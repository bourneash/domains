---
name: skills-domain-social-setup
description: Provision social media accounts (Bluesky, Pinterest, Reddit) for a domain site using CloakBrowser + full-automation scripts, with credentials in the fleet's Vaultwarden instance and status tracked in the fleet social registry (Fleet Dashboard Social tab / social_registry.py). Use when onboarding a new site's social presence, resuming a stalled/failed signup, re-provisioning an account the platform suspended or closed, or extending the automation to a new platform. Captures the exact operational pattern (live captcha hand-off with Jesse, verify-before-claim discipline, known per-platform bugs) worked out across the first fleet-wide rollout — read this before re-deriving any of it from scratch.
---

# Fleet Social Media Setup

Operational playbook for provisioning social accounts across the domain
portfolio. This is the **second-generation** approach — supersedes the older
`domains-social-setup` skill's flat-file-creds + single monolithic CLI
pattern. Built and battle-tested across ~10 sites in one session
(2026-08-13/14). Read this whole doc before starting a fresh site; it
front-loads every mistake so you don't repeat them.

## The shape of the system

1. **Credential vault** — Vaultwarden (self-hosted Bitwarden), not flat files.
2. **Per-platform standalone scripts** — not one big CLI. Each platform
   (Bluesky, Pinterest, Reddit) has its own script that drives the *entire*
   signup + onboarding flow itself, only pausing for a genuine captcha.
3. **Live human-in-the-loop for captchas only** — Jesse sits at the desktop,
   solves whatever CloakBrowser window pops up, says "done", you verify and
   continue. Everything else is unattended.

## 1. The vault

**Location:** `/mnt/encrypted/projects/credential-vault/` — Vaultwarden in
Docker, `docker-compose.yml` there. Server: `https://localhost:9280`
(self-signed cert — `NODE_EXTRA_CA_CERTS` points at
`/mnt/encrypted/projects/credential-vault/ssl/cert.pem`, never disable TLS
verification wholesale).

**Structure:**
- Organization **"Domain Fleet"** (`ORG_ID` in `vault_store.py`)
- Collection **"Social Media"** (`COLLECTION_ID` in `vault_store.py`)
- Written by a dedicated **"Fleet Automation"** account
  (`automation@domains.local`, credentials in
  `/mnt/encrypted/projects/credential-vault/automation-account.env`, chmod
  600) — **not** Jesse's personal login. This keeps his real master password
  out of scripts entirely.
- Jesse's personal vault account is a **member of the org** with `manage`
  access on the Social Media collection, so everything the automation writes
  shows up in his own vault too. If you ever recreate the org/collection,
  remember to explicitly grant his account access — `bw` CLI collection
  creation does NOT auto-include other org members, only the creator. This
  bit silently failed once already (creds existed but Jesse's vault looked
  empty) — verify with `bw get org-collection <id> --organizationid <id>`
  and check the `users` array actually contains his member id, not just
  automation's.

**Code:** `tools/social-lib/src/social_lib/vault_store.py` is the only thing
that talks to `bw` CLI directly. `social_lib.credentials` and
`social_setup.credentials` both delegate to it — that's the stable API
every consumer (signup scripts, `social-poster`, `personas`) should use:

```python
from social_lib.credentials import write_creds, read_creds, has_creds
write_creds(domain, platform, {"BLUESKY_HANDLE": ..., "BLUESKY_PASSWORD": ...})
data = read_creds(domain, platform)   # {} if nothing there
has_creds(domain, platform)           # bool
```

Every field of whatever dict you pass gets preserved losslessly as a vault
item custom field — the write function guesses at `login.username`/
`login.password` for cosmetic display in the Bitwarden UI, but `read_creds`
only reads the `fields` array back, so naming inconsistencies between
platforms (`BLUESKY_PASSWORD` vs `X_PASSWORD`) don't matter.

**Session handling:** `vault_store._ensure_unlocked()` logs in + unlocks the
automation account and caches the session key both in-process and on disk
(`/mnt/encrypted/projects/credential-vault/.session_cache`). This mattered —
early on, every short-lived script paid a full login+unlock round trip
(~6s) and occasionally the CLI flaked into an interactive master-password
prompt that hung a whole shell loop. Don't remove the disk cache "for
simplicity"; it's load-bearing for the "spawn lots of small scripts"
pattern this whole workflow uses.

