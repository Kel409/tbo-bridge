// server/index.js - two independent rooms: 'normal' (accounts optional, no stats) and 'ranked'
// (login required to sit, results update the account's win/loss record). Every game function takes the
// room it operates on. A socket picks its room via the ?mode= query on connect.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  newGame, makeBid, makePass, makeDouble, makeRedouble, playCard, pickAutoCard,
  isLegal, isLegalBid, controllerOf, PARTNERSHIPS, SEATS,
} from '../public/js/game.js';
import { createLog, scoreHand, addEvents, extraBonusRow, honorBonus } from '../public/js/scoring.js';
import { newRubber, vulnerability, applyTrickPoints } from '../public/js/rubber.js';
import { chooseBid } from '../public/js/bidding-ai.js';
import { initSchema, query } from './db.js';
import { registerAuthRoutes, sessionMiddleware } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // proxies terminate HTTPS upstream; trust it so secure cookies are set
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.json());
registerAuthRoutes(app);
app.use(express.static(path.join(__dirname, '..', 'public')));
const httpServer = createServer(app);
const io = new Server(httpServer);
io.engine.use(sessionMiddleware);

const PLAY_GAP = 650, TRICK_PAUSE = 1400, BID_GAP = 450;
const TURN_SECONDS = 30;
const GRACE_SECONDS = 25;

// ---- Rooms ----
function makeRoom(mode) {
  return {
    mode,                     // 'normal' | 'ranked'
    sockets: new Set(),       // sockets currently in this room
    game: null,
    rubber: newRubber(),
    log: createLog(),
    rounds: [],
    recorded: new Set(),
    rubberRecorded: false,    // ranked stats recorded for the current rubber?
    dealGameWon: null,
    seats: { N: null, E: null, S: null, W: null },
    timer: null,
    clock: null,
    turnEndsAt: null,
    grace: new Map(),
    reveal: new Set(),
    lockedThisDeal: new Set(),
    originalHands: null,
    names: new Map(),
  };
}
const rooms = { normal: makeRoom('normal'), ranked: makeRoom('ranked') };

function clientConnected(room, cid) {
  for (const s of room.sockets) if (s.data.clientId === cid) return true;
  return false;
}
function seatOfClient(room, cid) { return cid == null ? null : (SEATS.find((s) => room.seats[s] === cid) || null); }
function seatIsEmpty(room, seat) { return room.seats[seat] == null; }
function seatIsAuto(room, seat) {
  const v = room.seats[seat];
  if (v === 'bot') return true;
  if (v == null) return false;
  return !clientConnected(room, v);
}
function clearClock(room) { clearTimeout(room.clock); room.clock = null; room.turnEndsAt = null; }

// ---- Per-player view ----
function viewFor(room, seat, cid) {
  const g = room.game;
  const chosenSpectate = room.reveal.has(cid);
  const revealAll = chosenSpectate || g.phase === 'done';
  const source = (g.phase === 'done' && room.originalHands) ? room.originalHands : g.hands;
  const hands = {};
  for (const s of SEATS) {
    const canSee = revealAll || s === seat || (g.dummyRevealed && s === g.dummy);
    hands[s] = canSee ? source[s] : source[s].map(() => ({ hidden: true }));
  }
  const seatStatus = {};
  const seatNames = {};
  for (const s of SEATS) {
    const v = room.seats[s];
    seatStatus[s] = v == null ? 'empty' : (v === 'bot' ? 'bot' : (v === seat ? 'you' : 'taken'));
    seatNames[s] = (v && v !== 'bot') ? (room.names.get(v) || 'Player') : null;
  }
  return {
    game: { ...g, hands },
    rubber: room.rubber,
    rounds: room.rounds,
    log: room.log,
    seats: seatStatus,
    seatNames,
    you: seat,
    mode: room.mode,
    turnEndsAt: room.turnEndsAt,
    spectating: chosenSpectate,
    revealAll,
    locked: room.lockedThisDeal.has(cid),
  };
}
function sendTo(socket) {
  const room = socket.data.room;
  const v = viewFor(room, seatOfClient(room, socket.data.clientId), socket.data.clientId);
  v.loggedIn = !!socket.data.loggedIn;
  v.username = socket.data.username || null;
  socket.emit('state', v);
}
function emitStates(room) {
  for (const s of room.sockets) sendTo(s);
}

