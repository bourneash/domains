from datetime import datetime, timezone
import datahub.datasets as _ds

DEFAULT_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    params = {k: v for k, v in source.params.items() if k != "url"}
    data = _ds._get_json(url, proxy=proxy, params=params or None, client=client)
    rows = data.get("predictions") or data.get("data") or []
    out = []
    for row in rows:
        t = row.get("t") or datetime.now(timezone.utc).isoformat()
        out.append({"observed_at": str(t).replace(" ", "T"), "payload": row})
    return out
