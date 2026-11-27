'use strict';
// Árvore da Família: servidor privado e auto-hospedado.
// Regras: todos os convidados veem; membros adicionam pessoas, informações e
// documentos; cada um só altera o que ele mesmo criou; o administrador altera tudo.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { openDb } = require('./src/db');
const { toGedcom } = require('./src/gedcom');
const mail = require('./src/mail');
const BRAND = require('./src/brand');
const { runLote, norm } = require('./src/lote');
const relatos = require('./src/relatos');
const sugestoes = require('./src/sugestoes');

// PORT pode ser um número ou, nos livros por código, o caminho de um socket local.
const PORT = process.env.PORT && isNaN(process.env.PORT) ? process.env.PORT : Number(process.env.PORT || 3000);
// Livro por código (ex.: /K7P2Q): o site principal abre este mesmo programa para cada família, com banco e pasta próprios.
const BOOK_CODE = /^[A-Z0-9]{4,8}$/.test(process.env.BOOK_CODE || '') ? process.env.BOOK_CODE : '';
const BASE = BOOK_CODE ? '/' + BOOK_CODE : '';
const CPATH = BASE || '/';
const CK = n => BOOK_CODE ? `${n}_${BOOK_CODE}` : n; // cookies de cada livro com nome próprio: não se misturam com os do site principal
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TRASH_DIR = path.join(UPLOAD_DIR, 'lixeira');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_DAYS = 60;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const MAX_USER_STORAGE_MB = Number(process.env.MAX_USER_STORAGE_MB || 2000);
let sharp = null; try { sharp = require('sharp'); } catch { /* sem sharp: fotos guardadas como vieram */ }

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'arvore.db'));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// Site principal: /CÓDIGO/... vai para o livro daquela família (processo separado).
const books = BOOK_CODE ? null : require('./src/books')({ db, dataDir: DATA_DIR, serverFile: __filename });
if (books) app.use(books.middleware);

// ---------- segurança básica ----------
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  if (COOKIE_SECURE) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '5mb' }));

// Bloqueia pedidos de escrita vindos de outros sites (proteção CSRF).
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    try { if (new URL(origin).host !== host) return res.status(403).json({ error: 'Origem não permitida.' }); }
    catch { return res.status(403).json({ error: 'Origem não permitida.' }); }
  }
  next();
});

// ---------- sessões ----------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) { try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch { /* cookie inválido: ignora */ } }
  });
  return out;
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, userId, expires);
  res.setHeader('Set-Cookie', `${CK('sid')}=${token}; HttpOnly; SameSite=Lax; Path=${CPATH}; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
}
app.use((req, res, next) => {
  const sid = parseCookies(req)[CK('sid')];
  req.user = null;
  if (sid) {
    const row = db.prepare('SELECT u.id,u.name,u.email,u.role,u.person_id,u.person_ok,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1').get(sid);
    if (row && row.expires > Date.now()) { req.user = { id: row.id, name: row.name, email: row.email, role: row.role, personId: row.person_id || '', personOk: !!row.person_ok }; req.sid = sid; }
  }
  next();
});
const needUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Entre na sua conta.' });
const needUserOrGuest = (req, res, next) => (req.user || req.guest) ? next() : res.status(401).json({ error: 'Entre na sua conta.' });

// ---------- link da família (só ver, sem cadastro) ----------
// Um link único que o administrador cria, troca ou desliga. Quem entra por ele só vê:
// dos falecidos, tudo; dos vivos, só nome, apelido e ligações de família.
const getSetting = k => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || '';
// Pessoa da árvore escolhida pelo administrador ao convidar: tem de existir, estar viva e ainda não ter conta.
function inviteePerson(pid) {
  pid = String(pid || ''); if (!pid) return { pid: '' };
  const row = db.prepare('SELECT * FROM people WHERE id=?').get(pid);
  if (!row) return { error: 'Pessoa não encontrada na árvore.' };
  if (isDeceased(personOut(row))) return { error: 'Esta pessoa já faleceu.' };
  const u = db.prepare('SELECT name FROM users WHERE person_id=?').get(pid);
  if (u) return { error: `Esta pessoa já está ligada à conta de ${u.name}.` };
  return { pid, name: row.name };
}
const baseUrl = req => (process.env.DOMAIN ? 'https://' + process.env.DOMAIN : `${req.protocol}://${req.get('host')}`) + BASE;
// Mostra só o começo do e-mail (ex.: ma***@gmail.com) para quem pediu acesso neste aparelho.
const maskEmail = e => { const [u, d] = String(e).split('@'); return (u.length <= 2 ? u[0] : u.slice(0, 2)) + '***@' + d; };
// Pessoa inicial de quem não tem pessoa ligada (visitantes): a pessoa do primeiro administrador.
function startPerson() {
  const a = db.prepare("SELECT person_id FROM users WHERE role='admin' AND active=1 AND person_id<>'' ORDER BY id LIMIT 1").get();
  return (a && exists(a.person_id) ? a.person_id : '') || process.env.DEFAULT_PERSON || '';
}
// Nome da família deste livro: escolhido na instalação e editável em Administrar.
const familyName = () => getSetting('familia') || BRAND.family || 'Nossa família';
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const GUEST_DAYS = 30;
app.use((req, res, next) => {
  req.guest = false;
  if (!req.user) {
    const fam = parseCookies(req)[CK('fam')], current = getSetting('family_link');
    if (fam && current && fam.length === current.length && crypto.timingSafeEqual(Buffer.from(fam), Buffer.from(current))) req.guest = true;
  }
  next();
});
const DEAD_BEFORE = Number(process.env.FALECIDOS_ATE_ANO || 1915);
function isDeceased(p) {
  if (String(p.death || '').trim() || String(p.deathPlace || '').trim()) return true;
  const y = Number((String(p.birth || '').match(/\d{4}/) || [])[0]);
  return !!y && y <= DEAD_BEFORE;
}
// ---------- proteções dos termos de uso ----------
// Menor de idade: vivo e nascido há menos de 18 anos.
function isMinor(p) {
  if (isDeceased(p)) return false;
  const y = Number((String(p.birth || '').match(/\d{4}/) || [])[0]);
  return !!y && y > new Date().getFullYear() - 18;
}
// O que os outros membros veem de quem é menor ou pediu para ocultar os dados: nome, apelido e ligações (e o ano, para o menor).
function restrictedPerson(p, keepYear) {
  const y = (String(p.birth || '').match(/\d{4}/) || [''])[0];
  return { id: p.id, name: p.name, given: p.given, nick: p.nick, sex: p.sex, fatherId: p.fatherId, motherId: p.motherId, spouseId: p.spouseId,
    birth: keepYear ? y : '', restricted: true, private: p.private, photoFileId: '', createdBy: p.createdBy, managedBy: p.managedBy };
}
// Pode ver os detalhes desta pessoa? (mesma regra da árvore)
function canSeeDetails(req, row) {
  if (!req.user || req.user.role === 'admin') return true;
  const p = personOut(row), minor = isMinor(p), priv = p.private && !isDeceased(p);
  if (!minor && !priv) return true;
  const mine = req.user.personId;
  return p.id === mine || row.created_by === req.user.id || (minor && !priv && mine && (p.fatherId === mine || p.motherId === mine));
}
function guestPerson(p) {
  if (isDeceased(p)) return { ...p, createdBy: null };
  return { id: p.id, name: p.name, given: p.given, nick: p.nick, sex: p.sex, fatherId: p.fatherId, motherId: p.motherId, spouseId: p.spouseId, living: true, createdBy: null };
}
const needWriter = (req, res, next) => req.user && req.user.role !== 'viewer' ? next() : res.status(403).json({ error: 'Seu acesso é só de leitura.' });
const needAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Só o administrador pode fazer isso.' });
const owns = (req, createdBy) => req.user.role === 'admin' || (createdBy != null && createdBy === req.user.id);
// A própria pessoa (conta ligada a ela) também pode corrigir os seus dados, mesmo que outro parente tenha criado o registro.
const isSelf = (req, p) => !!req.user.personId && req.user.personId === p.id;
// Ficha administrada pela própria pessoa: a conta dela está ligada e confirmada.
const managerOf = pid => { const u = pid && db.prepare("SELECT id FROM users WHERE person_id=? AND person_ok=1 AND active=1").get(pid); return u ? u.id : null; };
const isManager = (req, pid) => !!req.user && managerOf(pid) === req.user.id;
// Parentes diretos de uma pessoa falecida podem corrigir a ficha dela: cônjuge, pais, irmãos,
// filhos, netos e bisnetos. Vale para quem tem a conta ligada à própria ficha.
function kinOfDeceased(myPid, ep) {
  const out = kinOf(myPid, ep);
  const dead = new Set(db.prepare('SELECT * FROM people').all().map(personOut).filter(isDeceased).map(p => p.id));
  return new Set([...out].filter(id => dead.has(id)));
}
// Parentes diretos (vivos ou não) de quem está na ficha myPid: cônjuge, pais, avós, bisavós, irmãos e filhos.
// Do ponto de vista da outra pessoa, myPid é o cônjuge, filho, neto, bisneto, irmão ou pai dela.
function kinOf(myPid, ep) {
  const out = new Set(); if (!myPid) return out;
  ep = ep || effectiveParents();
  const me = ep[myPid]; if (!me) return out;
  // meus pais, avós e bisavós (eu sou filho, neto ou bisneto)
  let gen = [me.f, me.m].filter(Boolean);
  for (let i = 0; i < 3 && gen.length; i++) { gen.forEach(x => out.add(x)); gen = gen.flatMap(x => ep[x] ? [ep[x].f, ep[x].m] : []).filter(Boolean); }
  for (const [id, c] of Object.entries(ep)) {
    if (id === myPid) continue;
    if (c.f === myPid || c.m === myPid) out.add(id); // meus filhos
    if ((me.f && c.f === me.f) || (me.m && c.m === me.m)) out.add(id); // meus irmãos
  }
  for (const r of db.prepare('SELECT id,spouse_id FROM people WHERE id=? OR spouse_id=?').all(myPid, myPid)) { if (r.id !== myPid) out.add(r.id); else if (r.spouse_id) out.add(r.spouse_id); }
  return out;
}
// Contas dos parentes diretos de um falecido (para quem não pode corrigir saber com quem falar).
function kinContacts(pid) {
  const ep = effectiveParents();
  return db.prepare("SELECT id,name,person_id FROM users WHERE person_id<>'' AND person_ok=1 AND active=1 AND role<>'viewer'").all()
    .filter(u => kinOfDeceased(u.person_id, ep).has(pid)).map(u => u.name);
}
const isKinOfDeceased = (req, p) => !!req.user && req.user.role !== 'viewer' && req.user.personOk && kinOfDeceased(req.user.personId).has(p.id);
// Quem altera a ficha: o administrador, a própria pessoa, quem a cadastrou (enquanto ela não assumir a própria ficha)
// e, se a pessoa já faleceu, os parentes diretos dela.
const canManagePerson = (req, p) => req.user.role === 'admin' || isSelf(req, p) || (owns(req, p.created_by) && !managerOf(p.id)) || isKinOfDeceased(req, p);
// Quem remove uma nota, link ou foto: quem acrescentou, o administrador, ou a pessoa dona da ficha (confirmada).
const canRemoveOn = (req, createdBy, pid) => (req.user.role !== 'viewer' && owns(req, createdBy)) || isManager(req, pid);

// Limite simples de tentativas de login.
const attempts = new Map();
function tooMany(key) {
  const now = Date.now(), a = (attempts.get(key) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(key, a);
  return a.length >= 10;
}
function noteAttempt(key) { const a = attempts.get(key) || []; a.push(Date.now()); attempts.set(key, a); }
function tooManyIp(ip) {
  const now = Date.now(), k = 'ip|' + ip, a = (attempts.get(k) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(k, a);
  return a.length >= 30;
}
// Limite de alterações por pessoa (evita abuso ou um robô enchendo a árvore).
const writes = new Map();
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.user) return next();
  const now = Date.now(), a = (writes.get(req.user.id) || []).filter(t => now - t < 3600e3);
  if (a.length >= 300) return res.status(429).json({ error: 'Muitas alterações em pouco tempo. Espere um pouco.' });
  a.push(now); writes.set(req.user.id, a); next();
});
setInterval(() => {
  const now = Date.now();
  for (const m of [attempts, writes]) for (const [k, a] of m) if (!a.some(t => now - t < 3600e3)) m.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  db.prepare('DELETE FROM resets WHERE expires < ?').run(now);
}, 3600e3).unref();

