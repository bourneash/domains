# Social Media Account Provisioner — Design Spec

**Date:** 2026-06-02
**Tool:** `tools/social-setup/`
**Skill:** `social-setup`

## Purpose

Automated social media account creation and profile configuration for the domain portfolio. Uses CloakBrowser (anti-detect Chromium with Playwright API) in guided semi-auto mode: automates form-filling, profile setup, and API key applications; pauses at phone verification / CAPTCHA gates for manual completion.

## Platforms

| Platform | Email signup? | Phone required? | API keys? | Automation level |
|---|---|---|---|---|
| X / Twitter | Yes | Usually (SMS/email) | Free tier (1500 posts/mo) | Semi-auto |
| Instagram | Yes | Yes (SMS) | Basic Display only | Semi-auto |
| Facebook Page | Needs personal acct | Yes | Graph API | Semi-auto |
| Reddit | Yes | Optional | Script app type | Near-full |
| TikTok | Yes | Yes (SMS) | Dev portal, gated | Semi-auto |
| Bluesky | Yes | No | AT Protocol, open | Fully auto |
| Pinterest | Yes | No | Business API | Near-full |

## Architecture

```
tools/social-setup/
├── pyproject.toml
├── src/social_setup/
│   ├── __init__.py
│   ├── cli.py                  # Click CLI entry point
│   ├── config.py               # Brand context from CLAUDE.md + ops/
│   ├── email.py                # CF Email Routing alias management
│   ├── credentials.py          # Read/write per-site cred files
│   ├── browser.py              # CloakBrowser lifecycle + human-gate helper
│   ├── passwords.py            # Secure password generation
│   └── platforms/
│       ├── __init__.py
│       ├── base.py             # PlatformProvisioner ABC
│       ├── x.py
│       ├── instagram.py
│       ├── facebook.py
│       ├── reddit.py
│       ├── tiktok.py
│       ├── bluesky.py
│       └── pinterest.py
├── profiles/                   # Persistent CloakBrowser profiles (gitignored)
└── README.md
```

## Provisioning flow

### Step 1 — Email alias

Check CF Email Routing for `social@<domain>`. Create if missing, forwarding to `jessetamburino@hotmail.com`. Uses existing CF API token from `/home/jesse/projects/domains/.env`.

### Step 2 — Brand context

Read `sites/<domain>/CLAUDE.md` to extract:
- Site name and one-line description
- Brand voice keywords
- Target bio text (from ops/roles/social*.md if it exists)
- Existing credential files (to skip provisioned platforms)

### Step 3 — Per-platform provisioning

For each platform, the provisioner:

1. **Launch** CloakBrowser with persistent profile at `profiles/<domain>/<platform>/`
   - `humanize=True` for natural interaction timing
   - Headless=False (user needs to see the browser for manual steps)
2. **Navigate** to signup URL
3. **Fill** email (`social@<domain>`), generated password, display name, bio
4. **Pause** at human-gate (phone verify, CAPTCHA, email confirm):
   ```
   ┌─────────────────────────────────────────────────┐
   │  X requires phone verification.                  │
   │  Complete the step in the browser window.         │
   │  Press Enter when done...                         │
   └─────────────────────────────────────────────────┘
   ```
   For email confirmation: tool checks inbox via CF catch-all → jessetamburino@hotmail.com. User can paste the verification code/link when prompted.
5. **Configure** profile: upload avatar, set header, write bio, set location/URL, adjust privacy settings
6. **API keys** (where applicable): navigate to developer portal, create app/project, capture keys
7. **Write** credentials to `sites/<domain>/ops/social/.<platform>-creds` (chmod 600)
8. **Log** result to `sites/<domain>/ops/social/setup-log.json`

### Step 4 — Summary

Print status table:
```
americastrikes.com — Social Media Setup
────────────────────────────────────────
  X (Twitter)     ✓ created    @AmericaStrikes     API keys: ✓
  Bluesky         ✓ created    @americastrikes.com API keys: n/a (AT Protocol)
  Reddit          ✓ created    u/AmericaStrikesDesk API keys: ✓
  Pinterest       ✓ created    americastrikes      API keys: ✓
  Instagram       ⏸ paused     needs phone verify
  Facebook        — skipped    no personal account linked
  TikTok          ⏸ paused     needs phone verify
```

## CLI interface

