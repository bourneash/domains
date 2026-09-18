from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET
import datahub.datasets as _ds

GEORSS = "{http://www.georss.org/georss}point"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    if not source.url:
        raise ValueError("NDBC source requires url")
    root = ET.fromstring(_ds._get_text(source.url, proxy=proxy, client=client))
    stations = []
    observed_times = []
    for item in root.findall(".//item"):
        published = item.findtext("pubDate")
        try:
            observed = parsedate_to_datetime(published).isoformat() if published else None
        except (TypeError, ValueError):
            observed = None
        point = (item.findtext(GEORSS) or "").split()
        observed = observed or datetime.now(timezone.utc).isoformat()
        observed_times.append(observed)
        stations.append({
                "station": item.findtext("title"),
                "url": item.findtext("link"),
                "description": item.findtext("description") or "",
                "lat": float(point[0]) if len(point) == 2 else None,
                "lon": float(point[1]) if len(point) == 2 else None,
                "observed_at": observed,
        })
    if not stations:
        return []
    # The generic dataset table is unique by source/key/observed_at. Store one
    # regional snapshot so stations sharing the same publication minute do not
    # overwrite one another.
    return [{"observed_at": max(observed_times),
             "payload": {"region_source": source.id, "stations": stations}}]
