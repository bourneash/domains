# Fleet-wide out-of-stock handling for affiliate products

Status: approved (design), 2026-07-02

## Problem

`affiliate-editor` already detects out-of-stock Amazon products (curl-checks the
`{{GO_PREFIX}}<id>` cloak, matches `currently unavailable` in the landed HTML) and
reports them to Slack — but it stops there. The product still renders as a normal,
buyable card on the live site, and there's no path from "detected out of stock" to
"marked on-site" to "eventually replaced." Today this is manual: Jesse reads the
Slack line and (maybe) does nothing.

This surfaced from a real audit line:

```
Total Jerks affiliate audit — 2026-07-01: 106/108 healthy, 0 dead, 0 broken redirects.
2 out-of-stock noted (power-pro-spectra-braid-150yd, sufix-832-braid-150yd) —
first occurrence, watching for restock.
```

The fix should be normalized across every site running the `affiliate-editor` role,
not built one-off for totaljerks — this is exactly the kind of enhancement the
`tools/cron-roles/` archetype library exists to roll out fleet-wide.

## Goals

- When a product is confirmed out of stock (not a transient blip), the on-site card
  reflects that: a badge, no live buy CTA.
- When a product stays out of stock for an extended period, the system flags it for
  replacement rather than silently leaving a dead-feeling card up indefinitely.
- When a marked product restocks, the site reflects that automatically on the next
  check — no manual un-marking.
- One implementation, rolled out to all sites currently running `affiliate-editor`.

## Non-goals

- No automatic *selection* of a replacement product (sourcing a new ASIN is content
  work — a human or content-writer picks it, this system only flags the need).
- No new state file / database. The product registry (`affiliate.ts`) is already the
  fleet's source of truth for affiliate products; state rides on it.
- No change to `affiliate-editor`'s NO-DEPLOY, read-only invariant. That invariant is
  documented as non-negotiable (`role.md.tmpl` line 13) and was a deliberate, scored
  choice when this archetype was selected (`meta.yml`: "pure no-deploy sentinel").

## Architecture

No new role, no new handoff edge. This slots into the existing
`affiliate-editor → content-writer` edge already defined in
`tools/cron-roles/handoff-protocol.md` (`type: content` for "stale product claim").
`affiliate-editor` stays a pure read-only sentinel; `content-writer` — which already
owns edits to `site/src/lib/affiliate.ts` — gains one new, narrowly-scoped edit
pattern: toggling a product's stock status.

```
affiliate-editor (Wed 7am, read-only)
  ├─ run 1 unavailable            → note in summary only (unchanged today)
  ├─ run 2 consecutive unavailable, no status yet → file type:content "mark-out-of-stock-<slug>"
  ├─ status already out_of_stock, still unavailable, ≥3 more weekly runs → file type:content "replace-product-<slug>"
  └─ status out_of_stock, now resolves normally    → file type:content "restock-<slug>"
                     │
                     ▼
content-writer (existing role, existing registry-edit ownership)
  ├─ mark-out-of-stock  → set status: 'out_of_stock', outOfStockSince: <date>; commit; deploy
  ├─ replace-product    → source replacement ASIN (same category/price tier), swap entry; commit; deploy
  └─ restock            → clear status/outOfStockSince; commit; deploy
```

The registry entry is the persistent state. `affiliate-editor` reads it (read-only,
already permitted — "the registry is always at `site/src/lib/affiliate.ts`") to know
whether a product is already marked and how long it's been marked, so no new state
file or counter mechanism is needed anywhere.

## Data model

