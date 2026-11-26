'use strict';
// Exportação GEDCOM 5.5.1, o formato padrão aceito por qualquer programa de genealogia
// (Gramps, FamilySearch, MyHeritage, Ancestry...).

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function gedDate(s) {
  s = String(s || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${Number(m[1])} ${MONTHS[Number(m[2]) - 1] || ''} ${m[3]}`.replace('  ', ' ');
  m = s.match(/(\d{4})/);
  if (m) return /volta|aprox|cerca|~/i.test(s) ? `ABT ${m[1]}` : m[1];
  return '';
}
function line(level, tag, value) {
  const v = String(value ?? '').replace(/\r?\n/g, ' ');
  return `${level} ${tag}${v ? ' ' + v : ''}`;
}
function noteLines(level, text) {
  const out = [], parts = String(text).split(/\r?\n/);
  parts.forEach((p, i) => {
    const chunks = p.match(/.{1,200}/g) || [''];
    chunks.forEach((c, j) => out.push(line(level + (i || j ? 1 : 0), i === 0 && j === 0 ? 'NOTE' : j === 0 ? 'CONT' : 'CONC', c)));
  });
  return out;
}

function toGedcom(people, title) {
  const ids = new Map(people.map((p, i) => [p.id, `@I${i + 1}@`]));
  const fams = new Map();
  const famKey = (a, b) => [a || '-', b || '-'].join('|');
  const getFam = (h, w) => {
    const k = famKey(h, w);
    if (!fams.has(k)) fams.set(k, { id: `@F${fams.size + 1}@`, husb: h, wife: w, chil: [] });
    return fams.get(k);
  };
  const byId = Object.fromEntries(people.map(p => [p.id, p]));
  for (const p of people) {
    const f = byId[p.fatherId] ? p.fatherId : '', m = byId[p.motherId] ? p.motherId : '';
    if (f || m) getFam(f, m).chil.push(p.id);
  }
  for (const p of people) {
    const s = byId[p.spouseId];
    if (!s) continue;
    const [h, w] = p.sex === 'f' || s.sex === 'm' ? [s.id, p.id] : [p.id, s.id];
    if (![...fams.values()].some(f => (f.husb === h && f.wife === w))) getFam(h, w);
  }
  const famsOf = id => [...fams.values()].filter(f => f.husb === id || f.wife === id);
  const famcOf = id => [...fams.values()].filter(f => f.chil.includes(id));

  const out = ['0 HEAD', '1 SOUR ARVORE_FAMILIA', '1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8', line(1, 'NOTE', title)];
  for (const p of people) {
    out.push(`0 ${ids.get(p.id)} INDI`);
    const parts = String(p.name).trim().split(/\s+/);
    const surname = parts.length > 1 ? parts.pop() : '';
    out.push(line(1, 'NAME', `${parts.join(' ')} /${surname}/`));
    if (p.nick) out.push(line(2, 'NICK', p.nick));
    if (p.sex === 'm' || p.sex === 'f') out.push(line(1, 'SEX', p.sex.toUpperCase()));
    if (p.birth || p.birthPlace) {
      out.push('1 BIRT');
      if (gedDate(p.birth)) out.push(line(2, 'DATE', gedDate(p.birth)));
      if (p.birthPlace) out.push(line(2, 'PLAC', p.birthPlace));
    }
    if (p.death || p.deathPlace) {
      out.push('1 DEAT Y');
      if (gedDate(p.death)) out.push(line(2, 'DATE', gedDate(p.death)));
      if (p.deathPlace) out.push(line(2, 'PLAC', p.deathPlace));
    }
    const COL = { branca: 'Branca', preta: 'Preta', parda: 'Parda', amarela: 'Amarela', indigena: 'Indígena' };
    const note = [p.color ? `Cor/raça: ${COL[p.color] || p.color}` : '', p.origin ? `Origem/etnia: ${p.origin}` : '', p.notes, p.sources ? `Fontes: ${p.sources}` : ''].filter(Boolean).join('\n');
    if (note) out.push(...noteLines(1, note));
    for (const f of famcOf(p.id)) out.push(line(1, 'FAMC', f.id));
    for (const f of famsOf(p.id)) out.push(line(1, 'FAMS', f.id));
  }
  for (const f of fams.values()) {
    out.push(`0 ${f.id} FAM`);
    if (f.husb) out.push(line(1, 'HUSB', ids.get(f.husb)));
    if (f.wife) out.push(line(1, 'WIFE', ids.get(f.wife)));
    const h = byId[f.husb] || {}, w = byId[f.wife] || {};
    const mDate = h.marriage || w.marriage, mPlace = h.marriagePlace || w.marriagePlace;
    if (f.husb && f.wife && (mDate || mPlace)) { out.push('1 MARR'); if (gedDate(mDate)) out.push(line(2, 'DATE', gedDate(mDate))); if (mPlace) out.push(line(2, 'PLAC', mPlace)); }
    for (const c of f.chil) out.push(line(1, 'CHIL', ids.get(c)));
  }
  out.push('0 TRLR');
  return out.join('\r\n') + '\r\n';
}

module.exports = { toGedcom };
