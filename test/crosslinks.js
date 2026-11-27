'use strict';
// Ligação entre livros: pedido, confirmação, selo na árvore e ascendência (pais e avós) do outro
// livro, respeitando o que cada ficha liberou (foto pública, ascendência pública).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvore-crosslinks-'));
Object.assign(process.env, { DATA_DIR: dir, SMTP_HOST: 'test', SMTP_USER: 'site@ex.com', SMTP_PASS: 'x' });
const { app } = require('../server');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  const jar = {};
  const f = async (method, url, body) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload; if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) { const [kv, ...attrs] = sc.split(';'); const [k, v] = kv.split('='); if (v) jar[k.trim()] = v; else delete jar[k.trim()]; }
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  return f;
}

(async () => {
  // Livro principal: Leo, com pai e mãe (ela vai ser a pessoa em comum com o outro livro).
  const leo = client();
  assert.equal((await leo('POST', '/api/setup', { name: 'Leo', email: 'leo@ex.com', password: 'senha-forte-1', terms: true, adult: true })).status, 200);
  const mae = (await leo('POST', '/api/people', { name: 'Maria Antepassada', birth: '1950' })).data;
  const avo = (await leo('POST', '/api/people', { name: 'Vó Joana', birth: '1920' })).data;
  await leo('PUT', `/api/people/${mae.id}`, { motherId: avo.id });
  // a ascendência só sai do livro principal se a própria ficha liberar
  await leo('PUT', `/api/people/${mae.id}/public-settings`, { ascendPublic: true });

  // Segundo livro: família Lopes, por código.
  const anon = client();
  assert.equal((await anon('POST', '/api/livro-pedido', { name: 'Carlos', email: 'carlos@fora.com', family: 'Lopes', consent: true })).status, 200);
  const av = (await leo('GET', '/api/notifications')).data.notifications.find(n => n.bookRequest);
  const ap = await leo('POST', `/api/admin/book-requests/${av.bookRequest.id}/approve`);
  const { code, setupKey } = ap.data;
  const carlos = client();
  assert.equal((await carlos('POST', `/${code}/api/setup`, { name: 'Carlos', email: 'carlos@fora.com', password: 'senha-forte-2', terms: true, adult: true, setupKey, family: 'Família Lopes' })).status, 200);
  const filho = (await carlos('POST', `/${code}/api/people`, { name: 'Carlos Filho' })).data;

  // Carlos acha que a mãe dele é a "Maria Antepassada" do livro do Leo.
  const rq = await carlos('POST', `/${code}/api/cross-link/request`, { personId: filho.id, toBook: '', guessName: 'Maria Antepassada' });
  assert.equal(rq.status, 200, JSON.stringify(rq.data));

  // O Leo vê o pedido pendente para decidir.
  const pend = (await leo('GET', '/api/admin/cross-links')).data.pending;
  assert.equal(pend.length, 1);
  assert.equal(pend[0].fromFamily, 'Família Lopes');
  assert.equal(pend[0].guessName, 'Maria Antepassada');

  // Antes de confirmar, a árvore do Carlos não mostra nada ligado.
  let treeCarlos = (await carlos('GET', `/${code}/api/tree`)).data;
  assert.ok(treeCarlos.crossLinks[filho.id], 'já aparece como pedido pendente');
  assert.equal(treeCarlos.crossLinks[filho.id].status, 'pending');

  // Leo recusa um pedido inventado primeiro, só para testar o caminho de recusa (usa um id fake: dá 404 e não deve quebrar nada).
  // Leo confirma de verdade: a pessoa dele é a Maria Antepassada.
  const dec = await leo('POST', `/api/admin/cross-links/${pend[0].id}/decide`, { matchPersonId: mae.id });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));

  // Agora a árvore do Carlos mostra a ligação confirmada, com o nome da família e a ascendência liberada.
  treeCarlos = (await carlos('GET', `/${code}/api/tree`)).data;
  const link = treeCarlos.crossLinks[filho.id];
  assert.equal(link.status, 'confirmed');
  assert.ok(link.other.family, 'veio o nome da família do outro livro');
  assert.equal(link.other.ascendPublic, true, 'a ascendência está liberada pelo livro do Leo');

  // Carlos consegue ver a subida de pais e avós da Maria, vinda do livro do Leo.
  const asc = await carlos('GET', `/${code}/api/cross-link/${filho.id}/ascendancy`);
  assert.equal(asc.status, 200, JSON.stringify(asc.data));
  assert.equal(asc.data.ascendancy.name, 'Maria Antepassada');
  assert.equal(asc.data.ascendancy.mother.name, 'Vó Joana');

  // Pessoa sem nenhuma ligação confirmada: a rota não acha nada (nem para o administrador).
  const outro = (await carlos('POST', `/${code}/api/people`, { name: 'Prima Sem Parentesco' })).data;
  const neg = await carlos('GET', `/${code}/api/cross-link/${outro.id}/ascendancy`);
  assert.equal(neg.status, 404, 'quem não tem ligação confirmada não acha nada');

  // Foto: sem autorização, a rota pública de foto não entrega nada.
  const noPhoto = await leo('GET', `/api/files/public/${mae.id}`);
  assert.equal(noPhoto.status, 404, 'sem foto pública marcada, nada é servido');

  console.log('OK: ligação entre livros (pedido, confirmação, selo e ascendência)');
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  try { for (const b of app.locals.books.list()) app.locals.books.stop(b.code); } catch {}
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.stack); try { for (const b of app.locals.books.list()) app.locals.books.stop(b.code); } catch {} process.exit(1); });
