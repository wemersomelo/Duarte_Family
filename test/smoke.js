'use strict';
// Teste de ponta a ponta: instalação, convites, regra "cada um altera só o que criou",
// documentos, exportação. Roda num diretório temporário: `npm test`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvore-test-'));
process.env.DATA_DIR = dir;
const { app } = require('../server');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  let cookie = '';
  return async (method, url, body, isForm) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (isForm) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

(async () => {
  const admin = client(), tia = client(), leitor = client(), anon = client();

  assert.equal((await anon('GET', '/api/status')).data.needsSetup, true);
  assert.equal((await anon('GET', '/api/tree')).status, 401, 'sem login não lê');
  assert.equal((await admin('POST', '/api/setup', { name: 'Admin', email: 'admin@ex.com', password: 'senha-forte-1' })).status, 200);
  assert.equal((await anon('POST', '/api/setup', { name: 'X', email: 'x@ex.com', password: 'senha-forte-1' })).status, 400, 'setup só uma vez');

  // importação
  const imp = await admin('POST', '/api/admin/import', { people: [{ id: 'avo', name: 'Avo Teste da Silva', sex: 'm', birth: '01/02/1930' }, { id: 'neto', name: 'Neto', fatherId: 'avo' }], notes: [{ personId: 'avo', text: 'Nota antiga', by: 'Admin' }] });
  assert.deepEqual(imp.data, { added: 2, updated: 0 });

  // convites
  const inv = (await admin('POST', '/api/admin/invites', { role: 'member', label: 'tia' })).data.token;
  const invV = (await admin('POST', '/api/admin/invites', { role: 'viewer' })).data.token;
  assert.equal((await tia('POST', '/api/invites/' + inv, { name: 'Tia', email: 'tia@ex.com', password: 'senha-forte-2' })).status, 200);
  assert.equal((await anon('POST', '/api/invites/' + inv, { name: 'Outro', email: 'o@ex.com', password: 'senha-forte-3' })).status, 404, 'convite só serve uma vez');
  assert.equal((await leitor('POST', '/api/invites/' + invV, { name: 'Leitor', email: 'l@ex.com', password: 'senha-forte-4' })).status, 200);

  // membro adiciona, não altera o que é dos outros
  const add = await tia('POST', '/api/people', { name: 'Bisavo Teste', sex: 'f', parentOf: 'avo', parentRole: 'mother' });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const bisavo = add.data.id;
  assert.equal((await tia('PUT', '/api/people/avo', { name: 'Hackeado' })).status, 403, 'membro não edita registro inicial');
  assert.equal((await tia('DELETE', '/api/people/avo')).status, 403, 'membro não exclui registro inicial');
  assert.equal((await tia('PUT', '/api/people/' + bisavo, { birth: 'por volta de 1910' })).status, 200, 'membro edita o que criou');
  let tree = (await tia('GET', '/api/tree')).data;
  assert.equal(tree.people.find(p => p.id === 'avo').motherId, bisavo, 'ligação de mãe aplicada');
  assert.equal(tree.people.find(p => p.id === 'avo').name, 'Avo Teste da Silva');

  // notas
  assert.equal((await tia('POST', '/api/people/avo/notes', { text: 'Morava na roça' })).status, 200);
  tree = (await admin('GET', '/api/tree')).data;
  const notaTia = tree.notes.find(n => n.text.startsWith('Morava na roça'));
  const notaAntiga = tree.notes.find(n => n.text.startsWith('Nota antiga'));
  assert.equal((await tia('DELETE', '/api/notes/' + notaAntiga.id)).status, 403, 'membro não remove nota alheia');
  assert.equal((await leitor('POST', '/api/people/avo/notes', { text: 'x' })).status, 403, 'leitor não escreve');
  assert.equal((await leitor('POST', '/api/people', { name: 'x' })).status, 403, 'leitor não adiciona');

  // admin altera tudo
  assert.equal((await admin('PUT', '/api/people/' + bisavo, { notes: 'Nota do admin' })).status, 200);
  assert.equal((await admin('DELETE', '/api/notes/' + notaTia.id)).status, 200);

  // documentos
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), 'certidao.png');
  fd.append('caption', 'Certidão');
  assert.equal((await tia('POST', '/api/people/avo/files', fd, true)).status, 200);
  tree = (await leitor('GET', '/api/tree')).data;
  assert.equal(tree.files.length, 1);
  const fget = await leitor('GET', '/api/files/' + tree.files[0].id);
  assert.equal(fget.status, 200, 'leitor vê documento');
  assert.equal((await anon('GET', '/api/files/' + tree.files[0].id)).status, 401, 'sem login não vê documento');
  const bad = new FormData();
  bad.append('files', new Blob(['<script>'], { type: 'text/html' }), 'x.html');
  assert.equal((await tia('POST', '/api/people/avo/files', bad, true)).status, 400, 'tipo de arquivo bloqueado');
  assert.equal((await leitor('DELETE', '/api/files/' + tree.files[0].id)).status, 403);

  // lembranças, links e foto principal
  assert.equal((await tia('POST', '/api/people/avo/notes', { text: 'Fazia o melhor pão de queijo', kind: 'memory' })).status, 200);
  assert.equal((await tia('POST', '/api/people/avo/links', { url: 'youtu.be/abc123', title: 'Festa' })).status, 200, 'link sem https é aceito e corrigido');
  assert.equal((await tia('POST', '/api/people/avo/links', { url: 'javascript:alert(1)' })).status, 400, 'link perigoso bloqueado');
  tree = (await tia('GET', '/api/tree')).data;
  assert.equal(tree.notes.find(n => n.text.startsWith('Fazia')).kind, 'memory');
  assert.equal(tree.media[0].url, 'https://youtu.be/abc123');
  const imgId = tree.files[0].id;
  assert.equal((await tia('PUT', '/api/people/avo/photo', { fileId: imgId })).status, 403, 'membro não escolhe foto de registro alheio');
  assert.equal((await tia('PUT', '/api/people/' + bisavo + '/photo', { fileId: imgId })).status, 400, 'foto tem de ser da própria pessoa');
  assert.equal((await admin('PUT', '/api/people/avo/photo', { fileId: imgId })).status, 200);
  tree = (await tia('GET', '/api/tree')).data;
  assert.equal(tree.people.find(p => p.id === 'avo').photoFileId, imgId);
  assert.equal((await leitor('DELETE', '/api/media-links/' + tree.media[0].id)).status, 403);
  assert.equal((await tia('DELETE', '/api/media-links/' + tree.media[0].id)).status, 200, 'autor remove o próprio link');
  // convidado "Só ver" acrescenta lembranças, links e fotos, mas não remove nem edita dados
  assert.equal((await leitor('POST', '/api/people/avo/notes', { text: 'Lembrança do leitor', kind: 'memory' })).status, 200);
  assert.equal((await leitor('POST', '/api/people/avo/links', { url: 'https://youtu.be/zzz' })).status, 200);
  const fd2 = new FormData(); fd2.append('files', new Blob([png], { type: 'image/png' }), 'foto.png');
  assert.equal((await leitor('POST', '/api/people/avo/files', fd2, true)).status, 200);
  tree = (await leitor('GET', '/api/tree')).data;
  const lemb = tree.notes.find(n => n.text === 'Lembrança do leitor');
  assert.equal((await leitor('DELETE', '/api/notes/' + lemb.id)).status, 403, 'leitor não remove');
  assert.equal((await leitor('PUT', '/api/people/avo', { name: 'x' })).status, 403);
  const exp = (await admin('GET', '/api/export.json')).data;
  assert.ok(exp.notes.some(n => n.kind === 'memory'));

  // exportação
  assert.equal((await tia('GET', '/api/export.json')).status, 403, 'só admin exporta');
  const ged = await admin('GET', '/api/export.ged');
  assert.ok(String(ged.data).includes('1 NAME Avo Teste da /Silva/'));
  assert.ok(String(ged.data).includes('2 DATE 1 FEB 1930'));

  // cada conta diz quem é na árvore; visitantes começam pela pessoa do administrador
  assert.equal((await tia('PUT', '/api/me/person', { personId: 'neto' })).status, 200);
  assert.equal((await tia('GET', '/api/tree')).data.me.personId, 'neto');
  assert.equal((await leitor('PUT', '/api/me/person', { personId: 'neto' })).status, 409, 'pessoa já ligada a outra conta');
  assert.equal((await leitor('PUT', '/api/me/person', { personId: 'nao-existe' })).status, 404);
  assert.equal((await anon('PUT', '/api/me/person', { personId: 'avo' })).status, 401);
  // a própria pessoa corrige os seus dados (mesmo com acesso de leitura), mas não exclui
  const prima = (await admin('POST', '/api/people', { name: 'Prima Teste', fatherId: 'avo' })).data.id;
  const morta = (await admin('POST', '/api/people', { name: 'Falecida Teste', death: '2001' })).data.id;
  assert.equal((await leitor('PUT', '/api/me/person', { personId: morta })).status, 400, 'não se identifica como falecido');
  assert.equal((await leitor('PUT', '/api/people/' + prima, { birth: '1990' })).status, 403, 'antes de se identificar, leitor não edita');
  assert.equal((await leitor('PUT', '/api/me/person', { personId: prima })).status, 200);
  assert.equal((await leitor('PUT', '/api/people/' + prima, { birth: '02/03/1990', marriage: '10/10/2015', marriagePlace: 'Catuji, MG' })).status, 200, 'edita a própria ficha');
  const pr = (await leitor('GET', '/api/tree')).data.people.find(x => x.id === prima);
  assert.equal(pr.birth, '02/03/1990'); assert.equal(pr.marriage, '10/10/2015'); assert.equal(pr.marriagePlace, 'Catuji, MG');
  assert.equal((await leitor('PUT', '/api/people/avo', { birth: '1900' })).status, 403, 'não edita outra pessoa');
  assert.equal((await leitor('DELETE', '/api/people/' + prima)).status, 403, 'não exclui a própria ficha');
  // lote de relatório: prévia não muda nada, aplicar muda, nunca apaga a versão anterior
  const lote = `| Ação | Pessoa | Campo | Valor | Fonte | Confiança |
|---|---|---|---|---|---|
| NOVA | Tia Lote Teste | nome completo | Tia Lote Teste ("Tia Lote") | Teste 01/01 | Relato direto |
| ATUALIZAR | Tia Lote Teste | nascimento | 13/11/1945 | Teste 01/01 | Relato direto |
| ATUALIZAR | Ninguém Existe | nascimento | 1900 | Teste | Hipótese |
| ATUALIZAR | Tia Lote Teste | moradia | Catuji (MG) | Teste | Relato direto |`;
  assert.equal((await tia('POST', '/api/admin/import-lote', { text: lote })).status, 403, 'só admin importa lote');
  const prev = (await admin('POST', '/api/admin/import-lote', { text: lote })).data;
  assert.equal(prev.ok, 3); assert.equal(prev.erros, 1); assert.equal(prev.applied, false);
  assert.ok(!(await admin('GET', '/api/tree')).data.people.some(x => x.name === 'Tia Lote Teste'), 'prévia não grava');
  await admin('POST', '/api/admin/import-lote', { text: lote, apply: true });
  let tl = (await admin('GET', '/api/tree')).data.people.find(x => x.name === 'Tia Lote Teste');
  assert.equal(tl.birth, '13/11/1945'); assert.equal(tl.nick, 'Tia Lote'); assert.ok(tl.sources.includes('Teste 01/01'));
  await admin('POST', '/api/admin/import-lote', { text: '| Ação | Pessoa | Campo | Valor | Fonte | Confiança |\n| ATUALIZAR | Tia Lote Teste | nascimento | 1946 | Outra | Relato indireto |', apply: true });
  const tree2 = (await admin('GET', '/api/tree')).data; tl = tree2.people.find(x => x.name === 'Tia Lote Teste');
  assert.equal(tl.birth, '1946'); assert.ok(tree2.notes.some(n => n.personId === tl.id && n.text.includes('Versão anterior de nascimento: 13/11/1945')), 'versão anterior guardada');
  assert.ok(tree2.notes.some(n => n.personId === tl.id && n.text.startsWith('moradia: Catuji')), 'campo livre vira nota');
  const csv = 'Ação;Pessoa;Campo;Valor;Fonte;Confiança\nATUALIZAR;Tia Lote Teste;local de nascimento;"Catuji; MG";CSV;Documento';
  assert.equal((await admin('POST', '/api/admin/import-lote', { text: csv, apply: true })).data.ok, 1, 'CSV com ;');
  assert.equal((await admin('GET', '/api/tree')).data.people.find(x => x.name === 'Tia Lote Teste').birthPlace, 'Catuji; MG');

  const adminId = (await admin('GET', '/api/admin')).data.users.find(u => u.email === 'admin@ex.com').id;
  assert.equal((await admin('PUT', '/api/admin/users/' + adminId, { personId: 'avo' })).status, 200);
  assert.equal((await anon('GET', '/api/status')).data.defaultPerson, 'avo', 'visitante começa pela pessoa do admin');

  // bloqueio de conta
  const tiaId = (await admin('GET', '/api/admin')).data.users.find(u => u.email === 'tia@ex.com').id;
  await admin('PUT', '/api/admin/users/' + tiaId, { active: false });
  assert.equal((await tia('GET', '/api/tree')).status, 401, 'conta bloqueada perde acesso');

  // proteção de origem
  const cross = await fetch(base + '/api/logout', { method: 'POST', headers: { origin: 'https://site-malicioso.com' } });
  assert.equal(cross.status, 403);

  console.log('OK: todos os testes passaram');
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error('FALHOU:', e.stack); server.close(); process.exit(1); });
