// Loader and typed wrapper for the Rust poker engine.
//
// The module is raw extern "C" with no wasm-bindgen glue, so everything that
// crosses the boundary is bytes in linear memory. That keeps the payload at
// ~75 KB and means there is no generated JS to drift out of sync — but it does
// mean every pointer here has to be freed by hand.

import type { Card } from "./cards";

interface Exports {
  memory: WebAssembly.Memory;
  ps_alloc(len: number): number;
  ps_free(ptr: number, len: number): void;
  ps_equity(
    hero: number,
    board: number,
    boardLen: number,
    range: number,
    rangeN: number,
    iters: number,
    seed: number
  ): number;
  ps_range_equity(
    hero: number,
    heroN: number,
    board: number,
    boardLen: number,
    range: number,
    rangeN: number,
    iters: number,
    seed: number
  ): number;
  ps_eval(ptr: number, len: number): number;
  ps_category(ptr: number, len: number): number;
  ps_equity_detail(
    hero: number,
    board: number,
    boardLen: number,
    range: number,
    rangeN: number,
    iters: number,
    seed: number,
    out: number
  ): void;
}

let mod: Exports | null = null;
let loading: Promise<Exports> | null = null;

export function engineReady(): boolean {
  return mod !== null;
}

export async function loadEngine(): Promise<Exports> {
  if (mod) return mod;
  if (!loading) {
    loading = WebAssembly.instantiateStreaming(fetch("/engine/poker_engine.wasm"), {})
      .catch(async () => {
        // instantiateStreaming needs the right Content-Type; fall back rather
        // than dying if a dev server or proxy serves it as octet-stream.
        const bytes = await fetch("/engine/poker_engine.wasm").then((r) => r.arrayBuffer());
        return WebAssembly.instantiate(bytes, {});
      })
      .then((r) => {
        mod = r.instance.exports as unknown as Exports;
        return mod;
      });
  }
  return loading;
}

/** Copy bytes in, run `fn`, always free. */
function withBytes<T>(m: Exports, arrays: number[][], fn: (ptrs: number[]) => T): T {
  const ptrs: number[] = [];
  try {
    for (const a of arrays) {
      const len = Math.max(a.length, 1);
      const p = m.ps_alloc(len);
      new Uint8Array(m.memory.buffer, p, len).set(a.length ? a : [0]);
      ptrs.push(p);
    }
    return fn(ptrs);
  } finally {
    ptrs.forEach((p, i) => m.ps_free(p, Math.max(arrays[i].length, 1)));
  }
}

/**
 * Equity of one hand against a range of combos, ties counted as half —
 * the convention every equity calculator reports.
 */
export function equity(
  hero: [Card, Card],
  board: Card[],
  villainRange: [Card, Card][],
  iters = 40000,
  seed = 1
): number {
  const m = mod;
  if (!m) throw new Error("engine not loaded");
  const flat = villainRange.flat();
  return withBytes(m, [hero, board, flat], ([h, b, r]) =>
    m.ps_equity(h, b, board.length, r, villainRange.length, iters, seed)
  );
}

export interface EquityDetail {
  win: number;
  tie: number;
  equity: number;
}

export function equityDetail(
  hero: [Card, Card],
  board: Card[],
  villainRange: [Card, Card][],
  iters = 40000,
  seed = 1
): EquityDetail {
  const m = mod;
  if (!m) throw new Error("engine not loaded");
  const flat = villainRange.flat();
  const out = m.ps_alloc(24);
  try {
    return withBytes(m, [hero, board, flat], ([h, b, r]) => {
      m.ps_equity_detail(h, b, board.length, r, villainRange.length, iters, seed, out);
      const f = new Float64Array(m.memory.buffer, out, 3);
      return { win: f[0], tie: f[1], equity: f[2] };
    });
  } finally {
    m.ps_free(out, 24);
  }
}

/** Range-vs-range equity, for board-texture questions. */
export function rangeEquity(
  heroRange: [Card, Card][],
  board: Card[],
  villainRange: [Card, Card][],
  iters = 40000,
  seed = 1
): number {
  const m = mod;
  if (!m) throw new Error("engine not loaded");
  return withBytes(m, [heroRange.flat(), board, villainRange.flat()], ([hr, b, r]) =>
    m.ps_range_equity(hr, heroRange.length, b, board.length, r, villainRange.length, iters, seed)
  );
}

/** Made-hand category index, 0 = high card … 8 = straight flush. */
export function category(cards: Card[]): number {
  const m = mod;
  if (!m) throw new Error("engine not loaded");
  return withBytes(m, [cards], ([p]) => m.ps_category(p, cards.length));
}

/** Comparable strength score. Only meaningful against another score. */
export function strength(cards: Card[]): number {
  const m = mod;
  if (!m) throw new Error("engine not loaded");
  return withBytes(m, [cards], ([p]) => m.ps_eval(p, cards.length));
}
