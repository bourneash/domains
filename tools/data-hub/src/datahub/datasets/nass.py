import datahub.datasets as _ds
from . import DatasetUnavailable
# NOTE: call _ds._get_json(...) (module-level lookup) so tests that monkeypatch
# datahub.datasets._get_json actually intercept the call. A `from . import _get_json`
# local binding would NOT be patchable.

URL = "https://quickstats.nass.usda.gov/api/api_GET/"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    if not (settings and settings.nass_key):
        raise DatasetUnavailable("no-api-key")
    params = dict(source.params)
    params["key"] = settings.nass_key
    params["format"] = "JSON"
    data = _ds._get_json(URL, proxy=proxy, client=client, params=params)
    out = []
    for r in data.get("data", []):
        year = str(r.get("year", "")).strip()
        observed = f"{year}-01-01T00:00:00+00:00" if year else ""
        if observed:
            out.append({"observed_at": observed, "payload": r})
    return out
