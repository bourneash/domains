#!/usr/bin/env python3
"""Generate Gatus's config.yaml from every sites/*/ops/smoke.yaml.

Fleet-wide: auto-discovers every site with an ops/smoke.yaml. This script
never edits a site's repo, it just re-renders those checks into Gatus's
format on every regen. A site with `enabled: false` in its smoke.yaml is
skipped entirely.

Run: python3 scripts/generate_config.py   (from tools/fleet-gatus/)
Then: docker compose up -d --build   (or `docker compose restart` if the
image is already built — Gatus hot-reloads config.yaml on change, no
rebuild needed for config-only edits).
"""
import glob
import json
import os

import yaml

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SITES_DIR = os.path.join(REPO_ROOT, "sites")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "config", "config.yaml")

CHECK_INTERVAL = "5m"          # real uptime detection, not a twice-daily digest
FAILURE_THRESHOLD = 2          # consecutive fails before alerting (kills single-blip noise)
SUCCESS_THRESHOLD = 2          # consecutive passes before "recovered"

# Channel for the fleet's own machinery (not a specific site's channel).
INTERNAL_CHANNEL = os.environ.get("SLACK_CHANNEL_FLEET", "#fleet-ops")

# --- The fleet's own services -------------------------------------------------
#
# Every check above this line watches the PRODUCT — public site URLs. Nothing
# watched the MACHINERY that produces it. 15 of 55 running fleet containers
# carry no healthcheck at all, so for those "the process is up" was the only
# liveness signal, and a wedged process (blocked event loop, dead upstream,
# full disk) reports as up forever. That is the same class of bug as the
# `pgrep -f supercronic` healthcheck that could never fail.
#
# These are request-level checks, which is the point: they prove the service
# still ANSWERS, not merely that its PID exists.
#
# `url` is resolved from inside the Gatus container, so each entry needs a
# network it shares with that service — see docker-compose.yml. Host-network
# services are reached via host.docker.internal.
INTERNAL_SERVICES = [
    {"name": "Fleet Dashboard", "url": "http://fleet-dashboard:4754/healthz"},
    {"name": "Data Hub API", "url": "http://datahub-api:4760/health"},
    {"name": "Data Hub Images API", "url": "http://datahub-images-api:4770/health"},
    {"name": "Product Feed API", "url": "http://product-feed-api:4761/health"},
    {"name": "Media Gen API", "url": "http://host.docker.internal:4780/health"},
    {"name": "Dev Sandboxes panel", "url": "http://dd-panel:7777/api/health"},
]

# Deliberately NOT here: cf-stats, gh-stats, amz-stats, datahub-collector,
# datahub-images-collector, product-feed-collector, cf-grafana-ingest. They are
# batch collectors with no HTTP surface at all, so an HTTP probe cannot say
# anything about them. They need a heartbeat/freshness signal instead (the shape
# tools/cron-roles' engineer pulse already uses) — listing them here with a
# fake check would be worse than the current honest gap.


def discover_sites():
    """Every sites/<domain>/ops/smoke.yaml."""
    pattern = os.path.join(SITES_DIR, "*", "ops", "smoke.yaml")
    return sorted(os.path.basename(os.path.dirname(os.path.dirname(p))) for p in glob.glob(pattern))


def load_smoke_yaml(site):
    path = os.path.join(SITES_DIR, site, "ops", "smoke.yaml")
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    data.setdefault("enabled", True)
    return data


def slack_alert_body(channel):
    """Custom-provider body posting through the fleet's existing Slack bot
    token + each site's existing channel (chat.postMessage) — reuses the
    fleet's current Slack app membership/channel wiring instead of standing
    up new webhooks."""
    payload = {
        "channel": channel,
        "attachments": [{
            "color": "#e01e5a",
            "mrkdwn_in": ["text"],
            "text": (
                "*[ENDPOINT_GROUP] — [ENDPOINT_NAME] — [ALERT_TRIGGERED_OR_RESOLVED]*\\n"
                "[ALERT_DESCRIPTION]\\n[RESULT_ERRORS]"
            ),
        }],
    }
    return json.dumps(payload)


