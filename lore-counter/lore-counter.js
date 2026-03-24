/* ── lore-counter.js ─────────────────────────────────────────────────────── */

// ── Constants ──────────────────────────────────────────────
const STORAGE_KEY = 'gta-lorcana-counter-state';
const WIN_LORE    = 20;
const MAX_HISTORY = 50;

// ── State ──────────────────────────────────────────────────
let state = {
  screen:      'setup',
  playerCount: 2,
  players:     [],   // [{ name, lore }]
  history:     [],   // newest first: [{ playerIndex, name, delta, result, seq }]
  undo:        null, // { playerIndex, prevLore } | null
  orientation: 'auto',
  seq:         0,
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
const setupScreen    = document.getElementById('setup-screen');
const gameScreen     = document.getElementById('game-screen');
const gameContainer  = document.getElementById('game-container');
const rotateBtn      = document.getElementById('rotate-btn');
const historyToggle  = document.getElementById('history-toggle');
const historyOverlay = document.getElementById('history-overlay');
const historyDrawer  = document.getElementById('history-drawer');
const historyList    = document.getElementById('history-list');
const undoBtn        = document.getElementById('undo-btn');
const clearBtn       = document.getElementById('clear-btn');
const newGameBtn     = document.getElementById('new-game-btn');
const installBanner  = document.getElementById('install-banner');
const installBtn     = document.getElementById('install-btn');
const installDismiss = document.getElementById('install-dismiss');
const playerNamesEl  = document.getElementById('player-names');

// ── Two-step confirm timers ────────────────────────────────
let newGameTimer = null;
let clearTimer   = null;

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
  // Sync radio buttons
  document.querySelectorAll('input[name="player-count"]').forEach(r => {
    r.checked = parseInt(r.value) === state.playerCount;
  });

  // Render name inputs
  playerNamesEl.innerHTML = '';
  for (let i = 0; i < state.playerCount; i++) {
    const savedName = state.players[i] ? state.players[i].name : '';
    const defaultName = 'Player ' + (i + 1);
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML =
      '<label for="name-' + i + '">Player ' + (i + 1) + '</label>' +
      '<input type="text" id="name-' + i + '" value="' + escAttr(savedName || defaultName) + '" placeholder="' + escAttr(defaultName) + '" maxlength="20" autocomplete="off" />';
    playerNamesEl.appendChild(field);
  }

  // Focus first input
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
  state.history = [];
  state.undo    = null;
  state.seq     = 0;
  showGame();
}

// ── Game screen ────────────────────────────────────────────
function renderGame() {
  gameContainer.setAttribute('data-players', state.playerCount);
  gameContainer.setAttribute('data-orientation', state.orientation);

  // Rotate button only makes sense for 2 players
  rotateBtn.style.visibility = state.playerCount === 2 ? '' : 'hidden';

  // Render panels
  gameContainer.innerHTML = '';
  state.players.forEach(function(player, i) {
    const isTop = (i === 0 && state.playerCount === 2);
    const panel = document.createElement('div');
    panel.className = 'player-panel' + (player.lore >= WIN_LORE ? ' winner' : '');
    panel.setAttribute('data-index', i);
    if (isTop) panel.setAttribute('data-pos', 'top');

    panel.innerHTML =
      '<div class="win-banner">🏆 ' + escHtml(player.name) + ' wins!</div>' +
      '<span class="player-name" data-index="' + i + '" tabindex="0" role="button" aria-label="Edit name">' + escHtml(player.name) + '</span>' +
      '<input class="name-input" data-index="' + i + '" type="text" value="' + escAttr(player.name) + '" maxlength="20" autocomplete="off" aria-label="Player name" />' +
      '<div class="score-display" id="score-' + i + '">' + player.lore + '</div>' +
      '<div class="score-btns">' +
        '<button class="score-btn score-btn-minus" data-index="' + i + '" data-delta="-1" aria-label="Minus 1"' + (player.lore === 0 ? ' disabled' : '') + '>−</button>' +
        '<button class="score-btn score-btn-plus"  data-index="' + i + '" data-delta="1"  aria-label="Plus 1">+</button>' +
      '</div>' +
      '<div class="quick-btns">' +
        '<button class="quick-btn" data-index="' + i + '" data-delta="2">+2</button>' +
        '<button class="quick-btn" data-index="' + i + '" data-delta="3">+3</button>' +
        '<button class="quick-btn" data-index="' + i + '" data-delta="4">+4</button>' +
      '</div>';

    gameContainer.appendChild(panel);
  });

  syncUndoBtn();
  renderHistory();
}

