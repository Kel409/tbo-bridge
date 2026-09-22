// main.js - build 2 online client. Owns no game state: it receives per-player snapshots and renders them,
// and it sends intents (claim/release a seat, bid, pass, play). The server validates everything.

import { render } from './ui.js';

// Landing vs game: '/' with no (or unknown) mode shows the home screen; ?mode=normal|ranked plays.
const rawMode = new URLSearchParams(location.search).get('mode');
const onHome = rawMode !== 'normal' && rawMode !== 'ranked';
const mode = rawMode === 'ranked' ? 'ranked' : 'normal';
document.getElementById('home').hidden = !onHome;
const socket = io({ query: { mode } }); // connect to this mode's room

// Title and the switch link.
const titleEl = document.getElementById('title');
if (titleEl) titleEl.textContent = mode === 'ranked' ? 'Bridge Ranked' : 'Bridge';
document.title = mode === 'ranked' ? 'Bridge Ranked' : 'Bridge';
const modeLink = document.getElementById('mode-link');
if (modeLink) {
  modeLink.textContent = mode === 'ranked' ? 'Play Normal' : 'Play Ranked';
  modeLink.href = mode === 'ranked' ? '?mode=normal' : '?mode=ranked';
}

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
let rubberWasComplete = false; // to detect a ranked rubber finishing (for stats refresh)
const TURN_SECONDS = 120; // matches the server; used to size the turn bar

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
    seatAvatars: state.seatAvatars,
    seatCardBacks: state.seatCardBacks,
    seatQueue: state.seatQueue,
    youQueued: state.youQueued,
    myOwnedSeat: state.myOwnedSeat,
    rubberActive: state.rubberActive,
    spectating: state.spectating,
    revealAll: state.revealAll,
    locked: state.locked,
    suitOrder,
    bidsOpen,
    mode,
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
  // After a ranked rubber is decided, the server updates records; refresh ours to show it.
  if (mode === 'ranked' && s.rubber && s.rubber.complete && !rubberWasComplete) refreshMe();
  rubberWasComplete = !!(s.rubber && s.rubber.complete);
  draw();
  updateClock();
});

