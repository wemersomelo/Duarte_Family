'use strict';
// Teste de verdade, com navegador escondido (Playwright): simula um clique de pessoa de carne e
// osso, não só chamadas de API. É o que pega bugs de interação que os outros testes, por falarem
// só com a API, não enxergam.
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
  return { sid };
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

  // Clicar numa pessoa na árvore atualiza a ficha logo abaixo, na mesma página.
  const nome1 = await page.locator('#slip h3.person').textContent();
  const chipPai = page.locator('#kin [data-go]').first();
  assert.ok(await chipPai.count(), 'tem um parente para clicar (pai)');
  await chipPai.click();
  await page.waitForFunction(prev => document.querySelector('#slip h3.person')?.textContent !== prev, nome1);
  const nome2 = await page.locator('#slip h3.person').textContent();
  assert.notEqual(nome1, nome2, 'a ficha trocou de pessoa');

  // "← Voltar" existe agora (temos de onde voltar) e volta para a pessoa de antes.
  await page.waitForSelector('#backBtn:not([hidden])');
  await page.locator('#backBtn').click();
  await page.waitForFunction(prev => document.querySelector('#slip h3.person')?.textContent === prev, nome1);

  // Editar abre um formulário por cima; cancelar fecha e volta para a árvore normalmente
  // (nenhum outro diálogo fica aberto por baixo bloqueando o clique).
  await page.locator('#slip button:has-text("Editar meus dados"), #slip button:has-text("Editar")').first().click();
  await page.waitForSelector('#dlg[open]');
  await page.locator('#dlg .closeDlg').click();
  await page.waitForFunction(() => document.querySelector('#dlg').open === false);

  // Trocar a senha continua funcionando, num diálogo separado.
  await page.locator('#pwBtn').click();
  await page.waitForSelector('#pdlg[open]');
  assert.equal(await page.locator('#pdlg h2').textContent(), 'Trocar senha');
  await page.locator('#pdlg .closeDlg').click();
  await page.waitForFunction(() => document.querySelector('#pdlg').open === false);

  assert.deepEqual(errors, [], 'sem erros de JavaScript na página: ' + errors.join(' | '));

  console.log('OK: navegador de verdade — clicar num parente, voltar, editar e trocar senha, sem travar nem erro de JS');
  await browser.close();
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(async e => {
  console.error('FALHOU:', e.stack);
  try { server.close(); } catch {}
  process.exit(1);
});
