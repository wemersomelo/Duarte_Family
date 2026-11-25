'use strict';
(() => {
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let me = null, people = {}, notes = [], files = [], media = [], userNames = {}, focus = null, editing = null, ctx = {};
const P = id => (id && people[id]) ? people[id] : null;
const canWrite = () => me && me.role !== 'viewer';
const canEdit = p => !!p && canWrite() && (me.role === 'admin' || (p.createdBy != null && p.createdBy === me.id));
const yr = p => { const y = s => (String(s || '').match(/\d{4}/) || [''])[0]; return p.birth || p.death ? `${y(p.birth) || '?'}${p.death ? ' – ' + (y(p.death) || '†') : ''}` : ''; };
const byName = (a, b) => norm(a.name).localeCompare(norm(b.name));
const childrenOf = id => Object.values(people).filter(p => p.fatherId === id || p.motherId === id);
const spousesOf = id => {
  const s = new Set(), p = P(id); if (p?.spouseId && P(p.spouseId)) s.add(p.spouseId);
  for (const q of Object.values(people)) if (q.spouseId === id) s.add(q.id);
  for (const c of childrenOf(id)) { const o = c.fatherId === id ? c.motherId : c.fatherId; if (o && P(o)) s.add(o); }
  s.delete(id); return [...s];
};
const siblingsOf = id => { const p = P(id); if (!p) return []; return Object.values(people).filter(q => q.id !== id && ((p.fatherId && q.fatherId === p.fatherId) || (p.motherId && q.motherId === p.motherId))); };
const who = id => id == null ? 'Registro inicial' : (userNames[id] || 'alguém da família');
const fmtDate = s => { try { return new Date(s).toLocaleDateString('pt-BR'); } catch { return ''; } };

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers = { 'Content-Type': 'application/json', ...(o.headers || {}) }; o.body = JSON.stringify(o.body); }
  const r = await fetch(path, o);
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(data.error || 'Algo deu errado.'); e.status = r.status; throw e; }
  return data;
}

/* ---------- entrar / convite / instalação ---------- */
let authMode = 'login', inviteToken = null, resetToken = null, familyName = 'Árvore da Família', defaultPerson = '';
function showAuth(mode, info = {}) {
  authMode = mode;
  $('#main').hidden = true; $('#auth').hidden = false;
  $('#authTitle').textContent = familyName;
  const f = $('#authForm');
  $('#fName').hidden = mode === 'login' || mode === 'reset';
  f.querySelector('input[name=email]').closest('label').hidden = mode === 'reset';
  f.elements.email.required = mode !== 'reset';
  $('#fKey').hidden = mode !== 'setup';
  f.elements.name.required = mode !== 'login' && mode !== 'reset';
  f.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authBtn').textContent = mode === 'login' ? 'Entrar' : mode === 'reset' ? 'Salvar nova senha' : 'Criar conta';
  $('#authSub').textContent = mode === 'reset' ? `Olá, ${info.name || ''}. Escolha uma senha nova (mínimo 8 caracteres).` : mode === 'setup' ? 'Primeira vez: crie a conta do administrador.' :
    mode === 'invite' ? `Você foi convidado${info.label ? ' (' + info.label + ')' : ''}. Crie sua conta para ${info.role === 'viewer' ? 'ver' : 'ver e completar'} a árvore da família.` :
    'Entre com seu e-mail e senha.';
  $('#authHelp').hidden = mode !== 'login';
  $('#authErr').textContent = '';
}
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, body = { name: f.elements.name.value, email: f.elements.email.value, password: f.elements.password.value, setupKey: f.elements.setupKey.value };
  $('#authErr').textContent = '';
  try {
    if (authMode === 'login') await api('/api/login', { method: 'POST', body });
    else if (authMode === 'setup') await api('/api/setup', { method: 'POST', body });
    else if (authMode === 'reset') await api('/api/reset/' + encodeURIComponent(resetToken), { method: 'POST', body: { password: body.password } });
    else await api('/api/invites/' + encodeURIComponent(inviteToken), { method: 'POST', body });
    if (authMode === 'invite' || authMode === 'reset') history.replaceState(null, '', '/');
    start();
  } catch (err) { $('#authErr').textContent = err.message; }
});

