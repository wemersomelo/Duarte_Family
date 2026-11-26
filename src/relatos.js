'use strict';
// Relatos de entrevista: pasta (ou .zip) com ficha.md, relato.md, lote.csv e material/.
// Fluxo: ler -> prévia com alertas -> o administrador decide -> aplicar.
// Nada junta pessoas sozinho: todo nome duvidoso vira alerta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { unzipSync } = require('fflate');
const { runLote, norm, splitNick } = require('./lote');

// ---------- leitura da pasta ----------
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.gif': 'image/gif', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.txt': 'text/plain', '.md': 'text/plain' };
const MAX_FILES = 200, MAX_TOTAL = 200 * 1024 * 1024;

// files: [{ name: 'caminho/relativo', data: Buffer }]
function expandZips(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      let total = 0;
      const z = unzipSync(new Uint8Array(f.data), { filter: e => { total += e.originalSize; if (total > MAX_TOTAL) throw new Error('O .zip é grande demais (máx. 200 MB descompactado).'); return !e.name.endsWith('/'); } });
      for (const [n, d] of Object.entries(z)) out.push({ name: n, data: Buffer.from(d) });
    } else out.push(f);
  }
  return out.filter(f => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(f.name));
}
function readFolder(files, fallbackName) {
  files = expandZips(files);
  if (files.length > MAX_FILES) throw new Error(`Arquivos demais na pasta (máx. ${MAX_FILES}).`);
  const clean = n => n.replace(/\\/g, '/').split('/').filter(x => x && x !== '..' && x !== '.').join('/');
  files = files.map(f => ({ name: clean(f.name), data: f.data }));
  const pick = base => files.filter(f => path.posix.basename(f.name).toLowerCase() === base).sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  const lote = pick('lote.csv'), ficha = pick('ficha.md'), relato = pick('relato.md');
  if (!lote) throw new Error('Não encontrei o lote.csv na pasta.');
  const root = path.posix.dirname(lote.name) === '.' ? '' : path.posix.dirname(lote.name);
  const folder = root.split('/').pop() || fallbackName || '';
  const fichaText = ficha ? ficha.data.toString('utf8') : '';
  const field = re => { const m = fichaText.match(re); return m ? m[1].replace(/\*\*/g, '').trim() : ''; };
  const id = (field(/^\s*[-*]?\s*\**\s*ID\s*\**\s*:\s*\**\s*(.+)$/im) || folder).replace(/[^\w.-]+/g, '_').slice(0, 80);
  if (!id) throw new Error('Não consegui descobrir o ID do relato (linha "ID:" na ficha.md ou o nome da pasta).');
  const fm = folder.match(/^(\d{4})-(\d{2})-(\d{2})_?(.*)$/);
  const meta = {
    id,
    fonte: field(/^\s*[-*]?\s*\**\s*(?:Fonte|Quem contou)\s*\**\s*:\s*\**\s*(.+)$/im) || (fm ? fm[4].replace(/[_-]+/g, ' ') : ''),
    data: field(/^\s*[-*]?\s*\**\s*Data(?: do relato)?\s*\**\s*:\s*\**\s*(.+)$/im) || (fm ? `${fm[3]}/${fm[2]}/${fm[1]}` : '')
  };
  const inMaterial = f => { const rel = root ? f.name.slice(root.length + 1) : f.name; return f.name.startsWith(root ? root + '/' : '') && rel.toLowerCase().startsWith('material/'); };
  const material = files.filter(inMaterial).map(f => ({ name: path.posix.basename(f.name).slice(0, 150), data: f.data, mime: MIME[path.extname(f.name).toLowerCase()] || 'application/octet-stream' }));
  return { meta, lote: lote.data.toString('utf8'), ficha: fichaText, relato: relato ? relato.data.toString('utf8') : '', material };
}

