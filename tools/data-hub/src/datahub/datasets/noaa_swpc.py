from datetime import datetime, timezone
import datahub.datasets as _ds


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    url = source.params["url"]
    data = _ds._get_json(url, proxy=proxy, client=client)
    if isinstance(data, list) and data and isinstance(data[0], list):
        # array-of-arrays: first row is the header
        header, *rows = data
        if not rows:
            return []
        latest = rows[-1]
        payload = dict(zip(header, latest))
        observed = payload.get(header[0]) or datetime.now(timezone.utc).isoformat()
        return [{"observed_at": str(observed).replace(" ", "T"), "payload": payload}]
    if isinstance(data, list) and data:  # array-of-objects
        latest = data[-1]
        observed = latest.get("time_tag") or latest.get("time") or datetime.now(timezone.utc).isoformat()
        return [{"observed_at": str(observed).replace(" ", "T"), "payload": latest}]
    return []
