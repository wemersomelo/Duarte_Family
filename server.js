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

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_DAYS = 60;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);

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
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; form-action 'self'"
  });
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
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
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
    const row = db.prepare('SELECT u.id,u.name,u.email,u.role,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1').get(sid);
    if (row && row.expires > Date.now()) { req.user = { id: row.id, name: row.name, email: row.email, role: row.role }; req.sid = sid; }
  }
  next();
});
const needUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Entre na sua conta.' });
const needWriter = (req, res, next) => req.user && req.user.role !== 'viewer' ? next() : res.status(403).json({ error: 'Seu acesso é só de leitura.' });
const needAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Só o administrador pode fazer isso.' });
const owns = (req, createdBy) => req.user.role === 'admin' || (createdBy != null && createdBy === req.user.id);

// Limite simples de tentativas de login.
const attempts = new Map();
function tooMany(key) {
  const now = Date.now(), a = (attempts.get(key) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(key, a);
  return a.length >= 10;
}
function noteAttempt(key) { const a = attempts.get(key) || []; a.push(Date.now()); attempts.set(key, a); }

// ---------- utilidades ----------
const FIELDS = ['name', 'nick', 'sex', 'birth', 'birth_place', 'death', 'death_place', 'father_id', 'mother_id', 'spouse_id', 'notes', 'sources'];
const MAP = { birthPlace: 'birth_place', deathPlace: 'death_place', fatherId: 'father_id', motherId: 'mother_id', spouseId: 'spouse_id' };
function clean(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    const col = MAP[k] || k;
    if (!FIELDS.includes(col)) continue;
    out[col] = String(v ?? '').trim().slice(0, col === 'notes' ? 5000 : col === 'sources' ? 2000 : 200);
  }
  if ('sex' in out && !['', 'm', 'f'].includes(out.sex)) out.sex = '';
  return out;
}
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pessoa';
const newId = name => `${slug(name)}-${crypto.randomBytes(3).toString('hex')}`;
const now = () => new Date().toISOString();
function personOut(p) {
  return {
    id: p.id, name: p.name, nick: p.nick, sex: p.sex, birth: p.birth, birthPlace: p.birth_place,
    death: p.death, deathPlace: p.death_place, fatherId: p.father_id, motherId: p.mother_id,
    spouseId: p.spouse_id, notes: p.notes, sources: p.sources, photoFileId: p.photo_file_id || '', createdBy: p.created_by,
    createdAt: p.created_at, updatedAt: p.updated_at
  };
}
function exists(id) { return !!db.prepare('SELECT 1 FROM people WHERE id=?').get(id); }

// ---------- conta ----------
app.get('/api/status', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  res.json({ needsSetup: users === 0, user: req.user, familyName: process.env.FAMILY_NAME || 'Árvore da Família', defaultPerson: process.env.DEFAULT_PERSON || '' });
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
  if (tooMany(key)) return res.status(429).json({ error: 'Muitas tentativas. Espere 15 minutos.' });
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) { noteAttempt(key); return res.status(401).json({ error: 'E-mail ou senha incorretos.' }); }
  setSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.sid) db.prepare('DELETE FROM sessions WHERE token=?').run(req.sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
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

// ---------- convites ----------
app.get('/api/invites/:token', (req, res) => {
  const inv = db.prepare('SELECT role,label,used_by,expires FROM invites WHERE token=?').get(req.params.token);
  if (!inv || inv.used_by || inv.expires < Date.now()) return res.status(404).json({ error: 'Convite inválido ou já usado.' });
  res.json({ role: inv.role, label: inv.label });
});
app.post('/api/invites/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(req.params.token);
  if (!inv || inv.used_by || inv.expires < Date.now()) return res.status(404).json({ error: 'Convite inválido ou já usado.' });
  const { name, email, password } = req.body || {};
  const err = checkAccount(name, email, password); if (err) return res.status(400).json({ error: err });
  const id = db.prepare('INSERT INTO users(name,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), inv.role, now()).lastInsertRowid;
  db.prepare('UPDATE invites SET used_by=?, used_at=? WHERE token=?').run(id, now(), inv.token);
  setSession(res, id);
  res.json({ ok: true });
});

// ---------- leitura da árvore ----------
app.get('/api/tree', needUser, (req, res) => {
  const people = db.prepare('SELECT * FROM people').all().map(personOut);
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
  res.json({ people, notes, files, media, users, me: req.user });
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
  res.json({ id });
});

app.put('/api/people/:id', needWriter, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (!owns(req, p.created_by)) return res.status(403).json({ error: 'Você só pode alterar o que você mesmo adicionou. Use "Acrescentar informação".' });
  const d = clean(req.body);
  if ('name' in d && !d.name) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
  for (const k of ['father_id', 'mother_id', 'spouse_id']) if (d[k] && (d[k] === p.id || !exists(d[k]))) d[k] = '';
  const cols = Object.keys(d);
  if (cols.length) db.prepare(`UPDATE people SET ${cols.map(c => c + '=?').join(',')}, updated_at=?, updated_by=? WHERE id=?`)
    .run(...cols.map(c => d[c]), now(), req.user.id, p.id);
  res.json({ ok: true });
});

