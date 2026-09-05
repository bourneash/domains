from datahub import store, metrics_collector as mc
from datahub.config import AnalyticsSite


def _sites():
    return {
        "xxxtea.com": AnalyticsSite(ga4_property_id="1", ga4_measurement_id="G-A",
                                    gsc_property="sc-domain:xxxtea.com", consent_gated=False),
        "saveusfarms.com": AnalyticsSite(ga4_property_id="2", ga4_measurement_id="G-B",
                                         gsc_property="sc-domain:saveusfarms.com", consent_gated=True),
    }


class FakeGA4Client:
    def __init__(self, fail_for=()):
        self.fail_for = set(fail_for)
        self.calls = []
    def properties(self):
        return self
    def runReport(self, property=None, body=None):
        self.calls.append(property)
        if property.split("/")[-1] in self.fail_for:
            raise RuntimeError("403 forbidden")
        return self
    def execute(self):
        return {"rows": [], "propertyQuota": {}}


class FakeGSCClient:
    def __init__(self, fail_for=()):
        self.fail_for = set(fail_for)
        self.calls = []
    def searchanalytics(self):
        return self
    def query(self, siteUrl=None, body=None):
        self.calls.append(siteUrl)
        if siteUrl in self.fail_for:
            raise RuntimeError("403 forbidden")
        return self
    def execute(self):
        return {"rows": []}


def test_run_metrics_cycle_calls_both_apis_for_every_site(db):
    ga4c, gscc = FakeGA4Client(), FakeGSCClient()
    summary = mc.run_metrics_cycle(db, _sites(), ga4_client=ga4c, gsc_client=gscc)
    assert summary["sites"] == 2
    assert summary["ga4_ok"] == 2
    assert summary["gsc_ok"] == 2
    assert summary["errors"] == 0
    # each site: site + pages = 2 GA4 calls; site + queries + pages = 3 GSC calls
    assert len(ga4c.calls) == 4
    assert len(gscc.calls) == 6


def test_run_metrics_cycle_isolates_one_site_ga4_failure(db):
    ga4c = FakeGA4Client(fail_for={"1"})
    gscc = FakeGSCClient()
    summary = mc.run_metrics_cycle(db, _sites(), ga4_client=ga4c, gsc_client=gscc)
    assert summary["errors"] == 1
    assert summary["ga4_ok"] == 1          # saveusfarms.com's GA4 pull still ran
    assert summary["gsc_ok"] == 2          # xxxtea.com's GSC pull still ran despite its GA4 failure
    states = {s["source_id"]: s for s in store.get_sources_state(db)}
    assert states["ga4:xxxtea.com"]["status"] == "error"
    assert states["gsc:xxxtea.com"]["status"] == "ok"


def test_run_metrics_cycle_writes_direct_policy_egress(db):
    mc.run_metrics_cycle(db, _sites(), ga4_client=FakeGA4Client(), gsc_client=FakeGSCClient())
    egress = store.query_egress(db)
    assert all(e["policy"] == "direct" for e in egress)
    assert all(e["exit_node"] == "direct" for e in egress)


def test_run_metrics_cycle_upserts_into_typed_tables(db):
    class OneRowGA4(FakeGA4Client):
        def execute(self):
            return {"rows": [{"dimensionValues": [{"value": "20260718"}],
                              "metricValues": [{"value": "1"}] * 8}],
                    "propertyQuota": {}}
    mc.run_metrics_cycle(db, {"xxxtea.com": _sites()["xxxtea.com"]},
                         ga4_client=OneRowGA4(), gsc_client=FakeGSCClient())
    rows = store.query_ga4_metrics(db, "xxxtea.com", grain="site")
    assert len(rows) == 1


def test_run_metrics_cycle_persists_gsc_page_grain(db):
    class PageAwareGSC(FakeGSCClient):
        def __init__(self):
            super().__init__()
            self.body = None
        def query(self, siteUrl=None, body=None):
            self.calls.append(siteUrl)
            self.body = body
            return self
        def execute(self):
            keys = ["2026-07-18", "https://xxxtea.com/guide"] if len(self.body["dimensions"]) > 1 else ["2026-07-18"]
            return {"rows": [{"keys": keys, "clicks": 2, "impressions": 20,
                              "ctr": 0.1, "position": 4.0}]}

    mc.run_metrics_cycle(db, {"xxxtea.com": _sites()["xxxtea.com"]},
                         ga4_client=FakeGA4Client(), gsc_client=PageAwareGSC())
    pages = store.query_gsc_metrics(db, "xxxtea.com", grain="page")
    assert len(pages) == 1
    assert pages[0]["dim_key"] == "https://xxxtea.com/guide"
