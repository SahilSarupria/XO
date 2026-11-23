// Applies a stored theme choice before first paint (D-18: dark is the default and is never stored). Loaded synchronously from
// index.html; kept tiny and dependency-free. src/ui/theme.ts owns the choice after start-up.
(function () {
  var t = 'dark';
  try {
    var v = window.localStorage.getItem('xo.studio.theme');
    if (v === 'light') t = 'light';
    else if (v === 'system' && window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches) t = 'light';
  } catch (e) {
    /* storage unavailable: the default stays */
  }
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.colorScheme = t;
})();