app.delete('/api/people/:id', needWriter, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (!owns(req, p.created_by)) return res.status(403).json({ error: 'Você só pode excluir o que você mesmo adicionou.' });
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
app.post('/api/people/:id/notes', needWriter, (req, res) => {
  if (!exists(req.params.id)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  const text = String(req.body.text || '').trim().slice(0, 5000);
  if (!text) return res.status(400).json({ error: 'Escreva a informação.' });
  const kind = req.body.kind === 'memory' ? 'memory' : 'info';
  db.prepare('INSERT INTO notes(person_id,kind,text,created_by,created_at) VALUES(?,?,?,?,?)').run(req.params.id, kind, text, req.user.id, now());
  res.json({ ok: true });
});
app.delete('/api/notes/:id', needWriter, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Não encontrada.' });
  if (!owns(req, n.created_by)) return res.status(403).json({ error: 'Você só pode remover o que você escreveu.' });
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
app.post('/api/people/:id/links', needWriter, (req, res) => {
  if (!exists(req.params.id)) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  const url = cleanUrl(req.body.url);
  if (!url) return res.status(400).json({ error: 'Cole um link válido (começando com https://).' });
  const title = String(req.body.title || '').trim().slice(0, 200);
  db.prepare('INSERT INTO media_links(person_id,url,title,created_by,created_at) VALUES(?,?,?,?,?)').run(req.params.id, url, title, req.user.id, now());
  res.json({ ok: true });
});
app.delete('/api/media-links/:id', needWriter, (req, res) => {
  const l = db.prepare('SELECT * FROM media_links WHERE id=?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Não encontrado.' });
  if (!owns(req, l.created_by)) return res.status(403).json({ error: 'Você só pode remover o que você adicionou.' });
  db.prepare('DELETE FROM media_links WHERE id=?').run(l.id);
  res.json({ ok: true });
});

// ---------- foto principal ----------
// Quem criou o registro da pessoa (ou o administrador) escolhe a foto principal.
app.put('/api/people/:id/photo', needWriter, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  if (!owns(req, p.created_by)) return res.status(403).json({ error: 'Só quem adicionou esta pessoa (ou o administrador) escolhe a foto principal.' });
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
app.post('/api/people/:id/files', needWriter, (req, res) => {
  upload.array('files', 10)(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${MAX_UPLOAD_MB} MB.` : 'Não foi possível enviar.' });
    if (!exists(req.params.id)) { (req.files || []).forEach(f => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'Pessoa não encontrada.' }); }
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Envie fotos (JPG, PNG, HEIC) ou PDF.' });
    const caption = String(req.body.caption || '').trim().slice(0, 500);
    const ins = db.prepare('INSERT INTO files(id,person_id,stored_name,original_name,mime,size,caption,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const f of req.files) ins.run(crypto.randomBytes(8).toString('hex'), req.params.id, f.filename, String(f.originalname).slice(0, 200), f.mimetype, f.size, caption, req.user.id, now());
    res.json({ ok: true, count: req.files.length });
  });
});
app.get('/api/files/:id', needUser, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).end();
  const file = path.join(UPLOAD_DIR, path.basename(f.stored_name));
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});
app.delete('/api/files/:id', needWriter, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado.' });
  if (!owns(req, f.created_by)) return res.status(403).json({ error: 'Você só pode remover o que você enviou.' });
  db.prepare('DELETE FROM files WHERE id=?').run(f.id);
  db.prepare("UPDATE people SET photo_file_id='' WHERE photo_file_id=?").run(f.id);
  fs.unlink(path.join(UPLOAD_DIR, path.basename(f.stored_name)), () => {});
  res.json({ ok: true });
});

// ---------- administração ----------
app.get('/api/admin', needAdmin, (req, res) => {
  const users = db.prepare('SELECT id,name,email,role,active,created_at createdAt FROM users ORDER BY created_at').all();
  const invites = db.prepare('SELECT token,role,label,created_at createdAt,expires,used_by usedBy FROM invites ORDER BY created_at DESC LIMIT 100').all();
  res.json({ users, invites });
});
app.post('/api/admin/invites', needAdmin, (req, res) => {
  const role = ['member', 'viewer', 'admin'].includes(req.body.role) ? req.body.role : 'member';
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO invites(token,role,label,created_by,created_at,expires) VALUES(?,?,?,?,?,?)')
    .run(token, role, String(req.body.label || '').slice(0, 100), req.user.id, now(), Date.now() + 30 * 864e5);
  res.json({ token });
});
app.delete('/api/admin/invites/:token', needAdmin, (req, res) => {
  db.prepare('DELETE FROM invites WHERE token=? AND used_by IS NULL').run(req.params.token);
  res.json({ ok: true });
});
app.put('/api/admin/users/:id', needAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Você não pode mudar a sua própria conta aqui.' });
  if (req.body.role && ['member', 'viewer', 'admin'].includes(req.body.role)) db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role, id);
  if (typeof req.body.active === 'boolean') {
    db.prepare('UPDATE users SET active=? WHERE id=?').run(req.body.active ? 1 : 0, id);
    if (!req.body.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  res.json({ ok: true });
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

// ---------- páginas ----------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));
app.get(/^\/(convite\/[\w-]+)?$/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Não encontrado.' }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Árvore da Família rodando em http://localhost:${PORT} (dados em ${DATA_DIR})`));
}
module.exports = { app, db };
