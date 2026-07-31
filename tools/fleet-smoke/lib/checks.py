"""Deterministic HTTP checks. All network I/O is dependency-injected so this
module is fully unit-testable without touching the network."""
import json
import subprocess
import time
import urllib.request


RETRY_DELAYS_SECONDS = (10, 20, 30)


def _default_http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode()


def resolve_apex_ip(apex, http_get=None):
    """Resolve apex's A record via Cloudflare DNS-over-HTTPS — bypasses any
    local resolver/proxy quirks, matching the proven xxxtea.com smoke.sh
    technique."""
    if http_get is None:
        http_get = _default_http_get
    url = f"https://cloudflare-dns.com/dns-query?name={apex}&type=A"
    body = http_get(url, headers={"accept": "application/dns-json"})
    data = json.loads(body)
    return data["Answer"][0]["data"]


def _default_run_curl(apex, ip, path):
    result = subprocess.run(
        [
            "curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
            "--resolve", f"{apex}:443:{ip}", "--max-time", "15",
            f"https://{apex}{path}",
        ],
        capture_output=True, text=True, timeout=20,
    )
    return result.stdout.strip()


def run_http_check(apex, ip, check, run_curl=None, sleep=None,
                   retry_delays=RETRY_DELAYS_SECONDS):
    """Run one check, retrying unexpected statuses with increasing backoff."""
    if run_curl is None:
        run_curl = _default_run_curl
    if sleep is None:
        sleep = time.sleep
    path = check["path"]
    expect = check["expect"]
    label = check.get("label", path)

    actual = run_curl(apex, ip, path)
    for delay in retry_delays:
        if actual == str(expect):
            break
        sleep(delay)
        actual = run_curl(apex, ip, path)

    return {
        "label": label,
        "path": path,
        "expect": expect,
        "actual": actual,
        "ok": actual == str(expect),
    }


def run_checks(config, run_curl=None, http_get=None):
    """Run every check in config['checks'] against config['apex']. Resolves
    the apex IP once (unless dns_over_https is False) and reuses it for every
    check — one DoH lookup per site, not per route."""
    apex = config["apex"]
    if config.get("dns_over_https", True):
        ip = resolve_apex_ip(apex, http_get=http_get)
    else:
        ip = apex

    results = []
    for check in config["checks"]:
        check_type = check.get("type", "http_status")
        if check_type != "http_status":
            raise ValueError(f"unknown check type: {check_type!r}")
        results.append(run_http_check(apex, ip, check, run_curl=run_curl))
    return results
