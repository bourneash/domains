# Social Media System — Design Spec
_2026-06-28_

## Overview

Fully automated social media presence for the domain portfolio. Three new tools plus a shared library, built on top of existing infrastructure (CloakBrowser, vpn-proxy, email-client, CF Email Routing). Handles account creation, fictional staff personas, and ongoing content posting. Designed to onboard new sites with minimal effort.

**Sites needing social accounts (site-level):**
xxxtea.com, sinderella.org, totaljerks.com, ultrarough.com, reviewtattoo.com, rc-9.com, deeppenetrations.com, broadwayshowgirls.com, americastrikes.com, aliencouncil.com, 0xroulette.com

**Sites needing fictional staff personas:**
americastrikes.com, saveusfarms.com, broadwayshowgirls.com

---

## Architecture

```
tools/
  social-lib/        ← shared primitives (VPN, browser, email, TOTP, SMS)
  social-setup/      ← account creation (extend existing)
  personas/          ← fictional staff generation (NEW)
  social-poster/     ← ongoing content posting (NEW)
```

All tools import from `social-lib`. No circular dependencies. Each tool is independently installable and testable.

---

## Infrastructure: What Already Exists

| Component | Location | Role |
|-----------|----------|------|
| VPN proxy | `tools/vpn-proxy/` | PIA gluetun containers, US exit `127.0.0.1:8181`, EU exit `127.0.0.1:8182` |
| CloakBrowser | `tools/social-setup/src/social_setup/cloak_driver.py` | Anti-detect Chromium, gate-and-wait flow |
| Email client | `/mnt/encrypted/projects/email-client/` | IMAP/SMTP + `/wait` long-poll endpoint at `localhost:9200` |
| CF Email Routing | CF API (token in shared `.env`) | Creates email aliases, forwards to `jessetamburino@hotmail.com` |
| Social setup | `tools/social-setup/` | Existing provisioner for 7 platforms, needs VPN + TOTP wired in |

---

## tools/social-lib/

Shared primitives. No CLI. All other tools import from here.

### Modules

**`vpn_session.py`**
Wraps vpn-proxy containers. Provides a context manager that sets `HTTP_PROXY=http://127.0.0.1:8181` for any subprocess or requests session. Defaults to US exit; EU exit available via `region="eu"`.

**`browser_session.py`**
Extends existing `cloak_driver.py`. Every session is created with VPN proxy injected (`--proxy-server=http://127.0.0.1:8181`). Abstracts gate-and-wait: writes `/tmp/cloak-gates/<name>.waiting`, blocks until `.continue` or `.skip` file appears.

**`email_client.py`**
HTTP client wrapping `localhost:9200`. Key methods:
- `wait_for_message(to_addr, subject_contains, timeout=120)` — long-polls `/mailbox/{addr}/wait`, matches by `to:` field to distinguish forwarded aliases in shared hotmail inbox
- `ensure_alias(domain, local_part)` — calls CF API to create `local_part@domain` routing rule if not exists (wraps existing `social_setup.email.ensure_social_alias`)

**`totp.py`**
Wraps `pyotp`. Methods:
- `generate_secret()` → base32 secret string
- `current_code(secret)` → 6-digit TOTP code
- `enroll(page, secret)` → drives browser to scan/enter TOTP secret in platform settings
Secrets stored in cred files as `TOTP_SECRET=<base32>`.

**`sms_gate.py`**
Two modes:
- `manual(phone_number, gate_name)` — prints Jesse's number (610-737-8479), opens gate-and-wait for him to receive and enter the code
- `smspool(platform, gate_name)` — SMSPool REST API (future, for Meta). Requests a number, polls for incoming code, returns it. Activated by `SMS_PROVIDER=smspool` in env.

**`credentials.py`**
Re-exports and extends existing `social_setup.credentials`. Adds `read_creds(site_root, platform)` and `has_totp(site_root, platform)`.

---

## tools/social-setup/ (Extended)

Account creation for site-level accounts. Extends existing tool.

### Changes to existing code

