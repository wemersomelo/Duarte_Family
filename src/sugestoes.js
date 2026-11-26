'use strict';
// Cruza as notas das fichas ("Irmã do Clemente", "casada com tio Joaquim", "filho da Joana")
// com as pessoas da árvore e sugere ligações. Nada é ligado sem a confirmação do administrador.
const crypto = require('crypto');
const { norm } = require('./lote');

const REL = [
  { re: /^(?:e\s+)?(irm[aã]o?s?|irm[aã]|g[eê]me[ao])\s+(?:mais\s+(?:velh[ao]|nov[ao])\s+)?d[oa]s?\s+(.+)$/i, kind: 'sibling' },
  { re: /^(?:e\s+)?(filh[oa]|fiho|filh[oa]\s+mais\s+(?:velh[ao]|nov[ao]))\s+d[oa]\s+(.+)$/i, kind: 'child' },
  { re: /^(?:e\s+)?(?:pai|m[aã]e)\s+d[oa]\s+(.+)$/i, kind: 'parent' },
  { re: /^(?:e\s+)?(?:casad[oa]|esposa|esposo|marido|mulher|viúv[ao]|viuv[ao])\s+(?:com|de|do|da)\s+(.+)$/i, kind: 'spouse' }
];
const TITLE = /^(o|a|seu|sua|nosso|nossa|tio|tia|vo|vó|vô|avo|avó|avô|bisavo|bisavó|bisavô|padrinho|madrinha|velho|velha|dona|seu|primo|prima)\s+/i;

// Divide o texto em trechos que começam uma frase ou vêm depois de vírgula/"e".
function clauses(text) {
  const out = [];
  for (const sent of String(text || '').replace(/\r/g, '').split(/[.;\n!?]+/)) {
    const parts = sent.split(/,/).map(x => x.trim()).filter(Boolean);
    parts.forEach((c, i) => out.push({ text: c, first: i === 0 }));
  }
  return out;
}

// Acha a pessoa citada no começo de um trecho ("Clemente", "avó Maria", "tio Joaquim", "Joana Alves de Miranda")
function resolveName(db, raw, people) {
  const stop = /\s+(?:que|e|era|foi|com|em|no|na|de\s+(?:quem|onde)|morava|moravam|mora|segundo|\(|"|—|-)\b.*$/i;
  let s = String(raw).replace(/["“”()]/g, ' ').replace(stop, '').trim();
  const words = s.split(/\s+/).slice(0, 5);
  for (let n = Math.min(words.length, 5); n >= 1; n--) {
    const cand = words.slice(0, n).join(' '), c = norm(cand), bare = norm(cand.replace(TITLE, ''));
    if (!bare) continue;
    let hit = people.filter(p => norm(p.nick) === c || norm(p.name) === c);
    if (!hit.length) { const al = db.prepare('SELECT person_id FROM person_aliases WHERE alias=?').get(c); if (al) hit = people.filter(p => p.id === al.person_id); }
    if (!hit.length) hit = people.filter(p => norm(p.name.replace(/\([^)]*\)/g, '')).trim() === c);
    if (!hit.length && n >= 1) {
      // primeiro nome (+ sobrenomes) contido no nome completo, sem o título
      const bw = bare.split(' ');
      hit = people.filter(p => { const pw = norm(p.name.replace(/\([^)]*\)/g, '').replace(TITLE, '')).split(' '); return pw[0] === bw[0] && bw.every(w => pw.includes(w)); });
      // título combina com o apelido ("avó Maria" -> apelido "Avó Maria")
      if (hit.length > 1 && TITLE.test(cand)) { const byNick = hit.filter(p => norm(p.nick) === c); if (byNick.length) hit = byNick; }
    }
    if (hit.length === 1) return { p: hit[0], said: cand };
    if (hit.length > 1 && n === Math.min(words.length, 5)) return { many: hit, said: cand };
    if (hit.length > 1) return { many: hit, said: cand };
  }
  return null;
}

function suggest(db, effectiveParents) {
  const people = db.prepare('SELECT * FROM people').all(), byId = Object.fromEntries(people.map(p => [p.id, p]));
  const par = effectiveParents();
  const noteRows = db.prepare('SELECT person_id, text FROM notes').all();
  const texts = {};
  for (const p of people) if (p.notes) (texts[p.id] ||= []).push(p.notes);
  for (const n of noteRows) if (byId[n.person_id]) (texts[n.person_id] ||= []).push(n.text);
  const dismissed = new Set(db.prepare("SELECT key FROM settings WHERE key LIKE 'nosug:%'").all().map(r => r.key.slice(6)));
  const out = [], seen = new Set();
  const nm = id => byId[id] ? byId[id].name : '';
  for (const [pid, list] of Object.entries(texts)) {
    const p = byId[pid];
    for (const t of list) for (const cl of clauses(t)) {
      for (const r of REL) {
        const m = cl.text.match(r.re); if (!m) continue;
        // irmão/filho/pai só no começo da frase (depois de vírgula costuma falar de outra pessoa); casamento em qualquer trecho
        if (r.kind !== 'spouse' && !cl.first) continue;
        const target = resolveName(db, m[m.length - 1], people.filter(x => x.id !== pid));
        if (!target || !target.p) continue;
        const q = target.p, changes = [];
        const pp = par[pid] || {}, qp = par[q.id] || {};
        if (r.kind === 'sibling') {
          if (pp.f && qp.f && pp.f !== qp.f || pp.m && qp.m && pp.m !== qp.m) continue; // meio-irmãos: não sugere
          if (!pp.f && qp.f) changes.push({ child: pid, parent: qp.f, role: 'father' });
          if (!pp.m && qp.m) changes.push({ child: pid, parent: qp.m, role: 'mother' });
          if (pp.f && !qp.f) changes.push({ child: q.id, parent: pp.f, role: 'father' });
          if (pp.m && !qp.m) changes.push({ child: q.id, parent: pp.m, role: 'mother' });
        } else if (r.kind === 'child') {
          const role = q.sex === 'f' ? 'mother' : q.sex === 'm' ? 'father' : null;
          if (!role || (role === 'father' ? pp.f : pp.m)) continue;
          changes.push({ child: pid, parent: q.id, role });
        } else if (r.kind === 'parent') {
          const role = p.sex === 'f' ? 'mother' : p.sex === 'm' ? 'father' : null;
          if (!role || (role === 'father' ? qp.f : qp.m)) continue;
          changes.push({ child: q.id, parent: pid, role });
        } else if (r.kind === 'spouse') {
          if (p.spouse_id || q.spouse_id) continue;
          changes.push({ spouse: [pid, q.id] });
        }
        if (!changes.length) continue;
        const key = crypto.createHash('sha1').update(JSON.stringify(changes)).digest('hex').slice(0, 16);
        if (seen.has(key) || dismissed.has(key)) continue; seen.add(key);
        out.push({
          key, kind: r.kind, person: { id: pid, name: p.name }, target: { id: q.id, name: q.name }, quote: cl.text.slice(0, 200),
          changes, describe: changes.map(c => c.spouse ? `${nm(c.spouse[0])} e ${nm(c.spouse[1])}: cônjuges` : `${nm(c.child)}: ${c.role === 'father' ? 'pai' : 'mãe'} ${nm(c.parent)}`)
        });
      }
    }
  }
  return out;
}

module.exports = { suggest, clauses, resolveName };
