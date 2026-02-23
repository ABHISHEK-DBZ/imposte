const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ===== ROOM MANAGEMENT =====
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function getImposterCount(playerCount, override) {
  if (override && override > 0 && override < playerCount) return override;
  if (playerCount <= 9) return 1;
  if (playerCount <= 12) return 2;
  return 3;
}

// Fisher-Yates shuffle (reliable randomization)
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Get active game participants (excludes host/Grand Master and eliminated players)
function getActivePlayersInRoom(room) {
  return room.players.filter(p => !p.eliminated && p.id !== room.host);
}

function checkWinCondition(room) {
  const active = getActivePlayersInRoom(room);
  const imposters = active.filter(p => p.isImposter);
  const normals = active.filter(p => !p.isImposter);
  if (imposters.length === 0) return 'people';
  // Need at least 2 normals remaining for game to continue, otherwise imposters win
  if (normals.length <= 1 && imposters.length > 0) return 'imposters';
  if (imposters.length > normals.length) return 'imposters';
  return null;
}

function cleanupRoom(code) {
  if (rooms[code] && rooms[code].players.length === 0) {
    delete rooms[code];
  }
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {

  // --- CREATE ROOM ---
  socket.on('create-room', ({ playerName }) => {
    if (!playerName || !playerName.trim()) {
      return socket.emit('room-error', { message: 'Enter your name.' });
    }
    const code = generateRoomCode();
    const room = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: playerName.trim(), isImposter: false, eliminated: false }],
      settings: {
        timerDuration: 120,
        imposterCount: 0, // 0 = auto
        maxRounds: 0,     // 0 = unlimited
        hintTimer: 0,     // 0 = off
      },
      state: {
        phase: 'lobby',
        normalWord: '',
        imposterWord: '',
        round: 0,
        votes: {},
        hintsGiven: [],
        tiedPlayers: [],
        votingOrder: [],
        votingIndex: 0,
      },
      voicePeers: [], // track voice chat participants { id, name }
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName.trim();
    socket.emit('room-created', { roomCode: code });
    io.to(code).emit('player-joined', {
      players: room.players.map(p => ({ name: p.name, isHost: p.id === room.host })),
      host: room.players.find(p => p.id === room.host)?.name,
    });
  });

  // --- JOIN ROOM ---
  socket.on('join-room', ({ roomCode, playerName }) => {
    if (!playerName || !playerName.trim()) {
      return socket.emit('room-error', { message: 'Enter your name.' });
    }
    if (!roomCode || !roomCode.trim()) {
      return socket.emit('room-error', { message: 'Enter a room code.' });
    }
    const code = roomCode.trim().toUpperCase();
    const room = rooms[code];
    if (!room) {
      return socket.emit('room-error', { message: 'Room not found.' });
    }
    if (room.state.phase !== 'lobby') {
      return socket.emit('room-error', { message: 'Game already in progress.' });
    }
    const name = playerName.trim();
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return socket.emit('room-error', { message: 'Name already taken in this room.' });
    }
    if (room.players.length >= 20) {
      return socket.emit('room-error', { message: 'Room is full (max 20 players).' });
    }

    room.players.push({ id: socket.id, name, isImposter: false, eliminated: false });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;

    socket.emit('room-joined', { roomCode: code });
    io.to(code).emit('player-joined', {
      players: room.players.map(p => ({ name: p.name, isHost: p.id === room.host })),
      host: room.players.find(p => p.id === room.host)?.name,
    });
  });

  // --- UPDATE SETTINGS ---
  socket.on('update-settings', (settings) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.host) return;
    if (settings.timerDuration !== undefined) room.settings.timerDuration = Math.min(300, Math.max(30, settings.timerDuration));
    if (settings.imposterCount !== undefined) room.settings.imposterCount = Math.min(5, Math.max(0, settings.imposterCount));
    if (settings.maxRounds !== undefined) room.settings.maxRounds = Math.min(20, Math.max(0, settings.maxRounds));
    if (settings.hintTimer !== undefined) room.settings.hintTimer = Math.min(120, Math.max(0, settings.hintTimer));
    io.to(socket.roomCode).emit('settings-updated', room.settings);
  });

  // --- START GAME ---
  socket.on('start-game', ({ normalWord, imposterWord }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.host) return;

    // Need at least 2 participants (excluding host who is Grand Master)
    const participants = room.players.filter(p => p.id !== room.host);
    if (participants.length < 2) {
      return socket.emit('room-error', { message: 'Need at least 2 players (besides Grand Master).' });
    }
    if (!normalWord || !imposterWord || normalWord.trim().toLowerCase() === imposterWord.trim().toLowerCase()) {
      return socket.emit('room-error', { message: 'Enter two different words.' });
    }

    // Assign roles ONLY to participants (not host)
    const imposterCount = getImposterCount(participants.length, room.settings.imposterCount);
    const shuffled = shuffleArray(participants);
    const imposterIds = new Set(shuffled.slice(0, imposterCount).map(p => p.id));

    room.players.forEach(p => {
      if (p.id === room.host) {
        // Host is Grand Master — not a player
        p.isImposter = false;
        p.eliminated = false;
      } else {
        p.isImposter = imposterIds.has(p.id);
        p.eliminated = false;
      }
    });

    room.state.normalWord = normalWord.trim();
    room.state.imposterWord = imposterWord.trim();
    room.state.phase = 'distribute';
    room.state.round = 0;
    room.state.votes = {};
    room.state.hintsGiven = [];
    room.state.tiedPlayers = [];

    // Send each PARTICIPANT their word privately (NOT the host)
    participants.forEach(p => {
      const word = p.isImposter ? room.state.imposterWord : room.state.normalWord;
      console.log(`[Room ${room.code}] ${p.name}: role=${p.isImposter ? 'IMPOSTER' : 'normal'}, word="${word}"`);
      io.to(p.id).emit('your-word', { word, role: p.isImposter ? 'imposter' : 'normal' });
    });

    io.to(socket.roomCode).emit('game-started', {
      phase: 'distribute',
      players: participants.map(p => ({ name: p.name })),
      imposterCount,
      settings: room.settings,
    });

    // Send Grand Master info to the host — host sees everything
    const imposterNames = participants.filter(p => p.isImposter).map(p => p.name);
    io.to(room.host).emit('grand-master-info', {
      imposters: imposterNames,
      normalWord: room.state.normalWord,
      imposterWord: room.state.imposterWord,
      participants: participants.map(p => ({ name: p.name, isImposter: p.isImposter })),
    });
  });

  // --- WORD SEEN (player confirms they saw word) ---
  socket.on('word-seen', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state.phase !== 'distribute') return;
    // Host doesn't see a word, so skip
    if (socket.id === room.host) return;

    if (!room.state._wordSeen) room.state._wordSeen = new Set();
    room.state._wordSeen.add(socket.id);

    const participants = room.players.filter(p => p.id !== room.host);

    console.log(`[Room ${socket.roomCode}] Word seen by ${socket.playerName}: ${room.state._wordSeen.size}/${participants.length}`);

    io.to(socket.roomCode).emit('word-seen-update', {
      seen: room.state._wordSeen.size,
      total: participants.length,
    });

    // All participants have seen their word
    if (room.state._wordSeen.size >= participants.length) {
      room.state.phase = 'hints';
      room.state.round++;
      room.state.hintsGiven = [];
      room.state._wordSeen = null;
      io.to(socket.roomCode).emit('phase-change', {
        phase: 'hints',
        round: room.state.round,
        players: getActivePlayersInRoom(room).map(p => ({ name: p.name })),
      });
    }
  });

  // --- HINT GIVEN ---
  socket.on('hint-given', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.state.phase !== 'hints') return;
    // Host doesn't give hints
    if (socket.id === room.host) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;

    if (!room.state.hintsGiven.includes(player.name)) {
      room.state.hintsGiven.push(player.name);
    }

    io.to(socket.roomCode).emit('hint-update', {
      hintsGiven: room.state.hintsGiven,
      total: getActivePlayersInRoom(room).length,
    });

    // All hints given — host can proceed
    if (room.state.hintsGiven.length >= getActivePlayersInRoom(room).length) {
      io.to(socket.roomCode).emit('all-hints-given');
    }
  });

  // --- START DISCUSSION ---
  socket.on('start-discussion', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.host) return;

    room.state.phase = 'discussion';
    const active = getActivePlayersInRoom(room);
    io.to(socket.roomCode).emit('phase-change', {
      phase: 'discussion',
      timerDuration: room.settings.timerDuration,
      players: active.map(p => ({
        name: p.name,
        eliminated: p.eliminated,
      })),
    });
  });

  // --- START VOTING ---
  socket.on('start-voting', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.host) return;

    room.state.phase = 'voting';
    room.state.votes = {};
    const active = getActivePlayersInRoom(room);
    room.state.votingOrder = active.map(p => p.name);

    io.to(socket.roomCode).emit('phase-change', {
      phase: 'voting',
      players: active.map(p => ({ name: p.name })),
    });

    // Tell each active participant to vote (NOT the host)
    active.forEach(p => {
      const candidates = active.filter(c => c.name !== p.name).map(c => ({ name: c.name }));
      io.to(p.id).emit('vote-request', { candidates });
    });
  });

  // --- SUBMIT VOTE ---
  socket.on('submit-vote', ({ votedFor }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state.phase !== 'voting') return;
    // Host cannot vote
    if (socket.id === room.host) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.eliminated) return;
    if (votedFor === player.name) return; // can't vote self

    room.state.votes[player.name] = votedFor;

    const active = getActivePlayersInRoom(room);
    const votesNeeded = active.length;
    const votesSubmitted = Object.keys(room.state.votes).length;

    io.to(socket.roomCode).emit('vote-update', {
      votesSubmitted,
      votesNeeded,
    });

    // All votes in
    if (votesSubmitted >= votesNeeded) {
      tallyVotes(room);
    }
  });

  // --- TIE RESOLUTION ---
  socket.on('tie-resolution', ({ method }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.host) return;

    if (method === 'revote') {
      room.state.votes = {};
      room.state.phase = 'voting';
      const tiedPlayerObjects = room.players.filter(p => !p.eliminated && p.id !== room.host && room.state.tiedPlayers.includes(p.name));

      io.to(socket.roomCode).emit('phase-change', {
        phase: 'voting',
        players: tiedPlayerObjects.map(p => ({ name: p.name })),
        isRevote: true,
      });

      tiedPlayerObjects.forEach(p => {
        const candidates = tiedPlayerObjects.filter(c => c.name !== p.name).map(c => ({ name: c.name }));
        io.to(p.id).emit('vote-request', { candidates, isRevote: true });
      });

    } else if (method === 'random') {
      const randomIndex = Math.floor(Math.random() * room.state.tiedPlayers.length);
      const name = room.state.tiedPlayers[randomIndex];
      eliminatePlayer(room, name);

    } else if (method === 'skip') {
      const result = checkWinCondition(room);
      if (result) {
        emitGameOver(room, result);
      } else {
        nextRound(room);
      }
    }
  });

  // --- PLAY AGAIN ---
  socket.on('play-again', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.host) return;
    room.state.phase = 'lobby';
    room.state.round = 0;
    room.state.votes = {};
    room.state.hintsGiven = [];
    room.state.tiedPlayers = [];
    room.players.forEach(p => { p.isImposter = false; p.eliminated = false; });
    io.to(socket.roomCode).emit('back-to-lobby', {
      players: room.players.map(p => ({ name: p.name, isHost: p.id === room.host })),
      host: room.players.find(p => p.id === room.host)?.name,
    });
  });

  // --- CHAT MESSAGE ---
  socket.on('chat-message', ({ message }) => {
    const room = rooms[socket.roomCode];
    if (!room || !message || typeof message !== 'string') return;
    const text = message.trim().slice(0, 200);
    if (!text) return;
    io.to(socket.roomCode).emit('chat-message', {
      author: socket.playerName,
      text,
      timestamp: Date.now(),
    });
  });

  // --- VOICE SIGNALING (WebRTC) ---
  socket.on('voice-join', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.voiceActive = true;

    // Send list of existing voice peers to the new joiner
    const existingPeers = (room.voicePeers || []).filter(vp => vp.id !== socket.id);
    socket.emit('voice-existing-peers', { peers: existingPeers });

    // Track this peer
    if (!room.voicePeers) room.voicePeers = [];
    room.voicePeers = room.voicePeers.filter(vp => vp.id !== socket.id);
    room.voicePeers.push({ id: socket.id, name: socket.playerName });

    // Notify others
    socket.to(socket.roomCode).emit('voice-peer-joined', {
      peerId: socket.id,
      name: socket.playerName,
    });
  });

  socket.on('voice-leave', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    socket.voiceActive = false;
    if (room.voicePeers) {
      room.voicePeers = room.voicePeers.filter(vp => vp.id !== socket.id);
    }
    socket.to(socket.roomCode).emit('voice-peer-left', {
      peerId: socket.id,
      name: socket.playerName,
    });
  });

  socket.on('voice-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('voice-offer', {
      fromId: socket.id,
      fromName: socket.playerName,
      offer,
    });
  });

  socket.on('voice-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('voice-answer', {
      fromId: socket.id,
      answer,
    });
  });

  socket.on('voice-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('voice-ice-candidate', {
      fromId: socket.id,
      candidate,
    });
  });

  socket.on('voice-mute-status', ({ muted }) => {
    socket.to(socket.roomCode).emit('voice-mute-status', {
      peerId: socket.id,
      name: socket.playerName,
      muted,
    });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    // Notify voice peers if player was in voice chat
    if (socket.voiceActive) {
      if (room.voicePeers) {
        room.voicePeers = room.voicePeers.filter(vp => vp.id !== socket.id);
      }
      socket.to(code).emit('voice-peer-left', {
        peerId: socket.id,
        name: socket.playerName,
      });
    }

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[code];
      return;
    }

    // If host left, assign new host
    if (room.host === socket.id) {
      room.host = room.players[0].id;
    }

    io.to(code).emit('player-left', {
      playerName: socket.playerName,
      players: room.players.map(p => ({ name: p.name, isHost: p.id === room.host })),
      host: room.players.find(p => p.id === room.host)?.name,
    });

    // If game in progress and player was active, check condition
    if (room.state.phase !== 'lobby') {
      const result = checkWinCondition(room);
      if (result) {
        emitGameOver(room, result);
      } else if (room.state.phase === 'voting') {
        // Check if all remaining votes are in
        const active = getActivePlayersInRoom(room);
        const votesNeeded = active.length;
        const votesSubmitted = Object.keys(room.state.votes).filter(v => active.some(p => p.name === v)).length;
        if (votesSubmitted >= votesNeeded) {
          tallyVotes(room);
        }
      }
    }
  });

  // --- KICK PLAYER ---
  socket.on('kick-player', ({ playerName }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.host || room.state.phase !== 'lobby') return;
    const player = room.players.find(p => p.name === playerName);
    if (!player || player.id === room.host) return;

    room.players = room.players.filter(p => p.name !== playerName);
    io.to(player.id).emit('kicked');
    const playerSocket = io.sockets.sockets.get(player.id);
    if (playerSocket) {
      playerSocket.leave(socket.roomCode);
      playerSocket.roomCode = null;
    }

    io.to(socket.roomCode).emit('player-joined', {
      players: room.players.map(p => ({ name: p.name, isHost: p.id === room.host })),
      host: room.players.find(p => p.id === room.host)?.name,
    });
  });
});