// The server sends turnEndsAt (epoch ms) when a human is on the clock. Tick the display locally each second.
function updateClock() {
  const el = document.getElementById('clock');
  const bar = document.getElementById('turn-bar');
  const endsAt = state && state.turnEndsAt;
  if (!endsAt) {
    if (el) { el.textContent = ''; el.classList.remove('low'); }
    if (bar) bar.style.width = '0';
    return;
  }
  const remaining = Math.max(0, endsAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  if (el) { el.textContent = secs + 's'; el.classList.toggle('low', secs <= 5); }
  if (bar) bar.style.width = Math.min(100, (remaining / (TURN_SECONDS * 1000)) * 100) + '%'; // shrinks to 0
}
setInterval(updateClock, 400);

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
    if (mode === 'ranked' && !(state && state.loggedIn)) { openAuth(); return; } // ranked needs an account
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

async function submitAuth(kind) {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/' + kind, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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

document.getElementById('auth-login').addEventListener('click', () => submitAuth('login'));
document.getElementById('auth-signup').addEventListener('click', () => submitAuth('signup'));
document.getElementById('auth-close').addEventListener('click', closeAuth);
document.getElementById('auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth('login'); });

function renderAuthBar() {
  const el = document.getElementById('auth-bar');
  const avEl = document.getElementById('account-avatar');
  if (!el || !state) return;
  if (state.loggedIn) {
    const mod = myStats && myStats.isAdmin ? ' <button id="auth-mod">Moderate</button>' : '';
    el.innerHTML = `${state.username} <button id="profile-open">Profile</button>${mod}`;
    if (avEl) avEl.src = (myStats && myStats.avatar) || '/img/default-avatar.png';
  } else {
    el.innerHTML = '<button id="auth-open">Log in</button>';
    if (avEl) avEl.src = '/img/default-avatar.png';
  }
}

let myStats = null;
async function refreshMe() {
  try { myStats = await (await fetch('/api/me')).json(); renderAuthBar(); renderProfile(); renderHomeAuth(); } catch { /* ignore */ }
}
refreshMe();

// Home screen: auth line, the four options, and the leaderboard.
function renderHomeAuth() {
  const el = document.getElementById('home-auth');
  if (!el) return;
  el.innerHTML = (myStats && myStats.username != null)
    ? `Signed in as ${myStats.username} <button id="home-logout">Log out</button>`
    : `Playing as guest <button id="home-login">Log in</button>`;
}
document.getElementById('home-auth').addEventListener('click', (e) => {
  if (e.target.id === 'home-login') openAuth();
  else if (e.target.id === 'home-logout') logout();
});
document.getElementById('home-normal').addEventListener('click', () => { location.href = '?mode=normal'; });
document.getElementById('home-ranked').addEventListener('click', () => { location.href = '?mode=ranked'; });
document.getElementById('home-profile').addEventListener('click', () => {
  if (myStats && myStats.username != null) openProfile(); else openAuth();
});
document.getElementById('home-leaderboard').addEventListener('click', openLeaderboard);

async function openLeaderboard() {
  const overlay = document.getElementById('lb-overlay');
  const content = document.getElementById('lb-content');
  content.innerHTML = 'Loading\u2026';
  overlay.hidden = false;
  try {
    const data = await (await fetch('/api/leaderboard')).json();
    if (!data.players.length) { content.innerHTML = '<p class="sb-empty">No ranked results yet.</p>'; return; }
    const rows = data.players.map((p, i) => {
      const cls = p.points >= 0 ? 'pos' : 'neg';
      return `<tr><td>${i + 1}</td><td>${p.username}</td><td class="${cls}">${p.points}</td><td>${p.rubbersWon}-${p.rubbersLost}</td></tr>`;
    }).join('');
    content.innerHTML = `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Points</th><th>Rubbers</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch {
    content.innerHTML = '<p class="sb-empty">Could not load.</p>';
  }
}
document.getElementById('lb-close').addEventListener('click', () => { document.getElementById('lb-overlay').hidden = true; });

// Clicking the top-right avatar opens the profile (or login prompt).
document.getElementById('account-avatar').addEventListener('click', () => {
  if (state && state.loggedIn) openProfile(); else openAuth();
});

// Auth bar delegated clicks: Profile, Moderate (admin), Login.
document.getElementById('auth-bar').addEventListener('click', async (e) => {
  if (e.target.id === 'profile-open') openProfile();
  else if (e.target.id === 'auth-open') openAuth();
  else if (e.target.id === 'auth-mod') {
    const username = prompt('Moderate which username?');
    if (!username) return;
    const blocked = confirm(`OK = BLOCK ${username}'s images.  Cancel = UNBLOCK.`);
    try {
      await fetch('/api/admin/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, blocked }) });
    } catch { /* ignore */ }
  }
});

// ---- Profile popup: avatar + card back uploads, stats, match history, clear images, logout ----
function openProfile() { const o = document.getElementById('profile-overlay'); if (o) { o.hidden = false; renderProfile(); loadHistory(); } }
function closeProfile() { const o = document.getElementById('profile-overlay'); if (o) o.hidden = true; }

function renderProfile() {
  if (!myStats || myStats.username == null) return;
  document.getElementById('profile-name').textContent = myStats.username || 'Profile';
  document.getElementById('profile-avatar').src = myStats.avatar || '/img/default-avatar.png';
  const cardEl = document.getElementById('profile-cardback');
  if (cardEl) {
    if (myStats.cardBack) { cardEl.style.backgroundImage = `url("${myStats.cardBack}")`; cardEl.textContent = ''; }
    else { cardEl.style.backgroundImage = ''; cardEl.textContent = 'Card back'; }
  }
  // Big, centered points (the headline stat).
  const p = myStats.points >= 0 ? 'pos' : 'neg';
  const bigEl = document.getElementById('profile-points');
  if (bigEl) bigEl.innerHTML = `<span class="${p}">${myStats.points}</span><small>points</small>`;

  // A stat row: label + won-lost on the left, a proportion bar (won share) on the right.
  const row = (label, won, lost) => {
    const total = won + lost;
    const pct = total ? Math.round((won / total) * 100) : 0;
    return `<div class="stat-row">
      <span class="stat-label">${label} <b>${won}\u2013${lost}</b></span>
      <span class="stat-bar"><span class="stat-fill" style="width:${pct}%"></span></span>
    </div>`;
  };
  const avg = myStats.avgHcp == null ? '\u2014' : myStats.avgHcp;
  document.getElementById('profile-stats').innerHTML =
    row('Rubbers', myStats.rubbersWon, myStats.rubbersLost)
    + row('Contracts', myStats.contractsMade, myStats.contractsLost)
    + row('Defenses', myStats.defensesWon, myStats.defensesLost)
    + `<div class="stat-row"><span class="stat-label">Avg HCP / hand <b>${avg}</b></span></div>`;
}

async function uploadImage(endpoint, field, file) {
  const form = new FormData();
  form.append(field, file);
  try {
    const res = await fetch(endpoint, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || 'Upload failed.'); return; }
    await refreshMe();
    socket.emit('hello', clientId); // re-sync so seats show the new image
  } catch { alert('Upload failed.'); }
}

document.getElementById('profile-avatar').addEventListener('click', () => document.getElementById('avatar-input').click());
document.getElementById('profile-cardback').addEventListener('click', () => document.getElementById('cardback-input').click());
document.getElementById('avatar-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadImage('/api/avatar', 'avatar', f); });
document.getElementById('cardback-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadImage('/api/cardback', 'image', f); });
document.getElementById('profile-clear').addEventListener('click', async () => {
  if (!confirm('Remove your photo and card back?')) return;
  try { await fetch('/api/clear-images', { method: 'POST' }); await refreshMe(); socket.emit('hello', clientId); } catch { /* ignore */ }
});
document.getElementById('profile-logout').addEventListener('click', logout);
document.getElementById('profile-close').addEventListener('click', closeProfile);

// ---- Match history (rendered inside the Profile popup) ----
async function loadHistory() {
  const contentEl = document.getElementById('profile-history');
  if (!contentEl) return;
  if (!(myStats && myStats.username != null)) { contentEl.innerHTML = '<p class="sb-empty">Log in to see your match history.</p>'; return; }
  contentEl.innerHTML = 'Loading\u2026';
  try {
    const data = await (await fetch('/api/history')).json();
    contentEl.innerHTML = data.matches.length ? data.matches.map(matchHTML).join('') : '<p class="sb-empty">No ranked rubbers yet.</p>';
  } catch {
    contentEl.innerHTML = '<p class="sb-empty">Could not load history.</p>';
  }
}

// Side label: the two seated usernames if present, otherwise the compass seats.
function sideLabel(seats, a, b) {
  const na = seats[a] && seats[a].username;
  const nb = seats[b] && seats[b].username;
  const names = { N: 'North', E: 'East', S: 'South', W: 'West' };
  return `${na || names[a]} & ${nb || names[b]}`;
}

function matchHTML(m) {
  const when = new Date(m.created_at).toLocaleString();
  const nsWin = m.winner === 'NS';
  const ns = `<span class="${nsWin ? 'win' : ''}">${sideLabel(m.seats, 'N', 'S')} — ${m.ns_score}</span>`;
  const ew = `<span class="${!nsWin ? 'win' : ''}">${sideLabel(m.seats, 'E', 'W')} — ${m.ew_score}</span>`;
  const rows = (m.rounds || []).map((r) => {
    const result = r.passedOut ? 'Passed out' : `${r.contract} by ${r.declarer} (${r.made ? `made${r.diff > 0 ? ` +${r.diff}` : ''}` : `down ${-r.diff}`})`;
    return `<tr><td>${r.round}</td><td>${result}</td><td>${r.tricks.NS}\u2013${r.tricks.EW}</td>
      <td>${r.points.NS.game}</td><td>${r.points.NS.bonus}</td><td>${r.points.EW.game}</td><td>${r.points.EW.bonus}</td></tr>`;
  }).join('');
  return `<div class="match">
    <div class="match-head"><span>${ns}</span><span>${ew}</span></div>
    <div class="match-date">${when}</div>
    <table class="sb-table">
      <thead><tr><th>Deal</th><th>Contract</th><th>Tr</th><th>NS g</th><th>NS b</th><th>EW g</th><th>EW b</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ---- Colour scheme (client-side, persisted). Three primaries; the theme shades the rest. ----
const COLOR_DEFAULTS = { bg: '#111214', text: '#eaeaea', accent: '#C5283D' };
const COLOR_VARS = { bg: '--color-bg', text: '--color-text', accent: '--color-accent' };

function applyColors(c) {
  for (const k of Object.keys(COLOR_VARS)) {
    if (c && c[k]) document.documentElement.style.setProperty(COLOR_VARS[k], c[k]);
    else document.documentElement.style.removeProperty(COLOR_VARS[k]); // fall back to the CSS default
  }
}
function syncColorInputs(c) {
  document.getElementById('color-bg').value = c.bg;
  document.getElementById('color-text').value = c.text;
  document.getElementById('color-accent').value = c.accent;
}

let colorScheme;
try { colorScheme = JSON.parse(localStorage.getItem('colorScheme')) || { ...COLOR_DEFAULTS }; }
catch { colorScheme = { ...COLOR_DEFAULTS }; }
applyColors(colorScheme);
syncColorInputs(colorScheme);

function onColorChange(key, value) {
  colorScheme[key] = value;
  applyColors(colorScheme);
  localStorage.setItem('colorScheme', JSON.stringify(colorScheme));
}
document.getElementById('color-bg').addEventListener('input', (e) => onColorChange('bg', e.target.value));
document.getElementById('color-text').addEventListener('input', (e) => onColorChange('text', e.target.value));
document.getElementById('color-accent').addEventListener('input', (e) => onColorChange('accent', e.target.value));

document.getElementById('colors-reset').addEventListener('click', () => {
  colorScheme = { ...COLOR_DEFAULTS };
  localStorage.removeItem('colorScheme');
  applyColors(null);            // remove overrides -> the CSS :root defaults take over
  syncColorInputs(colorScheme);
});
document.getElementById('colors-toggle').addEventListener('click', () => { document.getElementById('colors-overlay').hidden = false; });
document.getElementById('colors-close').addEventListener('click', () => { document.getElementById('colors-overlay').hidden = true; });

// ---- View another player's stats by clicking their seat avatar ----
async function showPlayer(username) {
  const overlay = document.getElementById('player-overlay');
  const statsEl = document.getElementById('player-stats');
  document.getElementById('player-name').textContent = username;
  document.getElementById('player-avatar').src = '/img/default-avatar.png';
  statsEl.textContent = 'Loading\u2026';
  overlay.hidden = false;
  try {
    const res = await fetch('/api/user/' + encodeURIComponent(username));
    const u = await res.json();
    if (!res.ok) { statsEl.textContent = u.error || 'Could not load.'; return; }
    document.getElementById('player-avatar').src = u.avatar || '/img/default-avatar.png';
    const cls = u.points >= 0 ? 'pos' : 'neg';
    statsEl.innerHTML =
      `<span class="${cls}">${u.points} pts</span><br>`
      + `rubbers ${u.rubbersWon}-${u.rubbersLost}<br>`
      + `contracts ${u.contractsMade}-${u.contractsLost}<br>`
      + `defenses ${u.defensesWon}-${u.defensesLost}`;
  } catch {
    statsEl.textContent = 'Could not load.';
  }
}

// Delegated: clicking any seat avatar opens that player's stats.
document.getElementById('table').addEventListener('click', (e) => {
  const av = e.target.closest('.seat-av');
  if (av && av.dataset.user) showPlayer(av.dataset.user);
});
document.getElementById('player-close').addEventListener('click', () => { document.getElementById('player-overlay').hidden = true; });

// ---- Home: How to play (static) and Patch notes (live from GitHub commits) ----
const GITHUB_REPO = 'Kel409/tbo-bridge'; // public repo; read-only, no token

document.getElementById('home-help').addEventListener('click', () => { document.getElementById('help-overlay').hidden = false; });
document.getElementById('help-close').addEventListener('click', () => { document.getElementById('help-overlay').hidden = true; });

document.getElementById('home-notes').addEventListener('click', openNotes);
document.getElementById('notes-close').addEventListener('click', () => { document.getElementById('notes-overlay').hidden = true; });

let notesLoaded = false;
async function openNotes() {
  document.getElementById('notes-overlay').hidden = false;
  if (notesLoaded) return; // fetch once per page (GitHub rate-limits unauthenticated calls)
  const el = document.getElementById('notes-content');
  el.textContent = 'Loading\u2026';
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=20`);
    if (!res.ok) { el.innerHTML = '<p class="sb-empty">Could not load updates right now.</p>'; return; }
    const commits = await res.json();
    el.innerHTML = commits.map((c) => {
      const msg = (c.commit.message || '').split('\n')[0]; // first line only
      const when = new Date(c.commit.author.date).toLocaleDateString();
      const url = c.html_url;
      return `<div class="note"><div class="note-msg">${escapeHtml(msg)}</div>
        <div class="note-date">${when} \u00b7 <a href="${url}" target="_blank" rel="noopener">view</a></div></div>`;
    }).join('');
    notesLoaded = true;
  } catch {
    el.innerHTML = '<p class="sb-empty">Could not load updates right now.</p>';
  }
}

function escapeHtml(t) {
  return t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
