/* ── SERVICE WORKER AUTO-UPDATE ─── */
if ('serviceWorker' in navigator) {
  // When a new SW takes over, reload so the fresh assets are used
  // but only if not mid-game to avoid a jarring flash
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!document.body.classList.contains('game-active')) {
      window.location.reload();
    }
  });
  // Check for a new SW whenever the app comes back into view
  // (covers iOS PWA resuming from background without a navigation)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg) reg.update();
      });
    }
  });
}

/* ── STARFIELD ─── */
(function () {
  var container = document.getElementById('stars');
  for (var i = 0; i < 80; i++) {
    var s = document.createElement('div');
    s.className = 'star';
    var size = Math.random() * 2.5 + 0.5;
    s.style.cssText = 'width:' + size + 'px;height:' + size + 'px;' +
      'top:' + (Math.random() * 100).toFixed(2) + '%;' +
      'left:' + (Math.random() * 100).toFixed(2) + '%;' +
      '--dur:' + (2 + Math.random() * 5).toFixed(1) + 's;' +
      '--delay:-' + (Math.random() * 6).toFixed(1) + 's;';
    container.appendChild(s);
  }
})();

/* ── THEME TOGGLE ─── */
(function () {
  var html  = document.documentElement;
  var btn   = document.getElementById('themeToggle');
  var icon  = document.getElementById('theme-icon');
  var label = document.getElementById('theme-label');

  function applyTheme(dark) {
    html.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (icon)  icon.textContent  = dark ? '☀️' : '🌙';
    if (label) label.textContent = dark ? 'Light' : 'Dark';
  }

  btn.addEventListener('click', function () {
    var isDark = html.getAttribute('data-theme') === 'dark';
    applyTheme(!isDark);
    localStorage.setItem('gta-lorcana-theme', isDark ? 'light' : 'dark');
  });

  var saved = localStorage.getItem('gta-lorcana-theme');
  if (saved) applyTheme(saved === 'dark');
})();
