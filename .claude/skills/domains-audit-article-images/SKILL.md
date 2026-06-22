---
name: domains-audit-article-images
description: Install and configure the live broken-image watchdog (originated on americastrikes.com) onto a portfolio site so every published article's hero/card image is verified on the LIVE site — HTTP 200 + not blank/near-empty — after each deploy, with failures posted to the site's Slack channel. Use when the user asks to "add the image audit to <site>", "check for broken article images", "install the broken-image watchdog", "audit article images", "why are images blank/404 on <site>", or wants the americastrikes image check on another site. Covers the parameterized check-live-images.sh template, the per-site CONFIG block (BASE_URL, frontmatter fields, the load-bearing CHECK_WEBP toggle, byte floors, Slack channel, repair hint), where to wire it (deploy.sh / smoke tests / cron), and live verification. Reference implementations: americastrikes.com (webp on) and saveusfarms.com.
---

# Audit article images (broken-image watchdog)

Stamps a site-agnostic **`ops/scripts/check-live-images.sh`** onto a portfolio
site. It reads every article's image frontmatter and probes the **live** site:
each referenced image must return **HTTP 200** and be **above a byte floor**
(a blank editorial card from the americastrikes font incident was ~7–10 KB,
versus 12 KB+ for a real photo). Failures are logged to `ops/logs/` and posted
to the site's Slack channel.

It runs with only **bash + python3 + curl** (no node), so it works inside the
cron container. The template lives at
`assets/check-live-images.sh` next to this skill.

## How it works

- Iterates `*.md` under the articles dir, pulls the image path(s) from
  frontmatter (the fields in `IMAGE_FIELDS`), and — when `CHECK_WEBP=1` — also
  probes the `.webp` sibling the browser actually fetches first.
- `image:` is treated as the hero (**cover** floor); any other field
  (e.g. `imageCard:`) is a **card** floor.
- Issues a GET but reads only the `Content-Length` header (Cloudflare omits it
  on HEAD for static assets), never downloading the body.
- Reachability pre-check: if the homepage doesn't answer 2xx/3xx, it logs and
  **exits 0** (a down site is a deploy problem, not an image problem).
- On failure: logs, posts to Slack via `ops/scripts/notify-slack.sh` (degrades
  silently if that script/token is absent), and exits 1.

## ⚠️ The one load-bearing per-site decision: CHECK_WEBP

The script can probe a `.webp` sibling for every `.jpg`. **Only enable this if
the build actually emits those `.webp` files** — otherwise every article logs a
false 404.

```bash
# Does this site serve .webp siblings? Probe one live cover:
img=$(grep -h '^image:' sites/<site>/site/src/content/articles/*.md | head -1 | sed "s/^image:\s*//; s/['\"]//g")
curl -s -o /dev/null -w '%{http_code}\n' "https://<site>${img%.jpg}.webp"   # 200 => CHECK_WEBP=1, 404 => CHECK_WEBP=0
```

Reference reality: **americastrikes.com** and **saveusfarms.com** emit webp
(`CHECK_WEBP=1`); **broadwayshowgirls.com** serves only `.jpg` (`CHECK_WEBP=0`).

## Procedure

1. **Confirm the site fits the shape.** Astro articles at
   `site/src/content/articles/*.md` with an `image:` (and maybe `imageCard:`)
   frontmatter path that starts with `/`. Confirm the cron image (if any) has
   `python3` + `curl`.

2. **Copy the template** to `sites/<site>/ops/scripts/check-live-images.sh` and
   `chmod +x` it.

3. **Fill the CONFIG block** at the top — the only lines that change per site:

   | Knob | How to set it |
   |------|---------------|
   | `SITE_NAME` / `BASE_URL_DEFAULT` | the host |
   | `ARTICLES_DIR_REL` | usually `site/src/content/articles` |
   | `IMAGE_FIELDS` | `image imageCard` — drop `imageCard` if the site doesn't use it |
   | `CHECK_WEBP` | **1 only if the build emits webp** (see the probe above) |
   | `COVER_FLOOR` / `CARD_FLOOR` | `11000` / `6000` are good defaults |
   | `SLACK_CHANNEL_VAR` / `SLACK_CHANNEL_DEFAULT` | `SLACK_CHANNEL_<SITE>` / `domain-<host-dashes>` (matches the `domains-connect-site-to-slack` convention) |
   | `UA` | a recognizable user-agent string |
   | `REPAIR_HINT` | the **real** repair command for this site (see below) |

   **Repair command differs per site** — point the hint at whatever regenerates
   an image there:
   - find-image.mjs sites (americastrikes, saveusfarms): `cd site && node scripts/find-image.mjs --force <slug>`
   - stock-photo sites (broadwayshowgirls): `node tools/fetch-image.mjs pexels "<query>" site/public<path>`

4. **Wire it into the deploy/verify path** (pick what the site already has):
   - **deploy.sh** — append a post-deploy call (saveusfarms pattern):
     `bash ops/scripts/check-live-images.sh "https://<site>" 2>&1 | tee -a "$LOG" || true`
   - **smoke tests** — call it from `run-smoke-tests.sh` after the HTTP checks.
   - **cron** — add a daily line so blank images surface even without a deploy.
   Keep it **non-fatal** in deploy (`|| true`) so an image blip doesn't abort a
   good deploy — the Slack post is the signal.

5. **Verify live, immediately** — the sites are live, so just run it:
   ```bash
   cd sites/<site> && bash ops/scripts/check-live-images.sh
   ```
   Expect `CHECKED <n>` / `FAILURES 0`. A wall of `HTTP 404` on `.webp` paths
   means `CHECK_WEBP` is wrong — flip it to 0.

## Gotchas

- **CHECK_WEBP false-positives** are the #1 failure mode — verify with the probe,
  don't assume.
- **Frontmatter quoting**: paths may be `'/images/...jpg'` (quoted). The python
  strips quotes; a raw shell probe won't — strip them yourself when testing.
- **`chmod +x`** or cron/`run-role.sh` silently won't execute it.
- **No Slack on the site is fine** — the script degrades to log-only + exit 1.
  If you want alerts, install `domains-connect-site-to-slack` first.
- Don't lower the floors to silence a real blank image — fix the image.

## Optional companion: build-time check

americastrikes also ships `ops/scripts/check-images.sh` — a *local* pre-deploy
check (scans `site/public/.../cover.jpg` on disk, `--fix` re-runs the image
generator). It's optional and only makes sense on sites whose generator matches
(`find-image.mjs`). The live watchdog above is the portable, always-useful half.