async function start() {
  const st = await api('/api/status');
  familyName = st.familyName || familyName; defaultPerson = st.defaultPerson || '';
  document.title = familyName; $('#title').textContent = familyName;
  const rm = location.pathname.match(/^\/senha\/([\w-]+)/);
  if (rm) {
    resetToken = rm[1];
    try { const info = await api('/api/reset/' + encodeURIComponent(resetToken)); return showAuth('reset', info); }
    catch (err) { history.replaceState(null, '', '/'); showAuth('login'); $('#authErr').textContent = err.message; return; }
  }
  const m = location.pathname.match(/^\/convite\/([\w-]+)/);
  if (m && !st.user) {
    inviteToken = m[1];
    try { const info = await api('/api/invites/' + encodeURIComponent(inviteToken)); return showAuth('invite', info); }
    catch (err) { showAuth('login'); $('#authErr').textContent = err.message; return; }
  }
  if (st.needsSetup) return showAuth('setup');
  if (!st.user) return showAuth('login');
  if (m) history.replaceState(null, '', '/');
  me = st.user;
  $('#auth').hidden = true; $('#main').hidden = false;
  $('#whoami').textContent = me.name;
  $('#adminBtn').hidden = me.role !== 'admin';
  $('#addBtn').hidden = !canWrite();
  await load();
}

async function load() {
  try {
    const d = await api('/api/tree');
    people = Object.fromEntries(d.people.map(p => [p.id, p]));
    notes = d.notes; files = d.files; media = d.media || [];
    userNames = Object.fromEntries(d.users.map(u => [u.id, u.name]));
    me = d.me;
    const n = d.people.length;
    $('#status').textContent = `${n} pessoas na árvore. ` + (canWrite() ? 'Você pode adicionar pessoas, informações e documentos; só altera o que você mesmo adicionou.' : 'Você pode ver a árvore e deixar lembranças, fotos, vídeos e links.');
    renderAll();
  } catch (err) {
    if (err.status === 401) return start();
    $('#status').textContent = 'Não foi possível carregar a árvore: ' + err.message;
  }
}

function setFocus(id) { if (!P(id)) return; focus = id; if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id); renderAll(); }
function go(id) { setFocus(id); $('#fig').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }

/* ---------- gráfico de antepassados ---------- */
const fig = $('#fig');
function drawChart() {
  const G = +$('#gens').value, p = P(focus);
  if (!p) { fig.innerHTML = '<p class="none" style="padding:20px 0">Nenhuma pessoa selecionada.</p>'; fig.style.cssText = ''; return; }
  $('#chartTitle').textContent = 'Antepassados de ' + (p.nick || p.name.split(' ')[0]);
  const narrow = innerWidth < 600, CW = narrow ? 170 : 210, GAP = narrow ? 26 : 42, SH = narrow ? 62 : 66, CH = 52, TOP = 24;
  const slots = 2 ** (G - 1), H = TOP + slots * SH, W = G * CW + (G - 1) * GAP;
  fig.style.cssText = `--cw:${CW}px;width:${W}px;height:${H}px`;
  const labels = ['Pessoa', 'Pais', 'Avós', 'Bisavós', 'Tataravós'];
  let html = '', lines = ''; const pos = [];
  for (let g = 0; g < G; g++) html += `<div class="gen" style="left:${g * (CW + GAP)}px">${labels[g]}</div>`;
  const place = (id, g, i, childId, role) => {
    const n = 2 ** g, y = TOP + (i + .5) * (slots * SH / n) - CH / 2, x = g * (CW + GAP);
    (pos[g] = pos[g] || [])[i] = null;
    const q = P(id); if (!q && !(childId && canWrite())) return;
    if (g > 0) { const pc = pos[g - 1][i >> 1]; if (pc) { const x1 = pc.x + CW, y1 = pc.y + CH / 2, y2 = y + CH / 2, mx = x1 + GAP / 2; lines += `<path d="M${x1} ${y1}H${mx}V${y2}H${x}" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>`; } }
    pos[g][i] = { x, y };
    if (q) {
      const meta = [yr(q), q.birthPlace].filter(Boolean).join(' · ');
      const av = q.photoFileId ? `<img class="av" src="/api/files/${encodeURIComponent(q.photoFileId)}" alt="" loading="lazy">` : '';
      html += `<button type="button" class="card${g === 0 ? ' focus' : ''}${av ? ' hasav' : ''}" data-id="${esc(q.id)}" style="left:${x}px;top:${y}px;height:${CH}px" title="${esc(q.name)}">${av}<span class="nm">${esc(q.name)}</span><span class="meta">${esc(meta || 'datas desconhecidas')}</span></button>`;
      if (g < G - 1) { place(q.fatherId, g + 1, i * 2, q.id, 'father'); place(q.motherId, g + 1, i * 2 + 1, q.id, 'mother'); }
    } else {
      html += `<button type="button" class="card empty" data-add="${role}" data-child="${esc(childId)}" style="left:${x}px;top:${y}px;height:${CH}px">+ ${role === 'father' ? 'Adicionar pai' : 'Adicionar mãe'}</button>`;
    }
  };
  place(focus, 0, 0, null, null);
  fig.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" style="color:var(--ink)">${lines}</svg>` + html;
}
fig.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.id) { if (b.dataset.id === focus) $('#slip').scrollIntoView({ behavior: 'smooth', block: 'start' }); else setFocus(b.dataset.id); }
  else if (b.dataset.add) openForm(null, { parentOf: b.dataset.child, parentRole: b.dataset.add });
});
$('#gens').addEventListener('change', drawChart);
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawChart, 150); });

