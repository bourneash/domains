---
name: domains-amazon-creator-connections
description: >
  Implement Amazon Creator Connections campaigns on any portfolio affiliate site under
  /home/jesse/projects/domains/sites/. Use when Jesse says "add the Creator Connections
  campaigns", "implement the campaigns I activated", "submit content URLs to Amazon",
  "set up the Amazon Creator campaigns for <site>", or wants to pull, build content for,
  and submit the boosted-commission brand campaigns he accepted in the Amazon Associates
  dashboard. Covers: reading the campaigns off the dashboard via CloakBrowser (there is NO
  API for them), building on-brand content pages with cloaked /go/ links + disclosure, and
  submitting each content URL back through the dashboard. Shared tooling lives at
  tools/creator-connections/ (pull.py, submit.py, cc_lib.py) — use it instead of writing fresh
  CloakBrowser scripts per site. Worked reference: totaljerks.com (9 campaigns, 2026-07-03).
---

# Amazon Creator Connections — portfolio playbook

## First, the distinction that trips everyone up

**"Amazon Creators API" and "Amazon Creator Connections" are two different things.**

- **Creator Connections** = the brand-funded campaigns Jesse *activates* (boosted commission,
  e.g. 10–20%, for a fixed window — the Mad Rabbit 15% on reviewtattoo, the KastKing 10% on
  totaljerks). These live **ONLY** in the Associates dashboard. There is **no public API** to
  list, accept, or submit them. Managed entirely through the web UI → we drive it with
  CloakBrowser. Do not go looking for an endpoint; it does not exist (verified 2026-07).
- **Creators API** (creds `AMAZON_CREATORS_KEY_ID/SECRET/APPLICATION_ID` in the root `.env`) =
  the REST successor to PA-API. Returns **product data**, not campaigns. Requires app approval +
  ≥10 qualifying sales / 30 days to return anything. Optional enrichment for writeups; NOT the
  way to get campaigns. Don't waste time wiring it unless product data is specifically needed.

**Commission attribution:** Creator Connections binds to the *creator account* (Jesse's is
"Synaptic Workshop", `creatorId amzn1.creator.7b4fea2c-d009-4d2f-86d4-f583a6aa4fd1`), NOT one
store tag. Dashboard reporting explicitly aggregates across all store IDs on the Associates
account, so a site's own `<site>-20` `/go/` link to the campaign ASIN qualifies for the bonus.
You do NOT need to switch tags per site. Confirm per campaign via the "Get associate link" button
if unsure.

**What each campaign requires:** publish ONE content URL covering the product (with a visible
affiliate disclosure), then submit that URL in the campaign's dashboard page before its end date.
No samples. Miss the deadline → forfeit the bonus commission.

## The end-to-end flow (per site)

1. **Pull the campaigns** off the dashboard (CloakBrowser). Filter to the ones for THIS site —
   the active list mixes campaigns across all of Jesse's sites (Jeep/moto, tattoo, fishing, …).
2. **Triage** which campaigns fit the site's brand; flag off-brand ones to Jesse (e.g. STEM toy
   "fishing" kits on a serious tackle site → a novelty gift angle, not a straight gear review).
3. **Add products** to the site's affiliate registry as `campaignOnly` entries → `/go/` cloaked
   links (auto-generated + smoke-tested), hidden from curated category grids.
4. **Write content** — dedicated guide/review pages, one per product or grouped, each with the
   `/go/` link + a visible disclosure callout. A single roundup URL can be submitted to every
   campaign it covers.
5. **Build, push, smoke** the site. Verify each `/go/` 302s to Amazon with the site tag and each
   content page is 200/live BEFORE submitting.
6. **Submit** each live content URL through the dashboard. Track state in a per-site manifest.

## Step 1 — Pull campaigns via the shared tool

