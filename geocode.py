"""
Address lookup for the settings screen.

Tries the US Census geocoder first (good with street addresses, no key needed), then
OpenStreetMap's Nominatim (handles building and place names like "Willis Tower").
Results outside the Chicago area are rejected since CTA buses don't go there.
"""

import json
import urllib.parse
import urllib.request

CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "cta-commute-display/1.0 (personal transit display)"}

# Rough box around CTA's bus service area: lat_min, lat_max, lon_min, lon_max
CTA_AREA = (41.60, 42.10, -87.95, -87.52)


class GeocodeError(Exception):
    pass


def _get_json(url, timeout=10):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _census(query):
    url = CENSUS_URL + "?" + urllib.parse.urlencode(
        {"address": query, "benchmark": "Public_AR_Current", "format": "json"})
    for match in _get_json(url).get("result", {}).get("addressMatches", []):
        coords = match["coordinates"]
        yield float(coords["y"]), float(coords["x"]), match.get("matchedAddress") or query


def _nominatim(query):
    lat_min, lat_max, lon_min, lon_max = CTA_AREA
    url = NOMINATIM_URL + "?" + urllib.parse.urlencode({
        "q": query, "format": "json", "limit": 3, "countrycodes": "us",
        "viewbox": f"{lon_min},{lat_max},{lon_max},{lat_min}", "bounded": 1,
    })
    for match in _get_json(url):
        yield float(match["lat"]), float(match["lon"]), match.get("display_name") or query


def in_cta_area(lat, lon):
    lat_min, lat_max, lon_min, lon_max = CTA_AREA
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def geocode(address):
    """Return {"lat", "lon", "matched"} for an address or place name in the Chicago area."""
    address = " ".join((address or "").split())
    if not address:
        raise GeocodeError("Enter an address.")
    # "233 S Wacker Dr" on its own is ambiguous nationwide; assume Chicago unless a city is given.
    query = address if "," in address else f"{address}, Chicago, IL"
    reachable = False
    for source in (_census, _nominatim):
        try:
            for lat, lon, matched in source(query):
                reachable = True
                if in_cta_area(lat, lon):
                    return {"lat": round(lat, 6), "lon": round(lon, 6), "matched": matched}
        except Exception:
            continue
    if not reachable:
        raise GeocodeError(f"Couldn't look up “{address}”. Check the address, or the internet connection.")
    raise GeocodeError(f"“{address}” isn't in the CTA service area.")
