// cards.js - the deck and card model. Nothing here knows the rules of bridge.

export const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J 12=Q 13=K 14=A

// Human-readable pieces used when drawing a card.
export const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export const SUIT_SYMBOLS = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };

// A card is a plain object. Keeping the data dumb makes it trivial to send over a network later.
export function makeCard(suit, rank) {
  return { suit, rank };
}

export function cardLabel(card) {
  const rank = RANK_LABELS[card.rank] || String(card.rank);
  return rank + SUIT_SYMBOLS[card.suit];
}

// Build an ordered 52-card deck.
export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(makeCard(suit, rank));
    }
  }
  return deck;
}

// Fisher-Yates shuffle. This is the correct unbiased shuffle. Do not replace it with sort(() => Math.random()).
export function shuffle(deck) {
  const copy = deck.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Deal 13 cards to each seat in clockwise order.
export function deal() {
  const deck = shuffle(buildDeck());
  const hands = { N: [], E: [], S: [], W: [] };
  const seats = ['N', 'E', 'S', 'W'];
  deck.forEach((card, i) => {
    hands[seats[i % 4]].push(card);
  });
  for (const seat of seats) sortHand(hands[seat]);
  return hands;
}

// Sort a hand by suit then rank so it reads like a real fanned hand.
export function sortHand(hand) {
  const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
  hand.sort((a, b) => suitOrder[a.suit] - suitOrder[b.suit] || b.rank - a.rank);
  return hand;
}