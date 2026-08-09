// Range shorthand -> concrete combos, and the villain archetypes the drills
// deal against.
//
// Every range here is a *stated assumption*, not a solved solution. The drills
// ask questions whose answers the engine computes exactly (equity, pot odds,
// EV) given the range on screen — so the player can always verify the answer,
// which matters a lot with an audience that does math for a living.

import { RANKS, type Card } from "./cards";

export type Combo = [Card, Card];

/** Expand "AA,KK,AKs,AQo,T9s" into concrete combos. */
export function parseRange(spec: string): Combo[] {
  const out: Combo[] = [];
  for (const raw of spec.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const r1 = RANKS.indexOf(tok[0].toUpperCase());
    const r2 = RANKS.indexOf(tok[1].toUpperCase());
    if (r1 < 0 || r2 < 0) throw new Error(`bad range token: ${tok}`);
    const suited = tok[2]?.toLowerCase() === "s";
    if (r1 === r2) {
      for (let s1 = 0; s1 < 4; s1++)
        for (let s2 = s1 + 1; s2 < 4; s2++) out.push([r1 * 4 + s1, r2 * 4 + s2]);
    } else if (suited) {
      for (let s = 0; s < 4; s++) out.push([r1 * 4 + s, r2 * 4 + s]);
    } else {
      for (let s1 = 0; s1 < 4; s1++)
        for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([r1 * 4 + s1, r2 * 4 + s2]);
    }
  }
  return out;
}

/** Drop combos that clash with cards already on the table. */
export const liveCombos = (range: Combo[], dead: Card[]): Combo[] => {
  const d = new Set(dead);
  return range.filter((c) => !d.has(c[0]) && !d.has(c[1]));
};

export interface Archetype {
  id: string;
  name: string;
  tagline: string;
  /** What this player's betting range looks like — the drill's stated premise. */
  range: string;
  /** How they behave, in plain language, for the coach panel. */
  reads: string;
  /** Equity threshold at which they continue vs a bet. Drives bot play. */
  callThreshold: number;
  /** How often they bet without a made hand. */
  bluffiness: number;
  accent: string;
}

/**
 * The roster. These are deliberately *exploitable* archetypes rather than
 * solver output: nobody makes money at low stakes by playing perfectly, they
 * make it by noticing that the player opposite them folds too much.
 */
export const ARCHETYPES: Archetype[] = [
  {
    id: "nit",
    name: "The Nit",
    tagline: "Folds until the nuts arrive",
    range: "AA,KK,QQ,JJ,TT,AKs,AQs,AKo",
    reads:
      "Bets only premium made hands and gives up everywhere else. Against a range this tight your bluffs print and your medium hands are worthless — attack the pots nobody wants, fold when they finally fight back.",
    callThreshold: 0.62,
    bluffiness: 0.03,
    accent: "#4d9df5"
  },
  {
    id: "station",
    name: "The Calling Station",
    tagline: "Never met a pair worth folding",
    range:
      "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,65s,AKo,AQo,AJo,ATo,KQo,KJo,QJo,JTo",
    reads:
      "Calls with any piece and almost never folds. Bluffing is lighting money on fire; the entire edge is value betting thinner and more often than feels comfortable.",
    callThreshold: 0.28,
    bluffiness: 0.02,
    accent: "#46c46b"
  },
  {
    id: "maniac",
    name: "The Maniac",
    tagline: "Aggression as a personality",
    range:
      "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,QJs,QTs,Q9s,JTs,J9s,T9s,T8s,98s,97s,87s,76s,65s,54s,AKo,AQo,AJo,ATo,A9o,KQo,KJo,KTo,QJo,QTo,JTo,T9o",
    reads:
      "Bets and raises with everything, so the betting tells you almost nothing. Stop folding good-but-not-great hands and let them bluff into you — patience is the counter, not counter-aggression.",
    callThreshold: 0.34,
    bluffiness: 0.42,
    accent: "#f2555a"
  },
  {
    id: "reg",
    name: "The Reg",
    tagline: "Solid, balanced, unbothered",
    range:
      "AA,KK,QQ,JJ,TT,99,88,77,66,55,AKs,AQs,AJs,ATs,A5s,A4s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,AKo,AQo,AJo,KQo",
    reads:
      "A competent, roughly balanced range with real bluffs and real value. There is no free money here — this one is about not making mistakes rather than punishing theirs.",
    callThreshold: 0.5,
    bluffiness: 0.22,
    accent: "#4fd1c5"
  }
];

export const archetypeById = (id: string): Archetype =>
  ARCHETYPES.find((a) => a.id === id) ?? ARCHETYPES[3];
