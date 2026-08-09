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

## 5. Multi-street: turn and flop solves

`street.rs` is a full multi-street solver — betting rounds separated by chance
nodes that deal the next board card, using CFR+ (regrets floored at zero, average
strategy weighted linearly by iteration). This is the benchmark that decides
whether "postflop solutions" is a real promise.

**Turn solve, every one of the 48 river cards enumerated, no abstraction:**

| Iterations | Exploitability | % of pot |
|---|---|---|
| 250 | 0.053 | 0.27% |
| 750 | 0.010 | 0.05% |
| 2,000 | 0.0025 | **0.01%** |

580 decision nodes, 432 showdown boards, 196 KB of solved output, 4.8 MB working
set, **6.7ms per iteration**. A turn solve is cheap — seconds per spot.

**Cost scales linearly with runout count**, confirmed by measuring flop solves at
four abstraction levels (3×3 through 8×8 turn/river buckets). Each implies the
same full-flop cost, which is what makes the extrapolation trustworthy:

| Runout buckets | ms/iter | Implied full flop |
|---|---|---|
| 3×3 | 4.1 | 1.1 s/iter |
| 4×4 | 7.4 | 1.1 s/iter |
| 6×6 | 17.0 | 1.1 s/iter |
| 8×8 | 30.4 | 1.1 s/iter |

All four converge to 0.1–0.2% of pot within 400 iterations.

**What a flop library costs**, at 400 iterations (~0.15% exploitable), across all
1,755 strategically distinct flops:

| | Per spot | Full library |
|---|---|---|
| Exact (49×48 runouts) | 7.4 min, 32 MB | **218 core-hours, 55 GB** |
| 8×8 runout abstraction | 12 s, 0.9 MB | **5.9 core-hours, 1.5 GB** |

Read that as: a complete exact flop library is ~1 day on 8 cores and 55 GB —
server-side only, absolutely not shippable. An abstracted library is an
afternoon's compute and 1.5 GB, which is a normal asset-hosting problem.

Neither ships to the client. Both are affordable to precompute. Postflop is a
budget decision, not a research problem.

### The bug this benchmark found

The multi-street exploitability initially plateaued around 4% of pot and stayed
there — which reads like slow convergence but was not. Hero combos that contain
a dealt runout card get zero reach, but their subtree values were still being
summed up through the chance node. Best-response takes a max over those garbage
values while the average strategy takes a mean, so the gap never closed. Zeroing
blocked combos' contributions at the chance node fixed it (0.01% of pot on a turn
solve). The river solver never hit this, because its board was already complete
when combos were filtered.

`street::tests::turn_solve_converges` now asserts below 0.5% of pot specifically
to catch a regression here. Worth remembering: **a plateau is not slow
convergence**, and a single exploitability reading cannot tell the two apart —
which is why the benchmark prints curves.

## What this does NOT prove

- **No UI, no browser test.** Node/V8 is the same engine as Chrome, but real
  frame budgets with rendering competing for the main thread are untested.
- **No bot play, no leak tracking.** The product's differentiators are unbuilt;
  this is engine feasibility only.
- **Solve trees are narrow.** One bet size, optionally one raise. Real solutions
  offer several sizings, and the preflop table above shows how fast that
  multiplies. Costs here are a floor, not a ceiling.
- **Runout abstraction quality is unmeasured.** Bucketed solves converge *within
  their own abstract game*; how much strategic accuracy is lost against the full
  game is a separate experiment.

## Verdict

Green light on the technical plan, with one scope correction and one confirmation.

The correction: the preflop table does not fit client-side as assumed. v1 must be
**heads-up (119 KB) or 6-max on a reduced tree (7 MB)** — which happens to be the
narrow product scope we already wanted, now backed by arithmetic instead of taste.

The confirmation: multi-street precompute is genuinely affordable. Turn solves are
seconds, and a full flop library is between an afternoon and a day of compute
depending on how much abstraction we accept. Real-time equity and coach overlays
in-browser are comfortably fast at 1.76ms per 10k-trial estimate.

## Running it

```bash
cargo test --release                  # 16 tests incl. 400k-case evaluator fuzz
cargo run  --release --bin bench      # evaluator, equity, preflop tree sizing
cargo run  --release --bin flopbench  # turn/flop solves + library extrapolation
cargo build --release --target wasm32-unknown-unknown
node web/bench.mjs                    # identical workloads in wasm
```