/* ---------- ficha da pessoa ---------- */
const chip = q => `<button type="button" class="chip" data-go="${esc(q.id)}">${esc(q.nick ? q.name + ' (' + q.nick + ')' : q.name)}</button>`;
const chips = list => list.length ? `<div class="chips">${list.sort(byName).map(chip).join('')}</div>` : '<p class="none">Ninguém registrado ainda.</p>';
function renderRecord() {
  const p = P(focus), slip = $('#slip'), kin = $('#kin');
  if (!p) { slip.innerHTML = '<p class="none">Procure ou escolha uma pessoa na lista abaixo.</p>'; kin.innerHTML = ''; return; }
  const row = (k, v, plain) => v ? `<dt>${k}</dt><dd${plain ? ' class="plain"' : ''}>${esc(v)}</dd>` : '';
  const pn = notes.filter(n => n.personId === p.id);
  const pf = files.filter(f => f.personId === p.id);
  const ed = canEdit(p);
  const mine = x => canWrite() && (me.role === 'admin' || x.createdBy === me.id);
  const info = pn.filter(n => n.kind !== 'memory'), mem = pn.filter(n => n.kind === 'memory');
  const pm = media.filter(m => m.personId === p.id);
  const isImg = f => /^image\/(jpeg|png|webp)$/.test(f.mime);
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const kindOf = u => /youtu\.?be/.test(u) ? 'YouTube' : /drive\.google|photos\.google/.test(u) ? 'Google' : /instagram/.test(u) ? 'Instagram' : /facebook|fb\.watch/.test(u) ? 'Facebook' : /vimeo/.test(u) ? 'Vimeo' : /whatsapp/.test(u) ? 'WhatsApp' : 'Link';
  const noteList = list => list.length ? `<ul class="notes">${list.map(n => `<li>${esc(n.text)}<small>${esc(who(n.createdBy))}, ${esc(fmtDate(n.createdAt))}${mine(n) ? ` · <button type="button" class="link" data-rmnote="${n.id}">remover</button>` : ''}</small></li>`).join('')}</ul>` : '';
  slip.innerHTML = `<div class="phead">${p.photoFileId ? `<button type="button" class="pphoto" data-view="${esc(p.photoFileId)}" aria-label="Ver foto"><img src="/api/files/${encodeURIComponent(p.photoFileId)}" alt="Foto de ${esc(p.name)}"></button>` : ''}<div><h3 class="person">${esc(p.name)}</h3><p class="nick">${p.nick ? '“' + esc(p.nick) + '”' : '&nbsp;'}</p></div></div>
  <dl>${row('Nascimento', p.birth)}${row('Local', p.birthPlace)}${row('Falecimento', p.death)}${row('Local', p.deathPlace)}${row('Histórias', p.notes, 1)}${row('Fontes', p.sources, 1)}</dl>
  ${!p.birth && !p.birthPlace && !p.notes ? '<p class="none">Ainda faltam informações sobre esta pessoa. Se você sabe algo, acrescente.</p>' : ''}
  <p class="by">Registrado por ${esc(who(p.createdBy))}</p>
  <div class="actions">${canWrite() ? '<button type="button" class="primary" data-act="note">+ Acrescentar informação</button>' : ''}<button type="button"${canWrite() ? '' : ' class="primary"'} data-act="memory">+ Deixar uma lembrança</button><button type="button" data-act="files">+ Fotos e documentos</button><button type="button" data-act="link">+ Vídeo ou link</button></div>
  ${canWrite() ? `<div class="actions small"><button type="button" data-act="child">+ Filho ou filha</button><button type="button" data-act="spouse">+ Cônjuge</button>${ed ? '<button type="button" data-act="edit">Editar</button><button type="button" class="danger" data-act="del">Excluir</button>' : ''}</div>` : ''}
  <h4>Fotos e documentos (${pf.length})</h4>
  ${pf.length ? `<div class="docs">${pf.map(f => `<div class="doc${f.id === p.photoFileId ? ' main' : ''}"><button type="button" class="thumb${f.mime === 'application/pdf' ? ' pdf' : ''}" data-view="${esc(f.id)}" ${isImg(f) ? `style="background-image:url('/api/files/${encodeURIComponent(f.id)}')"` : ''} aria-label="Abrir ${esc(f.name)}">${f.mime === 'application/pdf' ? 'PDF' : /hei[cf]/.test(f.mime) ? 'HEIC' : ''}</button><small title="${esc(f.caption || f.name)}">${esc(f.caption || f.name)}</small>${f.id === p.photoFileId ? '<small class="star">foto principal</small>' : ed && isImg(f) ? `<button type="button" class="link" data-mainphoto="${esc(f.id)}">usar como foto principal</button>` : ''}${mine(f) ? `<button type="button" class="link" data-rmfile="${esc(f.id)}">remover</button>` : ''}</div>`).join('')}</div>` : '<p class="none">Nenhum ainda.</p>'}
  <h4>Vídeos e links (${pm.length})</h4>
  ${pm.length ? `<ul class="mlinks">${pm.map(m => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><span class="tag">${esc(kindOf(m.url))}</span>${esc(m.title || host(m.url))}</a><small>${esc(host(m.url))} · ${esc(who(m.createdBy))}, ${esc(fmtDate(m.createdAt))}${mine(m) ? ` · <button type="button" class="link" data-rmlink="${m.id}">remover</button>` : ''}</small></li>`).join('')}</ul>` : '<p class="none">Nenhum ainda.</p>'}
  <h4>Lembranças da família (${mem.length})</h4>
  ${mem.length ? noteList(mem) : '<p class="none">Nenhuma ainda. Conte uma história, uma lembrança ou algo que você aprendeu com esta pessoa.</p>'}
  <h4>Informações da família (${info.length})</h4>
  ${info.length ? noteList(info) : '<p class="none">Nenhuma ainda.</p>'}`;
  const par = [P(p.fatherId), P(p.motherId)].filter(Boolean);
  kin.innerHTML = `<h4>Pais</h4>${chips(par)}<h4>Cônjuge</h4>${chips(spousesOf(p.id).map(P))}<h4>Filhos</h4>${chips(childrenOf(p.id))}<h4>Irmãos</h4>${chips(siblingsOf(p.id))}`;
}
document.addEventListener('click', async e => {
  const g = e.target.closest('[data-go]'); if (g) { closeAll(); go(g.dataset.go); return; }
  const v = e.target.closest('[data-view]'); if (v) { openViewer(v.dataset.view); return; }
  const rn = e.target.closest('[data-rmnote]'); if (rn) { if (await confirmBtn(rn)) { await api('/api/notes/' + rn.dataset.rmnote, { method: 'DELETE' }).catch(err => alertStatus(err)); load(); } return; }
  const rl = e.target.closest('[data-rmlink]'); if (rl) { if (await confirmBtn(rl)) { await api('/api/media-links/' + rl.dataset.rmlink, { method: 'DELETE' }).catch(err => alertStatus(err)); load(); } return; }
  const mp = e.target.closest('[data-mainphoto]'); if (mp) { await api(`/api/people/${encodeURIComponent(focus)}/photo`, { method: 'PUT', body: { fileId: mp.dataset.mainphoto } }).catch(err => alertStatus(err)); load(); return; }
  const rf = e.target.closest('[data-rmfile]'); if (rf) { if (await confirmBtn(rf)) { await api('/api/files/' + rf.dataset.rmfile, { method: 'DELETE' }).catch(err => alertStatus(err)); load(); } return; }
  const c = e.target.closest('.closeDlg'); if (c) { c.closest('dialog').close(); return; }
  const a = e.target.closest('[data-act]'); if (!a) return; const p = P(focus); if (!p) return;
  if (a.dataset.act === 'edit') openForm(p.id);
  if (a.dataset.act === 'child') openForm(null, { childOf: p.id });
  if (a.dataset.act === 'spouse') openForm(null, { spouseOf: p.id });
  if (a.dataset.act === 'del') openForm(p.id, { confirmDel: true });
  if (a.dataset.act === 'note') openNote(p.id, 'info');
  if (a.dataset.act === 'memory') openNote(p.id, 'memory');
  if (a.dataset.act === 'link') openLink(p.id);
  if (a.dataset.act === 'files') openFiles(p.id);
});
function closeAll() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
function alertStatus(err) { $('#status').textContent = err.message; }
// Pede um segundo clique para confirmar remoções (sem janelas do navegador).
function confirmBtn(btn) {
  if (btn.dataset.armed) return Promise.resolve(true);
  btn.dataset.armed = '1'; const t = btn.textContent; btn.textContent = 'clique de novo para remover';
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = t; }, 4000);
  return Promise.resolve(false);
}

/* ---------- índice e busca ---------- */
function renderIndex() {
  const list = Object.values(people).sort(byName);
  $('#count').textContent = list.length ? `(${list.length})` : '';
  $('#index').innerHTML = list.length ? list.map(p => `<li><button type="button" data-go="${esc(p.id)}">${esc(p.name)} <span>${esc(yr(p))}</span></button></li>`).join('') : '<li class="none">A árvore ainda está vazia. Comece adicionando alguém.</li>';
}
const q = $('#q'), res = $('#results');
function search() {
  const t = norm(q.value.trim()); if (!t) { res.style.display = 'none'; return; }
  const hits = Object.values(people).filter(p => norm([p.name, p.nick, p.birthPlace, p.deathPlace, p.notes].join(' ')).includes(t)).sort(byName).slice(0, 30);
  res.innerHTML = hits.length ? hits.map(p => `<button type="button" data-hit="${esc(p.id)}">${esc(p.name)}<small>${esc([p.nick, yr(p), p.birthPlace].filter(Boolean).join(' · ') || 'sem datas')}</small></button>`).join('') : '<p class="none" style="padding:12px 14px;margin:0">Ninguém encontrado. Você pode adicionar essa pessoa.</p>';
  res.style.display = 'block';
}
q.addEventListener('input', search); q.addEventListener('focus', search);
q.addEventListener('keydown', e => { if (e.key === 'Escape') { q.value = ''; res.style.display = 'none'; } if (e.key === 'Enter') { const f = res.querySelector('[data-hit]'); if (f) f.click(); } });
res.addEventListener('click', e => { const b = e.target.closest('[data-hit]'); if (!b) return; res.style.display = 'none'; q.value = ''; go(b.dataset.hit); });
document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) res.style.display = 'none'; });

/* ---------- formulário de pessoa ---------- */
const FIELDS = ['name', 'nick', 'sex', 'birth', 'birthPlace', 'death', 'deathPlace', 'fatherId', 'motherId', 'spouseId', 'notes', 'sources'];
const dlg = $('#dlg'), form = $('#form');
function fillSelect(sel, val, excl) {
  const opts = Object.values(people).filter(p => p.id !== excl).sort(byName);
  sel.innerHTML = '<option value="">Não informado</option>' + opts.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${yr(p) ? ' (' + esc(yr(p)) + ')' : ''}</option>`).join('');
  sel.value = val || '';
}
function openForm(id, c = {}) {
  if (!canWrite()) return; const p = id ? P(id) : {}; if (id && !canEdit(p)) return;
  editing = id; ctx = c;
  $('#formTitle').textContent = c.confirmDel ? 'Excluir ' + p.name + '?' : id ? 'Editar ' + p.name : c.parentOf ? (c.parentRole === 'father' ? 'Pai de ' : 'Mãe de ') + P(c.parentOf).name : c.childOf ? 'Filho ou filha de ' + P(c.childOf).name : c.spouseOf ? 'Cônjuge de ' + P(c.spouseOf).name : 'Adicionar pessoa';
  for (const f of FIELDS) { const el = form.elements[f]; if (el.tagName !== 'SELECT' || f === 'sex') el.value = p[f] || ''; }
  fillSelect(form.elements.fatherId, p.fatherId, id); fillSelect(form.elements.motherId, p.motherId, id); fillSelect(form.elements.spouseId, p.spouseId, id);
  if (c.childOf) { const par = P(c.childOf); form.elements[par.sex === 'f' ? 'motherId' : 'fatherId'].value = par.id; const sp = spousesOf(par.id)[0]; if (sp) form.elements[par.sex === 'f' ? 'fatherId' : 'motherId'].value = sp; }
  if (c.parentOf) { form.elements.sex.value = c.parentRole === 'father' ? 'm' : 'f'; const ch = P(c.parentOf), other = c.parentRole === 'father' ? ch.motherId : ch.fatherId; if (P(other)) form.elements.spouseId.value = other; }
  if (c.spouseOf) { form.elements.spouseId.value = c.spouseOf; const o = P(c.spouseOf); if (o.sex) form.elements.sex.value = o.sex === 'm' ? 'f' : 'm'; }
  $('#delBtn').hidden = !c.confirmDel; $('#saveBtn').hidden = !!c.confirmDel;
  [...form.querySelectorAll('input,select,textarea')].forEach(el => { el.disabled = !!c.confirmDel; });
  $('#formErr').textContent = c.confirmDel ? 'A pessoa será removida para toda a família. As informações e documentos ligados a ela continuam guardados.' : '';
  dlg.showModal(); if (c.confirmDel) $('#delBtn').focus(); else form.elements.name.focus();
}
form.addEventListener('submit', async e => {
  e.preventDefault(); if (ctx.confirmDel) return;
  const d = {}; for (const f of FIELDS) d[f] = String(form.elements[f].value || '').trim();
  if (!d.name) { $('#formErr').textContent = 'Escreva pelo menos o nome.'; return; }
  $('#saveBtn').disabled = true; $('#formErr').textContent = 'Salvando…';
  try {
    if (editing) await api('/api/people/' + encodeURIComponent(editing), { method: 'PUT', body: d });
    else {
      const r = await api('/api/people', { method: 'POST', body: { ...d, parentOf: ctx.parentOf, parentRole: ctx.parentRole } });
      if (!ctx.parentOf && !ctx.childOf && !ctx.spouseOf) focus = r.id;
    }
    dlg.close(); await load();
  } catch (err) { $('#formErr').textContent = err.message; }
  finally { $('#saveBtn').disabled = false; }
});
$('#delBtn').addEventListener('click', async () => {
  const p = P(editing); if (!p) return;
  try { await api('/api/people/' + encodeURIComponent(p.id), { method: 'DELETE' }); dlg.close(); focus = p.fatherId || p.motherId || null; await load(); }
  catch (err) { $('#formErr').textContent = err.message; }
});
$('#addBtn').addEventListener('click', () => openForm(null, {}));