// ── Score changes ──────────────────────────────────────────
function applyDelta(playerIndex, delta) {
  var player = state.players[playerIndex];
  var prev   = player.lore;
  var next   = Math.max(0, prev + delta);
  if (next === prev) return;

  state.undo  = { playerIndex: playerIndex, prevLore: prev };
  player.lore = next;

  var entry = {
    playerIndex: playerIndex,
    name:        player.name,
    delta:       next - prev,
    result:      next,
    seq:         ++state.seq,
  };
  state.history.unshift(entry);
  if (state.history.length > MAX_HISTORY) state.history.pop();

  updatePanel(playerIndex);
  renderHistory();
  saveState();
}

function updatePanel(index) {
  var player = state.players[index];
  var panel  = gameContainer.querySelector('.player-panel[data-index="' + index + '"]');
  if (!panel) return;

  // Animate score
  var scoreEl = panel.querySelector('.score-display');
  scoreEl.textContent = player.lore;
  scoreEl.classList.remove('bump');
  void scoreEl.offsetWidth; // force reflow
  scoreEl.classList.add('bump');

  // Win state
  var wasWinner = panel.classList.contains('winner');
  var isWinner  = player.lore >= WIN_LORE;
  panel.classList.toggle('winner', isWinner);

  // Keep win banner name in sync
  var banner = panel.querySelector('.win-banner');
  if (banner) banner.textContent = '🏆 ' + player.name + ' wins!';

  // Minus button
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
  updatePanel(playerIndex);
  renderHistory();
  saveState();
}

function syncUndoBtn() {
  undoBtn.disabled = !state.undo;
}

// ── Name editing ───────────────────────────────────────────
function startNameEdit(index) {
  var panel   = gameContainer.querySelector('.player-panel[data-index="' + index + '"]');
  if (!panel) return;
  var nameEl  = panel.querySelector('.player-name');
  var inputEl = panel.querySelector('.name-input');
  nameEl.style.display  = 'none';
  inputEl.style.display = '';
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

  // Update win banner
  var banner = panel.querySelector('.win-banner');
  if (banner) banner.textContent = '🏆 ' + newName + ' wins!';

  saveState();
}

// ── History rendering ──────────────────────────────────────
function renderHistory() {
  if (!historyList) return;
  if (state.history.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No moves yet</div>';
    return;
  }
  historyList.innerHTML = state.history.map(function(e) {
    var deltaStr = (e.delta > 0 ? '+' : '') + e.delta;
    return '<div class="history-entry">' +
      '<span class="he-seq">' + e.seq + '</span>' +
      '<span class="he-player">' + escHtml(e.name) + '</span>' +
      '<span class="he-delta' + (e.delta < 0 ? ' neg' : '') + '">' + deltaStr + '</span>' +
      '<span class="he-result">' + e.result + '</span>' +
    '</div>';
  }).join('');
}

// ── History drawer ─────────────────────────────────────────
function openHistory() {
  historyOverlay.classList.add('open');
  historyDrawer.classList.add('open');
  renderHistory();
}

function closeHistory() {
  historyOverlay.classList.remove('open');
  historyDrawer.classList.remove('open');
  resetConfirmBtns();
}

// ── Two-step confirms ──────────────────────────────────────
function resetConfirmBtns() {
  clearTimeout(newGameTimer);
  clearTimeout(clearTimer);

  newGameBtn.textContent = 'New Game';
  newGameBtn.className   = 'drawer-btn';
  newGameBtn.dataset.step = '0';

  clearBtn.textContent   = 'Clear History';
  clearBtn.className     = 'drawer-btn';
  clearBtn.dataset.step  = '0';
}

