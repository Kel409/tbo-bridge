// bidding-ai.js - a simplified natural bidding bot. Pure logic, no DOM.
//
// WHAT YOU NEED TO KNOW:
// - This is NOT real bridge bidding. It counts high-card points (A=4, K=3, Q=2, J=1) and a longest suit,
//   then opens / responds / overcalls with the lowest legal bid toward a sensible strain, capped by strength.
// - It always returns a LEGAL bid (checked against the auction) or null to pass, and the auction always
//   terminates because bids must strictly rise and a strength ceiling stops runaway escalation.
// - South is the human, so this only ever chooses for the three bots.

import { PARTNERSHIPS, isLegalBid } from './game.js';

const HCP = { 11: 1, 12: 2, 13: 3, 14: 4 }; // J, Q, K, A
const PARTNER = { N: 'S', S: 'N', E: 'W', W: 'E' };
const SUIT_ORDER = ['S', 'H', 'D', 'C']; // for tie-breaking the longest suit (higher ranking wins ties)

function evaluate(hand) {
  const len = { S: 0, H: 0, D: 0, C: 0 };
  let hcp = 0;
  for (const c of hand) {
    len[c.suit] += 1;
    hcp += HCP[c.rank] || 0;
  }
  let longest = 'S';
  for (const s of SUIT_ORDER) if (len[s] > len[longest]) longest = s;
  const vals = Object.values(len);
  const balanced = !vals.some((v) => v < 2) && !vals.some((v) => v >= 6); // 4333 / 4432 / 5332
  return { hcp, len, longest, balanced };
}

// Partner's most recent suit bid, or null if partner has only passed.
function partnerLastBid(game, seat) {
  const partner = PARTNER[seat];
  for (let i = game.bids.length - 1; i >= 0; i--) {
    const b = game.bids[i];
    if (!b.pass && b.seat === partner) return b;
  }
  return null;
}

function sideHasBid(game, side) {
  return game.bids.some((b) => !b.pass && PARTNERSHIPS[b.seat] === side);
}

// Highest contract level this strength should reach. The loop below still bids the LOWEST legal step,
// so this only caps how high a bot will go when the auction is pushed up.
function levelCeiling(points, strain) {
  if (points >= 37) return 7;
  if (points >= 33) return 6;                                   // small slam values
  if (points >= 26) return strain === 'NT' ? 3 : (strain === 'C' || strain === 'D' ? 5 : 4); // game
  if (points >= 23) return 3;
  if (points >= 20) return 2;
  return 1;
}

// Decide a bid for the seat on turn. Returns { level, strain } or null to pass.
export function chooseBid(game, seat) {
  const ev = evaluate(game.hands[seat]);
  const side = PARTNERSHIPS[seat];
  const oppSide = side === 'NS' ? 'EW' : 'NS';
  const partnerBid = partnerLastBid(game, seat);
  const oppsBid = sideHasBid(game, oppSide);

  let strain;
  let points = ev.hcp;

  if (partnerBid) {
    // Partner has shown values: support them, show our own suit, or bid notrump.
    points += 13; // assume partner holds about an opening hand
    if (ev.len[partnerBid.strain] >= 3 && ev.hcp >= 6) strain = partnerBid.strain; // raise the fit
    else if (ev.hcp >= 6 && ev.len[ev.longest] >= 5 && ev.longest !== partnerBid.strain) strain = ev.longest; // new suit
    else if (ev.balanced && ev.hcp >= 8) strain = 'NT';
    else return null;
  } else if (!oppsBid) {
    // Opening decision, nobody has bid yet.
    if (ev.hcp < 12) return null;
    strain = (ev.balanced && ev.hcp >= 15 && ev.hcp <= 17) ? 'NT' : ev.longest;
  } else {
    // Opponents opened and partner is silent: overcall only with real values and a long suit.
    if (ev.hcp >= 11 && ev.len[ev.longest] >= 5) strain = ev.longest;
    else if (ev.balanced && ev.hcp >= 15) strain = 'NT';
    else return null;
  }

  const ceiling = levelCeiling(points, strain);
  for (let level = 1; level <= ceiling; level++) {
    if (isLegalBid(game, level, strain)) return { level, strain };
  }
  return null; // nothing legal within our strength: pass
}
