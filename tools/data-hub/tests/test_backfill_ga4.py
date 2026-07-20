from datetime import date
from datahub import backfill_ga4


class FakeRunReport:
    def __init__(self, response):
        self._response = response
    def execute(self):
        return self._response


class FakeProperties:
    def __init__(self):
        self.calls = []
    def runReport(self, property=None, body=None):
        self.calls.append(body["dateRanges"][0])
        return FakeRunReport({"rows": [], "propertyQuota": {}})


class FakeClient:
    def __init__(self):
        self._p = FakeProperties()
    def properties(self):
        return self._p


def test_backfill_chunks_16_months_into_3_month_calls():
    client = FakeClient()
    backfill_ga4.backfill_site(client, "539743210", months=16, chunk_months=3, today=date(2026, 7, 19))
    assert len(client.properties().calls) == 6  # ceil(16/3)


def test_backfill_chunks_do_not_overlap_or_gap():
    client = FakeClient()
    backfill_ga4.backfill_site(client, "539743210", months=6, chunk_months=3, today=date(2026, 7, 19))
    ranges = client.properties().calls
    assert len(ranges) == 2
    from datetime import date as d, timedelta
    end0 = d.fromisoformat(ranges[0]["endDate"])
    start1 = d.fromisoformat(ranges[1]["startDate"])
    assert start1 == end0 + timedelta(days=1)
