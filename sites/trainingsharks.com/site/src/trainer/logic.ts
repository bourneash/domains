// Drill generation, bot behaviour, and scoring.
//
// Design rule for this file: every "correct answer" is something the engine
// computes from the range on screen, never a chart we made up. The audience
// does math for a living and will check.

import { draw, rng, type Card } from "../lib/cards";
import { equity, equityDetail } from "../lib/engine";
import { liveCombos, parseRange, type Archetype, type Combo } from "../lib/ranges";

export type Street = "flop" | "turn" | "river";
export const STREET_CARDS: Record<Street, number> = { flop: 3, turn: 4, river: 5 };

export type DrillKind = "equity" | "decision";

export interface Drill {
  kind: DrillKind;
  street: Street;
  hero: [Card, Card];
  board: Card[];
  villain: Archetype;
  /** Villain combos that survive card removal — what the answer is computed against. */
  range: Combo[];
  /** Hero equity vs that range, 0..1. */
  equity: number;
  win: number;
  tie: number;
  /** Chips already in the middle. */
  pot: number;
  /** What villain just bet (decision drills only). */
  bet: number;
  seed: number;
}

/** Break-even equity facing a bet of `bet` into a pot of `pot`. */
export const requiredEquity = (pot: number, bet: number) => bet / (pot + 2 * bet);

/** EV of calling, in chips, relative to folding (which is always 0). */
export const callEV = (eq: number, pot: number, bet: number) =>
  eq * (pot + bet) - (1 - eq) * bet;

const STREETS: Street[] = ["flop", "turn", "river"];

export function makeDrill(
  kind: DrillKind,
  villain: Archetype,
  seed: number,
  iters = 40000
): Drill {
  const rand = rng(seed);
  const street = STREETS[Math.floor(rand() * STREETS.length)];
  const hero = draw(2, [], rand) as [Card, Card];
  const board = draw(STREET_CARDS[street], hero, rand);

  const range = liveCombos(parseRange(villain.range), [...hero, ...board]);
  const detail = equityDetail(hero, board, range, iters, seed);

  // Pot and bet in big blinds, rounded to something a human would actually see.
  const pot = [8, 12, 16, 24, 32][Math.floor(rand() * 5)];
  const betFrac = [0.33, 0.5, 0.66, 0.75, 1.0][Math.floor(rand() * 5)];
  const bet = Math.round(pot * betFrac);

  return {
    kind,
    street,
    hero,
    board,
    villain,
    range,
    equity: detail.equity,
    win: detail.win,
    tie: detail.tie,
    pot,
    bet: Math.max(1, bet),
    seed
  };
}

export interface Verdict {
  correct: boolean;
  /** Chips of expected value given up by this answer. Zero when correct. */
  evLost: number;
  /** Short label for the leak tracker. */
  leak: string | null;
  headline: string;
  detail: string;
}

/** Grade an equity estimate. Tolerance widens with how close the spot is to a coin flip. */
export function gradeEquity(drill: Drill, guessPct: number): Verdict {
  const actual = drill.equity * 100;
  const err = guessPct - actual;
  const abs = Math.abs(err);
  const correct = abs <= 7;

  // Equity misreads cost money through the decisions they cause, so express
  // the miss as the EV of a call sized to the drill's own pot.
  const evLost = Math.abs(
    callEV(guessPct / 100, drill.pot, drill.bet) - callEV(drill.equity, drill.pot, drill.bet)
  );

  let leak: string | null = null;
  if (!correct) leak = err > 0 ? "Overestimates equity" : "Underestimates equity";

  return {
    correct,
    evLost: correct ? 0 : evLost,
    leak,
    headline: correct
      ? `Within ${abs.toFixed(1)} points — good read.`
      : `Off by ${abs.toFixed(1)} points.`,
    detail: `You have ${actual.toFixed(1)}% equity — winning ${(drill.win * 100).toFixed(1)}% and chopping ${(drill.tie * 100).toFixed(1)}% against ${drill.range.length} combos.`
  };
}

/** Grade a call/fold decision against the EV the engine computes. */
export function gradeDecision(drill: Drill, action: "call" | "fold"): Verdict {
  const need = requiredEquity(drill.pot, drill.bet);
  const ev = callEV(drill.equity, drill.pot, drill.bet);
  const shouldCall = ev > 0;
  const correct = (action === "call") === shouldCall;

  let leak: string | null = null;
  if (!correct) leak = action === "fold" ? "Folds too much" : "Calls too much";

  return {
    correct,
    evLost: correct ? 0 : Math.abs(ev),
    leak,
    headline: correct
      ? shouldCall
        ? `Call is right — it wins ${ev.toFixed(2)} bb.`
        : `Fold is right — calling loses ${Math.abs(ev).toFixed(2)} bb.`
      : shouldCall
        ? `Folding costs you ${ev.toFixed(2)} bb.`
        : `Calling costs you ${Math.abs(ev).toFixed(2)} bb.`,
    detail: `You need ${(need * 100).toFixed(1)}% to break even and you have ${(drill.equity * 100).toFixed(1)}%.`
  };
}

// --- Play mode -------------------------------------------------------------

export type PlayStage = "preflop" | "flop" | "turn" | "river" | "showdown";
const STAGE_CARDS: Record<PlayStage, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
  showdown: 5
};

export interface PlayState {
  stage: PlayStage;
  hero: [Card, Card];
  bot: [Card, Card];
  board: Card[];
  pot: number;
  /** Chips each side has put in on the current street. */
  committed: [number, number];
  heroStack: number;
  botStack: number;
  toAct: "hero" | "bot";
  /** Set once the hand is over. */
  result: null | { winner: "hero" | "bot" | "chop"; reason: string; delta: number };
  log: string[];
  seed: number;
}

export function newHand(villain: Archetype, seed: number, heroStack: number, botStack: number): PlayState {
  const rand = rng(seed);
  const hero = draw(2, [], rand) as [Card, Card];
  const bot = draw(2, hero, rand) as [Card, Card];
  const board = draw(5, [...hero, ...bot], rand);
  const blinds = 1.5;
  return {
    stage: "preflop",
    hero,
    bot,
    board,
    pot: blinds,
    committed: [0.5, 1],
    heroStack: heroStack - 0.5,
    botStack: botStack - 1,
    toAct: "hero",
    result: null,
    log: [`New hand vs ${villain.name}. Blinds posted.`],
    seed
  };
}

export const visibleBoard = (s: PlayState) => s.board.slice(0, STAGE_CARDS[s.stage]);

/**
 * Bot policy: pure equity thresholds plus a bluff frequency, deliberately
 * exploitable in the way the archetype advertises. This is not a solver and
 * does not pretend to be — the product value is that its leak is learnable.
 */
export function botAction(
  s: PlayState,
  villain: Archetype,
  facingBet: number,
  rand: () => number
): "check" | "bet" | "call" | "fold" {
  const board = visibleBoard(s);
  // The bot evaluates its own hand against a broad, neutral opposing range.
  const heroRange = liveCombos(
    parseRange(
      "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,KQs,KJs,QJs,JTs,T9s,98s,AKo,AQo,AJo,KQo"
    ),
    [...s.bot, ...board]
  );
  const eq = heroRange.length ? equity(s.bot, board, heroRange, 8000, s.seed + board.length) : 0.5;

  if (facingBet > 0) {
    const need = requiredEquity(s.pot, facingBet);
    if (eq >= Math.max(need, villain.callThreshold * 0.8)) return "call";
    return "fold";
  }
  if (eq >= villain.callThreshold + 0.08) return "bet";
  if (rand() < villain.bluffiness) return "bet";
  return "check";
}
