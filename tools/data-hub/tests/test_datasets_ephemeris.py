from datahub.datasets import ephemeris
from datahub.config import Source


def test_ephemeris_returns_one_record_with_signs():
    src = Source(id="eph", type="dataset", fetcher="ephemeris", dataset_key="ephemeris",
                 tags=["astro"], policy="direct")
    recs = ephemeris.fetch(src, proxy=None)
    assert len(recs) == 1
    p = recs[0]["payload"]
    # moon phase is a 0..100 illumination percentage
    assert 0.0 <= p["moon_phase_pct"] <= 100.0
    # zodiac signs are among the 12
    ZODIAC = {"Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra",
              "Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"}
    assert p["moon_sign"] in ZODIAC
    assert p["sun_sign"] in ZODIAC
    assert "Mars" in p["planet_longitudes"]
    assert recs[0]["observed_at"].endswith("+00:00") or recs[0]["observed_at"].endswith("Z")


def test_ephemeris_ignores_proxy_no_network():
    # proxy points at an unroutable address; fetch must still succeed (pure local compute)
    src = Source(id="eph", type="dataset", fetcher="ephemeris", dataset_key="ephemeris",
                 tags=["astro"], policy="direct")
    recs = ephemeris.fetch(src, proxy="http://10.255.255.1:9", settings=None)
    assert len(recs) == 1