// Histórico: quem fez o quê. Exclusões guardam uma cópia para poder recuperar.
function log(req, action, target, detail) {
  db.prepare('INSERT INTO activity(user_id,action,target,detail,at) VALUES(?,?,?,?,?)')
    .run(req.user ? req.user.id : null, action, String(target || '').slice(0, 200), detail ? JSON.stringify(detail).slice(0, 20000) : null, new Date().toISOString());
  if (NOTIFY[action] && req.user) { try { notifyKin(req, action, String(target || ''), detail || {}); } catch (e) { console.error('aviso:', e.message); } }
}
// ---------- avisos: quando alguém mexe numa ficha, os parentes diretos dela e os administradores ficam sabendo ----------
const NOTIFY = {
  'acrescentou informação': 'acrescentou uma informação', 'deixou lembrança': 'deixou uma lembrança',
  'editou pessoa': 'alterou dados', 'enviou arquivos': 'enviou fotos ou documentos', 'adicionou link': 'acrescentou um vídeo ou link',
  'escolheu foto principal': 'trocou a foto de perfil', 'adicionou pessoa': 'cadastrou',
  'removeu informação': 'removeu uma informação', 'removeu link': 'removeu um link', 'removeu arquivo': 'removeu uma foto ou documento'
};
const FIELD_LBL = { name: 'nome', given: 'primeiro nome', nick: 'apelido', sex: 'sexo', birth: 'nascimento', birth_place: 'local de nascimento', death: 'falecimento', death_place: 'local de falecimento', father_id: 'pai', mother_id: 'mãe', spouse_id: 'cônjuge', marriage: 'casamento', marriage_place: 'local do casamento', descendants: 'descendentes', notes: 'histórias', sources: 'fontes', color: 'cor/raça', origin: 'origem/etnia' };
function notifyKin(req, action, pid, detail) {
  const p = db.prepare('SELECT id,name FROM people WHERE id=?').get(pid); if (!p) return;
  const nm = id => { const q = id && db.prepare('SELECT name FROM people WHERE id=?').get(id); return q ? q.name : (id || 'vazio'); };
  let text = action === 'adicionou pessoa' ? `${req.user.name} cadastrou ${p.name} na árvore` : `${req.user.name} ${NOTIFY[action]} na ficha de ${p.name}`;
  if (action === 'editou pessoa' && detail.depois) {
    const ch = Object.keys(detail.depois).filter(k => String(detail.antes?.[k] ?? '') !== String(detail.depois[k] ?? '')).map(k => {
      const ref = ['father_id', 'mother_id', 'spouse_id'].includes(k), a = detail.antes?.[k] || '', b = detail.depois[k] || '';
      return k === 'notes' || k === 'sources' ? FIELD_LBL[k] : `${FIELD_LBL[k] || k}: ${ref ? nm(a) : a || 'vazio'} → ${ref ? nm(b) : b || 'vazio'}`;
    });
    if (!ch.length) return;
    text += ': ' + ch.join('; ');
  } else if (detail.text) text += `: "${String(detail.text).slice(0, 200)}"`;
  else if (detail.url) text += `: ${detail.url}`;
  const ep = effectiveParents();
  const to = db.prepare("SELECT id,name,email,role,person_id,email_updates FROM users WHERE active=1 AND id<>?").all(req.user.id)
    .filter(u => u.role === 'admin' || (u.person_id && (u.person_id === pid || kinOf(u.person_id, ep).has(pid))));
  const ins = db.prepare('INSERT INTO notifications(user_id,person_id,text,by_user,created_at) VALUES(?,?,?,?,?)');
  for (const u of to) ins.run(u.id, pid, text, req.user.id, now());
  // o e-mail sai uma vez por dia, no resumo da meia-noite (sendDigest)
}
// Resumo diário por e-mail: sai à meia-noite de Brasília, com os avisos até as 20h do dia anterior.
// O que acontecer depois das 20h vai no resumo da meia-noite seguinte. No máximo 1 e-mail por dia.
const BRT = -3 * 3600e3; // Brasília, sem horário de verão
function sendDigest(nowMs = Date.now()) {
  const local = new Date(nowMs + BRT), day = local.toISOString().slice(0, 10);
  if (getSetting('resumo_enviado') === day) return 0;
  const midnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BRT;
  const cutoff = new Date(midnightUtc - 4 * 3600e3).toISOString(); // 20h do dia anterior (Brasília)
  const since = new Date(midnightUtc - 4 * 86400e3).toISOString(); // não manda avisos muito antigos
  const site = process.env.DOMAIN ? 'https://' + process.env.DOMAIN + BASE : '';
  let sent = 0;
  for (const u of db.prepare('SELECT id,email FROM users WHERE active=1 AND email_updates=1').all()) {
    const list = db.prepare('SELECT id,person_id,text FROM notifications WHERE user_id=? AND mailed_at IS NULL AND read_at IS NULL AND created_at<? AND created_at>=? ORDER BY id').all(u.id, cutoff, since);
    if (!list.length) continue;
    const body = `Novidades no ${BRAND.name} da família:\n\n${list.map(n => '• ' + n.text + (site ? `\n  ${site}/#${encodeURIComponent(n.person_id)}` : '')).join('\n')}\n\nSe algo não for verdade, corrija ou avise o administrador, para a informação errada não se espalhar.\nPara não receber mais este e-mail, desmarque a opção na janela Avisos do site.`;
    mail.send(u.email, `${BRAND.name}: ${list.length} novidade${list.length > 1 ? 's' : ''}`, body);
    db.prepare(`UPDATE notifications SET mailed_at=? WHERE id IN (${list.map(() => '?').join(',')})`).run(now(), ...list.map(n => n.id));
    sent++;
  }
  setSetting('resumo_enviado', day);
  return sent;
}

// ---------- utilidades ----------
const FIELDS = ['name', 'given', 'nick', 'sex', 'birth', 'birth_place', 'death', 'death_place', 'father_id', 'mother_id', 'spouse_id', 'marriage', 'marriage_place', 'descendants', 'notes', 'sources', 'color', 'origin'];
const COLORS = ['', 'branca', 'preta', 'parda', 'amarela', 'indigena'];
const MAP = { birthPlace: 'birth_place', deathPlace: 'death_place', fatherId: 'father_id', motherId: 'mother_id', spouseId: 'spouse_id', marriagePlace: 'marriage_place' };
function clean(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    const col = MAP[k] || k;
    if (!FIELDS.includes(col)) continue;
    out[col] = String(v ?? '').trim().slice(0, col === 'notes' ? 5000 : col === 'sources' ? 2000 : 200);
  }
  if ('sex' in out && !['', 'm', 'f'].includes(out.sex)) out.sex = '';
  if ('color' in out && !COLORS.includes(out.color)) out.color = '';
  if ('descendants' in out && !['', 'nao_teve', 'nao_deixou'].includes(out.descendants)) out.descendants = '';
  return out;
}
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pessoa';
const newId = name => `${slug(name)}-${crypto.randomBytes(3).toString('hex')}`;
const now = () => new Date().toISOString();
function personOut(p) {
  return {
    id: p.id, name: p.name, given: p.given || '', nick: p.nick, sex: p.sex, birth: p.birth, birthPlace: p.birth_place,
    death: p.death, deathPlace: p.death_place, fatherId: p.father_id, motherId: p.mother_id,
    spouseId: p.spouse_id, marriage: p.marriage || '', marriagePlace: p.marriage_place || '', descendants: p.descendants || '', private: !!p.private, minorOk: !!p.minor_ok, notes: p.notes, sources: p.sources, color: p.color || '', origin: p.origin || '', photoFileId: p.photo_file_id || '', createdBy: p.created_by,
    createdAt: p.created_at, updatedAt: p.updated_at
  };
}
function exists(id) { return !!db.prepare('SELECT 1 FROM people WHERE id=?').get(id); }

// ---------- conta ----------
app.get('/api/status', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const pending = req.user && req.user.role === 'admin' ? db.prepare("SELECT COUNT(*) n FROM access_requests WHERE status='pending'").get().n : 0;
  const reportsN = req.user && req.user.role === 'admin' ? db.prepare("SELECT COUNT(*) n FROM reports WHERE status='open'").get().n : 0;
  const bookReqs = req.user && req.user.role === 'admin' ? db.prepare("SELECT COUNT(*) n FROM book_requests WHERE status='pending'").get().n : 0;
  // Quem pediu acesso neste aparelho vê em que pé está o pedido (o convite em si só chega pelo e-mail).
  let request = null;
  const claim = !req.user && parseCookies(req)[CK('pedido')];
  if (claim) {
    const r = db.prepare('SELECT status,email FROM access_requests WHERE claim=?').get(String(claim));
    if (r) request = { status: r.status, email: maskEmail(r.email), mailed: r.status === 'approved' && mail.configured() };
  }
  const inboxNew = req.user && req.user.role === 'admin' ? inboxState().filter(x => x.state !== 'importado').length : 0;
  let suggestionsN = 0; if (req.user && req.user.role === 'admin') try { suggestionsN = sugestoes.suggest(db, effectiveParents).length; } catch (e) { console.error(e); }
  res.json({ request, inboxNew, suggestions: suggestionsN, needsSetup: users === 0, termsVersion: TERMS_VERSION, needsTerms: !!(req.user && (db.prepare('SELECT terms_version v FROM users WHERE id=?').get(req.user.id) || {}).v !== TERMS_VERSION), pendingRequests: pending, bookRequests: bookReqs, reports: reportsN, hubUrl: process.env.HUB_URL || '', book: BOOK_CODE, codeLogin: mail.configured(), user: req.user || (req.guest ? { id: null, name: 'Visitante', role: 'guest' } : null), familyName: familyName(), familySuggestion: BRAND.family, brand: BRAND, defaultPerson: startPerson() });
});

app.put('/api/admin/family-name', needAdmin, (req, res) => {
  const fam = String(req.body.name || '').trim().slice(0, 80);
  if (!fam) return res.status(400).json({ error: 'Escreva o nome da família.' });
  setSetting('familia', fam); log(req, 'mudou o nome da família', null, { nome: fam });
  res.json({ ok: true, name: fam });
});
app.post('/api/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return res.status(400).json({ error: 'O administrador já foi criado.' });
  const setupKey = process.env.SETUP_KEY;
  if (setupKey && req.body.setupKey !== setupKey) return res.status(403).json({ error: 'Chave de instalação incorreta.' });
  const { name, email, password } = req.body || {};
  const err = checkAccount(name, email, password); if (err) return res.status(400).json({ error: err });
  if (!req.body.terms) return res.status(400).json({ error: 'Para criar a conta, aceite os Termos de uso e a Política de privacidade.' });
  if (req.body.adult !== true) return res.status(400).json({ error: 'As contas são para maiores de 18 anos. Confirme a sua idade.' });
  const id = db.prepare('INSERT INTO users(name,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), 'admin', now()).lastInsertRowid;
  acceptTerms(id);
  const fam = String(req.body.family || '').trim().slice(0, 80);
  if (fam) setSetting('familia', fam);
  setSession(res, id);
  res.json({ ok: true });
});

function checkAccount(name, email, password) {
  if (!name || !String(name).trim()) return 'Escreva seu nome.';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'E-mail inválido.';
  if (!password || String(password).length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(String(email).trim().toLowerCase())) return 'Já existe uma conta com esse e-mail.';
  return null;
}

app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = (req.ip || '') + '|' + email;
  if (tooMany(key) || tooManyIp(req.ip || '')) return res.status(429).json({ error: 'Muitas tentativas. Espere 15 minutos.' });
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) { noteAttempt(key); noteAttempt('ip|' + (req.ip || '')); return res.status(401).json({ error: 'E-mail ou senha incorretos.' }); }
  setSession(res, u.id);
  res.json({ ok: true });
});

// Entrar com código por e-mail: 6 números, valem 10 minutos, no máximo 5 tentativas por código.
// A resposta é sempre a mesma, exista ou não a conta, para ninguém descobrir quem está cadastrado.
const codeHash = c => crypto.createHash('sha256').update(String(c)).digest('hex');
app.post('/api/login/code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (!mail.configured()) return res.status(400).json({ error: 'O envio de e-mail não está configurado. Entre com a senha.' });
  const key = 'code|' + (req.ip || '') + '|' + email;
  if (tooMany(key) || tooManyIp(req.ip || '')) return res.status(429).json({ error: 'Muitos pedidos. Espere 15 minutos.' });
  noteAttempt(key); noteAttempt('ip|' + (req.ip || ''));
  const u = db.prepare('SELECT id,name FROM users WHERE email=? AND active=1').get(email);
  const prev = db.prepare('SELECT created_at FROM login_codes WHERE email=?').get(email);
  if (u && !(prev && Date.now() - prev.created_at < 60e3)) { // no máximo um código por minuto
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    db.prepare('INSERT INTO login_codes(email,code_hash,expires,tries,created_at) VALUES(?,?,?,0,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, tries=0, created_at=excluded.created_at')
      .run(email, codeHash(code), Date.now() + 10 * 60e3, Date.now());
    mail.send(email, `${BRAND.name}: seu código para entrar é ${code}`, `Olá, ${u.name}!\n\nSeu código para entrar no ${BRAND.name} da ${familyName()} é:\n\n${code}\n\nEle vale 10 minutos. Se não foi você que pediu, ignore este e-mail: ninguém entra sem o código.`);
  }
  res.json({ ok: true });
});
app.post('/api/login/code/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), code = String(req.body.code || '').replace(/\D/g, '');
  const key = (req.ip || '') + '|' + email;
  if (tooMany(key) || tooManyIp(req.ip || '')) return res.status(429).json({ error: 'Muitas tentativas. Espere 15 minutos.' });
  const row = db.prepare('SELECT * FROM login_codes WHERE email=?').get(email);
  const fail = msg => { noteAttempt(key); noteAttempt('ip|' + (req.ip || '')); return res.status(401).json({ error: msg }); };
  if (!row || row.expires < Date.now() || row.tries >= 5) { if (row) db.prepare('DELETE FROM login_codes WHERE email=?').run(email); return fail('Código vencido. Peça outro.'); }
  if (code.length !== 6 || !crypto.timingSafeEqual(Buffer.from(codeHash(code)), Buffer.from(row.code_hash))) {
    db.prepare('UPDATE login_codes SET tries=tries+1 WHERE email=?').run(email);
    return fail(row.tries + 1 >= 5 ? 'Código errado. Peça outro.' : 'Código errado. Confira o e-mail e tente de novo.');
  }
  db.prepare('DELETE FROM login_codes WHERE email=?').run(email);
  const u = db.prepare('SELECT id FROM users WHERE email=? AND active=1').get(email);
  if (!u) return fail('Conta não encontrada.');
  setSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.sid) db.prepare('DELETE FROM sessions WHERE token=?').run(req.sid);
  res.setHeader('Set-Cookie', [`${CK('sid')}=; HttpOnly; SameSite=Lax; Path=${CPATH}; Max-Age=0`, `${CK('fam')}=; HttpOnly; SameSite=Lax; Path=${CPATH}; Max-Age=0`]);
  res.json({ ok: true });
});

app.post('/api/password', needUser, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.pass_hash)) return res.status(400).json({ error: 'Senha atual incorreta.' });
  if (String(req.body.password || '').length < 8) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, req.sid);
  res.json({ ok: true });
});

