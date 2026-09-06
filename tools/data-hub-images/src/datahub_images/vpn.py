import ipaddress
import httpx
from dataclasses import dataclass
from .config import Source, Settings

# Fall back across independent IP-echo services before declaring a VPN exit
# down. A single-URL/single-attempt probe (the old behavior) flips on any one
# transient timeout/blip against that one third-party service — observed in
# production as recurring "VPN exit(s) down" Slack alerts that self-recovered
# on the very next 5-minute check every time (7/7 occurrences over 6 days, no
# corresponding gluetun error/restart/health-status change). This function
# also gates real fetch decisions in plan_fetch(), so the old flakiness
# wasn't just alert noise — it could skip a legitimate fetch through a
# perfectly healthy exit. Deliberately ONE attempt per URL (no retry loop):
# this is called synchronously from the /health endpoint, which the monitor
# polls with a bounded timeout, so worst-case latency (all echo services
# down = a genuinely dead exit) must stay small, not balloon with retries.
_IP_ECHO_URLS = (
    "https://checkip.amazonaws.com",
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
)
_ECHO_TIMEOUT_S = 5.0


def _is_home_ip(ip: str, home_ips) -> bool:
    """True if `ip` exactly matches an entry in `home_ips`, or falls within
    any entry that parses as a CIDR network. Entries without a "/" are
    treated as exact-match strings (fast path, and safe for malformed
    values). A malformed CIDR entry is skipped rather than raising, since
    this check must never crash the leak-detection path."""
    if ip in home_ips:
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for entry in home_ips:
        if "/" not in entry:
            continue
        try:
            network = ipaddress.ip_network(entry, strict=False)
        except ValueError:
            continue
        if addr in network:
            return True
    return False

@dataclass
class FetchPlan:
    allowed: bool
    proxy: str | None
    exit_node: str
    exit_ip: str | None
    reason: str

def _node_for(source: Source, settings: Settings):
    if source.exit == "eu":
        return "eu", settings.proxy_eu
    return "us", settings.proxy_us

def probe_exit_ip(proxy_url: str, client=None) -> str | None:
    """Return the public IP seen through `proxy_url`, or None if genuinely
    unreachable. Falls back across _IP_ECHO_URLS so a single transient
    failure of one echo service (rate limit, blip, slow DNS) doesn't falsely
    declare the VPN exit down — a real VPN outage still fails all of them
    and returns None. Bounded worst case: len(_IP_ECHO_URLS) * _ECHO_TIMEOUT_S.
    """
    own = client or httpx.Client(proxy=proxy_url, timeout=_ECHO_TIMEOUT_S)
    try:
        for url in _IP_ECHO_URLS:
            try:
                r = own.get(url)
                if r.status_code == 200:
                    ip = r.text.strip()
                    if ip:
                        return ip
            except Exception:
                continue
        return None
    finally:
        if client is None:
            own.close()

def plan_fetch(source: Source, settings: Settings, client=None) -> FetchPlan:
    if source.policy == "direct":
        return FetchPlan(True, None, "direct", None, "direct")
    node, proxy = _node_for(source, settings)
    ip = probe_exit_ip(proxy, client)
    if ip is None:
        return FetchPlan(False, None, node, None, "vpn-down")
    if _is_home_ip(ip, settings.home_ips):
        return FetchPlan(False, None, node, ip, "leak-detected")
    return FetchPlan(True, proxy, node, ip, "ok")