/* ---------- informação ---------- */
const ndlg = $('#ndlg'), nform = $('#nform'); let notePerson = null, noteKind = 'info';
function openNote(id, kind) {
  notePerson = id; noteKind = kind;
  $('#nTitle').textContent = (kind === 'memory' ? 'Lembrança de ' : 'Informação sobre ') + P(id).name;
  $('#nHelp').textContent = kind === 'memory' ? 'Conte uma lembrança, uma história, um ensinamento ou um recado sobre esta pessoa. Fica com o seu nome.' : 'Escreva o que você sabe: datas, lugares, correções. Diga de onde veio a informação, se souber.';
  nform.reset(); $('#nErr').textContent = ''; ndlg.showModal(); nform.elements.text.focus();
}
nform.addEventListener('submit', async e => {
  e.preventDefault();
  try { await api(`/api/people/${encodeURIComponent(notePerson)}/notes`, { method: 'POST', body: { text: nform.elements.text.value, kind: noteKind } }); ndlg.close(); await load(); }
  catch (err) { $('#nErr').textContent = err.message; }
});

/* ---------- vídeos e links ---------- */
const ldlg = $('#ldlg'), lform = $('#lform'); let linkPerson = null;
function openLink(id) { if (!me) return; linkPerson = id; $('#lTitle').textContent = 'Vídeo ou link de ' + P(id).name; lform.reset(); $('#lErr').textContent = ''; ldlg.showModal(); lform.elements.url.focus(); }
lform.addEventListener('submit', async e => {
  e.preventDefault();
  try { await api(`/api/people/${encodeURIComponent(linkPerson)}/links`, { method: 'POST', body: { url: lform.elements.url.value, title: lform.elements.title.value } }); ldlg.close(); await load(); }
  catch (err) { $('#lErr').textContent = err.message; }
});

