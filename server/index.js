// server/index.js - build 2. Authoritative server with seats, human intents, and per-player hand hiding.
//
// Seat model: room.seats[seat] holds a clientId, or null meaning "bot". A human can claim any bot/open
// seat; disconnecting reverts their seats to bots. The bot driver only acts for bot seats - when a human
// seat is on turn, the server waits for that human's validated intent. Each client receives a view with
// only the hands it may see (its own, and the dummy once exposed).

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
app.get('/healthz', (req, res) => res.send('ok')); // liveness check for the host / monitoring
app.use(express.json());        // parse JSON bodies for the auth routes
registerAuthRoutes(app);        // mounts the session middleware + /api/signup, /api/login, /api/logout, /api/me
app.use(express.static(path.join(__dirname, '..', 'public')));
const httpServer = createServer(app);
const io = new Server(httpServer);
io.engine.use(sessionMiddleware); // make the logged-in session available on socket.request.session

const PLAY_GAP = 650, TRICK_PAUSE = 1400, BID_GAP = 450;
const TURN_SECONDS = 30;  // a connected human has this long to act before the server auto-acts
const GRACE_SECONDS = 25; // a disconnected human keeps their seat this long before it reverts to a bot

// Connected sockets. Keyed per-socket (not per clientId) so no connection is ever dropped from
// broadcasts, even if two tabs happen to share an id.
const sockets = new Set();
function clientConnected(cid) {
  for (const s of sockets) if (s.data.clientId === cid) return true;
  return false;
}

// ---- One room for v1. Seats hold a clientId or null (= bot). ----
const room = {
  game: null,
  rubber: newRubber(),
  log: createLog(),
  rounds: [],
  recorded: new Set(),
  dealGameWon: null,
  seats: { N: null, E: null, S: null, W: null },
  timer: null,        // bot-move timer
  clock: null,        // human turn-clock timer
  turnEndsAt: null,   // epoch ms the current human turn auto-resolves (null on bot/auto turns)
  grace: new Map(),   // clientId -> grace timer for a disconnected human still holding a seat
  reveal: new Set(),  // clientIds spectating with all cards revealed
  lockedThisDeal: new Set(), // clientIds barred from claiming a seat this deal (they saw the cards)
  originalHands: null, // snapshot of the current deal for honors scoring (server-only)
  names: new Map(),    // clientId -> display username (for logged-in players)
};

function seatOfClient(cid) { return cid == null ? null : (SEATS.find((s) => room.seats[s] === cid) || null); }
function seatIsEmpty(seat) { return room.seats[seat] == null; }

// A seat is "auto" (played by the bot driver) if it holds a bot, or a human who is currently
// disconnected (in grace). Empty seats are NOT auto - the game pauses there until someone fills them.
function seatIsAuto(seat) {
  const v = room.seats[seat];
  if (v === 'bot') return true;
  if (v == null) return false;      // empty -> paused
  return !clientConnected(v);        // human -> auto only while disconnected (grace)
}

function clearClock() { clearTimeout(room.clock); room.clock = null; room.turnEndsAt = null; }

// ---- Per-player view: hide every hand except the viewer's own and the exposed dummy. ----
function viewFor(seat, cid) {
  const g = room.game;
  const chosenSpectate = room.reveal.has(cid);
  const revealAll = chosenSpectate || g.phase === 'done'; // spectators, and everyone once the deal is over
  // At the end of a deal the played-out hands are empty, so show the original deal instead.
  const source = (g.phase === 'done' && room.originalHands) ? room.originalHands : g.hands;
  const hands = {};
  for (const s of SEATS) {
    const canSee = revealAll || s === seat || (g.dummyRevealed && s === g.dummy);
    hands[s] = canSee ? source[s] : source[s].map(() => ({ hidden: true })); // placeholders keep the count only
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
    turnEndsAt: room.turnEndsAt,           // epoch ms the current human turn auto-resolves, or null
    spectating: chosenSpectate,            // this client chose to spectate (drives the button)
    revealAll,                             // all hands are visible now (spectating, or the deal is over)
    locked: room.lockedThisDeal.has(cid),  // this client cannot claim a seat until the next deal
  };
}
// Send the current state to one socket, attaching that socket's auth info.
function sendTo(socket) {
  const v = viewFor(seatOfClient(socket.data.clientId), socket.data.clientId);
  v.loggedIn = !!socket.data.loggedIn;
  v.username = socket.data.username || null;
  socket.emit('state', v);
}
function emitStates() {
  for (const s of sockets) sendTo(s);
}

// ---- Scoring (ported from the offline main.js) ----
function doPlay(seat, card) {
  const g = room.game;
  const wasPlaying = g.phase === 'playing';
  const before = g.currentTrick.length;
  playCard(g, seat, card);
  const trickDone = before === 3 && g.currentTrick.length === 0;
  if (wasPlaying && g.phase === 'done' && g.contract) scoreDeal();
  return trickDone;
}

