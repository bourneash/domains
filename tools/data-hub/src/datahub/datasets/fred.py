import datahub.datasets as _ds
from . import DatasetUnavailable
# NOTE: call _ds._get_json(...) (module-level lookup) so tests that monkeypatch
# datahub.datasets._get_json actually intercept the call. A `from . import _get_json`
# local binding would NOT be patchable.

URL = "https://api.stlouisfed.org/fred/series/observations"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    if not (settings and settings.fred_key):
        raise DatasetUnavailable("no-api-key")
    series_id = source.params["series_id"]
    data = _ds._get_json(URL, proxy=proxy, client=client, params={
        "series_id": series_id, "api_key": settings.fred_key,
        "file_type": "json", "sort_order": "desc", "limit": 1})
    obs = data.get("observations", [])
    if not obs:
        return []
    o = obs[0]
    return [{"observed_at": o.get("date", ""), "payload": {
        "series_id": series_id, "value": o.get("value"), "date": o.get("date")}}]