**Password hygiene:** never put the automation password on argv (`ps`,
`/proc/*/cmdline` are world-readable on a shared box). Use
`env["BW_PASSWORD"] = ...` + `bw unlock --passwordenv BW_PASSWORD`, not
`bw unlock <password>`. A security review caught this once already — don't
regress it if you touch `_ensure_unlocked`.

**Backup:** the vault is one local LUKS-encrypted disk with no other
replication — see `tools/credential-vault-backup/README.md`. A pre-commit
hook snapshots `data/db.sqlite3` into git on every commit to this repo;
`ADMIN_TOKEN`, the automation account password, and Jesse's personal login
deliberately stay off git (he holds those offsite himself). Restore path
is tested end-to-end (2026-08-14) — see that README before assuming the
vault is unrecoverable if the box is lost.

### Bootstrapping the vault on a fresh box (you shouldn't need to redo this)

If `/mnt/encrypted/projects/credential-vault/` doesn't exist at all, the
whole thing — Vaultwarden container, self-signed cert, automation account,
org, collection, org membership — was built by driving the web vault UI
with CloakBrowser (Playwright automation, not the `bw` CLI — CLI can't
create orgs, register accounts, or grant collection access). It's slow and
fiddly (Bitwarden's Angular app fights synthetic clicks in a few spots —
see gotchas below) but doable in under an hour. Don't attempt this unless
the vault is genuinely gone; check `docker ps | grep credential-vault`
first.

## 2. The signup scripts

Location: `tools/social-setup/scripts/` — `bsky_signup.py`,
`pinterest_signup.py`, `reddit_signup.py`, `bsky_finish_onboarding.py`.

All follow the same shape:

```bash
python3 scripts/bsky_signup.py <domain> <handle-or-username>
python3 scripts/pinterest_signup.py <domain> "<Business Name>"
python3 scripts/reddit_signup.py <domain> <username>
```

Run them via `nohup ... &`, poll the log file, don't block the foreground
Bash tool on them (they run for minutes and need to hold a live browser
window open for the human hand-off).

```bash
nohup python3 tools/social-setup/scripts/bsky_signup.py reviewtattoo.com reviewtattoo \
  > /tmp/.../bsky_reviewtattoo.log 2>&1 &
```

Each script:
1. Ensures `social@<domain>` CF Email Routing alias exists first (see
   `tools/social-setup/src/social_setup/email.py` — `ensure_social_alias`).
   Forwards to `jessetamburino@hotmail.com`.
2. Launches CloakBrowser via `social_setup.browser.launch_browser(domain,
   platform)` — persistent profile per (domain, platform) under
   `tools/social-setup/profiles/`.
3. Fills the signup form.
4. **Only pauses if it detects a genuine captcha widget** (`captcha_present()`
   helper — checks for reCAPTCHA/hCaptcha iframes, Pinterest's custom puzzle
   widget, etc). Prints `STATUS ... — need Jesse` and polls for up to 10 min
   waiting for it to clear.
5. Drives whatever post-signup onboarding wizard the platform shows
   (interest pickers, avatar prompts, "skip" buttons) on its own.
6. **Verifies success before writing to the vault** — never trust "the
   script didn't error" as proof of success. Bluesky: check the handle
   resolves via `resolveHandle` API. Pinterest: check the settings page's
   username field is non-empty. Reddit: check for a "log out" link on the
   logged-in homepage. An earlier version of `reddit_signup.py` skipped this
   and wrote bogus creds to the vault — always keep this gate.

### The "one at a time" operating rhythm

This is not optional politeness — it's how the session actually stabilized
after the early chaos of 5+ concurrent CloakBrowser windows all needing
Jesse's attention with no way to tell which was which:

1. Launch exactly **one** script that might need a captcha.
2. **Verify it's actually reached a state needing him** (process alive +
   log shows the captcha line) before saying anything to Jesse. Several
   times this session a captcha resolved on its own, or the process died
   before he could act, and claiming "window's up" when it wasn't burned
   his trust. Check, don't assume.