Portfolio CloakBrowser (same tooling as the GA4 / social-setup skills — NOT Playwright MCP).
Profile persists at `/tmp/cloak-driver/profile` (may already be logged in; else log in as
**Jesse Tamburino** in the visible window). Screenshots → `.cloak-screenshots/`.

Use `tools/creator-connections/pull.py` — do NOT write a fresh one-off CloakBrowser script per
site; every site needs the same two operations (list cards, then detail + `/dp/` product facts)
and the shared tool already handles login-handoff, SPA-warming, and file-first output (never
print large JSON through a piped command like `| tail` — that can hit `BlockingIOError` mid-print
and lose the data with nothing recoverable; the tool always writes to `--out` first).

```bash
cd /home/jesse/projects/domains
# every active campaign across ALL sites — filter to this site's products after
/home/jesse/.pyenv/shims/python tools/creator-connections/pull.py list --out /tmp/cards.json

# a specific category seems to be missing? search for it directly — see the DXV gotcha below
/home/jesse/.pyenv/shims/python tools/creator-connections/pull.py list --keyword vac --out /tmp/vac.json

# once you've picked target cards, pull detail + real /dp/ product facts (adId:campaignId pairs
# come from the `cid`/`adId` fields in the list output)
/home/jesse/.pyenv/shims/python tools/creator-connections/pull.py details \
  --pairs AD1:CID1,AD2:CID2 --dp --out /tmp/details.json
```

`details --dp` visits each product's `/dp/<ASIN>` page and returns real `title`, `price`,
`rating`, `reviewCount`, and hero `img` — use these, don't trust the campaign card's own
price/rating fields (often stale or "Currently unavailable" on multi-variation campaigns). The
campaign-detail `campaign_body` text still has `Commission rate`, `Start/End date`, and
`Budget Remaining`. The Amazon image ID is the segment before the first `.` in
`m.media-amazon.com/images/I/<id>._SR180,200_.jpg` — the same id works at higher res via
`._AC_SL500_.jpg`.

## Step 3 — Registry entries (`campaignOnly`)

Add a `campaignOnly?: boolean` field to the site's `AffiliateProduct` interface, add each product
with `campaignOnly: true` + `asin` + `amazonImageId`, and exclude it from the ONE grid consumer:
```ts
// CategoryLayout (or equivalent): the only place that renders ALL products of a category
const products = PRODUCTS.filter(p => p.category === slug && !p.campaignOnly);
```
Audit every `PRODUCTS` consumer first — most render from curated ID lists (TOP_PICKS, filter
pages) and are unaffected; only the "all products in category X" grid needs the filter. This
keeps time-boxed campaign gear out of the editorial catalog while still generating `/go/` links
+ smoke tests. Each product `image` must be `/products/<id>.jpg` if a test asserts it (string
check only — the file need not exist when the card renders from `amazonImageId`).

## Step 4 — Content + disclosure

**The content model depends on the site's shape — pick the one that fits:**

- **Editorial/guide sites** (e.g. totaljerks): dedicated `/guides/` review pages in the site's
  voice. Campaign products go in the registry as `campaignOnly` (hidden from category grids). One
  roundup URL can be submitted to several campaigns. Add a visible disclosure `.callout` per page.
- **Storefront-style sites** (e.g. shoptopless): the campaign products ARE catalog products. Add
  each as a normal product (there, a `src/content/products/<slug>.md` with name/category/asin/
  price/rating/reviewCount/hero/blurb/bullets/fitment) — NO `campaignOnly`, NO guide pages. Each
  product's `/p/<slug>` detail page is the content URL. Disclosure is already in the product
  template. `hero` can be a remote Amazon image URL (`m.media-amazon.com/images/I/<id>._AC_SL500_.jpg`)
  if the schema allows absolute URLs and there's no blocking CSP — check both first.
