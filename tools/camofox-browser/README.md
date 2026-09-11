# camofox-browser

Fleet-local runtime for [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser),
an agent-oriented REST wrapper around the Firefox-based Camoufox anti-detection
browser. It is an additional browser tool; it does not replace CloakBrowser.

The upstream package is pinned to `@askjo/camofox-browser@1.14.0`. Runtime data
(profiles, traces, uploads, logs, and the PID file) stays under `out/` and is
gitignored. Crash-report telemetry is disabled. The server binds to loopback.

Live results and current limitations are recorded in [TRIALS.md](./TRIALS.md).

## Install and run

```bash
cd tools/camofox-browser
npm ci
bin/camofox start
bin/camofox status
bin/camofox stop
```

On first install npm downloads the Camoufox browser bundle (roughly 300 MB).
Node 22 or newer is required.

By default browser traffic uses the fleet's rotating VPN proxy at
`127.0.0.1:8183`, matching the current X signup experiment. Override it with
`CAMOFOX_PROXY_PORT`, or run with `CAMOFOX_PROXY=off` for direct egress. Confirm
the exit country before an account signup because port 8183 rotates regions.

For a visible local window, run with `CAMOFOX_INTERACTIVE=desktop`. Normal agent
operation is headless.

## Agent API

The API is available at `http://127.0.0.1:9377`; upstream interactive docs are
served at `/docs` and OpenAPI JSON at `/openapi.json`.

```bash
# Create an isolated, persistent session/tab.
curl -sS -X POST http://127.0.0.1:9377/tabs \
  -H 'content-type: application/json' \
  -d '{"userId":"girlpain.com::x","sessionKey":"signup","url":"https://x.com/i/flow/signup","trace":true}'

# Read the accessibility snapshot (replace TAB_ID).
curl -sS 'http://127.0.0.1:9377/tabs/TAB_ID/snapshot?userId=girlpain.com%3A%3Ax'

# Interact using the current snapshot's stable element ref.
curl -sS -X POST http://127.0.0.1:9377/tabs/TAB_ID/click \
  -H 'content-type: application/json' \
  -d '{"userId":"girlpain.com::x","ref":"e1"}'
```

Take a new snapshot after navigation or a modal change because element refs can
change. Sessions persist cookies/local storage by hashed `userId`, so use one
stable ID per domain and platform. Never put SMSPool keys, passwords, or SMS
codes in command-line arguments or committed files.

## X signup trial contract

Before renting a number:

1. Verify the selected proxy is in the US.
2. Start Camofox and prove that it reaches X's signup chooser.
3. Confirm snapshots and click/type work on the live flow.

Only then rent one SMSPool Twitter number. If the flow cannot reach the SMS code
screen, cancel the order immediately. Persist credentials to Vaultwarden and
mark the fleet social registry active only after re-reading the live account's
actual handle. This preserves the same verify-before-claim discipline as
`tools/social-setup/scripts/x_signup.py`.

## Security notes

- The server binds to `127.0.0.1`, so unauthenticated control routes are not
  exposed to the LAN.
- Upstream crash telemetry is explicitly disabled.
- Profiles contain authenticated cookies and are ignored by git.
- `/evaluate` can execute JavaScript in a page. Treat access to port 9377 as
  browser-session access.
