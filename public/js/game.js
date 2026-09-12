// game.js - the bridge engine: dealing, the bidding auction, and trick play. Pure logic, no DOM.

import { deal } from './cards.js';

export const SEATS = ['N', 'E', 'S', 'W']; // clockwise order
export const PARTNERSHIPS = { N: 'NS', S: 'NS', E: 'EW', W: 'EW' };
export const STRAINS = ['C', 'D', 'H', 'S', 'NT']; // ascending within a level: clubs < diamonds < hearts < spades < no-trump

// Dealer rotates each deal. Starting at South means the human opens deal 1, then it goes clockwise.
const DEALER_ROTATION = ['S', 'W', 'N', 'E'];

export function newGame(round = 1) {
  const dealer = DEALER_ROTATION[(round - 1) % 4];
  return {
    hands: deal(),
    trump: null,               // set from the winning bid once the auction ends
    phase: 'bidding',          // 'bidding' | 'playing' | 'done' | 'passed-out'
    turn: dealer,              // the auction opens with the dealer
    dealer,                    // who dealt this hand
    bids: [],                  // auction history: { seat, pass:true } or { seat, level, strain }
    highestBid: null,          // { seat, level, strain }
    passes: 0,                 // consecutive passes
    doubled: 0,                // 0 none, 1 doubled, 2 redoubled (applies to the current highest bid)
    contract: null,            // { level, strain, declarer, doubled }
    currentTrick: [],          // array of { seat, card }
    leader: null,              // who leads the current trick
    tricksWon: { NS: 0, EW: 0 },
    trickCount: 0,
    dummy: null,               // declarer's partner; their hand is exposed and played by declarer
    dummyRevealed: false,      // flips true on the opening lead
    lastTrick: null,           // the most recently completed trick, kept for display: { plays, winner }
    vul: { NS: false, EW: false }, // set by main from the rubber standings (vulnerable after winning a game)
    round,                     // which deal this is; stamped onto each score-log entry
  };
}

// The seat clockwise after the given one.
export function nextSeat(seat) {
  return SEATS[(SEATS.indexOf(seat) + 1) % 4];
}

// ---- Bidding auction ----

// A single number that ranks any contract bid, so we can compare them. 1C is lowest, 7NT is highest.
export function bidRank(level, strain) {
  return (level - 1) * STRAINS.length + STRAINS.indexOf(strain);
}

// A contract bid is legal only if it strictly beats the current highest bid.
export function isLegalBid(game, level, strain) {
  if (game.phase !== 'bidding') return false;
  if (level < 1 || level > 7) return false;
  if (!game.highestBid) return true;
  return bidRank(level, strain) > bidRank(game.highestBid.level, game.highestBid.strain);
}

export function makeBid(game, seat, level, strain) {
  if (game.turn !== seat || !isLegalBid(game, level, strain)) return;
  game.bids.push({ seat, level, strain });
  game.highestBid = { seat, level, strain };
  game.doubled = 0; // a new contract bid clears any double
  game.passes = 0;
  advanceAuction(game);
}

// Double is legal against an opponent's current (undoubled) contract bid.
export function isLegalDouble(game, seat) {
  if (game.phase !== 'bidding' || !game.highestBid || game.doubled !== 0) return false;
  return PARTNERSHIPS[game.highestBid.seat] !== PARTNERSHIPS[seat];
}

// Redouble is legal when your side's contract has been doubled by an opponent.
export function isLegalRedouble(game, seat) {
  if (game.phase !== 'bidding' || !game.highestBid || game.doubled !== 1) return false;
  return PARTNERSHIPS[game.highestBid.seat] === PARTNERSHIPS[seat];
}

export function makeDouble(game, seat) {
  if (game.turn !== seat || !isLegalDouble(game, seat)) return;
  game.bids.push({ seat, double: true });
  game.doubled = 1;
  game.passes = 0;
  advanceAuction(game);
}

export function makeRedouble(game, seat) {
  if (game.turn !== seat || !isLegalRedouble(game, seat)) return;
  game.bids.push({ seat, redouble: true });
  game.doubled = 2;
  game.passes = 0;
  advanceAuction(game);
}

export function makePass(game, seat) {
  if (game.turn !== seat || game.phase !== 'bidding') return;
  game.bids.push({ seat, pass: true });
  game.passes += 1;
  advanceAuction(game);
}

function advanceAuction(game) {
  if (!game.highestBid && game.passes === 4) { game.phase = 'passed-out'; return; } // nobody bid
  if (game.highestBid && game.passes === 3) { finalizeContract(game); return; }     // three passes end it
  game.turn = nextSeat(game.turn);
}

function finalizeContract(game) {
  const { level, strain, seat } = game.highestBid;
  const side = PARTNERSHIPS[seat];
  // Declarer is the partner who FIRST named the winning strain, not necessarily the last bidder.
  let declarer = seat;
  for (const b of game.bids) {
    if (!b.pass && PARTNERSHIPS[b.seat] === side && b.strain === strain) { declarer = b.seat; break; }
  }
  game.contract = { level, strain, declarer, doubled: game.doubled };
  game.dummy = nextSeat(nextSeat(declarer));
  game.trump = strain;
  game.leader = nextSeat(declarer); // opening lead comes from the player to declarer's left
  game.turn = game.leader;
  game.phase = 'playing';
}

// ---- Trick play ----