// ---------- nova senha (link criado pelo administrador) ----------
app.get('/api/reset/:token', (req, res) => {
  const r = db.prepare('SELECT r.*,u.name FROM resets r JOIN users u ON u.id=r.user_id WHERE token=?').get(req.params.token);
  if (!r || r.expires < Date.now()) return res.status(404).json({ error: 'Link inválido ou vencido. Peça outro ao administrador.' });
  res.json({ name: r.name });
});
app.post('/api/reset/:token', (req, res) => {
  const r = db.prepare('SELECT * FROM resets WHERE token=?').get(req.params.token);
  if (!r || r.expires < Date.now()) return res.status(404).json({ error: 'Link inválido ou vencido. Peça outro ao administrador.' });
  if (String(req.body.password || '').length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), r.user_id);
  db.prepare('DELETE FROM resets WHERE user_id=?').run(r.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id);
  setSession(res, r.user_id);
  res.json({ ok: true });
});

// ---------- convites ----------
app.get('/api/invites/:token', (req, res) => {
  const inv = db.prepare('SELECT role,label,email,used_by,expires,person_id FROM invites WHERE token=?').get(req.params.token);
  if (!inv || inv.used_by || inv.expires < Date.now()) return res.status(404).json({ error: 'Convite inválido ou já usado.' });
  const r = db.prepare('SELECT name FROM access_requests WHERE invite_token=?').get(req.params.token);
  const pp = inv.person_id ? db.prepare('SELECT name FROM people WHERE id=?').get(inv.person_id) : null;
  res.json({ role: inv.role, label: inv.label, email: inv.email || '', name: r ? r.name : pp ? pp.name : '', personName: pp ? pp.name : '' });
});
app.post('/api/invites/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(req.params.token);
  if (!inv || inv.used_by || inv.expires < Date.now()) return res.status(404).json({ error: 'Convite inválido ou já usado.' });
  const { name, email, password } = req.body || {};
  // Convite de um pedido aprovado só vale para o e-mail que pediu.
  if (inv.email && String(email || '').trim().toLowerCase() !== inv.email) return res.status(400).json({ error: `Este convite é para o e-mail ${inv.email}.` });
  const err = checkAccount(name, email, password); if (err) return res.status(400).json({ error: err });
  if (!req.body.terms) return res.status(400).json({ error: 'Para criar a conta, aceite os Termos de uso e a Política de privacidade.' });
  if (req.body.adult !== true) return res.status(400).json({ error: 'As contas são para maiores de 18 anos. Confirme a sua idade.' });
  const id = db.prepare('INSERT INTO users(name,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), inv.role, now()).lastInsertRowid;
  db.prepare('UPDATE users SET email_updates=? WHERE id=?').run(req.body.emailUpdates === false ? 0 : 1, id);
  acceptTerms(id);
  db.prepare('UPDATE invites SET used_by=?, used_at=? WHERE token=?').run(id, now(), inv.token);
  db.prepare("UPDATE access_requests SET status='joined' WHERE invite_token=?").run(inv.token);
  // Já entra ligado à sua ficha na árvore, se o administrador escolheu ao convidar.
  if (inv.person_id && exists(inv.person_id) && !db.prepare('SELECT 1 FROM users WHERE person_id=?').get(inv.person_id))
    { db.prepare('UPDATE users SET person_id=?, person_ok=1 WHERE id=?').run(inv.person_id, id);
      db.prepare("INSERT INTO activity(user_id,action,target,detail,at) VALUES(?,'ligado à ficha',?,?,?)").run(id, inv.person_id, JSON.stringify({ por: 'convite' }), now()); }
  setSession(res, id);
  res.json({ ok: true });
});

// ---------- termos de uso e política de privacidade ----------
// Mudou o texto de forma importante? Suba a versão: todo mundo terá de aceitar de novo.
const TERMS_VERSION = '2026-11-27';
// Responsável pelos dados. O e-mail padrão é o mesmo que o site usa para enviar os avisos (SMTP_USER).
const legal = () => ({ name: process.env.LEGAL_NAME || 'Wemerson Duarte Melo', email: process.env.LEGAL_EMAIL || process.env.SMTP_USER || '[e-mail de contato]', address: process.env.LEGAL_ADDRESS || 'Copenhague, Dinamarca' });
app.get(['/termos', '/privacidade'], (req, res) => {
  const L = legal();
  const html = fs.readFileSync(path.join(__dirname, 'public', 'termos.html'), 'utf8')
    .replace(/\{\{BRAND_NAME\}\}/g, escHtml(BRAND.name)).replace(/\{\{VERSION\}\}/g, TERMS_VERSION)
    .replace(/\{\{LEGAL_NAME\}\}/g, escHtml(L.name)).replace(/\{\{LEGAL_EMAIL\}\}/g, escHtml(L.email)).replace(/\{\{LEGAL_ADDRESS\}\}/g, escHtml(L.address));
  res.set('Cache-Control', 'no-cache').type('html').send(req.path === '/privacidade' ? html.replace('<main class="lp legal">', '<main class="lp legal" data-goto="privacidade">') : html);
});
const acceptTerms = (uid) => db.prepare('UPDATE users SET terms_version=?, terms_at=? WHERE id=?').run(TERMS_VERSION, now(), uid);
// Direito de oposição: a própria pessoa (ou o administrador) oculta os dados dela dos outros membros.
app.put('/api/people/:id/private', needUser, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (req.user.role !== 'admin' && !isSelf(req, p)) return res.status(403).json({ error: 'Só a própria pessoa (ou o administrador) escolhe isso.' });
  db.prepare('UPDATE people SET private=?, updated_at=? WHERE id=?').run(req.body.on ? 1 : 0, now(), p.id);
  log(req, req.body.on ? 'ocultou os dados da ficha' : 'mostrou os dados da ficha', p.id);
  res.json({ ok: true });
});
// Denúncias: conteúdo que viola os termos (falso, ofensivo, exposição indevida). O administrador decide.
app.post('/api/reports', needUser, (req, res) => {
  const kind = String(req.body.kind || ''), target = String(req.body.target || '').slice(0, 100), reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!['person', 'note', 'file', 'media'].includes(kind) || !target) return res.status(400).json({ error: 'Denúncia inválida.' });
  if (reason.length < 5) return res.status(400).json({ error: 'Conte em poucas palavras o que está errado.' });
  const recent = db.prepare("SELECT COUNT(*) n FROM reports WHERE by_user=? AND created_at>?").get(req.user.id, new Date(Date.now() - 864e5).toISOString()).n;
  if (recent >= 20) return res.status(429).json({ error: 'Muitas denúncias hoje. Fale com o administrador.' });
  const pid = kind === 'person' ? target : ((kind === 'note' ? db.prepare('SELECT person_id p FROM notes WHERE id=?') : kind === 'file' ? db.prepare('SELECT person_id p FROM files WHERE id=?') : db.prepare('SELECT person_id p FROM media_links WHERE id=?')).get(target) || {}).p || null;
  db.prepare('INSERT INTO reports(kind,target,person_id,reason,by_user,created_at) VALUES(?,?,?,?,?,?)').run(kind, target, pid, reason, req.user.id, now());
  const nm = pid && (db.prepare('SELECT name FROM people WHERE id=?').get(pid) || {}).name;
  notifyAdmins(req, 'Denúncia', `${req.user.name} denunciou ${{ person: 'a ficha', note: 'uma informação', file: 'uma foto ou documento', media: 'um link' }[kind]}${nm ? ' de ' + nm : ''}: "${reason}". Veja em Administrar > Denúncias.`, pid);
  log(req, 'fez uma denúncia', pid, { kind, target });
  res.json({ ok: true });
});
app.get('/api/admin/reports', needAdmin, (req, res) => res.json({ reports: db.prepare("SELECT r.id,r.kind,r.target,r.person_id personId,r.reason,r.status,r.created_at createdAt,u.name byName FROM reports r LEFT JOIN users u ON u.id=r.by_user ORDER BY (r.status='open') DESC, r.id DESC LIMIT 200").all() }));
app.post('/api/admin/reports/:id/close', needAdmin, (req, res) => { db.prepare("UPDATE reports SET status='closed', closed_at=?, closed_by=? WHERE id=?").run(now(), req.user.id, Number(req.params.id)); res.json({ ok: true }); });
// Portabilidade: a pessoa baixa os dados dela (conta, ficha e o que acrescentou).
app.get('/api/me/export', needUser, (req, res) => {
  const u = db.prepare('SELECT id,name,email,role,person_id,email_updates,terms_version,terms_at,created_at FROM users WHERE id=?').get(req.user.id);
  const out = {
    exportado_em: now(), conta: u,
    minha_ficha: u.person_id ? db.prepare('SELECT * FROM people WHERE id=?').get(u.person_id) : null,
    pessoas_que_cadastrei: db.prepare('SELECT * FROM people WHERE created_by=?').all(u.id),
    informacoes_e_lembrancas: db.prepare('SELECT id,person_id,kind,text,created_at FROM notes WHERE created_by=?').all(u.id),
    fotos_e_documentos: db.prepare('SELECT id,person_id,original_name,mime,size,caption,created_at FROM files WHERE created_by=?').all(u.id),
    links: db.prepare('SELECT id,person_id,url,title,created_at FROM media_links WHERE created_by=?').all(u.id),
    avisos: db.prepare('SELECT text,created_at FROM notifications WHERE user_id=?').all(u.id),
    historico: db.prepare('SELECT action,target,at FROM activity WHERE user_id=? ORDER BY id').all(u.id)
  };
  log(req, 'baixou os próprios dados', null);
  res.set('Content-Disposition', 'attachment; filename="meus-dados.json"').json(out);
});
// Apagar a própria conta (com a senha). O que a pessoa acrescentou à árvore fica, com "(conta removida)".
app.post('/api/me/delete', needUser, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) return res.status(403).json({ error: 'Senha incorreta.' });
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n <= 1) return res.status(400).json({ error: 'Você é o único administrador. Passe a administração para outra pessoa antes de apagar a sua conta.' });
  log(req, 'apagou a própria conta', 'usuário ' + u.id, { nome: u.name });
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO removed_users(id,name,email,removed_at) VALUES(?,?,?,?)').run(u.id, u.name, u.email, now());
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM resets WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM notifications WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  })();
  res.setHeader('Set-Cookie', `${CK('sid')}=; HttpOnly; SameSite=Lax; Path=${CPATH}; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/me/accept-terms', needUser, (req, res) => { acceptTerms(req.user.id); log(req, 'aceitou os termos', null, { versao: TERMS_VERSION }); res.json({ ok: true, version: TERMS_VERSION }); });

// ---------- pedidos de livro: famílias de fora pedem a árvore delas (página /comecar) ----------
// Só o site principal recebe pedidos; os livros de teste têm HUB_URL e mandam para lá.
const bookLimit = new Map();
app.get(['/comecar', '/comecar/'], (req, res) => BOOK_CODE ? res.redirect('/comecar') : process.env.HUB_URL ? res.redirect(process.env.HUB_URL.replace(/\/$/, '') + '/comecar') : res.sendFile(path.join(__dirname, 'public', 'comecar.html')));
app.post('/api/livro-pedido', (req, res) => {
  if (process.env.HUB_URL || BOOK_CODE) return res.status(404).json({ error: 'Peça pelo site principal.' });
  if (req.body.site) return res.json({ ok: true }); // armadilha para robôs
  const ip = req.ip || '', nowMs = Date.now();
  const a = (bookLimit.get(ip) || []).filter(t => nowMs - t < 864e5);
  if (a.length >= 3) return res.status(429).json({ error: 'Você já enviou pedidos hoje. Aguarde a nossa resposta.' });
  const f = k => String(req.body[k] || '').trim();
  const name = f('name').slice(0, 100), email = f('email').toLowerCase().slice(0, 120), family = f('family').slice(0, 100), place = f('place').slice(0, 120), message = f('message').slice(0, 1500), relatives = f('relatives').slice(0, 300);
  if (!name) return res.status(400).json({ error: 'Escreva o seu nome.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (!family) return res.status(400).json({ error: 'Escreva o nome da sua família (ex.: Família Silva Santos).' });
  if (!req.body.consent) return res.status(400).json({ error: 'Para continuar, aceite os Termos de uso e a Política de privacidade.' });
  if (db.prepare("SELECT COUNT(*) n FROM book_requests WHERE status='pending'").get().n >= 500) return res.status(429).json({ error: 'Muitos pedidos aguardando. Tente de novo em alguns dias.' });
  if (db.prepare("SELECT 1 FROM book_requests WHERE email=? AND status='pending'").get(email)) return res.json({ ok: true });
  a.push(nowMs); bookLimit.set(ip, a);
  db.prepare('INSERT INTO book_requests(name,email,family,place,message,ip,created_at,terms_version,relatives) VALUES(?,?,?,?,?,?,?,?,?)').run(name, email, family, place, message, ip, now(), TERMS_VERSION, relatives);
  const text = `${name} (${email}) quer começar a árvore da ${family}${place ? ', de ' + place : ''}.${relatives ? ' Parentes que já usam: ' + relatives + '.' : ''}${message ? ' Mensagem: ' + message : ''}`;
  const admins = db.prepare("SELECT id,email FROM users WHERE role='admin' AND active=1").all();
  const reqId = db.prepare('SELECT last_insert_rowid() id').get().id;
  for (const u of admins) db.prepare('INSERT INTO notifications(user_id,person_id,text,created_at,book_req) VALUES(?,?,?,?,?)').run(u.id, null, 'Pedido de livro: ' + text, now(), reqId);
  mail.send(admins.map(u => u.email).join(','), `${BRAND.name}: pedido de livro da ${family}`, `${text}\n\nPara criar o livro, abra os Avisos ou Administrar > Famílias pedindo um livro e toque em "Aprovar e criar o livro":\n${baseUrl(req)}`);
  res.json({ ok: true });
});
// Pode ser a mesma família? Sobrenome em comum e mesma cidade (ou cidade não informada) com outro pedido ou com um livro já criado.
const STOP = new Set(['familia', 'de', 'da', 'do', 'das', 'dos', 'e']);
const surnames = s => new Set(norm(s || '').split(/[^a-z]+/).filter(w => w.length > 2 && !STOP.has(w)));
const cityOf = s => norm(String(s || '').split(/[,·-]/)[0]).trim();
function existingBooks() {
  let out = [];
  try { out = fs.readFileSync(path.join(DATA_DIR, 'livros.tsv'), 'utf8').split('\n').filter(Boolean).map(l => { const [slug, domain, family, place] = l.split('\t'); return { slug, domain, family, place: place || '' }; }); } catch { /* sem livros antigos */ }
  if (books) for (const b of books.list()) out.push({ slug: b.code, domain: (process.env.DOMAIN || 'este site') + '/' + b.code, family: b.family, place: b.place || '' });
  return out;
}
function familyMatches(r, others) {
  const sa = surnames(r.family), ca = cityOf(r.place), out = [];
  for (const o of others) {
    const common = [...surnames(o.family)].filter(w => sa.has(w)); if (!common.length) continue;
    const co = cityOf(o.place), sameCity = ca && co && ca === co, noCity = !ca || !co;
    if (sameCity || noCity) out.push({ ...o, strong: !!sameCity, common });
  }
  return out;
}
app.get('/api/admin/book-requests', needAdmin, (req, res) => {
  const all = db.prepare("SELECT id,name,email,family,place,message,relatives,status,book_code bookCode,created_at createdAt,done_at doneAt FROM book_requests ORDER BY (status='pending') DESC, id DESC LIMIT 300").all();
  const made = existingBooks().map(b => ({ kind: 'livro', label: `livro ${b.family}${b.place ? ' (' + b.place + ')' : ''} · ${b.domain}`, family: b.family, place: b.place }));
  for (const r of all) {
    const others = all.filter(o => o.id !== r.id).map(o => ({ kind: 'pedido', label: `pedido de ${o.name}: ${o.family}${o.place ? ' (' + o.place + ')' : ''}`, family: o.family, place: o.place }));
    r.maybeSame = familyMatches(r, [...made, ...others]).map(m => ({ label: m.label, strong: m.strong }));
    if (r.bookCode) r.bookUrl = baseUrl(req) + '/' + r.bookCode;
  }
  res.json({ requests: all, books: existingBooks(), codeBooks: books ? books.list().map(b => ({ ...b, url: baseUrl(req) + '/' + b.code })) : [] });
});
// Aprovar: cria o livro com um código curto e manda para a pessoa o endereço e a chave de instalação.
app.post('/api/admin/book-requests/:id/approve', needAdmin, (req, res) => {
  if (!books) return res.status(400).json({ error: 'Os livros são criados no site principal.' });
  const r = db.prepare('SELECT * FROM book_requests WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (r.book_code) return res.status(400).json({ error: `Este pedido já tem livro: ${r.book_code}.` });
  const fam = String(req.body.family || r.family || '').trim().slice(0, 100) || r.family;
  const { code, setupKey } = books.create({ family: fam, place: r.place, email: r.email, requestId: r.id });
  db.prepare("UPDATE book_requests SET status='done', done_at=?, book_code=? WHERE id=?").run(now(), code, r.id);
  const url = baseUrl(req) + '/' + code, setupUrl = `${url}/?chave=${setupKey}`;
  let mailed = false;
  if (mail.configured()) {
    mail.send(r.email, `${BRAND.name}: o livro da ${fam} está pronto`,
      `Olá, ${r.name}!\n\nO livro da ${fam} no ${BRAND.name} está pronto.\n\nCódigo do livro: ${code}\nEndereço: ${url}\n\nPara começar, abra o link abaixo e crie a sua conta. Você será o administrador do livro da sua família (a chave de instalação já vai preenchida):\n${setupUrl}\n\nChave de instalação, se pedir: ${setupKey}\n\nDepois, convide a família pelo próprio site, em Administrar.\n\nSe você não pediu este livro, ignore este e-mail.`);
    mailed = true;
  }
  log(req, 'criou livro por código', null, { codigo: code, familia: fam, pedido: r.id });
  res.json({ ok: true, code, url, setupUrl, setupKey, mailed });
});
app.post('/api/admin/book-requests/:id/:act', needAdmin, (req, res) => {
  const act = req.params.act; if (!['done', 'reopen', 'delete'].includes(act)) return res.status(400).json({ error: 'Ação inválida.' });
  const id = Number(req.params.id);
  if (act === 'delete') db.prepare('DELETE FROM book_requests WHERE id=?').run(id);
  else db.prepare('UPDATE book_requests SET status=?, done_at=? WHERE id=?').run(act === 'done' ? 'done' : 'pending', act === 'done' ? now() : null, id);
  log(req, 'pedido de livro: ' + act, 'pedido ' + id);
  res.json({ ok: true });
});

// ---------- pedidos para participar (a partir do link da família) ----------
const reqLimit = new Map();
app.post('/api/access-requests', (req, res) => {
  if (!req.guest) return res.status(403).json({ error: 'Abra pelo link da família para pedir acesso.' });
  const ip = req.ip || '', nowMs = Date.now();
  const a = (reqLimit.get(ip) || []).filter(t => nowMs - t < 864e5);
  if (a.length >= 3) return res.status(429).json({ error: 'Você já enviou pedidos hoje. Aguarde a resposta.' });
  const name = String(req.body.name || '').trim().slice(0, 100), email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  const relation = String(req.body.relation || '').trim().slice(0, 200), message = String(req.body.message || '').trim().slice(0, 1000);
  if (!name) return res.status(400).json({ error: 'Escreva seu nome completo.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (!relation) return res.status(400).json({ error: 'Conte como você é da família (ex.: neta do Clemente).' });
  if (db.prepare("SELECT COUNT(*) n FROM access_requests WHERE status='pending'").get().n >= 300) return res.status(429).json({ error: 'Muitos pedidos aguardando. Tente mais tarde.' });
  if (db.prepare("SELECT 1 FROM access_requests WHERE email=? AND status='pending'").get(email)) return res.json({ ok: true });
  a.push(nowMs); reqLimit.set(ip, a);
  const claim = crypto.randomBytes(24).toString('base64url');
  db.prepare("INSERT INTO access_requests(name,email,relation,message,ip,status,created_at,claim) VALUES(?,?,?,?,?,'pending',?,?)").run(name, email, relation, message, ip, now(), claim);
  res.setHeader('Set-Cookie', `${CK('pedido')}=${claim}; HttpOnly; SameSite=Lax; Path=${CPATH}; Max-Age=${60 * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
  // Avisa os administradores por e-mail (se o e-mail estiver configurado).
  const admins = db.prepare("SELECT email FROM users WHERE role='admin' AND active=1").all().map(u => u.email);
  mail.send(admins.join(','), `Pedido de acesso: ${name}`, `${name} (${email}) pediu para participar da árvore.\nParentesco: ${relation}${message ? '\nMensagem: ' + message : ''}\n\nPara aprovar ou recusar, entre no site e abra Administrar:\n${baseUrl(req)}`);
  res.json({ ok: true, mail: mail.configured() });
});

