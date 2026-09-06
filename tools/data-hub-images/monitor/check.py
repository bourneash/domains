#!/usr/bin/env python3
"""data-hub-images health + VPN-integrity monitor.

Runs in the collector container (has SLACK_BOT_TOKEN via env_file, and reaches
datahub-images-api:4770 + vpn-us/vpn-eu:8888 on the vpn-proxy_default network).
Stdlib only. Posts to Slack ONLY on a status change (bit-flip), like fleet-smoke.

Checks (severity):
  1. API /health reachable + db:true .......................... CRITICAL
  2. >=1 VPN exit reported by /health ......................... CRITICAL (both) / WARNING (one)
  3. VPN INTEGRITY — the load-bearing one:
       DIRECT_IP  = our real public egress (no proxy)
       VPN_IP     = egress THROUGH each configured VPN exit
     At least one VPN exit must be usable; every usable exit must differ from
     DIRECT_IP ................................................. CRITICAL if none usable or any bypasses
     This discovers the home IP dynamically every run, so it does not depend on
     the broker's static DEFAULT_HOME_IPS list (which drifts).
  4. EGRESS LEAK — no recorded image-fetch exit_ip == DIRECT_IP  CRITICAL if any
  5. Collector freshness — a fetch/pull within FRESH_MIN ....... WARNING if stale
  6. Serve path — fetch bytes of a real pool image ............. WARNING if broken

Usage:
  python check.py            # run checks, post Slack on state change
  python check.py --dry-run  # print result, never post, never touch state
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

BROKER = os.environ.get("DATAHUB_IMAGES_MONITOR_BROKER", "http://datahub-images-api:4770")
PROXY_US = os.environ.get("DATAHUB_IMAGES_PROXY_US", "http://vpn-us:8888")
PROXY_EU = os.environ.get("DATAHUB_IMAGES_PROXY_EU", "http://vpn-eu:8888")
STATE_PATH = os.environ.get("DATAHUB_IMAGES_MONITOR_STATE", "/data/monitor-state.json")
FRESH_MIN = int(os.environ.get("DATAHUB_IMAGES_MONITOR_FRESH_MIN", "90"))
SLACK_TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")
# Fleet infrastructure alerts (VPN exits, collector health) belong in the
# shared ops channel, not in any one site's channel.
SLACK_CHANNEL = os.environ.get("DATAHUB_IMAGES_ALERT_CHANNEL") or "domain-ops"
IP_ECHOS = ["https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.me/ip"]

CRITICAL, WARNING, OK = "critical", "warning", "ok"


def _get(url, proxy=None, timeout=12, raw=False):
    if proxy:
        handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})]
    else:
        # Empty ProxyHandler forces a truly DIRECT request — ignore any ambient
        # HTTP_PROXY/HTTPS_PROXY env, so the "home IP" lookup can't be silently
        # routed through a proxy and break the leak comparison.
        handlers = [urllib.request.ProxyHandler({})]
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers={"User-Agent": "dhi-monitor/1.0"})
    with opener.open(req, timeout=timeout) as r:
        data = r.read()
        return (data, r.headers) if raw else json.loads(data.decode())


def _echo_ip(proxy=None):
    """Return our egress IP as seen externally, via proxy or direct. None on failure."""
    for url in IP_ECHOS:
        try:
            data, _ = _get(url, proxy=proxy, timeout=12, raw=True)
            ip = data.decode().strip()
            if ip and ip.count(".") == 3:
                return ip
        except Exception:
            continue
    return None


def _vpn_integrity_findings(direct_ip, vpn):
    """Check all exits and return findings for the independent egress check."""
    vpn_ips = {}
    for node, proxy in (("us", PROXY_US), ("eu", PROXY_EU)):
        if proxy:
            vpn_ips[node] = _echo_ip(proxy=proxy)
    usable_vpn_ips = {node: ip for node, ip in vpn_ips.items() if ip}
    findings = []
    if direct_ip is None and not usable_vpn_ips:
        findings.append((WARNING, "IP-echo services unreachable — could not verify VPN egress this run"))
    elif not usable_vpn_ips:
        findings.append((CRITICAL, f"VPN egress dead: proxied lookup failed while direct works (home IP {direct_ip}) — fetches would leak or fail"))
    elif direct_ip is None:
        findings.append((WARNING, f"could not determine home IP (direct lookup failed); VPN exits: {', '.join(usable_vpn_ips.values())}"))

    for node, vpn_ip in usable_vpn_ips.items():
        if direct_ip is not None and vpn_ip == direct_ip:
            findings.append((CRITICAL, f"VPN BYPASS/LEAK: proxied {node} egress == direct egress ({vpn_ip}) — traffic is NOT going through the VPN"))
        # consistency: broker's probe should agree with our independent lookup
        if vpn.get(node) and vpn_ip != vpn.get(node):
            findings.append((WARNING, f"VPN IP mismatch: monitor sees {vpn_ip} via vpn-{node}, broker /health reports {vpn.get(node)}"))
    return findings


def run_checks():
    findings = []  # (severity, message)

    def add(sev, msg):
        findings.append((sev, msg))

    # 1. API + DB
    # /health now probes each VPN exit across a fallback chain of IP-echo
    # services (see vpn.probe_exit_ip) run concurrently per exit, so a fully
    # dead exit can take longer than the old single-URL probe did. Give it
    # more headroom than the default 12s so that worst case doesn't get
    # mistaken for "API /health unreachable" instead of the more useful
    # per-exit finding.
    health = None
    try:
        health = _get(f"{BROKER}/health", timeout=30)
        if not health.get("db", False):
            add(CRITICAL, "DB not reachable (health.db=false)")
    except Exception as e:
        add(CRITICAL, f"API /health unreachable: {e}")
        return findings  # nothing else will work

    # 2. VPN exits per the broker's own probe
    vpn = health.get("vpn")
    if not isinstance(vpn, dict):  # tolerate a malformed/absent vpn field, never crash
        vpn = {}
    up = [k for k, v in vpn.items() if v]
    if not up:
        add(CRITICAL, "no VPN exit is up (health.vpn all null) — sourcing is dead")
    elif len(up) < len([k for k in vpn]):
        down = [k for k, v in vpn.items() if not v]
        add(WARNING, f"VPN exit(s) down: {', '.join(down)} (still have {', '.join(up)})")

    # 3. VPN INTEGRITY — dynamic leak check independent of the broker. Probe
    # every exit so a healthy EU fallback does not get escalated to CRITICAL
    # merely because the US exit is the one currently down.
    direct_ip = _echo_ip(proxy=None)
    for severity, message in _vpn_integrity_findings(direct_ip, vpn):
        add(severity, message)

    # 4. EGRESS LEAK — did any actual image fetch exit via the home IP?
    try:
        events = _get(f"{BROKER}/egress?limit=50").get("events", [])
        for ev in events:
            exit_ip = ev.get("exit_ip")
            if direct_ip and exit_ip == direct_ip:
                add(CRITICAL, f"IMAGE FETCH LEAKED: egress row for '{ev.get('source_id')}' exited via home IP {exit_ip}")
                break
    except Exception as e:
        add(WARNING, f"could not read /egress: {e}")

    # 5. Collector freshness (a wedged collector = stale pool). Best-effort.
    # Deliberately NOT keyed off egress recency: a cycle where every topic's
    # pool is already at target_depth fetches nothing and writes no egress
    # rows at all, which used to false-page this check every ~90-120min on a
    # perfectly healthy collector. /health.last_cycle_at is a heartbeat the
    # collector writes at the end of every cycle regardless of fetch activity.
    last_cycle_at = health.get("last_cycle_at")
    if last_cycle_at:
        try:
            from datetime import datetime, timezone
            t = datetime.fromisoformat(last_cycle_at.replace("Z", "+00:00"))
            age_min = (datetime.now(timezone.utc) - t).total_seconds() / 60
            if age_min > FRESH_MIN:
                add(WARNING, f"collector looks stale: last cycle {age_min:.0f} min ago (> {FRESH_MIN})")
        except Exception:
            pass
    else:
        add(WARNING, "collector heartbeat missing (last_cycle_at absent from /health) — cannot verify it's running")

    # 6. Serve path — pull real bytes of an existing pool image
    try:
        imgs = _get(f"{BROKER}/images?limit=1").get("images", [])
        if not imgs:
            add(WARNING, "pool is empty — no image to serve")
        else:
            iid = imgs[0]["id"]
            data, hdrs = _get(f"{BROKER}/image/{iid}", raw=True)
            ct = hdrs.get("content-type", "")
            if not ct.startswith("image/"):
                add(WARNING, f"serve path broken: /image/{iid[:10]} returned '{ct}'")
            elif len(data) < 1000:
                add(WARNING, f"serve path suspicious: /image/{iid[:10]} returned {len(data)} bytes")
    except Exception as e:
        add(WARNING, f"serve-path check failed: {e}")

    return findings


def overall(findings):
    if any(s == CRITICAL for s, _ in findings):
        return CRITICAL
    if any(s == WARNING for s, _ in findings):
        return WARNING
    return OK


def post_slack(text):
    """Returns True if the message reached Slack (or Slack is not configured)."""
    if not SLACK_TOKEN:
        print("[monitor] SLACK_BOT_TOKEN unset — not posting")
        return True
    payload = json.dumps({"channel": SLACK_CHANNEL, "text": text, "unfurl_links": False}).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage", data=payload,
        headers={"Authorization": "Bearer " + SLACK_TOKEN, "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read().decode())
            if not resp.get("ok"):
                print("[monitor] slack error:", resp.get("error"))
                return False
            return True
    except Exception as e:
        print("[monitor] slack post failed:", e)
        return False


def format_msg(status, findings):
    icon = {CRITICAL: ":sos:", WARNING: ":warning:", OK: ":white_check_mark:"}[status]
    head = {CRITICAL: "data-hub-images CRITICAL", WARNING: "data-hub-images degraded",
            OK: "data-hub-images recovered — all checks green"}[status]
    lines = [f"{icon} *{head}*"]
    for sev, msg in findings:
        bullet = ":sos:" if sev == CRITICAL else ":warning:"
        lines.append(f"{bullet} {msg}")
    return "\n".join(lines)


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {"status": OK}


def save_state(status, findings):
    try:
        with open(STATE_PATH, "w") as f:
            json.dump({"status": status, "at": time.time(),
                       "findings": [f"{s}:{m}" for s, m in findings]}, f, indent=2)
    except Exception as e:
        print("[monitor] could not write state:", e)


def main():
    dry = "--dry-run" in sys.argv
    try:
        findings = run_checks()
    except Exception as e:
        # A monitor that dies silently is worse than none — turn any unexpected
        # crash into a CRITICAL so it pages instead of going blind.
        findings = [(CRITICAL, f"monitor itself errored: {e}")]
    status = overall(findings)
    msg = format_msg(status, findings)

    if dry:
        print(f"STATUS={status}")
        print(msg)
        return 0 if status == OK else 1

    prev = load_state().get("status", OK)
    # Bit-flip: post when we leave OK (problem) or return to OK (recovery).
    if status != prev:
        delivered = post_slack(format_msg(OK, []) if status == OK else msg)
        if delivered:
            save_state(status, findings)
        else:
            # Leave prev intact so the next tick retries this transition rather
            # than silently swallowing the alert and later posting a recovery
            # for something nobody was ever told about.
            print(f"[monitor] slack undelivered — keeping prev={prev} to retry")
    else:
        print(f"[monitor] status unchanged ({status}) — no Slack post")
        save_state(status, findings)
    # Always echo to stdout (captured by docker logs)
    print(f"[monitor] status={status} (prev={prev})")
    for s, m in findings:
        print(f"  {s}: {m}")
    return 0 if status == OK else 1


if __name__ == "__main__":
    sys.exit(main())
