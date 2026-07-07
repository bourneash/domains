import hashlib
from datetime import datetime, timedelta, timezone
import datahub.datasets as _ds

DEFAULT_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"


def _stable_offset_micros(cve_id: str) -> int:
    """Deterministic microsecond offset derived from the CVE ID.

    The store's uniqueness key is (source_id, dataset_key, observed_at), but
    KEV's `dateAdded` is date-only — CISA routinely adds several CVEs on the
    same day, so day-granularity observed_at values collide and INSERT OR
    IGNORE silently drops every collision but the first (caught in testing:
    a live poll reported "1 new" when the catalog has hundreds of entries).
    Hashing the CVE ID into a microsecond offset keeps observed_at unique per
    CVE while staying stable across repeated polls of the same catalog, so
    re-polling still dedupes correctly instead of re-inserting every entry
    every cycle.
    """
    digest = hashlib.md5(cve_id.encode("utf-8")).hexdigest()
    return int(digest, 16) % 1_000_000


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    """CISA Known Exploited Vulnerabilities catalog — public JSON, no API key.

    One record per catalog entry. observed_at is the KEV `dateAdded` date
    (not a fetch timestamp) so `since_iso` windowing reflects when CISA
    actually added the entry, not when we happened to poll it — plus a
    per-CVE microsecond offset (see _stable_offset_micros) so same-day
    entries don't collide on the (source_id, dataset_key, observed_at)
    uniqueness constraint.
    """
    url = source.params.get("url", DEFAULT_URL)
    data = _ds._get_json(url, proxy=proxy, client=client)
    out = []
    for v in data.get("vulnerabilities", []):
        date_added = v.get("dateAdded")
        cve_id = v.get("cveID") or ""
        try:
            base = datetime.fromisoformat(date_added).replace(tzinfo=timezone.utc)
            observed = (base + timedelta(microseconds=_stable_offset_micros(cve_id))).isoformat()
        except (TypeError, ValueError):
            observed = datetime.now(timezone.utc).isoformat()
        out.append({"observed_at": observed, "payload": {
            "cve_id": v.get("cveID"),
            "vendor_project": v.get("vendorProject"),
            "product": v.get("product"),
            "vulnerability_name": v.get("vulnerabilityName"),
            "short_description": v.get("shortDescription"),
            "required_action": v.get("requiredAction"),
            "due_date": v.get("dueDate"),
            "known_ransomware_use": v.get("knownRansomwareCampaignUse"),
            "notes": v.get("notes"),
            "cwes": v.get("cwes") or [],
        }})
    return out
