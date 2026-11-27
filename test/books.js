'use strict';
// Livros por código (/K7P2Q) e entrar com código por e-mail. Roda num diretório temporário.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvore-livros-'));
Object.assign(process.env, { DATA_DIR: dir, SMTP_HOST: 'test', SMTP_USER: 'site@ex.com', SMTP_PASS: 'x' });
const { app } = require('../server');
const mail = require('../src/mail');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  const jar = {};
  const f = async (method, url, body) => {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload; if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) { const [kv, ...attrs] = sc.split(';'); const [k, v] = kv.split('='); if (v) jar[k.trim()] = v; else delete jar[k.trim()]; f.attrs[k.trim()] = attrs.join(';'); }
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, location: r.headers.get('location') };
  };
  f.jar = jar; f.attrs = {};
  return f;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const leo = client(), ana = client(), anon = client();
  assert.equal((await leo('POST', '/api/setup', { name: 'Leo', email: 'leo@ex.com', password: 'senha-forte-1', terms: true, adult: true })).status, 200);
  await leo('POST', '/api/people', { name: 'Pessoa do Leo' });

  // pedido e aprovação
  assert.equal((await anon('POST', '/api/livro-pedido', { name: 'Ana', email: 'ana@fora.com', family: 'lopes santos', place: 'Igarapé, MG', consent: true })).status, 200);
  const av = (await leo('GET', '/api/notifications')).data.notifications.find(n => n.bookRequest);
  assert.ok(av && av.bookRequest.pending, 'o aviso traz o botão de aprovar');
  assert.equal((await ana('POST', `/api/admin/book-requests/${av.bookRequest.id}/approve`)).status, 403, 'só o administrador aprova');
  const ap = await leo('POST', `/api/admin/book-requests/${av.bookRequest.id}/approve`);
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const { code, setupKey } = ap.data; await wait(100);
  assert.match(code, /^[A-HJKMNP-Z2-9]{5}$/, 'código curto, sem letras que confundem');
  assert.ok(ap.data.mailed && mail.sent.some(m => m.to === 'ana@fora.com' && m.text.includes(code) && m.text.includes(setupKey)), 'e-mail com código e chave');
  assert.equal((await leo('POST', `/api/admin/book-requests/${av.bookRequest.id}/approve`)).status, 400, 'não cria duas vezes');
  const lst = (await leo('GET', '/api/admin/book-requests')).data;
  assert.equal(lst.requests[0].bookCode, code); assert.equal(lst.codeBooks[0].code, code);

  // o livro novo: separado do principal
  const st = (await ana('GET', `/${code}/api/status`)).data;
  assert.equal(st.needsSetup, true); assert.equal(st.book, code);
  assert.equal((await ana('POST', `/${code}/api/setup`, { name: 'Ana', email: 'ana@fora.com', password: 'senha-forte-2', terms: true, adult: true, setupKey: 'errada' })).status, 403, 'precisa da chave');
  assert.equal((await ana('POST', `/${code}/api/setup`, { name: 'Ana', email: 'ana@fora.com', password: 'senha-forte-2', terms: true, adult: true, setupKey, family: 'Família Lopes Santos' })).status, 200);
  assert.ok(ana.jar['sid_' + code], 'cookie com nome do livro'); assert.match(ana.attrs['sid_' + code], new RegExp(`Path=/${code}`));
  await ana('POST', `/${code}/api/people`, { name: 'Pessoa da Ana' });
  const treeAna = (await ana('GET', `/${code}/api/tree`)).data.people.map(p => p.name);
  assert.ok(treeAna.includes('Pessoa da Ana') && !treeAna.includes('Pessoa do Leo'), 'livro da Ana só tem os dados dela');
  const treeLeo = (await leo('GET', '/api/tree')).data.people.map(p => p.name);
  assert.ok(!treeLeo.includes('Pessoa da Ana'), 'livro do Leo não vê os dados da Ana');
  assert.equal((await ana('GET', '/api/status')).data.user, null, 'conta da Ana não vale no livro do Leo');
  assert.equal((await leo('GET', `/${code}/api/status`)).data.user, null, 'conta do Leo não vale no livro da Ana');
  assert.equal((await leo('GET', `/${code}/api/tree`)).status, 401);
  const html = (await anon('GET', `/${code}/`)).data;
  assert.ok(html.includes(`content="/${code}"`) && html.includes('Família Lopes Santos'), 'página do livro com o endereço e o nome');
  assert.equal((await anon('GET', `/${code.toLowerCase()}/api/status`)).location, `/${code}/api/status`, 'minúsculas viram o código certo');
  assert.equal((await anon('GET', '/ZZZZZ')).location, '/?livro=naoencontrado');
  assert.equal((await ana('POST', `/${code}/api/livro-pedido`, { name: 'x', email: 'x@x.com', family: 'X', consent: true })).status, 404, 'pedidos só no site principal');
  assert.ok(fs.existsSync(path.join(dir, 'livros-codigo', code, 'arvore.db')), 'banco próprio do livro');

  // entrar com código por e-mail (no principal)
  const n0 = mail.sent.length;
  assert.equal((await anon('POST', '/api/login/code', { email: 'ninguem@ex.com' })).status, 200, 'não revela quem tem conta');
  assert.equal(mail.sent.length, n0, 'sem conta, sem e-mail');
  const cl = client();
  assert.equal((await cl('POST', '/api/login/code', { email: 'leo@ex.com' })).status, 200);
  await wait(50);
  const msg = mail.sent.filter(m => m.to === 'leo@ex.com').pop(); const got = msg.subject.match(/(\d{6})/)[1];
  assert.equal((await cl('POST', '/api/login/code/verify', { email: 'leo@ex.com', code: got === '000000' ? '111111' : '000000' })).status, 401, 'código errado');
  assert.equal((await cl('POST', '/api/login/code/verify', { email: 'leo@ex.com', code: got })).status, 200);
  assert.equal((await cl('GET', '/api/status')).data.user.name, 'Leo');
  assert.equal((await client()('POST', '/api/login/code/verify', { email: 'leo@ex.com', code: got })).status, 401, 'código vale uma vez só');
  // 5 erros invalidam o código
  const cx = client(); await cx('POST', '/api/login/code', { email: 'leo@ex.com' });
  for (let i = 0; i < 5; i++) await cx('POST', '/api/login/code/verify', { email: 'leo@ex.com', code: '99999' + i });
  const msg2 = mail.sent.filter(m => m.to === 'leo@ex.com').pop().subject.match(/(\d{6})/)[1];
  assert.equal((await cx('POST', '/api/login/code/verify', { email: 'leo@ex.com', code: msg2 })).status, 401, 'depois de 5 erros, pede outro');

  // esqueci a senha
  const n1 = mail.sent.length;
  assert.equal((await anon('POST', '/api/forgot', { email: 'ninguem@ex.com' })).status, 200); await wait(50);
  assert.equal(mail.sent.length, n1, 'sem conta, sem e-mail');
  assert.equal((await anon('POST', '/api/forgot', { email: 'leo@ex.com' })).status, 200); await wait(50);
  const tok = mail.sent.filter(m => m.to === 'leo@ex.com').pop().text.match(/\/senha\/([a-f0-9]+)/)[1];
  const fg = client();
  assert.equal((await fg('POST', '/api/reset/' + tok, { password: 'senha-nova-123' })).status, 200);
  assert.equal((await client()('POST', '/api/login', { email: 'leo@ex.com', password: 'senha-nova-123' })).status, 200, 'entra com a senha nova');
  assert.equal((await client()('POST', '/api/reset/' + tok, { password: 'outra-senha-1' })).status, 404, 'link vale uma vez só');

  console.log('OK: livros por código, entrar com código e esqueci a senha');
  app.locals.books.stop(code); server.close(); process.exit(0);
})().catch(e => { console.error(e); try { for (const b of app.locals.books.list()) app.locals.books.stop(b.code); } catch {} process.exit(1); });
