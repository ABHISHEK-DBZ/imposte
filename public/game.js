// ===== IMPOSTER GAME ENGINE =====

(function () {
  'use strict';

  // ===== STATE =====
  const state = {
    players: [],          // { name, isImposter, eliminated }
    coordinator: null,    // player name or null
    normalWord: '',
    imposterWord: '',
    currentPhase: 'welcome',
    distributeIndex: 0,
    votingIndex: 0,
    votes: {},            // { voterName: votedForName }
    currentVoter: null,
    selectedCandidate: null,
    round: 0,
    hintsGiven: new Set(),
    timerInterval: null,
    timerSeconds: 0,
    timerPaused: false,
    soundEnabled: true,
    tiedPlayers: [],
  };

  // ===== AUDIO =====
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new AudioCtx(); } catch (e) { /* no audio */ }
    }
  }

  function playTone(freq, duration, type = 'sine', vol = 0.15) {
    if (!state.soundEnabled || !audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(vol, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) { /* ignore */ }
  }

  function playClick() { playTone(600, 0.08, 'sine', 0.1); }
  function playReveal() { playTone(800, 0.15, 'sine', 0.12); setTimeout(() => playTone(1200, 0.2, 'sine', 0.12), 100); }
  function playEliminate() { playTone(300, 0.3, 'triangle', 0.15); setTimeout(() => playTone(200, 0.4, 'triangle', 0.15), 200); }
  function playWin() { [0, 100, 200, 300].forEach((d, i) => setTimeout(() => playTone(600 + i * 200, 0.2, 'sine', 0.12), d)); }
  function playLose() { [0, 200, 400].forEach((d, i) => setTimeout(() => playTone(400 - i * 100, 0.3, 'triangle', 0.12), d)); }

  // Expose sound functions for multiplayer.js
  window.playTone = playTone;
  window.playClick = playClick;
  window.playReveal = playReveal;
  window.playEliminate = playEliminate;
  window.playWin = playWin;
  window.playLose = playLose;

  // ===== DOM HELPERS =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const screen = $(`#screen-${id}`);
    if (screen) {
      screen.classList.add('active');
      screen.style.animation = 'none';
      screen.offsetHeight; // reflow
      screen.style.animation = '';
    }
    state.currentPhase = id;
  }

  // ===== THEME =====
  function initTheme() {
    const saved = localStorage.getItem('imposter-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcons(saved);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('imposter-theme', next);
    updateThemeIcons(next);
    playClick();
  }

  function updateThemeIcons(theme) {
    $('.theme-dark').classList.toggle('hidden', theme !== 'dark');
    $('.theme-light').classList.toggle('hidden', theme !== 'light');
  }

  // ===== SOUND TOGGLE =====
  function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    $('.sound-on').classList.toggle('hidden', !state.soundEnabled);
    $('.sound-off').classList.toggle('hidden', state.soundEnabled);
    if (state.soundEnabled) {
      ensureAudio();
      playClick();
    }
  }

  // ===== IMPOSTER COUNT LOGIC =====
  function getImposterCount(playerCount) {
    if (playerCount <= 9) return 1;
    if (playerCount <= 12) return 2;
    return 3; // > 12
  }

  // ===== SETUP SCREEN =====
  function updatePlayerCount() {
    const names = getPlayerNames();
    const count = names.length;
    const infoDiv = $('#game-info');
    if (count >= 3) {
      const imposterCount = getImposterCount(count);
      $('#info-player-count').textContent = count;
      $('#info-imposter-count').textContent = imposterCount;
      infoDiv.classList.remove('hidden');
    } else {
      infoDiv.classList.add('hidden');
    }
    updateCoordinatorDropdown(names);
    updateRemoveButtons();
  }

  function getPlayerNames() {
    const inputs = $$('.player-name');
    const names = [];
    inputs.forEach(input => {
      const name = input.value.trim();
      if (name) names.push(name);
    });
    return names;
  }

  function updateCoordinatorDropdown(names) {
    const select = $('#coordinator-select');
    const prevValue = select.value;
    select.innerHTML = '<option value="">None (everyone plays)</option>';
    names.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    if (names.includes(prevValue)) {
      select.value = prevValue;
    }
  }

  function updateRemoveButtons() {
    const rows = $$('.player-input-row');
    rows.forEach(row => {
      const btn = row.querySelector('.btn-remove-player');
      btn.classList.toggle('hidden', rows.length <= 3);
    });
  }

  function addPlayerInput() {
    const container = $('#player-inputs');
    const count = container.children.length + 1;
    const row = document.createElement('div');
    row.className = 'player-input-row';
    row.innerHTML = `
      <input type="text" class="input player-name" placeholder="Player ${count}" maxlength="20" autocomplete="off">
      <button class="btn-icon btn-remove-player" title="Remove">✕</button>
    `;
    container.appendChild(row);

    const removeBtn = row.querySelector('.btn-remove-player');
    removeBtn.addEventListener('click', () => {
      row.remove();
      renumberPlaceholders();
      updatePlayerCount();
      playClick();
    });

    const input = row.querySelector('.player-name');
    input.addEventListener('input', updatePlayerCount);
    input.focus();

    updateRemoveButtons();
    playClick();
  }

  function renumberPlaceholders() {
    $$('.player-name').forEach((input, i) => {
      input.placeholder = `Player ${i + 1}`;
    });
  }

  // ===== START GAME =====
  function validateAndStartGame() {
    const errorEl = $('#setup-error');
    errorEl.classList.add('hidden');

    const names = getPlayerNames();
    const coordinator = $('#coordinator-select').value;
    const normalWord = $('#normal-word').value.trim();
    const imposterWord = $('#imposter-word').value.trim();

    // Validations
    const uniqueNames = new Set(names.map(n => n.toLowerCase()));
    if (names.length < 3) {
      return showError('You need at least 3 players.');
    }
    if (uniqueNames.size !== names.length) {
      return showError('Player names must be unique.');
    }
    if (!normalWord) {
      return showError('Enter a normal word.');
    }
    if (!imposterWord) {
      return showError('Enter an imposter word.');
    }
    if (normalWord.toLowerCase() === imposterWord.toLowerCase()) {
      return showError('Normal and imposter words must be different.');
    }

    // Determine active players (exclude coordinator)
    const activePlayers = coordinator
      ? names.filter(n => n !== coordinator)
      : names;

    if (activePlayers.length < 3) {
      return showError('Need at least 3 active players (excluding coordinator).');
    }

    // Assign roles
    const imposterCount = getImposterCount(activePlayers.length);
    const shuffled = [...activePlayers].sort(() => Math.random() - 0.5);
    const imposters = new Set(shuffled.slice(0, imposterCount));

    state.players = activePlayers.map(name => ({
      name,
      isImposter: imposters.has(name),
      eliminated: false,
    }));
    state.coordinator = coordinator || null;
    state.normalWord = normalWord;
    state.imposterWord = imposterWord;
    state.round = 0;
    state.distributeIndex = 0;
    state.votes = {};
    state.hintsGiven = new Set();
    state.tiedPlayers = [];

    ensureAudio();
    playClick();
    startDistribution();
  }

  function showError(msg) {
    const errorEl = $('#setup-error');
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  // ===== DISTRIBUTION PHASE =====
  function startDistribution() {
    state.distributeIndex = 0;
    showScreen('distribute');
    showPassPrompt();
  }

  function showPassPrompt() {
    const player = state.players[state.distributeIndex];
    if (!player) {
      startHintRound();
      return;
    }

    const total = state.players.length;
    const current = state.distributeIndex + 1;

    $('#distribute-progress').style.width = `${(current / total) * 100}%`;
    $('#distribute-counter').textContent = `Player ${current} of ${total}`;
    $('#pass-player-name').textContent = player.name;

    $('#pass-prompt').classList.remove('hidden');
    $('#word-reveal').classList.add('hidden');
  }

  function revealWord() {
    const player = state.players[state.distributeIndex];
    const word = player.isImposter ? state.imposterWord : state.normalWord;

    $('#reveal-word').textContent = word;
    $('#pass-prompt').classList.add('hidden');
    $('#word-reveal').classList.remove('hidden');

    playReveal();
  }

  function hideAndPass() {
    state.distributeIndex++;
    playClick();

    if (state.distributeIndex >= state.players.length) {
      startHintRound();
    } else {
      showPassPrompt();
    }
  }

  // ===== HINT ROUND =====
  function startHintRound() {
    clearInterval(state.timerInterval);
    state.round++;
    state.hintsGiven = new Set();
    showScreen('hints');

    const container = $('#hint-players');
    container.innerHTML = '';

    const activePlayers = state.players.filter(p => !p.eliminated);
    activePlayers.forEach(player => {
      const item = document.createElement('div');
      item.className = 'hint-player-item';
      item.dataset.name = player.name;
      item.innerHTML = `
        <span class="player-hint-name">${player.name}</span>
        <span class="hint-status">Waiting...</span>
      `;
      item.addEventListener('click', () => toggleHint(player.name, item));
      container.appendChild(item);
    });

    updateHintButton();
  }

  function toggleHint(name, item) {
    if (state.hintsGiven.has(name)) {
      state.hintsGiven.delete(name);
      item.classList.remove('done');
      item.querySelector('.hint-status').textContent = 'Waiting...';
    } else {
      state.hintsGiven.add(name);
      item.classList.add('done');
      item.querySelector('.hint-status').textContent = '✓ Done';
      playClick();
    }
    updateHintButton();
  }

  function updateHintButton() {
    const activePlayers = state.players.filter(p => !p.eliminated);
    const allDone = activePlayers.every(p => state.hintsGiven.has(p.name));
    $('#btn-start-discussion').disabled = !allDone;
  }

  // ===== DISCUSSION PHASE =====
  function startDiscussion() {
    showScreen('discussion');
    playClick();

    // Show active players
    const container = $('#discussion-players');
    container.innerHTML = '';
    state.players.forEach(player => {
      const chip = document.createElement('span');
      chip.className = 'player-chip' + (player.eliminated ? ' eliminated' : '');
      chip.textContent = player.name;
      container.appendChild(chip);
    });

    // Start timer (2 minutes)
    startTimer(120, 'discussion-timer-text');
  }

  // ===== TIMER =====
  function startTimer(seconds, elementId) {
    clearInterval(state.timerInterval);
    state.timerSeconds = seconds;
    state.timerPaused = false;
    updateTimerDisplay(elementId);

    state.timerInterval = setInterval(() => {
      if (state.timerPaused) return;
      state.timerSeconds--;
      updateTimerDisplay(elementId);

      if (state.timerSeconds <= 0) {
        clearInterval(state.timerInterval);
        playTone(500, 0.5, 'square', 0.1);
      }
    }, 1000);
  }

  function updateTimerDisplay(elementId) {
    const el = $(`#${elementId}`);
    if (!el) return;
    const mins = Math.floor(state.timerSeconds / 60);
    const secs = state.timerSeconds % 60;
    el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const parent = el.closest('.timer-display');
    if (parent) {
      parent.classList.remove('warning', 'critical');
      if (state.timerSeconds <= 10) parent.classList.add('critical');
      else if (state.timerSeconds <= 30) parent.classList.add('warning');
    }
  }

  function pauseTimer() {
    state.timerPaused = !state.timerPaused;
    $('#btn-pause-timer').textContent = state.timerPaused ? '▶ Resume' : '⏸ Pause';
  }

  function resetTimer() {
    startTimer(120, 'discussion-timer-text');
    $('#btn-pause-timer').textContent = '⏸ Pause';
  }

  // ===== VOTING PHASE =====
  function startVoting() {
    clearInterval(state.timerInterval);

    const activePlayers = state.players.filter(p => !p.eliminated);
    state.votes = {};
    state.votingIndex = 0;
    state.selectedCandidate = null;

    showScreen('voting');
    showVoterPrompt(activePlayers);
  }

  function showVoterPrompt(activePlayers) {
    if (state.votingIndex >= activePlayers.length) {
      tallyVotes();
      return;
    }

    const voter = activePlayers[state.votingIndex];
    state.currentVoter = voter.name;
    state.selectedCandidate = null;

    const total = activePlayers.length;
    const current = state.votingIndex + 1;

    $('#voting-progress').style.width = `${(current / total) * 100}%`;
    $('#voting-counter').textContent = `Voter ${current} of ${total}`;
    $('#voter-name').textContent = voter.name;

    $('#voter-prompt').classList.remove('hidden');
    $('#vote-selection').classList.add('hidden');
  }

  function showVoteSelection() {
    const activePlayers = state.players.filter(p => !p.eliminated);
    const voter = state.currentVoter;

    $('#voter-prompt').classList.add('hidden');
    $('#vote-selection').classList.remove('hidden');
    $('#vote-header').textContent = `${voter}, who is the imposter?`;

    const container = $('#vote-candidates');
    container.innerHTML = '';

    const avatars = ['🧑', '👤', '🙋', '🧑‍💼', '🧑‍🎤', '🧑‍💻', '🧑‍🔬', '🧑‍🎨', '🧑‍🚀', '🧑‍⚕️', '🧙', '🦹', '🧝', '🧛', '🧞', '🧜', '🧑‍🍳', '🕵️', '👻', '🤖'];

    activePlayers.forEach((player, i) => {
      if (player.name === voter) return; // can't vote for self

      const card = document.createElement('div');
      card.className = 'vote-candidate';
      card.dataset.name = player.name;
      card.innerHTML = `
        <span class="candidate-avatar">${avatars[i % avatars.length]}</span>
        <span class="candidate-name">${player.name}</span>
      `;
      card.addEventListener('click', () => selectCandidate(player.name));
      container.appendChild(card);
    });

    $('#btn-submit-vote').disabled = true;
    playClick();
  }

  function selectCandidate(name) {
    state.selectedCandidate = name;
    $$('.vote-candidate').forEach(c => {
      c.classList.toggle('selected', c.dataset.name === name);
    });
    $('#btn-submit-vote').disabled = false;
    playClick();
  }

  function submitVote() {
    if (!state.selectedCandidate) return;

    state.votes[state.currentVoter] = state.selectedCandidate;
    state.votingIndex++;
    playClick();

    const activePlayers = state.players.filter(p => !p.eliminated);
    if (state.votingIndex >= activePlayers.length) {
      tallyVotes();
    } else {
      showVoterPrompt(activePlayers);
    }
  }

  // ===== TALLY & ELIMINATE =====
  function tallyVotes() {
    showScreen('elimination');

    // Count votes
    const voteCounts = {};
    const activePlayers = state.players.filter(p => !p.eliminated);
    activePlayers.forEach(p => { voteCounts[p.name] = 0; });

    Object.values(state.votes).forEach(votedFor => {
      voteCounts[votedFor] = (voteCounts[votedFor] || 0) + 1;
    });

    // Sort by votes descending
    const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
    const maxVotes = sorted[0][1];

    // Render vote result bars
    const resultsContainer = $('#vote-results');
    resultsContainer.innerHTML = '';

    sorted.forEach(([name, count], i) => {
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

    // Find tied players at the top
    const tiedAtTop = sorted.filter(([, count]) => count === maxVotes);

    if (maxVotes === 0) {
      // No votes cast somehow — skip
      $('#eliminated-reveal').classList.add('hidden');
      $('#tie-section').classList.add('hidden');
      $('#btn-continue-game').classList.remove('hidden');
      return;
    }

    if (tiedAtTop.length > 1) {
      // Tie!
      state.tiedPlayers = tiedAtTop.map(([name]) => name);
      $('#eliminated-reveal').classList.add('hidden');
      $('#tie-section').classList.remove('hidden');
      $('#tie-names').textContent = state.tiedPlayers.join(' & ');
      $('#btn-continue-game').classList.add('hidden');
    } else {
      // Single elimination
      const eliminatedName = sorted[0][0];
      eliminatePlayer(eliminatedName);
    }
  }

  function eliminatePlayer(name) {
    const player = state.players.find(p => p.name === name);
    player.eliminated = true;

    $('#eliminated-reveal').classList.remove('hidden');
    $('#tie-section').classList.add('hidden');
    $('#eliminated-name').textContent = name;

    const roleEl = $('#eliminated-role');
    if (player.isImposter) {
      roleEl.textContent = '🕵️ Was an IMPOSTER!';
      roleEl.className = 'eliminated-role was-imposter';
    } else {
      roleEl.textContent = '✅ Was NOT an imposter';
      roleEl.className = 'eliminated-role was-normal';
    }

    playEliminate();

    // Check win condition
    const result = checkWinCondition();
    if (result) {
      $('#btn-continue-game').classList.remove('hidden');
      $('#btn-continue-game').textContent = 'See Results';
      $('#btn-continue-game').onclick = () => showGameOver(result);
    } else {
      $('#btn-continue-game').classList.remove('hidden');
      $('#btn-continue-game').textContent = 'Next Round';
      $('#btn-continue-game').onclick = () => startHintRound();
    }
  }

  // Tie-breaker handlers
  function handleRevote() {
    playClick();
    // Revote only among tied players
    state.votes = {};
    state.votingIndex = 0;
    state.selectedCandidate = null;

    showScreen('voting');
    const tiedPlayerObjects = state.players.filter(p => !p.eliminated && state.tiedPlayers.includes(p.name));
    showVoterPrompt(tiedPlayerObjects);
  }

  function handleRandomEliminate() {
    playClick();
    const randomIndex = Math.floor(Math.random() * state.tiedPlayers.length);
    const name = state.tiedPlayers[randomIndex];
    eliminatePlayer(name);
  }

  function handleSkipRound() {
    playClick();
    clearInterval(state.timerInterval);
    const result = checkWinCondition();
    if (result) {
      showGameOver(result);
    } else {
      startHintRound();
    }
  }

  // ===== WIN CONDITION =====
  function checkWinCondition() {
    const active = state.players.filter(p => !p.eliminated);
    const imposters = active.filter(p => p.isImposter);
    const normals = active.filter(p => !p.isImposter);

    if (imposters.length === 0) return 'people';
    if (imposters.length >= normals.length) return 'imposters';
    return null; // game continues
  }

  // ===== GAME OVER =====
  function showGameOver(result) {
    clearInterval(state.timerInterval);
    showScreen('gameover');

    const titleEl = $('#gameover-title');
    const iconEl = $('#gameover-icon');
    const subtitleEl = $('#gameover-subtitle');

    if (result === 'people') {
      iconEl.textContent = '🏆';
      titleEl.textContent = 'People Win!';
      titleEl.className = 'gameover-title people-win';
      subtitleEl.textContent = 'All imposters have been found and eliminated!';
      playWin();
      triggerConfetti();
    } else {
      iconEl.textContent = '🎭';
      titleEl.textContent = 'Imposters Win!';
      titleEl.className = 'gameover-title imposter-win';
      subtitleEl.textContent = 'The imposters have taken over!';
      playLose();
    }

    // Reveal imposters
    const imposterReveal = $('#imposter-reveal');
    imposterReveal.innerHTML = '';
    state.players.filter(p => p.isImposter).forEach(p => {
      const badge = document.createElement('span');
      badge.className = 'imposter-name-badge';
      badge.textContent = p.name;
      imposterReveal.appendChild(badge);
    });

    // Reveal words
    $('#reveal-normal-word').textContent = state.normalWord;
    $('#reveal-imposter-word').textContent = state.imposterWord;

    // Stats
    const eliminated = state.players.filter(p => p.eliminated).length;
    $('#stat-rounds').textContent = state.round;
    $('#stat-eliminated').textContent = eliminated;

    // Save score to localStorage
    saveLocalScore({
      date: new Date().toISOString(),
      mode: 'local',
      winner: result,
      rounds: state.round,
      eliminated,
      players: state.players.map(p => p.name),
      imposters: state.players.filter(p => p.isImposter).map(p => p.name),
      words: { normal: state.normalWord, imposter: state.imposterWord },
    });
  }

  // ===== PLAY AGAIN =====
  function playAgain() {
    // Keep same players and coordinator, just reset roles and words
    playClick();
    showScreen('setup');
  }

  function newGame() {
    playClick();
    // Full reset
    state.players = [];
    state.coordinator = null;
    state.normalWord = '';
    state.imposterWord = '';
    state.round = 0;

    // Reset setup form
    const container = $('#player-inputs');
    container.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const row = document.createElement('div');
      row.className = 'player-input-row';
      row.innerHTML = `
        <input type="text" class="input player-name" placeholder="Player ${i + 1}" maxlength="20" autocomplete="off">
        <button class="btn-icon btn-remove-player hidden" title="Remove">✕</button>
      `;
      container.appendChild(row);
    }
    bindPlayerInputEvents();
    $('#coordinator-select').innerHTML = '<option value="">None (everyone plays)</option>';
    $('#normal-word').value = '';
    $('#imposter-word').value = '';
    $('#game-info').classList.add('hidden');
    $('#setup-error').classList.add('hidden');

    showScreen('welcome');
  }

  // ===== CONFETTI =====
  function triggerConfetti() {
    const canvas = $('#confetti-canvas');
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

  // ===== SCORE TRACKING =====
  function loadScores() {
    try {
      const raw = localStorage.getItem('imposter_scores');
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveLocalScore(entry) {
    try {
      const scores = loadScores();
      scores.unshift(entry);
      if (scores.length > 50) scores.length = 50;
      localStorage.setItem('imposter_scores', JSON.stringify(scores));
    } catch (e) { /* localStorage unavailable */ }
  }

  function renderScores() {
    const container = $('#scores-list');
    if (!container) return;

    const scores = loadScores();
    if (scores.length === 0) {
      container.innerHTML = '<p class="empty-scores">No games played yet.</p>';
      return;
    }

    container.innerHTML = '';
    scores.forEach(entry => {
      const isWin = (entry.winner === 'people' && entry.role !== 'imposter') ||
                    (entry.winner === 'imposters' && entry.role === 'imposter') ||
                    (entry.mode === 'local' && entry.winner === 'people');
      const div = document.createElement('div');
      div.className = 'score-entry ' + (entry.winner === 'people' ? 'win' : 'loss');

      const date = new Date(entry.date);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

      const resultText = entry.winner === 'people' ? 'People Won' : 'Imposters Won';
      const details = entry.mode === 'online'
        ? `${entry.playerName || 'You'} | Room: ${entry.roomCode || '---'} | ${entry.rounds || 0} rounds`
        : `${(entry.players || []).length} players | ${entry.rounds || 0} rounds`;

      div.innerHTML = `
        <div class="score-info">
          <span class="score-result ${entry.winner === 'people' ? 'win' : 'loss'}">${resultText}</span>
          <span class="score-details">${details}</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <span class="score-date">${dateStr}</span>
          ${entry.role ? `<span class="score-role ${entry.role}">${entry.role}</span>` : ''}
        </div>
      `;
      container.appendChild(div);
    });
  }

  function clearScores() {
    localStorage.removeItem('imposter_scores');
    renderScores();
    playClick();
  }

  // ===== LOCAL WORD PACKS =====
  let localSelectedPack = null;
  let localSelectedPair = null;

  function initLocalWordPacks() {
    const toggle = $('#local-word-mode');
    if (!toggle) return;

    toggle.querySelectorAll('.word-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.word-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        const manual = $('#local-manual-words');
        const packs = $('#local-word-packs');
        const shuffleBtn = $('#btn-local-shuffle-words');

        if (manual) manual.classList.toggle('hidden', mode !== 'manual');
        if (packs) packs.classList.toggle('hidden', mode !== 'pack');
        if (shuffleBtn) shuffleBtn.classList.toggle('hidden', mode !== 'pack');

        if (mode === 'pack') renderLocalWordPacks();
        playClick();
      });
    });

    const shuffleBtn = $('#btn-local-shuffle-words');
    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        shuffleLocalPackWords();
        playClick();
      });
    }
  }

  function renderLocalWordPacks() {
    const container = $('#local-word-packs');
    if (!container || typeof WORD_PACKS === 'undefined') return;
    if (container.querySelectorAll('.word-pack-card').length > 0) return;

    Object.entries(WORD_PACKS).forEach(([key, pack]) => {
      const card = document.createElement('div');
      card.className = 'word-pack-card';
      card.dataset.pack = key;
      card.innerHTML = `
        <span class="pack-icon">${pack.icon}</span>
        <span class="pack-name">${pack.name}</span>
      `;
      card.addEventListener('click', () => selectLocalPack(key));
      container.appendChild(card);
    });
  }

  function selectLocalPack(key) {
    if (typeof WORD_PACKS === 'undefined') return;
    localSelectedPack = key;

    $('#local-word-packs').querySelectorAll('.word-pack-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.pack === key);
    });

    shuffleLocalPackWords(key);
    playClick();
  }

  function shuffleLocalPackWords(key) {
    const packKey = key || localSelectedPack;
    if (!packKey || typeof WORD_PACKS === 'undefined') return;

    const pack = WORD_PACKS[packKey];
    if (!pack || !pack.pairs || pack.pairs.length === 0) return;

    const idx = Math.floor(Math.random() * pack.pairs.length);
    localSelectedPair = pack.pairs[idx];

    const display = $('#local-selected-pack-words');
    if (display) {
      display.innerHTML = `
        <div class="pack-word-display">
          <span class="pack-word normal-word">Normal: <strong>${localSelectedPair[0]}</strong></span>
          <span class="pack-word imposter-word">Imposter: <strong>${localSelectedPair[1]}</strong></span>
        </div>
      `;
      display.classList.remove('hidden');
    }

    // Populate word inputs
    const normalInput = $('#normal-word');
    const imposterInput = $('#imposter-word');
    if (normalInput) normalInput.value = localSelectedPair[0];
    if (imposterInput) imposterInput.value = localSelectedPair[1];
  }

  // ===== EVENT BINDINGS =====
  function bindPlayerInputEvents() {
    $$('.player-name').forEach(input => {
      input.addEventListener('input', updatePlayerCount);
    });

    $$('.btn-remove-player').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.player-input-row').remove();
        renumberPlaceholders();
        updatePlayerCount();
        playClick();
      });
    });
  }

  function init() {
    initTheme();

    // Welcome screen
    $('#btn-start').addEventListener('click', () => { playClick(); showScreen('setup'); });
    $('#btn-how-to-play').addEventListener('click', () => { playClick(); showScreen('how-to-play'); });
    $('#btn-back-welcome').addEventListener('click', () => { playClick(); showScreen('welcome'); });

    // Header
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#sound-toggle').addEventListener('click', toggleSound);

    // Setup
    bindPlayerInputEvents();
    $('#btn-add-player').addEventListener('click', addPlayerInput);
    $('#btn-start-game').addEventListener('click', validateAndStartGame);

    // Distribution
    $('#btn-ready').addEventListener('click', revealWord);
    $('#btn-hide-pass').addEventListener('click', hideAndPass);

    // Hint round
    $('#btn-start-discussion').addEventListener('click', startDiscussion);

    // Discussion
    $('#btn-pause-timer').addEventListener('click', pauseTimer);
    $('#btn-reset-timer').addEventListener('click', resetTimer);
    $('#btn-start-voting').addEventListener('click', startVoting);

    // Voting
    $('#btn-vote-ready').addEventListener('click', showVoteSelection);
    $('#btn-submit-vote').addEventListener('click', submitVote);

    // Elimination tie-breakers
    $('#btn-revote').addEventListener('click', handleRevote);
    $('#btn-random-eliminate').addEventListener('click', handleRandomEliminate);
    $('#btn-skip-round').addEventListener('click', handleSkipRound);

    // Game over
    $('#btn-play-again').addEventListener('click', playAgain);
    $('#btn-new-game').addEventListener('click', newGame);

    // Mode selection back button
    const btnBackMode = $('#btn-back-mode');
    if (btnBackMode) btnBackMode.addEventListener('click', () => { playClick(); showScreen('welcome'); });

    // Scores screen
    const btnScores = $('#btn-scores');
    if (btnScores) btnScores.addEventListener('click', () => { playClick(); renderScores(); showScreen('scores'); });
    const btnBackScores = $('#btn-back-scores');
    if (btnBackScores) btnBackScores.addEventListener('click', () => { playClick(); showScreen('welcome'); });
    const btnClearScores = $('#btn-clear-scores');
    if (btnClearScores) btnClearScores.addEventListener('click', clearScores);

    // Local word packs
    initLocalWordPacks();

    // Initialize audio on first interaction
    document.addEventListener('click', ensureAudio, { once: true });
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
