# tools/social-lib/src/social_lib/vpn_session.py
import os
from contextlib import contextmanager

US_PROXY = "http://127.0.0.1:8181"
EU_PROXY = "http://127.0.0.1:8182"
_PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")


def get_proxy_url(region: str = "us") -> str:
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
