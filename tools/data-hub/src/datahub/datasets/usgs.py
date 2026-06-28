from datetime import datetime, timezone
import datahub.datasets as _ds

DEFAULT_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    data = _ds._get_json(url, proxy=proxy, client=client)
    out = []
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        t = p.get("time")
        observed = (datetime.fromtimestamp(t / 1000, tz=timezone.utc).isoformat()
                    if isinstance(t, (int, float)) else datetime.now(timezone.utc).isoformat())
        out.append({"observed_at": observed, "payload": {
            "mag": p.get("mag"), "place": p.get("place"),
            "type": p.get("type"), "url": p.get("url")}})
    return out
