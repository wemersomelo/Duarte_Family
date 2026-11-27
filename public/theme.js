// Tema: "auto" segue o aparelho; "light" (versão A) ou "dark" (versão B) é a escolha da pessoa, guardada neste aparelho.
(function () {
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function pref() { try { return localStorage.getItem('tema') || 'auto'; } catch (e) { return 'auto'; } }
  function apply() {
    var p = pref(), dark = p === 'dark' || (p === 'auto' && mq && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', dark ? '#3C3A2F' : '#F8EFE6');
    var lbl = { auto: 'Tema: auto', light: 'Tema: claro', dark: 'Tema: escuro' }[p];
    document.querySelectorAll('[data-themebtn]').forEach(function (b) { b.textContent = lbl; b.title = 'Trocar: automático (como o aparelho), claro ou escuro'; });
  }
  window.cycleTheme = function () {
    var next = { auto: 'light', light: 'dark', dark: 'auto' }[pref()];
    try { localStorage.setItem('tema', next); } catch (e) {}
    apply();
  };
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  apply();
  document.addEventListener('DOMContentLoaded', apply);
})();
