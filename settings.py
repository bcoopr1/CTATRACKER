"""
Back end for the Settings screen on the display.

Addresses, preferred buses and timing are saved to settings.local.json; the API key is saved
to .env. Both files are git-ignored, and both override config.json.
"""

import json
import os
import re
from pathlib import Path

from geocode import GeocodeError, geocode
from tracker import LOCAL_SETTINGS_NAME, read_local_settings

KEY_PATTERN = re.compile(r"^[A-Za-z0-9]{16,40}$")
THEMES = ("terminal", "studio", "mono", "candy")
ROUTE_PATTERN = re.compile(r"[A-Za-z]?\d{1,3}[A-Za-z]?")


class SettingsError(Exception):
    pass


def current_address(cfg, place):
    spot = cfg[place]
    if spot.get("address"):
        return spot["address"]
    return spot["label"] if spot.get("lat") is not None else ""


def describe(tracker):
    """Everything the Settings form needs, minus the API key itself."""
    cfg = tracker.cfg
    picked = [
        {"rt": r["rt"], "name": r["name"], "minutes": r.get("trip_minutes"),
         "board": r["home_stop"]["name"], "walk_min": round(r["walk_to_stop_min"])}
        for r in tracker._route_summaries() if r["found"]
    ]
    return {
        "home_address": current_address(cfg, "home"),
        "work_address": current_address(cfg, "work"),
        "home_matched": cfg["home"].get("matched", ""),
        "work_matched": cfg["work"].get("matched", ""),
        "routes": ", ".join(cfg["routes"]),
        "auto": tracker.auto,
        "picked": picked,
        "door_min": cfg["minutes_to_get_out_the_door"],
        "desk_min": cfg["minutes_from_stop_to_desk"],
        "theme": cfg["theme"],
        "api_key_set": bool(cfg["api_key"]),
    }


def _minutes(value, label):
    try:
        minutes = float(value)
    except (TypeError, ValueError):
        raise SettingsError(f"{label} should be a number of minutes.") from None
    if not 0 <= minutes <= 60:
        raise SettingsError(f"{label} should be between 0 and 60 minutes.")
    return int(minutes) if minutes.is_integer() else round(minutes, 1)


def _write_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_env_value(path, key, value):
    """Set KEY=value in a .env file, keeping everything else in it."""
    path = Path(path)
    lines = path.read_text(encoding="utf-8-sig").splitlines() if path.exists() else [
        "# Private settings. This file is git-ignored; don't commit it."]
    for i, line in enumerate(lines):
        if line.split("=", 1)[0].strip() == key:
            lines[i] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def save(payload, cfg, folder):
    """Validate and store a Settings form submission. Raises SettingsError with a readable message."""
    folder = Path(folder)
    local = read_local_settings(folder / LOCAL_SETTINGS_NAME)

    for place in ("home", "work"):
        text = " ".join(str(payload.get(f"{place}_address") or "").split())[:200]
        if not text:
            raise SettingsError(f"Enter your {place} address.")
        if text == current_address(cfg, place) and cfg[place].get("lat") is not None:
            spot = {k: cfg[place].get(k) for k in ("label", "lat", "lon", "matched")}
        else:
            try:
                found = geocode(text)
            except GeocodeError as exc:
                raise SettingsError(f"{place.title()} address: {exc}") from None
            label = "Home" if place == "home" else text.split(",")[0].strip()
            spot = {"label": label, "lat": found["lat"], "lon": found["lon"], "matched": found["matched"]}
        local[place] = {"address": text, **spot}

    routes = []
    for rt in ROUTE_PATTERN.findall(str(payload.get("routes") or "")):
        if rt.upper() not in routes:
            routes.append(rt.upper())
    local["routes"] = routes[:10]
    local["minutes_to_get_out_the_door"] = _minutes(payload.get("door_min"), "Time to get out the door")
    local["minutes_from_stop_to_desk"] = _minutes(payload.get("desk_min"), "Minutes to desk")
    theme = str(payload.get("theme") or "terminal")
    if theme not in THEMES:
        raise SettingsError("Pick one of the listed themes.")
    local["theme"] = theme

    key = str(payload.get("api_key") or "").strip()
    if key:
        if not KEY_PATTERN.match(key):
            raise SettingsError("That doesn't look like a CTA API key (letters and numbers only).")
        write_env_value(folder / ".env", "CTA_API_KEY", key)

    _write_json(folder / LOCAL_SETTINGS_NAME, local)
