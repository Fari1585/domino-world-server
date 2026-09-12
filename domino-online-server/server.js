// Domino World — online multiplayer server
// Node.js + Express + Socket.io. In-memory state (no database) — good enough
// for an MVP; rooms are lost if the server restarts.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Domino World server is running.");
});
app.get("/health", (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// ---------------- game rules (mirrors the client's offline logic) ----------------

function buildDeck() {
  const d = [];
  for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) d.push({ a, b });
  return d;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function ends(chain) {
  if (chain.length === 0) return null;
  return { left: chain[0].a, right: chain[chain.length - 1].b };
}
function tileMatchesEnds(chain, tile) {
  const e = ends(chain);
  if (!e) return { left: true, right: true };
  return {
    left: tile.a === e.left || tile.b === e.left,
    right: tile.a === e.right || tile.b === e.right,
  };
}
function handHasPlayable(chain, hand) {
  return hand.some((t) => {
    const m = tileMatchesEnds(chain, t);
    return m.left || m.right;
  });
}
function placeTile(chain, tile, side) {
  if (chain.length === 0) {
    chain.push({ a: tile.a, b: tile.b });
    return;
  }
  const e = ends(chain);
  if (side === "left") {
    if (tile.b === e.left) chain.unshift({ a: tile.a, b: tile.b });
    else chain.unshift({ a: tile.b, b: tile.a });
  } else {
    if (tile.a === e.right) chain.push({ a: tile.a, b: tile.b });
    else chain.push({ a: tile.b, b: tile.a });
  }
}
function pipSum(hand) {
  return hand.reduce((s, t) => s + t.a + t.b, 0);
}
const TARGET_BY_N = { 2: 60, 3: 125, 4: 250 };
function scoreKey(numPlayers, seat) {
  return numPlayers === 4 ? (seat % 2 === 0 ? "A" : "B") : String(seat);
}

// ---------------- room state ----------------
// rooms[code] = {
//   code, numPlayers, seats: [{socketId, name, connected, isBot}]  length numPlayers, may have nulls,
//   started, matchOver,
//   game: { players:[{hand}], boneyard, chain, currentSeat, passStreak, roundActive,
//           matchScore, targetScore, roundNumber, nextStarterSeat }
// }
const rooms = {};
const socketRoom = {}; // socketId -> roomCode
const queues = { 2: [], 3: [], 4: [] }; // matchmaking queues of socket ids

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function publicRoomInfo(room) {
  return {
    code: room.code,
    numPlayers: room.numPlayers,
    seats: room.seats.map((s) => (s ? { name: s.name, connected: s.connected, isBot: !!s.isBot } : null)),
    started: room.started,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room_update", publicRoomInfo(room));
}

function startRound(room) {
  const g = room.game;
  const deck = shuffle(buildDeck());
  g.players.forEach((p) => (p.hand = deck.splice(0, 7)));
  g.boneyard = deck;
  g.chain = [];
  g.passStreak = 0;
  g.roundActive = true;
  g.roundNumber++;

  let starter;
  if (g.nextStarterSeat !== null) {
    starter = g.nextStarterSeat;
  } else {
    starter = 0;
    let bestDouble = -1;
    g.players.forEach((p, i) => {
      p.hand.forEach((t) => {
        if (t.a === t.b && t.a > bestDouble) {
          bestDouble = t.a;
          starter = i;
        }
      });
    });
  }
  g.currentSeat = starter;

  sendFullStateToAll(room);
  maybeRunBotTurn(room);
}

function sendFullStateToAll(room) {
  const g = room.game;
  room.seats.forEach((seat, i) => {
    if (!seat || seat.isBot || !seat.socketId) return;
    io.to(seat.socketId).emit("game_state", {
      yourSeat: i,
      hand: g.players[i].hand,
      chain: g.chain,
      boneyardCount: g.boneyard.length,
      currentSeat: g.currentSeat,
      matchScore: g.matchScore,
      targetScore: g.targetScore,
      roundNumber: g.roundNumber,
      numPlayers: room.numPlayers,
      handCounts: g.players.map((p) => p.hand.length),
      roundActive: g.roundActive,
    });
  });
}

function afterAction(room, seatIndex, wasPass) {
  const g = room.game;
  if (!wasPass && g.players[seatIndex].hand.length === 0) {
    handleRoundEnd(room, "hand", seatIndex);
    return;
  }
  if (g.passStreak >= room.numPlayers) {
    handleRoundEnd(room, "blocked", null);
    return;
  }
  g.currentSeat = (seatIndex + 1) % room.numPlayers;
  sendFullStateToAll(room);
  maybeRunBotTurn(room);
}

function handleRoundEnd(room, reason, endingSeat) {
  const g = room.game;
  g.roundActive = false;
  let winnerKey = null, points = 0;

  if (reason === "hand") {
    winnerKey = scoreKey(room.numPlayers, endingSeat);
    points = g.players.reduce(
      (s, p, i) => (scoreKey(room.numPlayers, i) === winnerKey ? s : s + pipSum(p.hand)),
      0
    );
    g.nextStarterSeat = endingSeat;
  } else {
    const totals = {};
    g.players.forEach((p, i) => {
      const k = scoreKey(room.numPlayers, i);
      totals[k] = (totals[k] || 0) + pipSum(p.hand);
    });
    const keys = Object.keys(totals).sort((a, b) => totals[a] - totals[b]);
    if (keys.length > 1 && totals[keys[0]] === totals[keys[1]]) {
      winnerKey = null;
      g.nextStarterSeat = (g.currentSeat + 1) % room.numPlayers;
    } else {
      winnerKey = keys[0];
      keys.forEach((k) => { if (k !== winnerKey) points += totals[k]; });
      let bestSeat = null, bestPips = Infinity;
      g.players.forEach((p, i) => {
        if (scoreKey(room.numPlayers, i) === winnerKey) {
          const s = pipSum(p.hand);
          if (s < bestPips) { bestPips = s; bestSeat = i; }
        }
      });
      g.nextStarterSeat = bestSeat;
    }
  }

  if (winnerKey !== null) g.matchScore[winnerKey] += points;

  const matchWinnerKey = Object.keys(g.matchScore).find((k) => g.matchScore[k] >= g.targetScore);

  io.to(room.code).emit("round_over", {
    reason, winnerKey, points, matchScore: g.matchScore, targetScore: g.targetScore,
  });

  if (matchWinnerKey) {
    room.matchOver = true;
    io.to(room.code).emit("match_over", { winnerKey: matchWinnerKey, matchScore: g.matchScore });
  }
  sendFullStateToAll(room);
}

// very small built-in bot, used to fill empty seats in a room if the host allows it
function botChooseAndAct(room, seatIndex) {
  const g = room.game;
  const hand = g.players[seatIndex].hand;
  const playable = hand
    .map((t, i) => ({ t, i, m: tileMatchesEnds(g.chain, t) }))
    .filter((x) => x.m.left || x.m.right);

  if (playable.length > 0) {
    playable.sort((x, y) => {
      const xd = x.t.a === x.t.b, yd = y.t.a === y.t.b;
      if (xd !== yd) return xd ? -1 : 1;
      return y.t.a + y.t.b - (x.t.a + x.t.b);
    });
    const choice = playable[0];
    const side = choice.m.right ? "right" : "left";
    placeTile(g.chain, choice.t, side);
    hand.splice(choice.i, 1);
    g.passStreak = 0;
    afterAction(room, seatIndex, false);
    return;
  }
  g.passStreak++;
  afterAction(room, seatIndex, true);
}

function maybeRunBotTurn(room) {
  if (!room.game.roundActive || room.matchOver) return;
  const seat = room.seats[room.game.currentSeat];
  if (seat && seat.isBot) {
    setTimeout(() => {
      if (rooms[room.code] && room.game.roundActive) botChooseAndAct(room, room.game.currentSeat);
    }, 700);
  }
}

function removeFromQueues(socketId) {
  Object.keys(queues).forEach((n) => {
    queues[n] = queues[n].filter((id) => id !== socketId);
  });
}

function tryFormMatch(numPlayers) {
  const q = queues[numPlayers];
  while (q.length >= numPlayers) {
    const ids = q.splice(0, numPlayers);
    const room = createRoom(numPlayers);
    ids.forEach((id) => {
      const sock = io.sockets.sockets.get(id);
      if (!sock) return;
      joinRoomSocket(room, sock, "Oyuncu");
    });
    room.matchmaking = true;
    if (room.seats.every((s) => s)) {
      room.started = true;
      startRound(room);
    }
    broadcastRoom(room);
  }
}

function createRoom(numPlayers) {
  const code = makeRoomCode();
  const room = {
    code,
    numPlayers,
    seats: Array.from({ length: numPlayers }, () => null),
    started: false,
    matchOver: false,
    matchmaking: false,
    game: {
      players: Array.from({ length: numPlayers }, () => ({ hand: [] })),
      boneyard: [],
      chain: [],
      currentSeat: 0,
      passStreak: 0,
      roundActive: false,
      matchScore: numPlayers === 4 ? { A: 0, B: 0 } : Object.fromEntries(Array.from({ length: numPlayers }, (_, i) => [String(i), 0])),
      targetScore: TARGET_BY_N[numPlayers],
      roundNumber: 0,
      nextStarterSeat: null,
    },
  };
  rooms[code] = room;
  return room;
}

function joinRoomSocket(room, socket, name) {
  const freeIdx = room.seats.findIndex((s) => s === null);
  if (freeIdx === -1) return false;
  room.seats[freeIdx] = { socketId: socket.id, name: name || "Oyuncu", connected: true, isBot: false };
  socket.join(room.code);
  socketRoom[socket.id] = room.code;
  socket.emit("room_joined", { code: room.code, seat: freeIdx, numPlayers: room.numPlayers });
  return true;
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ numPlayers, name }) => {
    if (![2, 3, 4].includes(numPlayers)) return socket.emit("error_msg", "Geçersiz oyuncu sayısı");
    const room = createRoom(numPlayers);
    joinRoomSocket(room, socket, name);
    broadcastRoom(room);
  });

  socket.on("join_room", ({ code, name }) => {
    const room = rooms[(code || "").toUpperCase()];
    if (!room) return socket.emit("error_msg", "Böyle bir oda yok");
    if (room.started) return socket.emit("error_msg", "Oyun zaten başladı");
    const ok = joinRoomSocket(room, socket, name);
    if (!ok) return socket.emit("error_msg", "Oda dolu");
    broadcastRoom(room);
  });

  socket.on("join_matchmaking", ({ numPlayers, name }) => {
    if (![2, 3, 4].includes(numPlayers)) return;
    socket.data.mmName = name || "Oyuncu";
    if (!queues[numPlayers].includes(socket.id)) queues[numPlayers].push(socket.id);
    socket.emit("queued", { numPlayers });
    tryFormMatch(numPlayers);
  });

  socket.on("cancel_matchmaking", () => removeFromQueues(socket.id));

  socket.on("start_with_bots", () => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room || room.started) return;
    room.seats = room.seats.map((s) => s || { socketId: null, name: "Bot", connected: true, isBot: true });
    room.started = true;
    broadcastRoom(room);
    startRound(room);
  });

  socket.on("play_tile", ({ tile, side }) => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room || !room.started || room.matchOver) return;
    const seatIndex = room.seats.findIndex((s) => s && s.socketId === socket.id);
    if (seatIndex === -1 || seatIndex !== room.game.currentSeat) return;
    const g = room.game;
    const hand = g.players[seatIndex].hand;
    const idx = hand.findIndex((t) => t.a === tile.a && t.b === tile.b);
    if (idx === -1) return;
    const m = tileMatchesEnds(g.chain, hand[idx]);
    if (!((side === "left" && m.left) || (side === "right" && m.right) || g.chain.length === 0)) {
      return socket.emit("error_msg", "Bu taş buraya oynanamaz");
    }
    placeTile(g.chain, hand[idx], g.chain.length === 0 ? "left" : side);
    hand.splice(idx, 1);
    g.passStreak = 0;
    afterAction(room, seatIndex, false);
  });

  socket.on("draw_tile", () => {
    // Drawing is disabled — Domino World uses Block rules (deal once, no draw pile).
  });

  socket.on("pass_turn", () => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room || !room.started || room.matchOver) return;
    const seatIndex = room.seats.findIndex((s) => s && s.socketId === socket.id);
    if (seatIndex === -1 || seatIndex !== room.game.currentSeat) return;
    const g = room.game;
    if (handHasPlayable(g.chain, g.players[seatIndex].hand)) return;
    g.passStreak++;
    afterAction(room, seatIndex, true);
  });

  socket.on("next_round", () => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room || room.matchOver) return;
    startRound(room);
  });

  socket.on("disconnect", () => {
    removeFromQueues(socket.id);
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (room) {
      const seat = room.seats.find((s) => s && s.socketId === socket.id);
      if (seat) seat.connected = false;
      broadcastRoom(room);
    }
    delete socketRoom[socket.id];
  });
});

server.listen(PORT, () => {
  console.log("Domino World server listening on port " + PORT);
});
