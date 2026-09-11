// rubber.js - rubber-bridge game and rubber tracking. Pure logic, no DOM, no other imports.
//
// WHAT YOU NEED TO KNOW:
// - Only contracted-trick points ("below the line") count toward a game. First side to 100 wins a game.
// - Winning a game draws a line: BOTH sides' below-the-line total resets to 0 for the next game.
// - The rubber goes to the first side to win two games: bonus 700 if the opponents won none, else 500.
// - A side is vulnerable once it has won a game.

const OTHER = { NS: 'EW', EW: 'NS' };

export function newRubber() {
  return {
    gamesWon: { NS: 0, EW: 0 },
    belowLine: { NS: 0, EW: 0 }, // trick points toward the CURRENT game only; resets each game
    gameNumber: 1,               // which game of the rubber is being played (1, 2, or 3)
    complete: false,
    winner: null,                // 'NS' | 'EW' once the rubber is decided
  };
}

// A side is vulnerable once it has won a game.
export function vulnerability(rubber) {
  return { NS: rubber.gamesWon.NS >= 1, EW: rubber.gamesWon.EW >= 1 };
}

// Add a made contract's below-the-line trick points to the declaring side and resolve any game/rubber win.
// Mutates rubber (it is owned by main). Returns { gameWon, rubberBonus, bonusSide }.
export function applyTrickPoints(rubber, declaringSide, trickPoints) {
  const result = { gameWon: null, rubberBonus: 0, bonusSide: null };
  if (rubber.complete || trickPoints <= 0) return result;

  rubber.belowLine[declaringSide] += trickPoints;
  if (rubber.belowLine[declaringSide] < 100) return result; // no game yet

  // Game won: draw a line, reset both sides below the line.
  rubber.gamesWon[declaringSide] += 1;
  rubber.belowLine = { NS: 0, EW: 0 };
  result.gameWon = declaringSide;

  if (rubber.gamesWon[declaringSide] === 2) {
    rubber.complete = true;
    rubber.winner = declaringSide;
    result.rubberBonus = rubber.gamesWon[OTHER[declaringSide]] === 0 ? 700 : 500;
    result.bonusSide = declaringSide;
  } else {
    rubber.gameNumber += 1;
  }
  return result;
}
