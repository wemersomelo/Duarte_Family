'use strict';
// Testes de segurança: cabeçalhos, arquivos disfarçados, dados escondidos em fotos,
// link de nova senha, histórico, limite de tentativas de login.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvore-sec-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = '1';
process.env.SMTP_HOST = 'test'; process.env.SMTP_USER = 'arvore@ex.com'; process.env.SMTP_PASS = 'x'; process.env.DOMAIN = 'arvore.ex.com';
const mail = require('../src/mail');
const sharp = require('sharp');
const { app } = require('../server');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  const jar = {};
  return async (method, url, body, isForm, extra = {}) => {
    const headers = { ...extra };
    const cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
    if (cookie) headers.cookie = cookie;
    let payload;
    if (isForm) payload = body; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const buf = Buffer.from(await r.arrayBuffer()); let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
    return { status: r.status, data, headers: r.headers };
  };
}

(async () => {
  const admin = client(), tia = client(), anon = client();
  await admin('POST', '/api/setup', { name: 'Admin', email: 'a@ex.com', password: 'senha-forte-1', terms: true });
  await admin('POST', '/api/admin/import', { people: [{ id: 'p1', name: 'Pessoa Um' }] });
  const inv = (await admin('POST', '/api/admin/invites', { role: 'member' })).data.token;
  await tia('POST', '/api/invites/' + inv, { name: 'Tia', email: 't@ex.com', password: 'senha-forte-2', terms: true });

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
  let fd = new FormData(); fd.append('files', new Blob([jpgGps], { type: 'image/jpeg' }), 'gps.jpg'); fd.append('doc', '0');
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

  // link da família: só ver, vivos sem detalhes
  await admin('POST', '/api/admin/import', { people: [
    { id: 'vivo', name: 'Prima Viva', birth: '01/01/1990', birthPlace: 'Cidade X', notes: 'segredo do vivo', fatherId: 'antigo' },
    { id: 'antigo', name: 'Bisavô', birth: '01/01/1900', notes: 'história antiga' },
    { id: 'falecida', name: 'Tia Falecida', death: '2010', notes: 'história dela' }] });
  const famTok = (await admin('POST', '/api/admin/family-link')).data.token;
  assert.equal((await tia('POST', '/api/admin/family-link')).status, 403, 'só admin cria link');
  const guest = client();
  assert.equal((await guest('GET', '/familia/errado')).headers.get('location'), '/?link=invalido', 'link errado volta para a entrada');
  assert.equal((await guest('GET', '/api/tree')).status, 401);
  await guest('GET', '/familia/' + famTok);
  let gt = (await guest('GET', '/api/tree')).data;
  const viva = gt.people.find(p => p.id === 'vivo');
  assert.equal(viva.name, 'Prima Viva');
  assert.equal(viva.fatherId, 'antigo', 'ligações aparecem');
  assert.equal(viva.birth, undefined, 'data do vivo escondida');
  assert.equal(viva.birthPlace, undefined); assert.equal(viva.notes, undefined);
  assert.equal(gt.people.find(p => p.id === 'antigo').notes, 'história antiga', 'nascido até 1915 conta como falecido');
  assert.equal(gt.people.find(p => p.id === 'falecida').notes, 'história dela');
  assert.equal(gt.users.length, 0, 'nomes de quem tem conta não aparecem');
  assert.ok(!JSON.stringify(gt).includes('t@ex.com'));
  assert.equal((await guest('POST', '/api/people/antigo/notes', { text: 'x', kind: 'memory' })).status, 401, 'visitante não escreve');
  assert.equal((await guest('POST', '/api/people', { name: 'x' })).status, 403);
  assert.equal((await guest('GET', '/api/admin')).status, 403);
  // foto de pessoa viva não abre para visitante; de falecido abre
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#555' } }).jpeg().toBuffer();
  for (const pid of ['vivo', 'antigo']) { const f = new FormData(); f.append('files', new Blob([jpg], { type: 'image/jpeg' }), pid + '.jpg'); f.append('doc', '0'); await admin('POST', `/api/people/${pid}/files`, f, true); }
  const all = (await admin('GET', '/api/tree')).data.files;
  const fVivo = all.find(f => f.personId === 'vivo'), fAntigo = all.find(f => f.personId === 'antigo');
  gt = (await guest('GET', '/api/tree')).data;
  assert.ok(!gt.files.some(f => f.id === fVivo.id), 'lista não mostra arquivo do vivo');
  assert.equal((await guest('GET', '/api/files/' + fVivo.id)).status, 404, 'arquivo do vivo bloqueado');
  assert.equal((await guest('GET', '/api/files/' + fAntigo.id)).status, 200);
  // documento de falecido: visitante não vê
  { const f = new FormData(); f.append('files', new Blob([jpg], { type: 'image/jpeg' }), 'certidao.jpg'); await admin('POST', '/api/people/antigo/files', f, true);
    const d = (await admin('GET', '/api/tree')).data.files.find(x => x.personId === 'antigo' && x.doc);
    assert.ok(d, 'padrão é documento');
    assert.ok(!(await guest('GET', '/api/tree')).data.files.some(x => x.id === d.id), 'visitante não vê documento na lista');
    assert.equal((await guest('GET', '/api/files/' + d.id)).status, 404, 'nem pelo endereço'); }
  // pedir para participar: só pelo link; convite aprovado só vale para aquele e-mail
  assert.equal((await client()('POST', '/api/access-requests', { name: 'X', email: 'x@ex.com', relation: 'primo' })).status, 403, 'sem o link não pede');
  assert.equal((await guest('POST', '/api/access-requests', { name: 'Prima Nova', email: 'nova@ex.com', relation: '' })).status, 400, 'parentesco obrigatório');
  assert.equal((await guest('POST', '/api/access-requests', { name: 'Prima Nova', email: 'Nova@Ex.com', relation: 'neta do Bisavô', message: 'zap 123' })).status, 200);
  const reqs = (await admin('GET', '/api/admin/access-requests')).data.requests;
  assert.equal(reqs[0].email, 'nova@ex.com');
  assert.ok(mail.sent.some(m => m.to === 'a@ex.com' && m.text.includes('Prima Nova')), 'admin recebe aviso do pedido');
  assert.equal((await guest('GET', '/api/status')).data.request.status, 'pending', 'quem pediu vê que está aguardando');
  assert.equal((await tia('GET', '/api/admin/access-requests')).status, 403, 'só admin vê pedidos');
  const apr = (await admin('POST', `/api/admin/access-requests/${reqs[0].id}/approve`, { role: 'member' })).data;
  assert.equal(apr.mailed, true);
  const aviso = mail.sent.find(m => m.to === 'nova@ex.com');
  assert.ok(aviso && aviso.text.includes('https://arvore.ex.com/convite/' + apr.token), 'e-mail de aprovação leva o link do convite');
  const st = (await guest('GET', '/api/status')).data.request;
  assert.equal(st.status, 'approved'); assert.equal(st.email, 'no***@ex.com'); assert.ok(!JSON.stringify(st).includes(apr.token), 'o aparelho não recebe o convite, só o e-mail');
  assert.equal((await client()('GET', '/api/invites/' + apr.token)).data.name, 'Prima Nova');
  assert.equal((await client()('POST', '/api/invites/' + apr.token, { name: 'Outra', email: 'outra@ex.com', password: 'senha-forte-7', terms: true })).status, 400, 'convite preso ao e-mail do pedido');
  assert.equal((await client()('POST', '/api/invites/' + apr.token, { name: 'Prima Nova', email: 'nova@ex.com', password: 'senha-forte-7', terms: true })).status, 200);

  // convite já ligado a uma pessoa da árvore: a pessoa entra e a árvore começa por ela
  const pViva = (await admin('POST', '/api/people', { name: 'Bisavó Viva', birth: '1940' })).data.id;
  const pVelha = (await admin('POST', '/api/people', { name: 'Falecida Antiga', death: '1990' })).data.id;
  assert.equal((await admin('POST', '/api/admin/invites', { role: 'viewer', personId: pVelha })).status, 400, 'não convida quem faleceu');
  const invP = (await admin('POST', '/api/admin/invites', { role: 'viewer', personId: pViva })).data.token;
  const infoP = (await client()('GET', '/api/invites/' + invP)).data;
  assert.equal(infoP.personName, 'Bisavó Viva'); assert.equal(infoP.name, 'Bisavó Viva');
  const vovo = client();
  assert.equal((await vovo('POST', '/api/invites/' + invP, { name: 'Bisavó Viva', email: 'vovo@ex.com', password: 'senha-forte-8', terms: true })).status, 200);
  assert.equal((await vovo('GET', '/api/tree')).data.me.personId, pViva, 'entra já ligada à sua ficha');
  assert.equal((await admin('POST', '/api/admin/invites', { role: 'viewer', personId: pViva })).status, 400, 'pessoa já tem conta');
  assert.equal((await admin('GET', '/api/admin/access-requests')).data.requests[0].status, 'joined');
  // cancelar convite aprovado: o link deixa de funcionar; depois pode apagar da lista
  const g2 = client(); await g2('GET', '/familia/' + famTok);
  await g2('POST', '/api/access-requests', { name: 'Teste Cancela', email: 'cancela@ex.com', relation: 'primo' });
  const rq2 = (await admin('GET', '/api/admin/access-requests')).data.requests.find(r => r.email === 'cancela@ex.com');
  const apr2 = (await admin('POST', `/api/admin/access-requests/${rq2.id}/approve`, { role: 'viewer' })).data;
  assert.equal((await tia('POST', `/api/admin/access-requests/${rq2.id}/cancel`)).status, 403, 'só admin cancela');
  assert.equal((await admin('DELETE', `/api/admin/access-requests/${rq2.id}`)).status, 400, 'não apaga convite ativo');
  assert.equal((await admin('POST', `/api/admin/access-requests/${rq2.id}/cancel`)).status, 200);
  assert.equal((await client()('GET', '/api/invites/' + apr2.token)).status, 404, 'convite cancelado não funciona');
  assert.equal((await g2('GET', '/api/status')).data.request.status, 'cancelled');
  assert.equal((await admin('DELETE', `/api/admin/access-requests/${rq2.id}`)).status, 200);
  assert.ok(!(await admin('GET', '/api/admin/access-requests')).data.requests.some(r => r.id === rq2.id));
  for (let i = 0; i < 3; i++) await guest('POST', '/api/access-requests', { name: 'Spam', email: `s${i}@ex.com`, relation: 'x' });
  assert.equal((await guest('POST', '/api/access-requests', { name: 'Spam', email: 's9@ex.com', relation: 'x' })).status, 429, 'limite de pedidos por dia');

  // cor/raça e origem: guardadas; escondidas dos visitantes quando a pessoa é viva
  await admin('PUT', '/api/people/antigo', { color: 'preta', origin: 'africana' });
  await admin('PUT', '/api/people/vivo', { color: 'parda', origin: 'brasileira' });
  assert.equal((await admin('PUT', '/api/people/falecida', { color: 'inventada' })).status, 200);
  let full = (await admin('GET', '/api/tree')).data.people;
  assert.equal(full.find(p => p.id === 'antigo').color, 'preta');
  assert.equal(full.find(p => p.id === 'falecida').color, '', 'valor fora da lista é descartado');
  gt = (await guest('GET', '/api/tree')).data;
  assert.equal(gt.people.find(p => p.id === 'antigo').origin, 'africana');
  assert.equal(gt.people.find(p => p.id === 'vivo').color, undefined, 'cor do vivo escondida');
  assert.equal(gt.people.find(p => p.id === 'vivo').origin, undefined);

  // trocar o link derruba quem entrou pelo antigo
  await admin('POST', '/api/admin/family-link');
  assert.equal((await guest('GET', '/api/tree')).status, 401, 'link antigo para de funcionar');
  await admin('DELETE', '/api/admin/family-link');
  assert.equal((await client()('GET', '/familia/' + famTok)).headers.get('location'), '/?link=invalido', 'link desligado não entra');

  // limite de tentativas de login
  let last;
  for (let i = 0; i < 11; i++) last = await anon('POST', '/api/login', { email: 'a@ex.com', password: 'errada' });
  assert.equal(last.status, 429, 'bloqueia após muitas tentativas');

  console.log('OK: testes de segurança');
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('FALHOU:', e.stack); server.close(); process.exit(1); });
