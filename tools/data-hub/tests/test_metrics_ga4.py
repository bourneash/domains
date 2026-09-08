from datetime import date
from datahub.metrics import ga4


class FakeRunReport:
    def __init__(self, response):
        self._response = response
        self.num_retries = None
    def execute(self, num_retries=0):
        self.num_retries = num_retries
        return self._response


class FakeProperties:
    def __init__(self, response):
        self._responses = response if isinstance(response, list) else [response]
        self.calls = []
        self.requests = []
    def runReport(self, property=None, body=None):
        self.calls.append((property, body))
        index = min(len(self.calls) - 1, len(self._responses) - 1)
        request = FakeRunReport(self._responses[index])
        self.requests.append(request)
        return request


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
    client = FakeClient([_response([row]), _response([])])
    records, quota = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    assert len(records) == 1
    r = records[0]
    assert r["grain"] == "site"
    assert r["dim_key"] == ""
    assert r["date"] == "2026-07-18"
    assert r["sessions"] == 0    # position 0 in METRIC_MAP
    # The base response is still mapped by header name; the explicit
    # affiliate-click report then owns the conversion value.
    assert r["avg_session_duration"] == len(ga4.METRIC_MAP) - 2
    assert r["conversions"] == 0
    assert quota["tokensPerDay"]["consumed"] == 12


def test_fetch_site_empty_response_is_empty_list_not_zero_rows():
    client = FakeClient([_response([]), _response([])])
    records, _ = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    assert records == []


def test_fetch_pages_sets_page_grain_and_dim_key():
    row = {
        "dimensionValues": [{"value": "20260718"}, {"value": "/tea/oolong"}],
        "metricValues": [{"value": "5"} for _ in ga4.METRIC_MAP],
    }
    client = FakeClient([_response([row]), _response([])])
    records, _ = ga4.fetch_pages(client, "539743210", today=date(2026, 7, 19))
    assert records[0]["grain"] == "page"
    assert records[0]["dim_key"] == "/tea/oolong"


def test_fetch_site_calls_runreport_with_correct_property_and_window():
    client = FakeClient([_response([]), _response([])])
    ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    prop, body = client.properties().calls[0]
    assert prop == "properties/539743210"
    assert body["dateRanges"] == [{"startDate": "2026-07-12", "endDate": "2026-07-18"}]
    assert body["dimensions"] == [{"name": "date"}]
    assert body["returnPropertyQuota"] is True
    assert client.properties().requests[0].num_retries == ga4.API_RETRIES


def test_fetch_site_counts_affiliate_clicks_as_conversions():
    base = _response([{
        "dimensionValues": [{"value": "20260718"}],
        "metricValues": [{"value": "5"} for _ in ga4.METRIC_MAP],
    }])
    clicks = {
        "metricHeaders": [{"name": "eventCount"}],
        "rows": [{
            "dimensionValues": [{"value": "20260718"}],
            "metricValues": [{"value": "3"}],
        }],
        "propertyQuota": {},
    }
    client = FakeClient([base, clicks])
    records, _ = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    assert records[0]["conversions"] == 3
    _, body = client.properties().calls[1]
    assert body["metrics"] == [{"name": "eventCount"}]
    assert body["dimensionFilter"]["filter"]["fieldName"] == "eventName"
    assert body["dimensionFilter"]["filter"]["stringFilter"]["value"] == "affiliate_click"


def test_fetch_pages_merges_click_only_row():
    clicks = {
        "metricHeaders": [{"name": "eventCount"}],
        "rows": [{
            "dimensionValues": [{"value": "20260718"}, {"value": "/review"}],
            "metricValues": [{"value": "2"}],
        }],
        "propertyQuota": {},
    }
    client = FakeClient([_response([]), clicks])
    records, _ = ga4.fetch_pages(client, "539743210", today=date(2026, 7, 19))
    assert records == [{
        "date": "2026-07-18", "grain": "page", "dim_key": "/review",
        "sessions": 0, "users": 0, "new_users": 0, "views": 0,
        "engaged_sessions": 0, "engagement_rate": 0,
        "avg_session_duration": 0, "conversions": 2,
    }]


def test_fetch_site_maps_metrics_correctly_when_response_header_order_differs_from_metric_map():
    """Regression test: by-name lookup must be used, not positional indexing.
    If someone rewrites _rows_to_records to use positional indexing,
    this test will fail because headers are in reversed order but values
    still correspond to the correct metrics."""
    reversed_map = list(reversed(ga4.METRIC_MAP))
    response = {
        "dimensionHeaders": [{"name": "date"}],
        "metricHeaders": [{"name": n} for n, _ in reversed_map],
        "rows": [{
            "dimensionValues": [{"value": "20260718"}],
            "metricValues": [{"value": str(i)} for i in range(len(reversed_map))],
        }],
        "propertyQuota": {},
    }
    client = FakeClient([response, _response([])])
    records, _ = ga4.fetch_site(client, "539743210", today=date(2026, 7, 19))
    record = records[0]
    # Base fields still map by header; the empty affiliate-click response then
    # intentionally replaces the conversion value with zero.
    assert record["avg_session_duration"] == 1
    assert record["conversions"] == 0
    assert record["sessions"] == len(reversed_map) - 1


def test_fetch_social_uses_utm_content_and_organic_social_filter():
    row = {
        "dimensionValues": [{"value": "20260718"}, {"value": "hub-42"}],
        "metricValues": [{"value": "5"} for _ in ga4.METRIC_MAP],
    }
    client = FakeClient(_response([row]))
    records, _ = ga4.fetch_social(client, "539743210", today=date(2026, 7, 19))
    assert records[0]["grain"] == "social"
    assert records[0]["dim_key"] == "hub-42"
    _, body = client.properties().calls[0]
    assert body["dimensions"] == [{"name": "date"}, {"name": "sessionManualAdContent"}]
    assert body["dimensionFilter"]["filter"]["fieldName"] == "sessionManualMedium"
