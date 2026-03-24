/* ── lore-counter.js ─────────────────────────────────────────────────────── */

// ── Constants ──────────────────────────────────────────────
const STORAGE_KEY = 'gta-lorcana-counter-state';
const WIN_LORE    = 20;
const MAX_HISTORY = 50;

// ── State ──────────────────────────────────────────────────
let state = {
  screen:          'setup',
  playerCount:     2,
  matchFormat:     'bo1',  // 'bo1' | 'bo3'
  gameNumber:      1,
  matchScore:      [],     // game wins per player index
  players:         [],     // [{ name, lore }]
  history:         [],     // newest first: [{ playerIndex, name, delta, result, seq }]
  undo:            null,   // { playerIndex, prevLore } | null
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
const gameScreen       = document.getElementById('game-screen');
const gameContainer    = document.getElementById('game-container');
const undoPill         = document.getElementById('undo-pill');
const matchStrip       = document.getElementById('match-strip');
const winPrompt        = document.getElementById('win-prompt');
const winPromptTitle   = document.getElementById('win-prompt-title');
const winPromptScore   = document.getElementById('win-prompt-score');
const winPromptNext    = document.getElementById('win-prompt-next');
const winPromptDismiss = document.getElementById('win-prompt-dismiss');
const matchFormatField = document.getElementById('match-format-field');
const newGameQuick     = document.getElementById('new-game-quick');
const installBanner    = document.getElementById('install-banner');
const installBtn       = document.getElementById('install-btn');
const installDismiss   = document.getElementById('install-dismiss');
const playerNamesEl    = document.getElementById('player-names');

// ── Two-step confirm timers ────────────────────────────────
let newGameQuickTimer = null;

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
  // Show install banner if prompt is queued and eligible
  if (deferredInstall) {
    var dismissed = localStorage.getItem('gta-lorcana-install-dismissed');
    var week = 7 * 24 * 60 * 60 * 1000;
    if (!dismissed || Date.now() - parseInt(dismissed, 10) > week) {
      installBanner.classList.add('visible');
    }
  }
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
  // Sync player count radios
  document.querySelectorAll('input[name="player-count"]').forEach(function(r) {
    r.checked = parseInt(r.value) === state.playerCount;
  });

  // Match format: only available for 2 players
  matchFormatField.style.display = state.playerCount === 2 ? '' : 'none';
  if (state.playerCount !== 2) state.matchFormat = 'bo1';
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
  state.undo            = null;
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
  state.players.forEach(function(player, i) {
    const isTop = (i === 0 && state.playerCount === 2);
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

  syncUndoBtn();
  renderHistory();
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

  state.undo  = { playerIndex: playerIndex, prevLore: prev };
  player.lore = next;

  state.history.unshift({
    playerIndex: playerIndex,
    name:        player.name,
    delta:       next - prev,
    result:      next,
    seq:         ++state.seq,
  });
  if (state.history.length > MAX_HISTORY) state.history.pop();

  updatePanel(playerIndex);
  renderHistory();

  // Bo3 win detection: show prompt when first crossing WIN_LORE
  if (state.matchFormat === 'bo3' && next >= WIN_LORE && prev < WIN_LORE && state.winPromptPlayer === null) {
    state.winPromptPlayer = playerIndex;
    showWinPrompt(playerIndex);
  }

  saveState();
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

  syncUndoBtn();
}

// ── Undo ───────────────────────────────────────────────────
function doUndo() {
  if (!state.undo) return;
  var playerIndex = state.undo.playerIndex;
  var prevLore    = state.undo.prevLore;
  state.players[playerIndex].lore = prevLore;
  state.history.shift();
  state.undo = null;

  // If undo drops score below win threshold, clear win prompt so it can reappear
  if (state.winPromptPlayer === playerIndex && prevLore < WIN_LORE) {
    hideWinPrompt();
  }

  updatePanel(playerIndex);
  renderHistory();
  saveState();
}

function syncUndoBtn() {
  undoPill.disabled = !state.undo;
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
function renderHistory() {
  state.players.forEach(function(_, i) {
    var el = gameContainer.querySelector('.panel-history[data-index="' + i + '"]');
    if (!el) return;
    var entries = state.history.filter(function(e) { return e.playerIndex === i; }).slice(0, 5);
    el.innerHTML = entries.map(function(e) {
      var d = (e.delta > 0 ? '+' : '') + e.delta;
      return '<span class="ph-entry' + (e.delta < 0 ? ' ph-neg' : '') + '">' + d + ' \u2192 ' + e.result + '</span>';
    }).join('');
  });
}

// ── Win prompt (Bo3) ───────────────────────────────────────
function showWinPrompt(playerIndex) {
  var player       = state.players[playerIndex];
  var newScore     = state.matchScore.slice();
  newScore[playerIndex]++;
  var isMatchOver  = newScore[playerIndex] >= 2;

  winPromptTitle.textContent = '\u2726 ' + player.name + ' wins Game ' + state.gameNumber + '! \u2726';

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
  // Reset button state for next time
  winPromptNext.style.display  = '';
  winPromptDismiss.textContent = 'Not yet';
}

function startNextGame() {
  var playerIndex = state.winPromptPlayer;
  state.matchScore[playerIndex]++;
  state.gameNumber++;
  state.players.forEach(function(p) { p.lore = 0; });
  state.history = [];
  state.undo    = null;
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
document.querySelectorAll('input[name="player-count"]').forEach(function(radio) {
  radio.addEventListener('change', function() {
    state.playerCount = parseInt(this.value, 10);
    renderSetup();
  });
});

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
undoPill.addEventListener('click', doUndo);

winPromptNext.addEventListener('click', startNextGame);

newGameQuick.addEventListener('click', function() {
  if (newGameQuick.dataset.step === '1') {
    clearTimeout(newGameQuickTimer);
    newGameQuick.textContent  = 'New Game';
    newGameQuick.className    = '';
    newGameQuick.dataset.step = '0';
    hideWinPrompt();
    state.history    = [];
    state.undo       = null;
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
  // Don't clear winPromptPlayer here — keep it set so undo can clear the prompt
  // but DO prevent the prompt from auto-showing again for this crossing
  // (it will only show again if score drops below 20 and crosses back up)
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && winPrompt.classList.contains('open')) {
    winPrompt.classList.remove('open');
  }
});

// ── PWA Install prompt ─────────────────────────────────────
var deferredInstall = null;

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstall = e;
  var dismissed = localStorage.getItem('gta-lorcana-install-dismissed');
  var week = 7 * 24 * 60 * 60 * 1000;
  if (!dismissed || Date.now() - parseInt(dismissed, 10) > week) {
    // Only show on setup screen; if game is active, queue and show on next setup visit
    if (state.screen !== 'game') {
      installBanner.classList.add('visible');
    }
  }
});

installBtn.addEventListener('click', function() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(function() {
    deferredInstall = null;
    installBanner.classList.remove('visible');
  });
});

installDismiss.addEventListener('click', function() {
  installBanner.classList.remove('visible');
  localStorage.setItem('gta-lorcana-install-dismissed', Date.now());
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
