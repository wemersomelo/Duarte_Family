'use strict';
(() => {
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const kinOpen = new Set(); // seções de tios/primos que a pessoa deixou abertas
let me = null, people = {}, notes = [], files = [], media = [], relatoLinks = [], crossLinks = {}, userNames = {}, focus = null, editing = null, ctx = {};
const P = id => (id && people[id]) ? people[id] : null;
const canWrite = () => !!me && (me.role === 'member' || me.role === 'admin');
const isGuest = () => !!me && me.role === 'guest';
const canContribute = () => !!me && !isGuest();
const isSelfP = p => !!p && !!me && !!me.personId && me.personId === p.id;
// Quem cadastrou perde a edição quando a própria pessoa assume a ficha (conta ligada e confirmada).
const ownsP = p => !!p && canWrite() && (me.role === 'admin' || (p.createdBy != null && p.createdBy === me.id && (!p.managedBy || p.managedBy === me.id)));
// Editar: quem criou, o administrador, a própria pessoa e, se já faleceu, os parentes diretos (kinEdit vem do servidor).
const canEdit = p => ownsP(p) || (isSelfP(p) && !isGuest()) || (!!p && !!p.kinEdit);
const y4 = s => (String(s || '').match(/\d{4}/) || [''])[0];
const isDead = p => !!(p.death || p.deathPlace || (y4(p.birth) && +y4(p.birth) <= 1915));
const yr = p => { const b = y4(p.birth), d = y4(p.death), out = []; if (b) out.push('★\uFE0E ' + b); if (isDead(p)) out.push(d ? '✝\uFE0E ' + d : '✝\uFE0E'); return out.join('  ') || '—'; };
const dn = (p, n = p.name) => n + (isDead(p) ? '\u00a0✝\uFE0E' : '');
// Primeiro nome: o campo próprio ou a primeira palavra do nome completo.
const firstName = p => (p.given || '').trim() || String(p.name).split(' ')[0];
// Nome curto: primeiro nome + último sobrenome (ex.: Maria Wilsa Duarte).
const shortName = p => { const f = firstName(p), w = String(p.name).trim().split(/\s+/), last = w[w.length - 1]; return w.length > 1 && !f.split(' ').includes(last) ? f + ' ' + last : f; };
// Apelidos de parentesco dependem de quem vê: "Vó Floripes" só para os netos, "Tia Fulô" só para os sobrinhos.
// Para os outros, mostra o apelido sem o parentesco ("Floripes", "Fulô"). Padrinho, Madrinha etc. ficam sempre.
const GRAN = /^(av[óô]|v[óô]|vov[óô])\s+/i, UNCLE = /^(tio|tia|titio|titia)\s+/i;
function isGrandOf(p, r) { return [r.fatherId, r.motherId].some(id => P(id) && (P(id).fatherId === p.id || P(id).motherId === p.id)); }
function isUncleOf(p, r) {
  const parents = [r.fatherId, r.motherId].filter(id => P(id));
  const sibs = new Set(parents.flatMap(id => siblingsOf(id).map(q => q.id)));
  return sibs.has(p.id) || [...sibs].some(id => spousesOf(id).includes(p.id));
}
function nickOf(p) {
  const n = String(p.nick || '').trim(), g = n.match(GRAN), u = n.match(UNCLE), m = g || u; if (!m) return n;
  const r = P(rootPerson());
  if (r && (g ? isGrandOf(p, r) : isUncleOf(p, r))) return n;
  const rest = n.slice(m[0].length); return norm(rest) === norm(firstName(p)) ? '' : rest;
}
const callName = p => nickOf(p) || firstName(p);
const byName = (a, b) => norm(a.name).localeCompare(norm(b.name));
const childrenOf = id => Object.values(people).filter(p => p.fatherId === id || p.motherId === id);
const spousesOf = id => {
  const s = new Set(), p = P(id); if (p?.spouseId && P(p.spouseId)) s.add(p.spouseId);
  for (const q of Object.values(people)) if (q.spouseId === id) s.add(q.id);
  for (const c of childrenOf(id)) { const o = c.fatherId === id ? c.motherId : c.fatherId; if (o && P(o)) s.add(o); }
  s.delete(id); return [...s];
};
// Pessoa de quem está vendo: a ligada à conta; visitantes e contas sem ligação começam pela pessoa do administrador.
const myPerson = () => (me && P(me.personId)) ? me.personId : '';
const rootPerson = () => myPerson() || (P(defaultPerson) ? defaultPerson : '');
// Família de alguém: antepassados, todos os descendentes deles (irmãos, tios, primos, filhos, netos) e os cônjuges.
function familyOf(root) {
  if (!P(root)) return null;
  const kids = {};
  for (const q of Object.values(people)) for (const par of [q.fatherId, q.motherId]) if (par) (kids[par] ||= []).push(q.id);
  const anc = new Set(), st = [root];
  while (st.length) { const id = st.pop(); if (!id || anc.has(id) || !P(id)) continue; anc.add(id); st.push(P(id).fatherId, P(id).motherId); }
  const fam = new Set(), q = [...anc];
  while (q.length) { const id = q.pop(); if (fam.has(id)) continue; fam.add(id); q.push(...(kids[id] || [])); }
  for (const id of [...fam]) for (const sp of spousesOf(id)) fam.add(sp);
  return fam;
}
let showAll = false;
const siblingsOf = id => { const p = P(id); if (!p) return []; return Object.values(people).filter(q => q.id !== id && ((p.fatherId && q.fatherId === p.fatherId) || (p.motherId && q.motherId === p.motherId))); };
const who = id => id == null ? 'Registro inicial' : (userNames[id] || 'alguém da família');
const fmtDate = s => { try { return new Date(s).toLocaleDateString('pt-BR'); } catch { return ''; } };

// Livro por código (ex.: /K7P2Q): tudo do livro fica debaixo desse endereço.
const BASE = (m => m && /^\/[A-Z0-9]{4,8}$/.test(m.content) ? m.content : '')(document.querySelector('meta[name=book-base]'));
const PATH = () => location.pathname.slice(BASE.length) || '/';
async function api(path, opts = {}) {
  if (path.startsWith('/api')) path = BASE + path;
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers = { 'Content-Type': 'application/json', ...(o.headers || {}) }; o.body = JSON.stringify(o.body); }
  const r = await fetch(path, o);
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(data.error || 'Algo deu errado.'); e.status = r.status; e.code = data.code; throw e; }
  return data;
}

/* ---------- entrar / convite / instalação ---------- */
let authMode = 'login', codeSent = false, codeLogin = false, isBook = false, inviteToken = null, resetToken = null, familyName = '', familySuggestion = '', defaultPerson = '';
function showAuth(mode, info = {}) {
  authMode = mode;
  $('#main').hidden = true; $('#auth').hidden = false;
  $('#authFamily').textContent = familyName;
  const f = $('#authForm');
  $('#fName').hidden = mode === 'login' || mode === 'reset';
  f.querySelector('input[name=email]').closest('label').hidden = mode === 'reset';
  f.elements.password.closest('label').hidden = mode === 'code' || mode === 'forgot'; f.elements.password.required = mode !== 'code' && mode !== 'forgot';
  if (mode !== 'code') codeSent = false;
  $('#fCode').hidden = !(mode === 'code' && codeSent); f.elements.code.required = mode === 'code' && codeSent;
  $('#codeSwitch').hidden = !(codeLogin && ['login', 'code', 'forgot'].includes(mode));
  $('#forgotBtn').textContent = mode === 'forgot' ? 'Voltar para entrar com senha' : 'Esqueci a senha';
  $('#codeBtn').textContent = mode === 'code' ? 'Entrar com e-mail e senha' : 'Entrar com um código por e-mail, sem senha';
  $('#bookCodeForm').hidden = isBook || mode !== 'login';
  if (mode === 'setup') { const k = new URLSearchParams(location.search).get('chave'); if (k) f.elements.setupKey.value = k; }
  f.elements.email.required = mode !== 'reset';
  $('#fKey').hidden = mode !== 'setup';
  $('#fFamily').hidden = mode !== 'setup'; if (mode === 'setup' && !$('#authForm').elements.family.value) $('#authForm').elements.family.value = familySuggestion;
  $('#fMail').hidden = mode !== 'invite';
  $('#fTerms').hidden = !(mode === 'invite' || mode === 'setup'); $('#fAdult').hidden = $('#fTerms').hidden; $('#authForm').elements.adult.required = !$('#fAdult').hidden; $('#authForm').elements.terms.required = mode === 'invite' || mode === 'setup';
  f.elements.name.required = !['login', 'reset', 'code', 'forgot'].includes(mode);
  f.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authBtn').textContent = mode === 'forgot' ? 'Mandar o link' : mode === 'code' ? (codeSent ? 'Entrar' : 'Mandar o código') : mode === 'login' ? 'Entrar' : mode === 'reset' ? 'Salvar nova senha' : 'Criar conta';
  $('#authSub').textContent = mode === 'reset' ? `Olá, ${info.name || ''}. Escolha uma senha nova (mínimo 8 caracteres).` : mode === 'setup' ? 'Primeira vez: crie a conta do administrador.' :
    mode === 'invite' ? (info.personName ? `Olá! Você já está na árvore como ${info.personName}. Só falta criar uma senha para ${info.role === 'viewer' ? 'ver' : 'ver e completar'} a árvore da família.` : `Você foi convidado${info.label ? ' (' + info.label + ')' : ''}. Crie sua conta para ${info.role === 'viewer' ? 'ver' : 'ver e completar'} a árvore da família.`) :
    mode === 'forgot' ? 'Escreva o seu e-mail. Mandamos um link para você criar uma senha nova (vale 1 hora).' :
    mode === 'code' ? (codeSent ? 'Se o e-mail tiver conta aqui, o código chegou nele (olhe também no spam). Ele vale 10 minutos.' : 'Escreva o seu e-mail. Mandamos um código de 6 números para você entrar.') :
    'Entre com seu e-mail e senha.';
  $('#authHelp').hidden = !['login', 'code'].includes(mode);
  $('#authNew').hidden = mode !== 'login' || isBook;
  $('#authErr').textContent = '';
}
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, body = { name: f.elements.name.value, email: f.elements.email.value, password: f.elements.password.value, setupKey: f.elements.setupKey.value, family: f.elements.family.value, terms: f.elements.terms.checked, adult: f.elements.adult.checked, emailUpdates: f.elements.emailUpdates.checked };
  $('#authErr').textContent = '';
  try {
    if (authMode === 'forgot') { await api('/api/forgot', { method: 'POST', body: { email: body.email } }); $('#authSub').textContent = 'Se o e-mail tiver conta aqui, o link chegou nele. Olhe também no spam.'; return; }
    if (authMode === 'code' && !codeSent) { await api('/api/login/code', { method: 'POST', body: { email: body.email } }); codeSent = true; showAuth('code'); f.elements.code.focus(); return; }
    if (authMode === 'code') await api('/api/login/code/verify', { method: 'POST', body: { email: body.email, code: f.elements.code.value } });
    else if (authMode === 'login') await api('/api/login', { method: 'POST', body });
    else if (authMode === 'setup') await api('/api/setup', { method: 'POST', body });
    else if (authMode === 'reset') await api('/api/reset/' + encodeURIComponent(resetToken), { method: 'POST', body: { password: body.password } });
    else await api('/api/invites/' + encodeURIComponent(inviteToken), { method: 'POST', body });
    if (authMode === 'invite' || authMode === 'reset' || authMode === 'setup') history.replaceState(null, '', BASE + '/');
    start();
  } catch (err) { $('#authErr').textContent = err.message; }
});

$('#forgotBtn').addEventListener('click', () => { const em = $('#authForm').elements.email.value; showAuth(authMode === 'forgot' ? 'login' : 'forgot'); $('#authForm').elements.email.value = em; });
$('#codeBtn').addEventListener('click', () => { const em = $('#authForm').elements.email.value; showAuth(authMode === 'code' ? 'login' : 'code'); $('#authForm').elements.email.value = em; });
$('#bookCodeForm').addEventListener('submit', e => {
  e.preventDefault(); const c = e.target.elements.code.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length === 5) location.href = '/' + c; else $('#authErr').textContent = 'O código do livro tem 5 letras e números (ex.: K7P2Q).';
});

// Aviso para quem pediu acesso neste aparelho.
function showRequest(r) {
  const n = $('#notice'), msg = !r ? '' :
    r.status === 'pending' ? 'Seu pedido para participar está aguardando a aprovação do administrador.' :
    r.status === 'approved' ? (r.mailed ? `<b>Seu pedido foi aprovado!</b> Enviamos um e-mail para ${esc(r.email)}. Abra e toque no link para criar a sua senha. Se não encontrar, olhe na pasta de spam.` : '<b>Seu pedido foi aprovado!</b> O administrador vai te mandar o link para criar a sua senha.') :
    r.status === 'rejected' ? 'Seu pedido não foi aprovado. Se achar que é um engano, fale com o administrador.' :
    r.status === 'cancelled' ? 'Seu pedido foi cancelado. Se achar que é um engano, fale com o administrador.' : '';
  n.innerHTML = msg; n.hidden = !msg;
}
async function start() {
  const st = await api('/api/status');
  if (st.hubUrl) $('#comecarLink').href = st.hubUrl.replace(/\/$/, '') + '/comecar';
  codeLogin = !!st.codeLogin; isBook = !!st.book;
  familyName = st.familyName || familyName; familySuggestion = st.familySuggestion || ''; defaultPerson = st.defaultPerson || '';
  showRequest(st.request);
  document.title = (st.brand ? st.brand.name : document.title.split(' · ')[0]) + ' · ' + familyName; $('#hsub').textContent = familyName;
  const rm = PATH().match(/^\/senha\/([\w-]+)/);
  if (rm) {
    resetToken = rm[1];
    try { const info = await api('/api/reset/' + encodeURIComponent(resetToken)); return showAuth('reset', info); }
    catch (err) { history.replaceState(null, '', BASE + '/'); showAuth('login'); $('#authErr').textContent = err.message; return; }
  }
  const m = PATH().match(/^\/convite\/([\w-]+)/);
  if (m && !st.user) {
    inviteToken = m[1];
    try { const info = await api('/api/invites/' + encodeURIComponent(inviteToken)); showAuth('invite', info); const em = $('#authForm').elements.email; em.value = info.email || ''; em.readOnly = !!info.email; if (info.name) $('#authForm').elements.name.value = info.name; showRequest(null); return; }
    catch (err) { showAuth('login'); $('#authErr').textContent = err.message; return; }
  }
  if (st.needsSetup) return showAuth('setup');
  if (!st.user) { showAuth('login'); if (/livro=naoencontrado/.test(location.search)) { $('#authErr').textContent = 'Não achamos um livro com esse código. Confira as letras e os números.'; history.replaceState(null, '', '/'); }
    if (/link=invalido/.test(location.search)) { $('#authErr').textContent = 'Este link da família não funciona mais. Peça o link novo a quem te enviou.'; history.replaceState(null, '', BASE + '/'); } return; }
  if (m) history.replaceState(null, '', BASE + '/');
  me = st.user;
  $('#auth').hidden = true; $('#main').hidden = false;
  if (st.needsTerms && !isGuest()) $('#termsdlg').showModal();
  $('#whoami').textContent = me.name;
  $('#adminBtn').hidden = me.role !== 'admin';
  $('#pwBtn').hidden = isGuest();
  $('#notifBtn').hidden = isGuest();
  if (!isGuest()) loadNotifCount();
  $('#askBtn').hidden = !isGuest();
  { const n = (st.pendingRequests || 0) + (st.inboxNew || 0) + (st.suggestions || 0) + (st.bookRequests || 0) + (st.crossLinks || 0) + (st.reports || 0); $('#adminBtn').textContent = n ? `Administrar (${n})` : 'Administrar'; }
  $('#how').hidden = isGuest();
  $('#addBtn').hidden = !canWrite();
  await load();
}

