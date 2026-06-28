from datetime import datetime, timezone
import datahub.datasets as _ds

DEFAULT_URL = ("https://api.weather.gov/alerts/active"
               "?status=actual&message_type=alert&severity=Extreme,Severe")


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    data = _ds._get_json(url, proxy=proxy, client=client)
    out = []
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        out.append({"observed_at": p.get("sent") or datetime.now(timezone.utc).isoformat(),
                    "payload": {"event": p.get("event"), "severity": p.get("severity"),
                                "area": p.get("areaDesc"), "headline": p.get("headline")}})
    return out