3. When he solves it and says so, check the log for `captcha cleared,
   resuming` — but see the gotcha below, this detection is inherently lossy.
4. If the script reports failure but the captcha *did* clear, the account
   was very likely still created — it just landed on a post-signup
   onboarding wizard the script's coarse success-check didn't recognize.
   Check via a fresh page load (`bsky_finish_onboarding.py` for Bluesky) or
   a settings-page check before assuming a real failure. This happened
   constantly — don't re-run a fresh signup attempt against an email that
   might already have a half-finished account; you'll hit "email taken" /
   "handle taken" and waste the captcha you just spent.
5. Only bring up the *next* window once the current one is fully resolved
   (success, confirmed failure, or explicitly parked).

## 3. Known per-platform gotchas

### Bluesky (`bsky_signup.py`)
- Landing modal → "Create account" click sometimes doesn't register on the
  first pass (timing/animation race). The script retries in a loop with a
  30s deadline — if you see `email_found=0`, that's what happened; just
  relaunch.
- Handle-taken: Bluesky shows "`<handle>.bsky.social` is not available".
  Fixed by retyping the input with a random 2-digit numeric suffix and
  re-checking — do NOT try to click the suggested-alternative rows, that
  selector approach was unreliable (DOM instability errors from
  CloakBrowser's humanized-click stability check).
- **Captcha-clear detection is unreliable** — the hCaptcha "I am human"
  widget/text can persist in the DOM (hidden) even after solving, so
  `captcha_present()` alone under-detects clearance. The script also checks
  whether the Next/Continue button has become *enabled* as a secondary
  signal — but this backfired once (falsely triggered "cleared" instantly,
  closing the window before Jesse could even look at it). If you see a
  captcha-wait resolve suspiciously fast, be suspicious of it, not of your
  own captcha-solving.
- Text selectors: Playwright's `locator('text="exact string"')` requires
  an **exact whole-element** text match — a substring like "is not
  available" inside a longer sentence will silently never match. Use
  `page.get_by_text("substring")` instead. This bug hit both the Bluesky
  handle-conflict retry AND Pinterest's puzzle-captcha detector before being
  caught — check any new `text="..."` selector you add for this trap.
- Occasionally (not consistently — same domain, different attempts, mixed
  results) Bluesky asks for an **email verification code** instead of/after
  the captcha step ("Step 2 of 3... Invalid verification code" if you don't
  supply one). This is NOT solvable by clicking a captcha — it needs a real
  6-digit code from the inbox. See §4 below for reading it; if that's not
  set up, this blocks the site's Bluesky signup and should be parked, not
  blindly retried (retrying just burns another captcha and often hits the
  same wall).
- Post-signup onboarding is a 2-4 step wizard (avatar picker → interests →
  "let's go"). `bsky_finish_onboarding.py` handles this for an
  already-created account that's stuck here — reads the password back out
  of a prior run's log file (never pass passwords as bash argv, see below).

### Pinterest (`pinterest_signup.py`)
- The birthdate `<input type="date">` is React-controlled. Plain
  `el.value = '...'` via `page.evaluate` gets silently dropped on some
  runs (worked once, failed the next — not reliably reproducible). Fixed
  by using the native property setter before dispatching the input event:
  ```js
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '1992-01-01');
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  ```
  Simulated keystrokes (`.fill()`, `.type()`) are worse — they collide with
  Chrome's own remembered-field autofill and produce garbage like
  `12/09/0101`. Always verify by reading `el.value` back after setting it.
- The "Create account" button stays disabled for a moment after the last
  field fills (async password-breach check). Clicking too early is a
  silent no-op. Script waits up to 10s polling `is_enabled()` before
  clicking — keep this if you touch the submit step.
- Pinterest's captcha is a **custom puzzle widget** ("Protecting your
  account" / "Start Puzzle"), not a standard reCAPTCHA/hCaptcha iframe —
  needs its own detection strings, and (see above) needs `get_by_text`
  substring matching, not `locator('text="..."')`.
- **Orphaned email reservations**: if an earlier attempt got far enough to
  submit the form before failing/being abandoned, Pinterest provisionally
  locks that email ("Deja vu! That email's taken") even though no full
  account exists and the browser session isn't logged in. There is no known
  quick recovery — tried both reusing the CloakBrowser profile's cookies
  (not logged in) and a manual login with the last-used password (wrong —
  each retry generates a fresh random password, so you don't know which
  one, if any, actually got saved server-side). If you hit this, mark the
  site's Pinterest as stuck and move on; don't keep burning captchas
  retrying, it just re-hits the same wall. Revisit later — the reservation
  may expire, or use Pinterest support.
- Screenshot filenames are domain-prefixed
  (`pin-{domain}-01-filled.png` etc) — an early version hardcoded
  `pin-broadway-*` regardless of which site was running, silently
  overwriting screenshots across concurrent runs. Already fixed; if you
  copy this script for a new platform, make sure the prefix is dynamic.

### Reddit (`reddit_signup.py`) — currently PARKED fleet-wide
- Reddit serves **two different signup UIs** unpredictably (old
  single-page form with `input[name=email]`/`id=regEmail`, vs. a newer
  stepped modal with bare `input[type=email]`/no name-or-id attrs, one
  "Continue" click apart per field). The script probes for whichever is
  actually visible each pass rather than assuming one — keep this if you
  touch it.
- The real, current blocker (as of 2026-08-13/14, multiple accounts across
  multiple domains): Reddit's email verification send **fails server-side**
  ("Something went wrong sending verification code...") after the email
  step, before username/password. Diagnosed via a network-response
  listener on `page.on("response", ...)` — the actual POST subsequently
  fired was to `/api/submit` (Reddit's post-submission endpoint) with an
  empty 200 body, i.e. something is being silently short-circuited, not
  cleanly rejected.
- Working theory: Reddit's anti-abuse system is detecting that every
  `social@<domain>` alias ultimately forwards to the same real inbox
  (`jessetamburino@hotmail.com` via CF Email Routing) across many
  automation-created accounts, and is blocking verification sends across
  that pattern. This is consistent with the separate, earlier-diagnosed
  issue where americastrikes.com's existing Reddit account (`
  AmericaStrikesDesk`, created weeks earlier) could never create an API
  app either — captcha-solve genuinely succeeds, but the real POST to
  Reddit's app-creation endpoint gets silently swallowed and something
  else fires instead. Two different symptoms, same likely root cause:
  Reddit shadow-restricting this fleet's account-creation pattern.
- **Recommendation:** don't spend more captchas on Reddit signups until
  this is addressed at a structural level — e.g. spacing signups out much
  further in time, or sourcing distinct real-looking destination inboxes
  instead of one shared hotmail catch-all. The API-key problem has a
  documented workaround (create the OAuth app on a different, established
  account — the app owner and the posting account don't have to match);
  no equivalent workaround is known yet for the verification-send failure.
- **Re-probed 2026-08-14 (weapontester.com):** captcha cleared fine this
  time, but immediately hit "too many requests" — a fresh rate-limit
  symptom, not the same verification-send failure as before. No creds
  landed in the vault (confirmed), so no orphaned-account risk on retry.
  Consistent with the same underlying pattern (Reddit throttling this
  fleet's signup traffic), just manifesting differently. **Parked again per
  Jesse 2026-08-14** — don't retry without spacing attempts out much
  further (hours/days, not minutes) or changing egress IP.

## 4. Reading verification codes from email

`social@<domain>` forwards to `jessetamburino@hotmail.com` (CF Email
Routing, see `tools/social-setup/src/social_setup/email.py`). The fleet's
shared email-read service is at `/mnt/encrypted/projects/email-client`
(FastAPI on `localhost:9200`).

**As of 2026-08-14 this is NOT wired up for the hotmail inbox** — the only
mailbox actually registered in that service is `ai@vitaetools.com` (check
via `GET /admin/mailboxes` with the master key). Registering
`jessetamburino@hotmail.com` there would need IMAP credentials (an app
password) added as a new mailbox — not done yet. Until it is, any
platform step that needs a real verification code (not just a captcha
click) is a genuine blocker that needs Jesse to check his hotmail inbox by
hand, or gets parked.

If you do wire it up, note two bugs already found and fixed on the
consumer side:
- `EmailClient` (`tools/social-lib/src/social_lib/email_client.py`) was
  sending `x-api-key: <key>` — the server's actual auth middleware
  (`email-client/api/auth.py`) expects `Authorization: Bearer <key>`. Fixed
  already; don't regress it.
- The master/break-glass key lives in the **running container's env**, not
  necessarily in a checked-in `.env`: `docker exec email-client-email-api-1
  printenv EMAIL_API_KEY`.

## 5. Bootstrapping a new site's socials — quick recipe

```bash
DOMAIN=example.com
BRAND="Example Brand Name"        # check sites/$DOMAIN/CLAUDE.md for the real brand/persona name
HANDLE=examplebrand               # lowercase, no spaces/punctuation — used for both bsky+pinterest username base

# 1. Email alias (idempotent — safe to always run)
python3 -c "
import sys; sys.path.insert(0, 'tools/social-setup/src')
from social_setup.email import ensure_social_alias
print(ensure_social_alias('$DOMAIN'))
"

# 2. Bluesky (one at a time — watch for captcha)
nohup python3 tools/social-setup/scripts/bsky_signup.py $DOMAIN $HANDLE > /tmp/bsky.log 2>&1 &
tail -f /tmp/bsky.log
# If it ends with "SIGNUP DID NOT SUCCEED" but a captcha WAS cleared along the way,
# don't assume real failure — try tools/social-setup/scripts/bsky_finish_onboarding.py
# <domain> <log-file-with-the-password-line> first (it reads the account back via the
# same persistent profile and finishes the onboarding wizard).

# 3. Pinterest (same pattern)
nohup python3 tools/social-setup/scripts/pinterest_signup.py $DOMAIN "$BRAND" > /tmp/pin.log 2>&1 &

# 4. Reddit — SKIP for now (see §3, fleet-wide blocker). Revisit once the
#    verification-send issue is understood/fixed.

# 5. Verify what actually landed in the vault
python3 -c "
import sys; sys.path.insert(0, 'tools/social-lib/src')
from social_lib.credentials import has_creds
print({p: has_creds('$DOMAIN', p) for p in ['bluesky','pinterest','reddit']})
"
```

Write each result into the registry the moment it lands (§6) — that's what
keeps a long multi-site sweep coherent instead of losing track of what was
actually done vs. assumed done. `social_registry.py worklist` is the
resume point if the session dies.

## 6. The registry — where state lives (READ AND WRITE THIS)

There is no markdown status table any more. `FLEET_SOCIAL_MAP.md` was deleted
2026-08-15 and its contents migrated into the **fleet social registry**: a
tracked JSON store at `tools/social-setup/registry/social.json`, served and
edited through the Fleet Dashboard's **Social** tab
(http://127.0.0.1:4754/#social) and its API (`/api/social/*`).

Why it changed: the markdown drifted constantly — sites were "corrected" in
prose footnotes but never in the table, per-cell reasons were smeared into one
shared Notes column, and there was no way for Jesse to tell the automation
"Instagram killed this account, redo it." The registry fixes all three.

**Use the CLI, not the JSON file.** Never hand-edit `social.json` — the API
validates, appends an audit event, and writes atomically.

```bash
R="python3 tools/social-setup/scripts/social_registry.py"

# ALWAYS start here: what is broken and what was never attempted
$R worklist

# Record a successful signup (upsert — no need to check if the row exists)
$R set reviewtattoo.com bluesky --status active --handle reviewtattoo.bsky.social --creds

# Record a failure with the reason the next run needs
$R set sinderella.org pinterest --status stuck \
     --note "orphaned email reservation — no known recovery, do not retry"

# A persona account (--create-persona registers the byline if it's new)
$R set americastrikes.com bluesky --persona "Sam Reyes" --status active \
     --handle sam-reyes.bsky.social --creds

# Read
$R list --site americastrikes.com
$R list --needs-attention
$R personas --site saveusfarms.com
$R events --limit 20
```

Statuses, and what each one means to you:

| status | meaning | your job |
|---|---|---|
| `active` | live and usable | nothing |
| `pending` | signup started, awaiting verification/onboarding | finish it |
| `stuck` | partially created, known platform bug | read the note before retrying |
| `blocked` | platform-level blocker (rate limit, shadow restriction) | don't burn captchas |
| `suspended` | platform banned it — **this is the spam-ban case** | re-provision |
| `closed` | account gone | re-provision |
| `not_started` | never attempted (absence of a row means this too) | provision |
| `excluded` | deliberately n/a for this site/persona | nothing |

`worklist` turns those into an `action` per row (`provision` / `unblock` /
`reprovision`) — that's the field to act on. Sites in a non-`active` bucket
(`positioning_tbd`, `adult_excluded`, `retired`) are excluded from the
provisioning worklist automatically, so you never have to re-derive the
"correctly excluded" lists.

**Write to the registry as you go, not at the end of a sweep.** A run that
dies mid-way should still have left the registry accurate for everything it
finished. This is the discipline the old markdown never enforced.

Sites populate from live `sites/*` discovery, so a newly onboarded domain
shows up in the Social tab with zero registry edits — it just has no account
rows yet.

### Known script bugs still open (2026-08-14 sweep)
- **Pinterest's settings-page username check races the page render** —
  `page.goto(..., wait_until="domcontentloaded")` followed immediately by
  reading `input[name="username"]` finds nothing on a fair number of runs
  even though the account is fully created and logged in (confirmed via
  screenshot — nav bar renders, body is still blank). Coarse check reports
  "SIGNUP DID NOT SUCCEED — no username found, no creds written" as a false
  negative. Recovery: reopen the persistent profile, `goto` the settings
  page with `wait_until="domcontentloaded"` + an explicit multi-second
  `time.sleep()` before reading the field (`networkidle` never fires on
  Pinterest — it keeps a live connection open). This recovery flow doesn't
  have a saved script yet the way Bluesky's `bsky_finish_onboarding.py`
  does; worth promoting to `pinterest_finish_signup.py` if this keeps
  happening (it did, repeatedly, this session).
- Bluesky's captcha-clear-then-fails-coarse-check pattern (documented above
  in §3) was the majority outcome this session, not the exception —
  `bsky_finish_onboarding.py` successfully recovered every one of them.
  Consider making the finish-onboarding call automatic inside
  `bsky_signup.py` itself right after a "SIGNUP DID NOT SUCCEED" following
  a captcha clear, instead of a manual follow-up step each time.

### Fleet-level findings that outlived the markdown

- **Pinterest soft-blocks by session/IP, not by domain.** After ~5 persona
  signups in ~20 minutes (americastrikes.com), every subsequent attempt
  failed identically: form fills fine, the submit click never registers, no
  error banner, no orphaned-email lock. Confirmed not domain-specific — the
  very next attempt on a different site (saveusfarms.com) failed the same
  way. **Switch VPN egress before any further Pinterest attempts**, and space
  them out.
- **Instagram automation is parked.** `scripts/instagram_signup.py` gets
  email/password/name/username and the Month/Day birthday dropdowns (custom
  click-widgets — need real mouse-coordinate clicks to bypass a pointer-events
  block; Instagram has no stable `name`/`placeholder`/`aria-label`, so fields
  are matched by input type + DOM order). **The Year dropdown is the
  blocker** — its option list needs scrolling to reach the target value, and
  Submit stays disabled until all three birthday fields are set. No captcha
  has ever been spent on it — every failure lands before that gate. Next step
  if resumed: dump the Year dropdown's real scroll container from the DOM
  rather than guessing.
- **LinkedIn is a different risk class.** It requires a real identity behind a
  profile, so a fabricated byline there is impersonation-adjacent, not just an
  editorial-voice question. Americastrikes' own `ops/board/personas.md` already
  bans a fake biography on social — treat that as fleet-wide. Get explicit
  per-persona go-ahead from Jesse before running any LinkedIn signup. The
  registry marks genuinely-real people with a `realPerson` flag on the persona;
  everyone else is pseudonymous.

### Open decisions (unresolved, ask Jesse)

- Does every persona get a social presence, or only the lead/most-active
  byline per site?
- LinkedIn: opt-in per persona, or skip entirely for pseudonymous bylines?
- 0daynews.com / sinderella.org Pinterest — orphaned email reservations with
  no known recovery path. Revisit, or mark `excluded` and stop looking at them?
