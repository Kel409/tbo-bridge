// ui.js - everything that touches the DOM. Rendering stays separate from rules.

import { SUIT_SYMBOLS, RANK_LABELS } from './cards.js';
import { SEATS, isLegal, isLegalBid, isLegalDouble, isLegalRedouble, controllerOf, PARTNERSHIPS } from './game.js';
import { subtotalsFor } from './scoring.js';

const RED_SUITS = new Set(['H', 'D']);
const RANK_WORDS = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const SUIT_WORDS = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
function rankText(card) { return RANK_LABELS[card.rank] || String(card.rank); }
function suitSymbol(card) { return SUIT_SYMBOLS[card.suit]; }
function colorClass(card) { return RED_SUITS.has(card.suit) ? 'red' : 'black'; }
function cardName(card) { return `${RANK_WORDS[card.rank] || card.rank} of ${SUIT_WORDS[card.suit]}`; }

// Fill a card element with a corner index (rank over suit) and a large center pip.
function paintFace(el, card) {
  el.classList.add('face', colorClass(card));
  el.setAttribute('aria-label', cardName(card)); // spoken name for screen readers
  const idx = document.createElement('span');
  idx.className = 'idx';
  idx.innerHTML = `<span class="r">${rankText(card)}</span><span class="s">${suitSymbol(card)}</span>`;
  const pip = document.createElement('span');
  pip.className = 'pip';
  pip.textContent = suitSymbol(card);
  el.append(idx, pip);
}

const SEAT_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };

// Set at the top of each render() so the drawing helpers know the viewer's perspective.
let MY_SEAT = null;      // which seat is "me" (null = spectator)
let SEAT_STATUS = null;  // { N:'empty'|'bot'|'you'|'taken', ... }
let SEAT_NAMES_MAP = null; // { N: username|null, ... } for occupied human seats
let SEAT_AVATARS = null;   // { N: url|null, ... }
let SEAT_CARDBACKS = null; // { N: url|null, ... } custom card backs
let SEAT_QUEUE = null;     // { N: count, ... } waiting counts (normal mode)
let YOU_QUEUED = null;     // seat the viewer is queued for, or null
let MY_OWNED = null;       // ranked: the seat the viewer owns this rubber
let RUBBER_ACTIVE = false; // ranked: all four seats owned (rubber underway)
const DEFAULT_AVATAR = '/img/default-avatar.png';
let POS = {};            // logical seat -> screen position ('top'|'bottom'|'left'|'right'), set each render
let SPECTATING = false;  // viewer chose to spectate (drives the button; not used for rendering)
let REVEAL_ALL = false;  // all hands visible right now (spectating, or the deal is over)
let LOCKED = false;      // viewer cannot claim a seat this deal
let SUIT_ORDER = ['S', 'H', 'D', 'C']; // viewer's preferred suit order for their own hand
let BIDS_OPEN = false;   // bid-order popup shown
let MODE = 'normal';     // 'normal' | 'ranked' (ranked hides the add-bot control)

const CW = ['N', 'E', 'S', 'W']; // clockwise
function nextCW(s) { return CW[(CW.indexOf(s) + 1) % 4]; }

// Rotate the table so the viewer sits at the bottom; others fill left, top, right going clockwise.
function positionsFor(mySeat) {
  const base = mySeat || 'S'; // spectator: standard South-at-bottom view
  const p = {};
  p[base] = 'bottom';
  p[nextCW(base)] = 'left';
  p[nextCW(nextCW(base))] = 'top';
  p[nextCW(nextCW(nextCW(base)))] = 'right';
  return p;
}