// ---------- leitura da árvore ----------
app.get('/api/tree', needUserOrGuest, (req, res) => {
  let people = db.prepare('SELECT * FROM people').all().map(personOut);
  // Ligações de pai/mãe feitas por quem não é dono do registro do filho.
  const links = db.prepare('SELECT * FROM links ORDER BY id').all();
  const byId = Object.fromEntries(people.map(p => [p.id, p]));
  for (const l of links) {
    const c = byId[l.child_id];
    const field = l.role === 'father' ? 'fatherId' : 'motherId';
    if (c && byId[l.parent_id] && !(c[field] && byId[c[field]])) c[field] = l.parent_id;
  }
  const notes = db.prepare('SELECT id,person_id personId,kind,text,created_by createdBy,created_at createdAt FROM notes ORDER BY created_at').all();
  const media = db.prepare('SELECT id,person_id personId,url,title,created_by createdBy,created_at createdAt FROM media_links ORDER BY created_at').all();
  const mg = Object.fromEntries(db.prepare("SELECT person_id,id FROM users WHERE person_id<>'' AND person_ok=1 AND active=1").all().map(u => [u.person_id, u.id]));
  for (const p of people) p.managedBy = mg[p.id] || null;
  if (req.user && !req.guest && req.user.role !== 'viewer' && req.user.personOk) { const kin = kinOfDeceased(req.user.personId); for (const p of people) if (kin.has(p.id)) p.kinEdit = true; }
  // Menores e quem pediu para ocultar os dados: os outros membros veem só nome e ligações.
  // Veem tudo: o administrador, a própria pessoa, quem cadastrou e, no caso do menor, pai e mãe.
  let hiddenIds = new Set();
  if (req.user && !req.guest && req.user.role !== 'admin') {
    const mine = req.user.personId;
    people = people.map(p => {
      const minor = isMinor(p), priv = p.private && !isDeceased(p);
      if (!minor && !priv) return p;
      if (p.id === mine || p.createdBy === req.user.id || (minor && !priv && mine && (p.fatherId === mine || p.motherId === mine))) return p;
      hiddenIds.add(p.id); return restrictedPerson(p, minor && !priv);
    });
  }
  const files = db.prepare('SELECT id,person_id personId,original_name name,mime,size,caption,doc,profile,created_by createdBy,created_at createdAt FROM files ORDER BY created_at').all()
    .filter(f => canSeeDoc(req, { doc: f.doc }) && (!hiddenIds.has(f.personId) || f.createdBy === req.user?.id)).map(f => ({ ...f, doc: !!f.doc, profile: !!f.profile }));
  const users = db.prepare("SELECT id,name FROM users UNION ALL SELECT id, name || ' (conta removida)' FROM removed_users").all();
  // Relatos que citam cada pessoa (só para quem pode editar; os relatos são privados).
  const relatoLinks = req.user && req.user.role !== 'viewer' ? db.prepare(`SELECT rp.person_id personId, r.id relatoId, r.fonte, r.data, rp.hidden FROM relato_people rp JOIN relatos r ON r.id=rp.relato_id WHERE rp.hidden=0 OR (rp.hidden=1 AND ?) ORDER BY r.data`).all(req.user.role === 'admin' ? 1 : 0) : [];
  if (req.guest) {
    // Ligações primeiro (já aplicadas acima); depois esconde os dados dos vivos.
    const dead = new Set(people.filter(isDeceased).map(p => p.id));
    people = people.map(guestPerson);
    const anon = x => ({ ...x, createdBy: null });
    return res.json({
      people,
      notes: notes.filter(n => dead.has(n.personId)).map(anon),
      files: files.filter(f => dead.has(f.personId)).map(f => ({ ...anon(f), name: f.caption || 'documento' })),
      media: media.filter(m => dead.has(m.personId)).map(anon),
      users: [],
      me: { id: null, name: 'Visitante', role: 'guest' }
    });
  }
  const visible = x => !hiddenIds.has(x.personId) || x.createdBy === req.user.id;
  res.json({ people, notes: notes.filter(visible), files, media: media.filter(visible), users, relatoLinks, me: req.user });
});