async function load() {
  try {
    const d = await api('/api/tree');
    people = Object.fromEntries(d.people.map(p => [p.id, p]));
    notes = d.notes; files = d.files; media = d.media || []; relatoLinks = d.relatoLinks || []; crossLinks = d.crossLinks || {};
    userNames = Object.fromEntries(d.users.map(u => [u.id, u.name]));
    me = d.me;
    const n = d.people.length;
    $('#status').textContent = `${n} pessoas na árvore. ` + (isGuest() ? 'Você está vendo pelo link da família: das pessoas vivas aparecem só o nome e as ligações. Para deixar lembranças ou fotos, peça um convite ao administrador.' : canWrite() ? 'Você pode adicionar pessoas, informações e documentos; só altera o que você mesmo adicionou.' : 'Você pode ver a árvore e deixar lembranças, fotos, vídeos e links.');
    renderAll();
  } catch (err) {
    if (err.status === 401) return start();
    $('#status').textContent = 'Não foi possível carregar a árvore: ' + err.message;
  }
}

// Caminho percorrido: o botão "Voltar" e o voltar do celular desfazem um passo de cada vez (usam o mesmo histórico).
const trail = [];
let firstFocus = null;
function setFocus(id, back) {
  if (!P(id)) return;
  if (!firstFocus) firstFocus = focus || id;
  if (!back && focus && focus !== id) { trail.push(focus); if (trail.length > 100) trail.shift(); history.pushState({ arvore: true }, '', '#' + id); }
  else if (location.hash !== '#' + id) history.replaceState(history.state, '', '#' + id);
  const changed = focus && focus !== id;
  focus = id;
  smoothRender(changed);
}
// Troca de pessoa com transição suave: os cartões que continuam na árvore deslizam para o lugar novo
// (a mãe sobe para o topo, os avós dela aparecem embaixo) e a ficha se renova com um leve esmaecer.
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function smoothRender(changed) {
  if (!changed || reduceMotion()) { renderAll(); return; }
  if (document.startViewTransition) { document.startViewTransition(() => renderAll()); return; }
  renderAll();
  for (const el of [$('#fig'), $('#slip'), $('#kin')]) { el.classList.remove('fadein'); void el.offsetWidth; el.classList.add('fadein'); }
}
function goBack() {
  if (history.state && history.state.arvore) { history.back(); return true; } // o popstate faz o resto
  while (trail.length) { const id = trail.pop(); if (P(id) && id !== focus) { setFocus(id, true); return true; } }
  return false;
}
function go(id) { setFocus(id); $('#fig').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
addEventListener('popstate', () => {
  const h = decodeURIComponent(location.hash.slice(1)), id = P(h) ? h : firstFocus;
  if (!P(id) || id === focus) return;
  if (trail[trail.length - 1] === id) trail.pop();
  setFocus(id, true);
});

/* ---------- gráfico de antepassados ---------- */
const fig = $('#fig');
const isMobile = () => innerWidth < 700;
// Árvore de cima para baixo: a pessoa procurada no topo e os antepassados descendo.
// Celular: sempre 3 gerações. Computador: 3, 4 ou 5.
const vtName = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^(\d)/, '_$1');
function drawChart() {
  const mob = isMobile();
  $('#gensWrap').hidden = mob;
  const G = mob ? 3 : +$('#gens').value, p = P(focus);
  if (!p) { fig.innerHTML = '<p class="none" style="padding:20px 0">Nenhuma pessoa selecionada.</p>'; fig.style.cssText = ''; return; }
  $('#chartTitle').textContent = 'Antepassados de ' + callName(p);
  const slots = 2 ** (G - 1), M = mob ? 4 : 8, GX = mob ? 6 : 10;
  const avail = (fig.parentElement.clientWidth || innerWidth) - 2;
  const CW = Math.max(mob ? 78 : 104, Math.min(200, Math.floor((avail - 2 * M) / slots) - GX));
  const CH = mob ? 90 : 78, RH = CH + (mob ? 46 : 54), TOP = mob ? 4 : 22;
  const PW = Math.min(avail - 2 * M, mob ? 230 : 300), PH = (mob ? 90 : 92) + (p.photoFileId ? 44 : 0);
  const W = Math.max(slots * (CW + GX) + 2 * M, avail);
  const rowY = g => g === 0 ? TOP : TOP + PH + (mob ? 46 : 54) + (g - 1) * RH;
  const H = rowY(G - 1) + CH + 12;
  fig.style.cssText = `--cw:${CW}px;width:${W}px;height:${H}px`;
  const labels = ['', 'Pais', 'Avós', 'Bisavós', 'Tataravós'];
  let html = '', lines = ''; const vtSeen = new Set();
  if (!mob) for (let g = 1; g < G; g++) html += `<div class="gen" style="left:${M}px;top:${rowY(g) - 20}px">${labels[g]}</div>`;
  const place = (id, g, i, childId, role, cx0, cy0) => {
    const n = 2 ** g, w = g === 0 ? PW : CW, h = g === 0 ? PH : CH;
    const cx = g === 0 ? W / 2 : (i + .5) * (W - 2 * M) / n + M, y = rowY(g), x = cx - w / 2;
    const q = P(id); if (!q && !(childId && canWrite())) return;
    if (g > 0) { const mid = cy0 + (y - cy0) / 2; lines += `<path d="M${cx0} ${cy0}V${mid}H${cx}V${y}" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>`; }
    if (q) {
      const av = q.photoFileId ? `<img class="av" src="${BASE}/api/files/${encodeURIComponent(q.photoFileId)}" alt="" loading="lazy">` : '';
      const meta = q.living ? '—' : [yr(q), g === 0 ? q.birthPlace : ''].filter(Boolean).join(' · ');
      // Com apelido: apelido em destaque e o nome na segunda linha. Sem apelido: primeiro nome + sobrenome (completo no computador).
      const full = mob && g > 0 ? shortName(q) : (g === 0 || !mob ? q.name : shortName(q));
      const nk = nickOf(q), nm = nk || full, sub = nk ? (mob ? shortName(q) : q.name) : '';
      const mt = mob && g > 0 ? meta.replace(/([★✝]\uFE0E?) /g, '$1') : meta;
      const vt = vtSeen.has(q.id) ? '' : (vtSeen.add(q.id), `view-transition-name:p-${vtName(q.id)};`);
      html += `<button type="button" class="card td${g === 0 ? ' focus main' : ''}" data-id="${esc(q.id)}" style="${vt}left:${x}px;top:${y}px;width:${w}px;height:${h}px" title="${esc(q.name)}">${av}<span class="nm">${esc(nm)}${isDead(q) ? '<span class="x">\u00a0✝\uFE0E</span>' : ''}</span>${sub ? `<span class="fn">${esc(sub)}</span>` : ''}${mt ? `<span class="meta">${esc(mt)}</span>` : ''}</button>`;
      if (g < G - 1) { place(q.fatherId, g + 1, i * 2, q.id, 'father', cx, y + h); place(q.motherId, g + 1, i * 2 + 1, q.id, 'mother', cx, y + h); }
    } else {
      html += `<button type="button" class="card td empty" data-add="${role}" data-child="${esc(childId)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">+ ${role === 'father' ? 'Pai' : 'Mãe'}</button>`;
    }
  };
  place(focus, 0, 0, null, null, 0, 0);
  fig.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" style="color:var(--ink)">${lines}</svg>` + html;
  const sc = fig.parentElement; sc.scrollLeft = (W - sc.clientWidth) / 2;
}
fig.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.id) { if (b.dataset.id === focus) $('#slip').scrollIntoView({ behavior: 'smooth', block: 'start' }); else setFocus(b.dataset.id); }
  else if (b.dataset.add) openForm(null, { parentOf: b.dataset.child, parentRole: b.dataset.add });
});
$('#gens').addEventListener('change', drawChart);
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawChart, 150); });

