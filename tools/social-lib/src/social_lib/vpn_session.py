# tools/social-lib/src/social_lib/vpn_session.py
import os
from contextlib import contextmanager

# Host-side default: gluetun's internal proxy (container port 8888) published
# to the host's loopback. Only reachable as 127.0.0.1 from processes running
# directly on the host — a container has its OWN loopback, so callers running
# inside a Docker container (joined to the `vpn-proxy_default` network) must
# override via VPN_PROXY_URL_US/VPN_PROXY_URL_EU, pointing at the gluetun
# container's Docker DNS name and internal port instead, e.g.
# "http://vpn-us:8888" / "http://vpn-eu:8888".
US_PROXY = "http://127.0.0.1:8181"
EU_PROXY = "http://127.0.0.1:8182"
_PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")


def get_proxy_url(region: str = "us") -> str:
    override = os.environ.get(f"VPN_PROXY_URL_{region.upper()}")
    if override:
        return override
    return EU_PROXY if region == "eu" else US_PROXY


@contextmanager
def vpn_session(region: str = "us"):
    proxy = get_proxy_url(region)
    saved = {k: os.environ.get(k) for k in _PROXY_KEYS}
    for k in _PROXY_KEYS:
        os.environ[k] = proxy
    try:
        yield proxy
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
