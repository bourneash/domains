import httpx

from datahub.config import Source
from datahub.datasets import federal_register, ndbc


class Settings:
    pass


def test_federal_register_keeps_only_atlantic_fisheries():
    payload = {"results": [
        {"document_number": "2026-1", "title": "Atlantic Bluefin Tuna Retention Limit",
         "abstract": "NOAA adjusts the fishery.", "publication_date": "2026-09-17",
         "type": "Rule", "html_url": "https://federalregister.gov/d/2026-1", "agencies": []},
        {"document_number": "2026-2", "title": "Alaska Groundfish",
         "abstract": "Bering Sea fishery.", "publication_date": "2026-09-17",
         "type": "Rule", "html_url": "https://federalregister.gov/d/2026-2", "agencies": []},
    ]}
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload)))
    source = Source(id="fr", type="dataset", fetcher="federal-register",
                    dataset_key="fisheries-rules", tags=["regulations"])
    rows = federal_register.fetch(source, client=client, settings=Settings())
    assert len(rows) == 1
    assert rows[0]["payload"]["document_number"] == "2026-1"


def test_ndbc_parses_station_observations():
    xml = """<rss xmlns:georss="http://www.georss.org/georss"><channel><item>
      <title>Station 44009</title><link>https://www.ndbc.noaa.gov/station_page.php?station=44009</link>
      <pubDate>Thu, 17 Sep 2026 12:00:00 GMT</pubDate><georss:point>38.46 -74.70</georss:point>
      <description>Wave Height: 3.0 ft; Water Temperature: 72.1 F</description>
    </item></channel></rss>"""
    client = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, text=xml)))
    source = Source(id="ndbc", type="dataset", url="https://www.ndbc.noaa.gov/rss/x",
                    fetcher="ndbc", dataset_key="buoy-observations", tags=["buoys"])
    rows = ndbc.fetch(source, client=client, settings=Settings())
    station = rows[0]["payload"]["stations"][0]
    assert station["station"] == "Station 44009"
    assert station["lat"] == 38.46
    assert "Wave Height" in station["description"]
