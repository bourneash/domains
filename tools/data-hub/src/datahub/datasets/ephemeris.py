"""Local astronomical ephemeris via PyEphem — no network."""
import math
from datetime import datetime, timezone
import ephem

ZODIAC = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra",
          "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"]


def _sign(body) -> str:
    # Ecliptic longitude → 30°-wide zodiac sign.
    lon_deg = math.degrees(float(ephem.Ecliptic(body).lon)) % 360
    return ZODIAC[int(lon_deg // 30)]


def _lon(body) -> float:
    return round(math.degrees(float(ephem.Ecliptic(body).lon)) % 360, 2)


def fetch(source, *, proxy=None, settings=None, client=None) -> list[dict]:
    now = datetime.now(timezone.utc)
    obs_date = ephem.Date(now)
    sun = ephem.Sun(obs_date)
    moon = ephem.Moon(obs_date)
    planets = {
        "Mercury": ephem.Mercury(obs_date), "Venus": ephem.Venus(obs_date),
        "Mars": ephem.Mars(obs_date), "Jupiter": ephem.Jupiter(obs_date),
        "Saturn": ephem.Saturn(obs_date),
    }
    payload = {
        "moon_phase_pct": round(float(moon.phase), 2),   # 0..100 illuminated
        "moon_sign": _sign(moon),
        "sun_sign": _sign(sun),
        "planet_longitudes": {name: _lon(b) for name, b in planets.items()},
    }
    return [{"observed_at": now.isoformat(), "payload": payload}]
