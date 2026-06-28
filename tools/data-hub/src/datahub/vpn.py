import httpx
from pydantic import BaseModel
from .config import Source, Settings


class FetchPlan(BaseModel):
    allowed: bool
    proxy: str | None = None
    exit_node: str = ""
    exit_ip: str | None = None
    reason: str = ""


_IP_CHECK_URL = "http://checkip.amazonaws.com"


def probe_exit_ip(proxy_url: str, *, client: httpx.Client | None = None, timeout: float = 8) -> str | None:
    """Return the exit IP as seen through proxy_url, or None if unreachable/leaking.

    Uses an HTTP GET to a plain-text IP-echo endpoint routed through the proxy.
    This avoids the gluetun control API which now requires authentication.
    """
    owns = client is None
    client = client or httpx.Client(proxy=proxy_url, timeout=timeout, follow_redirects=True)
    try:
        r = client.get(_IP_CHECK_URL)
        r.raise_for_status()
        ip = r.text.strip()
        return ip if ip else None
    except Exception:
        return None
    finally:
        if owns:
            client.close()


def _node_for(source: Source, settings: Settings) -> tuple[str, str]:
    """Return (exit_node, proxy_url). 'any' resolves to US."""
    node = "us" if source.exit in ("us", "any") else "eu"
    if node == "us":
        return "us", settings.proxy_us
    return "eu", settings.proxy_eu


def plan_fetch(source: Source, settings: Settings, *, client: httpx.Client | None = None) -> FetchPlan:
    if source.policy == "direct":
        return FetchPlan(allowed=True, proxy=None, exit_node="direct", exit_ip=None, reason="direct-policy")

    node, proxy = _node_for(source, settings)
    exit_ip = probe_exit_ip(proxy, client=client)
    if exit_ip is None:
        return FetchPlan(allowed=False, proxy=None, exit_node=node, exit_ip=None, reason="vpn-down")
    if exit_ip in settings.home_ips:
        return FetchPlan(allowed=False, proxy=None, exit_node=node, exit_ip=exit_ip, reason="leak-detected")
    return FetchPlan(allowed=True, proxy=proxy, exit_node=node, exit_ip=exit_ip, reason="ok")