Add two optional fields to the shared `AffiliateProduct` type (per-site, in each
site's `site/src/lib/affiliate.ts`):

```ts
export interface AffiliateProduct {
  // ...existing fields...
  status?: 'active' | 'out_of_stock';  // omitted/absent == active
  outOfStockSince?: string;            // ISO date (YYYY-MM-DD), set when marked
}
```

Omitting `status` (rather than requiring `'active'` everywhere) keeps every existing
product entry across all 10 sites valid with zero migration.

## Detection & escalation logic (affiliate-editor archetype)

Update `tools/cron-roles/archetypes/affiliate-editor/role.md.tmpl`, section "An
out-of-stock (`currently unavailable`)" (currently step 4 under "What to do with
results"):

1. **First occurrence** (no existing task/registry marker): note in the run summary,
   no task filed. Unchanged from today.
2. **Second consecutive occurrence**, and the registry entry has no `status` field:
   file `ops/tasks/backlog/<yyyy-mm-dd>-mark-out-of-stock-<slug>.md`,
   `type: content`, noting the `id`, the `currently unavailable` match, and the
   product's current registry entry so content-writer can edit it directly.
3. **Registry already has `status: out_of_stock`**, product is still unavailable,
   and `outOfStockSince` is ≥3 of this role's weekly runs in the past (~3-4 weeks):
   file `ops/tasks/backlog/<yyyy-mm-dd>-replace-product-<slug>.md`, `type: content`,
   higher-severity framing ("persistently out of stock, needs replacement" rather
   than "mark it"), including category/price tier so a replacement is easy to source.
4. **Registry has `status: out_of_stock`** but the product now checks out healthy
   (no `currently unavailable` marker, normal landing page): file
   `ops/tasks/backlog/<yyyy-mm-dd>-restock-<slug>.md`, `type: content`, so
   content-writer clears the flag. This check runs even in an otherwise-all-healthy
   week — restock detection doesn't require a "bad" run to trigger it.

Same anti-bot-wall guard applies throughout: a captcha/Robot Check response is never
treated as "still out of stock" or "restocked" — it's inconclusive and skipped.

## content-writer changes

Update `tools/cron-roles/archetypes/content-writer/role.md.tmpl` to document the
three new task subtypes it may receive from affiliate-editor (mark-out-of-stock,
replace-product, restock) alongside its existing "stale product claim" content task
handling. Each is a direct, mechanical registry edit (or, for replace-product, a
sourcing task using the site's existing product-sourcing pattern — Playwright
verification of the new ASIN, per `reference_affiliate_product_sourcing.md`) followed
by the role's normal commit-and-deploy flow. No new role capability is required —
content-writer already edits this exact file for exactly this reason.

## On-site rendering (shared `AffiliateCard.astro` pattern)

When `product.status === 'out_of_stock'`:

- Show an "OUT OF STOCK" badge in the position the `Ribbon` normally occupies (badge
  wins over ribbon if both are set — a product shouldn't show "EDITORS PICK" and be
  unbuyable at the same time).
- Gray the card (~40% opacity treatment consistent with existing disabled-state
  patterns, or the closest per-site equivalent if a site's design system already has
  one).
- Disable the buy CTA: render the card as a non-interactive `<div>` instead of an
  `<a href="/go/<id>/">` (no dead/misleading link, no crawl path to a cloak that
  currently 404s-or-redirects-to-an-unavailable-listing).
- Card stays in the grid — it is not removed or hidden. Removing it would silently
  drop internal links and category counts; graying + badging communicates status
  without breaking page structure.

This is a shared component pattern (`AffiliateCard.astro` is structurally identical
across sites, descended from the reviewtattoo original) — apply the same conditional
to each site's copy during rollout, not just totaljerks.

## Rollout

1. Update the two archetypes once (`affiliate-editor`, `content-writer`) in
   `tools/cron-roles/archetypes/`.
2. Update the shared `AffiliateProduct` type + `AffiliateCard.astro` pattern.
3. **Pilot on totaljerks.com** — it has live out-of-stock hits right now
   (`power-pro-spectra-braid-150yd`, `sufix-832-braid-150yd`), so a pilot exercises
   the mark path immediately instead of waiting for a synthetic case. Verify a full
   mark → badge → (eventually) restock-or-replace cycle before rolling further.
4. Roll to the remaining 9 sites already running `affiliate-editor`: aliencouncil,
   sinderella, shoptopless, reviewtattoo, americastrikes, ultrarough,
   broadwayshowgirls, deeppenetrations, xxxtea — via WIRING.md's maintain-mode
   refresh (Steps 4, 10, 11: refresh role body + awareness, re-verify, rebuild cron
   image). This is a role-doc refresh, not a fresh install, since all 10 already
   have the role.
5. New sites that install `affiliate-editor` going forward get this behavior by
   default — no separate step.

## Testing

- Extend each site's existing `site/src/lib/__tests__/affiliate.test.ts` /
  `tests/smoke/affiliate.spec.ts` with a case asserting `AffiliateCard` renders the
  out-of-stock badge and a non-interactive card (no `href`) when
  `status: 'out_of_stock'`.
- The existing `smoke-affiliate` postbuild validator (where present) must not fail
  on out-of-stock entries — they're intentionally non-live, not a build defect.
  Confirm the validator's pass/fail logic already treats "product exists with a
  valid ASIN" separately from "product is currently purchasable," and adjust if it
  conflates the two.
- Manual pilot verification on totaljerks: confirm the two currently-flagged
  products (once they hit the 2-consecutive-run threshold, which they've already
  passed per the 2026-07-01 audit) get marked on the live site.

## Open questions resolved during brainstorming

- **Who writes the status field?** content-writer, not affiliate-editor — preserves
  affiliate-editor's read-only/no-deploy invariant, which was a deliberate,
  documented, scored design choice.
- **Replacement threshold:** 3 additional consecutive weekly out-of-stock runs after
  the initial mark (~3-4 weeks total from first detection) before escalating to
  replace-product. Not user-confirmed interactively (no response during
  brainstorming) — proceeding with this as the reasonable default; easy to tune via
  a one-line change to the archetype if it proves too eager or too patient in
  practice.
