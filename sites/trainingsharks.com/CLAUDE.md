# TrainingSharks.com

A free browser poker trainer that **computes every answer instead of looking it up**. Positioning
locked 2026-08-09 after a modelled comparison against two alternatives (combat-sports gear
affiliate; a shark-training satire site). This is a *tool*, not a content site — the same shape as
0xroulette.com and weapontester.com.

## Revenue thesis

Free tool first, monetise second. In order:

1. **Training-site affiliates** — the real money. Poker training subscriptions run $50–100/mo and
   their affiliate programmes pay 25–40% *recurring*. Fifty active referrals is ~$1k/mo.
2. **Own paid tier**, $9–15/mo — deliberately under GTO Wizard's $99. Free stays: unlimited drills,
   equity, bots. Paid gets: session history, saved leak reports, custom ranges, harder opponents.
3. **Amazon affiliate** — a footnote. Chips and books convert badly against study intent.

Explicitly **not** in the model:

- **No real-money poker room affiliates.** That is where the CPA money is and also the
  geo/licensing/ad-network risk. Strategy training with no wagering is clean; stay there.
- **No display ads.** AdSense will not serve gambling-adjacent inventory reliably, so the model
  never assumed it.

Phase 1 is deliberately unmonetised: the poker community is small and reputation-driven, and a
free tool that gets linked from forums and Discords is the compounding asset. Monetising on sight
kills that.

## Voice

- Dry, precise, player-native. Confident about maths, never about outcomes.
- **Show the working.** Every claim the site makes should be checkable by the reader. The audience
  does arithmetic for a living and will check.
- Never promise profit. Poker is beatable; that is not the same as safe, and variance is brutal.
- Where we are assuming rather than solving, say so on the page.
- Restraint over hype. The maths is the pitch.

## What the product is

Three screens, one idea — every answer computed, every mistake priced in big blinds:

- **Drill** — call/fold decisions and equity reads, graded in chips against a stated range.
- **Play** — heads-up hands against deliberately exploitable archetypes, with a live coach overlay.
- **Leaks** — mistakes ranked by total cost, not frequency.

## Non-negotiables

- **Never ship a made-up chart.** If a number appears, the engine computed it, or the page states
  it is an assumption. The four opponent ranges are assumptions and are printed in full on
  `/opponents` precisely so they can be argued with.
- **Play money only.** No wagering, no cashier, no links to poker rooms, anywhere.
- **The engine is the product.** If it fails to load, the trainer shows an error rather than
  falling back to approximations.

## Stack

- **React 18 + Vite** under `site/`, TypeScript throughout. Same design system as 0xroulette
  (CSS tokens in `src/ui/theme.css`) so the two could be merged or cross-skinned later.
- **Engine**: Rust → WebAssembly, `public/engine/poker_engine.wasm` (~75 KB). Source of truth is
  `/home/jesse/projects/domains/prototypes/poker-engine`; the `.wasm` here is a build artifact.
- **Cloudflare Worker** (`src/worker/index.ts`) — static assets + www→apex redirect.
- **Worker name on CF:** `trainingsharks-com`

### No COOP/COEP here

0xroulette needs cross-origin isolation because wasmoon wants `SharedArrayBuffer`. This engine is
single-threaded with a hand-rolled ABI and needs none of it. Do not copy those headers across —
they buy nothing here and break ad iframes.

## The engine ABI

Raw `extern "C"`, no wasm-bindgen: cards are single bytes (`rank * 4 + suit`, rank 0–12 for 2–A,
suit 0–3 for clubs/diamonds/hearts/spades), and everything crossing the boundary is a
`Uint8Array`. `src/lib/engine.ts` owns allocation and freeing. **The card encoding must stay
identical on both sides** — change one, change the other.

To rebuild the engine after changing the Rust:

```bash
cd /home/jesse/projects/domains/prototypes/poker-engine
cargo test --release && cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/poker_engine.wasm \
   ../../sites/trainingsharks.com/site/public/engine/poker_engine.wasm
```

## Verification

Unit tests live with the Rust engine (16, including a 400,000-case fuzz against an independently
written brute-force evaluator). The browser smoke test is `site/tests/smoke.mjs` — it is the only
thing that proves the wasm ABI works in a real page, so run it before shipping:

```bash
npm run build && npx vite preview --port 4791 &   # then
node tests/smoke.mjs
```

## Roadmap

Feasibility work is **done** — see `prototypes/poker-engine/RESULTS.md`. Two findings shape what
comes next:

- A 6-max preflop strategy table does **not** fit client-side (6.14 GB at three sizings and a
  four-raise cap). Only heads-up (119 KB) or a reduced 6-max tree (7 MB) ships. Preflop chart
  drills must be scoped accordingly.
- Postflop precompute is affordable server-side: a full exact flop library is 218 core-hours and
  55 GB; at 8×8 runout abstraction it is 5.9 core-hours and 1.5 GB.

Blackjack is a planned sibling site. The engine is being kept modular — `game rules / strategy
oracle / drill loop / leak tracker` — so only the first two are poker-specific.
