// main.js - build 2 online client. Owns no game state: it receives per-player snapshots and renders them,
// and it sends intents (claim/release a seat, bid, pass, play). The server validates everything.

import { render } from './ui.js';

const socket = io(); // global from /socket.io/socket.io.js

// A per-tab id (sessionStorage is NOT shared between tabs/windows, unlike localStorage), so two
// windows in the same browser are two different players. It survives a refresh but not a tab close.
let clientId = sessionStorage.getItem('bridgeClientId');
if (!clientId) {
  clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  sessionStorage.setItem('bridgeClientId', clientId);
}

let state = null;           // latest snapshot: { game, rubber, rounds, log, seats, you }
let selectedLevel = 1;      // local: bid level stepper
let scoreboardOpen = false; // local: is the scoreboard popup showing
let bidsOpen = false;       // local: is the bid-order popup showing
let seenRounds = 0;         // to auto-open the scoreboard when a deal finishes
let suitOrder = (localStorage.getItem('suitOrder') || 'SHDC').split(''); // viewer's preferred suit order

function draw() {
  if (!state) return;
  render(state.game, onCardClick, {
    selectedLevel,
    log: state.log,
    rounds: state.rounds,
    scoreboardOpen,
    rubber: state.rubber,
    mySeat: state.you,
    seats: state.seats,
    seatNames: state.seatNames,
    spectating: state.spectating,
    revealAll: state.revealAll,
    locked: state.locked,
    suitOrder,
    bidsOpen,
  });
}

socket.on('connect', () => socket.emit('hello', clientId));

socket.on('state', (s) => {
  state = s;
  if (s.rounds.length > seenRounds) { scoreboardOpen = true; seenRounds = s.rounds.length; }
  if (s.rounds.length < seenRounds) seenRounds = s.rounds.length; // new rubber reset
  const leaveBtn = document.getElementById('leave-seat');
  if (leaveBtn) leaveBtn.disabled = !s.you; // only usable when you actually hold a seat
  const spectateBtn = document.getElementById('spectate');
  if (spectateBtn) {
    spectateBtn.textContent = s.spectating ? 'Stop spectating' : 'Spectate';
    spectateBtn.classList.toggle('on', !!s.spectating);
  }
  renderAuthBar();
  draw();
  updateClock();
});

// The server sends turnEndsAt (epoch ms) when a human is on the clock. Tick the display locally each second.
function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const endsAt = state && state.turnEndsAt;
  if (!endsAt) { el.textContent = ''; el.classList.remove('low'); return; }
  const secs = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  el.textContent = secs + 's';
  el.classList.toggle('low', secs <= 5);
}
setInterval(updateClock, 500);

// ---- Intents to the server ----
function onCardClick(card) {
  socket.emit('play', { suit: card.suit, rank: card.rank });
}

document.querySelectorAll('.bid').forEach((btn) =>
  btn.addEventListener('click', () => socket.emit('bid', { level: selectedLevel, strain: btn.dataset.strain })));
document.getElementById('pass').addEventListener('click', () => socket.emit('pass'));
document.getElementById('dbl').addEventListener('click', () => socket.emit('double'));
document.getElementById('redbl').addEventListener('click', () => socket.emit('redouble'));
document.getElementById('new-deal').addEventListener('click', () => socket.emit('newDeal'));

// Seat controls: Sit / Leave / +Bot / -Bot buttons carry data-action and data-seat.
document.getElementById('table').addEventListener('click', (e) => {
  const b = e.target.closest('.seatbtn');
  if (!b) return;
  const { action, seat } = b.dataset;
  if (action === 'release') socket.emit('release');
  else if (action === 'claim') {
    if (!(state && state.loggedIn)) { openAuth(); return; } // must sign in to sit
    socket.emit('claim', seat);
  }
  else if (action === 'addBot') socket.emit('addBot', seat);
  else if (action === 'removeBot') socket.emit('removeBot', seat);
});