// ---- Scoring ----
function doPlay(room, seat, card) {
  const g = room.game;
  const wasPlaying = g.phase === 'playing';
  const before = g.currentTrick.length;
  playCard(g, seat, card);
  const trickDone = before === 3 && g.currentTrick.length === 0;
  if (wasPlaying && g.phase === 'done' && g.contract) scoreDeal(room);
  return trickDone;
}

function scoreDeal(room) {
  const g = room.game;
  const declSide = PARTNERSHIPS[g.contract.declarer];
  const rows = scoreHand(g.contract, g.tricksWon[declSide], g.vul[declSide], g.round);
  addEvents(room.log, rows);
  const trickPoints = rows.filter((r) => r.countsTowardGame && r.team === declSide).reduce((s, r) => s + r.points, 0);
  const outcome = applyTrickPoints(room.rubber, declSide, trickPoints);
  room.dealGameWon = outcome.gameWon;
  if (outcome.rubberBonus > 0) addEvents(room.log, [extraBonusRow(g.round, outcome.bonusSide, 'Rubber bonus', outcome.rubberBonus)]);

  const honors = honorBonus(room.originalHands, g.contract.strain);
  if (honors) addEvents(room.log, [extraBonusRow(g.round, PARTNERSHIPS[honors.seat], 'Honors', honors.points)]);

  // Ranked only: when the rubber is decided, update the human players' win/loss records once.
  if (room.mode === 'ranked' && room.rubber.complete && !room.rubberRecorded) {
    room.rubberRecorded = true;
    recordRankedResult(room);
  }
}

async function recordRankedResult(room) {
  const winner = room.rubber.winner; // 'NS' | 'EW'
  for (const seat of SEATS) {
    const v = room.seats[seat];
    if (typeof v === 'string' && v.startsWith('u:')) {
      const id = Number(v.slice(2));
      const col = PARTNERSHIPS[seat] === winner ? 'games_won' : 'games_lost'; // fixed column names, not user input
      try { await query(`UPDATE users SET ${col} = ${col} + 1 WHERE id = $1`, [id]); }
      catch (e) { console.error('ranked stat update failed:', e.message); }
    }
  }
}

function maybeFinishRound(room) {
  const g = room.game;
  if ((g.phase === 'done' || g.phase === 'passed-out') && !room.recorded.has(g.round)) {
    room.recorded.add(g.round);
    recordRound(room);
  }
}

function recordRound(room) {
  const g = room.game;
  const per = { NS: { game: 0, bonus: 0 }, EW: { game: 0, bonus: 0 } };
  for (const e of room.log) if (e.round === g.round) per[e.team][e.countsTowardGame ? 'game' : 'bonus'] += e.points;
  const c = g.contract;
  const summary = {
    round: g.round, passedOut: g.phase === 'passed-out' || !c,
    tricks: { NS: g.tricksWon.NS, EW: g.tricksWon.EW }, points: per,
    gameWonBy: room.dealGameWon, contract: null, declarer: null, made: null, diff: null,
  };
  if (c) {
    const declSide = PARTNERSHIPS[c.declarer];
    summary.diff = g.tricksWon[declSide] - (c.level + 6);
    summary.made = summary.diff >= 0;
    summary.contract = `${c.level}${c.strain}${c.doubled === 2 ? ' XX' : c.doubled === 1 ? ' X' : ''}`;
    summary.declarer = c.declarer;
  }
  room.rounds.push(summary);
}

