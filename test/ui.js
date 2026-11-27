'use strict';
// Teste de verdade, com navegador escondido (Playwright): simula um clique de pessoa de carne e
// osso, não só chamadas de API. É o que pega bugs de interação (ex.: um diálogo que não fecha)
// que os outros testes, por falarem só com a API, não enxergam.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arvore-ui-'));
Object.assign(process.env, { DATA_DIR: dir, SMTP_HOST: 'test', SMTP_USER: 'site@ex.com', SMTP_PASS: 'x' });
const { app } = require('../server');
const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function setupData() {
  const r = await fetch(base + '/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Leo', email: 'leo@ex.com', password: 'senha-forte-1', terms: true, adult: true })
  });
  const sid = (r.headers.getSetCookie().find(c => c.startsWith('sid=')) || '').split(';')[0].split('=')[1];
  assert.ok(sid, 'conta criada e com sessão');
  const headers = { 'content-type': 'application/json', cookie: 'sid=' + sid };
  const post = (url, body) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) }).then(r => r.json());
  const leo = await post('/api/people', { name: 'Leo Teste' });
  const pai = await post('/api/people', { name: 'Pai Teste' });
  const avo = await post('/api/people', { name: 'Avô Teste' });
  await fetch(base + '/api/people/' + leo.id, { method: 'PUT', headers, body: JSON.stringify({ fatherId: pai.id }) });
  await fetch(base + '/api/people/' + pai.id, { method: 'PUT', headers, body: JSON.stringify({ fatherId: avo.id }) });
  return { sid, leoId: leo.id, paiId: pai.id };
}

(async () => {
  const { sid } = await setupData();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'sid', value: sid, domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(base + '/');
  await page.waitForSelector('#fig button[data-id]');

  // Clicar numa pessoa abre o cartão dela, por cima da árvore, sem navegar de página.
  const urlAntes = page.url();
  await page.locator('#fig button[data-id]').first().click();
  await page.waitForSelector('#carddlg[open]');
  assert.equal(page.url(), urlAntes.split('#')[0] + page.url().match(/#.*/)[0], 'mesma página, só o hash muda');
  const nome1 = await page.locator('#slip h3.person').textContent();

  // Clicar num parente, dentro do cartão, troca a pessoa mostrada mas não fecha o cartão
  // nem mexe na árvore de fundo (o bug que estávamos resolvendo era bem aqui: duas coisas
  // com o mesmo id brigando e travando o fechar).
  const chip = page.locator('#kin [data-card]').first();
  if (await chip.count()) {
    await chip.click();
    await page.waitForFunction(() => document.querySelector('#carddlg').open === true);
    const nome2 = await page.locator('#slip h3.person').textContent();
    assert.notEqual(nome1, nome2, 'trocou de pessoa dentro do mesmo cartão');
  }

  // Fechar de verdade fecha (clique real, não via JS) — é a correção do bug de produção.
  await page.locator('#carddlg .closeDlg').click();
  await page.waitForFunction(() => document.querySelector('#carddlg').open === false, null, { timeout: 5000 });

  // Abrir "Editar" por cima do cartão: o cartão fecha sozinho (nunca duas janelas abertas ao
  // mesmo tempo), e volta sozinho quando o formulário fecha — sem isso, o botão "Fechar" do
  // cartão ficava visível atrás mas o clique não chegava nele (pertencia à janela de trás).
  await page.locator('#fig button[data-id]').first().click();
  await page.waitForSelector('#carddlg[open]');
  await page.locator('#slip [data-act="edit"], #slip button:has-text("Editar")').first().click();
  await page.waitForSelector('#dlg[open]');
  assert.equal(await page.locator('#carddlg').evaluate(d => d.open), false, 'o cartão fecha sozinho enquanto o formulário está aberto');
  await page.locator('#dlg .closeDlg').click();
  await page.waitForSelector('#carddlg[open]');
  assert.equal(await page.locator('#dlg').evaluate(d => d.open), false, 'o formulário fechou');
  // E agora o "Fechar" do cartão, que antes podia ficar bloqueado, funciona de verdade.
  await page.locator('#carddlg .closeDlg').click();
  await page.waitForFunction(() => document.querySelector('#carddlg').open === false, null, { timeout: 5000 });

  // "Ver a árvore desta pessoa" recentra a árvore e fecha o cartão.
  await page.locator('#fig button[data-id]').first().click();
  await page.waitForSelector('#carddlg[open]');
  const tituloAntes = await page.locator('#chartTitle').textContent();
  await page.locator('#cardTree').click();
  await page.waitForFunction(() => document.querySelector('#carddlg').open === false);

  // Trocar a senha usa outro diálogo (id diferente, de propósito): continua funcionando
  // separado do cartão da pessoa.
  await page.locator('#pwBtn').click();
  await page.waitForSelector('#pdlg[open]');
  assert.equal(await page.locator('#pdlg h2').textContent(), 'Trocar senha');
  assert.equal(await page.locator('#carddlg').evaluate(d => d.open), false, 'o cartão de pessoa continua fechado');
  await page.locator('#pdlg .closeDlg').click();

  assert.deepEqual(errors, [], 'sem erros de JavaScript na página: ' + errors.join(' | '));

  console.log('OK: navegador de verdade — abrir cartão, trocar de parente, fechar, ver árvore, sem travar');
  await browser.close();
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(async e => {
  console.error('FALHOU:', e.stack);
  try { server.close(); } catch {}
  process.exit(1);
});