- **Auto-review sites** (e.g. ultrarough): if every SKU already gets a programmatic
  `/reviews/<id>/` page (via `getStaticPaths` over the affiliate registry) with disclosure baked
  into the template, you don't need separate guide pages OR remote product images — just add the
  `campaignOnly` SKU and the review page + `/go/` link generate automatically. For the hero
  image, check whether the site's convention is real product photos or **stylized editorial
  images** picked by theme (ultrarough's gallery is artistic sandpaper photography, not literal
  product shots) — reuse an existing unused image that matches the product's form factor/material
  rather than sourcing a new one.

**Every campaign page needs a visible affiliate disclosure** ("unavoidable disclosure" is a hard
Amazon requirement). Content is written from the campaign brief + product specs (no samples).
**Get real ratings/reviewCounts** — don't fabricate (feeds Product JSON-LD). The campaign detail
page's star widget hides the number in `innerText`; read it from an `aria-label`/`.a-icon-alt`
containing "X out of 5". Off-brand products (STEM toy kits, a kids' ride-on): frame honestly as
gifts/novelty and confirm inclusion with Jesse — don't fake a gear review. Campaign titles can
LIE about the product (an "ASOWTREND JEEP" campaign was actually a kids' ride-on car) — always
verify the real product from the `/dp/<ASIN>` on the detail page.

## Step 5 — Manifest + build

Track per site at `ops/campaigns/creator-connections.json`: creatorId, dashboardUrl, and per
campaign `{productId, brand, product, asin, price, commission, start, end, campaignId, adId,
amazonImageId, contentUrl, submitted}`. Build (`npm run build` regenerates `/go/` redirects),
run unit tests, push (CF Workers Build deploys on push), then smoke each `/go/` + content URL.
Note: Cloudflare rate-limits rapid burst curls (returns `000`) — pace probes or check a few
individually; that's anti-bot on your probing, not a site defect.

## Step 6 — Submit content URLs

Drive the dashboard detail page per campaign. The submit form (bottom, "Please submit links to
your published post here"):
- **Content type** dropdown — click "Select a content type", then choose **"Article or blog
  post"** (the options are content FORMATS; "URL" is only how you enter it — do NOT try to pick
  "URL"). Beware `get_by_text('URL')` matching the summary-table header — target the option.
- **`#contentInput`** — fill the live content URL.
- **Submit** — enabled once both set. Success = the URL appears in "Manage content" with a
  **Delete** control. `You currently don't have any content links submitted` means it did NOT
  take.

Each site gets a thin wrapper at `ops/campaigns/submit-content-links.py` that just calls the
shared `tools/creator-connections/submit.py` against that site's manifest (copy the wrapper from
`sites/ultrarough.com/ops/campaigns/submit-content-links.py` — it's ~15 lines). The shared
`submit.py` is idempotent (skips `submitted:true`), detects the Amazon **"Website Temporarily
Unavailable"** maintenance page and aborts cleanly (rerun later), saves the manifest after
*every* campaign (not just at the end, so a mid-run crash doesn't lose progress), and — the
lesson from ultrarough's `eQualle` campaign — retries the content-type dropdown with a raw JS
`.click()` if the humanized click doesn't visibly open it. Run:
```bash
/home/jesse/.pyenv/shims/python sites/<site>/ops/campaigns/submit-content-links.py
# or directly, with more control:
/home/jesse/.pyenv/shims/python tools/creator-connections/submit.py \
  --manifest sites/<site>/ops/campaigns/creator-connections.json \
  --only productId1,productId2   # optional, to retry just a straggler
```

## Gotchas (learned the hard way)

- The active list mixes ALL sites' campaigns — filter to the target site's products.
- **Campaign titles can hide the actual category.** Two "shop vac" campaigns for ultrarough were
  titled `DXV09P-QTA` and `Grace-DXV08S` — no mention of "vac" anywhere in the title. If a
  requested category seems missing from the active list, search by **model-number prefix or
  brand's known SKU pattern**, not just the product word (`pull.py list --keyword vac` plus
  checking the brand's other campaigns in the same cluster would have caught this faster). Always
  verify the real product from the `/dp/<ASIN>` on the detail page — an "ASOWTREND JEEP" campaign
  was actually a kids' ride-on car.
- Content type is **"Article or blog post"**, not "URL".
- **Never print large JSON through a piped command** (e.g. `python foo.py | tail`) — a big
  payload mid-print can hit `BlockingIOError` and the data is gone with nothing to recover. Always
  write to a file first (`cc_lib.dump_json` / `pull.py --out` do this already), print a summary.
- `get_by_text(...).first` can grab a page header instead of the intended control — verify with a
  screenshot; the pixels are the evidence.
- **The content-type dropdown doesn't always open on a humanized click** — seen on a
  48-variation evergreen campaign (eQualle). If `get_by_role/get_by_text` can't find the option
  after opening, the dropdown likely never actually opened; a raw
  `page.evaluate(() => button.click())` on the "Select a content type" button reliably opens it
  where the humanized click silently no-ops. `tools/creator-connections/cc_lib.set_content_type`
  already does this fallback — no need to re-debug it per site.
- Amazon Associates goes into scheduled **maintenance** ("Temporarily Unavailable") — submissions
  silently fail against it. Detect and resume later; deadlines usually give weeks of slack.
- Drive CloakBrowser from **Python**, not bash loops (escaping + zsh no-word-split — this bites
  in shell smoke-test loops too; wrap in `bash -c` or loop in Python).
- **Warm the SPA before deep-linking:** load the campaigns LIST page first, then navigate to
  detail pages in the same context. Cold deep-links leave the app unhydrated (empty body).
- **Wait for the form before interacting:** poll for `#contentInput` before clicking the
  content-type dropdown. Some campaign pages hydrate the header before the form.
- **Browser gets flaky after heavy churn** (many launch/close cycles in one session): launches
  start hanging. Fix = `pkill -9 -f cloakbrowser` + remove `/tmp/cloak-driver/profile/Singleton*`
  before relaunching. If it stays flaky, leave stragglers for a fresh-session resume run — the
  submit script is idempotent and deadlines usually have weeks of slack.
- Always `close` the daemon / context at the end to release the profile lock.

## Repeat across sites

Same six steps per site. Per-site deltas: which campaigns are that site's, the content model
(editorial guides / storefront products / auto-reviewed SKUs — see Step 4), and the voice.
Everything else (dashboard URLs, extraction, submit flow, manifest shape) is the shared
`tools/creator-connections/` tool — don't rewrite it per site; add a ~15-line wrapper script.

**Worked examples:**
- **totaljerks.com** (2026-07-03): 9 fishing campaigns → 4 editorial guides + `campaignOnly`
  registry. 8/9 submitted (hautton straggler for resume).
- **shoptopless.com** (2026-07-03): 12 Jeep/off-road/emergency campaigns (10 products; 3 duck
  campaigns share one) → 10 storefront `products/*.md` with remote Amazon hero images. 12/12
  submitted. Skipped FOSMET smartwatch (Jesse declined); flagged ASOWTREND campaign was mislabeled
  (actually a kids' ride-on car) and included as a `gifts` novelty per Jesse.
- **ultrarough.com** (2026-07-04): 12 sandpaper/discs/shop-vac/speaker/sander campaigns →
  `campaignOnly` SKUs, no guide pages needed (every SKU auto-generates a `/reviews/<id>/` page).
  Reused existing editorial gallery images instead of Amazon product photos. 12/12 submitted.
  Two shop-vac campaigns were hiding under DeWalt model-number titles (see Gotchas). This run is
  also what motivated pulling the ad-hoc CloakBrowser scripts into the shared
  `tools/creator-connections/` package used by Steps 1 and 6 above.
- **reviewtattoo.com:** Mad Rabbit campaign already handled (pre-dates this shared tooling).
