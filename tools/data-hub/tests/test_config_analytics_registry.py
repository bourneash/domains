from datahub.config import load_analytics_registry


def test_load_analytics_registry_parses_all_fields(tmp_path):
    path = tmp_path / "sites-analytics.yaml"
    path.write_text(
        "sites:\n"
        "  xxxtea.com:\n"
        "    ga4_property_id: '539743210'\n"
        "    ga4_measurement_id: G-P889LLFBNK\n"
        "    gsc_property: sc-domain:xxxtea.com\n"
        "    consent_gated: false\n"
        "  saveusfarms.com:\n"
        "    ga4_property_id: '542493246'\n"
        "    ga4_measurement_id: G-GDYX2GPMMJ\n"
        "    gsc_property: sc-domain:saveusfarms.com\n"
        "    consent_gated: true\n"
    )
    sites = load_analytics_registry(str(path))
    assert set(sites) == {"xxxtea.com", "saveusfarms.com"}
    assert sites["xxxtea.com"].ga4_property_id == "539743210"
    assert sites["xxxtea.com"].consent_gated is False
    assert sites["saveusfarms.com"].consent_gated is True


def test_load_analytics_registry_handles_null_measurement_id(tmp_path):
    path = tmp_path / "sites-analytics.yaml"
    path.write_text(
        "sites:\n"
        "  3boobs.com:\n"
        "    ga4_property_id: '540969570'\n"
        "    ga4_measurement_id: null\n"
        "    gsc_property: sc-domain:3boobs.com\n"
        "    consent_gated: false\n"
    )
    sites = load_analytics_registry(str(path))
    assert sites["3boobs.com"].ga4_measurement_id is None


def test_load_analytics_registry_missing_file_returns_empty(tmp_path):
    sites = load_analytics_registry(str(tmp_path / "nope.yaml"))
    assert sites == {}