1. **Wire VPN into every CloakBrowser session** — currently missing. `cloak_driver.py` gets `--proxy-server` injected from `social_lib.browser_session`.
2. **TOTP enrollment after every signup** — immediately after account created, navigate to security settings, enroll TOTP via `social_lib.totp.enroll()`, store secret in cred file, remove phone from account.
3. **LinkedIn platform added** — new `platforms/linkedin.py`.
4. **Facebook + Instagram stubs** — `platforms/facebook.py` and `platforms/instagram.py` exist but raise `PlatformDeferred("use --include-meta to enable")` unless flag is passed. Cred file stubs written as empty files so `social-status` can report them as pending.
5. **SMS gate unified** — all phone verify steps go through `social_lib.sms_gate`. Currently hardcoded manual; Meta path will use SMSPool when enabled.

### Platform provisioning order

Bluesky → Reddit → Pinterest → X → TikTok → LinkedIn → _(Facebook deferred)_ → _(Instagram deferred)_

### CLI

```bash
social-setup provision americastrikes.com
social-setup provision ultrarough.com --platforms bluesky,reddit,x
social-setup provision broadwayshowgirls.com --include-meta  # when Meta phase begins
social-setup status --all
social-setup resume americastrikes.com
```

### Platform matrix

| Platform | SMS at signup | API for posting | Phase |
|----------|--------------|-----------------|-------|
| Bluesky | No | AT Protocol (no key needed) | 1 — now |
| Reddit | No | PRAW + OAuth | 1 — now |
| Pinterest | No | Pinterest API | 1 — now |
| X | Yes — Jesse's # | Tweepy | 1 — now |
| TikTok | Yes — Jesse's # | TikTok API | 1 — now |
| LinkedIn | Yes — Jesse's # | LinkedIn API | 1 — now |
| Facebook | Yes — SMSPool | Meta Graph API | 2 — deferred |
| Instagram | Yes — SMSPool | Meta Graph API | 2 — deferred |

**SMS note:** Jesse's number (610-737-8479) used for X, TikTok, LinkedIn. Platforms don't cross-reference. Meta deferred specifically to avoid personal number linkage across adult content sites; SMSPool credits (~$5-10 one-time) used when Meta phase begins.

---

## tools/personas/ (NEW)

Fictional staff personas publicly associated with brands as real employees.

### What a persona is

- AI-generated face (fetched from `thispersondoesnotexist.com` or generated via ComfyUI for custom looks)
- Invented name, DOB, employment history, short bio (generated via Claude API)
- Real CF Email Routing alias (`jane.doe@americastrikes.com` → hotmail)
- LinkedIn account (CloakBrowser + VPN)
- Optional: X account, other platforms as needed per brand

### CLI

```bash
persona create --site americastrikes.com --count 2 --role "reporter"
persona create --site broadwayshowgirls.com --count 3 --role "performer"
persona provision-linkedin jane-doe --site americastrikes.com
persona provision-x jane-doe --site americastrikes.com
persona status americastrikes.com
persona list --all
```

### Persona generation pipeline

1. Call Claude API: generate name, DOB (25-45 age range), 2-sentence bio, employment history (1-2 prior roles + current site role)
2. Fetch face: `GET https://thispersondoesnotexist.com/` → save to `ops/personas/avatars/<handle>.jpg`
3. CF Email Routing: create `<firstname>.<lastname>@<domain>` alias → hotmail
4. Write `sites/<domain>/ops/personas/<handle>.yaml`

### Persona YAML format

```yaml
name: Jane Doe
handle: jane-doe
role: Senior Reporter
email: jane.doe@americastrikes.com
dob: 1988-04-12
bio: "Former wire service correspondent covering defense and foreign policy. Now reporting for America Strikes."
employment_history:
  - company: Reuters
    role: Staff Correspondent
    years: "2014–2021"
  - company: America Strikes
    role: Senior Reporter
    years: "2021–present"
avatar: ops/personas/avatars/jane-doe.jpg
platforms:
  linkedin: provisioned
  x: pending
  instagram: pending
linkedin_url: https://linkedin.com/in/janedoe-americastrikes
created: 2026-06-28
```

### Storage

```
sites/<domain>/ops/personas/
  jane-doe.yaml
  john-smith.yaml
  avatars/
    jane-doe.jpg
    john-smith.jpg
```

### LinkedIn provisioning

CloakBrowser + VPN. Flow:
1. Ensure persona email alias exists and is routing
2. Navigate to `linkedin.com/signup`
3. Fill name, email (persona alias), password, DOB
4. Email verify: `email_client.wait_for_message(to_addr=persona.email)` → auto-read code
5. SMS verify (if triggered): manual gate with Jesse's number
6. Fill profile: headline, bio, avatar upload, current employer (site name), employment history
7. Write `linkedin_url` back to persona YAML

