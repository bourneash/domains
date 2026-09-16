import importlib.util
from pathlib import Path

MODULE = Path(__file__).with_name("portfolio_opportunities.py")
spec = importlib.util.spec_from_file_location("portfolio_opportunities", MODULE)
portfolio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portfolio)


def test_aggregate_weights_position_by_impressions():
    rows = [
        {"site": "x.test", "query": "widget", "page": "https://x.test/a", "clicks": 1,
         "impressions": 10, "position": 5},
        {"site": "x.test", "query": "widget", "page": "https://x.test/a", "clicks": 0,
         "impressions": 30, "position": 15},
    ]
    result = portfolio.aggregate(rows)[0]
    assert result["impressions"] == 40
    assert result["clicks"] == 1
    assert result["position"] == 12.5


def test_score_only_accepts_opportunity_band():
    base = {"impressions": 100, "clicks": 0, "ctr": 0}
    assert portfolio.opportunity_score({**base, "position": 8}) > 0
    assert portfolio.opportunity_score({**base, "position": 4}) == 0
    assert portfolio.opportunity_score({**base, "position": 21}) == 0


def test_low_ctr_scores_above_high_ctr():
    base = {"impressions": 100, "clicks": 0, "position": 8}
    assert portfolio.opportunity_score({**base, "ctr": 0}) > portfolio.opportunity_score({**base, "ctr": 0.05})