// Cada conta pode dizer quem ela é na árvore.
// Desfaz tudo o que a conta mudou na ficha desde que se identificou (quando diz "não sou eu").
function revertSelfChanges(uid, pid) {
  const claim = db.prepare("SELECT at FROM activity WHERE user_id=? AND target=? AND action IN ('se identificou na árvore','ligado à ficha') ORDER BY id DESC LIMIT 1").get(uid, pid);
  if (!claim) return 0;
  const since = claim.at; let n = 0;
  // a ficha dela e as fichas de falecidos que ela só podia corrigir por ser parente direto
  const acts = db.prepare(`SELECT a.* FROM activity a LEFT JOIN people p ON p.id=a.target WHERE a.user_id=? AND a.at>=? AND (a.target=? OR (a.action IN ('editou pessoa','escolheu foto principal') AND COALESCE(p.created_by,-1)<>?)) ORDER BY a.id DESC`).all(uid, since, pid, uid);
  db.transaction(() => {
    for (const a of acts) {
      let d = {}; try { d = JSON.parse(a.detail || '{}'); } catch {}
      if (a.action === 'editou pessoa' && d.antes) {
        const cols = Object.keys(d.antes).filter(c => FIELDS.includes(c));
        if (cols.length) { db.prepare(`UPDATE people SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(c => d.antes[c] ?? ''), now(), a.target); n++; }
      } else if (a.action === 'escolheu foto principal') { db.prepare('UPDATE people SET photo_file_id=? WHERE id=?').run(d.antes || '', a.target); n++; }
      else if (a.action === 'removeu informação' && d.id) { n += db.prepare('INSERT OR IGNORE INTO notes(id,person_id,kind,text,created_by,created_at) VALUES(?,?,?,?,?,?)').run(d.id, d.person_id, d.kind || 'info', d.text, d.created_by, d.created_at).changes; }
      else if (a.action === 'removeu link' && d.id) { n += db.prepare('INSERT OR IGNORE INTO media_links(id,person_id,url,title,created_by,created_at) VALUES(?,?,?,?,?,?)').run(d.id, d.person_id, d.url, d.title || '', d.created_by, d.created_at).changes; }
      else if (a.action === 'removeu arquivo' && d.id) {
        const from = path.join(TRASH_DIR, path.basename(d.stored_name || ''));
        if (d.stored_name && fs.existsSync(from)) {
          try { fs.renameSync(from, path.join(UPLOAD_DIR, path.basename(d.stored_name))); } catch {}
          n += db.prepare('INSERT OR IGNORE INTO files(id,person_id,stored_name,original_name,mime,size,caption,created_by,created_at,doc) VALUES(?,?,?,?,?,?,?,?,?,?)').run(d.id, d.person_id, d.stored_name, d.original_name, d.mime, d.size, d.caption || '', d.created_by, d.created_at, d.doc ?? 1).changes;
        }
      }
    }
    // o que a conta acrescentou na ficha depois de se identificar sai
    n += db.prepare('DELETE FROM notes WHERE person_id=? AND created_by=? AND created_at>=?').run(pid, uid, since).changes;
    n += db.prepare('DELETE FROM media_links WHERE person_id=? AND created_by=? AND created_at>=?').run(pid, uid, since).changes;
    for (const f of db.prepare('SELECT * FROM files WHERE person_id=? AND created_by=? AND created_at>=?').all(pid, uid, since)) {
      db.prepare('DELETE FROM files WHERE id=?').run(f.id); db.prepare("UPDATE people SET photo_file_id='' WHERE photo_file_id=?").run(f.id); n++;
      fs.mkdirSync(TRASH_DIR, { recursive: true });
      try { fs.renameSync(path.join(UPLOAD_DIR, path.basename(f.stored_name)), path.join(TRASH_DIR, path.basename(f.stored_name))); } catch {}
    }
  })();
  return n;
}
// Quantas alterações a conta fez na própria ficha desde que se identificou (para o aviso de "não sou eu").
app.get('/api/me/person/changes', needUser, (req, res) => {
  const pid = req.user.personId; if (!pid) return res.json({ count: 0 });
  const claim = db.prepare("SELECT at FROM activity WHERE user_id=? AND target=? AND action IN ('se identificou na árvore','ligado à ficha') ORDER BY id DESC LIMIT 1").get(req.user.id, pid);
  const count = claim ? db.prepare("SELECT COUNT(*) n FROM activity a LEFT JOIN people p ON p.id=a.target WHERE a.user_id=? AND a.at>=? AND a.action NOT IN ('se identificou na árvore','ligado à ficha') AND (a.target=? OR (a.action IN ('editou pessoa','escolheu foto principal') AND COALESCE(p.created_by,-1)<>?))").get(req.user.id, claim.at, pid, req.user.id).n : 0;
  res.json({ count });
});
// Aviso para os administradores: vai para os Avisos do site e entra no resumo diário por e-mail.
function notifyAdmins(req, subject, text, pid) {
  const ins = db.prepare('INSERT INTO notifications(user_id,person_id,text,by_user,created_at) VALUES(?,?,?,?,?)');
  for (const a of db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND id<>?").all(req.user.id)) ins.run(a.id, pid || null, text, req.user.id, now());
}
app.get('/api/people/:id/kin-contacts', needUser, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  const admins = db.prepare("SELECT name FROM users WHERE role='admin' AND active=1").all().map(u => u.name);
  res.json({ contacts: kinContacts(p.id), admins });
});
app.get('/api/notifications', needUser, (req, res) => {
  const list = db.prepare('SELECT id,person_id personId,text,created_at createdAt,read_at readAt,book_req bookReq FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 150').all(req.user.id);
  for (const n of list) {
    const r = n.bookReq && req.user.role === 'admin' ? db.prepare("SELECT id,status,book_code FROM book_requests WHERE id=?").get(n.bookReq) : null;
    if (r) n.bookRequest = { id: r.id, pending: r.status === 'pending' && !r.book_code, code: r.book_code || '', url: r.book_code ? baseUrl(req) + '/' + r.book_code : '' };
    delete n.bookReq;
  }
  const em = db.prepare('SELECT email_updates FROM users WHERE id=?').get(req.user.id);
  res.json({ notifications: list, unread: list.filter(n => !n.readAt).length, emailUpdates: !!(em && em.email_updates) });
});
app.put('/api/me/email-updates', needUser, (req, res) => {
  db.prepare('UPDATE users SET email_updates=? WHERE id=?').run(req.body.on ? 1 : 0, req.user.id);
  res.json({ ok: true, on: !!req.body.on });
});
app.post('/api/notifications/read', needUser, (req, res) => {
  db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), req.user.id);
  res.json({ ok: true });
});
app.put('/api/me/person', needUser, (req, res) => {
  const pid = String(req.body.personId || '');
  if (pid && !exists(pid)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (pid && req.user.role !== 'admin') {
    if (isDeceased(personOut(db.prepare('SELECT * FROM people WHERE id=?').get(pid)))) return res.status(400).json({ error: 'Esta pessoa já faleceu, então não pode ser você.' });
    const other = db.prepare('SELECT name FROM users WHERE person_id=? AND id<>?').get(pid, req.user.id);
    if (other) return res.status(409).json({ error: `Esta pessoa já está ligada à conta de ${other.name}. Fale com o administrador.` });
  }
  const prev = req.user.personId, prevName = prev && (db.prepare('SELECT name FROM people WHERE id=?').get(prev) || {}).name;
  let undone = 0;
  if (!pid && prev) undone = revertSelfChanges(req.user.id, prev);
  // Quem se identifica já administra a própria ficha; o administrador recebe um aviso.
  db.prepare('UPDATE users SET person_id=?, person_ok=? WHERE id=?').run(pid, pid ? 1 : 0, req.user.id);
  if (pid) {
    log(req, 'se identificou na árvore', pid);
    const nm = db.prepare('SELECT name FROM people WHERE id=?').get(pid).name;
    notifyAdmins(req, `${req.user.name} se identificou como ${nm}`, `${req.user.name} (${req.user.email}) tocou em "Esta pessoa sou eu" na ficha de ${nm} e agora administra essa ficha. Se não for a pessoa certa, abra Administrar > Pessoas com acesso e troque ou tire a ligação.`, pid);
  } else if (prev) {
    log(req, 'desfez a identificação na árvore', prev, { desfeitas: undone });
    notifyAdmins(req, `${req.user.name} disse que não é ${prevName}`, `${req.user.name} (${req.user.email}) tocou em "não sou eu" na ficha de ${prevName}. ${undone ? undone + ' alteração(ões) que essa conta fez na ficha foram desfeitas automaticamente.' : 'Não havia alterações a desfazer.'}`, prev);
  }
  res.json({ ok: true, personId: pid, undone });
});

// ---------- irmãos: por padrão têm os mesmos pais ----------
// Se todos os filhos de alguém que têm o outro pai/mãe registrado concordam (um só valor),
// os filhos sem esse dado recebem o mesmo. Nunca troca um pai/mãe já registrado: meio-irmãos
// continuam como estão, e cada pessoa pode corrigir a própria ficha.
// A ligação vai na tabela links (não altera o registro de quem o criou).
// Documentos (certidões, identidades, CTPS): só o administrador vê a imagem. Os parentes veem os dados
// que o documento confirmou, na ficha, com a fonte.
function canSeeDoc(req, f) {
  if (!f.doc) return true;
  return !!req.user && !req.guest && req.user.role === 'admin';
}
function effectiveParents() {
  const ps = db.prepare('SELECT id,father_id,mother_id FROM people').all(), by = {};
  for (const p of ps) by[p.id] = { f: p.father_id || '', m: p.mother_id || '' };
  for (const l of db.prepare('SELECT child_id,parent_id,role FROM links ORDER BY id').all()) {
    const c = by[l.child_id]; if (!c || !by[l.parent_id]) continue;
    const k = l.role === 'father' ? 'f' : 'm'; if (!c[k] || !by[c[k]]) c[k] = l.parent_id;
  }
  for (const c of Object.values(by)) { if (c.f && !by[c.f]) c.f = ''; if (c.m && !by[c.m]) c.m = ''; }
  return by;
}
function alignSiblings(req, onlyParents) {
  const by = effectiveParents(), fills = [];
  const parents = onlyParents ? onlyParents.filter(Boolean) : [...new Set(Object.values(by).flatMap(c => [c.f, c.m]).filter(Boolean))];
  for (const X of parents) for (const [slot, other] of [['f', 'm'], ['m', 'f']]) {
    const kids = Object.entries(by).filter(([, c]) => c[slot] === X);
    const vals = [...new Set(kids.map(([, c]) => c[other]).filter(Boolean))];
    if (vals.length !== 1) continue;
    for (const [kid, c] of kids) if (!c[other] && vals[0] !== kid) {
      c[other] = vals[0];
      db.prepare('INSERT INTO links(child_id,parent_id,role,created_by,created_at) VALUES(?,?,?,NULL,?)').run(kid, vals[0], other === 'f' ? 'father' : 'mother', now());
      fills.push({ kid, parent: vals[0], role: other === 'f' ? 'pai' : 'mãe' });
    }
  }
  if (fills.length) log(req, 'alinhou pais de irmãos', null, { ligacoes: fills });
  return fills;
}
// Uma vez só, para os dados que já existiam antes desta regra.
if (!getSetting('familia') && db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) setSetting('familia', process.env.FAMILY_SUBTITLE || 'Família Duarte Melo');
if (!getSetting('fichas_proprias_v1')) { db.exec("UPDATE users SET person_ok=1 WHERE person_id<>''"); setSetting('fichas_proprias_v1', new Date().toISOString()); }
if (!getSetting('irmaos_alinhados_v1')) { try { const n = alignSiblings({ user: null }).length; setSetting('irmaos_alinhados_v1', new Date().toISOString()); if (n) console.log(`Irmãos: ${n} ligação(ões) de pai/mãe completada(s).`); } catch (e) { console.error(e); } }
const parentsOf = id => { const c = effectiveParents()[id] || {}; return [c.f, c.m]; };

// ---------- pessoas ----------
// Regras dos termos ao gravar uma ficha: menor só com autorização dos responsáveis;
// cor/raça e origem de pessoa viva só a própria pessoa preenche (dado sensível, consentimento explícito).
function termsCheck(req, before, d) {
  const after = personOut({ ...(before || {}), ...d });
  if (isMinor(after) && !(before && before.minor_ok) && req.body.minorConsent !== true)
    return { status: 400, body: { error: 'Esta pessoa é menor de idade. Para registrar, confirme que você tem a autorização dos pais ou responsáveis.', code: 'minor' } };
  const sensitive = ['color', 'origin'].filter(k => k in d && d[k] && d[k] !== (before ? before[k] || '' : ''));
  if (sensitive.length && !isDeceased(after) && !(before && isSelf(req, before)))
    return { status: 400, body: { error: 'Cor/raça e origem/etnia de pessoas vivas são dados sensíveis: só a própria pessoa preenche, na ficha dela.', code: 'sensitive' } };
  return null;
}
app.post('/api/people', needWriter, (req, res) => {
  const d = clean(req.body);
  if (!d.name) return res.status(400).json({ error: 'Escreva pelo menos o nome.' });
  { const bad = termsCheck(req, null, d); if (bad) return res.status(bad.status).json(bad.body); }
  if (req.body.minorConsent === true) d.minor_ok = 1;
  for (const k of ['father_id', 'mother_id', 'spouse_id']) if (d[k] && !exists(d[k])) d[k] = '';
  const id = newId(d.name), t = now();
  const cols = Object.keys(d);
  db.prepare(`INSERT INTO people(id,${cols.join(',')},created_by,created_at,updated_at,updated_by) VALUES(?,${cols.map(() => '?').join(',')},?,?,?,?)`)
    .run(id, ...cols.map(c => d[c]), req.user.id, t, t, req.user.id);
  // Ligar como pai/mãe de alguém (mesmo que o registro do filho seja de outra pessoa).
  const { parentOf, parentRole } = req.body;
  if (parentOf && exists(parentOf) && ['father', 'mother'].includes(parentRole)) {
    db.prepare('INSERT INTO links(child_id,parent_id,role,created_by,created_at) VALUES(?,?,?,?,?)').run(parentOf, id, parentRole, req.user.id, t);
  }
  log(req, 'adicionou pessoa', id, { name: d.name, parentOf });
  alignSiblings(req, [d.father_id, d.mother_id, parentOf && exists(parentOf) ? id : '', ...parentsOf(id)]);
  res.json({ id });
});

app.put('/api/people/:id', needUser, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (req.user.role === 'viewer' && !isSelf(req, p)) return res.status(403).json({ error: 'Seu acesso é só de leitura.' });
  if (!canManagePerson(req, p) && isDeceased(personOut(p))) { const k = kinContacts(p.id); return res.status(403).json({ error: `Só os parentes diretos de ${p.name} (cônjuge, pais, irmãos, filhos, netos e bisnetos) ou o administrador podem alterar esta ficha. ${k.length ? 'Entre em contato com: ' + k.join(', ') + '.' : 'Nenhum parente direto tem conta ainda; fale com o administrador.'}` }); }
  if (!canManagePerson(req, p)) return res.status(403).json({ error: managerOf(p.id) ? 'Esta ficha agora é administrada pela própria pessoa. Use "Acrescentar informação".' : 'Você só pode alterar o que você mesmo adicionou. Use "Acrescentar informação".' });
  const d = clean(req.body);
  { const bad = termsCheck(req, p, d); if (bad) return res.status(bad.status).json(bad.body); }
  if (req.body.minorConsent === true) d.minor_ok = 1;
  if ('name' in d && !d.name) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
  for (const k of ['father_id', 'mother_id', 'spouse_id']) if (d[k] && (d[k] === p.id || !exists(d[k]))) d[k] = '';
  const cols = Object.keys(d);
  if (cols.length) db.prepare(`UPDATE people SET ${cols.map(c => c + '=?').join(',')}, updated_at=?, updated_by=? WHERE id=?`)
    .run(...cols.map(c => d[c]), now(), req.user.id, p.id);
  log(req, 'editou pessoa', p.id, { antes: Object.fromEntries(cols.map(c => [c, p[c]])), depois: d });
  if ('father_id' in d || 'mother_id' in d) alignSiblings(req, [p.father_id, p.mother_id, ...parentsOf(p.id)]);
  res.json({ ok: true });
});

app.delete('/api/people/:id', needWriter, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (!owns(req, p.created_by)) return res.status(403).json({ error: 'Você só pode excluir o que você mesmo adicionou.' });
  if (req.user.role !== 'admin' && managerOf(p.id)) return res.status(403).json({ error: 'Esta ficha é administrada pela própria pessoa; só o administrador pode excluí-la.' });
  log(req, 'excluiu pessoa', p.id, p);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM links WHERE child_id=? OR parent_id=?').run(p.id, p.id);
    db.prepare('DELETE FROM people WHERE id=?').run(p.id);
    db.prepare('DELETE FROM media_links WHERE person_id=?').run(p.id);
    for (const k of ['father_id', 'mother_id', 'spouse_id']) db.prepare(`UPDATE people SET ${k}='' WHERE ${k}=?`).run(p.id);
  });
  tx();
  res.json({ ok: true });
});

// ---------- informações (notas) ----------
// Lembranças, links e fotos: qualquer convidado pode acrescentar (inclusive "Só ver").
// Informações (dados e correções) continuam exigindo o acesso "Pode adicionar".
// Remover: só o autor com acesso "Pode adicionar", ou o administrador.
app.post('/api/people/:id/notes', needUser, (req, res) => {
  if (!exists(req.params.id)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (req.body.kind !== 'memory' && req.user.role === 'viewer') return res.status(403).json({ error: 'Seu acesso permite deixar lembranças, links e fotos.' });
  const text = String(req.body.text || '').trim().slice(0, 5000);
  if (!text) return res.status(400).json({ error: 'Escreva a informação.' });
  const kind = req.body.kind === 'memory' ? 'memory' : 'info';
  db.prepare('INSERT INTO notes(person_id,kind,text,created_by,created_at) VALUES(?,?,?,?,?)').run(req.params.id, kind, text, req.user.id, now());
  log(req, kind === 'memory' ? 'deixou lembrança' : 'acrescentou informação', req.params.id, { text });
  res.json({ ok: true });
});
app.delete('/api/notes/:id', needUser, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Não encontrada.' });
  if (!canRemoveOn(req, n.created_by, n.person_id)) return res.status(403).json({ error: 'Você só pode remover o que você escreveu.' });
  log(req, 'removeu informação', n.person_id, n);
  db.prepare('DELETE FROM notes WHERE id=?').run(n.id);
  res.json({ ok: true });
});

// ---------- links de vídeos e páginas ----------
function cleanUrl(u) {
  u = String(u || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); if (!['http:', 'https:'].includes(x.protocol) || !x.hostname.includes('.')) return null; return x.href.slice(0, 1000); }
  catch { return null; }
}
app.post('/api/people/:id/links', needUser, (req, res) => {
  if (!exists(req.params.id)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  const url = cleanUrl(req.body.url);
  if (!url) return res.status(400).json({ error: 'Cole um link válido (começando com https://).' });
  const title = String(req.body.title || '').trim().slice(0, 200);
  db.prepare('INSERT INTO media_links(person_id,url,title,created_by,created_at) VALUES(?,?,?,?,?)').run(req.params.id, url, title, req.user.id, now());
  log(req, 'adicionou link', req.params.id, { url });
  res.json({ ok: true });
});
app.delete('/api/media-links/:id', needUser, (req, res) => {
  const l = db.prepare('SELECT * FROM media_links WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Não encontrado.' });
  if (!canRemoveOn(req, l.created_by, l.person_id)) return res.status(403).json({ error: 'Você só pode remover o que você adicionou.' });
  log(req, 'removeu link', l.person_id, l);
  db.prepare('DELETE FROM media_links WHERE id=?').run(l.id);
  res.json({ ok: true });
});

// ---------- foto principal ----------
// Quem criou o registro da pessoa (ou o administrador) escolhe a foto principal.
app.put('/api/people/:id/photo', needUser, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (req.user.role === 'viewer' && !isSelf(req, p)) return res.status(403).json({ error: 'Seu acesso é só de leitura.' });
  if (!canManagePerson(req, p)) return res.status(403).json({ error: 'Só a própria pessoa, quem a cadastrou (se ela não tiver assumido a ficha) ou o administrador escolhe a foto principal.' });
  const fileId = String(req.body.fileId || '');
  if (fileId) {
    const f = db.prepare('SELECT * FROM files WHERE id=? AND person_id=?').get(fileId, p.id);
    if (!f || !/^image\/(jpeg|png|webp)$/.test(f.mime)) return res.status(400).json({ error: 'Escolha uma foto (JPG, PNG ou WebP) desta pessoa.' });
    if (f.doc) return res.status(400).json({ error: 'Este arquivo está marcado como documento (restrito). Para usar como foto de perfil, libere-o como foto primeiro.' });
  }
  db.prepare('UPDATE people SET photo_file_id=?, updated_at=?, updated_by=? WHERE id=?').run(fileId, now(), req.user.id, p.id);
  log(req, 'escolheu foto principal', p.id, { antes: p.photo_file_id || '', depois: fileId });
  res.json({ ok: true });
});

// ---------- documentos e fotos ----------
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (ALLOWED[file.mimetype] || ''))
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, !!ALLOWED[file.mimetype])
});
app.post('/api/people/:id/files', needUser, (req, res) => {
  const used = db.prepare('SELECT COALESCE(SUM(size),0) n FROM files WHERE created_by=?').get(req.user.id).n;
  if (used > MAX_USER_STORAGE_MB * 1024 * 1024) return res.status(400).json({ error: `Você já enviou ${Math.round(used / 1048576)} MB, o limite por pessoa. Fale com o administrador.` });
  upload.array('files', 10)(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${MAX_UPLOAD_MB} MB.` : 'Não foi possível enviar.' });
    if (!exists(req.params.id)) { (req.files || []).forEach(f => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'Pessoa não encontrada.' }); }
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Envie fotos (JPG, PNG, HEIC) ou PDF.' });
    const caption = String(req.body.caption || '').trim().slice(0, 500);
    const asProfile = String(req.body.profile || '') === '1'; // foto de perfil: fica só na bolinha
    const asDoc = !asProfile && String(req.body.doc ?? '1') !== '0'; // padrão: documento (restrito)
    const ins = db.prepare('INSERT INTO files(id,person_id,stored_name,original_name,mime,size,caption,created_by,created_at,doc,profile) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const ids = [];
    for (const f of req.files) {
      const info = await cleanImage(f);
      if (!info) { fs.unlink(f.path, () => {}); continue; }
      const fid = crypto.randomBytes(8).toString('hex'); ids.push(fid);
      ins.run(fid, req.params.id, info.filename, String(f.originalname).slice(0, 200), info.mime, info.size, caption, req.user.id, now(), asDoc || info.mime === 'application/pdf' ? 1 : 0, asProfile && info.mime !== 'application/pdf' ? 1 : 0);
    }
    log(req, asProfile ? 'enviou foto de perfil' : 'enviou arquivos', req.params.id, { count: req.files.length });
    res.json({ ok: true, count: req.files.length, ids });
  });
});
// Fotos: confere que é mesmo imagem, gira conforme o celular e remove os dados escondidos
// (localização GPS, modelo do aparelho). Fotos HEIC do iPhone viram JPG quando possível.
// PDF: confere a assinatura do arquivo.
async function cleanImage(f) {
  if (f.mimetype === 'application/pdf') {
    const fd = fs.openSync(f.path, 'r'), b = Buffer.alloc(5); fs.readSync(fd, b, 0, 5, 0); fs.closeSync(fd);
    return b.toString() === '%PDF-' ? { filename: f.filename, mime: f.mimetype, size: f.size } : null;
  }
  if (!sharp) return { filename: f.filename, mime: f.mimetype, size: f.size };
  const toJpeg = /hei[cf]/.test(f.mimetype);
  const outName = toJpeg ? f.filename.replace(/\.[a-z]+$/, '') + '.jpg' : f.filename;
  const tmp = path.join(UPLOAD_DIR, 'tmp-' + outName);
  try {
    let img = sharp(f.path, { failOn: 'error' }).rotate();
    if (toJpeg) img = img.jpeg({ quality: 88 });
    await img.toFile(tmp);
    if (outName !== f.filename) fs.unlinkSync(f.path);
    fs.renameSync(tmp, path.join(UPLOAD_DIR, outName));
    return { filename: outName, mime: toJpeg ? 'image/jpeg' : f.mimetype, size: fs.statSync(path.join(UPLOAD_DIR, outName)).size };
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    // HEIC que não pôde ser convertido fica como veio; outros formatos inválidos são recusados.
    return toJpeg ? { filename: f.filename, mime: f.mimetype, size: f.size } : null;
  }
}
app.get('/api/files/:id', needUserOrGuest, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).end();
  if (req.guest) {
    const p = db.prepare('SELECT * FROM people WHERE id=?').get(f.person_id);
    if (!p || !isDeceased(personOut(p))) return res.status(404).end();
  }
  if (!canSeeDoc(req, f)) return res.status(404).end();
  if (req.user && f.created_by !== req.user.id) { const pr = db.prepare('SELECT * FROM people WHERE id=?').get(f.person_id); if (pr && !canSeeDetails(req, pr)) return res.status(404).end(); }
  const file = path.join(UPLOAD_DIR, path.basename(f.stored_name));
  res.set('Content-Type', f.mime);
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', "frame-ancestors 'self'");
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});
// Marcar como documento (só o administrador vê) ou liberar como foto: só o administrador.
app.put('/api/files/:id', needAdmin, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado.' });
  if (typeof req.body.doc !== 'boolean') return res.status(400).json({ error: 'Informe doc.' });
  if (!req.body.doc && f.mime === 'application/pdf') return res.status(400).json({ error: 'PDF fica sempre como documento.' });
  db.prepare('UPDATE files SET doc=? WHERE id=?').run(req.body.doc ? 1 : 0, f.id);
  if (req.body.doc) db.prepare("UPDATE people SET photo_file_id='' WHERE photo_file_id=?").run(f.id);
  log(req, req.body.doc ? 'marcou como documento' : 'liberou como foto', f.person_id, { file: f.id, nome: f.original_name });
  res.json({ ok: true });
});
app.delete('/api/files/:id', needUser, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado.' });
  if (!canRemoveOn(req, f.created_by, f.person_id) || (f.doc && req.user.role !== 'admin')) return res.status(403).json({ error: 'Você só pode remover o que você enviou.' });
  log(req, 'removeu arquivo', f.person_id, f);
  db.prepare('DELETE FROM files WHERE id=?').run(f.id);
  db.prepare("UPDATE people SET photo_file_id='' WHERE photo_file_id=?").run(f.id);
  // Vai para a lixeira (data/uploads/lixeira) em vez de sumir: o administrador pode recuperar.
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  try { fs.renameSync(path.join(UPLOAD_DIR, path.basename(f.stored_name)), path.join(TRASH_DIR, path.basename(f.stored_name))); } catch { /* arquivo já não existe */ }
  res.json({ ok: true });
});

