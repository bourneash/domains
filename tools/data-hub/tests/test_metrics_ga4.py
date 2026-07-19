from datetime import date
from datahub.metrics import ga4


class FakeRunReport:
    def __init__(self, response):
        self._response = response
    def execute(self):
        return self._response


class FakeProperties:
    def __init__(self, response):
        self._response = response
        self.calls = []
    def runReport(self, property=None, body=None):
        self.calls.append((property, body))
        return FakeRunReport(self._response)


class FakeClient:
    def __init__(self, response):
        self._properties = FakeProperties(response)
    def properties(self):
        return self._properties


def _response(rows):
    return {
        "dimensionHeaders": [{"name": "date"}],
        "metricHeaders": [{"name": n} for n, _ in ga4.METRIC_MAP],
        "rows": rows,
        "propertyQuota": {"tokensPerDay": {"consumed": 12, "remaining": 199988}},
    }


def test_trailing_window_ends_yesterday():
    start, end = ga4.trailing_window(date(2026, 7, 19), days=7)
    assert start == "2026-07-12"
    assert end == "2026-07-18"


def test_fetch_site_maps_metrics_by_name_not_position():
    row = {
        "dimensionValues": [{"value": "20260718"}],
        "metricValues": [{"value": str(i)} for i in range(len(ga4.METRIC_MAP))],
    }
    client = FakeClient(_response([row]))
    records, quota = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    assert len(records) == 1
    r = records[0]
    assert r["grain"] == "site"
    assert r["dim_key"] == ""
    assert r["date"] == "2026-07-18"
    assert r["sessions"] == 0    # position 0 in METRIC_MAP
    assert r["conversions"] == len(ga4.METRIC_MAP) - 1  # last metric, last value
    assert quota["tokensPerDay"]["consumed"] == 12


def test_fetch_site_empty_response_is_empty_list_not_zero_rows():
    client = FakeClient(_response([]))
    records, _ = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    assert records == []


def test_fetch_pages_sets_page_grain_and_dim_key():
    row = {
        "dimensionValues": [{"value": "20260718"}, {"value": "/tea/oolong"}],
        "metricValues": [{"value": "5"} for _ in ga4.METRIC_MAP],
    }
    client = FakeClient(_response([row]))
    records, _ = ga4.fetch_pages(client, "539743210", today=date(2026, 7, 19))
    assert records[0]["grain"] == "page"
    assert records[0]["dim_key"] == "/tea/oolong"


def test_fetch_site_calls_runreport_with_correct_property_and_window():
    client = FakeClient(_response([]))
    ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    prop, body = client.properties().calls[0]
    assert prop == "properties/539743210"
    assert body["dateRanges"] == [{"startDate": "2026-07-12", "endDate": "2026-07-18"}]
    assert body["dimensions"] == [{"name": "date"}]
    assert body["returnPropertyQuota"] is True
