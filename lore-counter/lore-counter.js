/* ── lore-counter.js ─────────────────────────────────────────────────────── */

// ── Constants ──────────────────────────────────────────────
const STORAGE_KEY = 'gta-lorcana-counter-state';
const WIN_LORE    = 20;
const MAX_HISTORY = 50;
const BATCH_MS    = 600; // rapid taps within this window merge into one history entry

// ── State ──────────────────────────────────────────────────
let state = {
  screen:          'setup',
  playerCount:     2,
  matchFormat:     'bo1',  // 'bo1' | 'bo3'
  gameNumber:      1,
  matchScore:      [],     // game wins per player index
  players:         [],     // [{ name, lore }]
  history:         [],     // newest first: [{ playerIndex, name, delta, result, seq }]
  winPromptPlayer: null,   // playerIndex who triggered the win prompt | null
  seq:             0,
};

// ── Persistence ────────────────────────────────────────────
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (saved && Array.isArray(saved.players) && saved.players.length > 0) {
      Object.assign(state, saved);
      return true;
    }
  } catch (_) {}
  return false;
}

// ── DOM refs ───────────────────────────────────────────────
const setupScreen      = document.getElementById('setup-screen');
const gameContainer    = document.getElementById('game-container');
const matchStrip       = document.getElementById('match-strip');
const winPrompt        = document.getElementById('win-prompt');
const winPromptTitle   = document.getElementById('win-prompt-title');
const winPromptScore   = document.getElementById('win-prompt-score');
const winPromptNext    = document.getElementById('win-prompt-next');
const winPromptDismiss = document.getElementById('win-prompt-dismiss');
const newGameQuick     = document.getElementById('new-game-quick');
const installBanner    = document.getElementById('install-banner');
const installBtn       = document.getElementById('install-btn');
const playerNamesEl    = document.getElementById('player-names');

// ── Two-step confirm timers ────────────────────────────────
let newGameQuickTimer = null;

// ── Tap batching ───────────────────────────────────────────
let pendingBatch = null; // { playerIndex, prevLore, delta }
let batchTimer   = null;

// ── Utilities ──────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Screen switching ───────────────────────────────────────
function showSetup() {
  state.screen = 'setup';
  document.body.classList.remove('game-active');
  setupScreen.style.display = '';
  saveState();
  renderSetup();
  if (deferredInstall) installBanner.classList.add('visible');
  showInstallBanner();
}

function showGame() {
  state.screen = 'game';
  document.body.classList.add('game-active');
  setupScreen.style.display = 'none';
  saveState();
  renderGame();
}

// ── Setup screen ───────────────────────────────────────────
function renderSetup() {
  // Sync match format radios
  document.querySelectorAll('input[name="match-format"]').forEach(function(r) {
    r.checked = r.value === state.matchFormat;
  });

  // Render name inputs
  playerNamesEl.innerHTML = '';
  for (let i = 0; i < state.playerCount; i++) {
    const savedName  = state.players[i] ? state.players[i].name : '';
    const defaultName = 'Player ' + (i + 1);
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML =
      '<label for="name-' + i + '">Player ' + (i + 1) + '</label>' +
      '<input type="text" id="name-' + i + '" value="' + escAttr(savedName || defaultName) + '" placeholder="' + escAttr(defaultName) + '" maxlength="20" autocomplete="off" />';
    playerNamesEl.appendChild(field);
  }

  const first = playerNamesEl.querySelector('input');
  if (first) first.focus();
}

function startGame() {
  const inputs = playerNamesEl.querySelectorAll('input');
  state.players = [];
  inputs.forEach(function(inp, i) {
    state.players.push({
      name: inp.value.trim() || ('Player ' + (i + 1)),
      lore: 0,
    });
  });
  state.history         = [];
  state.seq             = 0;
  state.gameNumber      = 1;
  state.matchScore      = state.players.map(function() { return 0; });
  state.winPromptPlayer = null;
  showGame();
}