/* ---------- documentos ---------- */
const fdlg = $('#fdlg'), fform = $('#fform'); let filePerson = null;
function openFiles(id) { filePerson = id; $('#fTitle').textContent = 'Fotos e documentos de ' + P(id).name; fform.reset(); $('#fErr').textContent = ''; fdlg.showModal(); }
fform.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(fform);
  $('#fSave').disabled = true; $('#fErr').textContent = 'Enviando…';
  try { await api(`/api/people/${encodeURIComponent(filePerson)}/files`, { method: 'POST', body: fd }); fdlg.close(); await load(); }
  catch (err) { $('#fErr').textContent = err.message; }
  finally { $('#fSave').disabled = false; }
});
function openViewer(id) {
  const f = files.find(x => x.id === id); if (!f) return;
  const url = '/api/files/' + encodeURIComponent(id);
  $('#vCap').textContent = (f.caption ? f.caption + ' · ' : '') + f.name + ' · enviado por ' + who(f.createdBy);
  $('#vDl').href = url + '?download=1';
  const body = $('#vBody');
  body.innerHTML = f.mime.startsWith('image/') && !/hei[cf]/.test(f.mime) ? `<img src="${url}" alt="${esc(f.caption || f.name)}">` :
    f.mime === 'application/pdf' ? `<iframe src="${url}" title="${esc(f.name)}"></iframe>` : '<p class="none" style="padding:20px">Este formato não abre no navegador. Use "Baixar".</p>';
  $('#vdlg').showModal();
}

