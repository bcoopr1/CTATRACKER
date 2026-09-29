"""
Small client for the CTA Bus Tracker API, version 3.

Official docs: https://www.transitchicago.com/developers/bustracker/
(PDF: "Bus Tracker API Developer Guide and Documentation", rev. 2025-04-21)

Only the Python standard library is used, so nothing needs to be pip-installed.
"""

import json
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

BASE_URL = "https://www.ctabustracker.com/bustime/api/v3/"
ALERTS_URL = "https://www.transitchicago.com/api/1.0/alerts.aspx"

# BusTime answers "nothing to report right now" with an error message instead of an
# empty list. These are normal (e.g. late at night) and must not be treated as failures.
QUIET_ERRORS = ("no data found", "no arrival times", "no service scheduled")

# Dynamic action types (see "Dynamic Action Types" in the API guide).
DYN_CANCELED = {1, 18}
DYN_EXPRESSED = {4}              # drop-off only: the bus will not pick you up
DYN_HIDDEN = {12, 16, 17}        # "should not be shown to the public"


class CTAError(Exception):
    """Raised when the API (or the network) fails in a way the caller should show."""


def as_list(value):
    """BusTime JSON sometimes gives a single object where a list is expected."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def chunked(items, size=10):
    """Most list parameters accept at most 10 ids per request."""
    items = list(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]


# ---------------------------------------------------------------------------
# Time handling
#
# BusTime reports local Chicago wall-clock time ("YYYYMMDD HH:MM[:SS]"), or epoch
# milliseconds when unixTime=true. Windows Python usually ships without tz data,
# so fall back to the US daylight-saving rules if zoneinfo can't load Chicago.
# ---------------------------------------------------------------------------

try:
    from zoneinfo import ZoneInfo
    CHICAGO = ZoneInfo("America/Chicago")
except Exception:  # ZoneInfoNotFoundError, ImportError
    CHICAGO = None


def _nth_sunday(year, month, n):
    first = datetime(year, month, 1)
    return first + timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))


def _chicago_utc_offset_hours(local_naive):
    """-5 during daylight time (2nd Sun of March 2am -> 1st Sun of Nov 2am), else -6."""
    dst_start = _nth_sunday(local_naive.year, 3, 2).replace(hour=2)
    dst_end = _nth_sunday(local_naive.year, 11, 1).replace(hour=2)
    return -5 if dst_start <= local_naive < dst_end else -6


def chicago_to_epoch(local_naive):
    if CHICAGO is not None:
        return local_naive.replace(tzinfo=CHICAGO).timestamp()
    utc = local_naive - timedelta(hours=_chicago_utc_offset_hours(local_naive))
    return utc.replace(tzinfo=timezone.utc).timestamp()


def epoch_to_chicago(epoch):
    if CHICAGO is not None:
        return datetime.fromtimestamp(epoch, CHICAGO).replace(tzinfo=None)
    standard = datetime.fromtimestamp(epoch, timezone.utc).replace(tzinfo=None) - timedelta(hours=6)
    dst_start = _nth_sunday(standard.year, 3, 2).replace(hour=2)
    dst_end = _nth_sunday(standard.year, 11, 1).replace(hour=1)  # 2am CDT is 1am CST
    return standard + timedelta(hours=1) if dst_start <= standard < dst_end else standard


def parse_cta_time(value):
    """Return epoch seconds for any BusTime timestamp, or None if it can't be read."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value) / 1000.0
    text = str(value).strip()
    if text.isdigit() and len(text) >= 12:
        return int(text) / 1000.0
    for fmt in ("%Y%m%d %H:%M:%S", "%Y%m%d %H:%M"):
        try:
            return chicago_to_epoch(datetime.strptime(text, fmt))
        except ValueError:
            pass
    return None


def format_cta_time(epoch, seconds=True):
    return epoch_to_chicago(epoch).strftime("%Y%m%d %H:%M:%S" if seconds else "%Y%m%d %H:%M")