// Draw everything from current state. view carries UI-only state from main.js.
export function render(game, onHumanPlay, view) {
  MY_SEAT = view.mySeat ?? null;
  SEAT_STATUS = view.seats ?? null;
  SEAT_NAMES_MAP = view.seatNames ?? null;
  SEAT_AVATARS = view.seatAvatars ?? null;
  SEAT_CARDBACKS = view.seatCardBacks ?? null;
  SEAT_QUEUE = view.seatQueue ?? null;
  YOU_QUEUED = view.youQueued ?? null;
  MY_OWNED = view.myOwnedSeat ?? null;
  RUBBER_ACTIVE = !!view.rubberActive;
  SPECTATING = !!view.spectating;
  REVEAL_ALL = !!view.revealAll;
  LOCKED = !!view.locked;
  SUIT_ORDER = view.suitOrder || ['S', 'H', 'D', 'C'];
  BIDS_OPEN = !!view.bidsOpen;
  MODE = view.mode || 'normal';
  POS = positionsFor(MY_SEAT);
  for (const seat of SEATS) {
    const section = document.getElementById('seat-' + seat);
    if (section) section.className = 'seat pos-' + POS[seat]; // rotate this seat to its screen position
  }
  renderSpotlight(game);
  renderTrump(game);
  for (const seat of SEATS) renderHand(game, seat, onHumanPlay);
  renderSeatLabels(game);
  renderSeatControls();
  renderCalls(game);
  renderTrick(game);
  renderStatus(game);
  renderBidding(game, view.selectedLevel);
  renderAuction(game);
  renderScoreboard(view);
  renderBids(game);
}

// Light pool on whoever is to act (at their screen position), during bidding and play.
function renderSpotlight(game) {
  const el = document.getElementById('spotlight');
  if (!el) return;
  const active = (game.phase === 'bidding' || game.phase === 'playing') ? game.turn : null;
  el.className = active ? 'spot-' + POS[active] : '';
}

// Per-seat buttons: sit, leave, add or remove a bot. main.js emits the matching intent.
function renderSeatControls() {
  for (const seat of SEATS) {
    const el = document.getElementById('ctl-' + seat);
    if (!el) continue;
    const st = SEAT_STATUS ? SEAT_STATUS[seat] : 'empty';
    const btn = (action, label, title) => `<button class="seatbtn" data-action="${action}" data-seat="${seat}"${title ? ` title="${title}"` : ''}>${label}</button>`;
    const n = SEAT_QUEUE ? (SEAT_QUEUE[seat] || 0) : 0;
    const waiting = n ? ` <span class="queue-count">${n} waiting</span>` : '';

    if (MODE === 'ranked') {
      // Ranked: you own one seat for the rubber. Only your seat is actionable; before the rubber fills, open seats can be claimed.
      if (seat === MY_OWNED) {
        el.innerHTML = (st === 'you') ? btn('release', 'Leave') : btn('claim', 'Reclaim', 'Take your seat back from the bot');
      } else if (!MY_OWNED && !RUBBER_ACTIVE && st === 'empty' && !LOCKED) {
        el.innerHTML = btn('claim', 'Sit');
      } else {
        el.innerHTML = ''; // locked to someone else, or you're spectating this rubber
      }
      continue;
    }

    // Normal mode.
    if (st === 'you') { el.innerHTML = btn('release', 'Leave'); continue; }
    const queued = YOU_QUEUED === seat;
    const sitLabel = queued ? 'Queued \u2713' : 'Sit';
    const sitTitle = queued ? 'Waiting for this seat \u2014 click to stop'
      : (LOCKED ? 'Join the queue \u2014 you\u2019ll be seated next deal'
        : (st === 'taken' ? 'Occupied \u2014 click to wait for this seat' : ''));
    const sitBtn = btn('claim', sitLabel, sitTitle);
    if (st === 'bot') el.innerHTML = sitBtn + btn('removeBot', '\u2212 Bot') + waiting;
    else if (st === 'empty') el.innerHTML = sitBtn + btn('addBot', '+ Bot') + waiting;
    else el.innerHTML = sitBtn + waiting; // taken
  }
}

// Faint suit symbol in the center once the contract is set. NT shows text instead of a suit.
function renderTrump(game) {
  const el = document.getElementById('trump-emblem');
  if (!el) return;
  const shown = (game.phase === 'playing' || game.phase === 'done') && game.trump;
  if (!shown) { el.textContent = ''; el.className = ''; return; }
  if (game.trump === 'NT') { el.textContent = 'NT'; el.className = 'nt'; }
  else { el.textContent = SUIT_SYMBOLS[game.trump]; el.className = RED_SUITS.has(game.trump) ? 'red' : 'white'; }
}