def build_endpoints(sites):
    endpoints = []
    skipped_sites = []
    skipped_checks = []  # (site, label) — checks Gatus can't represent yet (see below)
    for site in sites:
        cfg = load_smoke_yaml(site)
        if not cfg.get("enabled", True):
            skipped_sites.append(site)
            continue
        apex = cfg["apex"]
        channel = cfg.get("slack", {}).get("channel")
        for check in cfg.get("checks", []):
            name = check["label"]
            path = check["path"]
            # One check type Gatus's HTTP-status conditions can't
            # replicate: `module_graph` (currently only 0xroulette.com's
            # /play) walks the real Vite dynamic-import chunk graph rather
            # than asserting on a status code. That depth is exactly the
            # "deep content check" phase not built yet (see README "Next
            # steps") — skip it here rather than silently mis-representing
            # it as an HTTP check. It currently has NO automated coverage.
            if check.get("type", "http_status") != "http_status":
                skipped_checks.append((site, name))
                continue
            expect = check["expect"]
            endpoint = {
                "name": name,
                "group": apex,
                "url": f"https://{apex}{path}",
                "interval": CHECK_INTERVAL,
                "conditions": [f"[STATUS] == {expect}"],
            }
            if str(expect).startswith("3"):
                # e.g. /go/* affiliate redirects (expect: 302) — without this
                # the client follows the redirect and asserts on the final
                # destination's 200, not the redirect itself.
                endpoint["client"] = {"ignore-redirect": True}
            endpoint["alerts"] = [{
                "type": "custom",
                "enabled": True,
                "failure-threshold": FAILURE_THRESHOLD,
                "success-threshold": SUCCESS_THRESHOLD,
                "send-on-resolved": True,
                "provider-override": {
                    "body": slack_alert_body(channel),
                },
            }]
            endpoints.append(endpoint)
    return endpoints, skipped_sites, skipped_checks


def build_internal_endpoints():
    """Checks for the fleet's own services, grouped separately from the sites."""
    out = []
    for svc in INTERNAL_SERVICES:
        out.append({
            "name": svc["name"],
            "group": "fleet-internal",
            "url": svc["url"],
            "interval": CHECK_INTERVAL,
            "conditions": ["[STATUS] == 200"],
            "alerts": [{
                "type": "custom",
                "enabled": True,
                "failure-threshold": FAILURE_THRESHOLD,
                "success-threshold": SUCCESS_THRESHOLD,
                "send-on-resolved": True,
                "provider-override": {"body": slack_alert_body(INTERNAL_CHANNEL)},
            }],
        })
    return out


def main():
    sites = discover_sites()
    endpoints, skipped_sites, skipped_checks = build_endpoints(sites)
    internal = build_internal_endpoints()
    endpoints = internal + endpoints
    config = {
        "storage": {
            "type": "sqlite",
            "path": "/data/data.db",
            "maximum-number-of-results": 200,
            "maximum-number-of-events": 50,
        },
        "alerting": {
            "custom": {
                "url": "https://slack.com/api/chat.postMessage",
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer ${SLACK_BOT_TOKEN}",
                },
            },
        },
        "endpoints": endpoints,
    }
    live = len(sites) - len(skipped_sites)
    header_lines = [
        "# GENERATED FILE — do not edit by hand.",
        "# Regenerate with: python3 scripts/generate_config.py",
        "# Source of truth for checks is each site's own sites/<domain>/ops/smoke.yaml",
        f"# Auto-discovered {live} sites, {len(endpoints)} endpoints "
        f"({len(internal)} of them the fleet's own services).",
    ]
    if skipped_sites:
        header_lines.append(f"# Skipped (enabled: false): {', '.join(skipped_sites)}")
    if skipped_checks:
        detail = "; ".join(f"{s}: {n}" for s, n in skipped_checks)
        header_lines.append(f"# Skipped (non-http_status check, not yet supported here): {detail}")
    header = "\n".join(header_lines) + "\n\n"
    with open(OUT_PATH, "w") as f:
        f.write(header)
        yaml.safe_dump(config, f, sort_keys=False, width=100)
    print(f"Wrote {OUT_PATH} — {len(endpoints)} endpoints across {live} sites "
          f"(+{len(internal)} internal services)")
    if skipped_sites:
        print(f"  skipped sites (enabled: false): {', '.join(skipped_sites)}")
    if skipped_checks:
        for s, n in skipped_checks:
            print(f"  skipped check (non-http_status, not yet supported): {s} — {n}")


if __name__ == "__main__":
    main()
