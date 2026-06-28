import httpx
from pydantic import BaseModel
from .config import Source, Settings


class FetchPlan(BaseModel):
    allowed: bool
    proxy: str | None = None
    exit_node: str = ""
    exit_ip: str | None = None
    reason: str = ""


def probe_exit_ip(control_url: str, *, client: httpx.Client | None = None, timeout: float = 8) -> str | None:
    owns = client is None
    client = client or httpx.Client(timeout=timeout)
    try:
        r = client.get(f"{control_url}/v1/publicip/ip")
        r.raise_for_status()
        return r.json().get("public_ip") or None
    except Exception:
        return None
    finally:
        if owns:
            client.close()


def _node_for(source: Source, settings: Settings) -> tuple[str, str, str]:
    """Return (exit_node, proxy_url, control_url). 'any' resolves to US."""
    node = "us" if source.exit in ("us", "any") else "eu"
    if node == "us":
        return "us", settings.proxy_us, settings.control_us
    return "eu", settings.proxy_eu, settings.control_eu


def plan_fetch(source: Source, settings: Settings, *, client: httpx.Client | None = None) -> FetchPlan:
    if source.policy == "direct":
        return FetchPlan(allowed=True, proxy=None, exit_node="direct", exit_ip=None, reason="direct-policy")

    node, proxy, control = _node_for(source, settings)
    exit_ip = probe_exit_ip(control, client=client)
    if exit_ip is None:
        return FetchPlan(allowed=False, proxy=None, exit_node=node, exit_ip=None, reason="vpn-down")
    if exit_ip in settings.home_ips:
        return FetchPlan(allowed=False, proxy=None, exit_node=node, exit_ip=exit_ip, reason="leak-detected")
    return FetchPlan(allowed=True, proxy=proxy, exit_node=node, exit_ip=exit_ip, reason="ok")
