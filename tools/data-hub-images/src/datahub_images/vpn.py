import ipaddress
import httpx
from dataclasses import dataclass
from .config import Source, Settings


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
    own = client or httpx.Client(proxy=proxy_url, timeout=8.0)
    try:
        r = own.get("https://checkip.amazonaws.com")
        return r.text.strip() if r.status_code == 200 else None
    except Exception:
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