// The most recent call each seat made, shown in front of them during the auction.
function renderCalls(game) {
  const auctionOn = game.phase === 'bidding';
  for (const seat of SEATS) {
    const el = document.getElementById('call-' + seat);
    if (!el) continue;
    if (!auctionOn) { el.innerHTML = ''; el.className = 'call'; continue; }
    const mine = game.bids.filter((b) => b.seat === seat); // every call this seat made, in order
    el.className = 'call';
    el.innerHTML = mine.map(callPill).join('');
  }
}

// One small pill for a single call.
function callPill(b) {
  if (b.pass) return '<span class="call-item pass">Pass</span>';
  if (b.double) return '<span class="call-item dbl">X</span>';
  if (b.redouble) return '<span class="call-item dbl">XX</span>';
  const sym = b.strain === 'NT' ? 'NT' : SUIT_SYMBOLS[b.strain];
  const color = (b.strain !== 'NT' && RED_SUITS.has(b.strain)) ? 'red' : 'white';
  return `<span class="call-item ${color}">${b.level}${sym}</span>`;
}

// Footer quick total, plus the popup panel with the rubber standing and per-deal history table.
function renderScoreboard(view) {
  const ns = subtotalsFor(view.log, 'NS');
  const ew = subtotalsFor(view.log, 'EW');
  const line = document.getElementById('scoreboard');
  if (line) line.textContent = `Game ${view.rubber.gameNumber}  |  NS ${ns.total}  vs  EW ${ew.total}`;

  const overlay = document.getElementById('sb-overlay');
  if (overlay) overlay.hidden = !view.scoreboardOpen;
  const content = document.getElementById('sb-content');
  if (content) content.innerHTML = buildScoreboardHTML(view.rounds, view.log, view.rubber);
}

function rubberHeaderHTML(rubber) {
  const games = `Games won &mdash; NS ${rubber.gamesWon.NS} &middot; EW ${rubber.gamesWon.EW}`;
  const status = rubber.complete
    ? `<strong>Rubber won by ${rubber.winner === 'NS' ? 'North-South' : 'East-West'}</strong>`
    : `Playing game ${rubber.gameNumber} &middot; toward game: NS ${rubber.belowLine.NS} &middot; EW ${rubber.belowLine.EW}`;
  return `<p class="sb-rubber">${games}<br>${status}</p>`;
}

function buildScoreboardHTML(rounds, log, rubber) {
  const header = rubberHeaderHTML(rubber);
  if (!rounds || rounds.length === 0) return header + '<p class="sb-empty">No completed deals yet.</p>';

  let gameNo = 1;
  const rows = [];
  rounds.forEach((r, idx) => {
    const result = r.made ? `made${r.diff > 0 ? ` +${r.diff}` : ''}` : `down ${-r.diff}`;
    const contract = r.passedOut ? 'Passed out' : `${r.contract} by ${r.declarer} (${result})`;
    const flag = r.gameWonBy ? ` \u2605 game to ${r.gameWonBy}` : '';
    rows.push(`<tr>
      <td>${r.round}</td>
      <td>${contract}${flag}</td>
      <td>${r.tricks.NS}\u2013${r.tricks.EW}</td>
      <td>${r.points.NS.game}</td><td>${r.points.NS.bonus}</td>
      <td>${r.points.EW.game}</td><td>${r.points.EW.bonus}</td>
    </tr>`);
    // A won game starts a fresh game next deal: mark the boundary so it's clear game points reset to 0.
    if (r.gameWonBy && idx < rounds.length - 1) {
      gameNo += 1;
      rows.push(`<tr class="sb-divider"><td colspan="7">\u2014 Game ${gameNo} \u00b7 game points reset to 0 \u2014</td></tr>`);
    }
  });
  const body = rows.join('');

  const ns = subtotalsFor(log, 'NS');
  const ew = subtotalsFor(log, 'EW');
  return header + `<table class="sb-table">
    <thead><tr><th>Deal</th><th>Contract</th><th>Tr</th><th>NS game</th><th>NS bonus</th><th>EW game</th><th>EW bonus</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot>
      <tr><td colspan="3">Subtotals</td><td>${ns.gamePoints}</td><td>${ns.bonusPoints}</td><td>${ew.gamePoints}</td><td>${ew.bonusPoints}</td></tr>
      <tr><td colspan="3">Total</td><td colspan="2">NS ${ns.total}</td><td colspan="2">EW ${ew.total}</td></tr>
    </tfoot>
  </table>`;
}