```bash
# Provision all platforms for a domain
social-setup provision americastrikes.com

# Specific platforms
social-setup provision americastrikes.com --platforms x,bluesky,reddit

# Check status
social-setup status americastrikes.com

# Status across all sites
social-setup status --all

# Resume partial run
social-setup provision americastrikes.com --resume
```

## Credential file format

Matches existing per-site conventions. Example `ops/social/.x-creds`:
```bash
X_API_KEY=abc123
X_API_SECRET=def456
X_ACCESS_TOKEN=ghi789
X_ACCESS_SECRET=jkl012
X_BEARER_TOKEN=mno345
X_USERNAME=AmericaStrikes
X_PASSWORD=<generated-strong-password>
X_EMAIL=social@americastrikes.com
```

All cred files: chmod 600, gitignored via existing `.*-creds` patterns.

## Platform-specific notes

### X / Twitter
- Username: derived from domain (e.g., `AmericaStrikes`, `UltraRough`)
- Bio: extracted from CLAUDE.md brand description, truncated to 160 chars
- Developer portal: create project + app under Free tier, capture all 5 key types
- Avatar: use site's `favicon.svg` or `og-image.png` if available

### Instagram
- Username: matches X where possible
- Business account type preferred (needed for API access later)
- Link in bio → site URL
- Avatar: same as X

### Facebook
- Creates a Page (not personal profile) — requires an existing personal Facebook account
- Page name: site brand name
- Category: depends on site type (News for americastrikes, Product/Service for ultrarough)
- If no personal account exists, logs instruction and skips

### Reddit
- Username: `<Brand>Desk` or `<Brand>Official` convention
- Email verify only (no phone needed)
- Immediately creates script-type OAuth app at reddit.com/prefs/apps
- User agent: `<platform>:<app_id>:v1.0 (by /u/<username>)`

### TikTok
- Business account type
- Developer portal registration for API access
- May require manual approval period — tool logs status

### Bluesky
- Fully automated: email-only signup, no phone, no CAPTCHA
- Uses AT Protocol directly for profile setup (no browser needed after account creation)
- Custom handle: `<brand>.bsky.social` or custom domain later
- App password generated for API access

### Pinterest
- Business account (free, needed for API)
- Board creation: one default board matching site topic
- Website claim: adds site URL for rich pins

## Password policy

Generated via Python `secrets` module:
- 24 characters
- Mixed case + digits + symbols
- Unique per platform per domain
- Stored only in the cred file (no central password store)

## Email routing

Uses existing CF API token. Creates `social@<domain>` alias if missing:
- Forward destination: `jessetamburino@hotmail.com`
- Serialized creation (per feedback: don't batch CF email sends)
- Idempotent: checks existing rules before creating

## Idempotency

- Checks for existing cred files before starting a platform
- `--resume` flag picks up from last logged state in `setup-log.json`
- `--force` flag re-provisions even if creds exist
- Each platform provisioner is independent — one failure doesn't block others

## Setup log format

`sites/<domain>/ops/social/setup-log.json`:
```json
{
  "domain": "americastrikes.com",
  "email": "social@americastrikes.com",
  "platforms": {
    "x": {
      "status": "created",
      "username": "AmericaStrikes",
      "created_at": "2026-06-02T14:30:00Z",
      "api_keys": true,
      "cred_file": "ops/social/.x-creds"
    },
    "bluesky": {
      "status": "created",
      "handle": "americastrikes.bsky.social",
      "created_at": "2026-06-02T14:31:00Z",
      "api_keys": true,
      "cred_file": "ops/social/.bluesky-creds"
    }
  }
}
```

## Skill: `social-setup`

Claude Code skill at project level. Invoked via `/social-setup`. Wraps the CLI:
- `social-setup provision <domain>` — runs the provisioning flow
- `social-setup status` — checks account inventory across portfolio
- Knows to read site CLAUDE.md for brand context
- Can create CF email aliases directly if the CLI isn't installed yet

## Test plan

1. **AmericaStrikes** (first target): provision Bluesky (fully auto, validates pipeline end-to-end), then Reddit (near-full auto), then X (semi-auto, validates human-gate flow)
2. **UltraRough** (validation target): provision same platforms, confirm brand context extraction produces different bios/usernames
3. Verify cred files land in correct locations with correct permissions
4. Verify idempotent re-run skips already-provisioned platforms

## Dependencies

- `cloakbrowser` (pip) — anti-detect browser
- `click` — CLI framework
- `httpx` — CF API calls (async-capable)
- Python 3.11+
- Existing: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from `.env`
