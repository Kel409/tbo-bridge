// ui.js - everything that touches the DOM. Rendering stays separate from rules.

import { SUIT_SYMBOLS, RANK_LABELS } from './cards.js';
import { SEATS, isLegal, isLegalBid, controllerOf, PARTNERSHIPS } from './game.js';
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
  idx.innerHTML = rankText(card) + '<br>' + suitSymbol(card);
  const pip = document.createElement('span');
  pip.className = 'pip';
  pip.textContent = suitSymbol(card);
  el.append(idx, pip);
}

const SEAT_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };

// Set at the top of each render() so the drawing helpers know the viewer's perspective.
let MY_SEAT = null;      // which seat is "me" (null = spectator)
let SEAT_STATUS = null;  // { N:'empty'|'bot'|'you'|'taken', ... }
let POS = {};            // logical seat -> screen position ('top'|'bottom'|'left'|'right'), set each render

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
    const btn = (action, label) => `<button class="seatbtn" data-action="${action}" data-seat="${seat}">${label}</button>`;
    if (st === 'you') el.innerHTML = btn('release', 'Leave');
    else if (st === 'taken') el.innerHTML = '';
    else if (st === 'bot') el.innerHTML = btn('claim', 'Sit') + btn('removeBot', '\u2212 Bot');
    else el.innerHTML = btn('claim', 'Sit') + btn('addBot', '+ Bot'); // empty
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
    const call = auctionOn ? lastCall(game, seat) : null;
    if (!call) { el.textContent = ''; el.style.visibility = 'hidden'; el.className = 'call'; continue; }
    el.style.visibility = 'visible';
    if (call.pass) { el.textContent = 'Pass'; el.className = 'call pass'; }
    else {
      el.textContent = `${call.level}${call.strain === 'NT' ? 'NT' : SUIT_SYMBOLS[call.strain]}`;
      el.className = 'call ' + (call.strain !== 'NT' && RED_SUITS.has(call.strain) ? 'red' : 'white');
    }
  }
}

function lastCall(game, seat) {
  for (let i = game.bids.length - 1; i >= 0; i--) if (game.bids[i].seat === seat) return game.bids[i];
  return null;
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

  const body = rounds.map((r) => {
    const result = r.made ? `made${r.diff > 0 ? ` +${r.diff}` : ''}` : `down ${-r.diff}`;
    const contract = r.passedOut ? 'Passed out' : `${r.contract} by ${r.declarer} (${result})`;
    const flag = r.gameWonBy ? ` \u2605 game to ${r.gameWonBy}` : '';
    return `<tr>
      <td>${r.round}</td>
      <td>${contract}${flag}</td>
      <td>${r.tricks.NS}\u2013${r.tricks.EW}</td>
      <td>${r.points.NS.game}</td><td>${r.points.NS.bonus}</td>
      <td>${r.points.EW.game}</td><td>${r.points.EW.bonus}</td>
    </tr>`;
  }).join('');

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
    let label = SEAT_NAMES[seat];
    if (seat === MY_SEAT) label += ' (you)';
    if (game.dummyRevealed && seat === game.dummy) label += ' \u2014 dummy';
    head.textContent = label;
  }
}

function renderHand(game, seat, onHumanPlay) {
  const el = document.getElementById('hand-' + seat);
  const faceUp = seat === MY_SEAT || (game.dummyRevealed && seat === game.dummy);
  el.className = 'hand ' + (faceUp ? 'spread' : 'stacked'); // spread = readable cascade, stacked = compact pile
  el.innerHTML = '';
  for (const card of game.hands[seat]) {
    const btn = document.createElement('button');
    btn.className = 'card';
    if (faceUp) paintFace(btn, card);
    else { btn.classList.add('back'); btn.setAttribute('aria-label', 'face-down card'); } // opponents stay face down
    const playable = game.phase === 'playing' && controllerOf(game, seat) === MY_SEAT && isLegal(game, seat, card);
    btn.disabled = !playable;
    if (playable) btn.addEventListener('click', () => onHumanPlay(card));
    el.appendChild(btn);
  }
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
  document.querySelectorAll('.bid').forEach((btn) => {
    btn.disabled = !(myTurn && isLegalBid(game, selectedLevel, btn.dataset.strain));
  });
}

function renderAuction(game) {
  const el = document.getElementById('auction');
  const parts = game.bids.map((b) => (b.pass ? `${b.seat}: Pass` : `${b.seat}: ${b.level}${b.strain}`));
  let line = parts.join('   ');
  if (game.contract) line += `   |   Contract ${game.contract.level}${game.contract.strain} by ${game.contract.declarer}`;
  el.textContent = line;
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
    el.textContent = `Contract ${c.level}${c.strain} by ${c.declarer} | Vul ${vul} | Turn: ${SEAT_NAMES[game.turn]} | NS ${game.tricksWon.NS} - EW ${game.tricksWon.EW}`;
  } else { // done
    const c = game.contract;
    const side = PARTNERSHIPS[c.declarer];
    const diff = game.tricksWon[side] - (c.level + 6); // tricks over or under the contract
    const result = diff >= 0 ? `made${diff > 0 ? ` +${diff}` : ''}` : `down ${-diff}`;
    el.textContent = `Deal ${game.round} done. ${c.level}${c.strain} by ${c.declarer}: ${result}. Tricks NS ${game.tricksWon.NS} - EW ${game.tricksWon.EW}.`;
  }
}