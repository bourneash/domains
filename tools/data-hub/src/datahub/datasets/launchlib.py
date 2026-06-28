from datetime import datetime, timezone
import datahub.datasets as _ds

DEFAULT_URL = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params.get("url", DEFAULT_URL)
    params = {"limit": source.params.get("limit", 5)}
    data = _ds._get_json(url, proxy=proxy, params=params, client=client)
    out = []
    for ln in data.get("results", []):
        out.append({"observed_at": ln.get("net") or datetime.now(timezone.utc).isoformat(),
                    "payload": {
                        "name": ln.get("name"),
                        "status": (ln.get("status") or {}).get("name"),
                        "provider": (ln.get("launch_service_provider") or {}).get("name"),
                        "pad": (ln.get("pad") or {}).get("name"),
                        "window_start": ln.get("window_start")}})
    return out
