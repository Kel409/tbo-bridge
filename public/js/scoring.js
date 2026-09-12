// scoring.js - per-deal bridge scoring. Pure logic: no DOM, and no dependency on game.js, so it can be tested alone.
//
// WHAT YOU NEED TO KNOW:
// - Tricks needed to make a contract is level + 6 (a 1H contract needs 7 tricks, not 1).
// - Contracted-trick points are "below the line" (countsTowardGame true); rubber.js accumulates them toward games.
// - Overtricks and undertrick penalties are "above the line" (countsTowardGame false): bonus points.
// - Per-deal game/part-score bonuses do NOT exist in rubber. Game and rubber bonuses are handled by rubber.js.
// - All point values are POSITIVE. The team is what changes, never the sign.
// - Vulnerability changes only the undertrick penalty here. It does not change undoubled overtrick value.
// - NOT handled yet (all undoubled): doubling/redoubling, slam bonuses, and honors.

// ---- Rule constants (edit these in one place rather than sprinkling numbers through the code) ----
const MINOR_PER_TRICK = 20; // clubs, diamonds
const MAJOR_PER_TRICK = 30; // hearts, spades
const NT_FIRST = 40;        // no-trump: first contracted trick
const NT_EXTRA = 30;        // no-trump: each contracted trick after the first

const UNDERTRICK_NONVUL = 50;  // per undertrick, undoubled
const UNDERTRICK_VUL = 100;    // per undertrick, undoubled

// Which partnership a seat belongs to. Mirrors PARTNERSHIPS in game.js, kept local to avoid a circular import.
const SIDE = { N: 'NS', S: 'NS', E: 'EW', W: 'EW' };
const OTHER = { NS: 'EW', EW: 'NS' };

// Value of `tricks` contracted tricks in a strain (before any doubling multiplier).
function baseTrickValue(strain, tricks) {
  if (strain === 'C' || strain === 'D') return tricks * MINOR_PER_TRICK;
  if (strain === 'H' || strain === 'S') return tricks * MAJOR_PER_TRICK;
  return tricks === 0 ? 0 : NT_FIRST + (tricks - 1) * NT_EXTRA; // NT
}

// Contracted-trick points (below the line). Doubling doubles them, redoubling quadruples them.
function contractTrickValue(strain, level, doubled) {
  return baseTrickValue(strain, level) * (doubled === 0 ? 1 : doubled === 1 ? 2 : 4);
}

// Overtrick points (above the line), by doubling state and vulnerability.
function overtrickValue(strain, overtricks, vulnerable, doubled) {
  if (overtricks <= 0) return 0;
  if (doubled === 0) {
    const per = (strain === 'C' || strain === 'D') ? MINOR_PER_TRICK : MAJOR_PER_TRICK; // majors and NT are 30
    return overtricks * per;
  }
  const per = doubled === 1 ? (vulnerable ? 200 : 100) : (vulnerable ? 400 : 200); // doubled / redoubled
  return overtricks * per;
}

// Undertrick penalty (above the line, to the defenders).
function undertrickPenalty(undertricks, vulnerable, doubled) {
  if (doubled === 0) return undertricks * (vulnerable ? UNDERTRICK_VUL : UNDERTRICK_NONVUL);
  let total = 0;
  for (let i = 1; i <= undertricks; i++) {
    if (vulnerable) total += (i === 1) ? 200 : 300;
    else total += (i === 1) ? 100 : (i <= 3 ? 200 : 300);
  }
  return doubled === 2 ? total * 2 : total; // redoubled = doubled x2
}

// Pure numeric breakdown of one contract's result. Does not know or care which team scores it.
export function scoreContract(contract, declarerTricks, vulnerable) {
  const doubled = contract.doubled || 0;
  const requiredTricks = contract.level + 6;
  const tricksOver = declarerTricks - requiredTricks; // signed: positive = overtricks, negative = undertricks
  const made = tricksOver >= 0;

  if (!made) {
    const penaltyPoints = undertrickPenalty(Math.abs(tricksOver), vulnerable, doubled);
    return { made, tricksOver, contractPoints: 0, overtrickPoints: 0, insult: 0, penaltyPoints };
  }

  const contractPoints = contractTrickValue(contract.strain, contract.level, doubled);       // below the line
  const overtrickPoints = overtrickValue(contract.strain, tricksOver, vulnerable, doubled);   // above the line
  const insult = doubled === 1 ? 50 : doubled === 2 ? 100 : 0;                                 // bonus for making a (re)doubled contract
  return { made, tricksOver, contractPoints, overtrickPoints, insult, penaltyPoints: 0 };
}

// One row of the score log. countsTowardGame flags the game-points column (the 100 threshold).
function entry(round, team, type, label, points, countsTowardGame) {
  return { round, team, type, label, points, countsTowardGame };
}

// Turn a contract result into log rows, tagged with the round and the team that earns them.
// Made -> declaring side. Set -> defenders. Every returned points value is positive.
export function scoreHand(contract, declarerTricks, vulnerable, round) {
  const s = scoreContract(contract, declarerTricks, vulnerable);
  const declaringSide = SIDE[contract.declarer];
  const defendingSide = OTHER[declaringSide];
  const rows = [];

  if (s.made) {
    rows.push(entry(round, declaringSide, 'contract', 'Contract tricks', s.contractPoints, true)); // below the line
    if (s.overtrickPoints > 0) rows.push(entry(round, declaringSide, 'overtricks', 'Overtricks', s.overtrickPoints, false));
    if (s.insult > 0) rows.push(entry(round, declaringSide, 'insult', 'Doubled bonus', s.insult, false));
  } else {
    rows.push(entry(round, defendingSide, 'undertricks', 'Undertricks', s.penaltyPoints, false));
  }
  return rows;
}

// A bonus (above-the-line) log row, e.g. the rubber bonus that rubber.js reports.
export function extraBonusRow(round, team, label, points) {
  return entry(round, team, 'bonus', label, points, false);
}

// ---- Score log helpers. Totals are DERIVED from the log, never stored, so they cannot drift out of sync. ----

export function createLog() {
  return [];
}

export function addEvents(log, rows) {
  for (const row of rows) log.push(row);
  return log;
}

// Grand total for one team across every round.
export function totalFor(log, team) {
  return log.filter((e) => e.team === team).reduce((sum, e) => sum + e.points, 0);
}

// Game-points and bonus-points columns for one team, split by countsTowardGame.
export function subtotalsFor(log, team) {
  const rows = log.filter((e) => e.team === team);
  const gamePoints = rows.filter((e) => e.countsTowardGame).reduce((s, e) => s + e.points, 0);
  const bonusPoints = rows.filter((e) => !e.countsTowardGame).reduce((s, e) => s + e.points, 0);
  return { gamePoints, bonusPoints, total: gamePoints + bonusPoints };
}