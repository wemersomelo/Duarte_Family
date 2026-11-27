// Tema: "auto" segue o aparelho; "light" (versão A), "dark" (versão B) ou "green" (versão C) é a escolha da pessoa, guardada neste aparelho.
(function () {
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function pref() { try { return localStorage.getItem('tema') || 'auto'; } catch (e) { return 'auto'; } }
  function apply() {
    var p = pref(), t = p === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : p;
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', { dark: '#3C3A2F', green: '#5B673C' }[t] || '#F8EFE6');
    var lbl = { auto: 'Tema: auto', light: 'Tema: claro', dark: 'Tema: escuro', green: 'Tema: verde' }[p];
    document.querySelectorAll('[data-themebtn]').forEach(function (b) { b.textContent = lbl; b.title = 'Trocar: automático (como o aparelho), claro, escuro ou verde'; });
  }
  window.cycleTheme = function () {
    var next = { auto: 'light', light: 'dark', dark: 'green', green: 'auto' }[pref()] || 'auto';
    try { localStorage.setItem('tema', next); } catch (e) {}
    apply();
  };
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  apply();
  document.addEventListener('DOMContentLoaded', apply);
})();
