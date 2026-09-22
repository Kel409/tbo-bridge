// server/index.js - two independent rooms: 'normal' (accounts optional, no stats) and 'ranked'
// (login required to sit, results update the account's win/loss record). Every game function takes the
// room it operates on. A socket picks its room via the ?mode= query on connect.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';

import {
  newGame, makeBid, makePass, makeDouble, makeRedouble, playCard, pickAutoCard,
  isLegal, isLegalBid, controllerOf, PARTNERSHIPS, SEATS,
} from '../public/js/game.js';
import { createLog, scoreHand, addEvents, extraBonusRow, honorBonus, totalFor } from '../public/js/scoring.js';
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

// ---- Avatars (Cloudinary) ----
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
// In-memory upload, capped at 2 MB, images only. Cloudinary re-encodes/resizes to a 256x256 square.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
function uploadToCloudinary(buffer, publicId, transformation) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'bridge', public_id: publicId, overwrite: true, format: 'png', transformation: [transformation] },
      (err, result) => (err ? reject(err) : resolve(result.secure_url)),
    );
    stream.end(buffer);
  });
}

app.post('/api/avatar', avatarUpload.single('avatar'), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in first.' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
  try {
    const chk = await query('SELECT username, avatar_blocked FROM users WHERE id = $1', [req.session.userId]);
    if (chk.rows[0] && chk.rows[0].avatar_blocked) return res.status(403).json({ error: 'Your image is blocked.' });
    const url = await uploadToCloudinary(req.file.buffer, 'avatar_' + req.session.userId, { width: 256, height: 256, crop: 'fill', gravity: 'face' });
    await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, req.session.userId]);
    refreshImagesForUsername(chk.rows[0] && chk.rows[0].username);
    res.json({ avatar: url });
  } catch (e) {
    console.error('avatar upload failed:', e.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

app.post('/api/cardback', avatarUpload.single('image'), async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in first.' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
  try {
    const chk = await query('SELECT username, card_back_blocked FROM users WHERE id = $1', [req.session.userId]);
    if (chk.rows[0] && chk.rows[0].card_back_blocked) return res.status(403).json({ error: 'Your image is blocked.' });
    const url = await uploadToCloudinary(req.file.buffer, 'cardback_' + req.session.userId, { width: 240, height: 336, crop: 'fill' }); // card aspect
    await query('UPDATE users SET card_back_url = $1 WHERE id = $2', [url, req.session.userId]);
    refreshImagesForUsername(chk.rows[0] && chk.rows[0].username);
    res.json({ cardBack: url });
  } catch (e) {
    console.error('card back upload failed:', e.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// Clear this user's custom images (avatar and card back).
app.post('/api/clear-images', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Log in first.' });
  try {
    await query('UPDATE users SET avatar_url = NULL, card_back_url = NULL WHERE id = $1', [req.session.userId]);
    refreshImagesForUsername(req.session.username);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed.' });
  }
});

// Admin (ADMIN_USERNAME) blocks/unblocks a user's images (both avatar and card back).
function isAdmin(req) {
  return !!process.env.ADMIN_USERNAME && req.session && req.session.username === process.env.ADMIN_USERNAME;
}
app.post('/api/admin/block', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Not allowed.' });
  const { username, blocked } = req.body || {};
  if (typeof username !== 'string') return res.status(400).json({ error: 'Username required.' });
  try {
    await query('UPDATE users SET avatar_blocked = $1, card_back_blocked = $1 WHERE username = $2', [blocked !== false, username]);
    refreshImagesForUsername(username);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed.' });
  }
});

// Re-read a user's effective images and push them to their connected sockets in every room.
async function refreshImagesForUsername(username) {
  if (!username) return;
  let r;
  try { r = await query('SELECT avatar_url, avatar_blocked, card_back_url, card_back_blocked FROM users WHERE username = $1', [username]); }
  catch { return; }
  const u = r.rows[0] || {};
  const av = (u.avatar_url && !u.avatar_blocked) ? u.avatar_url : null;
  const cb = (u.card_back_url && !u.card_back_blocked) ? u.card_back_url : null;
  for (const room of Object.values(rooms)) {
    let changed = false;
    for (const s of room.sockets) {
      if (s.data.username === username) {
        s.data.avatar = av; s.data.cardBack = cb;
        room.avatars.set(s.data.clientId, av); room.cardBacks.set(s.data.clientId, cb);
        changed = true;
      }
    }
    if (changed) emitStates(room);
  }
}

// Turn oversized/invalid uploads into a clean JSON error.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Image too large (max 2 MB).' });
  if (err) return res.status(400).json({ error: 'Upload error.' });
  next();
});

const httpServer = createServer(app);
const io = new Server(httpServer);
io.engine.use(sessionMiddleware);

const PLAY_GAP = 650, TRICK_PAUSE = 1400, BID_GAP = 450;
const TURN_SECONDS = 120;
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
    dealTally: { NS: { cm: 0, cl: 0, dw: 0, dl: 0 }, EW: { cm: 0, cl: 0, dw: 0, dl: 0 } }, // per side this rubber
    hcpTally: { N: { sum: 0, count: 0 }, E: { sum: 0, count: 0 }, S: { sum: 0, count: 0 }, W: { sum: 0, count: 0 } }, // high-card points per seat this rubber
    queues: { N: [], E: [], S: [], W: [] }, // clientIds waiting for each seat (normal mode)
    owners: { N: null, E: null, S: null, W: null }, // ranked: who owns each seat for the current rubber
    dealGameWon: null,
    seats: { N: null, E: null, S: null, W: null },
    timer: null,
    clock: null,
    turnEndsAt: null,
    grace: new Map(),
    reveal: new Set(),
    lockedThisDeal: new Set(),
    originalHands: null,
    names: new Map(),         // clientId -> display username
    avatars: new Map(),       // clientId -> effective avatar url (null if none/blocked)
    cardBacks: new Map(),     // clientId -> effective card-back url (null if none/blocked)
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

// High-card points of a 13-card hand (A=4, K=3, Q=2, J=1).
const HCP_VALUE = { 14: 4, 13: 3, 12: 2, 11: 1 };
function handHCP(cards) { let h = 0; for (const c of cards) h += HCP_VALUE[c.rank] || 0; return h; }

function removeFromQueues(room, cid) {
  for (const s of SEATS) { const q = room.queues[s]; const i = q.indexOf(cid); if (i >= 0) q.splice(i, 1); }
}
function ownerOf(room, cid) { return SEATS.find((s) => room.owners[s] === cid) || null; } // ranked seat this client owns
function rubberActive(room) { return room.mode === 'ranked' && SEATS.every((s) => room.owners[s] != null); }
function seatOfQueued(room, cid) { return SEATS.find((s) => room.queues[s].includes(cid)) || null; }
// When a seat frees, seat the first eligible waiter (connected; logged in for ranked; not locked this deal).
function fillFromQueue(room, seat) {
  if (room.seats[seat] != null) return;
  const q = room.queues[seat];
  while (q.length) {
    const cid = q.shift();
    const sock = [...room.sockets].find((s) => s.data.clientId === cid);
    if (!sock) continue;
    if (room.mode === 'ranked' && !sock.data.loggedIn) continue;
    if (room.lockedThisDeal.has(cid)) continue;
    for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null;
    room.seats[seat] = cid;
    removeFromQueues(room, cid);
    return;
  }
}

// ---- Per-player view ----
function viewFor(room, seat, cid) {
  const g = room.game;
  const myOwned = ownerOf(room, cid);
  const active = rubberActive(room);
  const chosenSpectate = room.reveal.has(cid);
  const isQueued = seatOfQueued(room, cid) != null; // waiting for a seat: watch until you're seated next deal
  // A non-participant in an active ranked rubber automatically sees all cards (can't join until it ends).
  const autoSpectate = room.mode === 'ranked' && active && !myOwned && seat == null;
  const revealAll = chosenSpectate || autoSpectate || isQueued || g.phase === 'done';
  const source = (g.phase === 'done' && room.originalHands) ? room.originalHands : g.hands;
  const iAmDummy = seat != null && g.dummy === seat; // if you're the dummy, you also see your partner (declarer)
  const hands = {};
  for (const s of SEATS) {
    const canSee = revealAll || s === seat || (g.dummyRevealed && s === g.dummy) || (iAmDummy && s === g.declarer);
    hands[s] = canSee ? source[s] : source[s].map(() => ({ hidden: true }));
  }
  const seatStatus = {};
  const seatNames = {};
  const seatAvatars = {};
  const seatCardBacks = {};
  const seatQueue = {};
  for (const s of SEATS) {
    const v = room.seats[s];
    seatStatus[s] = v == null ? 'empty' : (v === 'bot' ? 'bot' : (v === cid ? 'you' : 'taken'));
    seatNames[s] = (v && v !== 'bot') ? (room.names.get(v) || 'Player') : null;
    seatAvatars[s] = (v && v !== 'bot') ? (room.avatars.get(v) || null) : null;
    seatCardBacks[s] = (v && v !== 'bot') ? (room.cardBacks.get(v) || null) : null;
    seatQueue[s] = room.queues[s].length;
  }
  return {
    game: { ...g, hands },
    rubber: room.rubber,
    rounds: room.rounds,
    log: room.log,
    seats: seatStatus,
    seatNames,
    seatAvatars,
    seatCardBacks,
    seatQueue,
    youQueued: seatOfQueued(room, cid),
    myOwnedSeat: myOwned,
    rubberActive: active,
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

  // Per-deal result: split into the declaring side's contract result and the defenders' defense result.
  const made = g.tricksWon[declSide] >= g.contract.level + 6;
  const defSide = declSide === 'NS' ? 'EW' : 'NS';
  if (made) { room.dealTally[declSide].cm += 1; room.dealTally[defSide].dl += 1; }
  else { room.dealTally[declSide].cl += 1; room.dealTally[defSide].dw += 1; }

  const trickPoints = rows.filter((r) => r.countsTowardGame && r.team === declSide).reduce((s, r) => s + r.points, 0);
  const outcome = applyTrickPoints(room.rubber, declSide, trickPoints);
  room.dealGameWon = outcome.gameWon;
  if (outcome.rubberBonus > 0) addEvents(room.log, [extraBonusRow(g.round, outcome.bonusSide, 'Rubber bonus', outcome.rubberBonus)]);

  const honors = honorBonus(room.originalHands, g.contract.strain);
  if (honors) addEvents(room.log, [extraBonusRow(g.round, PARTNERSHIPS[honors.seat], 'Honors', honors.points)]);

  // Ranked: settle the entire rubber once, when it is decided.
  if (room.mode === 'ranked' && room.rubber.complete && !room.rubberRecorded) {
    room.rubberRecorded = true;
    settleRubber(room);
  }
}

// Ranked settlement: net zero-sum points (score difference), deals and rubber counts, and a history row.
async function settleRubber(room) {
  const nsTotal = totalFor(room.log, 'NS');
  const ewTotal = totalFor(room.log, 'EW');
  const delta = { NS: nsTotal - ewTotal, EW: ewTotal - nsTotal }; // sums to zero across the four players
  const winner = room.rubber.winner;

  const seats = {};
  const players = [];
  for (const seat of SEATS) {
    const v = room.seats[seat];
    if (typeof v === 'string' && v.startsWith('u:')) {
      const id = Number(v.slice(2));
      seats[seat] = { userId: id, username: room.names.get(v) || 'Player' };
      players.push(id);
    } else {
      seats[seat] = null;
    }
  }

  for (const seat of SEATS) {
    const info = seats[seat];
    if (!info) continue;
    const side = PARTNERSHIPS[seat];
    const t = room.dealTally[side];
    const h = room.hcpTally[seat];
    const rw = side === winner ? 1 : 0;
    try {
      await query(
        `UPDATE users SET points = points + $1, contracts_made = contracts_made + $2, contracts_lost = contracts_lost + $3,
                          defenses_won = defenses_won + $4, defenses_lost = defenses_lost + $5,
                          rubbers_won = rubbers_won + $6, rubbers_lost = rubbers_lost + $7,
                          hcp_total = hcp_total + $8, hands_dealt = hands_dealt + $9 WHERE id = $10`,
        [delta[side], t.cm, t.cl, t.dw, t.dl, rw, 1 - rw, h.sum, h.count, info.userId],
      );
    } catch (e) { console.error('rubber stat update failed:', e.message); }
  }

  try {
    await query(
      'INSERT INTO matches (ns_score, ew_score, winner, seats, rounds, players) VALUES ($1, $2, $3, $4, $5, $6)',
      [nsTotal, ewTotal, winner, JSON.stringify(seats), JSON.stringify(room.rounds), players],
    );
  } catch (e) { console.error('match insert failed:', e.message); }
}

function maybeFinishRound(room) {
  const g = room.game;
  if ((g.phase === 'done' || g.phase === 'passed-out') && !room.recorded.has(g.round)) {
    room.recorded.add(g.round);
    recordRound(room);
    // Ranked: tally each seated player's high-card points for this deal (for the per-hand average).
    if (room.mode === 'ranked' && room.originalHands) {
      for (const seat of SEATS) {
        const v = room.seats[seat];
        if (typeof v === 'string' && v.startsWith('u:')) {
          room.hcpTally[seat].sum += handHCP(room.originalHands[seat]);
          room.hcpTally[seat].count += 1;
        }
      }
    }
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
  room.dealTally = { NS: { cm: 0, cl: 0, dw: 0, dl: 0 }, EW: { cm: 0, cl: 0, dw: 0, dl: 0 } };
  room.hcpTally = { N: { sum: 0, count: 0 }, E: { sum: 0, count: 0 }, S: { sum: 0, count: 0 }, W: { sum: 0, count: 0 } };
  // Ownership resets to whoever is actually seated now; bot/empty seats open up for the new rubber.
  for (const s of SEATS) room.owners[s] = (typeof room.seats[s] === 'string' && room.seats[s].startsWith('u:')) ? room.seats[s] : null;
}
function fillEmptySeats(room) {
  for (const s of SEATS) {
    if (room.queues[s].length && room.seats[s] === 'bot') room.seats[s] = null; // kick the bot so a waiting player can take the seat
    if (room.seats[s] == null) fillFromQueue(room, s);
  }
}

function onNewDeal(room) {
  const g = room.game;
  if (g.phase !== 'done' && g.phase !== 'passed-out') return;
  if (room.rubber.complete) { startNewRubber(room); room.game = newDeal(room, 1); }
  else room.game = newDeal(room, g.round + 1);
  fillEmptySeats(room); // a spectator who queued gets seated now that their peek-lock cleared
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
      // Load this user's effective avatar and card back, then refresh so seats show them.
      query('SELECT avatar_url, avatar_blocked, card_back_url, card_back_blocked FROM users WHERE id = $1', [sess.userId])
        .then((r) => {
          const u = r.rows[0] || {};
          const av = (u.avatar_url && !u.avatar_blocked) ? u.avatar_url : null;
          const cb = (u.card_back_url && !u.card_back_blocked) ? u.card_back_url : null;
          socket.data.avatar = av;
          socket.data.cardBack = cb;
          room.avatars.set(socket.data.clientId, av);
          room.cardBacks.set(socket.data.clientId, cb);
          emitStates(room);
        })
        .catch(() => {});
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

    if (room.mode === 'ranked') {
      if (!socket.data.loggedIn) return;
      const myOwned = ownerOf(room, cid);
      if (myOwned) {
        if (seat !== myOwned) return;      // locked to your own seat; no switching
        room.seats[seat] = cid;            // reclaim your seat from the bot placeholder
      } else {
        if (rubberActive(room)) return;    // rubber underway: non-participants can't join
        if (room.owners[seat] != null) return; // owned by someone else
        if (room.lockedThisDeal.has(cid)) return; // you peeked this deal
        room.owners[seat] = cid;           // lock this seat to you for the rubber
        room.seats[seat] = cid;
      }
      reevaluate(room);
      return;
    }

    // Normal mode: sit an open/bot seat, or line up for an occupied one. Queued players watch and are seated next deal.
    const holder = room.seats[seat];
    const holderIsHuman = holder != null && holder !== 'bot';
    const q = room.queues[seat];
    const alreadyQueued = q.includes(cid);
    const mustQueue = room.lockedThisDeal.has(cid) || (holderIsHuman && holder !== cid);
    if (mustQueue) {
      if (alreadyQueued) {
        q.splice(q.indexOf(cid), 1); // toggle off
      } else {
        removeFromQueues(room, cid);
        q.push(cid);
        room.reveal.delete(cid);        // reveal is driven by "queued" now, so it clears the lock next deal
        room.lockedThisDeal.add(cid);   // you can watch, but can't be seated until the next deal
      }
      reevaluate(room);
      return;
    }
    for (const s of SEATS) if (room.seats[s] === cid) room.seats[s] = null;
    room.seats[seat] = cid;
    removeFromQueues(room, cid);
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
    if (room.mode === 'ranked') {
      const s = ownerOf(room, cid);
      if (s && room.seats[s] === cid) room.seats[s] = 'bot'; // bot holds your seat; you keep ownership to reclaim
    } else {
      for (const s of SEATS) if (room.seats[s] === cid) { room.seats[s] = null; fillFromQueue(room, s); }
    }
    reevaluate(room);
  });

  socket.on('addBot', (seat) => {
    if (room.mode === 'ranked') return; // ranked is players-only
    if (!SEATS.includes(seat) || room.seats[seat] != null) return;
    room.seats[seat] = 'bot';
    reevaluate(room);
  });

  socket.on('removeBot', (seat) => {
    if (room.mode === 'ranked') return; // ranked bots are owner placeholders, managed by leave/reclaim
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
        if (room.seats[seat] === cid && !clientConnected(room, cid)) {
          if (room.mode === 'ranked' && room.owners[seat] === cid) room.seats[seat] = 'bot'; // keep the owner's seat, bot fills
          else { room.seats[seat] = null; fillFromQueue(room, seat); }
        }
        reevaluate(room);
      }, GRACE_SECONDS * 1000);
      room.grace.set(cid, handle);
    }
    room.reveal.delete(cid);
    room.lockedThisDeal.delete(cid);
    removeFromQueues(room, cid);
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