/* ---------- senha ---------- */
$('#pwBtn').addEventListener('click', () => { $('#pform').reset(); $('#pErr').textContent = ''; $('#pdlg').showModal(); });
$('#pform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try { await api('/api/password', { method: 'POST', body: { current: f.elements.current.value, password: f.elements.password.value } }); $('#pdlg').close(); $('#status').textContent = 'Senha alterada.'; }
  catch (err) { $('#pErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); me = null; showAuth('login'); });

/* ---------- administração ---------- */
async function loadActivity() {
  const box = $('#activity');
  try {
    const d = await api('/api/admin/activity');
    box.innerHTML = d.activity.length ? `<table class="tbl"><tbody>${d.activity.map(a => `<tr><td>${esc(new Date(a.at).toLocaleString('pt-BR'))}</td><td>${esc(a.name || 'sistema')}</td><td>${esc(a.action)}</td><td>${P(a.target) ? `<button type="button" class="link" data-go="${esc(a.target)}">${esc(P(a.target).name)}</button>` : esc(a.target || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nada registrado ainda.</p>';
  } catch (err) { box.textContent = err.message; }
}
const ROLE = { admin: 'Administrador', member: 'Pode adicionar', viewer: 'Ver e deixar lembranças' };
async function loadAdmin() {
  $('#aErr').textContent = '';
  const d = await api('/api/admin');
  $('#users').innerHTML = `<table class="tbl"><thead><tr><th>Nome</th><th>E-mail</th><th>Acesso</th><th></th></tr></thead><tbody>${d.users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.id === me.id ? ROLE[u.role] : `<select data-role="${u.id}">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}"${k === u.role ? ' selected' : ''}>${v}</option>`).join('')}</select>`}</td><td>${u.id === me.id ? 'você' : `<button type="button" class="link" data-reset="${u.id}">link de nova senha</button> <button type="button" class="link" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'bloquear' : 'desbloquear'}</button>`}</td></tr>`).join('')}</tbody></table>`;
  const open = d.invites.filter(i => !i.usedBy && i.expires > Date.now());
  $('#invites').innerHTML = open.length ? `<p class="note">Convites ainda não usados (valem 30 dias):</p><table class="tbl"><tbody>${open.map(i => `<tr><td>${esc(i.label || 'sem nome')}</td><td>${ROLE[i.role]}</td><td><button type="button" class="link" data-copy="${esc(i.token)}">copiar link</button> <button type="button" class="link" data-revoke="${esc(i.token)}">cancelar</button></td></tr>`).join('')}</tbody></table>` : '';
}
$('#adminBtn').addEventListener('click', async () => { $('#newInvite').hidden = true; $('#adlg').showModal(); try { await loadAdmin(); } catch (err) { $('#aErr').textContent = err.message; } });
const inviteUrl = t => `${location.origin}/convite/${t}`;
async function copy(text, btn) { try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = 'copiado'; setTimeout(() => btn.textContent = t, 2000); } } catch {} }
$('#iform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try {
    const r = await api('/api/admin/invites', { method: 'POST', body: { label: f.elements.label.value, role: f.elements.role.value } });
    const url = inviteUrl(r.token), box = $('#newInvite');
    box.hidden = false;
    box.innerHTML = `<b>Link do convite</b> (mande por WhatsApp ou e-mail; vale 30 dias e serve para uma pessoa):<br><span>${esc(url)}</span><br><button type="button" class="primary" data-copy="${esc(r.token)}">Copiar link</button>`;
    f.reset(); await loadAdmin();
  } catch (err) { $('#aErr').textContent = err.message; }
});
$('#adlg').addEventListener('click', async e => {
  const c = e.target.closest('[data-copy]'); if (c) { copy(inviteUrl(c.dataset.copy), c); return; }
  const r = e.target.closest('[data-revoke]'); if (r) { await api('/api/admin/invites/' + encodeURIComponent(r.dataset.revoke), { method: 'DELETE' }); loadAdmin(); return; }
  const rs = e.target.closest('[data-reset]'); if (rs) {
    try { const r = await api('/api/admin/users/' + rs.dataset.reset + '/reset', { method: 'POST' }); const url = `${location.origin}/senha/${r.token}`, box = $('#newInvite'); box.hidden = false;
      box.innerHTML = `<b>Link de nova senha</b> (vale 3 dias; mande só para a própria pessoa):<br><span>${esc(url)}</span><br><button type="button" class="primary" data-copyurl="${esc(url)}">Copiar link</button>`; box.scrollIntoView({ block: 'nearest' }); }
    catch (err) { $('#aErr').textContent = err.message; } return; }
  const cu = e.target.closest('[data-copyurl]'); if (cu) { copy(cu.dataset.copyurl, cu); return; }
  const sh = e.target.closest('#showActivity'); if (sh) { loadActivity(); return; }
  const a = e.target.closest('[data-active]'); if (a) { await api('/api/admin/users/' + a.dataset.active, { method: 'PUT', body: { active: a.dataset.to === '1' } }).catch(err => $('#aErr').textContent = err.message); loadAdmin(); }
});
$('#adlg').addEventListener('change', async e => {
  const s = e.target.closest('[data-role]'); if (!s) return;
  try { await api('/api/admin/users/' + s.dataset.role, { method: 'PUT', body: { role: s.value } }); } catch (err) { $('#aErr').textContent = err.message; }
});
$('#impform').addEventListener('submit', async e => {
  e.preventDefault(); const file = e.target.elements.file.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await api('/api/admin/import', { method: 'POST', body: data });
    $('#aErr').textContent = `Importado: ${r.added} novas pessoas, ${r.updated} atualizadas.`;
    e.target.reset(); await load();
  } catch (err) { $('#aErr').textContent = err instanceof SyntaxError ? 'O arquivo não é um JSON válido.' : err.message; }
});

function renderAll() {
  if (!P(focus)) { const h = decodeURIComponent(location.hash.slice(1)); focus = P(h) ? h : P(defaultPerson) ? defaultPerson : (Object.values(people).find(p => p.createdBy === me?.id)?.id || Object.keys(people)[0] || null); }
  drawChart(); renderRecord(); renderIndex();
}
addEventListener('hashchange', () => { const h = decodeURIComponent(location.hash.slice(1)); if (P(h) && h !== focus) setFocus(h); });

start().catch(() => { $('#auth').hidden = false; $('#authErr').textContent = 'Não foi possível conectar ao servidor.'; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
