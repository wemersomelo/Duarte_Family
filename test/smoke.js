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

  // irmãos: por padrão os mesmos pais (só preenche o que falta, nunca troca)
  const pai = (await admin('POST', '/api/people', { name: 'Pai Irmãos', sex: 'm' })).data.id;
  const mae = (await admin('POST', '/api/people', { name: 'Mãe Irmãos', sex: 'f' })).data.id;
  const ir1 = (await admin('POST', '/api/people', { name: 'Irmão Um', fatherId: pai, motherId: mae })).data.id;
  const ir2 = (await tia('POST', '/api/people', { name: 'Irmã Dois', fatherId: pai })).data.id;
  let tI = (await admin('GET', '/api/tree')).data.people;
  assert.equal(tI.find(x => x.id === ir2).motherId, mae, 'irmã sem mãe recebe a mesma mãe do irmão');
  const mae2 = (await admin('POST', '/api/people', { name: 'Outra Mãe', sex: 'f' })).data.id;
  await admin('POST', '/api/people', { name: 'Meio Irmão', fatherId: pai, motherId: mae2 });
  const ir4 = (await admin('POST', '/api/people', { name: 'Irmão Quatro', fatherId: pai })).data.id;
  tI = (await admin('GET', '/api/tree')).data.people;
  assert.ok(!tI.find(x => x.id === ir4).motherId, 'com duas mães diferentes, não adivinha');
  assert.equal(tI.find(x => x.id === ir2).motherId, mae, 'meio-irmão não muda quem já tinha mãe');
  const irLote = '| Ação | Pessoa | Campo | Valor | Fonte | Confiança |\n| NOVA | Irmã Cinco | nome completo | Irmã Cinco | Teste | Relato direto |\n| VÍNCULO | Irmã Cinco | irmã | Irmão Um | Teste | Relato direto |';
  assert.equal((await admin('POST', '/api/admin/import-lote', { text: irLote, apply: true })).data.ok, 2);
  const ir5 = (await admin('GET', '/api/tree')).data.people.find(x => x.name === 'Irmã Cinco');
  assert.equal(ir5.fatherId, pai); assert.equal(ir5.motherId, mae);

  // ligações sugeridas pelas notas
  const tiaN = (await admin('POST', '/api/people', { name: 'Tia Nota Teste', notes: 'Irmã do Irmão Um, casada com tio Sugestão.' })).data.id;
  const tioS = (await admin('POST', '/api/people', { name: 'Tio Sugestão Teste' })).data.id;
  let sg = (await admin('GET', '/api/admin/suggestions')).data.suggestions;
  const sSib = sg.find(x => x.person.id === tiaN && x.kind === 'sibling'), sSp = sg.find(x => x.person.id === tiaN && x.kind === 'spouse');
  assert.ok(sSib, 'sugere irmãos pela nota'); assert.equal(sSib.target.id, ir1);
  assert.ok(sSp && sSp.target.id === tioS, 'sugere cônjuge pela nota');
  assert.equal((await tia('GET', '/api/admin/suggestions')).status, 403);
  assert.ok((await admin('GET', '/api/status')).data.suggestions >= 2);
  let tN = (await admin('GET', '/api/tree')).data.people.find(x => x.id === tiaN); assert.ok(!tN.fatherId, 'nada muda antes de confirmar');
  await admin('POST', '/api/admin/suggestions/apply', { key: sSib.key });
  tN = (await admin('GET', '/api/tree')).data.people.find(x => x.id === tiaN); assert.equal(tN.fatherId, pai); assert.equal(tN.motherId, mae);
  await admin('POST', '/api/admin/suggestions/dismiss', { key: sSp.key });
  sg = (await admin('GET', '/api/admin/suggestions')).data.suggestions;
  assert.ok(!sg.some(x => x.key === sSp.key || x.key === sSib.key), 'aplicada e dispensada não voltam');

  // nomes repetidos na família: mesma pessoa só se os pais baterem
  const joao = (await admin('POST', '/api/people', { name: 'João Ctx', sex: 'm' })).data.id;
  const mariaJ = (await admin('POST', '/api/people', { name: 'Maria Ctx', fatherId: joao })).data.id;
  const ctxLote = (rows) => { const f = new FormData(); f.append('files', new Blob(['Ação,Pessoa,Campo,Valor,Fonte,Confiança\n' + rows]), 'ctx/lote.csv'); return f; };
  // a) Maria filha do José (novo): não é a Maria filha do João -> cria outra, sem perguntar
  let cx = (await admin('POST', '/api/admin/relatos/upload', ctxLote('NOVA,José Ctx,nome completo,José Ctx,T,Relato direto\nATUALIZAR,José Ctx,sexo,masculino,T,Relato direto\nNOVA,Maria Ctx,nome completo,Maria Ctx,T,Relato direto\nVÍNCULO,Maria Ctx,pai,José Ctx,T,Relato direto\nATUALIZAR,Maria Ctx,nascimento,1960,T,Relato direto\n'), true)).data;
  assert.equal(cx.alerts.length, 0, 'não pergunta: pais diferentes = outra pessoa ' + JSON.stringify(cx.alerts.map(a => a.title)));
  await admin('POST', '/api/admin/relatos/run', { token: cx.token, apply: true });
  let tc = (await admin('GET', '/api/tree')).data.people;
  assert.equal(tc.filter(x => x.name === 'Maria Ctx').length, 2, 'duas Marias');
  assert.ok(!tc.find(x => x.id === mariaJ).birth, 'a Maria filha do João não recebeu o dado da outra');
  // b) Maria filha do João: é a mesma -> atualiza sem perguntar
  cx = (await admin('POST', '/api/admin/relatos/upload', ctxLote('ATUALIZAR,Maria Ctx,local de nascimento,Catuji,T,Relato direto\nVÍNCULO,Maria Ctx,pai,João Ctx,T,Relato direto\n'), true)).data;
  assert.equal(cx.alerts.length, 0, 'mesmos pais = mesma pessoa');
  await admin('POST', '/api/admin/relatos/run', { token: cx.token, apply: true });
  tc = (await admin('GET', '/api/tree')).data.people;
  assert.equal(tc.find(x => x.id === mariaJ).birthPlace, 'Catuji');

  // alerta mostra as linhas e os trechos do relato que citam a pessoa
  { const f = new FormData();
    f.append('files', new Blob(['Ação,Pessoa,Campo,Valor,Fonte,Confiança\nATUALIZAR,Pedro Contexto,nascimento,1931,Fala da prima,Provável\nVÍNCULO,Ana Contexto,pai,Pedro Contexto,Fala da prima,Confirmado\n']), 'ctx2/lote.csv');
    f.append('files', new Blob(['# Relato\n## 3. Família\n- O Pedro Contexto era tropeiro e casou em Itaipé.\n- Outra pessoa sem relação.\n']), 'ctx2/relato.md');
    const r = (await admin('POST', '/api/admin/relatos/upload', f, true)).data;
    const a = r.alerts.find(x => x.name === 'Pedro Contexto');
    assert.ok(a && a.context, 'alerta com contexto ' + JSON.stringify(r.alerts));
    assert.ok(a.context.excerpts.some(x => /tropeiro/.test(x.text) && x.section === '3. Família'), 'trecho do relato.md');
    assert.ok(a.context.related.length || a.rows.length > 1, 'outras linhas que citam o nome');
    assert.equal(r.rows[0].fonte, 'Fala da prima', 'fonte de cada linha'); }

  // juntar duas fichas da mesma pessoa
  const dupA = (await admin('POST', '/api/people', { name: 'Duplicada Teste', birth: '1950', fatherId: pai })).data.id;
  const dupB = (await admin('POST', '/api/people', { name: 'Duplicada T.', birth: '1951', birthPlace: 'Catuji' })).data.id;
  const filhoB = (await admin('POST', '/api/people', { name: 'Filho da Duplicada', motherId: dupB })).data.id;
  await admin('POST', `/api/people/${dupB}/notes`, { kind: 'info', text: 'nota da B' });
  assert.equal((await tia('POST', '/api/admin/merge', { keep: dupA, remove: dupB })).status, 403);
  assert.equal((await admin('POST', '/api/admin/merge', { keep: filhoB, remove: dupB })).status, 400, 'pai/mãe não se junta com filho');
  const mr = (await admin('POST', '/api/admin/merge', { keep: dupA, remove: dupB })).data;
  assert.ok(mr.ok); assert.ok(mr.conflicts.some(c => c.includes('1951')));
  const tm = (await admin('GET', '/api/tree')).data;
  assert.ok(!tm.people.some(x => x.id === dupB), 'a outra ficha some');
  const kA = tm.people.find(x => x.id === dupA);
  assert.equal(kA.birth, '1950'); assert.equal(kA.birthPlace, 'Catuji', 'completa o que faltava');
  assert.equal(tm.people.find(x => x.id === filhoB).motherId, dupA, 'filhos passam para a ficha que fica');
  assert.ok(tm.notes.some(n => n.personId === dupA && n.text === 'nota da B'), 'notas passam');
  assert.ok(tm.notes.some(n => n.personId === dupA && n.text.includes('1951')), 'valor diferente guardado em nota');

  // relatos: pasta enviada pelo navegador (com caminhos), .zip e pasta de entrada no servidor
  const { zipSync, strToU8 } = require('fflate');
  const lote2 = 'Ação,Pessoa,Campo,Valor,Fonte,Confiança\nATUALIZAR,Tia Lote,nascimento,1947,Prima X 02/02,Relato direto\nNOVA,Bisavô Novo Teste,nome completo,Bisavô Novo Teste,Prima X,Relato indireto\nVÍNCULO,Bisavô Novo Teste,filho,Tia Lote Teste,Prima X,Relato indireto\nATUALIZAR,Bisavô Novo Teste,sexo,masculino,Prima X,Relato indireto\n';
  const ficha2 = '- **ID:** 2026-02-02_primax\n- **Fonte:** Prima X\n- **Data:** 02/02/2026\n';
  const rfd = new FormData();
  rfd.append('files', new Blob([ficha2]), '2026-02-02_primax/ficha.md');
  rfd.append('files', new Blob(['# Relato da prima X']), '2026-02-02_primax/relato.md');
  rfd.append('files', new Blob([lote2]), '2026-02-02_primax/lote.csv');
  rfd.append('files', new Blob([Buffer.from('%PDF-1.4 teste')]), '2026-02-02_primax/material/certidao.pdf');
  assert.equal((await tia('POST', '/api/admin/relatos/upload', rfd, true)).status, 403, 'só admin envia relato');
  let rrp = (await admin('POST', '/api/admin/relatos/upload', rfd, true)).data;
  assert.equal(rrp.relato.id, '2026-02-02_primax'); assert.equal(rrp.relato.material.length, 1);
  // "Tia Lote" é o apelido de "Tia Lote Teste": alerta de identidade, nada aplicado ainda
  assert.equal(rrp.alerts.length, 1); assert.equal(rrp.alerts[0].type, 'same');
  const tlId = rrp.alerts[0].candidates[0].id, rtok = rrp.token;
  assert.equal((await admin('POST', '/api/admin/relatos/run', { token: rrp.token, apply: true })).status, 400, 'não aplica com alerta aberto');
  rrp = (await admin('POST', '/api/admin/relatos/run', { token: rtok, decisions: { [rrp.alerts[0].key]: 'id:' + tlId } })).data;
  // a data de nascimento diverge (1946 no site): alerta de divergência
  const rdv = rrp.alerts.find(a => a.type === 'divergence'); assert.ok(rdv, 'divergência'); assert.equal(rdv.current, '1946');
  const rap = (await admin('POST', '/api/admin/relatos/run', { token: rtok, decisions: { [rrp.alerts.find(a => a.type !== 'divergence')?.key || 'x']: 'skip', tia: 'skip', 'tia lote': 'id:' + tlId, [rdv.key]: 'keep' }, apply: true }));
  assert.equal(rap.status, 200, JSON.stringify(rap.data));
  let rtr = (await admin('GET', '/api/tree')).data;
  const tlp = rtr.people.find(x => x.id === tlId), biso = rtr.people.find(x => x.name === 'Bisavô Novo Teste');
  assert.equal(tlp.birth, '1946', 'manteve o atual'); assert.ok(rtr.notes.some(n => n.personId === tlId && n.text.includes('Outra versão de nascimento: 1947')));
  assert.ok(biso, 'nova pessoa criada'); assert.ok(rtr.relatoLinks.some(l => l.personId === tlId && l.relatoId === '2026-02-02_primax'), 'relato ligado à pessoa');
  // nome alternativo memorizado: na próxima vez "Tia Lote" resolve sozinho
  const rfd2 = new FormData(); rfd2.append('files', new Blob([zipSync({ 'x/lote.csv': strToU8('Ação,Pessoa,Campo,Valor,Fonte,Confiança\nATUALIZAR,Tia Lote,local de falecimento,Teste,Zip,Hipótese\n') })]), 'x.zip');
  rrp = (await admin('POST', '/api/admin/relatos/upload', rfd2, true)).data;
  assert.equal(rrp.alerts.length, 0, 'nome alternativo lembrado'); assert.equal(rrp.relato.id, 'x');
  // reimportar o mesmo relato: só linhas novas
  rrp = (await admin('POST', '/api/admin/relatos/upload', rfd, true)).data;
  assert.ok(rrp.relato.existing); assert.ok(rrp.rows.filter(r => r.done).length >= 3, 'linhas já importadas não repetem');
  // relato e material: privados
  const relv = await admin('GET', '/api/relatos/2026-02-02_primax'); assert.equal(relv.status, 200); assert.equal(relv.data.files.length, 1);
  assert.equal((await leitor('GET', '/api/relatos/2026-02-02_primax')).status, 403, 'leitor não vê relatos');
  assert.equal((await anon('GET', '/api/relatos/2026-02-02_primax')).status, 403);
  assert.equal((await leitor('GET', '/api/tree')).data.relatoLinks.length, 0, 'leitor não recebe ligações de relatos');
  const rfr = await admin('GET', `/api/relatos/2026-02-02_primax/files/${relv.data.files[0].id}`); assert.equal(rfr.status, 200);
  // pasta de entrada no servidor
  const inboxDir = path.join(process.env.DATA_DIR, 'relatos-entrada', 'melo', '2026-03-03_tio');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'lote.csv'), 'Ação,Pessoa,Campo,Valor,Fonte,Confiança\nNOTA,Tia Lote Teste,nota,Teste da entrada,Tio,Relato direto\n');
  assert.equal((await admin('GET', '/api/status')).data.inboxNew, 1);
  rrp = (await admin('POST', '/api/admin/relatos/inbox', { folder: 'melo/2026-03-03_tio' })).data;
  await admin('POST', '/api/admin/relatos/run', { token: rrp.token, apply: true });
  assert.equal((await admin('GET', '/api/status')).data.inboxNew, 0, 'entrada marcada como importada');
  // varredura de duplicados não junta nada sozinha
  const rdup = (await admin('GET', '/api/admin/duplicates')).data; assert.ok(Array.isArray(rdup.pairs));

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
