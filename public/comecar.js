// Página pública: pedido do livro de uma família nova.
document.addEventListener('click', e => { if (e.target.closest('[data-themebtn]')) window.cycleTheme(); });
const f = document.getElementById('bookform');
f.addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('bookErr'), btn = document.getElementById('bookBtn');
  err.textContent = ''; btn.disabled = true;
  const body = Object.fromEntries(new FormData(f)); body.consent = f.elements.consent.checked;
  try {
    const r = await fetch('/api/livro-pedido', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Não foi possível enviar. Tente de novo.');
    f.hidden = true; document.getElementById('bookOk').hidden = false;
  } catch (x) { err.textContent = x.message; btn.disabled = false; }
});