// ===== SERVER GAME LOGIC =====
function tallyVotes(room) {
  const voteCounts = {};
  const active = getActivePlayersInRoom(room);
  active.forEach(p => { voteCounts[p.name] = 0; });

  Object.values(room.state.votes).forEach(votedFor => {
    if (voteCounts[votedFor] !== undefined) {
      voteCounts[votedFor]++;
    }
  });

  const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
  const maxVotes = sorted[0][1];
  const tiedAtTop = sorted.filter(([, count]) => count === maxVotes);

  room.state.phase = 'elimination';

  if (maxVotes === 0) {
    io.to(room.code).emit('vote-results', { results: sorted, eliminated: null, role: null, tie: false });
    return;
  }

  if (tiedAtTop.length > 1) {
    room.state.tiedPlayers = tiedAtTop.map(([name]) => name);
    io.to(room.code).emit('vote-results', {
      results: sorted,
      eliminated: null,
      role: null,
      tie: true,
      tiedPlayers: room.state.tiedPlayers,
    });
  } else {
    const eliminatedName = sorted[0][0];
    eliminatePlayer(room, eliminatedName);
  }
}

function eliminatePlayer(room, name) {
  const player = room.players.find(p => p.name === name);
  if (!player) return;
  player.eliminated = true;

  const result = checkWinCondition(room);

  const active = getActivePlayersInRoom(room);
  const voteCounts = {};
  active.forEach(p => { voteCounts[p.name] = 0; });
  Object.values(room.state.votes).forEach(v => { if (voteCounts[v] !== undefined) voteCounts[v]++; });
  const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);

  io.to(room.code).emit('vote-results', {
    results: sorted,
    eliminated: name,
    role: player.isImposter ? 'imposter' : 'normal',
    tie: false,
    gameOver: result,
  });

  if (result) {
    setTimeout(() => emitGameOver(room, result), 100);
  } else {
    // Auto-advance to next round after a delay so players can see the elimination
    setTimeout(() => nextRound(room), 5000);
  }
}

function nextRound(room) {
  room.state.phase = 'hints';
  room.state.round++;
  room.state.hintsGiven = [];
  room.state.votes = {};
  room.state.tiedPlayers = [];

  const active = getActivePlayersInRoom(room);

  // Check max rounds
  if (room.settings.maxRounds > 0 && room.state.round > room.settings.maxRounds) {
    emitGameOver(room, 'imposters'); // imposters win if max rounds reached
    return;
  }

  io.to(room.code).emit('phase-change', {
    phase: 'hints',
    round: room.state.round,
    players: active.map(p => ({ name: p.name })),
  });
}

function emitGameOver(room, result) {
  room.state.phase = 'gameover';
  const imposters = room.players.filter(p => p.isImposter).map(p => p.name);
  const eliminated = room.players.filter(p => p.eliminated).length;

  io.to(room.code).emit('game-over', {
    winner: result,
    imposters,
    words: { normal: room.state.normalWord, imposter: room.state.imposterWord },
    stats: { rounds: room.state.round, eliminated },
    players: room.players.map(p => ({ name: p.name, isImposter: p.isImposter, eliminated: p.eliminated })),
  });
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Imposter game server running on http://localhost:${PORT}`);
});