// ── Game screen ────────────────────────────────────────────
function renderGame() {
  gameContainer.setAttribute('data-players', state.playerCount);
  updateMatchStrip();

  gameContainer.innerHTML = '';
  var renderOrder = state.playerCount === 2 ? [1, 0] : state.players.map(function(_, i) { return i; });
  renderOrder.forEach(function(i) {
    var player = state.players[i];
    const isTop = (i === 1 && state.playerCount === 2);
    const panel = document.createElement('div');
    panel.className = 'player-panel' + (player.lore >= WIN_LORE ? ' winner' : '');
    panel.setAttribute('data-index', i);
    if (isTop) panel.setAttribute('data-pos', 'top');

    panel.innerHTML =
      '<div class="win-banner">✦ ' + escHtml(player.name) + ' wins! ✦</div>' +
      '<span class="player-name" data-index="' + i + '" tabindex="0" role="button" aria-label="Edit name">' + escHtml(player.name) + '</span>' +
      '<input class="name-input" data-index="' + i + '" type="text" value="' + escAttr(player.name) + '" maxlength="20" autocomplete="off" aria-label="Player name" />' +
      '<div class="score-display" id="score-' + i + '">' + player.lore + '</div>' +
      '<div class="score-btns">' +
        '<button class="score-btn score-btn-minus" data-index="' + i + '" data-delta="-1" aria-label="Minus 1"' + (player.lore === 0 ? ' disabled' : '') + '>−</button>' +
        '<button class="score-btn score-btn-plus"  data-index="' + i + '" data-delta="1"  aria-label="Plus 1">+</button>' +
      '</div>' +
      '<div class="panel-history" data-index="' + i + '"></div>';

    gameContainer.appendChild(panel);
  });

  renderHistory(false);
}

// ── Match strip ────────────────────────────────────────────
function updateMatchStrip() {
  if (state.matchFormat !== 'bo3') {
    matchStrip.classList.remove('active');
    return;
  }
  matchStrip.classList.add('active');
  matchStrip.textContent =
    'Game ' + state.gameNumber + ' \u00b7 ' +
    state.matchScore[0] + '\u2013' + state.matchScore[1];
}

// ── Score changes ──────────────────────────────────────────
function applyDelta(playerIndex, delta) {
  var player = state.players[playerIndex];
  var prev   = player.lore;
  var next   = Math.max(0, prev + delta);
  if (next === prev) return;

  player.lore = next;
  updatePanel(playerIndex);

  // Win detection fires immediately on crossing threshold
  if (next >= WIN_LORE && prev < WIN_LORE && state.winPromptPlayer === null) {
    state.winPromptPlayer = playerIndex;
    showWinPrompt(playerIndex);
  }

  // Accumulate rapid taps into one history entry
  if (pendingBatch && pendingBatch.playerIndex === playerIndex) {
    pendingBatch.delta += (next - prev);
  } else {
    if (pendingBatch) commitBatch(); // flush a different player's pending batch
    pendingBatch = { playerIndex: playerIndex, prevLore: prev, delta: next - prev };
  }
  clearTimeout(batchTimer);
  batchTimer = setTimeout(commitBatch, BATCH_MS);
}

function commitBatch() {
  if (!pendingBatch) return;
  clearTimeout(batchTimer);
  var b = pendingBatch;
  pendingBatch = null;

  var player = state.players[b.playerIndex];
  state.history.unshift({
    playerIndex: b.playerIndex,
    name:        player.name,
    delta:       b.delta,
    result:      player.lore,
    seq:         ++state.seq,
  });
  if (state.history.length > MAX_HISTORY) state.history.pop();

  renderHistory(true);
  saveState();
}

function cancelBatch() {
  clearTimeout(batchTimer);
  pendingBatch = null;
}

function updatePanel(index) {
  var player = state.players[index];
  var panel  = gameContainer.querySelector('.player-panel[data-index="' + index + '"]');
  if (!panel) return;

  var scoreEl = panel.querySelector('.score-display');
  scoreEl.textContent = player.lore;
  scoreEl.classList.remove('bump');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('bump');

  panel.classList.toggle('winner', player.lore >= WIN_LORE);

  var banner = panel.querySelector('.win-banner');
  if (banner) banner.textContent = '\u2726 ' + player.name + ' wins! \u2726';

  panel.querySelector('.score-btn-minus').disabled = player.lore === 0;
}

// ── Name editing ───────────────────────────────────────────
function startNameEdit(index) {
  var panel   = gameContainer.querySelector('.player-panel[data-index="' + index + '"]');
  if (!panel) return;
  var nameEl  = panel.querySelector('.player-name');
  var inputEl = panel.querySelector('.name-input');
  nameEl.style.display  = 'none';
  inputEl.style.display = 'block';
  inputEl.focus();
  inputEl.select();
}

function commitNameEdit(index) {
  var panel   = gameContainer.querySelector('.player-panel[data-index="' + index + '"]');
  if (!panel) return;
  var nameEl  = panel.querySelector('.player-name');
  var inputEl = panel.querySelector('.name-input');
  var newName = inputEl.value.trim() || ('Player ' + (index + 1));

  state.players[index].name = newName;
  nameEl.textContent    = newName;
  inputEl.style.display = 'none';
  nameEl.style.display  = '';

  var banner = panel.querySelector('.win-banner');
  if (banner) banner.textContent = '\u2726 ' + newName + ' wins! \u2726';

  saveState();
}

