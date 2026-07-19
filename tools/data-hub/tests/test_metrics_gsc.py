from datetime import date
from datahub.metrics import gsc


class FakeQuery:
    def __init__(self, response):
        self._response = response
    def execute(self):
        return self._response


class FakeSearchAnalytics:
    def __init__(self, response):
        self._response = response
        self.calls = []
    def query(self, siteUrl=None, body=None):
        self.calls.append((siteUrl, body))
        return FakeQuery(self._response)


class FakeClient:
    def __init__(self, response):
        self._sa = FakeSearchAnalytics(response)
    def searchanalytics(self):
        return self._sa


def test_fetch_site_maps_row_keys_and_metrics():
    response = {"rows": [{"keys": ["2026-07-18"], "clicks": 12, "impressions": 400,
                          "ctr": 0.03, "position": 8.4}]}
    client = FakeClient(response)
    records = gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19))
    assert len(records) == 1
    r = records[0]
    assert r == {"date": "2026-07-18", "grain": "site", "dim_key": "",
                 "clicks": 12, "impressions": 400, "ctr": 0.03, "position": 8.4}


def test_fetch_site_empty_response_is_empty_list():
    client = FakeClient({"rows": []})
    assert gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19)) == []


def test_fetch_site_missing_rows_key_is_empty_list():
    client = FakeClient({})
    assert gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19)) == []


def test_fetch_queries_sets_query_grain_and_dim_key():
    response = {"rows": [{"keys": ["2026-07-18", "loose leaf oolong"], "clicks": 3,
                          "impressions": 40, "ctr": 0.075, "position": 4.2}]}
    client = FakeClient(response)
    records = gsc.fetch_queries(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19))
    assert records[0]["grain"] == "query"
    assert records[0]["dim_key"] == "loose leaf oolong"


def test_fetch_site_calls_query_with_correct_site_and_window_and_row_cap():
    client = FakeClient({"rows": []})
    gsc.fetch_site(client, "sc-domain:xxxtea.com", today=date(2026, 7, 19))
    site_url, body = client.searchanalytics().calls[0]
    assert site_url == "sc-domain:xxxtea.com"
    assert body["startDate"] == "2026-07-12"
    assert body["endDate"] == "2026-07-18"
    assert body["dimensions"] == ["date"]
    assert body["rowLimit"] == gsc.ROW_LIMIT
