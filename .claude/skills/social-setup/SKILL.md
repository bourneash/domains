---
name: social-setup
description: Provision social media accounts for domain sites — create accounts on X, Instagram, Facebook, Reddit, TikTok, Bluesky, Pinterest. Drive the browser via Playwright MCP, configure profiles, capture API keys, write credential files to ops/social/. Use when setting up social media for any domain in the portfolio.
---

# Social Media Account Provisioner

You (Claude) are the operator. You drive the browser via Playwright MCP tools, fill forms, take screenshots at gates, and ask Jesse only when a human is truly needed (CAPTCHA, phone verification, email confirmation codes).

## Architecture

- **Browser automation:** Playwright MCP tools (`browser_navigate`, `browser_fill_form`, `browser_click`, `browser_snapshot`, `browser_take_screenshot`)
- **Config/creds/email:** Python modules at `tools/social-setup/` — call via Bash
- **Credential output:** `sites/<domain>/ops/social/.<platform>-creds` (chmod 600)
- **Email for signups:** `social@<domain>` (CF Email Routing → jessetamburino@hotmail.com)

## Before starting

```bash
cd /home/jesse/projects/domains/tools/social-setup
pip install -e . 2>/dev/null  # ensure Python modules available
```

### Extract brand context (run via Bash)

```python
from social_setup.config import extract_brand
brand = extract_brand('<domain>')
# brand.name, brand.bio_short, brand.category, brand.url, brand.avatar_path
```

### Ensure email alias (run via Bash)

```python
from social_setup.email import ensure_social_alias
created, msg = ensure_social_alias('<domain>')
```

### Generate password (run via Bash)

```python
from social_setup.passwords import generate
password = generate()
```

### Write credentials (run via Bash)

```python
from social_setup.credentials import write_creds
write_creds(brand.site_root, '<platform>', {'KEY': 'value', ...})
```

## Platform provisioning order

Do easiest first: **Bluesky → Reddit → Pinterest → X → Instagram → TikTok → Facebook**

## Per-platform playbook

### Bluesky
1. Navigate to `https://bsky.app` → find "Create account" link
2. Fill email, password, date of birth, handle
3. **CAPTCHA gate** — screenshot and ask Jesse to solve in a separate browser tab, OR try to solve
4. After account created: use AT Protocol API via Bash to set profile:
   ```python
   import httpx
   session = httpx.post('https://bsky.social/xrpc/com.atproto.server.createSession',
       json={'identifier': handle, 'password': password})
   token = session.json()['accessJwt']
   # putRecord for app.bsky.actor.profile
   ```
5. Create app password via API for bot access
6. Write `.bluesky-creds`

### Reddit
1. Navigate to `https://www.reddit.com/register`
2. Fill email, username (`<Brand>Desk`), password
3. Usually email-verify only (no phone) — check inbox
4. After signup: go to `https://www.reddit.com/prefs/apps` → create script-type app
5. Capture client_id and client_secret from the created app
6. Write `.reddit-creds`

### Pinterest
1. Navigate to `https://www.pinterest.com/business/create/`
2. Fill email, password, business name, website URL
3. Email verify if needed
4. After signup: set profile bio, claim website
5. Developer portal: `https://developers.pinterest.com` → create app
6. Write `.pinterest-creds`

### X (Twitter)
1. Navigate to `https://x.com/i/flow/signup`
2. Fill name, email, date of birth
3. **Phone verify gate** — screenshot, ask Jesse to enter his phone number
4. Set password, choose username
5. After signup: configure profile (bio, avatar, URL)
6. Developer portal: `https://developer.x.com` → Free tier → create project + app
7. **Ask Jesse to paste API keys** (dev portal requires manual key copy)
8. Write `.x-creds`

### Instagram
1. Navigate to `https://www.instagram.com/accounts/emailsignup/`
2. Fill email, full name, username, password
3. **Phone verify gate** — ask Jesse
4. After signup: edit profile (bio, URL, avatar)
5. Switch to Professional/Business account
6. Write `.instagram-creds`

### TikTok
1. Navigate to `https://www.tiktok.com/signup`
2. Use email signup method
3. **Phone verify gate** — ask Jesse
4. After signup: edit profile, switch to Business account
5. Dev portal: `https://developers.tiktok.com` (gated, may need to skip)
6. Write `.tiktok-creds`

### Facebook Page
1. Requires Jesse's personal Facebook account — ask if he has one
2. Navigate to `https://www.facebook.com/pages/creation/`
3. Fill page name, category, bio
4. Configure page settings (website URL, contact email)
5. Dev portal for Graph API (requires Business Verification — usually skip for now)
6. Write `.facebook-creds`

## Human gate protocol

When you hit a step requiring human action (CAPTCHA, phone code, email code):
1. Take a screenshot with `browser_take_screenshot`
2. Tell Jesse exactly what's needed ("Enter the CAPTCHA in the browser", "Check social@domain inbox for code")
3. Ask Jesse to provide the needed info OR tell you when done
4. Continue after

**CAPTCHAs:** Jesse is fine solving captchas — just screenshot and throw them to him. The browser is visible on his screen; he can click directly in the Playwright browser window. Don't waste time trying to solve visual puzzles yourself.

## Credential file format

All files are `KEY=VALUE`, one per line, chmod 600:
```
PLATFORM_USERNAME=value
PLATFORM_PASSWORD=value
PLATFORM_EMAIL=social@domain.com
PLATFORM_API_KEY=value
```

## Rules

- **contact@ is the default outward-facing email** — social@ is for platform signups only
- **Never batch CF email sends** — serialize per site
- **Never invent brand positioning** — read CLAUDE.md for voice/bio
- **Each platform is independent** — one failure doesn't block others
- **Check for existing creds before starting** a platform:
  ```python
  from social_setup.credentials import has_creds
  has_creds(brand.site_root, 'bluesky')  # True/False
  ```

## CloakBrowser provisioner (preferred for signups)

CloakBrowser (anti-detect Chromium) should be used for all social media signups. It runs as a single-session Python script with humanize=True and persistent profiles.

```bash
# Run a single platform signup with CloakBrowser
python3 -m social_setup.cloak_provision reddit ultrarough.com
python3 -m social_setup.cloak_provision pinterest ultrarough.com
python3 -m social_setup.cloak_provision x americastrikes.com
```

The script:
- Opens CloakBrowser with anti-fingerprinting + human-like timing
- Navigates the signup flow automatically
- Pauses at human gates (captcha, phone verify) with screenshot + prompt
- Saves creds + updates setup-log.json on success
- Uses persistent profiles so cookies survive across runs

Screenshots land in `/home/jesse/projects/domains/.cloak-screenshots/` — read them to see what's on screen.

For platforms not yet in `cloak_provision.py`, use the Playwright MCP tools as fallback (Bluesky worked fine with those since it's less hostile to automation).
