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
let scoreboardOpen = false; // local: is the popup showing
let seenRounds = 0;         // to auto-open the scoreboard when a deal finishes

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
  });
}

socket.on('connect', () => socket.emit('hello', clientId));

socket.on('state', (s) => {
  state = s;
  if (s.rounds.length > seenRounds) { scoreboardOpen = true; seenRounds = s.rounds.length; }
  if (s.rounds.length < seenRounds) seenRounds = s.rounds.length; // new rubber reset
  const leaveBtn = document.getElementById('leave-seat');
  if (leaveBtn) leaveBtn.disabled = !s.you; // only usable when you actually hold a seat
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
  else if (action === 'claim') socket.emit('claim', seat);
  else if (action === 'addBot') socket.emit('addBot', seat);
  else if (action === 'removeBot') socket.emit('removeBot', seat);
});

document.getElementById('reset-all').addEventListener('click', () => {
  if (confirm('Reset scores and start a new game? (keeps everyone in their seats)')) socket.emit('resetAll');
});
document.getElementById('leave-seat').addEventListener('click', () => socket.emit('release'));

// ---- Local view controls (no server involvement) ----
document.getElementById('level-up').addEventListener('click', () => { selectedLevel = Math.min(7, selectedLevel + 1); draw(); });
document.getElementById('level-down').addEventListener('click', () => { selectedLevel = Math.max(1, selectedLevel - 1); draw(); });
document.getElementById('sb-toggle').addEventListener('click', () => { scoreboardOpen = !scoreboardOpen; draw(); });
document.getElementById('sb-next').addEventListener('click', () => { scoreboardOpen = false; draw(); });