function leadSuit(game) {
  return game.currentTrick.length ? game.currentTrick[0].card.suit : null;
}

// Legal if you are on lead, or you follow the led suit, or you are void in that suit.
export function isLegal(game, seat, card) {
  if (game.turn !== seat) return false;
  const led = leadSuit(game);
  if (!led) return true;
  if (card.suit === led) return true;
  return !game.hands[seat].some((c) => c.suit === led);
}

// Play one card. Returns the winning seat if this completed the trick, else null.
export function playCard(game, seat, card) {
  if (!isLegal(game, seat, card)) return null;
  const hand = game.hands[seat];
  hand.splice(hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank), 1);
  game.currentTrick.push({ seat, card });

  game.dummyRevealed = true; // dummy is exposed once the opening lead is played

  if (game.currentTrick.length < 4) {
    game.turn = nextSeat(seat);
    return null;
  }
  return resolveTrick(game);
}

function resolveTrick(game) {
  const led = game.currentTrick[0].card.suit;
  let best = game.currentTrick[0];
  for (const play of game.currentTrick) {
    const c = play.card, b = best.card;
    const cIsTrump = game.trump !== 'NT' && c.suit === game.trump;
    const bIsTrump = game.trump !== 'NT' && b.suit === game.trump;
    if (cIsTrump && !bIsTrump) { best = play; continue; } // any trump beats a non-trump
    if (!cIsTrump && bIsTrump) continue;                  // a non-trump cannot beat a trump
    const winningSuit = bIsTrump ? game.trump : led;
    if (c.suit === winningSuit && c.rank > b.rank) best = play;
  }
  game.tricksWon[PARTNERSHIPS[best.seat]] += 1;
  game.trickCount += 1;
  game.lastTrick = { plays: game.currentTrick.slice(), winner: best.seat }; // snapshot for display before clearing
  game.currentTrick = [];
  game.leader = best.seat;
  game.turn = best.seat;
  if (game.trickCount === 13) game.phase = 'done'; // scoring is done by main.js, which owns the log
  return best.seat;
}

// A trivial legal move for auto-played seats. Replace with real strategy later.
// Is this card a trump in the current contract?
function isTrump(game, card) {
  return game.trump !== 'NT' && card.suit === game.trump;
}

// The play currently winning the in-progress trick (same rule as resolveTrick), or null if empty.
function currentWinner(game) {
  if (game.currentTrick.length === 0) return null;
  const led = game.currentTrick[0].card.suit;
  let best = game.currentTrick[0];
  for (const play of game.currentTrick) {
    const c = play.card, b = best.card;
    const cT = isTrump(game, c), bT = isTrump(game, b);
    if (cT && !bT) { best = play; continue; }
    if (!cT && bT) continue;
    const winSuit = bT ? game.trump : led;
    if (c.suit === winSuit && c.rank > b.rank) best = play;
  }
  return best;
}

const lowestOf = (cards) => cards.reduce((lo, c) => (c.rank < lo.rank ? c : lo), cards[0]);

// A competent (not expert) card for an auto-played seat: win cheaply when it helps, save high cards
// when partner is winning, ruff opponents when void, and lead sensibly. Uses only this seat's own hand
// plus the public trick - no peeking at hidden hands.
export function pickAutoCard(game, seat) {
  const hand = game.hands[seat];
  const legal = hand.filter((c) => isLegal(game, seat, c));
  if (legal.length <= 1) return legal[0] || hand[0];

  // On lead: cash an ace if we have one, otherwise develop by leading low from our longest suit.
  if (game.currentTrick.length === 0) {
    const aces = legal.filter((c) => c.rank === 14);
    if (aces.length) return aces[0];
    const bySuit = {};
    for (const c of hand) (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
    let longest = null;
    for (const s in bySuit) if (!longest || bySuit[s].length > bySuit[longest].length) longest = s;
    const inLongest = legal.filter((c) => c.suit === longest);
    return lowestOf(inLongest.length ? inLongest : legal);
  }

  const led = game.currentTrick[0].card.suit;
  const winner = currentWinner(game);
  const partnerWinning = PARTNERSHIPS[winner.seat] === PARTNERSHIPS[seat];
  const followers = legal.filter((c) => c.suit === led);

  if (followers.length) {
    if (partnerWinning) return lowestOf(followers);          // partner has the trick; keep our high cards
    if (!isTrump(game, winner.card)) {                        // opponent winning with a plain card
      const beats = followers.filter((c) => c.rank > winner.card.rank);
      if (beats.length) return lowestOf(beats);               // win as cheaply as possible
    }
    return lowestOf(followers);                               // can't beat it; throw the lowest
  }

  // Void in the led suit: ruff to win if an opponent is ahead, otherwise discard low.
  const trumps = legal.filter((c) => isTrump(game, c));
  if (!partnerWinning && trumps.length) {
    if (!isTrump(game, winner.card)) return lowestOf(trumps); // ruff cheaply
    const over = trumps.filter((c) => c.rank > winner.card.rank);
    if (over.length) return lowestOf(over);                   // over-ruff cheaply
  }
  const nonTrump = legal.filter((c) => !isTrump(game, c));
  return lowestOf(nonTrump.length ? nonTrump : legal);        // discard low, keeping trumps
}

// function to allow declarer to control dummy hand
export function controllerOf(game, seat) {
  return seat === game.dummy ? game.contract.declarer : seat;
}