// Label each seat with its name, whether it is you, its occupant, and the dummy tag.
// Bot/open seats get a claim affordance; your seat can be released. main.js handles the clicks.
function renderSeatLabels(game) {
  for (const seat of SEATS) {
    const head = document.getElementById('head-' + seat);
    const who = SEAT_NAMES_MAP ? SEAT_NAMES_MAP[seat] : null;
    let label = SEAT_NAMES[seat];
    if (who) label += ' \u00b7 ' + who;
    if (seat === MY_SEAT) label += ' (you)';
    if (game.dummyRevealed && seat === game.dummy) label += ' \u2014 dummy';
    const av = SEAT_AVATARS ? SEAT_AVATARS[seat] : null;
    // Small avatar for a seated human (falls back to the default image on error or when absent).
    const img = who
      ? `<img class="seat-av" data-user="${who}" src="${av || DEFAULT_AVATAR}" alt="" title="View ${who}'s stats" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}'">`
      : '';
    head.innerHTML = img + label;
  }
}

function renderHand(game, seat, onHumanPlay) {
  const el = document.getElementById('hand-' + seat);
  const iAmDummy = MY_SEAT != null && game.dummy === MY_SEAT;
  const faceUp = REVEAL_ALL || seat === MY_SEAT || (game.dummyRevealed && seat === game.dummy)
    || (iAmDummy && game.contract && seat === game.contract.declarer); // as dummy, see your partner's hand
  el.className = 'hand ' + (faceUp ? 'spread' : 'stacked'); // spread = readable cascade, stacked = compact pile
  el.innerHTML = '';
  let cards = game.hands[seat];
  if (faceUp) cards = sortForDisplay(cards); // your suit order applies to every hand you can see (own, dummy, reveal)
  for (const card of cards) {
    const btn = document.createElement('button');
    btn.className = 'card';
    if (faceUp && !card.hidden) paintFace(btn, card);
    else {
      btn.classList.add('back'); // hidden hands stay face down
      btn.setAttribute('aria-label', 'face-down card');
      const cb = SEAT_CARDBACKS ? SEAT_CARDBACKS[seat] : null;
      if (cb) { btn.classList.add('custom-back'); btn.style.backgroundImage = `url("${cb}")`; } // this seat's custom back
    }
    const playable = game.phase === 'playing' && controllerOf(game, seat) === MY_SEAT && isLegal(game, seat, card);
    btn.disabled = !playable;
    if (playable) btn.addEventListener('click', () => onHumanPlay(card));
    el.appendChild(btn);
  }
}

// Order the viewer's own cards by their chosen suit order, then by rank high-to-low within a suit.
function sortForDisplay(cards) {
  const rank = {};
  SUIT_ORDER.forEach((s, i) => { rank[s] = i; });
  return cards.slice().sort((a, b) => (rank[a.suit] - rank[b.suit]) || (b.rank - a.rank));
}

function renderTrick(game) {
  const el = document.getElementById('trick');
  el.innerHTML = '';
  // Show the active trick, or the just-finished one during the pause before the next lead.
  const plays = game.currentTrick.length ? game.currentTrick : (game.lastTrick ? game.lastTrick.plays : []);
  plays.forEach((play, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot pos-' + POS[play.seat]; // land the card at that player's screen position
    const card = document.createElement('div');
    card.className = 'card';
    paintFace(card, play.card);
    if (i === plays.length - 1) card.classList.add('fly-' + POS[play.seat]); // newest card slides in from its side
    slot.appendChild(card);
    el.appendChild(slot);
  });
}

// Show and enable the bidding controls only while it is South's turn to bid.
function renderBidding(game, selectedLevel) {
  const panel = document.getElementById('bidding');
  const bidding = game.phase === 'bidding';
  panel.style.display = bidding ? '' : 'none';
  if (!bidding) return;
  document.getElementById('level').textContent = selectedLevel;
  const myTurn = game.turn === MY_SEAT;
  document.getElementById('pass').disabled = !myTurn;
  document.getElementById('dbl').disabled = !(myTurn && isLegalDouble(game, MY_SEAT));
  document.getElementById('redbl').disabled = !(myTurn && isLegalRedouble(game, MY_SEAT));
  document.querySelectorAll('.bid').forEach((btn) => {
    btn.disabled = !(myTurn && isLegalBid(game, selectedLevel, btn.dataset.strain));
  });
}

