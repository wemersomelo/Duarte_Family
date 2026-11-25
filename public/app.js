'use strict';
(() => {
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let me = null, people = {}, notes = [], files = [], media = [], userNames = {}, focus = null, editing = null, ctx = {};
const P = id => (id && people[id]) ? people[id] : null;
const canWrite = () => !!me && (me.role === 'member' || me.role === 'admin');
const isGuest = () => !!me && me.role === 'guest';
const canContribute = () => !!me && !isGuest();
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
    try { const info = await api('/api/invites/' + encodeURIComponent(inviteToken)); showAuth('invite', info); const em = $('#authForm').elements.email; em.value = info.email || ''; em.readOnly = !!info.email; return; }
    catch (err) { showAuth('login'); $('#authErr').textContent = err.message; return; }
  }
  if (st.needsSetup) return showAuth('setup');
  if (!st.user) { showAuth('login'); if (/link=invalido/.test(location.search)) { $('#authErr').textContent = 'Este link da família não funciona mais. Peça o link novo a quem te enviou.'; history.replaceState(null, '', '/'); } return; }
  if (m) history.replaceState(null, '', '/');
  me = st.user;
  $('#auth').hidden = true; $('#main').hidden = false;
  $('#whoami').textContent = me.name;
  $('#adminBtn').hidden = me.role !== 'admin';
  $('#pwBtn').hidden = isGuest();
  $('#askBtn').hidden = !isGuest();
  $('#adminBtn').textContent = st.pendingRequests ? `Administrar (${st.pendingRequests})` : 'Administrar';
  $('#how').hidden = isGuest();
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
    $('#status').textContent = `${n} pessoas na árvore. ` + (isGuest() ? 'Você está vendo pelo link da família: das pessoas vivas aparecem só o nome e as ligações. Para deixar lembranças ou fotos, peça um convite ao administrador.' : canWrite() ? 'Você pode adicionar pessoas, informações e documentos; só altera o que você mesmo adicionou.' : 'Você pode ver a árvore e deixar lembranças, fotos, vídeos e links.');
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
const isMobile = () => innerWidth < 700;
let viewStyle = 'tree';
try { viewStyle = localStorage.getItem('viewStyle') || 'tree'; } catch {}
$('#viewStyle').value = viewStyle;
$('#viewStyle').addEventListener('change', e => { viewStyle = e.target.value; try { localStorage.setItem('viewStyle', viewStyle); } catch {} drawChart(); });
function drawChart() {
  fig.classList.toggle('illus', viewStyle === 'tree');
  if (viewStyle === 'tree') return drawTree();
  if (isMobile()) return drawVertical(); drawHorizontal();
}
// Número estável a partir de um texto (para as folhas ficarem sempre no mesmo lugar).
const seed = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; };
// Árvore ilustrada: a pessoa é a árvore (copa, tronco e o nome na faixa);
// os antepassados são as raízes, descendo pela terra geração por geração.
function drawTree() {
  const G = +$('#gens').value, p = P(focus);
  if (!p) { fig.innerHTML = '<p class="none" style="padding:20px 0">Nenhuma pessoa selecionada.</p>'; fig.style.cssText = ''; return; }
  $('#chartTitle').textContent = 'Raízes de ' + (p.nick || p.name.split(' ')[0]);
  const mob = isMobile(), slots = 2 ** (G - 1);
  const CW = mob ? 80 : 128, CH = mob ? 70 : 64, GX = mob ? 6 : 10, RH = mob ? 116 : 118, M = mob ? 6 : 16;
  const avail = (fig.parentElement.clientWidth || innerWidth) - 2;
  const W = Math.max(slots * (CW + GX) + 2 * M, Math.min(avail, 1180));
  const cx = W / 2, TOP = 8, crownH = mob ? 230 : 250, crownCy = TOP + crownH / 2;
  const crownRx = Math.min(W / 2 - 8, mob ? 175 : 290), crownRy = crownH / 2;
  const groundY = TOP + crownH + (mob ? 95 : 105);
  const rowTop = g => groundY + 46 + (g - 1) * RH;
  // raízes se abrem: as das pontas ficam um pouco mais rasas que as do meio
  const rise = (g, x) => g < 2 ? 0 : Math.round(RH * 0.35 * (g / (G - 1)) * ((x - cx) / (W / 2)) ** 2);
  const H = rowTop(G - 1) + CH + 30;
  fig.style.cssText = `--cw:${CW}px;width:${W}px;height:${H}px`;
  const rnd = seed(focus);
  const leaf = (x, y, r, rot, shade) => `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(r * 0.45).toFixed(1)}" ry="${r.toFixed(1)}" transform="rotate(${rot.toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${shade ? 'var(--leaf2)' : 'var(--leaf)'}"/>`;

  // ---- céu e copa
  let sky = `<ellipse cx="${cx}" cy="${crownCy}" rx="${crownRx}" ry="${crownRy}" fill="var(--canopy)"/>`;
  const tw = mob ? 22 : 30, trunkTop = crownCy + crownRy * 0.35;
  let trunk = `<path d="M${cx - tw * 1.5} ${groundY + 4} C${cx - tw * .6} ${groundY - 20},${cx - tw * .5} ${trunkTop + 40},${cx - tw * .45} ${trunkTop} L${cx + tw * .45} ${trunkTop} C${cx + tw * .5} ${trunkTop + 40},${cx + tw * .6} ${groundY - 20},${cx + tw * 1.5} ${groundY + 4} Z" fill="var(--bark)"/>`;
  // galhinhos subindo para a copa
  for (const s of [-1, 1]) trunk += `<path d="M${cx + s * tw * .2} ${trunkTop + 20} C${cx + s * tw * .6} ${trunkTop - 10},${cx + s * crownRx * .35} ${crownCy},${cx + s * crownRx * .55} ${crownCy - crownRy * .35}" stroke="var(--bark)" stroke-width="${mob ? 7 : 9}" fill="none" stroke-linecap="round"/>`;
  let crownLeaves = '';
  const nC = Math.round((crownRx * crownRy) / (mob ? 150 : 210));
  for (let k = 0; k < nC; k++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd());
    crownLeaves += leaf(cx + Math.cos(a) * crownRx * d, crownCy + Math.sin(a) * crownRy * d, (mob ? 7 : 9) + rnd() * 5, rnd() * 180, rnd() > .45);
  }
  for (let k = 0, n = mob ? 60 : 90; k < n; k++) {
    const a = (k / n) * Math.PI * 2, j2 = 0.93 + rnd() * 0.1;
    crownLeaves += leaf(cx + Math.cos(a) * crownRx * j2, crownCy + Math.sin(a) * crownRy * j2, (mob ? 8 : 11) + rnd() * 5, a * 180 / Math.PI + 90 + rnd() * 30, rnd() > .5);
  }

  // ---- terra
  let soil = `<defs><linearGradient id="soilg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--soil1)"/><stop offset="1" stop-color="var(--soil2)"/></linearGradient></defs>
    <rect x="0" y="${groundY}" width="${W}" height="${H - groundY}" fill="url(#soilg)"/>`;
  for (let k = 0, n = Math.round(W * (H - groundY) / 2600); k < n; k++)
    soil += `<ellipse cx="${(rnd() * W).toFixed(0)}" cy="${(groundY + 8 + rnd() * (H - groundY - 12)).toFixed(0)}" rx="${(1.5 + rnd() * 3).toFixed(1)}" ry="${(1 + rnd() * 2).toFixed(1)}" fill="var(--pebble)"/>`;
  let grass = '';
  for (let gx = 4; gx < W; gx += 8) grass += `<path d="M${gx} ${groundY + 2}l${(rnd() * 6 - 3).toFixed(1)} ${-(5 + rnd() * 9).toFixed(1)}" stroke="var(--leaf)" stroke-width="2" stroke-linecap="round"/>`;

  // ---- raízes e plaquinhas dos antepassados
  let roots = '', cards = '', labels = '';
  const names = ['', 'Pais', 'Avós', 'Bisavós', 'Tataravós'];
  for (let g = 1; g < G; g++) labels += `<div class="rowLabel" style="top:${Math.max(groundY + 6, rowTop(g) - rise(g, M + CW / 2) - 19)}px">${names[g]}</div>`;
  const root = (x0, y0, x1, y1, w) => {
    const my = (y0 + y1) / 2;
    roots += `<path d="M${x0} ${y0}C${x0} ${my},${x1} ${my},${x1} ${y1}" fill="none" stroke="var(--root)" stroke-width="${w}" stroke-linecap="round"/>`;
    for (const t of [0.3, 0.55, 0.8]) { // radicelas
      const it = 1 - t, x = it ** 3 * x0 + 3 * it * it * t * x0 + 3 * it * t * t * x1 + t ** 3 * x1, y = it ** 3 * y0 + 3 * it * it * t * my + 3 * it * t * t * my + t ** 3 * y1;
      const s = rnd() > .5 ? 1 : -1, L = 8 + rnd() * 12;
      roots += `<path d="M${x.toFixed(1)} ${y.toFixed(1)}q${(s * L * .6).toFixed(1)} ${(L * .3).toFixed(1)} ${(s * L).toFixed(1)} ${(L * .9).toFixed(1)}" stroke="var(--root)" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
    }
  };
  const plaque = (q, x, y, w, h, extra = '') => {
    const av = q.photoFileId ? `<img class="av" src="/api/files/${encodeURIComponent(q.photoFileId)}" alt="" loading="lazy">` : '';
    const meta = q.living ? '' : yr(q);
    const nm = mob && w < 100 ? (s => { const a = String(s).split(' '); return a.length > 2 ? a[0] + ' ' + a[a.length - 1] : s; })(q.name) : q.name;
    return `<button type="button" class="card plaque${extra}" data-id="${esc(q.id)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px" title="${esc(q.name)}">${av}<span class="nm">${esc(nm)}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</button>`;
  };
  const place = (id, g, i, childId, role, x0, y0) => {
    const n = 2 ** g, xc = (i + .5) * (W - 2 * M) / n + M, y = Math.max(groundY + 30, rowTop(g) - rise(g, xc)), x = xc - CW / 2;
    const q = P(id); if (!q && !(childId && canWrite())) return;
    root(x0, y0, xc, y + 2, Math.max(3, (mob ? 13 : 17) - g * 3.4));
    if (q) {
      cards += plaque(q, x, y, CW, CH);
      if (g < G - 1) { place(q.fatherId, g + 1, i * 2, q.id, 'father', xc, y + CH - 2); place(q.motherId, g + 1, i * 2 + 1, q.id, 'mother', xc, y + CH - 2); }
    } else {
      cards += `<button type="button" class="card plaque empty" data-add="${role}" data-child="${esc(childId)}" style="left:${x}px;top:${y}px;height:${CH}px">+ ${role === 'father' ? 'Pai' : 'Mãe'}</button>`;
    }
  };
  if (G > 1) { place(p.fatherId, 1, 0, p.id, 'father', cx - tw * .7, groundY); place(p.motherId, 1, 1, p.id, 'mother', cx + tw * .7, groundY); }

  // ---- a pessoa: plaquinha na copa e o nome na faixa sobre o tronco
  const PW = mob ? 150 : 190, PH = mob ? 84 : 86;
  cards += plaque(p, cx - PW / 2, crownCy - PH / 2 - 10, PW, PH, ' focus big');
  const rw = Math.min(W - 24, mob ? 300 : 440), ry = groundY - (mob ? 58 : 62);
  const ribbon = `<path d="M${cx - rw / 2 - 24} ${ry + 12} l24 6 l-9 15 l${rw + 18} 0 l-9 -15 l24 -6 l-18 -9 Z" fill="var(--ribbon2)"/>
    <path d="M${cx - rw / 2} ${ry} Q${cx} ${ry - 12} ${cx + rw / 2} ${ry} L${cx + rw / 2} ${ry + 36} Q${cx} ${ry + 23} ${cx - rw / 2} ${ry + 36} Z" fill="var(--ribbon)" stroke="var(--plaque-line)" stroke-width="1.5"/>`;
  const ribbonText = `<div class="ribbonText" style="top:${ry + 1}px">${esc(p.name)}</div>`;

  fig.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${soil}${roots}${sky}${trunk}${crownLeaves}${grass}${ribbon}</svg>${labels}${ribbonText}${cards}`;
  const sc = fig.parentElement; sc.scrollLeft = (W - sc.clientWidth) / 2;
}
// Celular: árvore em pé. A pessoa fica embaixo (o tronco) e os antepassados sobem como galhos.
function drawVertical() {
  const G = +$('#gens').value, p = P(focus);
  if (!p) { fig.innerHTML = '<p class="none" style="padding:20px 0">Nenhuma pessoa selecionada.</p>'; fig.style.cssText = ''; return; }
  $('#chartTitle').textContent = 'Antepassados de ' + (p.nick || p.name.split(' ')[0]);
  const slots = 2 ** (G - 1), CW = 92, GX = 6, CH = 78, RH = 112, TOP = 10;
  const W = Math.max(slots * (CW + GX), innerWidth - 32), H = TOP + G * RH;
  fig.style.cssText = `--cw:${CW}px;width:${W}px;height:${H}px`;
  let html = '', lines = '';
  const short = n => { const parts = String(n).split(' '); return parts.length > 2 ? parts[0] + ' ' + parts[parts.length - 1] : n; };
  const place = (id, g, i, childId, role, cx0, cy0) => {
    const n = 2 ** g, cx = (i + .5) * W / n, y = TOP + (G - 1 - g) * RH, x = cx - CW / 2;
    const q = P(id); if (!q && !(childId && canWrite())) return;
    if (g > 0) { const mid = y + CH + (cy0 - y - CH) / 2; lines += `<path d="M${cx0} ${cy0}V${mid}H${cx}V${y + CH}" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>`; }
    if (q) {
      const av = q.photoFileId ? `<img class="av" src="/api/files/${encodeURIComponent(q.photoFileId)}" alt="" loading="lazy">` : '';
      const meta = q.living ? '' : yr(q);
      html += `<button type="button" class="card v${g === 0 ? ' focus' : ''}" data-id="${esc(q.id)}" style="left:${x}px;top:${y}px;height:${CH}px" title="${esc(q.name)}">${av}<span class="nm">${esc(short(q.name))}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</button>`;
      if (g < G - 1) { place(q.fatherId, g + 1, i * 2, q.id, 'father', cx, y); place(q.motherId, g + 1, i * 2 + 1, q.id, 'mother', cx, y); }
    } else {
      html += `<button type="button" class="card v empty" data-add="${role}" data-child="${esc(childId)}" style="left:${x}px;top:${y}px;height:${CH}px">+ ${role === 'father' ? 'Pai' : 'Mãe'}</button>`;
    }
  };
  place(focus, 0, 0, null, null, 0, 0);
  fig.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" style="color:var(--ink)">${lines}</svg>` + html;
  const sc = fig.parentElement; sc.scrollLeft = (W - sc.clientWidth) / 2;
}
function drawHorizontal() {
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
      const meta = q.living ? 'dados privados' : [yr(q), q.birthPlace].filter(Boolean).join(' · ');
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
if (isMobile()) $('#gens').value = '3';
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
  <dl>${row('Nascimento', p.birth)}${row('Local', p.birthPlace)}${row('Falecimento', p.death)}${row('Local', p.deathPlace)}${row('Cor/raça', COLOR[p.color])}${row('Origem/etnia', p.origin)}${row('Histórias', p.notes, 1)}${row('Fontes', p.sources, 1)}</dl>
  ${!p.birth && !p.birthPlace && !p.notes ? '<p class="none">Ainda faltam informações sobre esta pessoa. Se você sabe algo, acrescente.</p>' : ''}
  ${isGuest() ? '' : `<p class="by">Registrado por ${esc(who(p.createdBy))}</p>`}
  ${p.living ? '<p class="none">Dados de pessoas vivas (datas, lugares, fotos e lembranças) ficam visíveis só para quem tem convite.</p>' : ''}
  ${canContribute() ? `<div class="actions">${canWrite() ? '<button type="button" class="primary" data-act="note">+ Acrescentar informação</button>' : ''}<button type="button"${canWrite() ? '' : ' class="primary"'} data-act="memory">+ Deixar uma lembrança</button><button type="button" data-act="files">+ Fotos e documentos</button><button type="button" data-act="link">+ Vídeo ou link</button></div>` : ''}
  ${canWrite() ? `<div class="actions small"><button type="button" data-act="child">+ Filho ou filha</button><button type="button" data-act="spouse">+ Cônjuge</button>${ed ? '<button type="button" data-act="edit">Editar</button><button type="button" class="danger" data-act="del">Excluir</button>' : ''}</div>` : ''}
  ${p.living ? '' : `<h4>Fotos e documentos (${pf.length})</h4>
  ${pf.length ? `<div class="docs">${pf.map(f => `<div class="doc${f.id === p.photoFileId ? ' main' : ''}"><button type="button" class="thumb${f.mime === 'application/pdf' ? ' pdf' : ''}" data-view="${esc(f.id)}" ${isImg(f) ? `style="background-image:url('/api/files/${encodeURIComponent(f.id)}')"` : ''} aria-label="Abrir ${esc(f.name)}">${f.mime === 'application/pdf' ? 'PDF' : /hei[cf]/.test(f.mime) ? 'HEIC' : ''}</button><small title="${esc(f.caption || f.name)}">${esc(f.caption || f.name)}</small>${f.id === p.photoFileId ? '<small class="star">foto principal</small>' : ed && isImg(f) ? `<button type="button" class="link" data-mainphoto="${esc(f.id)}">usar como foto principal</button>` : ''}${mine(f) ? `<button type="button" class="link" data-rmfile="${esc(f.id)}">remover</button>` : ''}</div>`).join('')}</div>` : '<p class="none">Nenhum ainda.</p>'}
  <h4>Vídeos e links (${pm.length})</h4>
  ${pm.length ? `<ul class="mlinks">${pm.map(m => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer"><span class="tag">${esc(kindOf(m.url))}</span>${esc(m.title || host(m.url))}</a><small>${esc(host(m.url))} · ${esc(who(m.createdBy))}, ${esc(fmtDate(m.createdAt))}${mine(m) ? ` · <button type="button" class="link" data-rmlink="${m.id}">remover</button>` : ''}</small></li>`).join('')}</ul>` : '<p class="none">Nenhum ainda.</p>'}
  <h4>Lembranças da família (${mem.length})</h4>
  ${mem.length ? noteList(mem) : '<p class="none">Nenhuma ainda. Conte uma história, uma lembrança ou algo que você aprendeu com esta pessoa.</p>'}
  <h4>Informações da família (${info.length})</h4>
  ${info.length ? noteList(info) : '<p class="none">Nenhuma ainda.</p>'}`}`;
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
  btn.dataset.armed = '1'; const t = btn.textContent; btn.textContent = 'clique de novo para confirmar';
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
  const hits = Object.values(people).filter(p => norm([p.name, p.nick, p.birthPlace, p.deathPlace, p.origin, COLOR[p.color], p.notes].join(' ')).includes(t)).sort(byName).slice(0, 30);
  res.innerHTML = hits.length ? hits.map(p => `<button type="button" data-hit="${esc(p.id)}">${esc(p.name)}<small>${esc([p.nick, yr(p), p.birthPlace].filter(Boolean).join(' · ') || 'sem datas')}</small></button>`).join('') : '<p class="none" style="padding:12px 14px;margin:0">Ninguém encontrado. Você pode adicionar essa pessoa.</p>';
  res.style.display = 'block';
}
q.addEventListener('input', search); q.addEventListener('focus', search);
q.addEventListener('keydown', e => { if (e.key === 'Escape') { q.value = ''; res.style.display = 'none'; } if (e.key === 'Enter') { const f = res.querySelector('[data-hit]'); if (f) f.click(); } });
res.addEventListener('click', e => { const b = e.target.closest('[data-hit]'); if (!b) return; res.style.display = 'none'; q.value = ''; go(b.dataset.hit); });
document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) res.style.display = 'none'; });

/* ---------- formulário de pessoa ---------- */
const FIELDS = ['name', 'nick', 'sex', 'birth', 'birthPlace', 'death', 'deathPlace', 'fatherId', 'motherId', 'spouseId', 'color', 'origin', 'notes', 'sources'];
const COLOR = { branca: 'Branca', preta: 'Preta', parda: 'Parda', amarela: 'Amarela', indigena: 'Indígena' };
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
  for (const f of FIELDS) { const el = form.elements[f]; if (el.tagName !== 'SELECT' || f === 'sex' || f === 'color') el.value = p[f] || ''; }
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

/* ---------- documentos ---------- */
const fdlg = $('#fdlg'), fform = $('#fform'); let filePerson = null;
function openFiles(id) { if (!canContribute()) return; filePerson = id; $('#fTitle').textContent = 'Fotos e documentos de ' + P(id).name; fform.reset(); $('#fErr').textContent = ''; fdlg.showModal(); }
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

/* ---------- pedir para participar ---------- */
$('#askBtn').addEventListener('click', () => { $('#rform').reset(); $('#rErr').textContent = ''; $('#rdlg').showModal(); });
$('#rform').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try {
    await api('/api/access-requests', { method: 'POST', body: { name: f.elements.name.value, email: f.elements.email.value, relation: f.elements.relation.value, message: f.elements.message.value } });
    $('#rdlg').close(); $('#status').textContent = 'Pedido enviado. Você vai receber um convite quando o administrador aprovar.';
  } catch (err) { $('#rErr').textContent = err.message; }
});

