'use strict';
// Importação de lotes dos relatórios de entrevista (projeto GENEALOGIC TREE).
// Aceita a tabela colada do relatório (markdown) ou um CSV com as colunas:
//   Ação | Pessoa | Campo | Valor | Fonte | Confiança
// Regras: nunca apaga nada; quando um campo já tem outro valor, o antigo vira nota ("versão anterior");
// fonte e confiança vão para o campo "Fontes" da pessoa; campos desconhecidos viram nota.

const crypto = require('crypto');
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const unmd = s => String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

// ---------- leitura ----------
function splitCsvLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"' && cur.trim() === '') { q = true; cur = ''; }
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out.map(s => s.trim());
}
function parseRows(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  let rows;
  if (lines.some(l => l.trim().startsWith('|'))) {
    rows = lines.filter(l => l.trim().startsWith('|')).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
      .filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));
  } else {
    const sep = (lines[0] || '').split(';').length > (lines[0] || '').split(',').length ? ';' : ',';
    rows = lines.map(l => splitCsvLine(l, sep));
  }
  const h = rows.findIndex(r => norm(r[0]).startsWith('acao') && r.some(c => norm(c) === 'pessoa'));
  if (h < 0) return { error: 'Não encontrei o cabeçalho "Ação | Pessoa | Campo | Valor | Fonte | Confiança".' };
  const head = rows[h].map(norm), col = k => head.findIndex(c => c.startsWith(k));
  const idx = { acao: col('acao'), pessoa: col('pessoa'), campo: col('campo'), valor: col('valor'), fonte: col('fonte'), conf: col('confian') };
  if (idx.pessoa < 0 || idx.campo < 0 || idx.valor < 0) return { error: 'Faltam colunas: preciso de Pessoa, Campo e Valor.' };
  return { rows: rows.slice(h + 1).map((r, i) => ({ n: i + 1, acao: unmd(r[idx.acao]), pessoa: unmd(r[idx.pessoa]), campo: unmd(r[idx.campo]), valor: String(r[idx.valor] || '').trim(), fonte: unmd(r[idx.fonte]), conf: unmd(r[idx.conf]) })).filter(r => r.pessoa || r.valor) };
}

