// Card encoding must match the Rust engine exactly: card = rank * 4 + suit,
// rank 0..12 for 2..A, suit 0..3 for clubs/diamonds/hearts/spades.

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";

export type Card = number;

export const rankOf = (c: Card) => c >> 2;
export const suitOf = (c: Card) => c & 3;

export const cardName = (c: Card) => `${RANKS[rankOf(c)]}${SUITS[suitOf(c)]}`;

export const SUIT_GLYPH = ["♣", "♦", "♥", "♠"];
export const SUIT_VAR = ["var(--suit-c)", "var(--suit-d)", "var(--suit-h)", "var(--suit-s)"];

export function parseCard(s: string): Card {
  const r = RANKS.indexOf(s[0].toUpperCase());
  const su = SUITS.indexOf(s[1].toLowerCase());
  if (r < 0 || su < 0) throw new Error(`bad card: ${s}`);
  return r * 4 + su;
}

export const parseCards = (s: string): Card[] =>
  (s.match(/../g) ?? []).map(parseCard);

/** Canonical shorthand for a two-card hand: "AKs", "AKo", "TT". */
export function handLabel(a: Card, b: Card): string {
  const [hi, lo] = rankOf(a) >= rankOf(b) ? [a, b] : [b, a];
  const r1 = RANKS[rankOf(hi)];
  const r2 = RANKS[rankOf(lo)];
  if (rankOf(hi) === rankOf(lo)) return r1 + r2;
  return r1 + r2 + (suitOf(hi) === suitOf(lo) ? "s" : "o");
}

export const HAND_CATEGORIES = [
  "High card",
  "Pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush"
];

/** Mulberry32 — small, fast, and seedable so a drill can be replayed exactly. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw `n` distinct cards avoiding `dead`. */
export function draw(n: number, dead: Card[], rand: () => number): Card[] {
  const used = new Set(dead);
  const out: Card[] = [];
  while (out.length < n) {
    const c = Math.floor(rand() * 52);
    if (!used.has(c)) {
      used.add(c);
      out.push(c);
    }
  }
  return out;
}