function scoreDeal() {
  const g = room.game;
  const declSide = PARTNERSHIPS[g.contract.declarer];
  const rows = scoreHand(g.contract, g.tricksWon[declSide], g.vul[declSide], g.round);
  addEvents(room.log, rows);
  const trickPoints = rows.filter((r) => r.countsTowardGame && r.team === declSide).reduce((s, r) => s + r.points, 0);
  const outcome = applyTrickPoints(room.rubber, declSide, trickPoints);
  room.dealGameWon = outcome.gameWon;
  if (outcome.rubberBonus > 0) addEvents(room.log, [extraBonusRow(g.round, outcome.bonusSide, 'Rubber bonus', outcome.rubberBonus)]);

  // Honors: from the original deal, awarded to whichever side held them (independent of the result).
  const honors = honorBonus(room.originalHands, g.contract.strain);
  if (honors) addEvents(room.log, [extraBonusRow(g.round, PARTNERSHIPS[honors.seat], 'Honors', honors.points)]);
}

function maybeFinishRound() {
  const g = room.game;
  if ((g.phase === 'done' || g.phase === 'passed-out') && !room.recorded.has(g.round)) {
    room.recorded.add(g.round);
    recordRound();
  }
}

function recordRound() {
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

// ---- Turn driver. Bot/auto seats are played by the bot; a connected human gets a turn clock. ----
// Who actually acts for the seat on turn. In play the DECLARER acts for the dummy (bridge rule);
// otherwise the seat acts for itself. This is why a bot in the dummy seat must not auto-play it.
function actorSeat() {
  const g = room.game;
  return g.phase === 'playing' ? controllerOf(g, g.turn) : g.turn;
}

function activeSeatIsAuto() {
  const g = room.game;
  return (g.phase === 'bidding' || g.phase === 'playing') && seatIsAuto(actorSeat());
}

// Set up whoever is on turn: schedule the bot for an auto seat, or arm the clock for a connected human.
// Does not reset an already-running clock (so a connect/claim elsewhere doesn't extend the active turn).
function setupTurn(trickDone) {
  clearTimeout(room.timer);
  const g = room.game;
  if (g.phase !== 'bidding' && g.phase !== 'playing') { clearClock(); return; }
  const actor = actorSeat();
  if (seatIsEmpty(actor)) { clearClock(); return; } // paused: the controlling seat is empty
  if (seatIsAuto(actor)) {
    clearClock();
    const delay = g.phase === 'bidding' ? BID_GAP : (trickDone ? TRICK_PAUSE : PLAY_GAP);
    room.timer = setTimeout(botStep, delay);
  } else if (room.clock == null) {
    room.turnEndsAt = Date.now() + TURN_SECONDS * 1000;
    room.clock = setTimeout(onTurnTimeout, TURN_SECONDS * 1000);
  }
}

// Called after an actual move (turn advanced): drop the old clock and set a fresh one for the new turn.
function afterMove(trickDone) {
  clearClock();
  setupTurn(trickDone);
  emitStates();
}

// Called when seat occupancy changed but the turn did not (claim/release/connect/disconnect):
// re-evaluate the driver without disturbing a running clock.
function reevaluate() {
  setupTurn(false);
  emitStates();
}

// The connected human ran out of time: pass in bidding, play the lowest legal card in play.
function onTurnTimeout() {
  const g = room.game;
  clearClock();
  if (g.phase !== 'bidding' && g.phase !== 'playing') return;
  let trickDone = false;
  if (g.phase === 'bidding') makePass(g, g.turn);
  else trickDone = doPlay(g.turn, pickAutoCard(g, g.turn));
  maybeFinishRound();
  afterMove(trickDone);
}

function botStep() {
  if (!activeSeatIsAuto()) return; // seat became a connected human, or the hand ended
  const g = room.game;
  let trickDone = false;
  if (g.phase === 'bidding') {
    const bid = chooseBid(g, g.turn);
    if (bid) makeBid(g, g.turn, bid.level, bid.strain);
    else makePass(g, g.turn);
  } else {
    trickDone = doPlay(g.turn, pickAutoCard(g, g.turn));
  }
  maybeFinishRound();
  afterMove(trickDone);
}

function newDeal(round) {
  const g = newGame(round);
  g.vul = vulnerability(room.rubber);
  room.dealGameWon = null;
  room.lockedThisDeal = new Set(room.reveal); // anyone still spectating has seen the new deal
  room.originalHands = structuredClone(g.hands); // kept on the room (not the game) so it never reaches clients
  return g;
}

function startNewRubber() {
  room.rubber = newRubber();
  room.log = createLog();
  room.rounds = [];
  room.recorded.clear();
}

function onNewDeal() {
  const g = room.game;
  if (g.phase !== 'done' && g.phase !== 'passed-out') return; // only between hands
  if (room.rubber.complete) { startNewRubber(); room.game = newDeal(1); }
  else room.game = newDeal(g.round + 1);
  afterMove(false); // new turn (the dealer): fresh clock or bot
}

// ---- Connections and intents ----
io.on('connection', (socket) => {
  sockets.add(socket);

  socket.on('hello', (guestId) => {
    // Logged-in users are identified by their account; guests get a per-tab id and can only spectate.
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
      reevaluate(); // reconnected to a held seat -> hand it back from the bot
    } else {
      sendTo(socket); // just sync this newcomer
    }
  });

  socket.on('claim', (seat) => {
    const cid = socket.data.clientId;
    if (!cid || !SEATS.includes(seat)) return;
    if (!socket.data.loggedIn) return; // must be signed in to take a seat
    if (room.lockedThisDeal.has(cid)) return; // saw the cards this deal -> cannot sit until next deal
    const holder = room.seats[seat];
    const holderIsHuman = holder != null && holder !== 'bot';
    // Blocked only if another human holds it and is connected or briefly away (in grace). Bots/empty are free.
    if (holderIsHuman && holder !== cid && (clientConnected(holder) || room.grace.has(holder))) return;
    for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null; // one seat per client
    room.seats[seat] = cid;
    reevaluate();
  });

  // Spectate = reveal all cards. Gives up any seat and locks this client out of the current deal.
  socket.on('spectate', (on) => {
    const cid = socket.data.clientId;
    if (!cid) return;
    if (on) {
      for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null; // leave the table
      room.reveal.add(cid);
      room.lockedThisDeal.add(cid); // they have now seen every hand this deal
    } else {
      room.reveal.delete(cid); // stop peeking (still locked out for the rest of this deal)
    }
    reevaluate();
  });

  socket.on('release', () => {
    const cid = socket.data.clientId;
    if (!cid) return;
    for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null; // seat becomes empty
    reevaluate();
  });

  socket.on('addBot', (seat) => {
    if (!SEATS.includes(seat) || room.seats[seat] != null) return; // only fill an empty seat
    room.seats[seat] = 'bot';
    reevaluate();
  });

  socket.on('removeBot', (seat) => {
    if (!SEATS.includes(seat) || room.seats[seat] !== 'bot') return; // only remove a bot
    room.seats[seat] = null;
    reevaluate();
  });

  // TEMPORARY: wipe scores and start a fresh deal. Players keep their seats.
  socket.on('resetAll', () => {
    clearTimeout(room.timer);
    clearClock();
    for (const h of room.grace.values()) clearTimeout(h);
    room.grace.clear();
    room.rubber = newRubber();
    room.log = createLog();
    room.rounds = [];
    room.recorded.clear();
    room.game = newDeal(1);
    afterMove(false);
  });

  socket.on('bid', ({ level, strain } = {}) => {
    const seat = seatOfClient(socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    if (!isLegalBid(g, level, strain)) return;
    makeBid(g, seat, level, strain);
    maybeFinishRound();
    afterMove(false);
  });

  socket.on('pass', () => {
    const seat = seatOfClient(socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    makePass(g, seat);
    maybeFinishRound();
    afterMove(false);
  });

  socket.on('double', () => {
    const seat = seatOfClient(socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    makeDouble(g, seat); // no-ops if illegal
    maybeFinishRound();
    afterMove(false);
  });

  socket.on('redouble', () => {
    const seat = seatOfClient(socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'bidding' || g.turn !== seat) return;
    makeRedouble(g, seat); // no-ops if illegal
    maybeFinishRound();
    afterMove(false);
  });

  socket.on('play', ({ suit, rank } = {}) => {
    const seat = seatOfClient(socket.data.clientId);
    const g = room.game;
    if (!seat || g.phase !== 'playing') return;
    if (controllerOf(g, g.turn) !== seat) return;               // you control the seat on turn (declarer plays dummy)
    const hand = g.hands[g.turn];
    const card = hand.find((c) => c.suit === suit && c.rank === rank);
    if (!card || !isLegal(g, g.turn, card)) return;             // must be a real, legal card
    const trickDone = doPlay(g.turn, card);
    maybeFinishRound();
    afterMove(trickDone);
  });

  socket.on('newDeal', onNewDeal);

  socket.on('disconnect', () => {
    sockets.delete(socket);
    const cid = socket.data.clientId;
    if (!cid || clientConnected(cid)) return; // another tab with the same id is still here; keep the seat
    const seat = seatOfClient(cid);
    if (seat && !room.grace.has(cid)) {
      // Hold the seat for a grace window; bots auto-play it meanwhile (it is now "auto" since disconnected).
      const handle = setTimeout(() => {
        room.grace.delete(cid);
        if (room.seats[seat] === cid && !clientConnected(cid)) room.seats[seat] = null; // grace expired -> bot
        reevaluate();
      }, GRACE_SECONDS * 1000);
      room.grace.set(cid, handle);
    }
    room.reveal.delete(cid);
    room.lockedThisDeal.delete(cid);
    reevaluate(); // the seat is now auto; the bot driver takes over its turns
  });
});

// ---- Boot ----
room.game = newDeal(1);
afterMove(false); // set up the first turn (a bot deals deal 1, so the bot driver starts)

// Connect to Postgres, ensure the schema, and prove a read works. Non-fatal: the game still runs
// if the database is unreachable (accounts just won't work until it is).
initSchema()
  .then(() => query('SELECT COUNT(*) FROM users'))
  .then((r) => console.log(`Users in database: ${r.rows[0].count}`))
  .catch((err) => console.error('Database not ready:', err.message));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Bridge server running: http://localhost:${PORT}`));
