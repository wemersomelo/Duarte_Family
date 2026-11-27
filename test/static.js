'use strict';
// Checagem rápida do HTML, sem servidor e sem navegador: pega o tipo de erro que travou o
// "Fechar" em produção (dois elementos com o mesmo id) e seletores que o app.js usa mas que
// não existem mais no HTML (referência órfã, geralmente de uma renomeação esquecida).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const pub = path.join(__dirname, '..', 'public');
const htmlFiles = fs.readdirSync(pub).filter(f => f.endsWith('.html'));

for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(pub, file), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"{}]+)"/g)].map(m => m[1]);
  const seen = new Set(), dup = new Set();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  assert.equal(dup.size, 0, `${file}: id duplicado: ${[...dup].join(', ')}`);
}

// Todo "#algumId" que o app.js usa como seletor precisa existir em algum .html, ou ser um id
// que o próprio app.js cria na hora (innerHTML de um cartão, por exemplo).
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const allIds = new Set([
  ...htmlFiles.flatMap(file => [...fs.readFileSync(path.join(pub, file), 'utf8').matchAll(/\sid="([^"{}]+)"/g)].map(m => m[1])),
  ...[...appJs.matchAll(/\sid="([^"{}$]+)"/g)].map(m => m[1])
]);
const used = new Set();
for (const re of [/\$\(['"]#([A-Za-z][\w-]*)['"]\)/g, /getElementById\(['"]([A-Za-z][\w-]*)['"]\)/g]) {
  for (const m of appJs.matchAll(re)) used.add(m[1]);
}
const missing = [...used].filter(id => !allIds.has(id));
assert.equal(missing.length, 0, `app.js usa estes ids, que não existem em nenhum .html: ${missing.join(', ')}`);

console.log(`OK: HTML sem id duplicado (${htmlFiles.join(', ')}), e todos os ${used.size} seletores de id do app.js existem`);