def to_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def to_int(value, default=None):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class CTAClient:
    """
    Thin wrapper over the BusTime v3 endpoints this project needs.

    `fetch` can be swapped for a fake (see demo.py); it receives (method, params)
    and must return the decoded JSON document ({"bustime-response": {...}}).
    """

    def __init__(self, api_key, timeout=12, fetch=None):
        self.api_key = (api_key or "").strip()
        self.timeout = timeout
        self._fetch = fetch or self._http_get
        self.calls_today = 0
        self._calls_day = date.today()
        self._count_lock = threading.Lock()
        self.warnings = []

    # -- plumbing ----------------------------------------------------------

    def _http_get(self, method, params):
        query = urllib.parse.urlencode({"key": self.api_key, "format": "json", **params})
        request = urllib.request.Request(
            BASE_URL + method + "?" + query,
            headers={"User-Agent": "living-room-cta-tracker/1.0"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise CTAError(f"CTA server returned HTTP {exc.code}") from None
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
            reason = getattr(exc, "reason", exc)
            raise CTAError(f"Can't reach ctabustracker.com ({reason})") from None
        except json.JSONDecodeError:
            raise CTAError("CTA sent a response that isn't valid JSON") from None

    def _count_call(self):
        with self._count_lock:   # route discovery calls in parallel
            today = date.today()
            if today != self._calls_day:
                self._calls_day, self.calls_today = today, 0
            self.calls_today += 1

    def call(self, method, list_key, **params):
        """Call `method` and return the list stored under `list_key` (possibly empty)."""
        if not self.api_key and self._fetch == self._http_get:
            raise CTAError("No CTA API key yet: put CTA_API_KEY=your-key in the .env file.")
        params = {k: v for k, v in params.items() if v not in (None, "")}
        self._count_call()
        document = self._fetch(method, params)
        body = document.get("bustime-response", {}) if isinstance(document, dict) else {}
        data = as_list(body.get(list_key))
        problems = []
        for err in as_list(body.get("error")):
            msg = (err.get("msg") if isinstance(err, dict) else str(err)) or "Unknown CTA error"
            if not msg.lower().startswith(QUIET_ERRORS):
                problems.append(msg)
        if problems and not data:
            raise CTAError("; ".join(dict.fromkeys(problems)))
        if problems:
            # Partial success (e.g. one bad stop id among several): keep going, but remember why.
            self.warnings.extend(problems)
        return data

    # -- endpoints ---------------------------------------------------------

    def get_routes(self):
        return self.call("getroutes", "routes")

    def get_patterns(self, rt=None, pids=None):
        if rt is not None:
            return self.call("getpatterns", "ptr", rt=rt)
        found = []
        for group in chunked(pids or []):
            found += self.call("getpatterns", "ptr", pid=",".join(map(str, group)))
        return found

    def get_predictions_for_stops(self, stpids, routes=None):
        found = []
        for group in chunked(stpids):
            found += self.call(
                "getpredictions", "prd",
                stpid=",".join(group),
                rt=",".join(routes or []),
                tmres="s",
                unixTime="true",
            )
        return found

    def get_predictions_for_vehicles(self, vids):
        found = []
        for group in chunked(vids):
            found += self.call("getpredictions", "prd", vid=",".join(group), tmres="s", unixTime="true")
        return found

    def get_vehicles_for_routes(self, routes):
        found = []
        for group in chunked(routes):
            found += self.call("getvehicles", "vehicle", rt=",".join(group), tmres="s")
        return found


def fetch_alerts(routes, timeout=10):
    """
    Active service alerts from the CTA Customer Alerts API (no key needed).
    Returns a list of {"id", "headline", "text", "routes", "severity", "major"}.
    """
    if not routes:
        return []
    query = urllib.parse.urlencode({
        "routeid": ",".join(routes), "activeonly": "true", "outputType": "JSON",
    })
    request = urllib.request.Request(ALERTS_URL + "?" + query,
                                     headers={"User-Agent": "living-room-cta-tracker/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        document = json.loads(response.read().decode("utf-8"))
    alerts = []
    for alert in as_list(document.get("CTAAlerts", {}).get("Alert")):
        services = as_list((alert.get("ImpactedService") or {}).get("Service"))
        alerts.append({
            "id": alert.get("AlertId"),
            "headline": (alert.get("Headline") or "").strip(),
            "text": " ".join((alert.get("ShortDescription") or "").split()),
            "routes": [s.get("ServiceId") for s in services if s.get("ServiceType") == "B"],
            "severity": to_int(alert.get("SeverityScore"), 0),
            "major": alert.get("MajorAlert") == "1",
        })
    alerts.sort(key=lambda a: -a["severity"])
    return alerts