// ---------- semelhança de nomes ----------
function lev(a, b) {
  if (a === b) return 0; if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const PREFIX = /^(tia|tio|vo|avo|vovo|bisavo|padrinho|madrinha|velho|velha|dona|seu|sr|sra|titia|titio|prima|primo)\s+/;
const words = s => norm(s).replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(w => w.length > 1 && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(w));
// a: nome do lote; p: pessoa do site. Devolve o motivo da semelhança ou ''.
// strict (varredura da árvore inteira): exige o primeiro nome igual, para não confundir irmãos (Dilma/Ilma, José/Josué).
function similar(a, p, aliases, strict) {
  const A = norm(a).replace(PREFIX, ''), wa = words(A), wp = words(norm(p.name).replace(PREFIX, ''));
  if (!wa.length || !wp.length) return '';
  const full = wp.join(' '), short = wa.join(' ');
  if (short === full) return 'mesmo nome';
  if (Math.min(short.length, full.length) >= 8 && lev(short, full) <= 2 && (!strict || wa[0] === wp[0])) return 'nome quase igual';
  if (p.nick && (norm(p.nick) === norm(a) || norm(p.nick).replace(PREFIX, '') === A)) return 'mesmo apelido';
  if ((aliases || []).some(x => x === norm(a))) return 'nome alternativo';
  const tol = n => n > 6 ? 3 : n > 5 ? 2 : 1;
  const firstOk = strict ? wa[0] === wp[0] : lev(wa[0], wp[0]) <= tol(Math.min(wa[0].length, wp[0].length));
  // palavra igual ou com uma letra trocada (Milson/Nilson); na varredura geral, só igual
  const has = (list, x) => list.some(y => y === x || (!strict && x.length > 4 && lev(x, y) <= 1));
  if (firstOk && (wa.slice(1).every(w => has(wp, w)) || wp.slice(1).every(w => has(wa, w))))
    return wa[0] === wp[0] ? (wa.length === wp.length ? 'mesmo nome' : 'mesmo primeiro nome, sobrenome parcial') : 'nome parecido';
  if (!strict && wa.length > 1 && wa.every(w => wp.includes(w))) return 'sobrenome parcial';
  return '';
}

function personCard(db, p) {
  const nm = id => { const q = id && db.prepare('SELECT name FROM people WHERE id=?').get(id); return q ? q.name : ''; };
  const rel = db.prepare('SELECT relato_id FROM relato_people WHERE person_id=?').all(p.id).map(r => r.relato_id);
  return { id: p.id, name: p.name, nick: p.nick || '', birth: p.birth || '', death: p.death || '', father: nm(p.father_id), mother: nm(p.mother_id), spouse: nm(p.spouse_id), relatos: rel };
}

// Resolve um nome do lote para uma pessoa, usando as decisões já tomadas.
// decisions: { [nomeNormalizado]: 'id:<pessoa>' | 'new' | 'skip' }
function makeResolver(db, decisions, created) {
  return (ref, ctx) => {
    const { main } = splitNick(ref), n = norm(main);
    if (!n) return { none: true };
    const d = decisions[n];
    if (created[n]) return { p: db.prepare('SELECT * FROM people WHERE id=?').get(created[n]) };
    if (d === 'skip') return { skip: true };
    if (d === 'new') return { create: true, onCreate: id => { created[n] = id; } };
    if (d && d.startsWith('id:')) { const p = db.prepare('SELECT * FROM people WHERE id=?').get(d.slice(3)); if (p) return { p }; }
    const byId = db.prepare('SELECT * FROM people WHERE id=?').get(main); if (byId) return { p: byId };
    const al = db.prepare('SELECT p.* FROM person_aliases a JOIN people p ON p.id=a.person_id WHERE a.alias=?').get(n); if (al) return { p: al };
    const all = db.prepare('SELECT * FROM people').all();
    const exact = all.filter(p => norm(p.name) === n);
    const card = p => personCard(db, p);
    if (exact.length > 1) return { alert: { type: 'choose', key: n, name: main, title: `Há ${exact.length} pessoas chamadas "${main}". Qual é?`, candidates: exact.map(card) } };
    if (exact.length === 1) return { p: exact[0] };
    const aliasMap = {}; for (const a of db.prepare('SELECT alias, person_id FROM person_aliases').all()) (aliasMap[a.person_id] ||= []).push(a.alias);
    const RANK = ['mesmo nome', 'nome alternativo', 'mesmo apelido', 'mesmo primeiro nome, sobrenome parcial', 'nome quase igual', 'sobrenome parcial', 'nome parecido'];
    const cands = all.map(p => ({ p, why: similar(main, p, aliasMap[p.id]) })).filter(x => x.why).sort((a, b) => RANK.indexOf(a.why) - RANK.indexOf(b.why)).slice(0, 6);
    if (cands.length) return { alert: { type: ctx.nova ? 'duplicate' : 'same', key: n, name: main, title: ctx.nova ? `"${main}" vai ser criada, mas já existe alguém parecido. É a mesma pessoa?` : `"${main}" não está na árvore com esse nome. É a mesma pessoa?`, candidates: cands.map(x => ({ ...card(x.p), why: x.why })) } };
    if (ctx.nova && ctx.role === 'pessoa') return { create: true, onCreate: id => { created[n] = id; } };
    return { alert: { type: 'missing', key: n, name: main, title: `"${main}" não está na árvore e nenhuma pessoa parecida foi encontrada.`, candidates: [] } };
  };
}

// ---------- prévia e aplicação ----------
function runRelato(db, staged, { decisions = {}, apply = false, userId, newId, now, saveFile }) {
  const existing = db.prepare('SELECT * FROM relatos WHERE id=?').get(staged.meta.id);
  const done = new Set(db.prepare("SELECT row_key FROM relato_rows WHERE relato_id=? AND status='applied'").all(staged.meta.id).map(r => r.row_key));
  const created = {};
  const ident = {}, div = {};
  for (const [k, v] of Object.entries(decisions)) (k.includes('|') ? div : ident)[k] = v;
  let result;
  const tx = db.transaction(() => {
    result = runLote(db, staged.lote, { apply: true, userId, newId, now, resolver: makeResolver(db, ident, created), divergence: k => div[k], skipKeys: done });
    const alerts = result.rows.filter(r => r.alert);
    if (!apply) throw Object.assign(new Error('preview'), { preview: true });
    if (alerts.length) throw Object.assign(new Error('Ainda há alertas sem decisão.'), { status: 400 });
    // registro do relato
    const applied = result.rows.filter(r => r.ok).length, skipped = result.rows.filter(r => r.skipped || r.erro).length;
    if (existing) db.prepare('UPDATE relatos SET fonte=?, data=?, ficha=?, relato=?, imported_at=?, imported_by=?, applied=applied+?, skipped=? WHERE id=?').run(staged.meta.fonte, staged.meta.data, staged.ficha, staged.relato, now(), userId, applied, skipped, staged.meta.id);
    else db.prepare('INSERT INTO relatos(id,fonte,data,ficha,relato,imported_at,imported_by,applied,skipped) VALUES(?,?,?,?,?,?,?,?,?)').run(staged.meta.id, staged.meta.fonte, staged.meta.data, staged.ficha, staged.relato, now(), userId, applied, skipped);
    for (const r of result.rows) {
      if (r.ok) db.prepare("INSERT INTO relato_rows(relato_id,row_key,status,at) VALUES(?,?,'applied',?) ON CONFLICT(relato_id,row_key) DO UPDATE SET status='applied', at=excluded.at").run(staged.meta.id, r.key, now());
      else if (r.skipped || r.erro) db.prepare("INSERT OR IGNORE INTO relato_rows(relato_id,row_key,status,at) VALUES(?,?,'skipped',?)").run(staged.meta.id, r.key, now());
      for (const pid of r.people || []) db.prepare('INSERT OR IGNORE INTO relato_people(relato_id,person_id) VALUES(?,?)').run(staged.meta.id, pid);
    }
    // memória das decisões: "Donaldo" = pessoa X
    for (const [n, d] of Object.entries(ident)) if (d.startsWith('id:')) {
      const p = db.prepare('SELECT name FROM people WHERE id=?').get(d.slice(3));
      if (p && norm(p.name) !== n) db.prepare('INSERT OR REPLACE INTO person_aliases(alias,person_id,created_at) VALUES(?,?,?)').run(n, d.slice(3), now());
    }
    // alertas pulados ficam no painel de pendências
    for (const r of staged.lastAlerts || []) if (ident[r.key] === 'skip' && !db.prepare("SELECT 1 FROM pending WHERE kind='identity' AND relato_id=? AND title=? AND status='open'").get(staged.meta.id, r.title))
      db.prepare("INSERT INTO pending(kind,relato_id,title,data,status,created_at) VALUES('identity',?,?,?,'open',?)").run(staged.meta.id, r.title, JSON.stringify({ name: r.name, candidates: (r.candidates || []).map(c => c.id) }), now());
    // material: só na primeira vez que cada arquivo entra
    for (const f of staged.material) if (!db.prepare('SELECT 1 FROM relato_files WHERE relato_id=? AND name=? AND size=?').get(staged.meta.id, f.name, f.data.length)) {
      const stored = saveFile(f);
      db.prepare('INSERT INTO relato_files(relato_id,name,stored,mime,size,created_at) VALUES(?,?,?,?,?,?)').run(staged.meta.id, f.name, stored, f.mime, f.data.length, now());
    }
  });
  try { tx(); } catch (e) { if (!e.preview) throw e; }
  // agrupa alertas iguais (o mesmo nome em várias linhas vira um alerta só)
  const alerts = [], seen = new Map();
  for (const r of result.rows) if (r.alert) {
    const a = seen.get(r.alert.key);
    if (a) a.rows.push(r.n); else { const x = { ...r.alert, rows: [r.n] }; seen.set(r.alert.key, x); alerts.push(x); }
  }
  staged.lastAlerts = alerts;
  return {
    relato: { ...staged.meta, existing: !!existing, importedAt: existing ? existing.imported_at : null, material: staged.material.map(f => ({ name: f.name, size: f.data.length })), hasRelato: !!staged.relato },
    alerts, rows: result.rows.map(r => ({ n: r.n, acao: r.acao, pessoa: r.pessoa, campo: r.campo, valor: r.valor, ok: r.ok, erro: r.erro, skipped: r.skipped, done: r.done, alert: r.alert ? r.alert.key : null })),
    applied: apply
  };
}

// ---------- varredura de duplicados em toda a árvore ----------
function scanDuplicates(db) {
  const all = db.prepare('SELECT * FROM people').all();
  const no = new Set(db.prepare('SELECT a,b FROM not_duplicates').all().map(r => r.a + '|' + r.b));
  const out = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j], k = [a.id, b.id].sort().join('|');
    if (no.has(k)) continue;
    // parentes diretos com nomes parecidos (pai e filho com o mesmo nome) não são duplicados
    if ([a.father_id, a.mother_id, a.spouse_id].includes(b.id) || [b.father_id, b.mother_id, b.spouse_id].includes(a.id)) continue;
    // irmãos (mesmo pai ou mesma mãe) podem ter nomes parecidos
    if ((a.father_id && a.father_id === b.father_id) || (a.mother_id && a.mother_id === b.mother_id)) continue;
    const why = similar(a.name, b, null, true) || similar(b.name, a, null, true);
    if (!why) continue;
    // datas diferentes conhecidas tornam improvável
    const y = s => (String(s || '').match(/\d{4}/) || [''])[0];
    if (y(a.birth) && y(b.birth) && Math.abs(+y(a.birth) - +y(b.birth)) > 2) continue;
    out.push({ key: k, why, a: personCard(db, a), b: personCard(db, b) });
  }
  return out.slice(0, 200);
}

// ---------- pasta de entrada no servidor (sincronizada a partir do PC) ----------
function listInbox(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (fs.existsSync(path.join(p, 'lote.csv'))) found.push(p); else walk(p, depth + 1); }
    }
  };
  walk(dir, 0);
  return found;
}
function readInboxFolder(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r); else if (e.isFile()) files.push({ name: path.basename(dir) + '/' + r, data: fs.readFileSync(p) });
    }
  };
  walk(dir, '');
  return readFolder(files, path.basename(dir));
}
// Assinatura do conteúdo, para saber se uma pasta mudou desde a última importação.
const hashStaged = st => crypto.createHash('sha1').update(st.lote).update(st.material.map(f => f.name + f.data.length).join('|')).digest('hex');

module.exports = { readFolder, runRelato, scanDuplicates, listInbox, readInboxFolder, hashStaged, similar, lev };