// ---------- administração ----------
app.get('/api/admin', needAdmin, (req, res) => {
  const users = db.prepare('SELECT id,name,email,role,active,person_id personId,person_ok personOk,created_at createdAt FROM users ORDER BY created_at').all();
  const invites = db.prepare('SELECT token,role,label,created_at createdAt,expires,used_by usedBy,person_id personId FROM invites ORDER BY created_at DESC LIMIT 100').all();
  const idents = db.prepare("SELECT a.action,a.target,a.detail,a.at,u.name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.action IN ('se identificou na árvore','desfez a identificação na árvore') AND a.at>=? ORDER BY a.id DESC LIMIT 30").all(new Date(Date.now() - 30 * 864e5).toISOString())
    .map(x => { let d = {}; try { d = JSON.parse(x.detail || '{}'); } catch {} return { action: x.action, personId: x.target, at: x.at, name: x.name || 'conta removida', undone: d.desfeitas || 0 }; });
  res.json({ users, invites, idents });
});
app.post('/api/admin/invites', needAdmin, (req, res) => {
  const role = ['member', 'viewer', 'admin'].includes(req.body.role) ? req.body.role : 'member';
  const who = inviteePerson(req.body.personId); if (who.error) return res.status(400).json({ error: who.error });
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO invites(token,role,label,created_by,created_at,expires,person_id) VALUES(?,?,?,?,?,?,?)')
    .run(token, role, String(req.body.label || who.name || '').slice(0, 100), req.user.id, now(), Date.now() + 30 * 864e5, who.pid);
  res.json({ token });
});
app.delete('/api/admin/invites/:token', needAdmin, (req, res) => {
  db.prepare('DELETE FROM invites WHERE token=? AND used_by IS NULL').run(req.params.token);
  res.json({ ok: true });
});
app.put('/api/admin/users/:id', needAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (typeof req.body.personId === 'string') {
    if (req.body.personId && !exists(req.body.personId)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
    db.prepare('UPDATE users SET person_id=?, person_ok=? WHERE id=?').run(req.body.personId, req.body.personId ? 1 : 0, id);
    if (req.body.personId) db.prepare("INSERT INTO activity(user_id,action,target,detail,at) VALUES(?,'ligado à ficha',?,?,?)").run(id, req.body.personId, JSON.stringify({ por: 'administrador', admin: req.user.id }), now());
    if (req.body.role === undefined && req.body.active === undefined) return res.json({ ok: true });
  }
  if (id === req.user.id) return res.status(400).json({ error: 'Você não pode mudar a sua própria conta aqui.' });
  if (req.body.role && ['member', 'viewer', 'admin'].includes(req.body.role)) db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role, id);
  if (typeof req.body.active === 'boolean') {
    db.prepare('UPDATE users SET active=? WHERE id=?').run(req.body.active ? 1 : 0, id);
    if (!req.body.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  res.json({ ok: true });
});

// Eliminar conta: a pessoa perde o acesso e a conta some da lista. Tudo o que ela acrescentou fica,
// com o nome dela e a marca "(conta removida)". O e-mail fica livre para um novo convite.
app.delete('/api/admin/users/:id', needAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Conta não encontrada.' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'Você não pode eliminar a sua própria conta.' });
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n <= 1) return res.status(400).json({ error: 'É o único administrador.' });
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO removed_users(id,name,email,removed_at) VALUES(?,?,?,?)').run(u.id, u.name, u.email, now());
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM resets WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  })();
  log(req, 'eliminou conta', 'usuário ' + u.id, { nome: u.name, email: u.email });
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/reset', needAdmin, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Conta não encontrada.' });
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('DELETE FROM resets WHERE user_id=?').run(u.id);
  db.prepare('INSERT INTO resets(token,user_id,expires) VALUES(?,?,?)').run(token, u.id, Date.now() + 3 * 864e5);
  log(req, 'criou link de nova senha', 'usuário ' + u.id);
  res.json({ token });
});
app.get('/api/admin/access-requests', needAdmin, (req, res) => {
  const rows = db.prepare(`SELECT r.id,r.name,r.email,r.relation,r.message,r.status,r.created_at createdAt,r.decided_at decidedAt,r.invite_token inviteToken,u.name decidedBy
    FROM access_requests r LEFT JOIN users u ON u.id=r.decided_by ORDER BY (r.status='pending') DESC, r.id DESC LIMIT 200`).all();
  res.json({ requests: rows });
});
app.post('/api/admin/access-requests/:id/approve', needAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(r.email)) return res.status(400).json({ error: 'Já existe uma conta com esse e-mail.' });
  const role = ['member', 'viewer'].includes(req.body.role) ? req.body.role : 'member';
  const who = inviteePerson(req.body.personId); if (who.error) return res.status(400).json({ error: who.error });
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO invites(token,role,label,email,created_by,created_at,expires,person_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(token, role, `${r.name} (${r.relation})`.slice(0, 100), r.email, req.user.id, now(), Date.now() + 30 * 864e5, who.pid);
  db.prepare("UPDATE access_requests SET status='approved', decided_by=?, decided_at=?, invite_token=? WHERE id=?").run(req.user.id, now(), token, r.id);
  log(req, 'aprovou pedido de acesso', r.email, { name: r.name, relation: r.relation, role });
  const family = BRAND.name;
  mail.send(r.email, `Seu acesso ao ${family} foi aprovado`,
    `Olá, ${r.name}!\n\nSeu pedido para participar do ${family}, a árvore da família, foi aprovado.\n\n${who.name ? `Você já está na árvore como ${who.name}. ` : ''}Toque no link abaixo para criar a sua senha. Ele confirma o seu e-mail e vale 30 dias:\n${baseUrl(req)}/convite/${token}\n\nDepois, é só entrar em ${baseUrl(req)} com o e-mail ${r.email} e a sua senha.\n\nSe você não pediu este acesso, ignore este e-mail.`)
    .then(mailed => res.json({ token, email: r.email, name: r.name, mailed }));
});
app.post('/api/admin/access-requests/:id/reject', needAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
  db.prepare("UPDATE access_requests SET status='rejected', decided_by=?, decided_at=? WHERE id=?").run(req.user.id, now(), r.id);
  log(req, 'recusou pedido de acesso', r.email, { name: r.name });
  res.json({ ok: true });
});
// Cancelar: um pedido aguardando ou um convite aprovado que ainda não foi usado (o link do e-mail deixa de funcionar).
app.post('/api/admin/access-requests/:id/cancel', needAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!['pending', 'approved'].includes(r.status)) return res.status(400).json({ error: 'Este pedido já não pode ser cancelado.' });
  if (r.invite_token) db.prepare('DELETE FROM invites WHERE token=? AND used_by IS NULL').run(r.invite_token);
  db.prepare("UPDATE access_requests SET status='cancelled', decided_by=?, decided_at=? WHERE id=?").run(req.user.id, now(), r.id);
  log(req, 'cancelou pedido de acesso', r.email, { name: r.name, antes: r.status });
  res.json({ ok: true });
});
// Tirar da lista um pedido já resolvido (o histórico guarda o registro).
app.delete('/api/admin/access-requests/:id', needAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM access_requests WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (['pending', 'approved'].includes(r.status)) return res.status(400).json({ error: 'Cancele ou recuse o pedido antes de apagar.' });
  db.prepare('DELETE FROM access_requests WHERE id=?').run(r.id);
  log(req, 'apagou pedido de acesso da lista', r.email, { name: r.name, status: r.status });
  res.json({ ok: true });
});
app.get('/api/admin/family-link', needAdmin, (req, res) => res.json({ token: getSetting('family_link') || null }));
app.post('/api/admin/family-link', needAdmin, (req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  setSetting('family_link', token);
  log(req, 'criou novo link da família', '');
  res.json({ token });
});
app.delete('/api/admin/family-link', needAdmin, (req, res) => {
  setSetting('family_link', '');
  log(req, 'desligou o link da família', '');
  res.json({ ok: true });
});
app.get('/api/admin/activity', needAdmin, (req, res) => {
  const rows = db.prepare('SELECT a.id,a.action,a.target,a.detail,a.at,u.name FROM activity a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300').all();
  res.json({ activity: rows });
});