document.getElementById('reset-all').addEventListener('click', () => {
  if (confirm('Reset scores and start a new game? (keeps everyone in their seats)')) socket.emit('resetAll');
});
document.getElementById('leave-seat').addEventListener('click', () => socket.emit('release'));
document.getElementById('spectate').addEventListener('click', () => socket.emit('spectate', !(state && state.spectating)));
document.getElementById('bids-toggle').addEventListener('click', () => { bidsOpen = !bidsOpen; draw(); });
document.getElementById('bids-close').addEventListener('click', () => { bidsOpen = false; draw(); });

// ---- Drag-to-reorder suit chips (client-side hand ordering preference) ----
const SUIT_LABEL = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
const RED = new Set(['H', 'D']);
const suitOrderEl = document.getElementById('suit-order');
let dragSuit = null;

function buildSuitChips() {
  suitOrderEl.innerHTML = '';
  for (const suit of suitOrder) {
    const chip = document.createElement('span');
    chip.className = 'suit-chip ' + (RED.has(suit) ? 'red' : 'white');
    chip.textContent = SUIT_LABEL[suit];
    chip.draggable = true;
    chip.dataset.suit = suit;
    chip.addEventListener('dragstart', () => { dragSuit = suit; chip.classList.add('dragging'); });
    chip.addEventListener('dragend', () => { dragSuit = null; chip.classList.remove('dragging'); });
    chip.addEventListener('dragover', (e) => e.preventDefault());
    chip.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = chip.dataset.suit;
      if (!dragSuit || dragSuit === target) return;
      const next = suitOrder.filter((x) => x !== dragSuit);
      next.splice(next.indexOf(target), 0, dragSuit); // drop before the target
      suitOrder = next;
      localStorage.setItem('suitOrder', suitOrder.join(''));
      buildSuitChips();
      draw(); // re-sort the hand immediately
    });
    suitOrderEl.appendChild(chip);
  }
}
buildSuitChips();

// Card-size preference (client-side, persisted per browser). Scales the whole board via --card-scale.
const sizeInput = document.getElementById('card-size');
const savedScale = localStorage.getItem('cardScale') || '1';
document.documentElement.style.setProperty('--card-scale', savedScale);
sizeInput.value = savedScale;
sizeInput.addEventListener('input', () => {
  document.documentElement.style.setProperty('--card-scale', sizeInput.value);
  localStorage.setItem('cardScale', sizeInput.value);
});

// ---- Local view controls (no server involvement) ----
document.getElementById('level-up').addEventListener('click', () => { selectedLevel = Math.min(7, selectedLevel + 1); draw(); });
document.getElementById('level-down').addEventListener('click', () => { selectedLevel = Math.max(1, selectedLevel - 1); draw(); });
document.getElementById('sb-toggle').addEventListener('click', () => { scoreboardOpen = !scoreboardOpen; draw(); });
document.getElementById('sb-next').addEventListener('click', () => { scoreboardOpen = false; draw(); });

// ---- Accounts: auth bar, login/signup overlay ----
function openAuth() { const o = document.getElementById('auth-overlay'); if (o) o.hidden = false; }
function closeAuth() { const o = document.getElementById('auth-overlay'); if (o) o.hidden = true; }

function renderAuthBar() {
  const el = document.getElementById('auth-bar');
  if (!el || !state) return;
  el.innerHTML = state.loggedIn
    ? `${state.username} <button id="auth-logout">Logout</button>`
    : '<button id="auth-open">Log in</button>';
}

async function submitAuth(kind) {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/' + kind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { errEl.textContent = data.error || 'Something went wrong.'; return; }
    location.reload(); // reconnect the socket so its handshake carries the new session
  } catch {
    errEl.textContent = 'Network error.';
  }
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.reload();
}

// Delegated clicks for the auth bar (its buttons are re-rendered each state).
document.getElementById('auth-bar').addEventListener('click', (e) => {
  if (e.target.id === 'auth-open') openAuth();
  else if (e.target.id === 'auth-logout') logout();
});
document.getElementById('auth-login').addEventListener('click', () => submitAuth('login'));
document.getElementById('auth-signup').addEventListener('click', () => submitAuth('signup'));
document.getElementById('auth-close').addEventListener('click', closeAuth);
document.getElementById('auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth('login'); });
