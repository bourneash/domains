# social-setup

Automated social media account provisioner for the domain portfolio. Creates accounts, configures profiles, captures API keys, and writes credential files to each site's `ops/social/` directory.

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