// ---- Turn driver ----
function actorSeat(room) {
  const g = room.game;
  return g.phase === 'playing' ? controllerOf(g, g.turn) : g.turn;
}
function activeSeatIsAuto(room) {
  const g = room.game;
  return (g.phase === 'bidding' || g.phase === 'playing') && seatIsAuto(room, actorSeat(room));
}
function setupTurn(room, trickDone) {
  clearTimeout(room.timer);
  const g = room.game;
  if (g.phase !== 'bidding' && g.phase !== 'playing') { clearClock(room); return; }
  const actor = actorSeat(room);
  if (seatIsEmpty(room, actor)) { clearClock(room); return; }
  if (seatIsAuto(room, actor)) {
    clearClock(room);
    const delay = g.phase === 'bidding' ? BID_GAP : (trickDone ? TRICK_PAUSE : PLAY_GAP);
    room.timer = setTimeout(() => botStep(room), delay);
  } else if (room.clock == null) {
    room.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    room.clock = setTimeout(() => onTurnTimeout(room), TURN_SECONDS * 1000);
  }
}
function afterMove(room, trickDone) {
  clearClock(room);
  setupTurn(room, trickDone);
  emitStates(room);
}
function reevaluate(room) {
  setupTurn(room, false);
  emitStates(room);
}
function onTurnTimeout(room) {
  const g = room.game;
  clearClock(room);
  if (g.phase !== 'bidding' && g.phase !== 'playing') return;
  let trickDone = false;
  if (g.phase === 'bidding') makePass(g, g.turn);
  else trickDone = doPlay(room, g.turn, pickAutoCard(g, g.turn));
  maybeFinishRound(room);
  afterMove(room, trickDone);
}
function botStep(room) {
  if (!activeSeatIsAuto(room)) return;
  const g = room.game;
  let trickDone = false;
  if (g.phase === 'bidding') {
    const bid = chooseBid(g, g.turn);
    if (bid) makeBid(g, g.turn, bid.level, bid.strain);
    else makePass(g, g.turn);
  } else {
    trickDone = doPlay(room, g.turn, pickAutoCard(g, g.turn));
  }
  maybeFinishRound(room);
  afterMove(room, trickDone);
}

function newDeal(room, round) {
  const g = newGame(round);
  g.vul = vulnerability(room.rubber);
  room.dealGameWon = null;
  room.lockedThisDeal = new Set(room.reveal);
  room.originalHands = structuredClone(g.hands);
  return g;
}
function startNewRubber(room) {
  room.rubber = newRubber();
  room.log = createLog();
  room.rounds = [];
  room.recorded.clear();
  room.rubberRecorded = false;
}
function onNewDeal(room) {
  const g = room.game;
  if (g.phase !== 'done' && g.phase !== 'passed-out') return;
  if (room.rubber.complete) { startNewRubber(room); room.game = newDeal(room, 1); }
  else room.game = newDeal(room, g.round + 1);
  afterMove(room, false);
}

