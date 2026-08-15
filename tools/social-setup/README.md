# social-setup

Automated social media account provisioner for the domain portfolio. Creates accounts, configures profiles, captures API keys, and writes credential files to each site's `ops/social/` directory.

> Current-generation provisioning (Vaultwarden creds + per-platform scripts in
> `scripts/`) is documented in the `skills-domain-social-setup` skill. The CLI
> described under "Usage" below is the older flat-file generation.

## Registry — fleet social state

`registry/social.json` is the tracked source of truth for **which accounts
exist and what state they're in**, across every site, platform, and writer
persona. It replaced the hand-maintained `FLEET_SOCIAL_MAP.md` on 2026-08-15.

- **UI:** Fleet Dashboard → **Social** tab (http://127.0.0.1:4754/#social) —
  matrix / list / persona views with search, grouping, sorting and filtering.
- **API:** `/api/social/*` on the same panel (see `tools/fleet-dashboard/server/social.js`).
- **CLI:** `scripts/social_registry.py` — the wrapper the skills and signup
  scripts use.
- **Audit trail:** every mutation appends to `registry/social-events.jsonl`.

```bash
R="python3 tools/social-setup/scripts/social_registry.py"
$R worklist                                              # what needs doing
$R set <site> <platform> --status active --handle <h> --creds
$R set <site> <platform> --status suspended --note "why" # e.g. spam ban
$R list --needs-attention
$R personas --site saveusfarms.com
```

Statuses: `active` `pending` `stuck` `blocked` `suspended` `closed`
`not_started` `excluded`; the registry derives a `provision` / `unblock` /
`reprovision` action from them. Site buckets (`active`, `positioning_tbd`,
`adult_excluded`, `retired`) keep non-eligible domains out of the worklist.
Sites are discovered from `sites/*` automatically.

Credentials themselves stay in Vaultwarden — the registry only records whether
they exist. Never hand-edit `social.json`; go through the CLI/API so writes are
validated, atomic, and logged.

`registry/` was seeded by `tools/fleet-dashboard/scripts/import-social-map.js`,
kept in-tree as provenance for the migration.

## Platforms

Bluesky, Reddit, Pinterest, X (Twitter), Instagram, TikTok, Facebook Page

## Install

```bash
cd tools/social-setup
pip install -e .
```

## Usage

```bash
# Provision all platforms for a domain
social-setup provision americastrikes.com

# Specific platforms only
social-setup provision ultrarough.com --platforms bluesky,reddit,pinterest

# Check what's set up
social-setup status americastrikes.com

# Status across all sites
social-setup status --all

# Resume a partial run
social-setup provision americastrikes.com --resume

# Re-provision (overwrite existing creds)
social-setup provision americastrikes.com --platforms bluesky --force
```

## How it works

1. Ensures `social@<domain>` email alias via CF Email Routing
2. Reads `CLAUDE.md` for brand context (name, bio, category)
3. For each platform, launches CloakBrowser (anti-detect Chromium):
   - Auto-fills signup forms
   - Pauses at phone/CAPTCHA gates for manual completion
   - Configures profile (bio, avatar, URL)
   - Captures API keys where available
4. Writes credentials to `sites/<domain>/ops/social/.<platform>-creds` (chmod 600)

## Credential files

Written to each site's existing `ops/social/` directory. All files chmod 600 and gitignored.

| Platform | File | Key fields |
|---|---|---|
| Bluesky | `.bluesky-creds` | `BLUESKY_HANDLE`, `BLUESKY_DID`, `BLUESKY_PASSWORD` |
| Reddit | `.reddit-creds` | `REDDIT_USERNAME`, `REDDIT_PASSWORD`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| Pinterest | `.pinterest-creds` | `PINTEREST_USERNAME`, `PINTEREST_PASSWORD`, `PINTEREST_APP_ID` |
| X | `.x-creds` | `X_USERNAME`, `X_PASSWORD`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `X_BEARER_TOKEN` |
| Instagram | `.instagram-creds` | `INSTAGRAM_USERNAME`, `INSTAGRAM_PASSWORD` |
| TikTok | `.tiktok-creds` | `TIKTOK_USERNAME`, `TIKTOK_PASSWORD`, `TIKTOK_CLIENT_KEY` |
| Facebook | `.facebook-creds` | `FB_PAGE_NAME`, `FB_PAGE_ID`, `FB_ACCESS_TOKEN` |

## Dependencies

- `cloakbrowser` — anti-detect Chromium (Playwright-compatible)
- `click` — CLI
- `httpx` — CF API calls
- `rich` — terminal UI