// ---------- campos ----------
const FIELD = [
  [/^(nome|nome completo|nome correto)$/, 'name'], [/^primeiro nome$/, 'given'],
  [/^(apelido|como e chamad[oa]|como gosta de ser chamad[oa]|conhecid[oa] como)$/, 'nick'], [/^sexo$/, 'sex'],
  [/^(nascimento|data de nascimento|nasceu)$/, 'birth'], [/^(local de nascimento|naturalidade|nasceu em)$/, 'birth_place'],
  [/^(falecimento|obito|data de falecimento|data de obito|morte)$/, 'death'], [/^(local de falecimento|local de obito|sepultamento|local de sepultamento)$/, 'death_place'],
  [/^(casamento|data de casamento|data do casamento)$/, 'marriage'], [/^(local de casamento|local do casamento)$/, 'marriage_place'],
  [/^(cor|cor\/raca|raca)$/, 'color'], [/^(origem|etnia|origem\/etnia)$/, 'origin'],
  [/^pai$/, 'father_id'], [/^(mae)$/, 'mother_id'], [/^pais$/, 'parents'],
  [/^(conjuge|esposa|esposo|marido|mulher|casou com)$/, 'spouse_id'], [/^(filh[oa]s?|filho\/filha)$/, 'child'],
  [/^(irmao|irma|irmaos|irmas|irmao\/irma|gemeo|gemea)$/, 'sibling'],
  [/^(nota|notas|observacao|informacao|info)$/, 'note'], [/^(lembranca|memoria|historia|causo)$/, 'memory']
];
const fieldOf = campo => { const c = norm(campo); for (const [re, f] of FIELD) if (re.test(c)) return f; return null; };
const LABEL = { name: 'nome', given: 'primeiro nome', nick: 'apelido', sex: 'sexo', birth: 'nascimento', birth_place: 'local de nascimento', death: 'falecimento', death_place: 'local de falecimento', marriage: 'casamento', marriage_place: 'local do casamento', color: 'cor/raça', origin: 'origem/etnia', father_id: 'pai', mother_id: 'mãe', spouse_id: 'cônjuge' };
const COLOR = { branca: 'branca', branco: 'branca', preta: 'preta', preto: 'preta', parda: 'parda', pardo: 'parda', amarela: 'amarela', amarelo: 'amarela', indigena: 'indigena' };
// "Donato ("velho Donato")" -> nome "Donato" e apelido "velho Donato"
function splitNick(v) { const m = unmd(v).match(/^(.*?)\s*\(\s*["“]([^"”]+)["”]\s*\)\s*$/); return m ? { main: m[1].trim(), nick: m[2].trim() } : { main: unmd(v), nick: '' }; }

// Identifica uma linha do lote (para não aplicar duas vezes a mesma linha de um relato).
const rowKey = r => crypto.createHash('sha1').update([r.acao, r.pessoa, r.campo, r.valor].map(norm).join('|')).digest('hex').slice(0, 16);
// Alerta: a linha fica parada até o administrador decidir.
class Alert extends Error { constructor(a) { super(a.title); this.alert = a; } }

// ---------- aplicação ----------
function runLote(db, text, { apply, userId, newId, now, resolver, divergence, skipKeys }) {
  const parsed = parseRows(text); if (parsed.error) return { error: parsed.error };
  const report = [];
  const all = () => db.prepare('SELECT * FROM people').all();
  function find(ref, ctx) {
    if (resolver) return resolver(ref, ctx || {});
    const { main } = splitNick(ref), r = norm(main); if (!r) return { none: true };
    const al = db.prepare('SELECT p.* FROM person_aliases a JOIN people p ON p.id=a.person_id WHERE a.alias=?').get(r); if (al) return { p: al };
    const ps = all();
    const byId = ps.find(p => p.id === main); if (byId) return { p: byId };
    let hit = ps.filter(p => norm(p.name) === r); if (hit.length === 1) return { p: hit[0] }; if (hit.length > 1) return { many: hit };
    hit = ps.filter(p => norm(p.nick) === r); if (hit.length === 1) return { p: hit[0] };
    const words = r.split(' ');
    hit = ps.filter(p => { const w = norm(p.name).split(' '); return words.every(x => w.includes(x)); });
    if (hit.length === 1) return { p: hit[0] }; if (hit.length > 1) return { many: hit };
    return { none: true };
  }
  const addNote = (pid, kind, txt) => { if (!db.prepare('SELECT 1 FROM notes WHERE person_id=? AND text=?').get(pid, txt)) db.prepare('INSERT INTO notes(person_id,kind,text,created_by,created_at) VALUES(?,?,?,?,?)').run(pid, kind, txt.slice(0, 5000), userId, now()); };
  const addSource = (pid, what, row) => {
    if (!row.fonte && !row.conf) return;
    const line = `• ${what}: ${row.fonte || 'sem fonte'}${row.conf ? ' (' + row.conf.toLowerCase() + ')' : ''}`;
    const cur = db.prepare('SELECT sources FROM people WHERE id=?').get(pid).sources || '';
    if (!cur.includes(line)) db.prepare('UPDATE people SET sources=?, updated_at=? WHERE id=?').run((cur ? cur + '\n' : '') + line, now(), pid);
  };
  const src = row => row.fonte ? ` (${row.fonte}${row.conf ? ', ' + row.conf.toLowerCase() : ''})` : '';
  const nameOf = id => { const q = db.prepare('SELECT name FROM people WHERE id=?').get(id); return q ? q.name : id; };
  function setField(p, f, v, row) {
    const old = p[f] || '';
    if (norm(old) === norm(v)) return 'já estava assim';
    if (old && divergence) {
      const rel = ['father_id', 'mother_id', 'spouse_id'].includes(f), show = x => rel ? nameOf(x) : x;
      const key = `${p.id}|${f}|${norm(v)}`, d = divergence(key);
      if (!d) {
        const srcLine = String(p.sources || '').split('\n').filter(l => norm(l).startsWith('• ' + norm(LABEL[f]))).pop() || '';
        throw new Alert({ type: 'divergence', key, title: `Divergência em ${LABEL[f]} de ${p.name}`, person: p.name, field: LABEL[f], current: show(old), currentSource: srcLine.replace(/^•\s*/, ''), proposed: show(v), proposedSource: [row.fonte, row.conf].filter(Boolean).join(', ') });
      }
      if (d === 'keep') { addNote(p.id, 'info', `Outra versão de ${LABEL[f]}: ${show(v)}${src(row)}. Mantido "${show(old)}".`); return `mantido "${show(old)}"; a outra versão ficou em nota`; }
    }
    if (old && !['father_id', 'mother_id', 'spouse_id'].includes(f)) addNote(p.id, 'info', `Versão anterior de ${LABEL[f]}: ${old}. Trocado por "${v}" no lote${src(row)}.`);
    db.prepare(`UPDATE people SET ${f}=?, updated_at=? WHERE id=?`).run(v, now(), p.id); p[f] = v; touched.add(p.id);
    return old ? `${LABEL[f]}: "${old}" → "${v}" (versão anterior guardada em nota)` : `${LABEL[f]}: ${v}`;
  }

  let touched = new Set();
  // Pessoa citada no Valor (pai, mãe, cônjuge, filho): pode gerar alerta ou ser criada se o administrador decidiu "criar nova".
  function target(v) {
    const t = find(v, { role: 'valor' });
    if (t.alert) throw new Alert(t.alert);
    if (t.skip) throw Object.assign(new Error('pulada (decisão: pular por enquanto)'), { skipped: true });
    if (t.create) {
      const { main, nick } = splitNick(v), id = newId(main);
      db.prepare('INSERT INTO people(id,name,nick,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, main, nick, userId, now(), now());
      touched.add(id); if (t.onCreate) t.onCreate(id);
      return { p: db.prepare('SELECT * FROM people WHERE id=?').get(id) };
    }
    if (!t.p) throw new Error(t.many ? `"${v}" é ambíguo: ${t.many.map(x => x.name).join(', ')}` : `"${v}" não está na árvore. Crie primeiro com uma linha NOVA.`);
    touched.add(t.p.id); return t;
  }
  const tx = db.transaction(() => {
    for (const row of parsed.rows) {
      const out = { n: row.n, key: rowKey(row), acao: row.acao, pessoa: row.pessoa, campo: row.campo, valor: unmd(row.valor), fonte: row.fonte, conf: row.conf };
      touched = new Set();
      if (skipKeys && skipKeys.has(out.key)) { out.done = 'já importada antes'; report.push(out); continue; }
      const sp = db.prepare('SAVEPOINT linha'); sp.run();
      try {
        const f = fieldOf(row.campo), ac = norm(row.acao);
        let who = find(row.pessoa, { role: 'pessoa', nova: ac.includes('nova'), row }), p = who.p;
        if (who.alert) throw new Alert(who.alert);
        if (who.skip) { out.skipped = 'pulada (decisão: pular por enquanto)'; db.prepare('RELEASE linha').run(); report.push(out); continue; }
        if (who.many) throw new Error('mais de uma pessoa com esse nome: ' + who.many.map(x => x.name).join(', ') + '. Use o nome completo.');
        if (!p) {
          if (!ac.includes('nova') && !who.create) throw new Error('pessoa não encontrada na árvore. Use NOVA para criar.');
          const { main, nick } = f === 'name' ? splitNick(row.valor) : splitNick(row.pessoa);
          const id = newId(main);
          db.prepare('INSERT INTO people(id,name,nick,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, main, nick, userId, now(), now());
          p = db.prepare('SELECT * FROM people WHERE id=?').get(id); out.novo = true; touched.add(id); if (who.onCreate) who.onCreate(id);
        }
        out.pessoa = p.name;
        const v = unmd(row.valor);
        if (ac.startsWith('confirm')) { addSource(p.id, `${row.campo} ${v}`.trim(), row); out.ok = 'fonte acrescentada'; }
        else if (ac.startsWith('nota') || f === 'note' || f === 'memory') { addNote(p.id, f === 'memory' ? 'memory' : 'info', v + src(row)); out.ok = 'nota acrescentada'; }
        else if (f === 'name') {
          const { main, nick } = splitNick(row.valor);
          out.ok = out.novo ? `criada: ${main}` : setField(p, 'name', main, row);
          if (nick && !p.nick) { db.prepare('UPDATE people SET nick=? WHERE id=?').run(nick, p.id); out.ok += `; apelido: ${nick}`; }
          addSource(p.id, 'nome', row);
        }
        else if (['father_id', 'mother_id', 'spouse_id'].includes(f)) {
          const t = target(v); if (t.p.id === p.id) throw new Error('a pessoa não pode ser ligada a ela mesma');
          out.ok = setField(p, f, t.p.id, row).replace(t.p.id, t.p.name); addSource(p.id, LABEL[f] + ' ' + t.p.name, row);
          if (f === 'spouse_id' && !t.p.spouse_id) db.prepare('UPDATE people SET spouse_id=? WHERE id=?').run(p.id, t.p.id);
        }
        else if (f === 'parents') {
          const names = v.split(/\s*(?:\+|\be\b|&)\s*/).filter(Boolean), done = [];
          for (const nm of names) {
            const t = target(nm);
            const slot = t.p.sex === 'f' ? 'mother_id' : t.p.sex === 'm' ? 'father_id' : null;
            if (!slot) throw new Error(`não sei se ${t.p.name} é pai ou mãe (sexo não informado)`);
            setField(p, slot, t.p.id, row); done.push(`${LABEL[slot]}: ${t.p.name}`);
          }
          addSource(p.id, 'pais', row); out.ok = done.join('; ');
        }
        else if (f === 'child') {
          const t = target(v);
          const slot = p.sex === 'f' ? 'mother_id' : p.sex === 'm' ? 'father_id' : null;
          if (!slot) throw new Error(`não sei se ${p.name} é pai ou mãe (sexo não informado)`);
          out.ok = `${t.p.name}: ` + setField(t.p, slot, p.id, row).replace(p.id, p.name); addSource(t.p.id, LABEL[slot] + ' ' + p.name, row);
        }
        else if (f === 'sibling') {
          // Irmãos têm os mesmos pais: copia o que falta de um para o outro; nunca troca um pai/mãe já registrado.
          const t = target(v); if (t.p.id === p.id) throw new Error('a pessoa não pode ser irmã dela mesma');
          const done = [];
          for (const slot of ['father_id', 'mother_id']) {
            const a = p[slot] || '', b = t.p[slot] || '';
            if (a && b && a !== b) throw new Error(`${p.name} e ${t.p.name} têm ${LABEL[slot]} diferente no site (meio-irmãos?). Confira e ligue à mão.`);
            if (!a && b) { setField(p, slot, b, row); done.push(`${p.name}: ${LABEL[slot]} ${nameOf(b)}`); }
            if (a && !b) { setField(t.p, slot, a, row); done.push(`${t.p.name}: ${LABEL[slot]} ${nameOf(a)}`); }
          }
          if (!p.father_id && !p.mother_id) throw new Error(`nem ${p.name} nem ${t.p.name} têm pai ou mãe na árvore. Registre os pais primeiro (irmãos se ligam pelos pais).`);
          if (/^gem/.test(norm(row.campo))) addNote(p.id, 'info', `Gêmeo(a) de ${t.p.name}${src(row)}.`);
          addSource(p.id, 'irmão(ã) ' + t.p.name, row);
          out.ok = done.length ? 'mesmos pais · ' + done.join('; ') : `irmãos: já têm os mesmos pais`;
        }
        else if (f === 'color') { const c = COLOR[norm(v)]; if (!c) throw new Error('cor/raça deve ser branca, preta, parda, amarela ou indígena'); out.ok = setField(p, 'color', c, row); addSource(p.id, 'cor/raça', row); }
        else if (f === 'sex') { const s = /^f|^mulher/.test(norm(v)) ? 'f' : /^m|^homem/.test(norm(v)) ? 'm' : ''; out.ok = setField(p, 'sex', s, row); }
        else if (f) { out.ok = setField(p, f, v, row); addSource(p.id, `${LABEL[f]} ${v}`, row); }
        else { addNote(p.id, 'info', `${row.campo}: ${v}${src(row)}`); out.ok = 'nota acrescentada (campo livre)'; }
        if (out.novo) out.ok = 'NOVA pessoa · ' + out.ok;
        touched.add(p.id); out.people = [...touched];
        db.prepare('RELEASE linha').run();
      } catch (e) {
        db.prepare('ROLLBACK TO linha').run(); db.prepare('RELEASE linha').run();
        if (e.alert) out.alert = e.alert; else if (e.skipped) out.skipped = e.message; else out.erro = e.message;
      }
      report.push(out);
    }
    if (!apply) throw Object.assign(new Error('preview'), { preview: true });
  });
  try { tx(); } catch (e) { if (!e.preview) throw e; }
  return { rows: report, ok: report.filter(r => r.ok).length, erros: report.filter(r => r.erro).length, alerts: report.filter(r => r.alert).length, applied: !!apply };
}

module.exports = { runLote, parseRows, rowKey, norm, unmd, splitNick };