// ---- Connections and intents ----
io.on('connection', (socket) => {
  const mode = socket.handshake.query.mode === 'ranked' ? 'ranked' : 'normal';
  const room = rooms[mode];
  socket.data.room = room;
  room.sockets.add(socket);

  socket.on('hello', (guestId) => {
    const sess = socket.request.session;
    if (sess && sess.userId) {
      socket.data.clientId = 'u:' + sess.userId;
      socket.data.loggedIn = true;
      socket.data.username = sess.username;
      room.names.set(socket.data.clientId, sess.username);
    } else if (typeof guestId === 'string') {
      socket.data.clientId = 'g:' + guestId;
      socket.data.loggedIn = false;
    } else {
      return;
    }
    const cid = socket.data.clientId;
    const graceHandle = room.grace.get(cid);
    if (graceHandle) {
      clearTimeout(graceHandle);
      room.grace.delete(cid);
      reevaluate(room);
    } else {
      sendTo(socket);
    }
  });

  socket.on('claim', (seat) => {
    const cid = socket.data.clientId;
    if (!cid || !SEATS.includes(seat)) return;
    if (room.mode === 'ranked' && !socket.data.loggedIn) return; // ranked requires an account to sit
    if (room.lockedThisDeal.has(cid)) return;
    const holder = room.seats[seat];
    const holderIsHuman = holder != null && holder !== 'bot';
    if (holderIsHuman && holder !== cid && (clientConnected(room, holder) || room.grace.has(holder))) return;
    for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null;
    room.seats[seat] = cid;
    reevaluate(room);
  });

  socket.on('spectate', (on) => {
    const cid = socket.data.clientId;
    if (!cid) return;
    if (on) {
      for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null;
      room.reveal.add(cid);
      room.lockedThisDeal.add(cid);
    } else {
      room.reveal.delete(cid);
    }
    reevaluate(room);
  });

  socket.on('release', () => {
    const cid = socket.data.clientId;
    if (!cid) return;
    for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null;
    reevaluate(room);
  });

  socket.on('addBot', (seat) => {
    if (room.mode === 'ranked') return; // ranked is players-only
    if (!SEATS.includes(seat) || room.seats[seat] != null) return;
    room.seats[seat] = 'bot';
    reevaluate(room);
  });

  socket.on('removeBot', (seat) => {
    if (!SEATS.includes(seat) || room.seats[seat] !== 'bot') return;
    room.seats[seat] = null;
    reevaluate(room);
  });

  socket.on('resetAll', () => {
    clearTimeout(room.timer);
    clearClock(room);
    for (const h of room.grace.values()) clearTimeout(h);
    room.grace.clear();
    startNewRubber(room);
    room.game = newDeal(room, 1);
    afterMove(room, false);
  });

  socket.on('bid', ({ level, strain } = {}) => {
    const seat = seatOfClient(room, socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    if (!isLegalBid(g, level, strain)) return;
    makeBid(g, seat, level, strain);
    maybeFinishRound(room);
    afterMove(room, false);
  });

  socket.on('pass', () => {
    const seat = seatOfClient(room, socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    makePass(g, seat);
    maybeFinishRound(room);
    afterMove(room, false);
  });

  socket.on('double', () => {
    const seat = seatOfClient(room, socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    makeDouble(g, seat);
    maybeFinishRound(room);
    afterMove(room, false);
  });

  socket.on('redouble', () => {
    const seat = seatOfClient(room, socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    makeRedouble(g, seat);
    maybeFinishRound(room);
    afterMove(room, false);
  });

  socket.on('play', ({ suit, rank } = {}) => {
    const seat = seatOfClient(room, socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'playing') return;
    if (controllerOf(g, g.turn) !== seat) return;
    const hand = g.hands[g.turn];
    const card = hand.find((c) => c.suit === suit && c.rank === rank);
    if (!card || !isLegal(g, g.turn, card)) return;
    const trickDone = doPlay(room, g.turn, card);
    maybeFinishRound(room);
    afterMove(room, trickDone);
  });

  socket.on('newDeal', () => onNewDeal(room));

  socket.on('disconnect', () => {
    room.sockets.delete(socket);
    const cid = socket.data.clientId;
    if (!cid || clientConnected(room, cid)) return;
    const seat = seatOfClient(room, cid);
    if (seat && !room.grace.has(cid)) {
      const handle = setTimeout(() => {
        room.grace.delete(cid);
        if (room.seats[seat] === cid && !clientConnected(room, cid)) room.seats[seat] = null;
        reevaluate(room);
      }, GRACE_SECONDS * 1000);
      room.grace.set(cid, handle);
    }
    room.reveal.delete(cid);
    room.lockedThisDeal.delete(cid);
    reevaluate(room);
  });
});

// ---- Boot ----
for (const room of Object.values(rooms)) {
  room.game = newDeal(room, 1);
  afterMove(room, false);
}

initSchema()
  .then(() => query('SELECT COUNT(*) FROM users'))
  .then((r) => console.log(`Users in database: ${r.rows[0].count}`))
  .catch((err) => console.error('Database not ready:', err.message));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Bridge server running: http://localhost:${PORT}`));