function handleNewGame() {
  if (newGameBtn.dataset.step === '1') {
    clearTimeout(newGameTimer);
    closeHistory();
    state.history = [];
    state.undo    = null;
    state.seq     = 0;
    state.players.forEach(function(p) { p.lore = 0; });
    showSetup();
    return;
  }
  resetConfirmBtns();
  newGameBtn.textContent  = 'Confirm Reset';
  newGameBtn.className    = 'drawer-btn confirm';
  newGameBtn.dataset.step = '1';
  newGameTimer = setTimeout(function() {
    newGameBtn.textContent  = 'New Game';
    newGameBtn.className    = 'drawer-btn';
    newGameBtn.dataset.step = '0';
  }, 4000);
}

function handleClearHistory() {
  if (clearBtn.dataset.step === '1') {
    clearTimeout(clearTimer);
    state.history = [];
    state.undo    = null;
    syncUndoBtn();
    renderHistory();
    saveState();
    resetConfirmBtns();
    return;
  }
  resetConfirmBtns();
  clearBtn.textContent  = 'Confirm Clear';
  clearBtn.className    = 'drawer-btn danger';
  clearBtn.dataset.step = '1';
  clearTimer = setTimeout(function() {
    clearBtn.textContent  = 'Clear History';
    clearBtn.className    = 'drawer-btn';
    clearBtn.dataset.step = '0';
  }, 4000);
}

// ── Orientation toggle ─────────────────────────────────────
function toggleOrientation() {
  var cur  = state.orientation;
  var next = cur === 'auto' ? 'landscape' : cur === 'landscape' ? 'portrait' : 'auto';
  state.orientation = next;
  gameContainer.setAttribute('data-orientation', next);
  saveState();
}

// ── Event delegation: game container ──────────────────────
gameContainer.addEventListener('click', function(e) {
  // Score / quick-add buttons
  var btn = e.target.closest('[data-delta]');
  if (btn && btn.closest('#game-container')) {
    var index = parseInt(btn.dataset.index, 10);
    var delta = parseInt(btn.dataset.delta, 10);
    applyDelta(index, delta);
    return;
  }

  // Player name tap
  var nameEl = e.target.closest('.player-name');
  if (nameEl) {
    startNameEdit(parseInt(nameEl.dataset.index, 10));
    return;
  }
});

// Name input: commit on Enter
gameContainer.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    var inp = e.target.closest('.name-input');
    if (inp) { e.preventDefault(); commitNameEdit(parseInt(inp.dataset.index, 10)); }
  }
});

// Name input: commit on blur
gameContainer.addEventListener('focusout', function(e) {
  var inp = e.target.closest('.name-input');
  if (inp) commitNameEdit(parseInt(inp.dataset.index, 10));
});

// Player name: keyboard activation
gameContainer.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === ' ') {
    var nameEl = e.target.closest('.player-name');
    if (nameEl) { e.preventDefault(); startNameEdit(parseInt(nameEl.dataset.index, 10)); }
  }
});

// ── Setup listeners ────────────────────────────────────────
document.querySelectorAll('input[name="player-count"]').forEach(function(radio) {
  radio.addEventListener('change', function() {
    state.playerCount = parseInt(this.value, 10);
    renderSetup();
  });
});

document.getElementById('start-btn').addEventListener('click', startGame);

// Allow Enter on setup card to start game
document.getElementById('setup-screen').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') startGame();
});

// ── Game control listeners ─────────────────────────────────
rotateBtn.addEventListener('click', toggleOrientation);
historyToggle.addEventListener('click', openHistory);
historyOverlay.addEventListener('click', closeHistory);
undoBtn.addEventListener('click', doUndo);
newGameBtn.addEventListener('click', handleNewGame);
clearBtn.addEventListener('click', handleClearHistory);

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeHistory();
});

// ── PWA Install prompt ─────────────────────────────────────
var deferredInstall = null;

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstall = e;
  installBanner.classList.add('visible');
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
});

// ── Service worker ─────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/lore-counter/' }).catch(function() {});
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
