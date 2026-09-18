from datetime import datetime, timezone
import datahub.datasets as _ds

DEFAULT_URL = "https://www.federalregister.gov/api/v1/documents.json"


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    params = {
        "per_page": 50,
        "order": "newest",
        "conditions[agencies][]": "national-oceanic-and-atmospheric-administration",
        "conditions[term]": "fisheries",
    }
    params.update({k: v for k, v in source.params.items() if k != "url"})
    data = _ds._get_json(source.params.get("url") or source.url or DEFAULT_URL, proxy=proxy,
                         params=params, client=client)
    out = []
    for index, row in enumerate(data.get("results", [])):
        searchable = " ".join((row.get("title") or "", row.get("abstract") or "")).lower()
        if not any(term in searchable for term in (
                "atlantic", "new england", "mid-atlantic", "south atlantic",
                "highly migratory", "bluefin", "swordfish", "billfish")):
            continue
        observed = row.get("publication_date") or datetime.now(timezone.utc).date().isoformat()
        # Multiple rules commonly share a publication date; use a stable slot
        # from the API's ordered result so the generic dataset uniqueness key
        # does not collapse them into one row. The true date remains in payload.
        if "T" not in observed:
            observed = f"{observed}T00:00:{index:02d}+00:00"
        out.append({"observed_at": observed,
                    "payload": {
                        "document_number": row.get("document_number"),
                        "title": row.get("title"),
                        "type": row.get("type"),
                        "abstract": row.get("abstract"),
                        "publication_date": row.get("publication_date"),
                        "effective_on": row.get("effective_on"),
                        "comments_close_on": row.get("comments_close_on"),
                        "html_url": row.get("html_url"),
                        "pdf_url": row.get("pdf_url"),
                        "agencies": [a.get("name") for a in row.get("agencies", [])],
                    }})
    return out