// ── History rendering (per-panel) ─────────────────────────
// animate=false on initial render (game load/restore) to avoid mass slide-in
function renderHistory(animate) {
  state.players.forEach(function(_, i) {
    var el = gameContainer.querySelector('.panel-history[data-index="' + i + '"]');
    if (!el) return;

    var entries = state.history.filter(function(e) { return e.playerIndex === i; }).reverse();

    // Remove DOM nodes no longer in history (pruned entries)
    Array.prototype.forEach.call(el.querySelectorAll('.ph-entry[data-seq]'), function(span) {
      var seq = parseInt(span.dataset.seq, 10);
      if (!entries.some(function(e) { return e.seq === seq; })) el.removeChild(span);
    });

    entries.forEach(function(e, idx) {
      var isLatest = idx === entries.length - 1;
      var cls = 'ph-entry' + (e.delta < 0 ? ' ph-neg' : '') + (isLatest ? '' : ' ph-old');
      var span = el.querySelector('.ph-entry[data-seq="' + e.seq + '"]');
      if (span) {
        // Update class in-place so opacity transition fires for newly-old entries
        span.className = cls;
      } else {
        span = document.createElement('span');
        span.className = cls + (animate ? ' ph-new' : '');
        span.dataset.seq = e.seq;
        span.textContent = e.result;
        el.appendChild(span);
      }
    });

    el.scrollTop = el.scrollHeight;
  });
}

// ── Win prompt (Bo3) ───────────────────────────────────────
function showWinPrompt(playerIndex) {
  var player = state.players[playerIndex];

  var newScore    = state.matchScore.slice();
  newScore[playerIndex]++;
  var isMatchOver = state.matchFormat === 'bo1' || newScore[playerIndex] >= 2;

  winPromptTitle.textContent = '\u2726 ' + player.name + ' wins' + (state.matchFormat === 'bo3' ? ' Game ' + state.gameNumber : '') + '! \u2726';

  if (isMatchOver) {
    winPromptScore.textContent    = 'Match complete \u00b7 ' + newScore[0] + '\u2013' + newScore[1];
    winPromptNext.style.display   = 'none';
    winPromptDismiss.textContent  = 'Close';
  } else {
    winPromptScore.textContent    = 'Match \u00b7 ' + newScore[0] + '\u2013' + newScore[1];
    winPromptNext.style.display   = '';
    winPromptNext.textContent     = 'Start Game ' + (state.gameNumber + 1);
    winPromptDismiss.textContent  = 'Not yet';
  }

  winPrompt.classList.add('open');
}

function hideWinPrompt() {
  winPrompt.classList.remove('open');
  state.winPromptPlayer = null;
  winPromptNext.style.display  = '';
  winPromptDismiss.textContent = 'Not yet';
  if (newGameQuick.dataset.mode) {
    newGameQuick.textContent  = 'New Game';
    newGameQuick.className    = '';
    newGameQuick.dataset.step = '0';
    delete newGameQuick.dataset.mode;
  }
}

function startNextGame() {
  cancelBatch();
  var playerIndex = state.winPromptPlayer;
  state.matchScore[playerIndex]++;
  state.gameNumber++;
  state.players.forEach(function(p) { p.lore = 0; });
  state.history = [];
  hideWinPrompt();
  renderGame();
  saveState();
}

// ── Event delegation: game container ──────────────────────
gameContainer.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-delta]');
  if (btn && btn.closest('#game-container')) {
    applyDelta(parseInt(btn.dataset.index, 10), parseInt(btn.dataset.delta, 10));
    return;
  }
  var nameEl = e.target.closest('.player-name');
  if (nameEl) {
    startNameEdit(parseInt(nameEl.dataset.index, 10));
    return;
  }
});

gameContainer.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    var inp = e.target.closest('.name-input');
    if (inp) { e.preventDefault(); commitNameEdit(parseInt(inp.dataset.index, 10)); }
    var nameEl = e.target.closest('.player-name');
    if (nameEl) { e.preventDefault(); startNameEdit(parseInt(nameEl.dataset.index, 10)); }
  }
  if (e.key === ' ') {
    var nameEl = e.target.closest('.player-name');
    if (nameEl) { e.preventDefault(); startNameEdit(parseInt(nameEl.dataset.index, 10)); }
  }
});

gameContainer.addEventListener('focusout', function(e) {
  var inp = e.target.closest('.name-input');
  if (inp) commitNameEdit(parseInt(inp.dataset.index, 10));
});

// ── Setup listeners ────────────────────────────────────────
document.querySelectorAll('input[name="match-format"]').forEach(function(radio) {
  radio.addEventListener('change', function() {
    state.matchFormat = this.value;
  });
});