/* ---------- ficha da pessoa ---------- */
const chip = q => `<button type="button" class="chip" data-go="${esc(q.id)}">${esc(dn(q, nickOf(q) ? q.name + ' (' + nickOf(q) + ')' : q.name))}</button>`;
const chips = list => list.length ? `<div class="chips">${list.sort(byName).map(chip).join('')}</div>` : '<p class="none">Ninguém registrado ainda.</p>';
// Selo de ligação com outro livro: pedido pendente, ou confirmado (com a foto pública, se liberada,
// e um link para ver a subida de pais e avós, se a outra família liberou isso também).
function crossBadge(p) {
  const xl = crossLinks[p.id]; if (!xl) return '';
  const fam = esc(xl.other.family || xl.other.book || 'outra família');
  if (xl.status === 'pending') return `<p class="hint">Pedido de ligação enviado para o livro da família ${fam}: aguardando confirmação do administrador de lá.</p>`;
  return `<p class="note">Esta pessoa também está na árvore da família <b>${fam}</b>${xl.other.name ? ` (lá: ${esc(xl.other.name)})` : ''}.${xl.other.photoUrl ? ` <img src="${esc(xl.other.photoUrl)}" alt="" style="height:28px;width:28px;border-radius:50%;object-fit:cover;vertical-align:middle">` : ''}${xl.other.ascendPublic ? ` <button type="button" class="link" data-xlascend="${esc(p.id)}">ver também os antepassados dessa família</button>` : ''}</p><div id="xlAscendBox"></div>`;
}
function ascendHtml(a) {
  if (!a) return '';
  const line = [a.name, a.birth, a.birthPlace].filter(Boolean).join(' · ');
  return `<li>${esc(line)}${(a.father || a.mother) ? `<ul>${ascendHtml(a.father)}${ascendHtml(a.mother)}</ul>` : ''}</li>`;
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-xlascend]'); if (!b) return;
  const box = $('#xlAscendBox'); box.innerHTML = 'Buscando…';
  try { const r = await api(`/api/cross-link/${encodeURIComponent(b.dataset.xlascend)}/ascendancy`); box.innerHTML = `<ul class="notes">${ascendHtml(r.ascendancy)}</ul>`; }
  catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
});
function renderRecord() {
  const p = P(focus), slip = $('#slip'), kin = $('#kin');
  if (!p) { slip.innerHTML = '<p class="none">Procure ou escolha uma pessoa na lista abaixo.</p>'; kin.innerHTML = ''; return; }
  const row = (k, v, plain) => v ? `<dt>${k}</dt><dd${plain ? ' class="plain"' : ''}>${esc(v)}</dd>` : '';
  const pn = notes.filter(n => n.personId === p.id);
  const pf = files.filter(f => f.personId === p.id && !f.profile); // a foto de perfil fica só na bolinha
  const ed = canEdit(p);
  const prel = relatoLinks.filter(r => r.personId === p.id);
  // Casamento: guardado na ficha da pessoa ou na do cônjuge.
  const sp = P(p.spouseId), back = sp && (!sp.spouseId || sp.spouseId === p.id) ? sp : null;
  const mD = p.marriage || back?.marriage || '', mP = p.marriagePlace || back?.marriagePlace || '';
  const marr = (mD || mP) ? [mD, mP].filter(Boolean).join(' · ') + (sp ? ' (com ' + sp.name + ')' : '') : '';
  const mine = x => !!me && !isGuest() && (me.role === 'admin' || (canWrite() && x.createdBy === me.id) || (!!p.managedBy && p.managedBy === me.id));
  const info = pn.filter(n => n.kind !== 'memory'), mem = pn.filter(n => n.kind === 'memory');
  const pm = media.filter(m => m.personId === p.id);
  const isImg = f => /^image\/(jpeg|png|webp)$/.test(f.mime);
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const kindOf = u => /youtu\.?be/.test(u) ? 'YouTube' : /drive\.google|photos\.google/.test(u) ? 'Google' : /instagram/.test(u) ? 'Instagram' : /facebook|fb\.watch/.test(u) ? 'Facebook' : /vimeo/.test(u) ? 'Vimeo' : /whatsapp/.test(u) ? 'WhatsApp' : 'Link';
  const rep = (k, id) => me && !isGuest() ? ` · <button type="button" class="link" data-report="${k}" data-target="${esc(id)}">denunciar</button>` : '';
  const noteList = list => list.length ? `<ul class="notes">${list.map(n => `<li>${esc(n.text)}<small>${esc(who(n.createdBy))}, ${esc(fmtDate(n.createdAt))}${mine(n) ? ` · <button type="button" class="link" data-rmnote="${n.id}">remover</button>` : ''}${n.createdBy !== me?.id ? rep('note', n.id) : ''}</small></li>`).join('')}</ul>` : '';
  const initials = (nickOf(p) || p.name || '?').replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(w => w.length > 2 || /^[A-ZÀ-Ú]/.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const canPhoto = !!ed;
  const avatar = `<div class="avatar${p.photoFileId ? ' has' : ''}">${p.photoFileId ? `<button type="button" class="pphoto" data-view="${esc(p.photoFileId)}" aria-label="Ampliar a foto"><img src="${BASE}/api/files/${encodeURIComponent(p.photoFileId)}" alt="Foto de ${esc(p.name)}"></button>` : canPhoto ? `<label class="pphoto empty" aria-label="Pôr foto de perfil"><span>${esc(initials)}</span><input type="file" id="photoinput-empty-${esc(p.id)}" accept="image/*" data-profilephoto hidden></label>` : `<div class="pphoto empty"><span>${esc(initials)}</span></div>`}${canPhoto ? `<label class="pcam" title="${p.photoFileId ? 'Trocar a foto de perfil' : 'Pôr foto de perfil'}" aria-label="${p.photoFileId ? 'Trocar a foto de perfil' : 'Pôr foto de perfil'}">+<input type="file" id="photoinput-cam-${esc(p.id)}" accept="image/*" data-profilephoto hidden></label>` : ''}</div>`;
  const photoToggle = canPhoto && p.photoFileId ? `<p class="note">Foto de perfil: ${p.photoPublic ? '<b>pública</b> (pode aparecer para outra família, se descobrirem parentesco)' : '<b>só para esta família</b>'} · <button type="button" class="link" data-act="photopub" data-to="${p.photoPublic ? 0 : 1}">${p.photoPublic ? 'tornar só desta família' : 'tornar pública'}</button></p>` : '';
  const ascendToggle = ed ? `<p class="note">Pais e avós: ${p.ascendPublic ? '<b>visíveis para quem descer dela em outro livro</b>, se um dia ligarem os livros' : '<b>só para esta família</b>'} · <button type="button" class="link" data-act="ascendpub" data-to="${p.ascendPublic ? 0 : 1}">${p.ascendPublic ? 'tornar só desta família' : 'liberar para descendentes de outro livro'}</button></p>` : '';
  slip.innerHTML = `<div class="phead">${avatar}<div><h3 class="person">${esc(dn(p, nickOf(p) || p.name))}</h3><p class="nick">${nickOf(p) ? esc(p.name) : '&nbsp;'}</p></div></div>
  ${photoToggle}${ascendToggle}
  <dl>${row('Nascimento', p.birth)}${row('Local', p.birthPlace)}${row('Casamento', marr)}${row('Falecimento', p.death)}${row('Local', p.deathPlace)}${row('Descendentes', DESC[p.descendants])}${row('Cor/raça', COLOR[p.color])}${row('Origem/etnia', p.origin)}${row('Histórias', p.notes, 1)}${row('Fontes', p.sources, 1)}</dl>
  ${me && !isGuest() ? (myPerson() === p.id ? '<p class="mine">Esta pessoa é você. Para corrigir as suas datas, toque em <b>Editar meus dados</b>. <button type="button" class="link" data-act="notme">não sou eu</button></p>' : !myPerson() ? '<div class="actions small"><button type="button" class="primary" data-act="isme">Esta pessoa sou eu</button></div>' : '') : ''}
  ${p.restricted ? `<p class="hint">${p.private ? 'Esta pessoa pediu para ocultar os dados dela.' : 'Esta pessoa é menor de idade.'} Você vê só o nome e as ligações de família.</p>` : ''}
  ${me && !isGuest() && (isSelfP(p) || me.role === 'admin') && !isDead(p) ? `<p class="note">${p.private ? '<b>Dados ocultos:</b> os outros membros veem só o nome e as ligações.' : 'Os membros da família veem os dados desta ficha.'} <button type="button" class="link" data-act="private" data-to="${p.private ? 0 : 1}">${p.private ? 'mostrar de novo' : (isSelfP(p) ? 'ocultar meus dados' : 'ocultar os dados')}</button></p>` : ''}
  ${!p.restricted && !p.birth && !p.birthPlace && !p.notes ? '<p class="none">Ainda faltam informações sobre esta pessoa. Se você sabe algo, acrescente.</p>' : ''}
  ${isGuest() ? '' : `<p class="by">Registrado por ${esc(who(p.createdBy))}${p.managedBy ? ` · ficha administrada pela própria pessoa${p.managedBy === me.id ? ' (você)' : ''}` : ''}</p>`}
  ${crossBadge(p)}
  ${p.living ? '<p class="none">Dados de pessoas vivas (datas, lugares, fotos e lembranças) ficam visíveis só para quem tem convite.</p>' : ''}
  ${canContribute() ? `<div class="actions">${canWrite() ? '<button type="button" class="primary" data-act="note">+ Acrescentar informação</button>' : ''}<button type="button"${canWrite() ? '' : ' class="primary"'} data-act="memory">+ Deixar uma lembrança</button><button type="button" data-act="files">+ Fotos e documentos</button><button type="button" data-act="link">+ Vídeo ou link</button></div>` : ''}
  ${!ed && isDead(p) && canContribute() && !isGuest() ? '<div class="actions small"><button type="button" data-act="kinask">Corrigir dados</button></div><div id="kinMsg"></div>' : ''}
  ${canWrite() || ed ? `<div class="actions small">${ed ? `<button type="button"${isSelfP(p) ? ' class="primary"' : ''} data-act="edit">${isSelfP(p) ? 'Editar meus dados' : 'Editar'}</button>` : ''}${canWrite() ? (p.fatherId || p.motherId ? '<button type="button" data-act="sibling">+ Irmão ou irmã</button>' : '') + '<button type="button" data-act="child">+ Filho ou filha</button><button type="button" data-act="spouse">+ Cônjuge</button>' : ''}${canWrite() ? '<button type="button" data-act="crosslink">Esta pessoa está em outro livro?</button>' : ''}${ownsP(p) ? '<button type="button" class="danger" data-act="del">Excluir</button>' : ''}</div>` : ''}
  ${p.living ? '' : `<h4>Fotos e documentos (${pf.length})</h4>
  ${pf.length ? `<div class="docs">${pf.map(f => `<div class="doc${f.id === p.photoFileId ? ' main' : ''}"><button type="button" class="thumb${f.mime === 'application/pdf' ? ' pdf' : ''}" data-view="${esc(f.id)}" ${isImg(f) ? `style="background-image:url('${BASE}/api/files/${encodeURIComponent(f.id)}')"` : ''} aria-label="Abrir ${esc(f.name)}">${f.mime === 'application/pdf' ? 'PDF' : /hei[cf]/.test(f.mime) ? 'HEIC' : ''}</button><small title="${esc(f.caption || f.name)}">${esc(f.caption || f.name)}</small>${f.doc ? '<small class="docb" title="Só o administrador vê">documento · só você vê</small>' : ''}${f.id === p.photoFileId ? '<small class="star">foto principal</small>' : ed && isImg(f) && !f.doc ? `<button type="button" class="link" data-mainphoto="${esc(f.id)}">usar como foto principal</button>` : ''}${me.role === 'admin' && f.mime !== 'application/pdf' ? `<button type="button" class="link" data-docflag="${esc(f.id)}" data-to="${f.doc ? 0 : 1}">${f.doc ? 'liberar como foto' : 'marcar como documento'}</button>` : ''}${mine(f) ? `<button type="button" class="link" data-rmfile="${esc(f.id)}">remover</button>` : ''}${f.createdBy !== me?.id && me && !isGuest() ? `<button type="button" class="link" data-report="file" data-target="${esc(f.id)}">denunciar</button>` : ''}</div>`).join('')}</div>` : '<p class="none">Nenhum ainda.</p>'}
  <h4>Vídeos e links (${pm.length})</h4>
  ${pm.length ? `<ul class="mlinks">${pm.map(m => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><span class="tag">${esc(kindOf(m.url))}</span>${esc(m.title || host(m.url))}</a><small>${esc(host(m.url))} · ${esc(who(m.createdBy))}, ${esc(fmtDate(m.createdAt))}${mine(m) ? ` · <button type="button" class="link" data-rmlink="${m.id}">remover</button>` : ''}${m.createdBy !== me?.id ? rep('media', m.id) : ''}</small></li>`).join('')}</ul>` : '<p class="none">Nenhum ainda.</p>'}
  <h4>Lembranças da família (${mem.length})</h4>
  ${mem.length ? noteList(mem) : '<p class="none">Nenhuma ainda. Conte uma história, uma lembrança ou algo que você aprendeu com esta pessoa.</p>'}
  <h4>Informações da família (${info.length})</h4>
  ${info.length ? noteList(info) : '<p class="none">Nenhuma ainda.</p>'}`}
  ${me && !isGuest() ? `<p class="note">Algo falso, ofensivo ou exposto sem autorização nesta ficha? <button type="button" class="link" data-report="person" data-target="${esc(p.id)}">Denunciar ao administrador</button></p>` : ''}
  ${me && me.role === 'admin' ? `<details class="relmore"><summary>Esta pessoa está duplicada?</summary><p class="note">Escolha a outra ficha da mesma pessoa. Fica esta ficha; a outra passa para ela os filhos, pais, notas, fotos e relatos e depois é apagada. Dados diferentes ficam em nota.</p><div class="actions"><select id="mergesel" data-mergesel>${Object.values(people).filter(q => q.id !== p.id).sort(byName).map(q => `<option value="${esc(q.id)}">${esc(q.name)}${yr(q) !== '—' ? ' (' + esc(yr(q)) + ')' : ''}</option>`).join('')}</select><button type="button" data-act="merge">Juntar nesta ficha</button></div></details>` : ''}
  ${prel.length ? `<h4>Relatos que citam esta pessoa (${prel.length})</h4><ul class="mlinks">${prel.map(r => `<li${r.hidden ? ' class="muted"' : ''}><button type="button" class="link" data-relato="${esc(r.relatoId)}">${esc(r.fonte || r.relatoId)}</button><small>${esc(r.data || '')}${r.hidden ? ' · oculto: só você vê' : ''}${me.role === 'admin' ? ` · <button type="button" class="link" data-relp="${r.hidden ? 'show' : 'hide'}" data-rel="${esc(r.relatoId)}">${r.hidden ? 'mostrar' : 'ocultar'}</button> · <button type="button" class="link" data-relp="remove" data-rel="${esc(r.relatoId)}">apagar</button>` : ''}</small></li>`).join('')}</ul>${me.role === 'admin' ? '<p class="note">Ocultar tira o relato da ficha para os outros, e você continua vendo. Apagar tira a citação desta ficha de vez, e ela não volta se o relato for importado de novo. Nos dois casos, o relato e os dados que ele trouxe continuam no site.</p>' : ''}` : ''}`;
  const par = [P(p.fatherId), P(p.motherId)].filter(Boolean);
  const sibs = siblingsOf(p.id), skip = new Set([p.id, ...sibs.map(q => q.id)]);
  // Tios: irmãos do pai e da mãe. Primos: filhos desses tios.
  const uncles = parId => P(parId) ? siblingsOf(parId) : [];
  const cousins = parId => { const seen = new Set(); return uncles(parId).flatMap(u => childrenOf(u.id)).filter(c => !skip.has(c.id) && !seen.has(c.id) && seen.add(c.id)); };
  const kids = childrenOf(p.id), descNote = p.descendants ? `<p class="none">${DESC[p.descendants]}.</p>` : '';
  const fold = (key, label, list) => `<details class="kfold" data-k="${key}"${kinOpen.has(key) ? ' open' : ''}><summary>${label} (${list.length})</summary>${chips(list)}</details>`;
  // Cada pessoa tem um pai e uma mãe, casados ou não. Irmãos por parte de pai ou de mãe e filhos com pessoas diferentes
  // aparecem do mesmo jeito, só separados para ficar claro de quem é cada um.
  const other = q => q.fatherId === p.id ? q.motherId : q.fatherId;
  const sps = spousesOf(p.id), coparents = [...new Set(kids.map(other).filter(id => id && P(id) && !sps.includes(id)))];
  const byOther = new Map(); for (const k of kids) { const o = P(other(k)) ? other(k) : ''; byOther.set(o, [...(byOther.get(o) || []), k]); }
  const kidsHtml = byOther.size > 1 ? [...byOther].map(([o, list]) => `<p class="klabel">${o ? 'Com ' + esc(P(o).name) : (p.sex === 'f' ? 'Pai' : p.sex === 'm' ? 'Mãe' : 'Pai ou mãe') + ' não informado'}</p>${chips(list)}`).join('') : chips(kids);
  const half = (q, side) => { const a = side === 'f' ? p.motherId : p.fatherId, b = side === 'f' ? q.motherId : q.fatherId; return a && b && a !== b; };
  const sibF = sibs.filter(q => p.fatherId && q.fatherId === p.fatherId && half(q, 'f')), sibM = sibs.filter(q => p.motherId && q.motherId === p.motherId && half(q, 'm'));
  const sibFull = sibs.filter(q => !sibF.includes(q) && !sibM.includes(q));
  const sibHtml = (sibF.length || sibM.length ? (sibFull.length ? chips(sibFull) : '') : chips(sibFull)) + (sibF.length ? `<p class="klabel">Por parte de pai</p>${chips(sibF)}` : '') + (sibM.length ? `<p class="klabel">Por parte de mãe</p>${chips(sibM)}` : '');
  kin.innerHTML = `<h4>Pais</h4>${chips(par)}<h4>Cônjuge</h4>${chips(sps.map(P))}${coparents.length ? `<h4>Teve filhos com</h4>${chips(coparents.map(P))}` : ''}<h4>Filhos</h4>${kids.length ? kidsHtml + descNote : descNote || chips(kids)}<h4>Irmãos</h4>${sibHtml}`
    + (P(p.fatherId) ? fold('tp', 'Tios paternos', uncles(p.fatherId)) : '') + (P(p.motherId) ? fold('tm', 'Tios maternos', uncles(p.motherId)) : '')
    + (P(p.fatherId) ? fold('pp', 'Primos do lado do pai', cousins(p.fatherId)) : '') + (P(p.motherId) ? fold('pm', 'Primos do lado da mãe', cousins(p.motherId)) : '');
}
document.addEventListener('change', async e => {
  const inp = e.target.closest('[data-profilephoto]'); if (!inp || !inp.files.length) return;
  const photoPublic = confirm('Esta foto pode aparecer para outra família, se um dia descobrirem que é a mesma pessoa?\n\nOK = pública\nCancelar = só para esta família (dá para mudar depois)');
  const fd = new FormData(); fd.append('files', inp.files[0]); fd.append('caption', 'Foto de perfil'); fd.append('doc', '0'); fd.append('profile', '1'); inp.value = '';
  const box = inp.closest('.avatar'); if (box) box.classList.add('busy');
  try {
    const r = await api(`/api/people/${encodeURIComponent(focus)}/files`, { method: 'POST', body: fd });
    if (r.ids && r.ids[0]) await api(`/api/people/${encodeURIComponent(focus)}/photo`, { method: 'PUT', body: { fileId: r.ids[0], photoPublic } });
    await load();
  } catch (err) { alertStatus(err); if (box) box.classList.remove('busy'); }
});
document.addEventListener('toggle', e => { const d = e.target; if (d.classList && d.classList.contains('kfold')) d.open ? kinOpen.add(d.dataset.k) : kinOpen.delete(d.dataset.k); }, true);
document.addEventListener('click', async e => {
  const g = e.target.closest('[data-go]'); if (g) { closeAll(); go(g.dataset.go); return; }
  const v = e.target.closest('[data-view]'); if (v) { openViewer(v.dataset.view); return; }
  const rv = e.target.closest('[data-relato]'); if (rv) { openRelato(rv.dataset.relato); return; }
  const rn = e.target.closest('[data-rmnote]'); if (rn) { if (await confirmBtn(rn)) { await api('/api/notes/' + rn.dataset.rmnote, { method: 'DELETE' }).catch(err => alertStatus(err)); load(); } return; }
  const rl = e.target.closest('[data-rmlink]'); if (rl) { if (await confirmBtn(rl)) { await api('/api/media-links/' + rl.dataset.rmlink, { method: 'DELETE' }).catch(err => alertStatus(err)); load(); } return; }
  const mp = e.target.closest('[data-mainphoto]'); if (mp) { await api(`/api/people/${encodeURIComponent(focus)}/photo`, { method: 'PUT', body: { fileId: mp.dataset.mainphoto } }).catch(err => alertStatus(err)); load(); return; }
  const df = e.target.closest('[data-docflag]'); if (df) { if (df.dataset.to === '0' && !(await confirmBtn(df))) return; await api('/api/files/' + df.dataset.docflag, { method: 'PUT', body: { doc: df.dataset.to === '1' } }).catch(err => alertStatus(err)); load(); return; }
  const rf = e.target.closest('[data-rmfile]'); if (rf) { if (await confirmBtn(rf)) { await api('/api/files/' + rf.dataset.rmfile, { method: 'DELETE' }).catch(err => alertStatus(err)); load(); } return; }
  const rp = e.target.closest('[data-relp]'); if (rp) { if (rp.dataset.relp === 'remove' && !(await confirmBtn(rp))) return; await api('/api/admin/relato-people', { method: 'POST', body: { relatoId: rp.dataset.rel, personId: focus, action: rp.dataset.relp } }).catch(err => alertStatus(err)); load(); return; }
  const rpb = e.target.closest('[data-report]'); if (rpb) { repTarget = { kind: rpb.dataset.report, target: rpb.dataset.target }; $('#repform').reset(); $('#repErr').textContent = ''; $('#repdlg').showModal(); return; }
  const c = e.target.closest('.closeDlg'); if (c) { c.closest('dialog').close(); return; }
  const a = e.target.closest('[data-act]'); if (!a) return; const p = P(focus); if (!p) return;
  if (a.dataset.act === 'edit') openForm(p.id);
  if (a.dataset.act === 'child') openForm(null, { childOf: p.id });
  if (a.dataset.act === 'sibling') openForm(null, { siblingOf: p.id });
  if (a.dataset.act === 'merge') {
    const other = a.parentElement.querySelector('[data-mergesel]').value;
    confirmBtn(a).then(ok => ok && api('/api/admin/merge', { method: 'POST', body: { keep: p.id, remove: other } }).then(r => { load(); if (r.conflicts.length) alert('Juntado. Dados diferentes guardados em nota: ' + r.conflicts.join('; ')); }).catch(err => alertStatus(err)));
  }
  if (a.dataset.act === 'spouse') openForm(null, { spouseOf: p.id });
  if (a.dataset.act === 'del') openForm(p.id, { confirmDel: true });
  if (a.dataset.act === 'note') openNote(p.id, 'info');
  if (a.dataset.act === 'memory') openNote(p.id, 'memory');
  if (a.dataset.act === 'link') openLink(p.id);
  if (a.dataset.act === 'files') openFiles(p.id);
  if (a.dataset.act === 'private') { api(`/api/people/${encodeURIComponent(p.id)}/private`, { method: 'PUT', body: { on: a.dataset.to === '1' } }).then(load).catch(err => alertStatus(err)); return; }
  if (a.dataset.act === 'photopub') { api(`/api/people/${encodeURIComponent(p.id)}/public-settings`, { method: 'PUT', body: { photoPublic: a.dataset.to === '1' } }).then(load).catch(err => alertStatus(err)); return; }
  if (a.dataset.act === 'ascendpub') { api(`/api/people/${encodeURIComponent(p.id)}/public-settings`, { method: 'PUT', body: { ascendPublic: a.dataset.to === '1' } }).then(load).catch(err => alertStatus(err)); return; }
  if (a.dataset.act === 'crosslink') { $('#xform').reset(); $('#xErr').textContent = ''; $('#xdlg').showModal(); return; }
  if (a.dataset.act === 'kinask') {
    api(`/api/people/${encodeURIComponent(p.id)}/kin-contacts`).then(r => {
      $('#kinMsg').innerHTML = `<div class="hint"><p><b>Só os parentes diretos de ${esc(p.name)}</b> (cônjuge, pais, irmãos, filhos, netos e bisnetos) ou o administrador podem alterar esta ficha.</p>
        <p>${r.contacts.length ? 'Entre em contato com: <b>' + r.contacts.map(esc).join(', ') + '</b>' + (r.admins.length ? ', ou com o administrador (' + r.admins.map(esc).join(', ') + ')' : '') + '.' : 'Nenhum parente direto tem conta ainda. Fale com o administrador' + (r.admins.length ? ' (' + r.admins.map(esc).join(', ') + ')' : '') + '.'}</p>
        <p>Enquanto isso, use <b>+ Acrescentar informação</b> para deixar a correção registrada na ficha, com a fonte.</p></div>`;
    }).catch(err => alertStatus(err));
    return;
  }
  if (a.dataset.act === 'isme' || a.dataset.act === 'notme') {
    (async () => {
      const pid = a.dataset.act === 'isme' ? p.id : '';
      if (pid && !confirm(`Tem certeza de que você é ${p.name}?\n\nVocê vai administrar esta ficha: corrigir datas, lugares e a foto. O administrador recebe um aviso.`)) return;
      if (!pid) {
        const { count } = await api('/api/me/person/changes').catch(() => ({ count: 0 }));
        const msg = count ? `Tem certeza de que quer apagar todas as alterações que você fez neste perfil (${count})?\n\nDatas, fotos, notas e o que você removeu voltam a ser como eram antes de você dizer que era esta pessoa. O que você corrigiu nas fichas de parentes falecidos também é desfeito.` : 'Tem certeza de que esta pessoa não é você?';
        if (!confirm(msg)) return;
      }
      try { const r = await api('/api/me/person', { method: 'PUT', body: { personId: pid } }); me.personId = pid; await load(); if (r.undone) $('#status').textContent = `${r.undone} alteração(ões) desfeita(s).`; }
      catch (err) { alertStatus(err); }
    })();
  }
});
function closeAll() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
function alertStatus(err) { $('#status').textContent = err.message; }
// Pede um segundo clique para confirmar remoções (sem janelas do navegador).
function confirmBtn(btn) {
  if (btn.dataset.armed) return Promise.resolve(true);
  btn.dataset.armed = '1'; const t = btn.textContent; btn.textContent = 'clique de novo para confirmar';
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = t; }, 4000);
  return Promise.resolve(false);
}

/* ---------- índice e busca ---------- */
function renderIndex() {
  const all = Object.values(people), root = rootPerson(), fam = familyOf(root);
  const list = (fam && !showAll ? all.filter(p => fam.has(p.id)) : all).sort(byName);
  const first = root ? callName(P(root)) : '';
  $('#indexTitle').textContent = fam && !showAll ? (root === myPerson() ? 'Sua família' : 'Família de ' + first) : 'Todas as pessoas';
  $('#count').textContent = list.length ? `(${list.length})` : '';
  $('#allBtn').hidden = !fam || fam.size >= all.length;
  $('#allBtn').textContent = showAll ? (root === myPerson() ? 'Ver só a sua família' : 'Ver só a família de ' + first) : `Ver todas as pessoas (${all.length})`;
  $('#index').innerHTML = list.length ? list.map(p => `<li><button type="button" data-go="${esc(p.id)}"${p.id === root ? ' class="me"' : ''}>${esc(dn(p))} <span>${esc(yr(p))}</span></button></li>`).join('') : '<li class="none">A árvore ainda está vazia. Comece adicionando alguém.</li>';
  $('#backBtn').hidden = !trail.some(id => P(id) && id !== focus);
  const home = $('#homeBtn'), r = rootPerson();
  home.hidden = !r || r === focus;
  home.textContent = r && r === myPerson() ? 'Voltar para mim' : 'Voltar ao início';
  $('#whoHint').hidden = !(me && !isGuest() && !myPerson());
}
$('#allBtn').addEventListener('click', () => { showAll = !showAll; renderIndex(); });
$('#backBtn').addEventListener('click', () => { if (goBack()) scrollTo({ top: $('#chartTitle').offsetTop - 10, behavior: 'smooth' }); });
$('#homeBtn').addEventListener('click', () => { const r = rootPerson(); if (r) { setFocus(r); scrollTo({ top: $('#chartTitle').offsetTop - 10, behavior: 'smooth' }); } });
const q = $('#q'), res = $('#results');
function search() {
  const t = norm(q.value.trim()); if (!t) { res.style.display = 'none'; return; }
  const hits = Object.values(people).filter(p => norm([p.name, p.nick, p.birthPlace, p.deathPlace, p.origin, COLOR[p.color], p.notes].join(' ')).includes(t)).sort(byName).slice(0, 30);
  res.innerHTML = hits.length ? hits.map(p => `<button type="button" data-hit="${esc(p.id)}">${esc(dn(p))}<small>${esc([nickOf(p), yr(p), p.birthPlace].filter(Boolean).join(' · '))}</small></button>`).join('') : '<p class="none" style="padding:12px 14px;margin:0">Ninguém encontrado. Você pode adicionar essa pessoa.</p>';
  res.style.display = 'block';
}
q.addEventListener('input', search); q.addEventListener('focus', search);
q.addEventListener('keydown', e => { if (e.key === 'Escape') { q.value = ''; res.style.display = 'none'; } if (e.key === 'Enter') { const f = res.querySelector('[data-hit]'); if (f) f.click(); } });
res.addEventListener('click', e => { const b = e.target.closest('[data-hit]'); if (!b) return; res.style.display = 'none'; q.value = ''; go(b.dataset.hit); });
document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) res.style.display = 'none'; });

/* ---------- formulário de pessoa ---------- */
const FIELDS = ['name', 'given', 'nick', 'sex', 'birth', 'birthPlace', 'death', 'deathPlace', 'fatherId', 'motherId', 'spouseId', 'marriage', 'marriagePlace', 'descendants', 'color', 'origin', 'notes', 'sources'];
const DESC = { nao_teve: 'Não teve descendentes', nao_deixou: 'Não deixou descendentes' };
const COLOR = { branca: 'Branca', preta: 'Preta', parda: 'Parda', amarela: 'Amarela', indigena: 'Indígena' };
const dlg = $('#dlg'), form = $('#form');
function fillSelect(sel, val, excl, addNew) {
  const opts = Object.values(people).filter(p => p.id !== excl).sort(byName);
  sel.innerHTML = '<option value="">Não informado</option>' + opts.map(p => `<option value="${esc(p.id)}">${esc(dn(p))}${yr(p) !== '—' ? ' (' + esc(yr(p)) + ')' : ''}</option>`).join('') + (addNew ? '<option value="__new__">+ Pessoa nova…</option>' : '');
  sel.value = val || '';
}
/* ---------- datas: dia, mês e ano em listas (no celular abrem como rolagem) ---------- */
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const pad2 = n => String(n).padStart(2, '0');
function parseDate(v) {
  v = String(v || '').trim(); if (!v) return { d: '', m: '', y: '', c: false };
  const c = /^c\.\s*/i.test(v), r = v.replace(/^c\.\s*/i, '');
  let x;
  if ((x = r.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\?{4})$/))) return { d: +x[1], m: +x[2], y: x[3] === '????' ? '' : x[3], c };
  if ((x = r.match(/^(\d{1,2})\/(\d{4}|\?{4})$/))) return { d: '', m: +x[1], y: x[2] === '????' ? '' : x[2], c };
  if ((x = r.match(/^(\d{4})$/))) return { d: '', m: '', y: x[1], c };
  return null; // texto livre: fica no modo "escrever"
}
function formatDate({ d, m, y, c }) {
  if (!d && !m && !y) return '';
  const yy = y || '????';
  const s = d && m ? `${pad2(d)}/${pad2(m)}/${yy}` : m ? `${pad2(m)}/${yy}` : y; if (!s) return '';
  return (c ? 'c. ' : '') + s;
}
function setupDatePickers() {
  const years = []; for (let y = new Date().getFullYear(); y >= 1700; y--) years.push(y);
  for (const box of document.querySelectorAll('.datef')) {
    const inp = box.querySelector('input');
    const w = document.createElement('div'); w.className = 'dsel';
    w.innerHTML = `<select id="${inp.name}-d" data-p="d" aria-label="Dia"><option value="">Dia</option>${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select>
      <select id="${inp.name}-m" data-p="m" aria-label="Mês"><option value="">Mês</option>${MESES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('')}</select>
      <select id="${inp.name}-y" data-p="y" aria-label="Ano"><option value="">Ano</option>${years.map(y => `<option>${y}</option>`).join('')}</select>
      <label class="aprox"><input type="checkbox" id="${inp.name}-aprox" data-p="c"> aproximada</label>`;
    const tog = document.createElement('button'); tog.type = 'button'; tog.className = 'link dtog';
    box.insertBefore(w, inp); box.appendChild(tog);
    const sel = k => w.querySelector(`[data-p="${k}"]`);
    const sync = () => { inp.value = formatDate({ d: sel('d').value, m: sel('m').value, y: sel('y').value, c: sel('c').checked }); };
    w.addEventListener('change', sync);
    box.setMode = manual => { box.classList.toggle('manual', manual); tog.textContent = manual ? 'escolher na lista' : 'escrever de outro jeito'; };
    box.load = () => { const p = parseDate(inp.value); box.setMode(!p); const q = p || { d: '', m: '', y: '', c: false }; sel('d').value = q.d; sel('m').value = q.m; sel('y').value = q.y; sel('c').checked = q.c; };
    tog.addEventListener('click', () => { const manual = !box.classList.contains('manual'); if (!manual) { const p = parseDate(inp.value); if (!p) inp.value = ''; } box.load(); box.setMode(manual); if (manual) inp.focus(); });
  }
}
setupDatePickers();
function openForm(id, c = {}) {
  const p = id ? P(id) : {}; if (id ? !canEdit(p) : !canWrite()) return; if (c.confirmDel && !ownsP(p)) return;
  editing = id; ctx = c;
  $('#formTitle').textContent = c.confirmDel ? 'Excluir ' + p.name + '?' : id ? 'Editar ' + p.name : c.parentOf ? (c.parentRole === 'father' ? 'Pai de ' : 'Mãe de ') + P(c.parentOf).name : c.childOf ? 'Filho ou filha de ' + P(c.childOf).name : c.spouseOf ? 'Cônjuge de ' + P(c.spouseOf).name : c.siblingOf ? 'Irmão ou irmã de ' + P(c.siblingOf).name : 'Adicionar pessoa';
  for (const f of FIELDS) { const el = form.elements[f]; if (el.tagName !== 'SELECT' || f === 'sex' || f === 'color' || f === 'descendants') el.value = p[f] || ''; }
  document.querySelectorAll('.datef').forEach(b => b.load());
  form.elements.minorConsent.checked = false; formRules();
  fillSelect(form.elements.fatherId, p.fatherId, id, !!id); fillSelect(form.elements.motherId, p.motherId, id, !!id); fillSelect(form.elements.spouseId, p.spouseId, id, !!id);
  $('#parentHint').hidden = !c.childOf;
  // Só preenche o outro pai/mãe quando a pessoa tem um único cônjuge ou companheiro conhecido.
  if (c.childOf) { const par = P(c.childOf), sp = [...new Set([...spousesOf(par.id), ...childrenOf(par.id).map(k => k.fatherId === par.id ? k.motherId : k.fatherId).filter(x => x && P(x))])]; form.elements[par.sex === 'f' ? 'motherId' : 'fatherId'].value = par.id; if (sp.length === 1) form.elements[par.sex === 'f' ? 'fatherId' : 'motherId'].value = sp[0]; }
  if (c.parentOf) { form.elements.sex.value = c.parentRole === 'father' ? 'm' : 'f'; const ch = P(c.parentOf), other = c.parentRole === 'father' ? ch.motherId : ch.fatherId; if (P(other)) form.elements.spouseId.value = other; }
  // Irmãos: os mesmos pais por padrão; para meio-irmãos, é só trocar o pai ou a mãe aqui.
  if (c.siblingOf) { const sb = P(c.siblingOf); form.elements.fatherId.value = sb.fatherId || ''; form.elements.motherId.value = sb.motherId || ''; }
  if (c.spouseOf) { form.elements.spouseId.value = c.spouseOf; const o = P(c.spouseOf); if (o.sex) form.elements.sex.value = o.sex === 'm' ? 'f' : 'm'; }
  $('#delBtn').hidden = !c.confirmDel; $('#saveBtn').hidden = !!c.confirmDel;
  [...form.querySelectorAll('input,select,textarea')].forEach(el => { el.disabled = !!c.confirmDel; });
  $('#formErr').textContent = c.confirmDel ? 'A pessoa será removida para toda a família. As informações e documentos ligados a ela continuam guardados.' : '';
  dlg.showModal(); if (c.confirmDel) $('#delBtn').focus(); else form.elements.name.focus();
}
// Regras dos termos no formulário: menor de idade e dados sensíveis de pessoas vivas.
const yNow = new Date().getFullYear();
function formRules() {
  const b = Number((String(form.elements.birth.value).match(/\d{4}/) || [])[0]), dead = !!(form.elements.death.value.trim() || form.elements.deathPlace.value.trim()) || (b && b <= 1915);
  const minor = !dead && b && b > yNow - 18;
  $('#minorWrap').hidden = !minor || (editing && P(editing)?.minorOk);
  const p = editing ? P(editing) : null, selfOrDead = dead || (p && isSelfP(p));
  for (const k of ['color', 'origin']) form.elements[k].disabled = !selfOrDead && !(p && p[k]);
  $('#sensHint').hidden = selfOrDead;
}
form.addEventListener('input', formRules); form.addEventListener('change', formRules);
// Pai/Mãe/Cônjuge só listam quem já está cadastrado; "+ Pessoa nova" manda para o formulário certo em vez de travar a busca.
for (const [field, role] of [['fatherId', 'father'], ['motherId', 'mother'], ['spouseId', 'spouse']]) {
  form.elements[field].addEventListener('change', e => {
    if (e.target.value !== '__new__' || !editing) return;
    const who = editing;
    openForm(null, role === 'spouse' ? { spouseOf: who } : { parentOf: who, parentRole: role });
  });
}
form.addEventListener('submit', async e => {
  e.preventDefault(); if (ctx.confirmDel) return;
  const d = {}; for (const f of FIELDS) d[f] = String(form.elements[f].value || '').trim();
  if (form.elements.minorConsent.checked) d.minorConsent = true;
  if (!d.name) { $('#formErr').textContent = 'Escreva pelo menos o nome.'; return; }
  $('#saveBtn').disabled = true; $('#formErr').textContent = 'Salvando…';
  try {
    if (editing) await api('/api/people/' + encodeURIComponent(editing), { method: 'PUT', body: d });
    else {
      const r = await api('/api/people', { method: 'POST', body: { ...d, parentOf: ctx.parentOf, parentRole: ctx.parentRole } });
      if (!ctx.parentOf && !ctx.childOf && !ctx.spouseOf && !ctx.siblingOf) focus = r.id;
    }
    dlg.close(); await load();
  } catch (err) { $('#formErr').textContent = err.message; if (err.code === 'minor') $('#minorWrap').hidden = false; }
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
  if (!canContribute()) return;
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
function openLink(id) { if (!canContribute()) return; linkPerson = id; $('#lTitle').textContent = 'Vídeo ou link de ' + P(id).name; lform.reset(); $('#lErr').textContent = ''; ldlg.showModal(); lform.elements.url.focus(); }
lform.addEventListener('submit', async e => {
  e.preventDefault();
  try { await api(`/api/people/${encodeURIComponent(linkPerson)}/links`, { method: 'POST', body: { url: lform.elements.url.value, title: lform.elements.title.value } }); ldlg.close(); await load(); }
  catch (err) { $('#lErr').textContent = err.message; }
});

/* ---------- ligação com outro livro ---------- */
$('#xform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, p = P(focus); if (!p) return;
  try {
    await api('/api/cross-link/request', { method: 'POST', body: { personId: p.id, toBook: f.elements.toBook.value, guessName: f.elements.guessName.value } });
    $('#xdlg').close(); await load();
  } catch (err) { $('#xErr').textContent = err.message; }
});

/* ---------- documentos ---------- */
const fdlg = $('#fdlg'), fform = $('#fform'); let filePerson = null;
function openFiles(id) { if (!canContribute()) return; filePerson = id; $('#fTitle').textContent = 'Fotos e documentos de ' + P(id).name; fform.reset(); $('#fErr').textContent = ''; fdlg.showModal(); }
fform.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(fform); fd.set('doc', fform.elements.doc.checked ? '1' : '0');
  $('#fSave').disabled = true; $('#fErr').textContent = 'Enviando…';
  try { await api(`/api/people/${encodeURIComponent(filePerson)}/files`, { method: 'POST', body: fd }); fdlg.close(); await load(); $('#status').textContent = fd.get('doc') === '1' ? 'Documento enviado ao administrador. Por segurança, só ele tem acesso à imagem; os dados do documento entram na ficha.' : 'Foto enviada.'; }
  catch (err) { $('#fErr').textContent = err.message; }
  finally { $('#fSave').disabled = false; }
});
function openViewer(id) {
  const f = files.find(x => x.id === id); if (!f) return;
  const url = BASE + '/api/files/' + encodeURIComponent(id);
  $('#vCap').textContent = (f.caption ? f.caption + ' · ' : '') + f.name + ' · enviado por ' + who(f.createdBy);
  $('#vDl').href = url + '?download=1';
  const body = $('#vBody');
  body.innerHTML = f.mime.startsWith('image/') && !/hei[cf]/.test(f.mime) ? `<img src="${url}" alt="${esc(f.caption || f.name)}">` :
    f.mime === 'application/pdf' ? `<iframe src="${url}" title="${esc(f.name)}"></iframe>` : '<p class="none" style="padding:20px">Este formato não abre no navegador. Use "Baixar".</p>';
  $('#vdlg').showModal();
}

$('#famform').addEventListener('submit', async e => {
  e.preventDefault();
  try { const r = await api('/api/admin/family-name', { method: 'PUT', body: { name: e.target.elements.name.value } }); familyName = r.name; $('#hsub').textContent = r.name; document.title = document.title.split(' · ')[0] + ' · ' + r.name; $('#aErr').textContent = ''; }
  catch (err) { $('#aErr').textContent = err.message; }
});

$('#termsOk').addEventListener('click', async () => { try { await api('/api/me/accept-terms', { method: 'POST' }); $('#termsdlg').close(); } catch (err) { $('#termsErr').textContent = err.message; } });
$('#termsNo').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.reload(); });
$('#termsdlg').addEventListener('cancel', e => e.preventDefault()); // não fecha com Esc

let repTarget = null;
$('#repform').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/reports', { method: 'POST', body: { ...repTarget, reason: e.target.elements.reason.value } }); $('#repdlg').close(); $('#status').textContent = 'Denúncia enviada ao administrador. Obrigado.'; }
  catch (err) { $('#repErr').textContent = err.message; }
});

/* ---------- avisos ---------- */
async function loadNotifCount() {
  try { const d = await api('/api/notifications'); $('#notifBtn').textContent = d.unread ? `Avisos (${d.unread})` : 'Avisos'; $('#notifBtn').classList.toggle('hot', !!d.unread); return d; } catch { return null; }
}
$('#notifBtn').addEventListener('click', async () => {
  const d = await loadNotifCount(); if (!d) return;
  $('#avList').innerHTML = d.notifications.length ? `<ul class="notes">${d.notifications.map(n => `<li class="${n.readAt ? '' : 'unread'}">${esc(n.text)}${n.bookRequest ? (n.bookRequest.pending ? approveBox(n.bookRequest.id, '') : n.bookRequest.code ? bookDone(n.bookRequest) : '') : ''}<small>${esc(fmtDate(n.createdAt))}${n.personId && P(n.personId) ? ` · <button type="button" class="link" data-go="${esc(n.personId)}">ver a ficha</button>` : ''}</small></li>`).join('')}</ul>` : '<p class="none">Nenhum aviso ainda.</p>';
  $('#avMail').checked = !!d.emailUpdates;
  $('#avdlg').showModal();
  if (d.unread) { await api('/api/notifications/read', { method: 'POST' }).catch(() => {}); $('#notifBtn').textContent = 'Avisos'; $('#notifBtn').classList.remove('hot'); }
});

$('#avList').addEventListener('click', e => { const cu = e.target.closest('[data-copyurl]'); if (cu) copy(cu.dataset.copyurl, cu); const ab = e.target.closest('[data-bookapprove]'); if (ab) approveBook(ab); });
$('#avMail').addEventListener('change', e => api('/api/me/email-updates', { method: 'PUT', body: { on: e.target.checked } }).catch(err => alertStatus(err)));

document.addEventListener('click', e => { if (e.target.closest('[data-themebtn]')) window.cycleTheme(); });

/* ---------- senha ---------- */
$('#pwBtn').addEventListener('click', () => { $('#pform').reset(); $('#pErr').textContent = ''; $('#pdlg').showModal(); });
$('#pform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try { await api('/api/password', { method: 'POST', body: { current: f.elements.current.value, password: f.elements.password.value } }); $('#pdlg').close(); $('#status').textContent = 'Senha alterada.'; }
  catch (err) { $('#pErr').textContent = err.message; }
});
$('#delform').addEventListener('submit', async e => {
  e.preventDefault(); const b = e.target.querySelector('button.danger');
  if (!(await confirmBtn(b))) return;
  try { await api('/api/me/delete', { method: 'POST', body: { password: e.target.elements.password.value } }); location.href = BASE + '/'; }
  catch (err) { $('#delErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); me = null; showAuth('login'); });

/* ---------- pedir para participar ---------- */
$('#askBtn').addEventListener('click', () => { $('#rform').reset(); $('#rErr').textContent = ''; $('#rdlg').showModal(); });
$('#rform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try {
    const r = await api('/api/access-requests', { method: 'POST', body: { name: f.elements.name.value, email: f.elements.email.value, relation: f.elements.relation.value, message: f.elements.message.value } });
    $('#rdlg').close();
    $('#notice').innerHTML = r.mail ? '<b>Pedido enviado.</b> Quando o administrador aprovar, você recebe um e-mail com o link para criar a sua senha. Ao voltar a este site, você também verá aqui se já foi aprovado.' : '<b>Pedido enviado.</b> Você vai receber o link para criar a sua senha quando o administrador aprovar.';
    $('#notice').hidden = false; scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) { $('#rErr').textContent = err.message; }
});

/* ---------- administração ---------- */
// Pessoas que ainda podem receber conta: vivas e sem conta ligada. "guess" pré-seleciona quem tem o nome igual.
let linkedIds = new Set();
function personOptions(guess) {
  const g = norm(guess || '').trim();
  const list = Object.values(people).filter(p => !isDead(p) && !linkedIds.has(p.id)).sort(byName);
  const pick = g && (list.find(p => norm(p.name) === g) || list.find(p => { const w = g.split(/\s+/); return w.length > 1 && w.every(x => norm(p.name).split(/\s+/).includes(x)); }));
  return `<option value="">Quem é na árvore? (opcional)</option>` + list.map(p => `<option value="${esc(p.id)}"${pick && pick.id === p.id ? ' selected' : ''}>${esc(p.name)}${nickOf(p) ? ' (' + esc(nickOf(p)) + ')' : ''}</option>`).join('');
}
const REQ_STATUS = { pending: 'aguardando', approved: 'aprovado, falta criar a senha', rejected: 'recusado', joined: 'entrou', cancelled: 'cancelado' };
async function loadRequests() {
  const d = await api('/api/admin/access-requests'), box = $('#requests');
  const pend = d.requests.filter(r => r.status === 'pending');
  $('#reqCount').textContent = pend.length ? `(${pend.length} aguardando)` : '';
  $('#adminBtn').textContent = pend.length ? `Administrar (${pend.length})` : 'Administrar';
  box.innerHTML = d.requests.length ? `<table class="tbl"><tbody>${d.requests.map(r => `<tr><td><b>${esc(r.name)}</b><br><span class="note">${esc(r.email)}</span></td><td>${esc(r.relation)}${r.message ? `<br><span class="note">${esc(r.message)}</span>` : ''}</td><td class="note">${esc(fmtDate(r.createdAt))}</td><td>${r.status === 'pending'
    ? `<select id="reqperson-${r.id}" data-reqperson="${r.id}">${personOptions(r.name)}</select> <select id="reqrole-${r.id}" data-reqrole="${r.id}"><option value="member">Pode adicionar</option><option value="viewer">Ver e deixar lembranças</option></select> <button type="button" class="primary" data-approve="${r.id}">Aprovar</button> <button type="button" class="link" data-reject="${r.id}">recusar</button>`
    : `${esc(REQ_STATUS[r.status] || r.status)}${r.status === 'approved' && r.inviteToken ? ` <button type="button" class="link" data-copyurl="${esc(inviteUrl(r.inviteToken))}">copiar convite</button> <button type="button" class="link" data-reqcancel="${r.id}">cancelar convite</button>` : ''}${['rejected', 'cancelled', 'joined'].includes(r.status) ? ` <button type="button" class="link" data-reqdel="${r.id}">apagar da lista</button>` : ''}`}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nenhum pedido. Quem entra pelo link da família pode pedir para participar.</p>';
}
async function loadActivity() {
  const box = $('#activity');
  try {
    const d = await api('/api/admin/activity');
    box.innerHTML = d.activity.length ? `<table class="tbl"><tbody>${d.activity.map(a => `<tr><td>${esc(new Date(a.at).toLocaleString('pt-BR'))}</td><td>${esc(a.name || 'sistema')}</td><td>${esc(a.action)}</td><td>${P(a.target) ? `<button type="button" class="link" data-go="${esc(a.target)}">${esc(dn(P(a.target)))}</button>` : esc(a.target || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nada registrado ainda.</p>';
  } catch (err) { box.textContent = err.message; }
}
const ROLE = { admin: 'Administrador', member: 'Pode adicionar', viewer: 'Ver e deixar lembranças' };
async function loadFamilyLink() {
  const d = await api('/api/admin/family-link'), box = $('#famLink');
  const url = d.token ? `${location.origin}${BASE}/familia/${d.token}` : '';
  box.innerHTML = url ? `<div class="newinv"><b>Link ativo:</b><br><span>${esc(url)}</span><br><button type="button" class="primary" data-copyurl="${esc(url)}">Copiar link</button></div>
    <div class="actions"><button type="button" id="famNew">Trocar link (o atual para de funcionar)</button><button type="button" class="danger" id="famOff">Desligar link</button></div>`
    : `<p class="none">Nenhum link ativo.</p><div class="actions"><button type="button" class="primary" id="famNew">Criar link da família</button></div>`;
}
async function loadReports() {
  const d = await api('/api/admin/reports'); const open = d.reports.filter(r => r.status === 'open');
  $('#repCount').textContent = open.length ? `(${open.length} abertas)` : '';
  const K = { person: 'a ficha', note: 'uma informação', file: 'uma foto ou documento', media: 'um link' };
  $('#repList').innerHTML = d.reports.length ? d.reports.map(r => `<div class="alert"><p><b>${esc(r.byName || 'conta removida')}</b> denunciou ${K[r.kind]}${r.personId && P(r.personId) ? ` de <button type="button" class="link" data-go="${esc(r.personId)}">${esc(P(r.personId).name)}</button>` : ''} <span class="note">${esc(fmtDate(r.createdAt))}${r.status === 'closed' ? ' · resolvida' : ''}</span></p><p>"${esc(r.reason)}"</p>${r.status === 'open' ? `<div class="actions small"><button type="button" data-repclose="${r.id}">Marcar como resolvida</button></div>` : ''}</div>`).join('') : '<p class="none">Nenhuma denúncia.</p>';
}
// Aprovar um pedido de livro: o site cria o livro com código e manda o e-mail para a pessoa.
const approveBox = (id, name) => `<div class="cmdbox"><button type="button" class="primary" data-bookapprove="${id}">Aprovar e criar o livro</button><p class="note">Cria o livro da ${esc(name || 'família')} com um código curto e manda para a pessoa o endereço e a chave de instalação. Nada é misturado com o seu livro.</p></div>`;
const bookDone = r => `<div class="cmdbox"><p><b>Livro criado:</b> código <b>${esc(r.code)}</b> · <a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a></p>${r.setupUrl ? `<p class="note">${r.mailed ? 'O e-mail com o endereço e a chave de instalação já foi para a pessoa.' : 'O e-mail não está configurado: mande você mesmo este link para a pessoa.'} Link de instalação (só para ela): <code>${esc(r.setupUrl)}</code></p><button type="button" data-copyurl="${esc(r.setupUrl)}">Copiar link de instalação</button>` : ''}</div>`;
async function approveBook(btn) {
  btn.disabled = true; btn.textContent = 'Criando…';
  try { const r = await api(`/api/admin/book-requests/${btn.dataset.bookapprove}/approve`, { method: 'POST' }); btn.closest('.cmdbox').outerHTML = bookDone(r); return r; }
  catch (err) { btn.disabled = false; btn.textContent = 'Aprovar e criar o livro'; btn.insertAdjacentHTML('afterend', `<p class="err">${esc(err.message)}</p>`); }
}
async function loadBookRequests() {
  const d = await api('/api/admin/book-requests');
  const pend = d.requests.filter(r => r.status === 'pending');
  $('#bookCount').textContent = pend.length ? `(${pend.length} aguardando)` : '';
  $('#bookList').innerHTML = d.requests.length ? d.requests.map(r => `<div class="alert"><p><b>${esc(r.family || '')}</b> <span class="note">${esc(fmtDate(r.createdAt))}${r.status === 'done' ? ' · atendido' : ''}</span></p>
    <p>${esc(r.name)} · <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.place ? ' · ' + esc(r.place) : ''}</p>${r.relatives ? `<p class="note">Parentes que já usam: ${esc(r.relatives)}</p>` : ''}${r.message ? `<p class="note">${esc(r.message)}</p>` : ''}
    ${r.maybeSame && r.maybeSame.length ? `<div class="hint"><b>Pode ser a mesma família:</b><ul>${r.maybeSame.map(m => `<li>${esc(m.label)}${m.strong ? ' <span class="tag">mesmo sobrenome e cidade</span>' : ' <span class="note">(mesmo sobrenome, cidade não informada)</span>'}</li>`).join('')}</ul>Antes de criar outro livro, pergunte se a pessoa não quer entrar no que já existe.</div>` : ''}
    ${r.bookCode ? bookDone({ code: r.bookCode, url: r.bookUrl }) : r.status === 'pending' ? approveBox(r.id, r.family) : ''}
    <div class="actions small">${r.status === 'pending' ? `<button type="button" data-bookreq="${r.id}" data-act2="done">Marcar como atendido</button>` : `<button type="button" class="link" data-bookreq="${r.id}" data-act2="reopen">reabrir</button>`}<button type="button" class="link danger" data-bookreq="${r.id}" data-act2="delete">apagar</button></div></div>`).join('') : '<p class="none">Nenhum pedido ainda. Divulgue o endereço /comecar.</p>';
  $('#codeBooks').innerHTML = d.codeBooks && d.codeBooks.length ? `<p class="note"><b>Livros criados (${d.codeBooks.length}):</b></p><ul class="notes">${d.codeBooks.map(b => `<li><b>${esc(b.code)}</b> · ${esc(b.family)}${b.place ? ' · ' + esc(b.place) : ''} · <a href="${esc(b.url)}" target="_blank">abrir</a><small>${esc(b.email)} · ${esc(fmtDate(b.createdAt))}</small></li>`).join('')}</ul>` : '';
}
async function loadCrossLinks() {
  const d = await api('/api/admin/cross-links');
  $('#xlCount').textContent = d.pending.length ? `(${d.pending.length} aguardando)` : '';
  const opts = Object.values(people).sort(byName).map(p => `<option value="${esc(p.id)}">${esc(p.name)}${yr(p) !== '—' ? ' (' + esc(yr(p)) + ')' : ''}</option>`).join('');
  $('#xlList').innerHTML = d.pending.length ? d.pending.map(x => `<div class="alert"><p>${esc(x.title)}</p>${x.fromPerson?.photoUrl ? `<img src="${esc(x.fromPerson.photoUrl)}" alt="" style="height:60px;width:60px;border-radius:50%;object-fit:cover">` : ''}
    <p class="note">${esc(fmtDate(x.createdAt))}</p>
    <div class="actions small"><select id="xlsel-${x.id}" data-xlsel="${x.id}"><option value="">Quem é, na sua árvore?</option>${opts}</select><button type="button" class="primary" data-xldecide="${x.id}">Confirmar</button><button type="button" class="link danger" data-xlreject="${x.id}">Não é a mesma pessoa</button></div></div>`).join('') : '<p class="none">Nenhum pedido de ligação aguardando.</p>';
}
async function loadAdmin() {
  loadBookRequests().catch(() => {}); loadReports().catch(() => {}); loadCrossLinks().catch(() => {});
  $('#famform').elements.name.value = familyName;
  $('#aErr').textContent = '';
  loadFamilyLink().catch(err => $('#aErr').textContent = err.message);
  const d = await api('/api/admin');
  linkedIds = new Set([...d.users.map(u => u.personId), ...d.invites.filter(i => !i.usedBy && i.expires > Date.now()).map(i => i.personId)].filter(Boolean));
  $('#iform').elements.personId.innerHTML = personOptions();
  loadRequests().catch(err => $('#aErr').textContent = err.message);
  loadRelatos().catch(err => $('#aErr').textContent = err.message);
  loadSuggestions().catch(err => $('#aErr').textContent = err.message);
  $('#idents').innerHTML = (d.idents || []).length ? `<p class="note"><b>Identificações dos últimos 30 dias:</b></p><ul class="notes">${d.idents.map(x => `<li>${esc(x.name)} ${x.action === 'se identificou na árvore' ? 'disse que é' : 'disse que não é'} <button type="button" class="link" data-go="${esc(x.personId)}">${esc(P(x.personId)?.name || x.personId)}</button>${x.undone ? ` · ${x.undone} alteração(ões) desfeita(s)` : ''}<small>${esc(fmtDate(x.at))}</small></li>`).join('')}</ul>` : '';
  $('#users').innerHTML = `<table class="tbl"><thead><tr><th>Nome</th><th>E-mail</th><th>Acesso</th><th>Na árvore</th><th></th></tr></thead><tbody>${d.users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.id === me.id ? ROLE[u.role] : `<select id="role-${u.id}" data-role="${u.id}">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}"${k === u.role ? ' selected' : ''}>${v}</option>`).join('')}</select>`}</td><td><select id="person-${u.id}" data-person="${u.id}"><option value="">—</option>${Object.values(people).sort(byName).map(p => `<option value="${esc(p.id)}"${p.id === u.personId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>${u.personId && !u.personOk ? `<br><span class="note">ela mesma se identificou; ainda não administra a ficha</span> <button type="button" class="link" data-personok="${u.id}" data-pid="${esc(u.personId)}">confirmar</button>` : ''}</td><td>${u.id === me.id ? 'você' : `<button type="button" class="link" data-reset="${u.id}">link de nova senha</button> <button type="button" class="link" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'bloquear' : 'desbloquear'}</button> <button type="button" class="link danger" data-deluser="${u.id}">eliminar conta</button>`}</td></tr>`).join('')}</tbody></table>`;
  const open = d.invites.filter(i => !i.usedBy && i.expires > Date.now());
  $('#invites').innerHTML = open.length ? `<p class="note">Convites ainda não usados (valem 30 dias):</p><table class="tbl"><tbody>${open.map(i => `<tr><td>${esc(i.label || 'sem nome')}</td><td>${ROLE[i.role]}</td><td><button type="button" class="link" data-copy="${esc(i.token)}">copiar link</button> <button type="button" class="link" data-revoke="${esc(i.token)}">cancelar</button></td></tr>`).join('')}</tbody></table>` : '';
}
$('#adminBtn').addEventListener('click', async () => { $('#newInvite').hidden = true; $('#adlg').showModal(); try { await loadAdmin(); for (const [sec, id] of [['relatos', '#relCount'], ['pedidos', '#reqCount'], ['sugestoes', '#sugCount'], ['livros', '#bookCount'], ['ligacoes', '#xlCount'], ['denuncias', '#repCount']]) if ($(id).textContent.trim()) $(`.asec[data-sec="${sec}"]`).open = true; } catch (err) { $('#aErr').textContent = err.message; } });
const inviteUrl = t => `${location.origin}${BASE}/convite/${t}`;
async function copy(text, btn) { try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = 'copiado'; setTimeout(() => btn.textContent = t, 2000); } } catch {} }
$('#iform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try {
    const r = await api('/api/admin/invites', { method: 'POST', body: { label: f.elements.label.value, role: f.elements.role.value, personId: f.elements.personId.value } });
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
    try { const r = await api('/api/admin/users/' + rs.dataset.reset + '/reset', { method: 'POST' }); const url = `${location.origin}${BASE}/senha/${r.token}`, box = $('#newInvite'); box.hidden = false;
      box.innerHTML = `<b>Link de nova senha</b> (vale 3 dias; mande só para a própria pessoa):<br><span>${esc(url)}</span><br><button type="button" class="primary" data-copyurl="${esc(url)}">Copiar link</button>`; box.scrollIntoView({ block: 'nearest' }); }
    catch (err) { $('#aErr').textContent = err.message; } return; }
  const cu = e.target.closest('[data-copyurl]'); if (cu) { copy(cu.dataset.copyurl, cu); return; }
  const sh = e.target.closest('#showActivity'); if (sh) { loadActivity(); return; }
  const ap = e.target.closest('[data-approve]'); if (ap) {
    try {
      const role = $(`[data-reqrole="${ap.dataset.approve}"]`).value, personId = $(`[data-reqperson="${ap.dataset.approve}"]`).value;
      const r = await api(`/api/admin/access-requests/${ap.dataset.approve}/approve`, { method: 'POST', body: { role, personId } });
      const url = inviteUrl(r.token), box = $('#newInvite'); box.hidden = false;
      const msg = `Oi, ${r.name}! Seu acesso à árvore da família foi aprovado. Crie sua conta com o e-mail ${r.email} neste link (vale 30 dias): ${url}`;
      box.innerHTML = r.mailed ? `<b>Aprovado.</b> Enviamos um e-mail para <b>${esc(r.email)}</b> com o link para ${esc(r.name)} criar a senha. Se a pessoa não receber, mande você mesmo:<br><span>${esc(url)}</span><br><div class="actions"><button type="button" data-copyurl="${esc(msg)}">Copiar mensagem pronta</button></div>` : `<b>Aprovado.</b> O e-mail automático não está configurado. Mande este convite para ${esc(r.name)} (só funciona com o e-mail <b>${esc(r.email)}</b>):<br><span>${esc(url)}</span><br><div class="actions"><button type="button" class="primary" data-copyurl="${esc(msg)}">Copiar mensagem pronta</button><a class="btn" href="mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent('Convite: árvore da família')}&body=${encodeURIComponent(msg)}">Abrir e-mail</a></div>`;
      box.scrollIntoView({ block: 'nearest' }); loadRequests();
    } catch (err) { $('#aErr').textContent = err.message; }
    return; }
  const rc = e.target.closest('[data-reqcancel]'); if (rc) { if (!(await confirmBtn(rc))) return; await api(`/api/admin/access-requests/${rc.dataset.reqcancel}/cancel`, { method: 'POST' }).catch(err => $('#aErr').textContent = err.message); loadRequests(); return; }
  const rd = e.target.closest('[data-reqdel]'); if (rd) { if (!(await confirmBtn(rd))) return; await api(`/api/admin/access-requests/${rd.dataset.reqdel}`, { method: 'DELETE' }).catch(err => $('#aErr').textContent = err.message); loadRequests(); return; }
  const rj = e.target.closest('[data-reject]'); if (rj) { if (!(await confirmBtn(rj))) return; await api(`/api/admin/access-requests/${rj.dataset.reject}/reject`, { method: 'POST' }).catch(err => $('#aErr').textContent = err.message); loadRequests(); return; }
  if (e.target.closest('#famNew')) { if (e.target.closest('#famNew').textContent.startsWith('Trocar') && !(await confirmBtn(e.target.closest('#famNew')))) return; await api('/api/admin/family-link', { method: 'POST' }).catch(err => $('#aErr').textContent = err.message); loadFamilyLink(); return; }
  if (e.target.closest('#famOff')) { if (!(await confirmBtn(e.target.closest('#famOff')))) return; await api('/api/admin/family-link', { method: 'DELETE' }).catch(err => $('#aErr').textContent = err.message); loadFamilyLink(); return; }
  const rpc = e.target.closest('[data-repclose]'); if (rpc) { await api(`/api/admin/reports/${rpc.dataset.repclose}/close`, { method: 'POST' }).catch(err => $('#aErr').textContent = err.message); loadReports(); return; }
  const ab = e.target.closest('[data-bookapprove]'); if (ab) { await approveBook(ab); return; }
  const xd = e.target.closest('[data-xldecide]'); if (xd) {
    const sel = $(`[data-xlsel="${xd.dataset.xldecide}"]`);
    if (!sel.value) { $('#aErr').textContent = 'Escolha quem ela é, na sua árvore.'; return; }
    await api(`/api/admin/cross-links/${xd.dataset.xldecide}/decide`, { method: 'POST', body: { matchPersonId: sel.value } }).catch(err => $('#aErr').textContent = err.message);
    loadCrossLinks(); return;
  }
  const xr = e.target.closest('[data-xlreject]'); if (xr) { if (!(await confirmBtn(xr))) return; await api(`/api/admin/cross-links/${xr.dataset.xlreject}/decide`, { method: 'POST', body: {} }).catch(err => $('#aErr').textContent = err.message); loadCrossLinks(); return; }
  const br = e.target.closest('[data-bookreq]'); if (br) { if (br.dataset.act2 === 'delete' && !(await confirmBtn(br))) return; await api(`/api/admin/book-requests/${br.dataset.bookreq}/${br.dataset.act2}`, { method: 'POST' }).catch(err => $('#aErr').textContent = err.message); loadBookRequests(); return; }
  const pk = e.target.closest('[data-personok]'); if (pk) { await api('/api/admin/users/' + pk.dataset.personok, { method: 'PUT', body: { personId: pk.dataset.pid } }).catch(err => $('#aErr').textContent = err.message); await loadAdmin(); load(); return; }
  const du = e.target.closest('[data-deluser]'); if (du) { if (!(await confirmBtn(du))) return; await api('/api/admin/users/' + du.dataset.deluser, { method: 'DELETE' }).catch(err => $('#aErr').textContent = err.message); await loadAdmin(); load(); return; }
  const a = e.target.closest('[data-active]'); if (a) { await api('/api/admin/users/' + a.dataset.active, { method: 'PUT', body: { active: a.dataset.to === '1' } }).catch(err => $('#aErr').textContent = err.message); loadAdmin(); }
});
$('#adlg').addEventListener('change', async e => {
  const pp = e.target.closest('[data-person]');
  if (pp) { try { await api('/api/admin/users/' + pp.dataset.person, { method: 'PUT', body: { personId: pp.value } }); if (+pp.dataset.person === me.id) { me.personId = pp.value; await load(); } } catch (err) { $('#aErr').textContent = err.message; } return; }
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

// Lote: prévia primeiro, depois aplicar.
let loteText = '';
const loteTable = r => `<p><b>${r.applied ? 'Aplicado' : 'Prévia'}:</b> ${r.ok} linha(s) ${r.applied ? 'aplicadas' : 'prontas'}${r.erros ? `, <span class="err">${r.erros} com problema (${r.applied ? 'não aplicadas' : 'serão puladas'})</span>` : ''}.</p>
  <table class="tbl"><tbody>${r.rows.map(x => `<tr><td class="note">${x.n}</td><td><b>${esc(x.pessoa)}</b><br><span class="note">${esc(x.acao)} · ${esc(x.campo)}</span></td><td>${x.erro ? `<span class="err">${esc(x.erro)}</span>` : esc(x.ok)}</td></tr>`).join('')}</tbody></table>`;
$('#loteform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, file = f.elements.file.files[0];
  try {
    loteText = file ? await file.text() : f.elements.text.value;
    const r = await api('/api/admin/import-lote', { method: 'POST', body: { text: loteText } });
    $('#lotePrev').innerHTML = loteTable(r) + (r.ok ? '<div class="actions"><button type="button" class="primary" id="loteApply">Aplicar</button><button type="button" id="loteCancel">Cancelar</button></div>' : '');
    $('#lotePrev').scrollIntoView({ block: 'nearest' });
  } catch (err) { $('#lotePrev').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
});
$('#lotePrev').addEventListener('click', async e => {
  if (e.target.closest('#loteCancel')) { $('#lotePrev').innerHTML = ''; return; }
  if (!e.target.closest('#loteApply')) return;
  try {
    const r = await api('/api/admin/import-lote', { method: 'POST', body: { text: loteText, apply: true } });
    $('#lotePrev').innerHTML = loteTable(r); $('#loteform').reset(); await load();
  } catch (err) { $('#lotePrev').innerHTML += `<p class="err">${esc(err.message)}</p>`; }
});

/* ---------- relatos de entrevista ---------- */
// Texto do relato: markdown simples (títulos, negrito, listas, tabelas viram texto legível).
function mdLite(t) {
  return esc(t || '').split('\n').map(l => {
    if (/^\s*\|?\s*:?-{3,}/.test(l)) return '';
    const h = l.match(/^(#{1,4})\s+(.*)$/); if (h) return `<h${Math.min(h[1].length + 2, 5)}>${h[2]}</h${Math.min(h[1].length + 2, 5)}>`;
    return (l.trim() ? `<p>${l}</p>` : '');
  }).join('').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}
async function openRelato(id) {
  try {
    const r = await api('/api/relatos/' + encodeURIComponent(id));
    $('#relTitle').textContent = `${r.fonte || r.id}${r.data ? ' · ' + r.data : ''}`;
    const img = f => /^image\//.test(f.mime);
    $('#relBody').innerHTML = `<p class="note">Importado em ${esc(fmtDate(r.importedAt))} · ${r.applied} linha(s) aplicadas${r.skipped ? `, ${r.skipped} pulada(s)` : ''}</p>
      ${r.people.length ? `<h4>Pessoas citadas</h4><div class="chips">${r.people.filter(P).map(id => chip(P(id))).join('')}</div>` : ''}
      ${r.files.length ? `<h4>Material (${r.files.length})</h4><div class="relfiles">${r.files.map(f => { const u = `/api/relatos/${encodeURIComponent(r.id)}/files/${f.id}`; return `<a class="relfile" href="${u}" target="_blank" rel="noopener">${img(f) ? `<img src="${u}" alt="" loading="lazy">` : '<span class="relicon">📄</span>'}<span>${esc(f.name)}</span></a>`; }).join('')}</div>` : ''}
      ${r.ficha ? `<h4>Ficha</h4><div class="mdtext">${mdLite(r.ficha)}</div>` : ''}
      ${r.relato ? `<h4>Relato</h4><div class="mdtext">${mdLite(r.relato)}</div>` : ''}`;
    $('#reldlg').showModal();
  } catch (err) { alertStatus(err); }
}
let rel = null; // { token, decisions, data }
const relNames = {};
async function loadRelatos() {
  const d = await api('/api/admin/relatos');
  const fresh = d.inbox.filter(x => x.state !== 'importado');
  $('#relCount').textContent = fresh.length ? `(${fresh.length} novo${fresh.length > 1 ? 's' : ''})` : '';
  $('#inbox').innerHTML = fresh.length ? `<p class="note">Na pasta de entrada do servidor:</p><table class="tbl"><tbody>${fresh.map(x => `<tr><td><b>${esc(x.folder)}</b><br><span class="note">${x.state === 'mudou' ? 'mudou desde a última importação' : 'novo'}</span></td><td><button type="button" class="primary" data-inbox="${esc(x.folder)}">Abrir</button> <button type="button" class="link" data-inboxignore="${esc(x.folder)}">já lancei, ignorar</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="note">Nenhum relato novo na pasta de entrada. Também pode escolher a pasta de um relato ou um .zip:</p>';
  $('#relList').innerHTML = d.relatos.length ? `<table class="tbl"><tbody>${d.relatos.map(r => `<tr><td><button type="button" class="link" data-relato="${esc(r.id)}">${esc(r.fonte || r.id)}</button><br><span class="note">${esc(r.id)}</span></td><td class="note">relato de ${esc(r.data || '?')}<br>importado ${esc(fmtDate(r.importedAt))}</td><td class="note">${r.applied} aplicada(s)${r.skipped ? `<br>${r.skipped} pulada(s)` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nenhum relato importado ainda.</p>';
  const pd = await api('/api/admin/pending');
  $('#pendList').innerHTML = pd.pending.length ? `<table class="tbl"><tbody>${pd.pending.map(x => `<tr><td>${esc(x.title)}<br><span class="note">relato ${esc(x.relatoId || '')} · ${esc(fmtDate(x.createdAt))}. Para resolver, abra o relato de novo.</span></td><td><button type="button" class="link" data-pendclose="${x.id}">resolvido</button></td></tr>`).join('')}</tbody></table>` : '<p class="none">Nenhuma pendência.</p>';
}
const SUG_KIND = { sibling: 'irmãos', child: 'filho(a)', parent: 'pai/mãe', spouse: 'cônjuges' };
async function loadSuggestions() {
  const d = await api('/api/admin/suggestions');
  $('#sugCount').textContent = d.suggestions.length ? `(${d.suggestions.length})` : '';
  $('#sugList').innerHTML = d.suggestions.length ? d.suggestions.map(x => `<div class="alert"><p><b>${esc(x.person.name)}</b> <span class="tag">${SUG_KIND[x.kind]}</span><br><span class="note">Nota: "${esc(x.quote)}" → ${esc(x.target.name)}</span></p>
      <ul>${x.describe.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="actions small"><button type="button" class="primary" data-sugok="${esc(x.key)}">Ligar</button><button type="button" class="link" data-sugno="${esc(x.key)}">Não é isso</button></div></div>`).join('')
    + (d.suggestions.length > 1 ? `<div class="actions"><button type="button" id="sugAll" data-keys="${esc(d.suggestions.map(x => x.key).join(','))}">Ligar todas (${d.suggestions.length})</button></div>` : '')
    : '<p class="none">Nenhuma sugestão: as notas já batem com as ligações da árvore.</p>';
}
const cand = c => `<div class="cand"><b>${esc(c.name)}</b>${c.nick ? ` (${esc(c.nick)})` : ''}${c.why ? ` <span class="tag">${esc(c.why)}</span>` : ''}
  <div class="note">${[c.birth && '★\uFE0E ' + c.birth, c.death && '✝\uFE0E ' + c.death, c.father && 'pai: ' + c.father, c.mother && 'mãe: ' + c.mother, c.spouse && 'cônjuge: ' + c.spouse, c.relatos && c.relatos.length && 'relatos: ' + c.relatos.join(', ')].filter(Boolean).map(esc).join(' · ') || 'sem outros dados'}</div>`;
// Atalhos para muitos alertas iguais: pessoas que o relato diz serem novas, ou citadas e ainda ausentes.
function bulkHtml(alerts) {
  const dup = alerts.filter(a => a.type === 'duplicate'), miss = alerts.filter(a => a.type === 'missing');
  if (dup.length < 2 && miss.length < 2) return '';
  return `<div class="alert"><p><b>Atalhos</b> <span class="note">confira a lista antes; dá para desfazer cada decisão</span></p><div class="actions">
    ${dup.length > 1 ? `<button type="button" data-bulk="${esc(dup.map(a => a.key).join('\n'))}">Criar as ${dup.length} pessoas novas do relato (não são as parecidas)</button>` : ''}
    ${miss.length > 1 ? `<button type="button" data-bulk="${esc(miss.map(a => a.key).join('\n'))}">Criar as ${miss.length} pessoas citadas que faltam</button>` : ''}</div>
    <p class="note">${dup.length > 1 ? 'Novas com nome parecido a alguém da árvore: ' + dup.map(a => esc(a.name)).join(', ') + '. ' : ''}${miss.length > 1 ? 'Citadas e ainda ausentes: ' + miss.map(a => esc(a.name)).join(', ') + '.' : ''}</p></div>`;
}
function renderRel() {
  const d = rel.data, R = d.relato, decided = Object.entries(rel.decisions);
  const label = v => v === 'new' ? 'criar pessoa nova' : v === 'skip' ? 'pular por enquanto' : v === 'keep' ? 'manter o atual' : v.startsWith('id:') ? 'é ' + (P(v.slice(3))?.name || relNames[v.slice(3)] || 'a pessoa escolhida') : v;
  const rowById = n => d.rows.find(r => r.n === n);
  const rowLine = r => r ? `<li><button type="button" class="link note" data-jump="${r.n}">linha ${r.n}</button> <b>${esc(r.pessoa)}</b> · ${esc(r.acao)} · ${esc(r.campo)}${r.valor ? ': ' + esc(r.valor) : ''}${r.fonte ? `<br><span class="note">fonte: ${esc(r.fonte)}${r.conf ? ' (' + esc(r.conf) + ')' : ''}</span>` : ''}</li>` : '';
  const ctxHtml = a => { const c = a.context || { related: [], excerpts: [] };
    return `<details class="ctx"><summary>Ver o que o relato diz</summary>
      <p class="note">Linhas deste alerta:</p><ul>${a.rows.map(n => rowLine(rowById(n))).join('')}</ul>
      ${c.related.length ? `<p class="note">Outras linhas que citam o mesmo nome:</p><ul>${c.related.map(n => rowLine(rowById(n))).join('')}</ul>` : ''}
      ${c.excerpts.length ? `<p class="note">Trechos do relato:</p>${c.excerpts.map(x => `<blockquote>${x.section ? `<span class="note">${esc(x.section)}</span><br>` : ''}${esc(x.text)}</blockquote>`).join('')}${c.more ? `<p class="note">e mais ${c.more} trecho(s) com o mesmo nome.</p>` : ''}` : `<p class="note">${R.hasRelato ? 'O nome não aparece no texto do relato.' : 'Este relato veio sem relato.md.'}</p>`}
    </details>`; };
  const rowRefs = a => a.rows.map(n => `<button type="button" class="link" data-jump="${n}">${n}</button>`).join(', ');
  const alertHtml = a => a.type === 'divergence'
    ? `<div class="alert"><p><b>${esc(a.title)}</b> <span class="note">(linha ${rowRefs(a)})</span></p>
        <div class="cand"><b>Atual:</b> ${esc(a.current)}<div class="note">${esc(a.currentSource || 'sem fonte registrada')}</div></div>
        <div class="cand"><b>Novo:</b> ${esc(a.proposed)}<div class="note">${esc(a.proposedSource || 'sem fonte')}</div></div>
        <div class="actions"><button type="button" class="primary" data-dec="${esc(a.key)}" data-val="new">Usar o novo</button><button type="button" data-dec="${esc(a.key)}" data-val="keep">Manter o atual</button></div>
        <p class="note">O outro valor fica guardado em nota, com a fonte.</p>${ctxHtml(a)}</div>`
    : `<div class="alert"><p><b>${esc(a.title)}</b> <span class="note">(linha${a.rows.length > 1 ? 's' : ''} ${rowRefs(a)})</span></p>
        ${ctxHtml(a)}
        ${a.candidates.map(c => { relNames[c.id] = c.name; return `${cand(c)}<div class="actions small"><button type="button" class="primary" data-dec="${esc(a.key)}" data-val="id:${esc(c.id)}">É esta pessoa</button></div></div>`; }).join('')}
        <div class="actions"><button type="button" data-dec="${esc(a.key)}" data-val="new">${a.candidates.length ? 'É outra pessoa: criar nova' : 'Criar pessoa nova'}</button><button type="button" class="link" data-dec="${esc(a.key)}" data-val="skip">Pular por enquanto</button></div></div>`;
  const rowTxt = r => r.done ? `<span class="note">${esc(r.done)}</span>` : r.alert ? '<span class="note">aguardando o alerta acima</span>' : r.erro ? `<span class="err">${esc(r.erro)}</span>` : r.skipped ? `<span class="note">${esc(r.skipped)}</span>` : esc(r.ok);
  const nOk = d.rows.filter(r => r.ok).length;
  $('#relWork').innerHTML = `<div class="relbox">
    <p><b>${esc(R.fonte || R.id)}</b>${R.data ? ' · ' + esc(R.data) : ''} <span class="note">(${esc(R.id)})</span></p>
    ${R.existing ? `<p class="hint">Este relato já foi importado${R.importedAt ? ' em ' + esc(fmtDate(R.importedAt)) : ''}. Só as linhas que ainda não entraram serão aplicadas.</p>` : ''}
    ${R.material.length ? `<p class="note">Material: ${R.material.map(f => esc(f.name)).join(', ')} (fica guardado no relato; só o administrador vê).</p>` : ''}
    ${d.applied ? `<p class="hint"><b>Aplicado.</b> ${nOk} linha(s) entraram na árvore.</p>` : d.alerts.length ? `<h4>Primeiro, resolva ${d.alerts.length} alerta${d.alerts.length > 1 ? 's' : ''}</h4>${bulkHtml(d.alerts)}${d.alerts.map(alertHtml).join('')}` : `<p class="hint">Sem alertas. Confira as linhas e toque em Aplicar.</p>`}
    ${decided.length && !d.applied ? `<p class="note">Decisões: ${decided.map(([k, v]) => `${esc(k.includes('|') ? 'divergência' : k)} → ${esc(label(v))} <button type="button" class="link" data-undo="${esc(k)}">desfazer</button>`).join(' · ')}</p>` : ''}
    <h4>Linhas do lote</h4>
    <table class="tbl"><tbody>${d.rows.map(r => `<tr id="rl-${r.n}"><td class="note">${r.n}</td><td><b>${esc(r.pessoa)}</b><br><span class="note">${esc(r.acao)} · ${esc(r.campo)}${r.valor ? ': ' + esc(r.valor) : ''}${r.fonte ? ' · fonte: ' + esc(r.fonte) : ''}</span></td><td>${rowTxt(r)}</td></tr>`).join('')}</tbody></table>
    <div class="actions">${d.applied ? '<button type="button" id="relClose">Fechar</button>' : `<button type="button" class="primary" id="relApply"${d.alerts.length || !nOk ? ' disabled' : ''}>Aplicar ${nOk} linha(s)</button><button type="button" id="relClose">Cancelar</button>`}</div>
  </div>`;
  $('#relWork').scrollIntoView({ block: 'start' });
}
async function relRun(apply) {
  try { rel.data = await api('/api/admin/relatos/run', { method: 'POST', body: { token: rel.token, decisions: rel.decisions, apply } }); renderRel(); if (apply) { await load(); loadRelatos(); } }
  catch (err) { $('#relWork').insertAdjacentHTML('afterbegin', `<p class="err">${esc(err.message)}</p>`); }
}
async function relStart(promise) {
  $('.asec[data-sec="relatos"]').open = true;
  $('#relWork').innerHTML = '<p class="note">Lendo o relato…</p>';
  try { const d = await promise; rel = { token: d.token, decisions: {}, data: d }; renderRel(); }
  catch (err) { $('#relWork').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}
$('#relform').addEventListener('change', e => {
  const list = [...(e.target.files || [])]; if (!list.length) return;
  const fd = new FormData();
  for (const f of list) fd.append('files', f, f.webkitRelativePath || f.name);
  e.target.value = '';
  relStart(api('/api/admin/relatos/upload', { method: 'POST', body: fd }));
});
$('#adlg').addEventListener('click', async e => {
  const ib = e.target.closest('[data-inbox]'); if (ib) { relStart(api('/api/admin/relatos/inbox', { method: 'POST', body: { folder: ib.dataset.inbox } })); return; }
  const ig = e.target.closest('[data-inboxignore]'); if (ig) { if (!(await confirmBtn(ig))) return; await api('/api/admin/relatos/inbox/ignore', { method: 'POST', body: { folder: ig.dataset.inboxignore } }).catch(err => $('#aErr').textContent = err.message); loadRelatos(); return; }
  const jp = e.target.closest('[data-jump]'); if (jp) { const tr = document.getElementById('rl-' + jp.dataset.jump); if (tr) { tr.scrollIntoView({ block: 'center' }); tr.classList.add('flash'); setTimeout(() => tr.classList.remove('flash'), 1600); } return; }
  const dc = e.target.closest('[data-dec]'); if (dc) { rel.decisions[dc.dataset.dec] = dc.dataset.val; relRun(false); return; }
  const bk = e.target.closest('[data-bulk]'); if (bk) { if (!(await confirmBtn(bk))) return; for (const k of bk.dataset.bulk.split('\n')) rel.decisions[k] = 'new'; relRun(false); return; }
  const un = e.target.closest('[data-undo]'); if (un) { delete rel.decisions[un.dataset.undo]; relRun(false); return; }
  if (e.target.closest('#relApply')) { relRun(true); return; }
  if (e.target.closest('#relClose')) { rel = null; $('#relWork').innerHTML = ''; return; }
  const so = e.target.closest('[data-sugok]'); if (so) { try { await api('/api/admin/suggestions/apply', { method: 'POST', body: { key: so.dataset.sugok } }); await load(); loadSuggestions(); } catch (err) { $('#aErr').textContent = err.message; } return; }
  const sn = e.target.closest('[data-sugno]'); if (sn) { await api('/api/admin/suggestions/dismiss', { method: 'POST', body: { key: sn.dataset.sugno } }); loadSuggestions(); return; }
  const sa = e.target.closest('#sugAll'); if (sa) { if (!(await confirmBtn(sa))) return; try { await api('/api/admin/suggestions/apply', { method: 'POST', body: { keys: sa.dataset.keys.split(',') } }); await load(); loadSuggestions(); } catch (err) { $('#aErr').textContent = err.message; } return; }
  const pc = e.target.closest('[data-pendclose]'); if (pc) { await api(`/api/admin/pending/${pc.dataset.pendclose}/close`, { method: 'POST' }); loadRelatos(); return; }
  if (e.target.closest('#dupBtn')) {
    $('#dupList').innerHTML = '<p class="note">Procurando…</p>';
    const d = await api('/api/admin/duplicates');
    $('#dupList').innerHTML = d.pairs.length ? d.pairs.map(x => `<div class="alert"><p class="note">${esc(x.why)}</p>${cand(x.a)}<div class="actions small"><button type="button" data-go="${esc(x.a.id)}">Abrir</button></div></div>${cand(x.b)}<div class="actions small"><button type="button" data-go="${esc(x.b.id)}">Abrir</button></div></div><div class="actions"><button type="button" data-merge="${esc(x.a.id)}|${esc(x.b.id)}">São a mesma: juntar na 1ª</button><button type="button" data-merge="${esc(x.b.id)}|${esc(x.a.id)}">juntar na 2ª</button><button type="button" class="link" data-notdup="${esc(x.a.id)}|${esc(x.b.id)}">São pessoas diferentes</button></div></div>`).join('')
      + '<p class="note">Juntar passa filhos, pais, notas, fotos e relatos para a ficha escolhida; dados diferentes ficam guardados em nota. O site nunca junta sozinho.</p>' : '<p class="none">Nenhum possível duplicado.</p>';
    return; }
  const mg = e.target.closest('[data-merge]'); if (mg) { if (!(await confirmBtn(mg))) return; const [keep, remove] = mg.dataset.merge.split('|'); try { const r = await api('/api/admin/merge', { method: 'POST', body: { keep, remove } }); mg.closest('.alert').outerHTML = `<p class="hint">Juntado.${r.conflicts.length ? ' Dados diferentes guardados em nota: ' + esc(r.conflicts.join('; ')) : ''}</p>`; await load(); } catch (err) { $('#aErr').textContent = err.message; } return; }
  const nd = e.target.closest('[data-notdup]'); if (nd) { const [a, b] = nd.dataset.notdup.split('|'); await api('/api/admin/duplicates/not', { method: 'POST', body: { a, b } }); nd.closest('.alert').remove(); return; }
});

// Primeira vez numa árvore vazia: "Ocê é fi dequem?" começa pela pessoa e pelos pais.
let onboardShown = false;
function maybeOnboard() {
  if (onboardShown || !me || !canWrite() || Object.keys(people).length) return;
  onboardShown = true; $('#onform').reset(); $('#onform').elements.me.value = me.name || ''; $('#onErr').textContent = ''; $('#ondlg').showModal();
}
$('#onform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target.elements;
  try {
    const mk = async (name, extra) => name.trim() ? (await api('/api/people', { method: 'POST', body: { name: name.trim(), ...extra } })).id : '';
    const fatherId = await mk(f.father.value, { sex: 'm' }), motherId = await mk(f.mother.value, { sex: 'f' });
    if (fatherId && motherId) await api('/api/people/' + encodeURIComponent(fatherId), { method: 'PUT', body: { spouseId: motherId } });
    const meId = await mk(f.me.value, { nick: f.nick.value, birth: f.birth.value, fatherId, motherId });
    await api('/api/me/person', { method: 'PUT', body: { personId: meId } });
    me.personId = meId; $('#ondlg').close(); focus = meId; await load();
  } catch (err) { $('#onErr').textContent = err.message; }
});
function renderAll() {
  if (!P(focus)) { const h = decodeURIComponent(location.hash.slice(1)); focus = P(h) ? h : rootPerson() || (Object.values(people).find(p => p.createdBy === me?.id)?.id || Object.keys(people)[0] || null); }
  drawChart(); renderRecord(); renderIndex(); maybeOnboard();
}
addEventListener('hashchange', () => { const h = decodeURIComponent(location.hash.slice(1)); if (P(h) && h !== focus) setFocus(h); });

start().catch(() => { $('#auth').hidden = false; $('#authErr').textContent = 'Não foi possível conectar ao servidor.'; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
