from datetime import datetime, timezone
import datahub.datasets as _ds

DEFAULT_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url") or source.url or DEFAULT_URL
    params = {k: v for k, v in source.params.items() if k not in {"url", "station_name"}}
    data = _ds._get_json(url, proxy=proxy, params=params or None, client=client)
    rows = data.get("predictions") or data.get("data") or []
    out = []
    for row in rows:
        t = row.get("t") or datetime.now(timezone.utc).isoformat()
        payload = dict(row)
        payload["station"] = source.params.get("station")
        payload["station_name"] = source.params.get("station_name")
        out.append({"observed_at": str(t).replace(" ", "T"), "payload": payload})
    return out
