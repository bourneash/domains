# TrainingSharks.com — board report

## 2026-08-09 — brief locked, engine proven, v1 built

**Positioning decided.** TrainingSharks.com is a free browser poker trainer, not a content site.
Chosen over a combat-sports gear affiliate and a shark-training satire site on modelled revenue:
best name fit, an audience that already pays for tools, and the only option with recurring rather
than per-transaction revenue.

**Feasibility proven before committing the domain.** A Rust engine prototype
(`prototypes/poker-engine`) answered both open technical questions:

- Real-time equity in the browser is comfortable — 9.4M hand evaluations/sec in wasm, a
  10,000-trial equity estimate in 1.76ms, in a 75 KB module with no threading.
- Multi-street solving is affordable to precompute server-side. Turn solves converge to 0.01% of
  pot in seconds. A full exact flop library is 218 core-hours and 55 GB; at 8×8 runout abstraction,
  5.9 core-hours and 1.5 GB.

**One assumption broke and changed scope:** a 6-max preflop strategy table does not fit
client-side (6.14 GB at three sizings, four-raise cap). Only heads-up (119 KB) or a reduced 6-max
tree (7 MB) is shippable. This is why v1 is narrow — arithmetic, not taste.

**Two real bugs were caught by building the benchmarks rather than trusting a single number.**
A blocked-combo leak through chance nodes was stalling multi-street exploitability at ~4% of pot
while still looking like slow convergence; and my recalled value for AA-vs-KK was wrong while the
engine was right, which is why the evaluator is now fuzzed against an independent brute-force
reference over 400,000 hands instead of against memory.

**v1 is built and verified.** React + Vite on the 0xroulette design system, three modes (Drill,
Play, Leaks), a coach rail, consent-gated analytics, and legal pages. A browser smoke test drives
the real app end to end: engine loads, spots grade correctly, play mode completes hands, all
routes render, zero console errors.

### Open before launch

1. Create `bourneash/trainingsharks.com`, convert `sites/trainingsharks.com` to a submodule.
2. Confirm the domain is in Cloudflare; run `bind-worker-domain.sh` and `setup-cf-email.sh`.
3. Jesse wires CF Workers Builds in the dashboard (root dir `site`, build `npm run build`,
   deploy `npx wrangler deploy`).
4. GA4 property + real measurement ID (currently a placeholder that deliberately no-ops).
5. Register in `DOMAINS_INDEX.md` and `tools/site-tracker/sites.yml`.
6. **Add the reciprocal link on 0xroulette.com** — held back deliberately until this site is live,
   so the link is not dead on a production site. TrainingSharks already links out to 0xRoulette.
