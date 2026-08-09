# poker-engine prototype — results

Purpose: prove or kill the technical assumptions behind the TrainingSharks.com
plan before spending the domain on it. Three questions:

1. Is equity/evaluation fast enough to run in a browser in real time?
2. Does a preflop strategy table fit in a shippable payload?
3. Is precomputing postflop solutions offline cheap enough to build a library?

Machine: Linux x86_64, Rust 1.94.1, Node 23.7 (V8 — the same engine Chrome runs,
so the wasm numbers transfer to the browser).

## 1. Correctness first

The evaluator is fuzzed against a deliberately naive reference (best of all 21
five-card subsets, sharing no code with the fast path):

| Test | Cases | Mismatches |
|---|---|---|
| Random independent hands | 200,000 pairs | 0 |
| Shared five-card board (the only case producing real ties) | 200,000 pairs | 0 |

Cross-check: averaged over all 36 AA-vs-KK suit pairings, exhaustively
enumerating all 1,712,304 boards each, the engine returns **81.946%** — the
canonical figure every equity calculator agrees on. AKs vs QQ returns 46.21%.

Two notes worth keeping, because both cost time here:
- My recalled "82.36%" for AA vs KK was wrong; the engine was right. Poker
  constants get checked against the reference implementation, not memory.
- Individual suit pairings legitimately differ from the all-combos average
  (AsAh vs KsKh is 82.64%). Shared suits give the aces *more* equity because
  they block the kings' flush outs.

## 2. Speed — native vs wasm

| Workload | Native | wasm (Node/V8) | wasm tax |
|---|---|---|---|
| 7-card evaluations | 11.2M/sec | 9.41M/sec | 16% |
| MC equity, hand vs hand | 7.8M trials/sec | 5.67M trials/sec | 27% |
| MC equity, range vs range | 4.4M trials/sec | 2.41M trials/sec | 45% |
| River CFR iterations | 25,200/sec | 15,500/sec | 38% |

**A 10,000-trial equity estimate takes 1.76ms in wasm.** That is comfortably
inside a single animation frame — real-time coach overlays are not a problem.
Exhaustive enumeration of all 1.7M rivers for a preflop matchup takes 0.15s
natively, so exact answers are viable server-side and for precompute.

Wasm module: **71.8 KB**, no wasm-bindgen, no threads. Because nothing here
needs `SharedArrayBuffer`, the COOP/COEP header dance that 0xroulette needs
does **not** apply at this stage.

Determinism holds across targets: native and wasm return bit-identical results
from the same seed (`462138`). Precomputed tables and client-side checks will
agree, and benchmarks are reproducible.

## 3. The preflop table does not fit — this is the real finding

Storage = decision nodes × 169 canonical hands × actions × 1 byte (frequencies
quantised to u8).

| Configuration | Decision nodes | Table size |
|---|---|---|
| 6-max, 2 raise sizes, cap 2 | 20,474 | **7.01 MB** |
| 6-max, 2 raise sizes, cap 3 | 287,370 | 99.23 MB |
| 6-max, 3 raise sizes, cap 3 | 945,860 | 326.69 MB |
| 6-max, 3 raise sizes, cap 4 | 18,072,662 | 6.14 GB |
| 6-max, 4 raise sizes, cap 4 | 56,343,622 | 19.13 GB |
| **Heads-up, 3 raise sizes, cap 4** | 242 | **119.5 KB** |

The plan assumed "preflop compresses to a few MB and ships with the app." That
is true only for a deliberately narrow tree. Consequences:

- **Heads-up preflop ships entirely client-side, trivially.** 119 KB.
- **6-max ships only at 2 raise sizes and a 2-raise cap** (7 MB — acceptable as
  a lazy-loaded asset). That covers open / 3-bet / call / fold, which is exactly
  the decision set the beginner-to-intermediate target audience needs.
- Anything richer (4-bet/5-bet wars, multiple sizings) must be a **server-side
  lookup**, not a client payload.

This is a scope decision, not a blocker — but it has to be made deliberately,
and it argues for the narrow v1.

## 4. Postflop precompute is cheap

A full river subgame, solved exactly — no bucketing, no sampling, full
card-removal correction, 1081-combo ranges on both sides:

| Iterations | Exploitability (chips/hand) | % of pot |
|---|---|---|
| 50 | 0.742 | 3.709% |
| 250 | 0.179 | 0.897% |
| 1,000 | 0.068 | 0.338% |
| 4,000 | 0.023 | 0.115% |
| 10,000 | 0.015 | 0.073% |

At full range width: **0.58s per 1000-iteration solve**, storing **11.6 KB** per
solved spot.

- One core: ~6,200 spots/hour. Eight cores: ~49,000 spots/hour.
- A 10,000-spot library ≈ **2 core-hours and ~116 MB**. An overnight job.

The expensive part of postflop is not compute. It is tree design and choosing
which spots to include.

## What this does NOT prove

Being explicit, because these are the places the estimates could still break:

- **Only one street.** A river solve is the easy case. Multi-street
  (flop → turn → river) node counts explode, and the preflop table above is the
  warning shot for how fast that happens. A flop solve needs its own benchmark
  before anyone promises "postflop solutions."
- **No UI, no browser test.** Node/V8 is the same engine as Chrome, but real
  frame budgets with rendering competing for the main thread are untested.
- **No bot play, no leak tracking.** The product's differentiators are unbuilt;
  this is engine feasibility only.

## Verdict

Green light on the technical plan, with one scope correction: the narrow v1
(**heads-up, or 6-max with a reduced preflop tree**) is not just the safe
product call — it is what the payload arithmetic actually permits. Real-time
equity and coaching in-browser are comfortably fast, and a precomputed spot
library is an overnight batch job rather than a research project.

## Running it

```bash
cargo test --release              # 13 tests incl. 400k-case evaluator fuzz
cargo run  --release --bin bench  # native benchmarks
cargo build --release --target wasm32-unknown-unknown
node web/bench.mjs                # identical workloads in wasm
```