/* ---------- administração ---------- */
const REQ_STATUS = { pending: 'aguardando', approved: 'aprovado, convite enviado?', rejected: 'recusado', joined: 'entrou' };
async function loadRequests() {
  const d = await api('/api/admin/access-requests'), box = $('#requests');
  const pend = d.requests.filter(r => r.status === 'pending');
  $('#reqCount').textContent = pend.length ? `(${pend.length} aguardando)` : '';
  $('#adminBtn').textContent = pend.length ? `Administrar (${pend.length})` : 'Administrar';
  box.innerHTML = d.requests.length ? `<table class="tbl"><tbody>${d.requests.map(r => `<tr><td><b>${esc(r.name)}</b><br><span class="note">${esc(r.email)}</span></td><td>${esc(r.relation)}${r.message ? `<br><span class="note">${esc(r.message)}</span>` : ''}</td><td class="note">${esc(fmtDate(r.createdAt))}</td><td>${r.status === 'pending'
    ? `<select data-reqrole="${r.id}"><option value="member">Pode adicionar</option><option value="viewer">Ver e deixar lembranças</option></select> <button type="button" class="primary" data-approve="${r.id}">Aprovar</button> <button type="button" class="link" data-reject="${r.id}">recusar</button>`
    : `${esc(REQ_STATUS[r.status] || r.status)}${r.status === 'approved' && r.inviteToken ? ` <button type="button" class="link" data-copyurl="${esc(inviteUrl(r.inviteToken))}">copiar convite</button>` : ''}`}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nenhum pedido. Quem entra pelo link da família pode pedir para participar.</p>';
}
async function loadActivity() {
  const box = $('#activity');
  try {
    const d = await api('/api/admin/activity');
    box.innerHTML = d.activity.length ? `<table class="tbl"><tbody>${d.activity.map(a => `<tr><td>${esc(new Date(a.at).toLocaleString('pt-BR'))}</td><td>${esc(a.name || 'sistema')}</td><td>${esc(a.action)}</td><td>${P(a.target) ? `<button type="button" class="link" data-go="${esc(a.target)}">${esc(P(a.target).name)}</button>` : esc(a.target || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nada registrado ainda.</p>';
  } catch (err) { box.textContent = err.message; }
}
const ROLE = { admin: 'Administrador', member: 'Pode adicionar', viewer: 'Ver e deixar lembranças' };
async function loadFamilyLink() {
  const d = await api('/api/admin/family-link'), box = $('#famLink');
  const url = d.token ? `${location.origin}/familia/${d.token}` : '';
  box.innerHTML = url ? `<div class="newinv"><b>Link ativo:</b><br><span>${esc(url)}</span><br><button type="button" class="primary" data-copyurl="${esc(url)}">Copiar link</button></div>
    <div class="actions"><button type="button" id="famNew">Trocar link (o atual para de funcionar)</button><button type="button" class="danger" id="famOff">Desligar link</button></div>`
    : `<p class="none">Nenhum link ativo.</p><div class="actions"><button type="button" class="primary" id="famNew">Criar link da família</button></div>`;
}
async function loadAdmin() {
  $('#aErr').textContent = '';
  loadFamilyLink().catch(err => $('#aErr').textContent = err.message);
  loadRequests().catch(err => $('#aErr').textContent = err.message);
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
  const ap = e.target.closest('[data-approve]'); if (ap) {
    try {
      const role = $(`[data-reqrole="${ap.dataset.approve}"]`).value;
      const r = await api(`/api/admin/access-requests/${ap.dataset.approve}/approve`, { method: 'POST', body: { role } });
      const url = inviteUrl(r.token), box = $('#newInvite'); box.hidden = false;
      const msg = `Oi, ${r.name}! Seu acesso à árvore da família foi aprovado. Crie sua conta com o e-mail ${r.email} neste link (vale 30 dias): ${url}`;
      box.innerHTML = `<b>Aprovado.</b> Mande este convite para ${esc(r.name)} (só funciona com o e-mail <b>${esc(r.email)}</b>):<br><span>${esc(url)}</span><br><div class="actions"><button type="button" class="primary" data-copyurl="${esc(msg)}">Copiar mensagem pronta</button><a class="btn" href="mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent('Convite: árvore da família')}&body=${encodeURIComponent(msg)}">Abrir e-mail</a></div>`;
      box.scrollIntoView({ block: 'nearest' }); loadRequests();
    } catch (err) { $('#aErr').textContent = err.message; }
    return; }
  const rj = e.target.closest('[data-reject]'); if (rj) { if (!(await confirmBtn(rj))) return; await api(`/api/admin/access-requests/${rj.dataset.reject}/reject`, { method: 'POST' }).catch(err => $('#aErr').textContent = err.message); loadRequests(); return; }
  if (e.target.closest('#famNew')) { if (e.target.closest('#famNew').textContent.startsWith('Trocar') && !(await confirmBtn(e.target.closest('#famNew')))) return; await api('/api/admin/family-link', { method: 'POST' }).catch(err => $('#aErr').textContent = err.message); loadFamilyLink(); return; }
  if (e.target.closest('#famOff')) { if (!(await confirmBtn(e.target.closest('#famOff')))) return; await api('/api/admin/family-link', { method: 'DELETE' }).catch(err => $('#aErr').textContent = err.message); loadFamilyLink(); return; }
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