---

## tools/social-poster/ (NEW)

Ongoing scheduled posting. Reads cred files, adapts site content per platform, posts.

### CLI

```bash
social-poster post americastrikes.com --platforms x,bluesky,reddit
social-poster post americastrikes.com --dry-run
social-poster install-cron americastrikes.com
```

### Content pipeline

```
site articles (src/content/*.md or content.json)
  → content_loader: extract title, URL, summary, tags, image
  → platform_adapter: format per platform
  → api_poster: post via platform SDK
  → post-log.jsonl: record what was posted, when, platform, URL
```

### Per-platform formatting

| Platform | Format |
|----------|--------|
| X | headline + site URL + 2-3 hashtags, ≤280 chars |
| Bluesky | same as X, AT Protocol `app.bsky.feed.post` |
| Reddit | link post to most relevant subreddit (stored per-site in config) |
| Pinterest | image pin: article OG image + description + site URL |
| TikTok | text post (video generation is a future phase) |
| LinkedIn | professional framing: 2-sentence summary + article link |
| Facebook | page post (deferred with Meta phase) |
| Instagram | image post (deferred with Meta phase) |

### Post deduplication

`ops/social/post-log.jsonl` — one JSON line per post with `article_slug`, `platform`, `posted_at`. Poster skips any article+platform combo already in the log.

### Cron role: `domains-cron-role-social-poster`

Per-site cron role following existing cron-role patterns. Runs 2x/day. Picks most recent unpublished article, posts to all active platforms, logs result. Slack notification on failure (follows existing Slack integration pattern).

Schedule: `0 9,17 * * *` (9am + 5pm) — staggered per existing fleet stagger map rules.

---

## Credential storage layout

```
sites/<domain>/ops/social/
  .bluesky-creds        # BLUESKY_HANDLE, BLUESKY_APP_PASSWORD, TOTP_SECRET
  .reddit-creds         # REDDIT_USERNAME, REDDIT_PASSWORD, CLIENT_ID, CLIENT_SECRET, TOTP_SECRET
  .x-creds              # X_USERNAME, X_PASSWORD, X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET, X_BEARER_TOKEN, TOTP_SECRET
  .tiktok-creds         # TIKTOK_USERNAME, TIKTOK_PASSWORD, TIKTOK_CLIENT_KEY, TOTP_SECRET
  .linkedin-creds       # LI_USERNAME, LI_PASSWORD, TOTP_SECRET
  .pinterest-creds      # PINTEREST_USERNAME, PINTEREST_PASSWORD, PINTEREST_APP_ID, TOTP_SECRET
  .facebook-creds       # empty stub — populated in Meta phase
  .instagram-creds      # empty stub — populated in Meta phase
  social-status.json    # per-platform: provisioned/pending/deferred + last_post_at
```

All cred files: `chmod 600`, gitignored via existing pattern.

---

## Skills

| Skill | Trigger |
|-------|---------|
| `domains-social-setup` | Provision site-level social accounts for a domain |
| `domains-persona-create` | Create + provision fictional staff personas for a site |
| `domains-cron-role-social-poster` | Install social posting cron role on a site |
| `domains-social-status` | Fleet-wide view: what's provisioned, what's posting, last post dates |

---

## Build sequence

| Phase | Work | Deliverable |
|-------|------|-------------|
| 1 | `tools/social-lib/` — VPN, browser, email, TOTP, SMS gate primitives | Shared library, tested standalone |
| 2 | Extend `tools/social-setup/` — wire VPN, TOTP enrollment, LinkedIn, Meta stubs | Updated provisioner |
| 3 | `tools/personas/` — generator, LinkedIn provisioner, skill | Persona system |
| 4 | `tools/social-poster/` — posting engine, per-platform adapters, cron role, skill | Posting pipeline |
| 5 | End-to-end on americastrikes.com — provision all Phase 1 platforms, create 2 personas, install poster cron | Full stack validated |

---

## Test site: americastrikes.com

First site to run the full stack. Chosen because:
- Most active content pipeline (articles publishing daily via autonomous ops)
- Already has engineer + content-writer cron roles running — good baseline for adding social-poster
- News/geopolitics content adapts naturally to X, Reddit, LinkedIn, Bluesky
- 2 fictional reporter personas make brand sense

After americastrikes validates, remaining 10 sites follow the same playbook.
