from datetime import datetime, timezone
import datahub.datasets as _ds

DEFAULT_URL = ("https://api.weather.gov/alerts/active"
               "?status=actual&message_type=alert&severity=Extreme,Severe")


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url") or source.url or DEFAULT_URL
    data = _ds._get_json(url, proxy=proxy, client=client)
    out = []
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        out.append({"observed_at": p.get("sent") or datetime.now(timezone.utc).isoformat(),
                    "payload": {"id": p.get("id") or feat.get("id"),
                                "event": p.get("event"), "severity": p.get("severity"),
                                "certainty": p.get("certainty"), "urgency": p.get("urgency"),
                                "area": p.get("areaDesc"), "headline": p.get("headline"),
                                "onset": p.get("onset"), "expires": p.get("expires"),
                                "description": p.get("description"),
                                "instruction": p.get("instruction"),
                                "affected_zones": p.get("affectedZones") or [],
                                "geocode": p.get("geocode") or {},
                                "geometry": feat.get("geometry")}})
    return out
