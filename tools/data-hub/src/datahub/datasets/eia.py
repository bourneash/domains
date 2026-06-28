import datahub.datasets as _ds
from . import DatasetUnavailable
# NOTE: call _ds._get_json(...) (module-level lookup) so tests that monkeypatch
# datahub.datasets._get_json actually intercept the call. A `from . import _get_json`
# local binding would NOT be patchable.

BASE = "https://api.eia.gov/v2/"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    if not (settings and settings.eia_key):
        raise DatasetUnavailable("no-api-key")
    url = BASE + source.params["path"].lstrip("/")
    params = {k: v for k, v in source.params.items() if k != "path"}
    params["api_key"] = settings.eia_key
    data = _ds._get_json(url, proxy=proxy, client=client, params=params)
    rows = (data.get("response") or {}).get("data", [])
    return [{"observed_at": str(r.get("period", "")), "payload": r} for r in rows]
