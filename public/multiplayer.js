// ===== IMPOSTER MULTIPLAYER CLIENT =====
// Socket.IO client for online multiplayer mode.
// This module activates only when the player selects "Online" mode.
// It communicates with the server and updates the shared DOM screens.

(function () {
  'use strict';

  // ===== MULTIPLAYER STATE =====
  const mp = {
    socket: null,
    active: false,          // true when online mode is engaged
    roomCode: null,
    playerName: null,
    isHost: false,
    myWord: null,
    myRole: null,            // 'normal' or 'imposter'
    players: [],             // [{ name, isHost }]
    settings: {
      timerDuration: 120,
      imposterCount: 0,
      maxRounds: 0,
      hintTimer: 0,
    },
    phase: 'lobby',
    round: 0,
    timerInterval: null,
    timerSeconds: 0,
    timerPaused: false,
    selectedVote: null,
    hasVoted: false,
    wordMode: 'manual',     // 'manual' or 'pack'
    selectedPack: null,
    selectedPair: null,
    connected: false,
    reconnecting: false,
    // Chat & Voice state
    commsPanelOpen: false,
    commsTab: 'chat',       // 'chat' or 'voice'
    unreadCount: 0,
    voiceActive: false,
    voiceMuted: false,
    localStream: null,
    peers: {},              // { peerId: { pc, name, muted } }
    // Grand Master info (host only)
    gmImposters: [],        // names of imposters (host sees these)
    gmNormalWord: null,
    gmImposterWord: null,
    isObserver: false,      // true when host is Grand Master (doesn't play)
  };

  // ===== DOM HELPERS =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function isGrandMaster() {
    return mp.isHost && mp.gmImposters.length > 0;
  }

  function isImposterName(name) {
    return mp.gmImposters.includes(name);
  }

  function gmBadge(name) {
    if (!isGrandMaster() || !isImposterName(name)) return '';
    return ' <span class="gm-spy-badge" title="Imposter">\uD83D\uDD75\uFE0F</span>';
  }

  // Render a floating Grand Master info panel (host only)
  function renderGrandMasterPanel() {
    // Remove old panel
    const old = $('#gm-panel');
    if (old) old.remove();

    if (!isGrandMaster()) return;

    const panel = document.createElement('div');
    panel.id = 'gm-panel';
    panel.className = 'gm-panel';
    panel.innerHTML = `
      <div class="gm-header">
        <span>\uD83D\uDC51 Grand Master View</span>
        <button class="gm-toggle-btn" title="Toggle">\u25BC</button>
      </div>
      <div class="gm-body">
        <div class="gm-words">
          <div class="gm-word-row"><span class="gm-label">Normal:</span> <strong>${escapeHtml(mp.gmNormalWord)}</strong></div>
          <div class="gm-word-row"><span class="gm-label">Imposter:</span> <strong class="gm-imp-word">${escapeHtml(mp.gmImposterWord)}</strong></div>
        </div>
        <div class="gm-imposters">
          <span class="gm-label">Imposters:</span>
          ${mp.gmImposters.map(n => `<span class="gm-imp-name">\uD83D\uDD75\uFE0F ${escapeHtml(n)}</span>`).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Toggle collapse
    const toggleBtn = panel.querySelector('.gm-toggle-btn');
    const body = panel.querySelector('.gm-body');
    toggleBtn.addEventListener('click', () => {
      body.classList.toggle('collapsed');
      toggleBtn.textContent = body.classList.contains('collapsed') ? '\u25B2' : '\u25BC';
    });
  }

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const screen = $(`#screen-${id}`);
    if (screen) {
      screen.classList.add('active');
      screen.style.animation = 'none';
      screen.offsetHeight; // trigger reflow
      screen.style.animation = '';
    }
  }

  function safePlay(fnName) {
    if (typeof window[fnName] === 'function') {
      window[fnName]();
    }
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ===== SCORE PERSISTENCE =====
  function loadScores() {
    try {
      const raw = localStorage.getItem('imposter_scores');
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveScore(entry) {
    try {
      const scores = loadScores();
      scores.unshift(entry);
      // Keep only the last 50 entries
      if (scores.length > 50) scores.length = 50;
      localStorage.setItem('imposter_scores', JSON.stringify(scores));
    } catch (e) {
      // localStorage may be unavailable
    }
  }

  // ===== CONNECTION =====
  function connectSocket() {
    if (mp.socket) return;

    mp.socket = io();
    mp.connected = false;

    mp.socket.on('connect', () => {
      mp.connected = true;
      mp.reconnecting = false;
      hideDisconnectOverlay();
    });

    mp.socket.on('disconnect', () => {
      mp.connected = false;
      if (mp.active && mp.phase !== 'lobby') {
        showDisconnectOverlay();
      }
    });

    mp.socket.on('connect_error', () => {
      mp.connected = false;
      if (mp.active) {
        showDisconnectOverlay();
      }
    });

    // Register all server event listeners
    registerServerEvents(mp.socket);
  }

  function disconnectSocket() {
    if (mp.socket) {
      mp.socket.disconnect();
      mp.socket = null;
    }
    mp.connected = false;
    mp.active = false;
    mp.roomCode = null;
    mp.playerName = null;
    mp.isHost = false;
    mp.phase = 'lobby';
    clearInterval(mp.timerInterval);
  }

  // ===== DISCONNECT OVERLAY =====
  function showDisconnectOverlay() {
    let overlay = $('#mp-disconnect-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mp-disconnect-overlay';
      overlay.className = 'mp-overlay';
      overlay.innerHTML = `
        <div class="mp-overlay-content">
          <div class="mp-overlay-icon">&#x26A0;</div>
          <h3>Connection Lost</h3>
          <p>Trying to reconnect...</p>
          <button id="btn-disconnect-back" class="btn btn-secondary">Back to Menu</button>
        </div>
      `;
      document.body.appendChild(overlay);
      $('#btn-disconnect-back').addEventListener('click', () => {
        hideDisconnectOverlay();
        backToModeSelect();
      });
    }
    overlay.classList.add('visible');
  }

  function hideDisconnectOverlay() {
    const overlay = $('#mp-disconnect-overlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
  }

  // ===== NAVIGATION =====
  function backToModeSelect() {
    disconnectSocket();
    clearInterval(mp.timerInterval);
    hideCommsPanel();
    showScreen('mode-select');
  }

  function backToWelcome() {
    disconnectSocket();
    clearInterval(mp.timerInterval);
    hideCommsPanel();
    showScreen('welcome');
  }

  // ===== LOBBY TABS =====
  function initLobbyTabs() {
    const createTab = $('#lobby-create-tab');
    const joinTab = $('#lobby-join-tab');
    const createSection = $('#lobby-create-section');
    const joinSection = $('#lobby-join-section');

    if (!createTab || !joinTab) return;

    createTab.addEventListener('click', () => {
      createTab.classList.add('active');
      joinTab.classList.remove('active');
      createSection.classList.remove('hidden');
      joinSection.classList.add('hidden');
      safePlay('playClick');
    });

    joinTab.addEventListener('click', () => {
      joinTab.classList.add('active');
      createTab.classList.remove('active');
      joinSection.classList.remove('hidden');
      createSection.classList.add('hidden');
      safePlay('playClick');
    });
  }

  // ===== CREATE / JOIN ROOM =====
  function createRoom() {
    const nameInput = $('#create-player-name');
    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name) {
      showLobbyError('Please enter your name.');
      return;
    }

    connectSocket();
    mp.playerName = name;

    // Wait for connection before emitting
    if (mp.socket.connected) {
      mp.socket.emit('create-room', { playerName: name });
    } else {
      mp.socket.once('connect', () => {
        mp.socket.emit('create-room', { playerName: name });
      });
    }
    safePlay('playClick');
  }

  function joinRoom() {
    const codeInput = $('#join-room-code');
    const nameInput = $('#join-player-name');
    if (!codeInput || !nameInput) return;

    const code = codeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();

    if (!name) {
      showLobbyError('Please enter your name.');
      return;
    }
    if (!code) {
      showLobbyError('Please enter a room code.');
      return;
    }

    connectSocket();
    mp.playerName = name;

    if (mp.socket.connected) {
      mp.socket.emit('join-room', { roomCode: code, playerName: name });
    } else {
      mp.socket.once('connect', () => {
        mp.socket.emit('join-room', { roomCode: code, playerName: name });
      });
    }
    safePlay('playClick');
  }

  function showLobbyError(msg) {
    const el = $('#lobby-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
  }

  function clearLobbyError() {
    const el = $('#lobby-error');
    if (el) el.classList.add('hidden');
  }

  // ===== SETTINGS (HOST ONLY) =====
  function initSettings() {
    const timerSlider = $('#setting-timer');
    const timerValue = $('#setting-timer-value');
    const imposterSelect = $('#setting-imposters');
    const maxRoundsInput = $('#setting-max-rounds');

    if (timerSlider) {
      timerSlider.addEventListener('input', () => {
        const val = parseInt(timerSlider.value, 10);
        if (timerValue) timerValue.textContent = `${val}s`;
        emitSettings({ timerDuration: val });
      });
    }

    if (imposterSelect) {
      imposterSelect.addEventListener('change', () => {
        emitSettings({ imposterCount: parseInt(imposterSelect.value, 10) });
      });
    }

    if (maxRoundsInput) {
      maxRoundsInput.addEventListener('change', () => {
        emitSettings({ maxRounds: parseInt(maxRoundsInput.value, 10) || 0 });
      });
    }
  }

  function emitSettings(partial) {
    if (!mp.socket || !mp.isHost) return;
    mp.socket.emit('update-settings', partial);
  }

  function applySettings(settings) {
    mp.settings = { ...mp.settings, ...settings };

    const timerSlider = $('#setting-timer');
    const timerValue = $('#setting-timer-value');
    const imposterSelect = $('#setting-imposters');
    const maxRoundsInput = $('#setting-max-rounds');

    if (timerSlider) timerSlider.value = settings.timerDuration;
    if (timerValue) timerValue.textContent = `${settings.timerDuration}s`;
    if (imposterSelect) imposterSelect.value = settings.imposterCount;
    if (maxRoundsInput) maxRoundsInput.value = settings.maxRounds;
  }

  // ===== WORD MODE (manual / pack) =====
  function initWordMode() {
    const toggle = $('#lobby-word-mode');
    if (!toggle) return;

    toggle.addEventListener('change', () => {
      const mode = toggle.value || toggle.dataset.mode;
      setWordMode(mode);
    });

    toggle.addEventListener('click', () => {
      // Handle if it's a button toggle instead of select
      if (toggle.tagName !== 'SELECT') {
        const newMode = mp.wordMode === 'manual' ? 'pack' : 'manual';
        setWordMode(newMode);
        toggle.dataset.mode = newMode;
      }
    });
  }

  function setWordMode(mode) {
    mp.wordMode = mode;
    const manual = $('#lobby-manual-words');
    const packs = $('#lobby-word-packs');

    if (manual) manual.classList.toggle('hidden', mode !== 'manual');
    if (packs) packs.classList.toggle('hidden', mode !== 'pack');

    if (mode === 'pack') {
      renderWordPacks();
    }
  }

  function renderWordPacks() {
    const container = $('#lobby-word-packs');
    if (!container || typeof WORD_PACKS === 'undefined') return;

    // Don't re-render if already populated with pack cards
    const existingCards = container.querySelectorAll('.word-pack-card');
    if (existingCards.length > 0) return;

    Object.entries(WORD_PACKS).forEach(([key, pack]) => {
      const card = document.createElement('div');
      card.className = 'word-pack-card';
      card.dataset.pack = key;
      card.innerHTML = `
        <span class="pack-icon">${pack.icon}</span>
        <span class="pack-name">${pack.name}</span>
      `;
      card.addEventListener('click', () => selectPack(key));
      container.appendChild(card);
    });
  }

  function selectPack(key) {
    if (typeof WORD_PACKS === 'undefined') return;
    const pack = WORD_PACKS[key];
    if (!pack) return;

    mp.selectedPack = key;

    // Highlight selected pack card
    $$('.word-pack-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.pack === key);
    });

    // Pick a random pair
    shufflePackWords(key);
    safePlay('playClick');
  }

  function shufflePackWords(key) {
    if (typeof WORD_PACKS === 'undefined') return;
    const packKey = key || mp.selectedPack;
    if (!packKey) return;

    const pack = WORD_PACKS[packKey];
    if (!pack || !pack.pairs || pack.pairs.length === 0) return;

    const idx = Math.floor(Math.random() * pack.pairs.length);
    const pair = pack.pairs[idx];
    mp.selectedPair = pair;

    const display = $('#selected-pack-words');
    if (display) {
      display.innerHTML = `
        <div class="pack-word-display">
          <span class="pack-word normal-word">Normal: <strong>${pair[0]}</strong></span>
          <span class="pack-word imposter-word">Imposter: <strong>${pair[1]}</strong></span>
        </div>
      `;
      display.classList.remove('hidden');
    }

    // Also populate hidden inputs so start-game can read them
    const normalInput = $('#lobby-normal-word');
    const imposterInput = $('#lobby-imposter-word');
    if (normalInput) normalInput.value = pair[0];
    if (imposterInput) imposterInput.value = pair[1];
  }

  // ===== PLAYER LIST UI =====
  function renderPlayerList(players, host) {
    const container = $('#lobby-player-list');
    if (!container) return;

    container.innerHTML = '';

    players.forEach(p => {
      const item = document.createElement('div');
      item.className = 'lobby-player-item';
      if (p.isHost) item.classList.add('host');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'lobby-player-name';
      nameSpan.textContent = p.name;
      if (p.isHost) nameSpan.textContent += ' (Host)';
      if (p.name === mp.playerName) nameSpan.textContent += ' (You)';
      item.appendChild(nameSpan);

      // Show kick button for host (not for self)
      if (mp.isHost && p.name !== mp.playerName && mp.phase === 'lobby') {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn-icon btn-kick';
        kickBtn.title = 'Kick player';
        kickBtn.textContent = '\u2715';
        kickBtn.addEventListener('click', () => {
          if (mp.socket) {
            mp.socket.emit('kick-player', { playerName: p.name });
          }
        });
        item.appendChild(kickBtn);
      }

      container.appendChild(item);
    });

    // Update player count if displayed
    const countEl = $('#lobby-player-count');
    if (countEl) countEl.textContent = players.length;
  }

  function updateLobbyHostUI() {
    const settings = $('#lobby-settings');
    const startBtn = $('#btn-lobby-start');
    const waiting = $('#lobby-waiting');
    const wordInputs = $('#lobby-manual-words');
    const wordMode = $('#lobby-word-mode');
    const shuffleBtn = $('#btn-shuffle-words');

    if (mp.isHost) {
      if (settings) settings.classList.remove('hidden');
      if (startBtn) startBtn.classList.remove('hidden');
      if (waiting) waiting.classList.add('hidden');
      if (wordInputs) wordInputs.classList.remove('hidden');
      if (wordMode) wordMode.classList.remove('hidden');
      if (shuffleBtn) shuffleBtn.classList.remove('hidden');
    } else {
      if (settings) settings.classList.add('hidden');
      if (startBtn) startBtn.classList.add('hidden');
      if (waiting) waiting.classList.remove('hidden');
      if (wordInputs) wordInputs.classList.add('hidden');
      if (wordMode) wordMode.classList.add('hidden');
      if (shuffleBtn) shuffleBtn.classList.add('hidden');
    }
  }

  // ===== HOST START GAME =====
  function startGame() {
    if (!mp.socket || !mp.isHost) return;

    let normalWord, imposterWord;

    if (mp.wordMode === 'pack' && mp.selectedPair) {
      normalWord = mp.selectedPair[0];
      imposterWord = mp.selectedPair[1];
    } else {
      const normalInput = $('#lobby-normal-word');
      const imposterInput = $('#lobby-imposter-word');
      normalWord = normalInput ? normalInput.value.trim() : '';
      imposterWord = imposterInput ? imposterInput.value.trim() : '';
    }

    if (!normalWord || !imposterWord) {
      showLobbyError('Please enter both words before starting.');
      return;
    }

    if (normalWord.toLowerCase() === imposterWord.toLowerCase()) {
      showLobbyError('Normal and imposter words must be different.');
      return;
    }

    mp.socket.emit('start-game', { normalWord, imposterWord });
    safePlay('playClick');
  }

  // ===== DISTRIBUTE PHASE =====

  // Observer distribute screen (Grand Master sees all player roles)
  function showObserverDistribute(participants) {
    showScreen('online-distribute');

    const wordDisplay = $('#online-word-display');
    const roleDisplay = $('#online-role-display');
    const btnSeen = $('#btn-word-seen');
    const progress = $('#word-seen-progress');

    if (wordDisplay) {
      wordDisplay.textContent = '\uD83D\uDC51';
      wordDisplay.className = 'online-word';
    }

    if (roleDisplay) {
      roleDisplay.textContent = 'You are the Grand Master — observing the game';
      roleDisplay.style.fontSize = '1rem';
    }

    // Hide the "I've seen my word" button — GM doesn't need it
    if (btnSeen) {
      btnSeen.style.display = 'none';
    }

    if (progress) {
      progress.textContent = 'Waiting for all players to view their words...';
    }

    // Show GM panel with imposter info
    renderGrandMasterPanel();
  }

  // Observer voting screen (Grand Master watches votes)
  function showObserverVoting(players) {
    showScreen('online-voting');

    const container = $('#online-vote-candidates');
    const statusEl = $('#online-vote-status');
    const submitBtn = $('#btn-online-submit-vote');

    if (container) {
      container.innerHTML = '';
      const notice = document.createElement('div');
      notice.className = 'gm-observer-notice';
      notice.innerHTML = '<p>\uD83D\uDC51 <strong>Grand Master View</strong></p><p>Players are voting. You are observing.</p>';
      container.appendChild(notice);

      // Show players with imposter badges
      if (players && players.length > 0) {
        players.forEach(p => {
          const chip = document.createElement('span');
          chip.className = 'player-chip' + (isImposterName(p.name) ? ' gm-imposter' : '');
          chip.innerHTML = p.name + gmBadge(p.name);
          container.appendChild(chip);
        });
      }
    }

    if (submitBtn) {
      submitBtn.style.display = 'none';
    }

    if (statusEl) {
      statusEl.textContent = 'Waiting for votes...';
    }
  }

  function showDistributeScreen(word, role) {
    mp.myWord = word;
    mp.myRole = role;
    showScreen('online-distribute');

    const wordDisplay = $('#online-word-display');
    const roleDisplay = $('#online-role-display');
    const btnSeen = $('#btn-word-seen');
    const progress = $('#word-seen-progress');

    if (wordDisplay) {
      wordDisplay.textContent = word;
      wordDisplay.className = 'online-word ' + (role === 'imposter' ? 'imposter-word' : 'normal-word');
    }

    if (roleDisplay) {
      roleDisplay.textContent = 'Remember your word!';
    }

    if (btnSeen) {
      btnSeen.style.display = '';
      btnSeen.disabled = false;
      btnSeen.textContent = "I've Seen My Word";
    }

    if (progress) {
      progress.textContent = 'Waiting for all players to view their words...';
    }

    // Grand Master panel — host sees imposter info
    renderGrandMasterPanel();

    safePlay('playReveal');
  }

  function wordSeen() {
    if (!mp.socket) return;
    mp.socket.emit('word-seen');

    const btnSeen = $('#btn-word-seen');
    if (btnSeen) {
      btnSeen.disabled = true;
      btnSeen.textContent = 'Waiting for others...';
    }

    // Hide the word after confirming
    const wordDisplay = $('#online-word-display');
    if (wordDisplay) {
      wordDisplay.textContent = '******';
    }

    safePlay('playClick');
  }

  // ===== HINTS PHASE =====
  function showHintsScreen(players) {
    showScreen('online-hints');

    const container = $('#online-hint-players');
    const btnHint = $('#btn-hint-given');
    const statusEl = $('#online-hint-status');
    const btnDiscussion = $('#btn-online-discussion');

    if (container) {
      container.innerHTML = '';
      players.forEach(p => {
        const item = document.createElement('div');
        item.className = 'hint-player-item' + (isGrandMaster() && isImposterName(p.name) ? ' gm-imposter' : '');
        item.dataset.name = p.name;
        item.innerHTML = `
          <span class="player-hint-name">${p.name}${p.name === mp.playerName ? ' (You)' : ''}${gmBadge(p.name)}</span>
          <span class="hint-status">Waiting...</span>
        `;
        container.appendChild(item);
      });
    }

    if (btnHint) {
      if (mp.isObserver) {
        // Grand Master doesn't give hints
        btnHint.style.display = 'none';
      } else {
        btnHint.style.display = '';
        btnHint.disabled = false;
        btnHint.textContent = "I Gave My Hint";
      }
    }

    if (statusEl) {
      statusEl.textContent = '0 of ' + players.length + ' hints given';
    }

    // Only host sees proceed button, initially hidden
    if (btnDiscussion) {
      btnDiscussion.classList.add('hidden');
      btnDiscussion.style.display = mp.isHost ? '' : 'none';
    }
  }

  function hintGiven() {
    if (!mp.socket) return;
    mp.socket.emit('hint-given');

    const btnHint = $('#btn-hint-given');
    if (btnHint) {
      btnHint.disabled = true;
      btnHint.textContent = 'Hint Submitted';
    }
    safePlay('playClick');
  }

  function updateHintProgress(hintsGiven, total) {
    const statusEl = $('#online-hint-status');
    if (statusEl) {
      statusEl.textContent = `${hintsGiven.length || hintsGiven} of ${total} hints given`;
    }

    // Update individual player statuses
    const container = $('#online-hint-players');
    if (container && Array.isArray(hintsGiven)) {
      const items = container.querySelectorAll('.hint-player-item');
      items.forEach(item => {
        const name = item.dataset.name;
        const status = item.querySelector('.hint-status');
        if (hintsGiven.includes(name)) {
          item.classList.add('done');
          if (status) status.textContent = '\u2713 Done';
        }
      });
    }
  }

  function showAllHintsGiven() {
    const btnDiscussion = $('#btn-online-discussion');
    if (btnDiscussion && mp.isHost) {
      btnDiscussion.classList.remove('hidden');
    }

    const statusEl = $('#online-hint-status');
    if (statusEl) {
      statusEl.textContent = 'All hints given!';
    }
  }

  // ===== DISCUSSION PHASE =====
  function showDiscussionScreen(timerDuration, players) {
    showScreen('online-discussion');

    const timerEl = $('#online-discussion-timer');
    const playersEl = $('#online-discussion-players');
    const btnVoting = $('#btn-online-voting');

    // Render active players
    if (playersEl) {
      playersEl.innerHTML = '';
      players.forEach(p => {
        const chip = document.createElement('span');
        chip.className = 'player-chip' + (p.eliminated ? ' eliminated' : '') + (isGrandMaster() && isImposterName(p.name) ? ' gm-imposter' : '');
        chip.innerHTML = p.name + gmBadge(p.name);
        playersEl.appendChild(chip);
      });
    }

    // Start local timer
    startOnlineTimer(timerDuration || mp.settings.timerDuration, timerEl);

    // Only host sees voting button
    if (btnVoting) {
      btnVoting.style.display = mp.isHost ? '' : 'none';
    }
  }

  function startOnlineTimer(seconds, displayEl) {
    clearInterval(mp.timerInterval);
    mp.timerSeconds = seconds;
    mp.timerPaused = false;

    if (displayEl) {
      displayEl.textContent = formatTime(mp.timerSeconds);
    }

    mp.timerInterval = setInterval(() => {
      if (mp.timerPaused) return;
      mp.timerSeconds--;

      if (displayEl) {
        displayEl.textContent = formatTime(mp.timerSeconds);

        // Visual warning states
        const parent = displayEl.closest('.timer-display');
        if (parent) {
          parent.classList.remove('warning', 'critical');
          if (mp.timerSeconds <= 10) parent.classList.add('critical');
          else if (mp.timerSeconds <= 30) parent.classList.add('warning');
        }
      }

      if (mp.timerSeconds <= 0) {
        clearInterval(mp.timerInterval);
        // Play timer end sound
        if (typeof window.playTone === 'function') {
          window.playTone(500, 0.5, 'square', 0.1);
        }
      }
    }, 1000);
  }

  function startDiscussion() {
    if (!mp.socket || !mp.isHost) return;
    mp.socket.emit('start-discussion');
    safePlay('playClick');
  }

  function startVoting() {
    if (!mp.socket || !mp.isHost) return;
    clearInterval(mp.timerInterval);
    mp.socket.emit('start-voting');
    safePlay('playClick');
  }

  // ===== VOTING PHASE =====
  function showVotingScreen(candidates, isRevote) {
    mp.selectedVote = null;
    mp.hasVoted = false;
    showScreen('online-voting');

    const container = $('#online-vote-candidates');
    const statusEl = $('#online-vote-status');
    const submitBtn = $('#btn-online-submit-vote');

    const avatars = [
      '\uD83E\uDDD1', '\uD83D\uDC64', '\uD83D\uDE4B', '\uD83E\uDDD1\u200D\uD83D\uDCBC',
      '\uD83E\uDDD1\u200D\uD83C\uDFA4', '\uD83E\uDDD1\u200D\uD83D\uDCBB', '\uD83E\uDDD1\u200D\uD83D\uDD2C',
      '\uD83E\uDDD1\u200D\uD83C\uDFA8', '\uD83E\uDDD1\u200D\uD83D\uDE80', '\uD83E\uDDD1\u200D\u2695\uFE0F',
      '\uD83E\uDDD9', '\uD83E\uDDB9', '\uD83E\uDDDD', '\uD83E\uDDDB', '\uD83E\uDDDE',
      '\uD83E\uDDDC', '\uD83E\uDDD1\u200D\uD83C\uDF73', '\uD83D\uDD75\uFE0F', '\uD83D\uDC7B', '\uD83E\uDD16'
    ];

    if (container) {
      container.innerHTML = '';

      if (isRevote) {
        const notice = document.createElement('p');
        notice.className = 'revote-notice';
        notice.textContent = 'Revote - Choose among tied players';
        container.parentElement.insertBefore(notice, container);
      }

      if (candidates && candidates.length > 0) {
        candidates.forEach((c, i) => {
          const card = document.createElement('div');
          card.className = 'vote-candidate' + (isGrandMaster() && isImposterName(c.name) ? ' gm-imposter' : '');
          card.dataset.name = c.name;
          card.innerHTML = `
            <span class="candidate-avatar">${avatars[i % avatars.length]}</span>
            <span class="candidate-name">${c.name}${gmBadge(c.name)}</span>
          `;
          card.addEventListener('click', () => selectOnlineVote(c.name));
          container.appendChild(card);
        });
      } else {
        container.innerHTML = '<p class="vote-waiting">Waiting for vote phase to begin...</p>';
      }
    }

    if (submitBtn) {
      submitBtn.classList.remove('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submit Vote';
    }

    if (statusEl) {
      statusEl.textContent = 'Select a player to vote for';
    }
  }

  function showVotingWait() {
    // For eliminated players or those who already voted
    showScreen('online-voting');

    const container = $('#online-vote-candidates');
    const submitBtn = $('#btn-online-submit-vote');
    const statusEl = $('#online-vote-status');

    if (container) {
      container.innerHTML = '<p class="vote-waiting">Waiting for all votes...</p>';
    }
    if (submitBtn) submitBtn.classList.add('hidden');
    if (statusEl) statusEl.textContent = 'Votes are being collected...';
  }

  function selectOnlineVote(name) {
    if (mp.hasVoted) return;
    mp.selectedVote = name;

    const container = $('#online-vote-candidates');
    if (container) {
      container.querySelectorAll('.vote-candidate').forEach(c => {
        c.classList.toggle('selected', c.dataset.name === name);
      });
    }

    const submitBtn = $('#btn-online-submit-vote');
    if (submitBtn) submitBtn.disabled = false;

    safePlay('playClick');
  }

  function submitOnlineVote() {
    if (!mp.socket || !mp.selectedVote || mp.hasVoted) return;

    mp.socket.emit('submit-vote', { votedFor: mp.selectedVote });
    mp.hasVoted = true;

    const submitBtn = $('#btn-online-submit-vote');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Vote Submitted';
    }

    const container = $('#online-vote-candidates');
    if (container) {
      container.querySelectorAll('.vote-candidate').forEach(c => {
        c.style.pointerEvents = 'none';
        if (c.dataset.name !== mp.selectedVote) {
          c.style.opacity = '0.5';
        }
      });
    }

    const statusEl = $('#online-vote-status');
    if (statusEl) statusEl.textContent = 'Vote submitted! Waiting for others...';

    safePlay('playClick');
  }

  // ===== ELIMINATION DISPLAY =====
  function showEliminationResults(data) {
    showScreen('elimination');

    const resultsContainer = $('#vote-results');
    const eliminatedReveal = $('#eliminated-reveal');
    const tieSection = $('#tie-section');
    const continueBtn = $('#btn-continue-game');

    // Render vote result bars
    if (resultsContainer && data.results) {
      resultsContainer.innerHTML = '';
      const maxVotes = data.results.length > 0 ? data.results[0][1] : 0;

      data.results.forEach(([name, count], i) => {
        const pct = maxVotes > 0 ? (count / maxVotes) * 100 : 0;
        const bar = document.createElement('div');
        bar.className = 'vote-result-bar';
        bar.innerHTML = `
          <span class="vote-result-name">${name}</span>
          <div class="vote-result-track">
            <div class="vote-result-fill ${count === maxVotes && count > 0 ? 'top' : ''}" style="width: 0%"></div>
          </div>
          <span class="vote-result-count">${count}</span>
        `;
        resultsContainer.appendChild(bar);

        // Animate bar fill
        setTimeout(() => {
          bar.querySelector('.vote-result-fill').style.width = `${pct}%`;
        }, 100 + i * 150);
      });
    }

    // Handle tie
    if (data.tie) {
      if (eliminatedReveal) eliminatedReveal.classList.add('hidden');
      if (tieSection) {
        tieSection.classList.remove('hidden');
        const tieNames = $('#tie-names');
        if (tieNames && data.tiedPlayers) {
          tieNames.textContent = data.tiedPlayers.join(' & ');
        }
      }
      if (continueBtn) continueBtn.classList.add('hidden');

      // Only host can resolve ties
      const revoteBtn = $('#btn-revote');
      const randomBtn = $('#btn-random-eliminate');
      const skipBtn = $('#btn-skip-round');

      if (!mp.isHost) {
        if (revoteBtn) revoteBtn.style.display = 'none';
        if (randomBtn) randomBtn.style.display = 'none';
        if (skipBtn) skipBtn.style.display = 'none';
        // Show waiting message
        if (tieSection) {
          let waitMsg = tieSection.querySelector('.tie-wait-msg');
          if (!waitMsg) {
            waitMsg = document.createElement('p');
            waitMsg.className = 'tie-wait-msg';
            waitMsg.textContent = 'Waiting for host to decide...';
            tieSection.appendChild(waitMsg);
          }
        }
      } else {
        if (revoteBtn) revoteBtn.style.display = '';
        if (randomBtn) randomBtn.style.display = '';
        if (skipBtn) skipBtn.style.display = '';
        // Remove any existing wait message
        const waitMsg = tieSection ? tieSection.querySelector('.tie-wait-msg') : null;
        if (waitMsg) waitMsg.remove();
      }
      return;
    }

    // Handle elimination
    if (tieSection) tieSection.classList.add('hidden');

    if (data.eliminated) {
      if (eliminatedReveal) {
        eliminatedReveal.classList.remove('hidden');
        const nameEl = $('#eliminated-name');
        const roleEl = $('#eliminated-role');

        if (nameEl) nameEl.textContent = data.eliminated;
        if (roleEl) {
          if (data.role === 'imposter') {
            roleEl.textContent = '\uD83D\uDD75\uFE0F Was an IMPOSTER!';
            roleEl.className = 'eliminated-role was-imposter';
          } else {
            roleEl.textContent = '\u2705 Was NOT an imposter';
            roleEl.className = 'eliminated-role was-normal';
          }
        }
        safePlay('playEliminate');
      }
    } else {
      if (eliminatedReveal) eliminatedReveal.classList.add('hidden');
    }

    // Continue button
    if (continueBtn) {
      if (data.gameOver) {
        // Game over will be triggered by separate event; hide continue
        continueBtn.classList.add('hidden');
      } else if (!data.eliminated && !data.tie) {
        // No elimination, no tie - just continue
        continueBtn.classList.add('hidden');
      } else if (data.eliminated && !data.gameOver) {
        // Elimination happened, server will auto-advance after 5s
        continueBtn.classList.remove('hidden');
        continueBtn.textContent = 'Next round starting soon...';
        continueBtn.disabled = true;
      } else {
        continueBtn.classList.add('hidden');
      }
    }
  }

  // ===== TIE RESOLUTION (HOST) =====
  function handleOnlineRevote() {
    if (!mp.socket || !mp.isHost) return;
    mp.socket.emit('tie-resolution', { method: 'revote' });
    safePlay('playClick');
  }

  function handleOnlineRandomEliminate() {
    if (!mp.socket || !mp.isHost) return;
    mp.socket.emit('tie-resolution', { method: 'random' });
    safePlay('playClick');
  }

  function handleOnlineSkipRound() {
    if (!mp.socket || !mp.isHost) return;
    mp.socket.emit('tie-resolution', { method: 'skip' });
    safePlay('playClick');
  }

  // ===== GAME OVER =====
  function showOnlineGameOver(data) {
    clearInterval(mp.timerInterval);
    // Remove Grand Master panel on game over
    const gmPanel = $('#gm-panel');
    if (gmPanel) gmPanel.remove();
    mp.gmImposters = [];
    mp.gmNormalWord = null;
    mp.gmImposterWord = null;
    mp.isObserver = false;

    showScreen('gameover');

    const titleEl = $('#gameover-title');
    const iconEl = $('#gameover-icon');
    const subtitleEl = $('#gameover-subtitle');

    if (data.winner === 'people') {
      if (iconEl) iconEl.textContent = '\uD83C\uDFC6';
      if (titleEl) {
        titleEl.textContent = 'People Win!';
        titleEl.className = 'gameover-title people-win';
      }
      if (subtitleEl) subtitleEl.textContent = 'All imposters have been found and eliminated!';
      safePlay('playWin');

      // Trigger confetti if the function exists in game.js scope
      // We replicate a simple confetti here for online mode
      triggerOnlineConfetti();
    } else {
      if (iconEl) iconEl.textContent = '\uD83C\uDFAD';
      if (titleEl) {
        titleEl.textContent = 'Imposters Win!';
        titleEl.className = 'gameover-title imposter-win';
      }
      if (subtitleEl) subtitleEl.textContent = 'The imposters have taken over!';
      safePlay('playLose');
    }

    // Reveal imposters
    const imposterReveal = $('#imposter-reveal');
    if (imposterReveal && data.imposters) {
      imposterReveal.innerHTML = '';
      data.imposters.forEach(name => {
        const badge = document.createElement('span');
        badge.className = 'imposter-name-badge';
        badge.textContent = name;
        imposterReveal.appendChild(badge);
      });
    }

    // Reveal words
    if (data.words) {
      const normalEl = $('#reveal-normal-word');
      const imposterEl = $('#reveal-imposter-word');
      if (normalEl) normalEl.textContent = data.words.normal;
      if (imposterEl) imposterEl.textContent = data.words.imposter;
    }

    // Stats
    if (data.stats) {
      const roundsEl = $('#stat-rounds');
      const elimEl = $('#stat-eliminated');
      if (roundsEl) roundsEl.textContent = data.stats.rounds;
      if (elimEl) elimEl.textContent = data.stats.eliminated;
    }

    // Show your role
    if (mp.myRole) {
      let roleMsg = subtitleEl ? subtitleEl.textContent : '';
      if (mp.myRole === 'imposter') {
        roleMsg += ' You were an imposter!';
      } else {
        roleMsg += ' You were a normal player.';
      }
      if (subtitleEl) subtitleEl.textContent = roleMsg;
    }

    // Save score to localStorage
    saveScore({
      date: new Date().toISOString(),
      mode: 'online',
      roomCode: mp.roomCode,
      winner: data.winner,
      playerName: mp.playerName,
      role: mp.myRole,
      rounds: data.stats ? data.stats.rounds : 0,
      players: data.players ? data.players.map(p => p.name) : [],
      imposters: data.imposters || [],
    });

    // Reassign game-over buttons for online mode
    const playAgainBtn = $('#btn-play-again');
    const newGameBtn = $('#btn-new-game');

    if (playAgainBtn) {
      if (mp.isHost) {
        playAgainBtn.textContent = 'Play Again';
        playAgainBtn.style.display = '';
        // Detach old handler and set new one
        const newBtn = playAgainBtn.cloneNode(true);
        playAgainBtn.parentNode.replaceChild(newBtn, playAgainBtn);
        newBtn.addEventListener('click', () => {
          if (mp.socket) mp.socket.emit('play-again');
          safePlay('playClick');
        });
      } else {
        playAgainBtn.textContent = 'Waiting for host...';
        playAgainBtn.disabled = true;
        playAgainBtn.style.display = '';
      }
    }

    if (newGameBtn) {
      const newBtn = newGameBtn.cloneNode(true);
      newGameBtn.parentNode.replaceChild(newBtn, newGameBtn);
      newBtn.addEventListener('click', () => {
        backToModeSelect();
        safePlay('playClick');
      });
      newBtn.textContent = 'Leave Game';
    }
  }

  function triggerOnlineConfetti() {
    const canvas = $('#confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const colors = ['#7f5af0', '#2cb67d', '#e53170', '#ff8906', '#fffffe', '#6b46d4'];

    for (let i = 0; i < 120; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 3 + 2,
        w: Math.random() * 8 + 4,
        h: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 10,
        opacity: 1,
      });
    }

    let frame = 0;
    const maxFrames = 180;

    function animate() {
      frame++;
      if (frame > maxFrames) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05;
        p.rotation += p.rotationSpeed;
        if (frame > maxFrames - 40) {
          p.opacity = Math.max(0, p.opacity - 0.025);
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = p.opacity;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });

      requestAnimationFrame(animate);
    }

    animate();
  }

  // ===== BACK TO LOBBY =====
  function returnToLobby(players, host) {
    mp.phase = 'lobby';
    mp.myWord = null;
    mp.myRole = null;
    mp.selectedVote = null;
    mp.hasVoted = false;
    mp.round = 0;
    clearInterval(mp.timerInterval);

    // Clear Grand Master state
    const gmPanel = $('#gm-panel');
    if (gmPanel) gmPanel.remove();
    mp.gmImposters = [];
    mp.gmNormalWord = null;
    mp.gmImposterWord = null;
    mp.isObserver = false;

    mp.players = players;
    mp.isHost = host === mp.playerName;

    showScreen('lobby');
    showLobbyRoom();
    renderPlayerList(players, host);
    updateLobbyHostUI();
    clearLobbyError();

    // Reset word inputs
    const normalInput = $('#lobby-normal-word');
    const imposterInput = $('#lobby-imposter-word');
    if (normalInput) normalInput.value = '';
    if (imposterInput) imposterInput.value = '';
    mp.selectedPair = null;

    const selectedDisplay = $('#selected-pack-words');
    if (selectedDisplay) selectedDisplay.classList.add('hidden');

    // Re-enable play again button in case it was disabled
    const playAgainBtn = $('#btn-play-again');
    if (playAgainBtn) {
      playAgainBtn.disabled = false;
      playAgainBtn.textContent = 'Play Again';
    }
  }

  function showLobbyRoom() {
    // Show room code and connected state
    const roomCodeEl = $('#lobby-room-code');
    if (roomCodeEl) roomCodeEl.textContent = mp.roomCode;

    // Switch from create/join tabs to room view
    const createSection = $('#lobby-create-section');
    const joinSection = $('#lobby-join-section');
    const tabBar = $('#lobby-create-tab');
    const tabBarJoin = $('#lobby-join-tab');

    if (createSection) createSection.classList.add('hidden');
    if (joinSection) joinSection.classList.add('hidden');
    if (tabBar) tabBar.parentElement.classList.add('hidden');

    // Show the room info sections
    const roomInfo = $('#lobby-room-info');
    if (roomInfo) roomInfo.classList.remove('hidden');
  }

  // ===== REGISTER ALL SERVER EVENTS =====
  function registerServerEvents(socket) {

    // --- Room Created ---
    socket.on('room-created', ({ roomCode }) => {
      mp.roomCode = roomCode;
      mp.isHost = true;
      mp.active = true;
      mp.phase = 'lobby';
      clearLobbyError();
      showLobbyRoom();
      updateLobbyHostUI();
      clearChat();
      showCommsPanel();
    });

    // --- Room Joined ---
    socket.on('room-joined', ({ roomCode }) => {
      mp.roomCode = roomCode;
      mp.isHost = false;
      mp.active = true;
      mp.phase = 'lobby';
      clearLobbyError();
      showLobbyRoom();
      updateLobbyHostUI();
      clearChat();
      showCommsPanel();
    });

    // --- Room Error ---
    socket.on('room-error', ({ message }) => {
      showLobbyError(message);
    });

    // --- Player Joined / Updated ---
    socket.on('player-joined', ({ players, host }) => {
      mp.players = players;
      mp.isHost = host === mp.playerName;
      renderPlayerList(players, host);
      updateLobbyHostUI();
    });

    // --- Player Left ---
    socket.on('player-left', ({ playerName, players, host }) => {
      mp.players = players;
      mp.isHost = host === mp.playerName;
      renderPlayerList(players, host);
      updateLobbyHostUI();
    });

    // --- Settings Updated ---
    socket.on('settings-updated', (settings) => {
      applySettings(settings);
    });

    // --- Game Started ---
    socket.on('game-started', ({ phase, players, imposterCount, settings }) => {
      mp.phase = phase;
      mp.settings = { ...mp.settings, ...settings };
      // Reset GM info (will be set by grand-master-info for host)
      mp.gmImposters = [];
      mp.gmNormalWord = null;
      mp.gmImposterWord = null;
    });

    // --- Grand Master Info (host only — sees who imposters are) ---
    socket.on('grand-master-info', ({ imposters, normalWord, imposterWord, participants }) => {
      mp.gmImposters = imposters;
      mp.gmNormalWord = normalWord;
      mp.gmImposterWord = imposterWord;
      mp.isObserver = true;
      // Host doesn't get 'your-word', show observer distribute screen
      showObserverDistribute(participants);
    });

    // --- Your Word (private) ---
    socket.on('your-word', ({ word, role }) => {
      showDistributeScreen(word, role);
    });

    // --- Word Seen Update ---
    socket.on('word-seen-update', ({ seen, total }) => {
      const progress = $('#word-seen-progress');
      if (progress) {
        progress.textContent = `${seen} of ${total} players have seen their word`;
      }
    });

    // --- Phase Change ---
    socket.on('phase-change', ({ phase, round, players, timerDuration, isRevote }) => {
      mp.phase = phase;
      if (round !== undefined) mp.round = round;

      switch (phase) {
        case 'hints':
          showHintsScreen(players || mp.players);
          break;

        case 'discussion':
          showDiscussionScreen(timerDuration, players || mp.players);
          break;

        case 'voting':
          if (mp.isObserver) {
            // Grand Master sees vote progress, not voting UI
            showObserverVoting(players);
          } else if (!isRevote) {
            showVotingWait();
          }
          break;

        default:
          break;
      }
    });

    // --- Hint Update ---
    socket.on('hint-update', ({ hintsGiven, total }) => {
      updateHintProgress(hintsGiven, total);
    });

    // --- All Hints Given ---
    socket.on('all-hints-given', () => {
      showAllHintsGiven();
    });

    // --- Vote Request (private: list of candidates for this player) ---
    socket.on('vote-request', ({ candidates, isRevote }) => {
      showVotingScreen(candidates, isRevote);
    });

    // --- Vote Update (progress) ---
    socket.on('vote-update', ({ votesSubmitted, votesNeeded }) => {
      const statusEl = $('#online-vote-status');
      if (statusEl && (mp.hasVoted || mp.isObserver)) {
        statusEl.textContent = `${votesSubmitted} of ${votesNeeded} votes submitted`;
      }
    });

    // --- Vote Results ---
    socket.on('vote-results', (data) => {
      showEliminationResults(data);
    });

    // --- Game Over ---
    socket.on('game-over', (data) => {
      mp.phase = 'gameover';
      showOnlineGameOver(data);
    });

    // --- Back to Lobby ---
    socket.on('back-to-lobby', ({ players, host }) => {
      returnToLobby(players, host);
    });

    // --- Kicked ---
    socket.on('kicked', () => {
      mp.active = false;
      mp.roomCode = null;
      clearInterval(mp.timerInterval);
      hideCommsPanel();
      showScreen('lobby');

      // Reset lobby to create/join view
      const roomInfo = $('#lobby-room-info');
      if (roomInfo) roomInfo.classList.add('hidden');
      const tabBar = $('#lobby-create-tab');
      if (tabBar) tabBar.parentElement.classList.remove('hidden');
      const createSection = $('#lobby-create-section');
      if (createSection) createSection.classList.remove('hidden');

      showLobbyError('You were kicked from the room.');
    });

    // --- Chat Message ---
    socket.on('chat-message', ({ author, text }) => {
      addChatMessage(author, text, false);
    });

    // --- Voice Signaling ---
    socket.on('voice-existing-peers', ({ peers }) => {
      // When we join voice, connect to all existing peers
      if (!mp.voiceActive) return;
      peers.forEach(({ id, name }) => {
        handleVoicePeerJoined(id, name);
      });
    });

    socket.on('voice-peer-joined', ({ peerId, name }) => {
      handleVoicePeerJoined(peerId, name);
    });

    socket.on('voice-peer-left', ({ peerId, name }) => {
      handleVoicePeerLeft(peerId, name);
    });

    socket.on('voice-offer', ({ fromId, fromName, offer }) => {
      handleVoiceOffer(fromId, fromName, offer);
    });

    socket.on('voice-answer', ({ fromId, answer }) => {
      handleVoiceAnswer(fromId, answer);
    });

    socket.on('voice-ice-candidate', ({ fromId, candidate }) => {
      handleVoiceIceCandidate(fromId, candidate);
    });

    socket.on('voice-mute-status', ({ peerId, name, muted }) => {
      handleVoiceMuteStatus(peerId, name, muted);
    });
  }

  // ===== MODE SELECTION =====
  function selectOnlineMode() {
    safePlay('playClick');
    showScreen('lobby');
    connectSocket();
  }

  function selectLocalMode() {
    safePlay('playClick');
    mp.active = false;
    showScreen('setup');
  }

  // ===== INITIALIZATION =====
  function initMultiplayer() {
    // Mode selection buttons
    const btnOnline = $('#btn-mode-online');
    const btnLocal = $('#btn-mode-local');

    if (btnOnline) {
      btnOnline.addEventListener('click', selectOnlineMode);
    }

    if (btnLocal) {
      btnLocal.addEventListener('click', selectLocalMode);
    }

    // Override the welcome "Start New Game" to go to mode select instead
    const btnStart = $('#btn-start');
    if (btnStart) {
      // Clone and replace to remove existing listener from game.js
      const newBtnStart = btnStart.cloneNode(true);
      btnStart.parentNode.replaceChild(newBtnStart, btnStart);
      newBtnStart.addEventListener('click', () => {
        safePlay('playClick');
        showScreen('mode-select');
      });
    }

    // Lobby: Create / Join
    initLobbyTabs();

    const btnCreate = $('#btn-create-room');
    if (btnCreate) {
      btnCreate.addEventListener('click', createRoom);
    }

    const btnJoin = $('#btn-join-room');
    if (btnJoin) {
      btnJoin.addEventListener('click', joinRoom);
    }

    // Allow Enter key in room code input
    const joinCodeInput = $('#join-room-code');
    if (joinCodeInput) {
      joinCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
      });
      // Auto-uppercase
      joinCodeInput.addEventListener('input', () => {
        joinCodeInput.value = joinCodeInput.value.toUpperCase();
      });
    }

    // Allow Enter key in name inputs
    const createNameInput = $('#create-player-name');
    if (createNameInput) {
      createNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createRoom();
      });
    }

    const joinNameInput = $('#join-player-name');
    if (joinNameInput) {
      joinNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
      });
    }

    // Lobby: Settings
    initSettings();

    // Lobby: Word mode
    initWordMode();

    // Word pack shuffle button
    const shuffleBtn = $('#btn-shuffle-words');
    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        shufflePackWords();
        safePlay('playClick');
      });
    }

    // Lobby: Start game (host only)
    const btnLobbyStart = $('#btn-lobby-start');
    if (btnLobbyStart) {
      btnLobbyStart.addEventListener('click', startGame);
    }

    // Distribute: word seen
    const btnWordSeen = $('#btn-word-seen');
    if (btnWordSeen) {
      btnWordSeen.addEventListener('click', wordSeen);
    }

    // Hints: hint given
    const btnHintGiven = $('#btn-hint-given');
    if (btnHintGiven) {
      btnHintGiven.addEventListener('click', hintGiven);
    }

    // Hints: proceed to discussion (host)
    const btnOnlineDiscussion = $('#btn-online-discussion');
    if (btnOnlineDiscussion) {
      btnOnlineDiscussion.addEventListener('click', startDiscussion);
    }

    // Discussion: proceed to voting (host)
    const btnOnlineVoting = $('#btn-online-voting');
    if (btnOnlineVoting) {
      btnOnlineVoting.addEventListener('click', startVoting);
    }

    // Voting: submit vote
    const btnOnlineSubmitVote = $('#btn-online-submit-vote');
    if (btnOnlineSubmitVote) {
      btnOnlineSubmitVote.addEventListener('click', submitOnlineVote);
    }

    // Tie resolution buttons (online mode overrides)
    // These are shared DOM elements, so we use a dedicated handler
    // that checks if we're in online mode
    const btnRevote = $('#btn-revote');
    const btnRandom = $('#btn-random-eliminate');
    const btnSkip = $('#btn-skip-round');

    if (btnRevote) {
      btnRevote.addEventListener('click', (e) => {
        if (mp.active) {
          e.stopImmediatePropagation();
          handleOnlineRevote();
        }
      });
    }

    if (btnRandom) {
      btnRandom.addEventListener('click', (e) => {
        if (mp.active) {
          e.stopImmediatePropagation();
          handleOnlineRandomEliminate();
        }
      });
    }

    if (btnSkip) {
      btnSkip.addEventListener('click', (e) => {
        if (mp.active) {
          e.stopImmediatePropagation();
          handleOnlineSkipRound();
        }
      });
    }

    // Back buttons from online screens to lobby/mode select
    const btnBackToLobby = $('#btn-back-to-lobby');
    if (btnBackToLobby) {
      btnBackToLobby.addEventListener('click', () => {
        backToModeSelect();
        safePlay('playClick');
      });
    }

    // Copy room code button
    const btnCopyCode = $('#btn-copy-room-code');
    if (btnCopyCode) {
      btnCopyCode.addEventListener('click', () => {
        if (mp.roomCode) {
          navigator.clipboard.writeText(mp.roomCode).then(() => {
            btnCopyCode.textContent = 'Copied!';
            setTimeout(() => { btnCopyCode.textContent = 'Copy'; }, 2000);
          }).catch(() => {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = mp.roomCode;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            btnCopyCode.textContent = 'Copied!';
            setTimeout(() => { btnCopyCode.textContent = 'Copy'; }, 2000);
          });
        }
        safePlay('playClick');
      });
    }

    // Inject overlay styles
    injectOverlayStyles();

    // Initialize chat & voice panel
    initCommsPanel();
  }

  // ===== OVERLAY STYLES =====
  function injectOverlayStyles() {
    if ($('#mp-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'mp-overlay-styles';
    style.textContent = `
      .mp-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }
      .mp-overlay.visible {
        opacity: 1;
        pointer-events: all;
      }
      .mp-overlay-content {
        text-align: center;
        padding: 2rem;
        background: var(--bg-card, #1e1c3c);
        border-radius: var(--radius, 12px);
        max-width: 400px;
        width: 90%;
      }
      .mp-overlay-icon {
        font-size: 3rem;
        margin-bottom: 1rem;
      }
      .mp-overlay-content h3 {
        margin-bottom: 0.5rem;
        color: var(--text, #fff);
      }
      .mp-overlay-content p {
        margin-bottom: 1.5rem;
        color: var(--text-secondary, #a7a9be);
      }
      .revote-notice {
        color: var(--warning, #ff8906);
        font-weight: 600;
        margin-bottom: 1rem;
        text-align: center;
      }
      .vote-waiting {
        text-align: center;
        color: var(--text-secondary, #a7a9be);
        padding: 2rem 0;
      }
      .tie-wait-msg {
        color: var(--text-secondary, #a7a9be);
        margin-top: 1rem;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }

  // ===== CHAT & VOICE SYSTEM =====

  // --- COMMS PANEL UI ---
  function initCommsPanel() {
    const chatTab = $('#comms-chat-tab');
    const voiceTab = $('#comms-voice-tab');
    const minimizeBtn = $('#comms-minimize');
    const openBtn = $('#comms-open-btn');
    const sendBtn = $('#btn-send-chat');
    const chatInput = $('#chat-input');
    const voiceToggle = $('#btn-voice-toggle');
    const voiceMute = $('#btn-voice-mute');

    if (chatTab) chatTab.addEventListener('click', () => switchCommsTab('chat'));
    if (voiceTab) voiceTab.addEventListener('click', () => switchCommsTab('voice'));
    if (minimizeBtn) minimizeBtn.addEventListener('click', minimizeComms);
    if (openBtn) openBtn.addEventListener('click', openComms);
    if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
    }
    if (voiceToggle) voiceToggle.addEventListener('click', toggleVoice);
    if (voiceMute) voiceMute.addEventListener('click', toggleMute);
  }

  function showCommsPanel() {
    const panel = $('#comms-panel');
    const openBtn = $('#comms-open-btn');
    if (panel) panel.classList.remove('hidden');
    if (openBtn) openBtn.classList.add('hidden');
    mp.commsPanelOpen = true;
    mp.unreadCount = 0;
    updateUnreadBadge();
  }

  function hideCommsPanel() {
    const panel = $('#comms-panel');
    const openBtn = $('#comms-open-btn');
    if (panel) panel.classList.add('hidden');
    if (openBtn) openBtn.classList.add('hidden');
    mp.commsPanelOpen = false;

    // Clean up voice if leaving
    if (mp.voiceActive) leaveVoice();
  }

  function minimizeComms() {
    const panel = $('#comms-panel');
    const openBtn = $('#comms-open-btn');
    if (panel) panel.classList.add('hidden');
    if (openBtn) openBtn.classList.remove('hidden');
    mp.commsPanelOpen = false;
  }

  function openComms() {
    const panel = $('#comms-panel');
    const openBtn = $('#comms-open-btn');
    if (panel) panel.classList.remove('hidden');
    if (openBtn) openBtn.classList.add('hidden');
    mp.commsPanelOpen = true;
    mp.unreadCount = 0;
    updateUnreadBadge();
  }

  function switchCommsTab(tab) {
    mp.commsTab = tab;
    const chatTab = $('#comms-chat-tab');
    const voiceTab = $('#comms-voice-tab');
    const chatSection = $('#comms-chat');
    const voiceSection = $('#comms-voice');

    if (tab === 'chat') {
      if (chatTab) chatTab.classList.add('active');
      if (voiceTab) voiceTab.classList.remove('active');
      if (chatSection) chatSection.classList.remove('hidden');
      if (voiceSection) voiceSection.classList.add('hidden');
      mp.unreadCount = 0;
      updateUnreadBadge();
    } else {
      if (chatTab) chatTab.classList.remove('active');
      if (voiceTab) voiceTab.classList.add('active');
      if (chatSection) chatSection.classList.add('hidden');
      if (voiceSection) voiceSection.classList.remove('hidden');
    }
  }

  function updateUnreadBadge() {
    const openBtn = $('#comms-open-btn');
    if (!openBtn) return;
    let badge = openBtn.querySelector('.unread-badge');
    if (mp.unreadCount > 0 && !mp.commsPanelOpen) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        openBtn.appendChild(badge);
      }
      badge.textContent = mp.unreadCount > 9 ? '9+' : mp.unreadCount;
    } else if (badge) {
      badge.remove();
    }
  }

  // --- CHAT ---
  function sendChatMessage() {
    const input = $('#chat-input');
    if (!input || !mp.socket) return;
    const text = input.value.trim();
    if (!text) return;
    mp.socket.emit('chat-message', { message: text });
    input.value = '';
  }

  function addChatMessage(author, text, isSystem) {
    const container = $('#chat-messages');
    if (!container) return;

    const msg = document.createElement('div');
    msg.className = 'chat-msg' + (isSystem ? ' chat-system' : '');
    if (isSystem) {
      msg.innerHTML = `<span class="chat-text">${escapeHtml(text)}</span>`;
    } else {
      msg.innerHTML = `<span class="chat-author">${escapeHtml(author)}</span><span class="chat-text">${escapeHtml(text)}</span>`;
    }
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;

    // Update unread count if panel is minimized or on voice tab
    if (!mp.commsPanelOpen || mp.commsTab !== 'chat') {
      mp.unreadCount++;
      updateUnreadBadge();
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function clearChat() {
    const container = $('#chat-messages');
    if (container) container.innerHTML = '';
  }

  // --- VOICE (WebRTC) ---
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  async function toggleVoice() {
    if (mp.voiceActive) {
      leaveVoice();
    } else {
      await joinVoice();
    }
  }

  async function joinVoice() {
    if (!mp.socket || mp.voiceActive) return;

    try {
      mp.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      mp.voiceActive = true;
      mp.voiceMuted = false;

      mp.socket.emit('voice-join');

      updateVoiceUI();
      addChatMessage(null, 'You joined voice chat', true);
    } catch (err) {
      addChatMessage(null, 'Could not access microphone: ' + err.message, true);
    }
  }

  function leaveVoice() {
    if (!mp.voiceActive) return;

    // Close all peer connections
    Object.keys(mp.peers).forEach(peerId => closePeer(peerId));

    // Stop local stream
    if (mp.localStream) {
      mp.localStream.getTracks().forEach(t => t.stop());
      mp.localStream = null;
    }

    mp.voiceActive = false;
    mp.voiceMuted = false;

    if (mp.socket) mp.socket.emit('voice-leave');

    updateVoiceUI();
    addChatMessage(null, 'You left voice chat', true);
  }

  function toggleMute() {
    if (!mp.voiceActive || !mp.localStream) return;
    mp.voiceMuted = !mp.voiceMuted;
    mp.localStream.getAudioTracks().forEach(t => { t.enabled = !mp.voiceMuted; });
    if (mp.socket) mp.socket.emit('voice-mute-status', { muted: mp.voiceMuted });
    updateVoiceUI();
  }

  function createPeerConnection(peerId, peerName) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    mp.peers[peerId] = { pc, name: peerName, muted: false };

    // Add local tracks
    if (mp.localStream) {
      mp.localStream.getTracks().forEach(t => pc.addTrack(t, mp.localStream));
    }

    // Handle incoming audio
    pc.ontrack = (event) => {
      // Remove any existing audio element for this peer
      const existingAudio = document.getElementById('voice-audio-' + peerId);
      if (existingAudio) existingAudio.remove();

      const audio = document.createElement('audio');
      audio.srcObject = event.streams[0];
      audio.autoplay = true;
      audio.id = 'voice-audio-' + peerId;
      audio.setAttribute('playsinline', '');
      document.body.appendChild(audio);

      // Explicitly play to handle browser autoplay restrictions
      audio.play().catch(() => {
        // If autoplay blocked, try again on next user interaction
        const resumePlay = () => {
          audio.play().catch(() => {});
          document.removeEventListener('click', resumePlay);
          document.removeEventListener('touchstart', resumePlay);
        };
        document.addEventListener('click', resumePlay);
        document.addEventListener('touchstart', resumePlay);
      });
    };

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && mp.socket) {
        mp.socket.emit('voice-ice-candidate', { targetId: peerId, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        closePeer(peerId);
        updateVoiceParticipants();
      }
    };

    return pc;
  }

  function closePeer(peerId) {
    const peer = mp.peers[peerId];
    if (!peer) return;
    peer.pc.close();
    delete mp.peers[peerId];
    const audioEl = document.getElementById('voice-audio-' + peerId);
    if (audioEl) audioEl.remove();
  }

  async function handleVoicePeerJoined(peerId, peerName) {
    if (!mp.voiceActive || peerId === mp.socket.id) return;

    // Create offer for new peer
    const pc = createPeerConnection(peerId, peerName);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      mp.socket.emit('voice-offer', { targetId: peerId, offer });
    } catch (err) {
      closePeer(peerId);
    }

    updateVoiceParticipants();
    addChatMessage(null, peerName + ' joined voice chat', true);
  }

  async function handleVoiceOffer(fromId, fromName, offer) {
    if (!mp.voiceActive) return;

    const pc = createPeerConnection(fromId, fromName);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      mp.socket.emit('voice-answer', { targetId: fromId, answer });
    } catch (err) {
      closePeer(fromId);
    }

    updateVoiceParticipants();
  }

  async function handleVoiceAnswer(fromId, answer) {
    const peer = mp.peers[fromId];
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      // ignore
    }
  }

  async function handleVoiceIceCandidate(fromId, candidate) {
    const peer = mp.peers[fromId];
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // ignore
    }
  }

  function handleVoicePeerLeft(peerId, peerName) {
    closePeer(peerId);
    updateVoiceParticipants();
    addChatMessage(null, peerName + ' left voice chat', true);
  }

  function handleVoiceMuteStatus(peerId, peerName, muted) {
    const peer = mp.peers[peerId];
    if (peer) peer.muted = muted;
    updateVoiceParticipants();
  }

  function updateVoiceUI() {
    const toggleBtn = $('#btn-voice-toggle');
    const muteBtn = $('#btn-voice-mute');
    const statusText = $('#voice-status-text');
    const statusEl = $('#voice-status');

    if (mp.voiceActive) {
      if (toggleBtn) {
        toggleBtn.textContent = '📴 Leave Voice';
        toggleBtn.classList.remove('btn-primary');
        toggleBtn.classList.add('btn-danger');
      }
      if (muteBtn) {
        muteBtn.classList.remove('hidden');
        muteBtn.textContent = mp.voiceMuted ? '🔊 Unmute' : '🔇 Mute';
      }
      if (statusText) statusText.textContent = mp.voiceMuted ? 'Muted' : 'Voice chat active';
      if (statusEl) statusEl.classList.toggle('voice-active', !mp.voiceMuted);
    } else {
      if (toggleBtn) {
        toggleBtn.textContent = '🎤 Join Voice';
        toggleBtn.classList.add('btn-primary');
        toggleBtn.classList.remove('btn-danger');
      }
      if (muteBtn) muteBtn.classList.add('hidden');
      if (statusText) statusText.textContent = 'Voice chat off';
      if (statusEl) statusEl.classList.remove('voice-active');
    }

    updateVoiceParticipants();
  }

  function updateVoiceParticipants() {
    const container = $('#voice-participants');
    if (!container) return;
    container.innerHTML = '';

    // Show self if active
    if (mp.voiceActive) {
      const self = document.createElement('div');
      self.className = 'voice-participant' + (mp.voiceMuted ? ' muted' : '');
      self.innerHTML = `<span class="voice-indicator"></span><span>${escapeHtml(mp.playerName)} (You)</span>`;
      container.appendChild(self);
    }

    // Show peers
    Object.entries(mp.peers).forEach(([id, peer]) => {
      const el = document.createElement('div');
      el.className = 'voice-participant' + (peer.muted ? ' muted' : '');
      el.innerHTML = `<span class="voice-indicator"></span><span>${escapeHtml(peer.name)}</span>`;
      container.appendChild(el);
    });

    if (!mp.voiceActive && Object.keys(mp.peers).length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.8rem;width:100%;text-align:center;">No one in voice chat</p>';
    }
  }

  // ===== EXPOSE FOR EXTERNAL ACCESS =====
  window.imposterMultiplayer = {
    isActive: () => mp.active,
    getState: () => ({ ...mp }),
    disconnect: disconnectSocket,
  };

  // ===== BOOT =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMultiplayer);
  } else {
    initMultiplayer();
  }

})();
