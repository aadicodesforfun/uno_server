const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};         
const matchmakeQueue = []; 

const COLORS   = ['red','blue','green','yellow'];
const SPECIALS = ['skip','reverse','draw2'];
const NUMS     = ['0','1','2','3','4','5','6','7','8','9'];

let cardIdCounter = 0;
const mkCard = (color, value) => ({ id: ++cardIdCounter, color, value });

function buildDeck() {
  const deck = [];
  for (const col of COLORS) {
    deck.push(mkCard(col, '0'));
    for (let i = 0; i < 2; i++) {
      for (const n of NUMS.slice(1)) deck.push(mkCard(col, n));
      for (const s of SPECIALS)      deck.push(mkCard(col, s));
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push(mkCard('wild', 'wild'));
    deck.push(mkCard('wild', 'wild4'));
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const genCode    = () => Math.random().toString(36).slice(2,8).toUpperCase();
const isWild     = c  => c.value === 'wild' || c.value === 'wild4';
const playerName = (room, pid) => room.players.find(p => p.id === pid)?.name ?? 'Unknown';

function addLog(room, msg) {
  if (!room.log) room.log = [];
  room.log.push({ msg, ts: Date.now() });
  if (room.log.length > 40) room.log.shift();
}

function reshuffle(room) {
  if (room.discard.length <= 1) return;
  const top  = room.discard[room.discard.length - 1];
  const rest = room.discard.slice(0, -1);
  room.deck.push(...shuffle(rest));
  room.discard = [top];
  addLog(room, '🔀 Deck reshuffled from discard pile');
}

function drawCards(room, playerId, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) reshuffle(room);
    if (room.deck.length === 0) break;
    drawn.push(room.deck.pop());
  }
  room.hands[playerId].push(...drawn);
  return drawn;
}

function canPlay(card, topCard, activeColor, drawStack) {
  if (drawStack > 0) {
    if (card.value === 'draw2'  && drawStack % 4 !== 0) return true; 
    if (card.value === 'wild4')                         return true; 
    return false; 
  }
  if (isWild(card)) return true;
  const effColor = activeColor || topCard.color;
  return card.color === effColor || card.value === topCard.value;
}

function advanceTurn(room, extraSkip = false) {
  const n    = room.players.length;
  let   next = (room.currentPlayer + room.direction + n) % n;
  if (extraSkip) next = (next + room.direction + n) % n;
  room.currentPlayer = next;
}

function applyCardEffect(room, card, playerId) {
  let skip = false;

  if (card.value === 'skip') {
    skip = true;
    addLog(room, `⊘ ${playerName(room, playerId)} played Skip`);

  } else if (card.value === 'reverse') {
    room.direction *= -1;
    addLog(room, `⇄ ${playerName(room, playerId)} reversed direction`);
    if (room.players.length === 2) skip = true; 

  } else if (card.value === 'draw2') {
    room.drawStack += 2;
    addLog(room, `+2 by ${playerName(room, playerId)} — stack is now +${room.drawStack}`);

  } else if (card.value === 'wild4') {
    room.drawStack += 4;
    addLog(room, `+4 by ${playerName(room, playerId)} — stack is now +${room.drawStack}`);

  } else if (card.value === 'wild') {
    addLog(room, `🌈 ${playerName(room, playerId)} chose ${room.activeColor}`);
  }

  return skip;
}

function publicState(room, forPlayerId) {
  const hands = {};
  for (const pid of Object.keys(room.hands)) {
    hands[pid] = pid === forPlayerId ? room.hands[pid] : room.hands[pid].length;
  }
  return {
    code:          room.code,
    isMatchmade:   room.isMatchmade || false,
    status:        room.status,
    players:       room.players,
    currentPlayer: room.currentPlayer,
    direction:     room.direction,
    topCard:       room.discard[room.discard.length - 1] || null,
    activeColor:   room.activeColor,
    drawStack:     room.drawStack,
    deckCount:     room.deck.length,
    discardCount:  room.discard.length,
    hands,
    log:           (room.log || []).slice(-20),
    winner:        room.winner || null,
    unoCallers:    room.unoCallers || {}
  };
}

function broadcastState(room) {
  for (const player of room.players) {
    const sid = room.socketMap[player.id];
    if (sid) io.to(sid).emit('gameState', publicState(room, player.id));
  }
}

function initGameState(room) {
  const deck = buildDeck();
  room.hands = {};
  for (const p of room.players) room.hands[p.id] = deck.splice(0, 7);

  let startCard;
  do {
    startCard = deck.shift();
    if (isWild(startCard)) deck.push(startCard);
  } while (isWild(startCard));

  room.deck          = deck;
  room.discard       = [startCard];
  room.activeColor   = startCard.color;
  room.status        = 'playing';
  room.currentPlayer = 0;
  room.direction     = 1;
  room.drawStack     = 0;
  room.winner        = null;
  room.unoCallers    = {};
  room.log           = [`🃏 Game started! First card: ${startCard.color} ${startCard.value}`];
}

function tryMatchmake() {
  for (let i = matchmakeQueue.length - 1; i >= 0; i--) {
    const s = io.sockets.sockets.get(matchmakeQueue[i].socketId);
    if (!s) matchmakeQueue.splice(i, 1);
  }

  if (matchmakeQueue.length < 2) return; 

  const batch = matchmakeQueue.splice(0, Math.min(matchmakeQueue.length, 4));
  const code  = genCode();

  const room = {
    code,
    isMatchmade: true,
    status:    'waiting',
    players:   batch.map((e, i) => ({ id: e.socketId, name: e.name, isHost: i === 0 })),
    socketMap: Object.fromEntries(batch.map(e => [e.socketId, e.socketId])),
    hands: {}, deck: [], discard: [],
    currentPlayer: 0, direction: 1, drawStack: 0,
    activeColor: null, log: [], unoCallers: {}, winner: null
  };

  rooms[code] = room;

  for (const entry of batch) {
    const s = io.sockets.sockets.get(entry.socketId);
    if (!s) continue;
    s.data.roomCode  = code;
    s.data.playerId  = entry.socketId;
    s.data.inQueue   = false;
    s.join(code);
  }

  addLog(room, `🎲 Matched ${batch.length} players! Starting in 3 seconds…`);
  broadcastState(room);

  setTimeout(() => {
    if (!rooms[code]) return;
    initGameState(rooms[code]);
    broadcastState(rooms[code]);
    console.log(`[matchmake] room ${code} started with ${batch.length} players`);
  }, 3000);

  console.log(`[matchmake] created room ${code} for: ${batch.map(e=>e.name).join(', ')}`);
}

app.get('/', (_req, res) =>
  res.json({ status: 'UNO server 🃏', rooms: Object.keys(rooms).length, queue: matchmakeQueue.length })
);
app.get('/health', (_req, res) => res.json({ ok: true }));

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('createRoom', ({ name }, cb) => {
    const code     = genCode();
    const playerId = socket.id;

    rooms[code] = {
      code,
      isMatchmade: false,
      status:    'waiting',
      players:   [{ id: playerId, name, isHost: true }],
      socketMap: { [playerId]: socket.id },
      hands: {}, deck: [], discard: [],
      currentPlayer: 0, direction: 1, drawStack: 0,
      activeColor: null, log: [], unoCallers: {}, winner: null
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    console.log(`[create] ${code} by ${name}`);
    cb({ ok: true, code, playerId });
    broadcastState(rooms[code]);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = rooms[code];
    if (!room)                       return cb({ ok: false, error: 'Room not found' });
    if (room.status !== 'waiting')   return cb({ ok: false, error: 'Game already in progress' });
    if (room.players.length >= 4)    return cb({ ok: false, error: 'Room is full (max 4)' });

    const playerId = socket.id;
    room.players.push({ id: playerId, name, isHost: false });
    room.socketMap[playerId] = socket.id;

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    addLog(room, `👋 ${name} joined`);
    console.log(`[join] ${name} → ${code}`);
    cb({ ok: true, code, playerId });
    broadcastState(room);
  });

  socket.on('joinMatchmaking', ({ name }, cb) => {
    if (matchmakeQueue.find(e => e.socketId === socket.id)) {
      return cb && cb({ ok: true, position: matchmakeQueue.length });
    }

    socket.data.inQueue  = true;
    socket.data.mmName   = name;

    matchmakeQueue.push({ socketId: socket.id, name, joinedAt: Date.now() });
    console.log(`[queue] ${name} joined — queue size: ${matchmakeQueue.length}`);

    cb && cb({ ok: true, position: matchmakeQueue.length });

    for (const entry of matchmakeQueue) {
      io.to(entry.socketId).emit('queueUpdate', { position: matchmakeQueue.length });
    }

    tryMatchmake();
  });

  socket.on('leaveMatchmaking', (_, cb) => {
    const idx = matchmakeQueue.findIndex(e => e.socketId === socket.id);
    if (idx !== -1) matchmakeQueue.splice(idx, 1);
    socket.data.inQueue = false;
    cb && cb({ ok: true });
  });

  socket.on('startGame', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'Room not found' });

    const host = room.players.find(p => p.id === playerId);
    if (!host?.isHost)          return cb && cb({ ok: false, error: 'Only host can start' });
    if (room.players.length < 2) return cb && cb({ ok: false, error: 'Need at least 2 players' });

    initGameState(room);
    console.log(`[start] ${roomCode}`);
    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('playCard', ({ cardId, chosenColor }, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return cb && cb({ ok: false, error: 'Not in a game' });

    const currentPid = room.players[room.currentPlayer].id;
    if (currentPid !== playerId) return cb && cb({ ok: false, error: 'Not your turn' });

    const hand    = room.hands[playerId];
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return cb && cb({ ok: false, error: 'Card not in hand' });

    const card    = hand[cardIdx];
    const topCard = room.discard[room.discard.length - 1];

    if (!canPlay(card, topCard, room.activeColor, room.drawStack)) {
      return cb && cb({ ok: false, error: "Can't play that card right now" });
    }

    hand.splice(cardIdx, 1);
    room.discard.push(card);

    if (isWild(card)) {
      room.activeColor = chosenColor || 'red';
    } else {
      room.activeColor = card.color;
      if (card.value !== 'draw2' && card.value !== 'wild4') {
        room.drawStack = 0;
      }
    }

    addLog(room, `🃏 ${playerName(room, playerId)} played ${card.color} ${card.value}`);

    if (hand.length === 1 && !room.unoCallers[playerId]) {
      room.unoCallers[playerId] = 'pending';
      setTimeout(() => {
        if (room.unoCallers[playerId] === 'pending' && room.hands[playerId]?.length === 1) {
          drawCards(room, playerId, 2);
          addLog(room, `😬 ${playerName(room, playerId)} forgot UNO! +2 penalty`);
          delete room.unoCallers[playerId];
          broadcastState(room);
        }
      }, 3000);
    }

    if (hand.length === 0) {
      room.status = 'finished';
      room.winner = playerName(room, playerId);
      addLog(room, `🏆 ${room.winner} wins!`);
      cb && cb({ ok: true });
      broadcastState(room);
      return;
    }


    const skip = applyCardEffect(room, card, playerId);

    advanceTurn(room, skip);

    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('drawCard', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return cb && cb({ ok: false });

    const currentPid = room.players[room.currentPlayer].id;
    if (currentPid !== playerId) return cb && cb({ ok: false, error: 'Not your turn' });


    let count = 1;
    if (room.drawStack > 0) {
      count          = room.drawStack;
      room.drawStack = 0;
    }

    drawCards(room, playerId, count);
    addLog(room, `📥 ${playerName(room, playerId)} drew ${count} card${count > 1 ? 's' : ''}`);

    advanceTurn(room, false);

    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('callUno', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room) return;
    room.unoCallers = room.unoCallers || {};
    room.unoCallers[playerId] = 'called';
    addLog(room, `🗣️ ${playerName(room, playerId)} called UNO!`);
    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('restartGame', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room) return;
    const host = room.players.find(p => p.id === playerId);
    if (!host?.isHost) return cb && cb({ ok: false, error: 'Only host can restart' });

    room.status = 'waiting';
    room.hands  = {};
    room.deck   = [];
    room.discard = [];
    room.winner  = null;
    room.log     = [];
    room.unoCallers = {};
    room.drawStack  = 0;

    cb && cb({ ok: true });
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    // Remove from matchmaking queue if present
    const qi = matchmakeQueue.findIndex(e => e.socketId === socket.id);
    if (qi !== -1) {
      matchmakeQueue.splice(qi, 1);
      console.log(`[queue] ${socket.id} removed — queue: ${matchmakeQueue.length}`);
    }

    const { roomCode, playerId } = socket.data || {};
    if (!roomCode || !rooms[roomCode]) return;

    const room   = rooms[roomCode];
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    addLog(room, `👋 ${player.name} disconnected`);
    room.players = room.players.filter(p => p.id !== playerId);
    delete room.hands[playerId];
    delete room.socketMap[playerId];

    if (room.players.length === 0) {
      delete rooms[roomCode];
      console.log(`[room] ${roomCode} deleted`);
      return;
    }

    if (player.isHost) {
      room.players[0].isHost = true;
      addLog(room, `👑 ${room.players[0].name} is now host`);
    }

    if (room.status === 'playing' && room.players.length < 2) {
      room.status   = 'waiting';
      room.hands    = {};
      room.deck     = [];
      room.discard  = [];
      room.drawStack = 0;
      addLog(room, '⚠️ Not enough players — game paused');
    }

    if (room.currentPlayer >= room.players.length) room.currentPlayer = 0;

    broadcastState(room);
    console.log(`[disconnect] ${player.name} left ${roomCode}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`✅ UNO server on port ${PORT}`));
