'use strict';
// Testes de segurança: cabeçalhos, arquivos disfarçados, dados escondidos em fotos,
// link de nova senha, histórico, limite de tentativas de login.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvore-sec-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = '1';
const sharp = require('sharp');
const { app } = require('../server');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  let cookie = '';
  return async (method, url, body, isForm, extra = {}) => {
    const headers = { ...extra };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (isForm) payload = body; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()); let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
    return { status: r.status, data, headers: r.headers };
  };
}

(async () => {
  const admin = client(), tia = client(), anon = client();
  await admin('POST', '/api/setup', { name: 'Admin', email: 'a@ex.com', password: 'senha-forte-1' });
  await admin('POST', '/api/admin/import', { people: [{ id: 'p1', name: 'Pessoa Um' }] });
  const inv = (await admin('POST', '/api/admin/invites', { role: 'member' })).data.token;
  await tia('POST', '/api/invites/' + inv, { name: 'Tia', email: 't@ex.com', password: 'senha-forte-2' });

  // cabeçalhos de proteção
  const h = (await anon('GET', '/')).headers;
  assert.match(h.get('content-security-policy'), /object-src 'none'/);
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.match(h.get('strict-transport-security'), /max-age=/);
  assert.match(h.get('x-robots-tag'), /noindex/);
  assert.match((await anon('GET', '/robots.txt')).data.toString(), /Disallow: \//);

  // foto com GPS: a localização é removida
  const jpgGps = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#888' } })
    .jpeg().withExif({ IFD0: { Make: 'Telefone' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '19/1 55/1 0/1' } }).toBuffer();
  assert.ok((await sharp(jpgGps).metadata()).exif, 'a foto de teste tem EXIF');
  let fd = new FormData(); fd.append('files', new Blob([jpgGps], { type: 'image/jpeg' }), 'gps.jpg');
  assert.equal((await tia('POST', '/api/people/p1/files', fd, true)).status, 200);
  let tree = (await tia('GET', '/api/tree')).data;
  const saved = (await tia('GET', '/api/files/' + tree.files[0].id)).data;
  assert.equal((await sharp(saved).metadata()).exif, undefined, 'EXIF/GPS removido');

  // arquivo disfarçado: texto/HTML com tipo de imagem ou PDF é recusado
  fd = new FormData(); fd.append('files', new Blob(['<html><script>alert(1)</script>'], { type: 'image/png' }), 'falso.png');
  await tia('POST', '/api/people/p1/files', fd, true);
  fd = new FormData(); fd.append('files', new Blob(['<html>'], { type: 'application/pdf' }), 'falso.pdf');
  await tia('POST', '/api/people/p1/files', fd, true);
  tree = (await tia('GET', '/api/tree')).data;
  assert.equal(tree.files.length, 1, 'arquivos disfarçados não são guardados');
  const leftovers = fs.readdirSync(path.join(dir, 'uploads')).filter(f => !fs.statSync(path.join(dir, 'uploads', f)).isDirectory());
  assert.equal(leftovers.length, 1, 'nenhum arquivo falso sobra no disco');

  // remover foto: vai para a lixeira e fica no histórico
  assert.equal((await tia('DELETE', '/api/files/' + tree.files[0].id)).status, 200);
  assert.equal(fs.readdirSync(path.join(dir, 'uploads', 'lixeira')).length, 1);
  await tia('DELETE', '/api/people/p1'); // não é dela: recusado
  const act = (await admin('GET', '/api/admin/activity')).data.activity;
  assert.ok(act.some(a => a.action === 'removeu arquivo' && a.name === 'Tia'));
  assert.equal((await tia('GET', '/api/admin/activity')).status, 403, 'só admin vê histórico');

  // link de nova senha
  const tiaId = (await admin('GET', '/api/admin')).data.users.find(u => u.email === 't@ex.com').id;
  const tok = (await admin('POST', `/api/admin/users/${tiaId}/reset`)).data.token;
  assert.equal((await tia('POST', '/api/admin/users/1/reset')).status, 403, 'só admin cria link de senha');
  const nova = client();
  assert.equal((await nova('GET', '/api/reset/' + tok)).data.name, 'Tia');
  assert.equal((await nova('POST', '/api/reset/' + tok, { password: 'curta' })).status, 400);
  assert.equal((await nova('POST', '/api/reset/' + tok, { password: 'senha-nova-123' })).status, 200);
  assert.equal((await tia('GET', '/api/tree')).status, 401, 'sessões antigas encerradas após troca');
  assert.equal((await anon('POST', '/api/reset/' + tok, { password: 'outra-senha-1' })).status, 404, 'link só funciona uma vez');
  assert.equal((await client()('POST', '/api/login', { email: 't@ex.com', password: 'senha-nova-123' })).status, 200);

  // pedidos malformados não derrubam nada
  assert.equal((await anon('POST', '/api/login', undefined, true, { 'content-type': 'application/json', cookie: 'sid=%E0%A4%A' })).status < 500, true);

  // limite de tentativas de login
  let last;
  for (let i = 0; i < 11; i++) last = await anon('POST', '/api/login', { email: 'a@ex.com', password: 'errada' });
  assert.equal(last.status, 429, 'bloqueia após muitas tentativas');

  console.log('OK: testes de segurança');
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('FALHOU:', e.stack); server.close(); process.exit(1); });