app.get('/api/export.json', needAdmin, (req, res) => {
  const people = db.prepare('SELECT * FROM people').all().map(p => { const o = personOut(p); delete o.createdBy; return o; });
  const users = Object.fromEntries(db.prepare('SELECT id,name FROM users').all().map(u => [u.id, u.name]));
  const notes = db.prepare('SELECT person_id personId,kind,text,created_by,created_at at FROM notes').all().map(n => ({ personId: n.personId, kind: n.kind, text: n.text, by: users[n.created_by] || '', at: n.at }));
  const media = db.prepare('SELECT person_id personId,url,title,created_by,created_at at FROM media_links').all().map(m => ({ personId: m.personId, url: m.url, title: m.title, by: users[m.created_by] || '', at: m.at }));
  const links = db.prepare('SELECT child_id child,parent_id parent,role FROM links').all();
  res.set('Content-Disposition', `attachment; filename="arvore-familia-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ format: 'arvore-familia-v1', exportedAt: now(), people, notes, links, media });
});
app.get('/api/export.ged', needAdmin, (req, res) => {
  const people = db.prepare('SELECT * FROM people').all().map(personOut);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="arvore-familia-${new Date().toISOString().slice(0, 10)}.ged"`);
  res.send(toGedcom(people, process.env.FAMILY_NAME || 'Arvore da Familia'));
});