document.getElementById('start-btn').addEventListener('click', startGame);

document.getElementById('setup-screen').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') startGame();
});

// ── Game control listeners ─────────────────────────────────
winPromptNext.addEventListener('click', startNextGame);

newGameQuick.addEventListener('click', function() {
  if (newGameQuick.dataset.mode === 'nextgame') {
    showWinPrompt(state.winPromptPlayer);
    return;
  }
  if (newGameQuick.dataset.mode === 'newmatch') {
    if (newGameQuick.dataset.step === '1') {
      clearTimeout(newGameQuickTimer);
      cancelBatch();
      state.winPromptPlayer     = null;
      delete newGameQuick.dataset.mode;
      newGameQuick.dataset.step = '0';
      newGameQuick.textContent  = 'New Game';
      newGameQuick.className    = '';
      state.history    = [];
      state.seq        = 0;
      state.gameNumber = 1;
      state.matchScore = state.players.map(function() { return 0; });
      state.players.forEach(function(p) { p.lore = 0; });
      showSetup();
      return;
    }
    newGameQuick.textContent  = 'Confirm?';
    newGameQuick.dataset.step = '1';
    newGameQuickTimer = setTimeout(function() {
      newGameQuick.textContent  = 'New Match';
      newGameQuick.dataset.step = '0';
    }, 4000);
    return;
  }
  if (newGameQuick.dataset.step === '1') {
    clearTimeout(newGameQuickTimer);
    newGameQuick.textContent  = 'New Game';
    newGameQuick.className    = '';
    newGameQuick.dataset.step = '0';
    cancelBatch();
    hideWinPrompt();
    state.history    = [];
    state.seq        = 0;
    state.gameNumber = 1;
    state.matchScore = state.players.map(function() { return 0; });
    state.players.forEach(function(p) { p.lore = 0; });
    showSetup();
    return;
  }
  newGameQuick.textContent  = 'Confirm?';
  newGameQuick.className    = 'confirm';
  newGameQuick.dataset.step = '1';
  newGameQuickTimer = setTimeout(function() {
    newGameQuick.textContent  = 'New Game';
    newGameQuick.className    = '';
    newGameQuick.dataset.step = '0';
  }, 4000);
});
winPromptDismiss.addEventListener('click', function() {
  winPrompt.classList.remove('open');
  if (state.winPromptPlayer !== null) {
    clearTimeout(newGameQuickTimer);
    newGameQuick.dataset.step = '0';
    // Bo1 always match-over; Bo3: check if deciding game
    var isMatchOver = state.matchFormat === 'bo1' || state.matchScore[state.winPromptPlayer] + 1 >= 2;
    if (isMatchOver) {
      newGameQuick.textContent  = 'New Match';
      newGameQuick.className    = 'next-game';
      newGameQuick.dataset.mode = 'newmatch';
    } else {
      newGameQuick.textContent  = 'Next Game';
      newGameQuick.className    = 'next-game';
      newGameQuick.dataset.mode = 'nextgame';
    }
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && winPrompt.classList.contains('open')) {
    winPrompt.classList.remove('open');
  }
});

// ── PWA Install prompt ─────────────────────────────────────
var deferredInstall = null;

var isIOS        = /iphone|ipad|ipod/i.test(navigator.userAgent);
var isStandalone = window.navigator.standalone === true;

function showInstallBanner() {
  if (isStandalone) return;
  if (isIOS) {
    installBanner.querySelector('.install-text strong').textContent = 'Add to Home Screen';
    installBanner.querySelector('.install-text span').innerHTML =
      'Tap <svg width="13" height="16" viewBox="0 0 13 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin:0 2px"><line x1="6.5" y1="0" x2="6.5" y2="9"/><polyline points="3,3.5 6.5,0 10,3.5"/><path d="M1,7 L1,15 L12,15 L12,7"/></svg> in your browser, then \u201cAdd to Home Screen\u201d. Works offline, no App Store needed.';
    installBtn.style.display = 'none';
    installBanner.classList.add('visible');
  }
}

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstall = e;
  if (state.screen !== 'game') installBanner.classList.add('visible');
});

installBtn.addEventListener('click', function() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(function() {
    deferredInstall = null;
    installBanner.classList.remove('visible');
  });
});


// ── Service worker ─────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/lore-counter/', updateViaCache: 'none' }).catch(function() {});
}

// ── Boot ───────────────────────────────────────────────────
(function init() {
  var hadSaved = loadState();
  if (hadSaved && state.screen === 'game' && state.players.length > 0) {
    showGame();
  } else {
    state.screen = 'setup';
    showSetup();
  }
}());
