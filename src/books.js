'use strict';
// Livros por código: cada família que pede um livro ganha um código curto (ex.: K7P2Q)
// e entra em <site>/K7P2Q. O site principal abre, para cada livro, uma cópia deste mesmo
// programa com banco e pasta próprios (dados/livros/K7P2Q), e repassa os pedidos para ela.
// Assim nada de uma família se mistura com a de outra, e não precisa de terminal nem de DNS.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');

// Sem letras e números que se confundem (I, L, O, 0, 1).
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RESERVED = new Set(['SENHA', 'FONTS', 'BRAND', 'INDEX', 'TERMO', 'ADMIN']);
const IDLE_MS = 30 * 60e3; // livro sem uso por 30 min dorme; acorda no próximo acesso
const BRT = -3 * 3600e3;

const randomFrom = (alpha, n) => { let s = ''; const b = crypto.randomBytes(n * 2); for (let i = 0; i < n; i++) s += alpha[b.readUInt16BE(i * 2) % alpha.length]; return s; };

module.exports = function books({ db, dataDir, serverFile }) {
  const root = path.join(dataDir, 'livros-codigo');
  const running = new Map(); // code -> { child, sock, ready: Promise, last }
  const getBook = code => db.prepare("SELECT * FROM books WHERE code=? AND status='active'").get(code);

  function newCode() {
    for (let i = 0; i < 200; i++) {
      const c = randomFrom(ALPHA, 5);
      if (!RESERVED.has(c) && !db.prepare('SELECT 1 FROM books WHERE code=?').get(c)) return c;
    }
    throw new Error('Não foi possível gerar um código.');
  }
  function create({ family, place, email, requestId }) {
    const code = newCode(), setupKey = randomFrom(ALPHA, 8);
    fs.mkdirSync(path.join(root, code), { recursive: true });
    db.prepare('INSERT INTO books(code,family,place,email,request_id,setup_key,status,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(code, family || '', place || '', email || '', requestId || null, setupKey, 'active', new Date().toISOString());
    return { code, setupKey };
  }

  function start(book) {
    const have = running.get(book.code); if (have) { have.last = Date.now(); return have.ready; }
    const dir = path.join(root, book.code);
    fs.mkdirSync(dir, { recursive: true });
    const sock = path.join(os.tmpdir(), `dequem-${book.code}.sock`);
    const env = { ...process.env, BOOK_CODE: book.code, DATA_DIR: dir, PORT: sock, SETUP_KEY: book.setup_key, FAMILY_SUBTITLE: book.family || '', RELATOS_INBOX: path.join(dir, 'relatos-entrada') };
    for (const k of ['HUB_URL', 'DEFAULT_PERSON']) delete env[k];
    const child = fork(serverFile, [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const entry = { child, sock, last: Date.now() };
    entry.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('O livro demorou a abrir.')), 20e3);
      child.on('message', m => { if (m === 'pronto') { clearTimeout(t); resolve(entry); } });
      child.on('exit', () => { clearTimeout(t); running.delete(book.code); reject(new Error('O livro fechou.')); });
    });
    entry.ready.catch(() => {});
    running.set(book.code, entry);
    return entry.ready;
  }
  function stop(code) { const e = running.get(code); if (e) { running.delete(code); try { e.child.kill(); } catch {} } }

  function forward(req, res, entry, rest) {
    const headers = { ...req.headers, 'x-forwarded-for': req.ip || '', 'x-forwarded-proto': req.protocol };
    const p = http.request({ socketPath: entry.sock, method: req.method, path: rest, headers }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on('error', () => { if (!res.headersSent) res.status(502).type('text/plain').send('O livro não respondeu. Tente de novo em alguns segundos.'); else res.end(); });
    req.pipe(p);
  }

  async function middleware(req, res, next) {
    const m = req.path.match(/^\/([A-Za-z0-9]{5})(\/.*)?$/);
    if (!m) return next();
    const code = m[1].toUpperCase(), book = getBook(code);
    if (!book) return next();
    const rest = req.originalUrl.slice(1 + m[1].length) || '/';
    if (m[1] !== code) return res.redirect(301, '/' + code + rest); // digitado em minúsculas
    try { const entry = await start(book); entry.last = Date.now(); forward(req, res, entry, rest.startsWith('/') ? rest : '/' + rest); }
    catch (e) { console.error('livro', code, e.message); stop(code); res.status(503).type('text/plain').send('O livro não abriu agora. Tente de novo em alguns segundos.'); }
  }

  function startTimers() {
    setInterval(() => {
      const t = Date.now();
      for (const [code, e] of running) if (t - e.last > IDLE_MS) stop(code);
      // Perto da meia-noite de Brasília, acorda todos os livros para mandarem o resumo diário por e-mail.
      const h = new Date(t + BRT).getUTCHours(), min = new Date(t + BRT).getUTCMinutes();
      if (h === 0 && min < 30) for (const b of db.prepare("SELECT * FROM books WHERE status='active'").all()) start(b).catch(() => {});
    }, 5 * 60e3).unref();
    const bye = () => { for (const code of [...running.keys()]) stop(code); };
    process.on('exit', bye);
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { bye(); process.exit(0); });
  }

  return { middleware, create, start, stop, startTimers, getBook, list: () => db.prepare('SELECT code,family,place,email,request_id requestId,status,created_at createdAt FROM books ORDER BY created_at DESC').all() };
};
