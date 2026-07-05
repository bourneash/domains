"""Image source adapter framework + dispatch registry."""
import os
import time

import httpx

# Wikimedia blocklists library User-Agents (e.g. `python-httpx/0.28.1`) and
# requires a descriptive UA with contact info; LoC also requests one. A single
# shared, env-overridable UA benefits every adapter, not just those two.
USER_AGENT = os.environ.get(
    "DATAHUB_IMAGES_USER_AGENT",
    "DataHubImages/1.0 (+https://americastrikes.com; contact: tips@americastrikes.com)",
)

# Bounded retry on 403/429 (rate-limiting / transient blocks). Kept small and
# the sleep is a patchable module attribute so tests never actually sleep.
_MAX_RETRIES = 3
_RETRY_BACKOFF = (1, 2, 4)
_sleep = time.sleep


class SourceUnavailable(Exception):
    """Raised by keyed adapters when their required key env var is absent.
    The collector records this as a 'skipped' egress, not an 'error'."""


def _get_json(url: str, proxy: str | None = None, headers: dict | None = None,
              timeout: float = 20, client: httpx.Client | None = None) -> dict:
    owns = client is None
    client = client or httpx.Client(proxy=proxy)
    merged_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    try:
        attempt = 0
        while True:
            r = client.get(url, headers=merged_headers, timeout=timeout)
            if r.status_code in (403, 429) and attempt < _MAX_RETRIES:
                _sleep(_RETRY_BACKOFF[attempt])
                attempt += 1
                continue
            r.raise_for_status()
            return r.json()
    finally:
        if owns:
            client.close()


def _redact(msg: str, *secrets: str) -> str:
    out = msg or ""
    for secret in secrets:
        if secret:
            out = out.replace(secret, "***")
    return out


# Built after fetcher modules are imported (bottom of file) to avoid circular imports.
from . import wikimedia  # noqa: E402
from . import unsplash  # noqa: E402
from . import pexels  # noqa: E402
from . import pixabay  # noqa: E402
from . import openverse  # noqa: E402
from . import dvids  # noqa: E402
from . import govflickr  # noqa: E402
from . import nara  # noqa: E402
from . import loc  # noqa: E402

SOURCE_FETCHERS = {
    "wikimedia": wikimedia.search,
    "unsplash": unsplash.search,
    "pexels": pexels.search,
    "pixabay": pixabay.search,
    "openverse": openverse.search,
    "dvids": dvids.search,
    "govflickr": govflickr.search,
    "nara": nara.search,
    "loc": loc.search,
}
