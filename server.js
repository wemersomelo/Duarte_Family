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
const { runLote } = require('./src/lote');
const relatos = require('./src/relatos');

const PORT = Number(process.env.PORT || 3000);
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
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
}
app.use((req, res, next) => {
  const sid = parseCookies(req).sid;
  req.user = null;
  if (sid) {
    const row = db.prepare('SELECT u.id,u.name,u.email,u.role,u.person_id,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1').get(sid);
    if (row && row.expires > Date.now()) { req.user = { id: row.id, name: row.name, email: row.email, role: row.role, personId: row.person_id || '' }; req.sid = sid; }
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
const baseUrl = req => process.env.DOMAIN ? 'https://' + process.env.DOMAIN : `${req.protocol}://${req.get('host')}`;
// Mostra só o começo do e-mail (ex.: ma***@gmail.com) para quem pediu acesso neste aparelho.
const maskEmail = e => { const [u, d] = String(e).split('@'); return (u.length <= 2 ? u[0] : u.slice(0, 2)) + '***@' + d; };
// Pessoa inicial de quem não tem pessoa ligada (visitantes): a pessoa do primeiro administrador.
function startPerson() {
  const a = db.prepare("SELECT person_id FROM users WHERE role='admin' AND active=1 AND person_id<>'' ORDER BY id LIMIT 1").get();
  return (a && exists(a.person_id) ? a.person_id : '') || process.env.DEFAULT_PERSON || '';
}
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const GUEST_DAYS = 30;
app.use((req, res, next) => {
  req.guest = false;
  if (!req.user) {
    const fam = parseCookies(req).fam, current = getSetting('family_link');
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
function guestPerson(p) {
  if (isDeceased(p)) return { ...p, createdBy: null };
  return { id: p.id, name: p.name, given: p.given, nick: p.nick, sex: p.sex, fatherId: p.fatherId, motherId: p.motherId, spouseId: p.spouseId, living: true, createdBy: null };
}
const needWriter = (req, res, next) => req.user && req.user.role !== 'viewer' ? next() : res.status(403).json({ error: 'Seu acesso é só de leitura.' });
const needAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Só o administrador pode fazer isso.' });
const owns = (req, createdBy) => req.user.role === 'admin' || (createdBy != null && createdBy === req.user.id);
// A própria pessoa (conta ligada a ela) também pode corrigir os seus dados, mesmo que outro parente tenha criado o registro.
const isSelf = (req, p) => !!req.user.personId && req.user.personId === p.id;

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
}

// ---------- utilidades ----------
const FIELDS = ['name', 'given', 'nick', 'sex', 'birth', 'birth_place', 'death', 'death_place', 'father_id', 'mother_id', 'spouse_id', 'marriage', 'marriage_place', 'notes', 'sources', 'color', 'origin'];
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
  return out;
}
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pessoa';
const newId = name => `${slug(name)}-${crypto.randomBytes(3).toString('hex')}`;
const now = () => new Date().toISOString();
function personOut(p) {
  return {
    id: p.id, name: p.name, given: p.given || '', nick: p.nick, sex: p.sex, birth: p.birth, birthPlace: p.birth_place,
    death: p.death, deathPlace: p.death_place, fatherId: p.father_id, motherId: p.mother_id,
    spouseId: p.spouse_id, marriage: p.marriage || '', marriagePlace: p.marriage_place || '', notes: p.notes, sources: p.sources, color: p.color || '', origin: p.origin || '', photoFileId: p.photo_file_id || '', createdBy: p.created_by,
    createdAt: p.created_at, updatedAt: p.updated_at
  };
}
function exists(id) { return !!db.prepare('SELECT 1 FROM people WHERE id=?').get(id); }

// ---------- conta ----------
app.get('/api/status', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const pending = req.user && req.user.role === 'admin' ? db.prepare("SELECT COUNT(*) n FROM access_requests WHERE status='pending'").get().n : 0;
  // Quem pediu acesso neste aparelho vê em que pé está o pedido (o convite em si só chega pelo e-mail).
  let request = null;
  const claim = !req.user && parseCookies(req).pedido;
  if (claim) {
    const r = db.prepare('SELECT status,email FROM access_requests WHERE claim=?').get(String(claim));
    if (r) request = { status: r.status, email: maskEmail(r.email), mailed: r.status === 'approved' && mail.configured() };
  }
  const inboxNew = req.user && req.user.role === 'admin' ? inboxState().filter(x => x.state !== 'importado').length : 0;
  res.json({ request, inboxNew, needsSetup: users === 0, pendingRequests: pending, user: req.user || (req.guest ? { id: null, name: 'Visitante', role: 'guest' } : null), familyName: process.env.FAMILY_NAME || 'Árvore da Família', defaultPerson: startPerson() });
});

app.post('/api/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return res.status(400).json({ error: 'O administrador já foi criado.' });
  const setupKey = process.env.SETUP_KEY;
  if (setupKey && req.body.setupKey !== setupKey) return res.status(403).json({ error: 'Chave de instalação incorreta.' });
  const { name, email, password } = req.body || {};
  const err = checkAccount(name, email, password); if (err) return res.status(400).json({ error: err });
  const id = db.prepare('INSERT INTO users(name,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), 'admin', now()).lastInsertRowid;
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

app.post('/api/logout', (req, res) => {
  if (req.sid) db.prepare('DELETE FROM sessions WHERE token=?').run(req.sid);
  res.setHeader('Set-Cookie', ['sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'fam=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0']);
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
  const id = db.prepare('INSERT INTO users(name,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), inv.role, now()).lastInsertRowid;
  db.prepare('UPDATE invites SET used_by=?, used_at=? WHERE token=?').run(id, now(), inv.token);
  db.prepare("UPDATE access_requests SET status='joined' WHERE invite_token=?").run(inv.token);
  // Já entra ligado à sua ficha na árvore, se o administrador escolheu ao convidar.
  if (inv.person_id && exists(inv.person_id) && !db.prepare('SELECT 1 FROM users WHERE person_id=?').get(inv.person_id))
    db.prepare('UPDATE users SET person_id=? WHERE id=?').run(inv.person_id, id);
  setSession(res, id);
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
  res.setHeader('Set-Cookie', `pedido=${claim}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
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
  const files = db.prepare('SELECT id,person_id personId,original_name name,mime,size,caption,created_by createdBy,created_at createdAt FROM files ORDER BY created_at').all();
  const users = db.prepare('SELECT id,name FROM users').all();
  // Relatos que citam cada pessoa (só para quem pode editar; os relatos são privados).
  const relatoLinks = req.user && req.user.role !== 'viewer' ? db.prepare('SELECT rp.person_id personId, r.id relatoId, r.fonte, r.data FROM relato_people rp JOIN relatos r ON r.id=rp.relato_id ORDER BY r.data').all() : [];
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
  res.json({ people, notes, files, media, users, relatoLinks, me: req.user });
});

// Cada conta pode dizer quem ela é na árvore.
app.put('/api/me/person', needUser, (req, res) => {
  const pid = String(req.body.personId || '');
  if (pid && !exists(pid)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (pid && req.user.role !== 'admin') {
    if (isDeceased(personOut(db.prepare('SELECT * FROM people WHERE id=?').get(pid)))) return res.status(400).json({ error: 'Esta pessoa já faleceu, então não pode ser você.' });
    const other = db.prepare('SELECT name FROM users WHERE person_id=? AND id<>?').get(pid, req.user.id);
    if (other) return res.status(409).json({ error: `Esta pessoa já está ligada à conta de ${other.name}. Fale com o administrador.` });
  }
  db.prepare('UPDATE users SET person_id=? WHERE id=?').run(pid, req.user.id);
  log(req, pid ? 'se identificou na árvore' : 'desfez a identificação na árvore', pid || null);
  res.json({ ok: true, personId: pid });
});

// ---------- pessoas ----------
app.post('/api/people', needWriter, (req, res) => {
  const d = clean(req.body);
  if (!d.name) return res.status(400).json({ error: 'Escreva pelo menos o nome.' });
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
  res.json({ id });
});

app.put('/api/people/:id', needUser, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (req.user.role === 'viewer' && !isSelf(req, p)) return res.status(403).json({ error: 'Seu acesso é só de leitura.' });
  if (!owns(req, p.created_by) && !isSelf(req, p)) return res.status(403).json({ error: 'Você só pode alterar o que você mesmo adicionou. Use "Acrescentar informação".' });
  const d = clean(req.body);
  if ('name' in d && !d.name) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
  for (const k of ['father_id', 'mother_id', 'spouse_id']) if (d[k] && (d[k] === p.id || !exists(d[k]))) d[k] = '';
  const cols = Object.keys(d);
  if (cols.length) db.prepare(`UPDATE people SET ${cols.map(c => c + '=?').join(',')}, updated_at=?, updated_by=? WHERE id=?`)
    .run(...cols.map(c => d[c]), now(), req.user.id, p.id);
  log(req, 'editou pessoa', p.id, { antes: Object.fromEntries(cols.map(c => [c, p[c]])), depois: d });
  res.json({ ok: true });
});

app.delete('/api/people/:id', needWriter, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (!owns(req, p.created_by)) return res.status(403).json({ error: 'Você só pode excluir o que você mesmo adicionou.' });
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
  log(req, kind === 'memory' ? 'deixou lembrança' : 'acrescentou informação', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/notes/:id', needWriter, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Não encontrada.' });
  if (!owns(req, n.created_by)) return res.status(403).json({ error: 'Você só pode remover o que você escreveu.' });
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
app.delete('/api/media-links/:id', needWriter, (req, res) => {
  const l = db.prepare('SELECT * FROM media_links WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Não encontrado.' });
  if (!owns(req, l.created_by)) return res.status(403).json({ error: 'Você só pode remover o que você adicionou.' });
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
  if (!owns(req, p.created_by) && !isSelf(req, p)) return res.status(403).json({ error: 'Só quem adicionou esta pessoa (ou o administrador) escolhe a foto principal.' });
  const fileId = String(req.body.fileId || '');
  if (fileId) {
    const f = db.prepare('SELECT * FROM files WHERE id=? AND person_id=?').get(fileId, p.id);
    if (!f || !/^image\/(jpeg|png|webp)$/.test(f.mime)) return res.status(400).json({ error: 'Escolha uma foto (JPG, PNG ou WebP) desta pessoa.' });
  }
  db.prepare('UPDATE people SET photo_file_id=?, updated_at=?, updated_by=? WHERE id=?').run(fileId, now(), req.user.id, p.id);
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
    const ins = db.prepare('INSERT INTO files(id,person_id,stored_name,original_name,mime,size,caption,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const f of req.files) {
      const info = await cleanImage(f);
      if (!info) { fs.unlink(f.path, () => {}); continue; }
      ins.run(crypto.randomBytes(8).toString('hex'), req.params.id, info.filename, String(f.originalname).slice(0, 200), info.mime, info.size, caption, req.user.id, now());
    }
    log(req, 'enviou arquivos', req.params.id, { count: req.files.length });
    res.json({ ok: true, count: req.files.length });
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
  const file = path.join(UPLOAD_DIR, path.basename(f.stored_name));
  res.set('Content-Type', f.mime);
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', "frame-ancestors 'self'");
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});
app.delete('/api/files/:id', needWriter, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado.' });
  if (!owns(req, f.created_by)) return res.status(403).json({ error: 'Você só pode remover o que você enviou.' });
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
  const users = db.prepare('SELECT id,name,email,role,active,person_id personId,created_at createdAt FROM users ORDER BY created_at').all();
  const invites = db.prepare('SELECT token,role,label,created_at createdAt,expires,used_by usedBy,person_id personId FROM invites ORDER BY created_at DESC LIMIT 100').all();
  res.json({ users, invites });
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
    db.prepare('UPDATE users SET person_id=? WHERE id=?').run(req.body.personId, id);
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
  const family = process.env.FAMILY_NAME || 'Árvore da Família';
  mail.send(r.email, `Seu acesso à ${family} foi aprovado`,
    `Olá, ${r.name}!\n\nSeu pedido para participar da ${family} foi aprovado.\n\n${who.name ? `Você já está na árvore como ${who.name}. ` : ''}Toque no link abaixo para criar a sua senha. Ele confirma o seu e-mail e vale 30 dias:\n${baseUrl(req)}/convite/${token}\n\nDepois, é só entrar em ${baseUrl(req)} com o e-mail ${r.email} e a sua senha.\n\nSe você não pediu este acesso, ignore este e-mail.`)
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
  if (apply) log(req, 'importou lote', null, { linhas: r.rows.length, ok: r.ok, erros: r.erros });
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
app.get('/api/relatos/:id', needWriter, (req, res) => {
  const r = db.prepare('SELECT id,fonte,data,ficha,relato,imported_at importedAt,applied,skipped FROM relatos WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Relato não encontrado.' });
  r.files = db.prepare('SELECT id,name,mime,size FROM relato_files WHERE relato_id=? ORDER BY name').all(r.id);
  r.people = db.prepare('SELECT person_id FROM relato_people WHERE relato_id=?').all(r.id).map(x => x.person_id);
  res.json(r);
});
app.get('/api/relatos/:id/files/:fid', needWriter, (req, res) => {
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
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', setHeaders: res => res.set('Cache-Control', 'no-cache') }));
app.get('/familia/:token', (req, res) => {
  const current = getSetting('family_link'), t = String(req.params.token);
  if (current && t.length === current.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(current))) {
    res.setHeader('Set-Cookie', `fam=${current}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${GUEST_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}`);
    return res.redirect(302, '/');
  }
  res.redirect(302, '/?link=invalido');
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.get(/^\/((convite|senha)\/[\w-]+)?$/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Não encontrado.' }));
// Erros: resposta simples, sem detalhes internos.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Dados grandes demais.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Pedido inválido.' });
  console.error(err);
  res.status(500).json({ error: 'Erro no servidor. Tente de novo.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Árvore da Família rodando em http://localhost:${PORT} (dados em ${DATA_DIR})`));
}
module.exports = { app, db };
