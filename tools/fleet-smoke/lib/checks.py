"""Deterministic HTTP checks. All network I/O is dependency-injected so this
module is fully unit-testable without touching the network."""
import json
import re
import subprocess
import time
import urllib.request


RETRY_DELAYS_SECONDS = (10, 20, 30)

# Matches Vite's emitted <script type="module" src="...">, order-agnostic on
# attributes (crossorigin comes before src in real output).
_MODULE_SCRIPT_RE = re.compile(r'<script[^>]+type="module"[^>]+src="([^"]+)"')
# Matches a literal dynamic import() specifier — Vite keeps these as plain
# strings in the built output (it's how React.lazy()'s code-split chunks
# reference each other), so a static regex walk finds the same chunks a
# browser's module loader would actually request.
_DYNAMIC_IMPORT_RE = re.compile(r'''import\(\s*["']([^"']+)["']\s*\)''')


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


def _default_fetch_body(apex, ip, path):
    result = subprocess.run(
        [
            "curl", "-sS", "--resolve", f"{apex}:443:{ip}", "--max-time", "15",
            f"https://{apex}{path}",
        ],
        capture_output=True, text=True, timeout=20,
    )
    return result.stdout


def _resolve_module_specifier(referrer_path, specifier):
    """Resolve a relative dynamic-import specifier (e.g. "./App-abc123.js")
    against the path it was found in. Vite's build output is a flat
    /assets/ dir, so a simple stack-based join covers every case it emits."""
    if specifier.startswith("/"):
        return specifier
    parts = (referrer_path.rsplit("/", 1)[0] + "/" + specifier).split("/")
    stack = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == "..":
            if stack:
                stack.pop()
            continue
        stack.append(part)
    return "/" + "/".join(stack)


def run_module_graph_check(apex, ip, check, run_curl=None, fetch_body=None,
                            max_depth=8):
    """Walk the real module graph reachable from an entry HTML page: the
    <script type="module"> it loads, then every chunk that script (and its
    descendants) reach via a literal dynamic import() — the same graph a
    browser's module loader resolves. Fails if any chunk in that graph
    doesn't 200.

    This is what a plain http_status check on the page can't see: the page
    itself always 200s (it's the same SPA shell for every route), but a
    stale/incomplete deploy can leave it pointing at a chunk hash that no
    longer exists — the "Importing a module script failed" failure mode.
    """
    if run_curl is None:
        run_curl = _default_run_curl
    if fetch_body is None:
        fetch_body = _default_fetch_body
    entry_path = check["path"]
    label = check.get("label", entry_path)

    entry_status = run_curl(apex, ip, entry_path)
    if entry_status != "200":
        return {
            "label": label, "path": entry_path,
            "expect": "module graph resolves",
            "actual": f"entry page returned {entry_status}", "ok": False,
        }

    html = fetch_body(apex, ip, entry_path)
    entry_scripts = _MODULE_SCRIPT_RE.findall(html)
    if not entry_scripts:
        return {
            "label": label, "path": entry_path,
            "expect": "module graph resolves",
            "actual": "no <script type=\"module\"> found in HTML", "ok": False,
        }

    seen = set()
    broken = []
    queue = list(entry_scripts)
    depth = 0
    while queue and depth < max_depth:
        depth += 1
        next_queue = []
        for asset_path in queue:
            if asset_path in seen:
                continue
            seen.add(asset_path)
            status = run_curl(apex, ip, asset_path)
            if status != "200":
                broken.append(f"{asset_path} ({status})")
                continue
            body = fetch_body(apex, ip, asset_path)
            for specifier in _DYNAMIC_IMPORT_RE.findall(body):
                next_queue.append(_resolve_module_specifier(asset_path, specifier))
        queue = next_queue

    ok = not broken
    return {
        "label": label,
        "path": entry_path,
        "expect": f"{len(seen)} module chunk(s) resolve",
        "actual": "; ".join(broken) if broken else f"{len(seen)} module chunk(s) resolve",
        "ok": ok,
    }


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


def run_checks(config, run_curl=None, http_get=None, fetch_body=None):
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
        if check_type == "http_status":
            results.append(run_http_check(apex, ip, check, run_curl=run_curl))
        elif check_type == "module_graph":
            results.append(run_module_graph_check(
                apex, ip, check, run_curl=run_curl, fetch_body=fetch_body
            ))
        else:
            raise ValueError(f"unknown check type: {check_type!r}")
    return results