app.post('/api/admin/import', needAdmin, (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.people)) return res.status(400).json({ error: 'Arquivo inválido.' });
  let added = 0, updated = 0;
  const tx = db.transaction(() => {
    for (const raw of data.people) {
      if (!raw || typeof raw.id !== 'string' || !raw.name) continue;
      const id = raw.id.slice(0, 80), d = clean(raw), t = now();
      const cur = db.prepare('SELECT id FROM people WHERE id=?').get(id);
      const cols = Object.keys(d);
      if (cur) { db.prepare(`UPDATE people SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(c => d[c]), t, id); updated++; }
      else { db.prepare(`INSERT INTO people(id,${cols.join(',')},created_by,created_at,updated_at) VALUES(?,${cols.map(() => '?').join(',')},NULL,?,?)`).run(id, ...cols.map(c => d[c]), t, t); added++; }
    }
    for (const n of data.notes || []) {
      if (!n || !n.personId || !n.text) continue;
      const text = (n.by ? `${String(n.text)} (por ${String(n.by)})` : String(n.text)).slice(0, 5000);
      if (!db.prepare('SELECT 1 FROM notes WHERE person_id=? AND text=?').get(n.personId, text))
        db.prepare('INSERT INTO notes(person_id,kind,text,created_by,created_at) VALUES(?,?,?,NULL,?)').run(n.personId, n.kind === 'memory' ? 'memory' : 'info', text, n.at || now());
    }
    for (const m of data.media || []) {
      const url = m && cleanUrl(m.url);
      if (url && m.personId && !db.prepare('SELECT 1 FROM media_links WHERE person_id=? AND url=?').get(m.personId, url))
        db.prepare('INSERT INTO media_links(person_id,url,title,created_by,created_at) VALUES(?,?,?,NULL,?)').run(m.personId, url, String(m.title || '').slice(0, 200), m.at || now());
    }
    for (const l of data.links || []) {
      if (l && l.child && l.parent && ['father', 'mother'].includes(l.role))
        db.prepare('INSERT INTO links(child_id,parent_id,role,created_by,created_at) VALUES(?,?,?,NULL,?)').run(l.child, l.parent, l.role, now());
    }
  });
  tx();
  alignSiblings(req);
  res.json({ added, updated });
});

// Lote dos relatórios de entrevista (tabela colada ou CSV). Sem "apply" só mostra o que faria.
app.post('/api/admin/import-lote', needAdmin, (req, res) => {
  const text = String((req.body && req.body.text) || '');
  if (!text.trim()) return res.status(400).json({ error: 'Cole a tabela do lote ou escolha um arquivo.' });
  if (text.length > 200000) return res.status(400).json({ error: 'Lote grande demais.' });
  const apply = !!req.body.apply;
  const r = runLote(db, text, { apply, userId: req.user.id, newId, now });
  if (r.error) return res.status(400).json({ error: r.error });
  if (apply) { log(req, 'importou lote', null, { linhas: r.rows.length, ok: r.ok, erros: r.erros }); r.aligned = alignSiblings(req).length; }
  res.json(r);
});

// ---------- relatos (pasta com ficha.md, relato.md, lote.csv e material/) ----------
const RELATO_DIR = path.join(UPLOAD_DIR, 'relatos');
const INBOX_DIR = path.resolve(process.env.RELATOS_INBOX || path.join(DATA_DIR, 'relatos-entrada'));
fs.mkdirSync(RELATO_DIR, { recursive: true });
fs.mkdirSync(INBOX_DIR, { recursive: true });
const staging = new Map(); // token -> { staged, at, inbox }
const stage = (staged, inbox) => {
  for (const [k, v] of staging) if (Date.now() - v.at > 3600e3) staging.delete(k);
  const token = crypto.randomBytes(16).toString('hex'); staging.set(token, { staged, at: Date.now(), inbox, user: null }); return token;
};
// Assinatura barata de uma pasta da entrada: nomes, tamanhos e datas dos arquivos.
function folderSig(dir) {
  const parts = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const p = path.join(d, e.name), r = rel + '/' + e.name; if (e.isDirectory()) walk(p, r); else { const st = fs.statSync(p); parts.push(r + ':' + st.size + ':' + Math.floor(st.mtimeMs)); } } };
  walk(dir, ''); return crypto.createHash('sha1').update(parts.sort().join('|')).digest('hex');
}
function inboxState() {
  try {
    return relatos.listInbox(INBOX_DIR).map(dir => {
      const rel = path.relative(INBOX_DIR, dir).split(path.sep).join('/'), sig = folderSig(dir), seen = getSetting('inbox:' + rel);
      return { folder: rel, state: !seen ? 'novo' : seen === sig ? 'importado' : 'mudou', sig };
    });
  } catch (e) { console.error('Entrada de relatos:', e.message); return []; }
}
function saveRelatoFile(f) {
  const stored = crypto.randomBytes(16).toString('hex') + path.extname(f.name).toLowerCase().replace(/[^.a-z0-9]/g, '');
  fs.writeFileSync(path.join(RELATO_DIR, stored), f.data);
  return stored;
}
const relatoOpts = (req, extra) => ({ userId: req.user.id, newId, now, saveFile: saveRelatoFile, ...extra });
const relatoUpload = multer({ storage: multer.memoryStorage(), preservePath: true, limits: { fileSize: 100 * 1024 * 1024, files: 200 } });

app.post('/api/admin/relatos/upload', needAdmin, (req, res) => {
  relatoUpload.array('files', 200)(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo grande demais (máx. 100 MB cada).' : 'Não foi possível enviar a pasta.' });
    try {
      const files = (req.files || []).map(f => ({ name: Buffer.from(f.originalname, 'latin1').toString('utf8'), data: f.buffer }));
      if (!files.length) return res.status(400).json({ error: 'Escolha a pasta do relato ou o .zip.' });
      const staged = relatos.readFolder(files);
      const token = stage(staged, null);
      res.json({ token, ...relatos.runRelato(db, staged, relatoOpts(req)) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
});
app.get('/api/admin/relatos', needAdmin, (req, res) => {
  res.json({
    relatos: db.prepare('SELECT id,fonte,data,imported_at importedAt,applied,skipped FROM relatos ORDER BY imported_at DESC').all(),
    inbox: inboxState().map(({ folder, state }) => ({ folder, state }))
  });
});
app.post('/api/admin/relatos/inbox', needAdmin, (req, res) => {
  const item = inboxState().find(x => x.folder === String(req.body.folder || ''));
  if (!item) return res.status(404).json({ error: 'Pasta não encontrada na entrada.' });
  try {
    const staged = relatos.readInboxFolder(path.join(INBOX_DIR, item.folder));
    const token = stage(staged, item);
    res.json({ token, ...relatos.runRelato(db, staged, relatoOpts(req)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/relatos/run', needAdmin, (req, res) => {
  const st = staging.get(String(req.body.token || ''));
  if (!st) return res.status(400).json({ error: 'A prévia expirou. Abra o relato de novo.' });
  const decisions = {};
  for (const [k, v] of Object.entries(req.body.decisions || {})) if (typeof v === 'string' && /^(new|skip|keep|id:.+)$/.test(v)) decisions[String(k).slice(0, 300)] = v;
  try {
    const r = relatos.runRelato(db, st.staged, relatoOpts(req, { decisions, apply: !!req.body.apply }));
    if (req.body.apply) {
      if (st.inbox) setSetting('inbox:' + st.inbox.folder, st.inbox.sig);
      staging.delete(String(req.body.token));
      log(req, 'importou relato', st.staged.meta.id, { linhas: r.rows.length, aplicadas: r.rows.filter(x => x.ok).length });
      r.aligned = alignSiblings(req).length;
    }
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao importar o relato.' }); if (!e.status) console.error(e); }
});
// Marcar uma pasta da entrada como vista sem importar (ex.: relato antigo já lançado à mão).
app.post('/api/admin/relatos/inbox/ignore', needAdmin, (req, res) => {
  const item = inboxState().find(x => x.folder === String(req.body.folder || ''));
  if (!item) return res.status(404).json({ error: 'Pasta não encontrada.' });
  setSetting('inbox:' + item.folder, item.sig); res.json({ ok: true });
});
// Na ficha da pessoa: ocultar, mostrar de novo ou apagar a ligação com um relato (só o administrador).
// Apagar tira a citação da ficha e não volta ao reimportar; o relato e os dados que ele trouxe continuam.
app.post('/api/admin/relato-people', needAdmin, (req, res) => {
  const relatoId = String(req.body.relatoId || ''), personId = String(req.body.personId || ''), action = String(req.body.action || '');
  const val = { hide: 1, show: 0, remove: 2 }[action];
  if (val === undefined) return res.status(400).json({ error: 'Ação inválida.' });
  const r = db.prepare('UPDATE relato_people SET hidden=? WHERE relato_id=? AND person_id=?').run(val, relatoId, personId);
  if (!r.changes) return res.status(404).json({ error: 'Esta pessoa não está ligada a esse relato.' });
  log(req, { hide: 'ocultou relato na ficha', show: 'mostrou relato na ficha', remove: 'apagou relato da ficha' }[action], personId, { relatoId });
  res.json({ ok: true });
});
app.get('/api/relatos/:id', needWriter, (req, res) => {
  const r = db.prepare('SELECT id,fonte,data,ficha,relato,imported_at importedAt,applied,skipped FROM relatos WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Relato não encontrado.' });
  // material do relato (fotos de certidões, CTPS...): só o administrador
  r.files = req.user.role === 'admin' ? db.prepare('SELECT id,name,mime,size FROM relato_files WHERE relato_id=? ORDER BY name').all(r.id) : [];
  r.people = db.prepare('SELECT person_id FROM relato_people WHERE relato_id=? AND hidden<2').all(r.id).map(x => x.person_id);
  res.json(r);
});
app.get('/api/relatos/:id/files/:fid', needAdmin, (req, res) => {
  const f = db.prepare('SELECT * FROM relato_files WHERE id=? AND relato_id=?').get(Number(req.params.fid), req.params.id);
  if (!f) return res.status(404).end();
  res.set('Content-Type', f.mime || 'application/octet-stream');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; frame-ancestors 'self'; sandbox");
  res.set('Content-Disposition', `${/^(image|audio|video)\/|pdf/.test(f.mime) && !req.query.download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(RELATO_DIR, path.basename(f.stored)));
});
// Pendências: alertas pulados e possíveis duplicados
app.get('/api/admin/pending', needAdmin, (req, res) => {
  res.json({ pending: db.prepare("SELECT id,kind,relato_id relatoId,title,data,created_at createdAt FROM pending WHERE status='open' ORDER BY created_at DESC").all().map(p => ({ ...p, data: JSON.parse(p.data || '{}') })) });
});
app.post('/api/admin/pending/:id/close', needAdmin, (req, res) => {
  db.prepare("UPDATE pending SET status='closed' WHERE id=?").run(Number(req.params.id)); res.json({ ok: true });
});
// Ligações sugeridas a partir das notas ("Irmã do Clemente", "casada com tio Joaquim")
app.get('/api/admin/suggestions', needAdmin, (req, res) => res.json({ suggestions: sugestoes.suggest(db, effectiveParents) }));
app.post('/api/admin/suggestions/apply', needAdmin, (req, res) => {
  const keys = new Set([].concat(req.body.keys || req.body.key || []).map(String));
  const list = sugestoes.suggest(db, effectiveParents).filter(x => keys.has(x.key));
  if (!list.length) return res.status(404).json({ error: 'Sugestão não encontrada (talvez já tenha sido aplicada).' });
  const applied = [];
  db.transaction(() => {
    for (const sg of list) for (const c of sg.changes) {
      if (c.spouse) {
        const [a, b] = c.spouse.map(id => db.prepare('SELECT id,spouse_id FROM people WHERE id=?').get(id));
        if (a && b && !a.spouse_id && !b.spouse_id) { db.prepare('UPDATE people SET spouse_id=?, updated_at=? WHERE id=?').run(b.id, now(), a.id); db.prepare('UPDATE people SET spouse_id=?, updated_at=? WHERE id=?').run(a.id, now(), b.id); }
      } else {
        const cur = effectiveParents()[c.child] || {};
        if (!cur[c.role === 'father' ? 'f' : 'm']) db.prepare('INSERT INTO links(child_id,parent_id,role,created_by,created_at) VALUES(?,?,?,?,?)').run(c.child, c.parent, c.role, req.user.id, now());
      }
      applied.push(sg.describe);
    }
  })();
  log(req, 'ligou pessoas a partir das notas', null, { sugestoes: list.map(x => ({ nota: x.quote, mudancas: x.describe })) });
  const extra = alignSiblings(req).length;
  res.json({ ok: true, applied: list.length, aligned: extra });
});
app.post('/api/admin/suggestions/dismiss', needAdmin, (req, res) => { setSetting('nosug:' + String(req.body.key || '').slice(0, 40), '1'); res.json({ ok: true }); });
// Juntar duas fichas da mesma pessoa (só o administrador, com confirmação).
// Fica a ficha "keep"; a outra é apagada depois de passar tudo para ela. Nada se perde:
// campos vazios são completados, valores diferentes viram nota, o nome da outra vira nome alternativo.
app.post('/api/admin/merge', needAdmin, (req, res) => {
  const keep = db.prepare('SELECT * FROM people WHERE id=?').get(String(req.body.keep || ''));
  const gone = db.prepare('SELECT * FROM people WHERE id=?').get(String(req.body.remove || ''));
  if (!keep || !gone) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (keep.id === gone.id) return res.status(400).json({ error: 'Escolha duas pessoas diferentes.' });
  if ([keep.father_id, keep.mother_id].includes(gone.id) || [gone.father_id, gone.mother_id].includes(keep.id)) return res.status(400).json({ error: 'Uma é pai ou mãe da outra; não podem ser a mesma pessoa.' });
  const nm = id => { const q = id && db.prepare('SELECT name FROM people WHERE id=?').get(id); return q ? q.name : id; };
  const LBL = { name: 'nome', given: 'primeiro nome', nick: 'apelido', sex: 'sexo', birth: 'nascimento', birth_place: 'local de nascimento', death: 'falecimento', death_place: 'local de falecimento', father_id: 'pai', mother_id: 'mãe', spouse_id: 'cônjuge', marriage: 'casamento', marriage_place: 'local do casamento', descendants: 'descendentes', color: 'cor/raça', origin: 'origem/etnia' };
  const diffs = [], set = {};
  db.transaction(() => {
    for (const f of FIELDS) {
      let a = keep[f] || '', b = gone[f] || '';
      if (['father_id', 'mother_id', 'spouse_id'].includes(f) && b === keep.id) b = '';
      if (!b || a === b) continue;
      if (f === 'notes' || f === 'sources') { set[f] = a ? a + '\n' + b : b; continue; }
      if (!a) set[f] = b; else diffs.push(`${LBL[f] || f}: "${['father_id', 'mother_id', 'spouse_id'].includes(f) ? nm(b) : b}"`);
    }
    if (!keep.photo_file_id && gone.photo_file_id) set.photo_file_id = gone.photo_file_id;
    const cols = Object.keys(set);
    if (cols.length) db.prepare(`UPDATE people SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(c => set[c]), now(), keep.id);
    if (diffs.length) db.prepare('INSERT INTO notes(person_id,kind,text,created_by,created_at) VALUES(?,?,?,?,?)').run(keep.id, 'info', `Juntado com outra ficha ("${gone.name}"), que dizia: ${diffs.join('; ')}.`, req.user.id, now());
    // filhos, cônjuges e ligações passam para a ficha que fica
    for (const k of ['father_id', 'mother_id', 'spouse_id']) db.prepare(`UPDATE people SET ${k}=? WHERE ${k}=? AND id<>?`).run(keep.id, gone.id, keep.id);
    db.prepare('UPDATE people SET spouse_id=? WHERE id=? AND spouse_id=?').run('', keep.id, keep.id);
    db.prepare('UPDATE links SET child_id=? WHERE child_id=?').run(keep.id, gone.id);
    db.prepare('UPDATE links SET parent_id=? WHERE parent_id=?').run(keep.id, gone.id);
    db.prepare('DELETE FROM links WHERE child_id=parent_id').run();
    for (const t of ['notes', 'files', 'media_links']) db.prepare(`UPDATE ${t} SET person_id=? WHERE person_id=?`).run(keep.id, gone.id);
    db.prepare('INSERT OR IGNORE INTO relato_people(relato_id,person_id,hidden) SELECT relato_id,?,hidden FROM relato_people WHERE person_id=?').run(keep.id, gone.id);
    db.prepare('DELETE FROM relato_people WHERE person_id=?').run(gone.id);
    db.prepare('UPDATE person_aliases SET person_id=? WHERE person_id=?').run(keep.id, gone.id);
    const al = norm(gone.name); if (al && al !== norm(keep.name)) db.prepare('INSERT OR REPLACE INTO person_aliases(alias,person_id,created_at) VALUES(?,?,?)').run(al, keep.id, now());
    if (!db.prepare('SELECT 1 FROM users WHERE person_id=?').get(keep.id)) db.prepare('UPDATE users SET person_id=? WHERE person_id=?').run(keep.id, gone.id); else db.prepare("UPDATE users SET person_id='' WHERE person_id=?").run(gone.id);
    db.prepare('DELETE FROM not_duplicates WHERE a=? OR b=?').run(gone.id, gone.id);
    db.prepare('DELETE FROM people WHERE id=?').run(gone.id);
  })();
  log(req, 'juntou duas fichas da mesma pessoa', keep.id, { ficou: keep.name, apagada: gone });
  alignSiblings(req);
  res.json({ ok: true, completed: Object.keys(set), conflicts: diffs });
});
app.get('/api/admin/duplicates', needAdmin, (req, res) => res.json({ pairs: relatos.scanDuplicates(db) }));
app.post('/api/admin/duplicates/not', needAdmin, (req, res) => {
  const a = String(req.body.a || ''), b = String(req.body.b || '');
  if (!exists(a) || !exists(b)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  const [x, y] = [a, b].sort();
  db.prepare('INSERT OR IGNORE INTO not_duplicates(a,b) VALUES(?,?)').run(x, y);
  log(req, 'marcou como pessoas diferentes', null, { a: x, b: y });
  res.json({ ok: true });
});

// ---------- páginas ----------
// 'no-cache': o navegador sempre confere se há versão nova (rápido, usa ETag), então atualizações aparecem na hora.
// Página principal e manifesto com a marca do .env (BRAND_NAME, BRAND_LINE, BRAND_SLOGAN, FAMILY_SUBTITLE).
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let indexHtml = null;
// "Ocê é fi dequem?": o nome da marca dentro da frase ganha destaque
const sloganHtml = () => { const n = BRAND.name.toLowerCase(), s = escHtml(BRAND.slogan), i = s.toLowerCase().lastIndexOf(n); return i < 0 ? s : s.slice(0, i) + `<b class="sloganword">${s.slice(i, i + n.length)}</b>` + s.slice(i + n.length); };
function sendIndex(req, res) {
  if (!indexHtml || process.env.NODE_ENV === 'development') indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const html = indexHtml.replace(/\{\{BRAND_NAME\}\}/g, escHtml(BRAND.name)).replace(/\{\{BRAND_LINE\}\}/g, escHtml(BRAND.line))
    .replace(/\{\{BRAND_SLOGAN\}\}/g, sloganHtml()).replace(/\{\{FAMILY\}\}/g, escHtml(familyName())).replace(/\{\{BASE\}\}/g, BASE);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
}
app.get(['/', '/index.html'], sendIndex);
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
  name: `${BRAND.name} · ${BRAND.line}`, short_name: BRAND.name, start_url: BASE + '/', scope: BASE + '/', display: 'standalone',
  background_color: '#F8EFE6', theme_color: '#F8EFE6', lang: 'pt-BR',
  icons: [
    { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2)));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', setHeaders: res => res.set('Cache-Control', 'no-cache') }));
app.get('/familia/:token', (req, res) => {
  const current = getSetting('family_link'), t = String(req.params.token);
  if (current && t.length === current.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(current))) {
    res.setHeader('Set-Cookie', `${CK('fam')}=${current}; HttpOnly; SameSite=Lax; Path=${CPATH}; Max-Age=${GUEST_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
    return res.redirect(302, BASE + '/');
  }
  res.redirect(302, BASE + '/?link=invalido');
});
// Código de livro que não existe: volta para a entrada com um aviso.
if (!BOOK_CODE) app.get(/^\/[A-Za-z0-9]{5}\/?$/, (req, res) => res.redirect(302, '/?livro=naoencontrado'));
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.get(/^\/((convite|senha)\/[\w-]+)?$/, sendIndex);
app.use('/api', (req, res) => res.status(404).json({ error: 'Não encontrado.' }));
// Erros: resposta simples, sem detalhes internos.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Dados grandes demais.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Pedido inválido.' });
  console.error(err);
  res.status(500).json({ error: 'Erro no servidor. Tente de novo.' });
});

app.locals.sendDigest = sendDigest; // usado nos testes
app.locals.books = books;
if (require.main === module) {
  setInterval(() => { try { sendDigest(); } catch (e) { console.error('resumo:', e.message); } }, 5 * 60e3);
  if (typeof PORT === 'string') try { fs.unlinkSync(PORT); } catch { /* não existia */ }
  app.listen(PORT, () => {
    console.log(BOOK_CODE ? `Livro ${BOOK_CODE} aberto (dados em ${DATA_DIR})` : `Árvore da Família rodando em http://localhost:${PORT} (dados em ${DATA_DIR})`);
    if (process.send) process.send('pronto');
    if (BOOK_CODE) try { sendDigest(); } catch (e) { console.error('resumo:', e.message); } // o livro pode ter ficado dormindo à meia-noite
  });
  if (books) books.startTimers();
}
module.exports = { app, db };