function dblTag(c) { return c && c.doubled === 2 ? ' XX' : (c && c.doubled === 1 ? ' X' : ''); }

function renderAuction(game) {
  const el = document.getElementById('auction');
  if (el) el.textContent = ''; // bid history removed from the top bar; see the Bids popup and status line
}

function vulLabel(vul) {
  if (vul.NS && vul.EW) return 'both';
  if (vul.NS) return 'NS';
  if (vul.EW) return 'EW';
  return 'none';
}

function renderStatus(game) {
  const el = document.getElementById('status');
  const vul = vulLabel(game.vul);
  // Paused: the seat on turn is empty (no human, no bot).
  if ((game.phase === 'bidding' || game.phase === 'playing') && SEAT_STATUS && SEAT_STATUS[game.turn] === 'empty') {
    el.textContent = `Waiting for ${SEAT_NAMES[game.turn]} \u2014 sit down or add a bot to that seat.`;
    return;
  }
  if (game.phase === 'bidding') {
    const hb = game.highestBid ? `${game.highestBid.level}${game.highestBid.strain} by ${game.highestBid.seat}` : 'none yet';
    el.textContent = `Deal ${game.round} bidding. Dealer ${game.dealer} | Vul ${vul} | Turn: ${SEAT_NAMES[game.turn]} | Highest: ${hb}`;
  } else if (game.phase === 'passed-out') {
    el.textContent = `Deal ${game.round} passed out, nobody bid. Press New Deal.`;
  } else if (game.phase === 'playing') {
    const c = game.contract;
    el.textContent = `Contract ${c.level}${c.strain}${dblTag(c)} by ${c.declarer} | Vul ${vul} | Turn: ${SEAT_NAMES[game.turn]} | NS ${game.tricksWon.NS} - EW ${game.tricksWon.EW}`;
  } else { // done
    const c = game.contract;
    const side = PARTNERSHIPS[c.declarer];
    const diff = game.tricksWon[side] - (c.level + 6); // tricks over or under the contract
    const result = diff >= 0 ? `made${diff > 0 ? ` +${diff}` : ''}` : `down ${-diff}`;
    el.textContent = `Deal ${game.round} done. ${c.level}${c.strain}${dblTag(c)} by ${c.declarer}: ${result}. Tricks NS ${game.tricksWon.NS} - EW ${game.tricksWon.EW}.`;
  }
}
// ---- Bid-order popup: the current deal's auction as a grid, dealer first, clockwise. ----
function renderBids(game) {
  const overlay = document.getElementById('bids-overlay');
  if (overlay) overlay.hidden = !BIDS_OPEN;
  const content = document.getElementById('bids-content');
  if (content) content.innerHTML = buildBidsHTML(game);
}

function bidCellHTML(b) {
  if (!b) return '<span class="bid-empty">&middot;</span>';
  if (b.pass) return '<span>Pass</span>';
  if (b.double) return '<span class="bid-x">X</span>';
  if (b.redouble) return '<span class="bid-x">XX</span>';
  const sym = b.strain === 'NT' ? 'NT' : SUIT_SYMBOLS[b.strain];
  const cls = (b.strain !== 'NT' && RED_SUITS.has(b.strain)) ? 'bid-red' : 'bid-white';
  return `<span class="${cls}">${b.level}${sym}</span>`;
}

function buildBidsHTML(game) {
  const bids = game.bids || [];
  if (!bids.length) return '<p class="sb-empty">No bids yet this deal.</p>';
  // Column order: dealer first, then clockwise. Bids were made in exactly that order.
  const order = [];
  let s = game.dealer || 'S';
  for (let i = 0; i < 4; i++) { order.push(s); s = CW[(CW.indexOf(s) + 1) % 4]; }
  const head = order.map((seat) => `<th>${SEAT_NAMES[seat]}${seat === game.dealer ? ' (dealer)' : ''}</th>`).join('');
  let body = '';
  for (let i = 0; i < bids.length; i += 4) {
    const rowCells = order.map((_, c) => `<td>${bidCellHTML(bids[i + c])}</td>`).join('');
    body += `<tr>${rowCells}</tr>`;
  }
  return `<table class="bid-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
