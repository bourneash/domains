"""Dataset fetchers + dispatch registry."""
import re
import httpx

DEFAULT_UA = "datahub/1.0 (+https://github.com/bourneash) contact@datahub"

_SECRET_QS = re.compile(r"(?i)\b(api_key|apikey|key|token|password)=[^&\s]+")


def _redact(text: str) -> str:
    return _SECRET_QS.sub(r"\1=***", text or "")


class DatasetUnavailable(Exception):
    """Raised when a dataset cannot be fetched for a non-error reason (e.g. missing key).
    The collector records this as a 'skipped' egress, not an 'error'."""
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def _get_json(url: str, *, proxy: str | None = None, params: dict | None = None,
              ua: str = DEFAULT_UA, client: httpx.Client | None = None, timeout: float = 20) -> dict:
    owns = client is None
    client = client or httpx.Client(proxy=proxy, timeout=timeout, follow_redirects=True)
    try:
        try:
            r = client.get(url, params=params, headers={"User-Agent": ua, "Accept": "application/json"})
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as exc:
            raise RuntimeError(_redact(str(exc))) from None
    finally:
        if owns:
            client.close()


# Built after fetcher modules are imported (bottom of file) to avoid circular imports.
from . import usgs, noaa_alerts, noaa_swpc, noaa_tides, launchlib  # noqa: E402
from . import ephemeris  # noqa: E402  (Task 3)
from . import fred, eia, nass  # noqa: E402  (Task 4)

FETCHERS = {
    "usgs": usgs.fetch,
    "noaa-alerts": noaa_alerts.fetch,
    "noaa-swpc": noaa_swpc.fetch,
    "noaa-tides": noaa_tides.fetch,
    "launchlib": launchlib.fetch,
    "ephemeris": ephemeris.fetch,
    "fred": fred.fetch,
    "eia": eia.fetch,
    "nass": nass.fetch,
}
