"""
Commute tracker: finds your stops and turns live CTA Bus Tracker data into a departure board.

    python tracker.py              one snapshot in the terminal
    python tracker.py --watch      keep refreshing in the terminal
    python tracker.py --stops      show which stops were picked for each route
    python tracker.py --demo       simulated buses (no API key needed)

The living-room display is served by server.py, which uses the same Tracker.
"""

import argparse
import hashlib
import json
import math
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from cta import (
    DYN_CANCELED, DYN_EXPRESSED, DYN_HIDDEN, CTAClient, CTAError, as_list,
    epoch_to_chicago, fetch_alerts, parse_cta_time, to_float, to_int,
)

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"

FT_PER_M = 3.28084
M_PER_MILE = 1609.344

DEFAULTS = {
    "api_key": "",
    "routes": [],
    "home": {"label": "Home", "lat": None, "lon": None},   # real values come from .env
    "work": {"label": "Work", "lat": None, "lon": None},
    "walk_speed_mph": 3.0,
    "walk_detour_factor": 1.3,
    "minutes_to_get_out_the_door": 3,
    "minutes_from_stop_to_desk": 2,
    "max_walk_to_stop_m": 1000,
    "catch_grace_seconds": 60,
    "fallback_bus_mph": 11,
    "poll_seconds": 30,
    "idle_poll_seconds": 300,
    "active_hours": ["05:00", "23:30"],
    "stop_overrides": {},
    "host": "0.0.0.0",
    "port": 8095,
}

REDISCOVER_SECONDS = 6 * 3600       # refresh patterns (detours change them)
NO_PLAN_RETRY_SECONDS = 600         # if no route fits, don't hammer getpatterns
ALERTS_SECONDS = 600
LIMIT_BACKOFF_SECONDS = 900
UPSTREAM_M = 3 * M_PER_MILE         # how far "up the line" the map and trajectory look
MAX_TRACKED_VEHICLES = 10           # getpredictions accepts at most 10 vids per call


def read_env_file(path):
    """Minimal .env reader: KEY=value lines, # comments, optional quotes."""
    values = {}
    if not Path(path).exists():
        return values
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


def load_config(path=CONFIG_PATH):
    cfg = json.loads(json.dumps(DEFAULTS))
    if Path(path).exists():
        with open(path, encoding="utf-8-sig") as fh:
            user = json.load(fh)
        for key, value in user.items():
            if key.startswith("_"):
                continue
            if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                cfg[key].update(value)
            else:
                cfg[key] = value
    # Private values (API key, home & work) belong in .env, which is git-ignored.
    # A real environment variable wins over the file.
    secrets = read_env_file(Path(path).resolve().parent / ".env")

    def private(name):
        return os.environ.get(name) or secrets.get(name)

    cfg["api_key"] = (private("CTA_API_KEY") or cfg["api_key"] or "").strip()
    if cfg["api_key"].upper().startswith("PASTE"):
        cfg["api_key"] = ""
    for place in ("home", "work"):
        prefix = place.upper()
        if private(f"{prefix}_LABEL"):
            cfg[place]["label"] = private(f"{prefix}_LABEL")
        for axis in ("lat", "lon"):
            value = to_float(private(f"{prefix}_{axis.upper()}"), cfg[place][axis])
            cfg[place][axis] = to_float(value)
    cfg["routes"] = [str(r).strip().upper() for r in as_list(cfg["routes"]) if str(r).strip()]
    return cfg


def distance_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in meters."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(a))


def truthy(value):
    return value is True or str(value).strip().lower() == "true"


class Pattern:
    """One getpatterns 'ptr': the ordered path a trip follows, with its stops."""

    def __init__(self, ptr, rt):
        self.pid = str(ptr.get("pid"))
        self.rt = rt
        self.rtdir = ptr.get("rtdir") or ""
        self.detour = bool(ptr.get("dtrid"))
        self.points = []
        self.stops = []
        for pt in sorted(as_list(ptr.get("pt")), key=lambda p: to_int(p.get("seq"), 0)):
            lat, lon = to_float(pt.get("lat")), to_float(pt.get("lon"))
            if lat is None or lon is None:
                continue
            self.points.append((lat, lon))
            if pt.get("typ") == "S" and pt.get("stpid"):
                self.stops.append({
                    "stpid": str(pt["stpid"]),
                    "name": pt.get("stpnm") or f"Stop {pt['stpid']}",
                    "lat": lat, "lon": lon,
                    # pdist is only meaningful for stops (waypoints report 0)
                    "pdist": to_float(pt.get("pdist"), 0.0),
                    "index": len(self.points) - 1,
                })
        self.stops.sort(key=lambda s: s["pdist"])
        self.by_id = {s["stpid"]: s for s in self.stops}


@dataclass
class Plan:
    """A pattern that takes you from a stop near home to a stop near work."""
    pattern: Pattern
    home: dict
    work: dict
    walk_to_m: float
    walk_from_m: float

    @property
    def ride_ft(self):
        return self.work["pdist"] - self.home["pdist"]


class Tracker:
    def __init__(self, cfg, client, demo=False):
        self.cfg = cfg
        self.client = client
        self.demo = demo
        self.routes = list(cfg["routes"])
        self.patterns = {}
        self.plans = {}
        self.route_names = {}
        self.unknown_routes = []
        self.silent_routes = []
        self.bad_pids = {}
        self.discovered_at = 0.0
        self.alerts = []
        self.alerts_at = 0.0
        self.geometry = {"version": "", "routes": []}
        self.last_good = None
        self.updated_at = None
        self.backoff_until = 0.0

    # ------------------------------------------------------------------
    # Walking & schedule helpers
    # ------------------------------------------------------------------

    def walk_minutes(self, meters):
        meters_per_min = self.cfg["walk_speed_mph"] * M_PER_MILE / 60.0
        return meters * self.cfg["walk_detour_factor"] / meters_per_min

    def is_active(self, now):
        start, end = self.cfg["active_hours"]
        local = epoch_to_chicago(now).strftime("%H:%M")
        return start <= local < end if start <= end else (local >= start or local < end)

    def poll_interval(self, now=None):
        now = now or time.time()
        if now < self.backoff_until:
            return LIMIT_BACKOFF_SECONDS
        return self.cfg["poll_seconds"] if self.is_active(now) else self.cfg["idle_poll_seconds"]

    # ------------------------------------------------------------------
    # Discovery: which stop near home / near work does each pattern use?
    # ------------------------------------------------------------------

    def discover(self):
        names = {str(r.get("rt")): r.get("rtnm", "") for r in self.client.get_routes()}
        self.route_names = names
        self.unknown_routes = [rt for rt in self.routes if rt not in names]
        patterns, plans = {}, {}
        self.silent_routes = []
        for rt in self.routes:
            if rt in self.unknown_routes:
                continue
            ptrs = self.client.get_patterns(rt=rt)
            if not ptrs:
                self.silent_routes.append(rt)
            for ptr in ptrs:
                pattern = Pattern(ptr, rt)
                patterns[pattern.pid] = pattern
                plan = self._make_plan(pattern)
                if plan:
                    plans[pattern.pid] = plan
        self.patterns, self.plans = patterns, plans
        self.discovered_at = time.time()
        self._rebuild_geometry()

    def _make_plan(self, pattern):
        if not pattern.stops:
            return None
        home, work = self.cfg["home"], self.cfg["work"]
        override = self.cfg["stop_overrides"].get(pattern.rt) or {}
        limit = self.cfg["max_walk_to_stop_m"]

        def from_home(s):
            return distance_m(home["lat"], home["lon"], s["lat"], s["lon"])

        def to_work(s):
            return distance_m(work["lat"], work["lon"], s["lat"], s["lon"])

        if override.get("home"):
            h = pattern.by_id.get(str(override["home"]))
        else:
            h = min(pattern.stops, key=from_home)
            if from_home(h) > limit:
                return None
        if h is None:
            return None

        downstream = [s for s in pattern.stops if s["pdist"] > h["pdist"]]
        if override.get("work"):
            w = next((s for s in downstream if s["stpid"] == str(override["work"])), None)
        else:
            w = min(downstream, key=to_work, default=None)
            if w is not None and to_work(w) > limit:
                return None
        if w is None:
            return None
        return Plan(pattern, h, w, from_home(h), to_work(w))

    def _ensure_patterns(self, pid_routes):
        """Fetch patterns we haven't seen (new trips, fresh detours), at most one call's worth."""
        now = time.time()
        missing = [pid for pid in pid_routes
                   if pid and pid not in self.patterns and now - self.bad_pids.get(pid, 0) > 1800][:10]
        if not missing:
            return
        try:
            ptrs = self.client.get_patterns(pids=missing)
        except CTAError:
            ptrs = []
        found = set()
        for ptr in ptrs:
            pid = str(ptr.get("pid"))
            pattern = Pattern(ptr, pid_routes.get(pid, ""))
            self.patterns[pid] = pattern
            found.add(pid)
            plan = self._make_plan(pattern)
            if plan:
                self.plans[pid] = plan
        for pid in set(missing) - found:
            self.bad_pids[pid] = now
        if any(pid in self.plans for pid in found):
            self._rebuild_geometry()

    def _main_plan(self, rt):
        plans = [p for p in self.plans.values() if p.pattern.rt == rt]
        if not plans:
            return None
        return max(plans, key=lambda p: (not p.pattern.detour, len(p.pattern.stops), p.pattern.pid))

    def _rebuild_geometry(self):
        """Route shapes for the radar map and trajectory strip (home-upstream through work)."""
        shapes = []
        for rt in self.routes:
            plan = self._main_plan(rt)
            if not plan:
                continue
            pts = plan.pattern.points
            start, meters = plan.home["index"], 0.0
            while start > 0 and meters < UPSTREAM_M:
                meters += distance_m(*pts[start - 1], *pts[start])
                start -= 1
            upstream_ft = meters * FT_PER_M
            end = min(len(pts), plan.work["index"] + 4)
            shapes.append({
                "rt": rt,
                "pid": plan.pattern.pid,
                "rtdir": plan.pattern.rtdir,
                "path": [[round(lat, 5), round(lon, 5)] for lat, lon in pts[start:end]],
                "stops": [
                    {"name": s["name"], "lat": s["lat"], "lon": s["lon"],
                     "offset_ft": round(s["pdist"] - plan.home["pdist"])}
                    for s in plan.pattern.stops
                    if plan.home["pdist"] - upstream_ft <= s["pdist"] <= plan.work["pdist"]
                ],
                "home_stop": {"name": plan.home["name"], "lat": plan.home["lat"], "lon": plan.home["lon"]},
                "work_stop": {"name": plan.work["name"], "lat": plan.work["lat"], "lon": plan.work["lon"]},
                "upstream_ft": round(upstream_ft),
                "ride_ft": round(plan.ride_ft),
            })
        digest = hashlib.sha1(json.dumps(shapes, sort_keys=True).encode()).hexdigest()[:12]
        self.geometry = {"version": digest, "routes": shapes}

    # ------------------------------------------------------------------
    # Polling
    # ------------------------------------------------------------------

    def poll(self):
        now = time.time()
        self.client.warnings.clear()
        missing = []
        if not self.demo and not self.client.api_key:
            missing.append("No CTA API key yet: put CTA_API_KEY=your-key in the .env file.")
        for place in ("home", "work"):
            if self.cfg[place]["lat"] is None or self.cfg[place]["lon"] is None:
                prefix = place.upper()
                missing.append(f"No {place} location yet: put {prefix}_LAT and {prefix}_LON "
                               f"(and optionally {prefix}_LABEL) in the .env file.")
        if not self.routes:
            missing.append("No bus routes yet: add your route numbers to config.json (\"routes\": [\"146\", ...]).")
        if missing:
            return self._state(now, error=" ".join(missing) + " Then restart.", setup=True)
        try:
            due = now - self.discovered_at > (REDISCOVER_SECONDS if self.plans else NO_PLAN_RETRY_SECONDS)
            if due:
                self.discover()
            if not self.plans:
                return self._state(now, error=self._no_plan_message(), setup=True)
            state = self._poll_live(now)
        except CTAError as exc:
            if "transaction limit" in str(exc).lower():
                self.backoff_until = now + LIMIT_BACKOFF_SECONDS
            return self._state(now, error=str(exc))
        self._refresh_alerts(now)
        state["alerts"] = self.alerts
        return state

    def _no_plan_message(self):
        if self.unknown_routes:
            return f"CTA doesn't recognize route(s) {', '.join(self.unknown_routes)}. Check config.json."
        if self.silent_routes and len(self.silent_routes) == len(self.routes):
            return (f"CTA has no active patterns for {', '.join(self.silent_routes)} right now "
                    "(not running at this hour?). Retrying every 10 minutes.")
        limit = self.cfg["max_walk_to_stop_m"]
        return (f"None of routes {', '.join(self.routes)} stop within {limit} m of both home and work. "
                "Raise max_walk_to_stop_m or set stop_overrides in config.json.")

    def _refresh_alerts(self, now):
        if now - self.alerts_at < ALERTS_SECONDS or self.demo:
            return
        self.alerts_at = now
        try:
            self.alerts = fetch_alerts(self.routes)[:8]
        except Exception:
            pass  # alerts are a nice-to-have; keep the previous ones

    def _plan_for(self, rt, stpid, vehicle):
        candidates = [p for p in self.plans.values() if p.pattern.rt == rt and p.home["stpid"] == stpid]
        if not candidates:
            return None
        if vehicle and self.plans.get(vehicle["pid"]) in candidates:
            return self.plans[vehicle["pid"]]
        return max(candidates, key=lambda p: (not p.pattern.detour, len(p.pattern.stops), p.pattern.pid))

    @staticmethod
    def _vehicle(v):
        return {
            "vid": str(v.get("vid")),
            "rt": str(v.get("rt")),
            "lat": to_float(v.get("lat")),
            "lon": to_float(v.get("lon")),
            "hdg": to_int(v.get("hdg"), 0),
            "pid": str(v.get("pid")) if v.get("pid") is not None else "",
            "pdist": to_float(v.get("pdist"), 0.0),
            "des": v.get("des") or "",
            "speed_mph": to_int(v.get("spd")),
            "load": v.get("psgld") or "",
            "delayed": truthy(v.get("dly")),
            "seen": parse_cta_time(v.get("tmstmp")),
        }

    def _where(self, vehicle, plan):
        """Plain-English position of a bus relative to your stop."""
        info = {"near": None, "next_stop": None, "stops_away": None, "on_trip": False,
                "rtdir": None, "miles_away": None}
        pattern = self.patterns.get(vehicle["pid"])
        if not pattern or not pattern.stops or vehicle["lat"] is None:
            return info
        info["rtdir"] = pattern.rtdir
        near = min(pattern.stops, key=lambda s: distance_m(vehicle["lat"], vehicle["lon"], s["lat"], s["lon"]))
        info["near"] = near["name"]
        ahead = [s for s in pattern.stops if s["pdist"] > vehicle["pdist"]]
        info["next_stop"] = ahead[0]["name"] if ahead else None
        home_here = pattern.by_id.get(plan.home["stpid"])
        if home_here and home_here["pdist"] >= vehicle["pdist"]:
            info["on_trip"] = True
            info["stops_away"] = sum(1 for s in ahead if s["pdist"] <= home_here["pdist"])
            info["miles_away"] = round((home_here["pdist"] - vehicle["pdist"]) / 5280, 2)
        return info

    def _estimate_work_arrival(self, arrive_stop, plan, vid_preds):
        """No CTA prediction reaches work yet: extrapolate from the bus's own pace, else a default speed."""
        best = None
        for stpid, t in vid_preds:
            s = plan.pattern.by_id.get(stpid)
            if s and plan.home["pdist"] < s["pdist"] <= plan.work["pdist"] and t > arrive_stop:
                if best is None or s["pdist"] > best[0]:
                    best = (s["pdist"], t)
        ft_per_s = None
        if best and best[0] - plan.home["pdist"] >= 0.25 * plan.ride_ft:
            ft_per_s = (best[0] - plan.home["pdist"]) / (best[1] - arrive_stop)
        if not ft_per_s or ft_per_s <= 0:
            ft_per_s = self.cfg["fallback_bus_mph"] * 5280 / 3600
        return arrive_stop + plan.ride_ft / ft_per_s

    def _poll_live(self, now):
        routes = [rt for rt in self.routes if any(p.pattern.rt == rt for p in self.plans.values())]
        home_stops = sorted({p.home["stpid"] for p in self.plans.values()})

        stop_preds = self.client.get_predictions_for_stops(home_stops, routes)
        vehicles = {}
        for raw in self.client.get_vehicles_for_routes(routes):
            v = self._vehicle(raw)
            vehicles[v["vid"]] = v
        self._ensure_patterns({v["pid"]: v["rt"] for v in vehicles.values()})

        door = self.cfg["minutes_to_get_out_the_door"]
        desk = self.cfg["minutes_from_stop_to_desk"]

        # 1) Buses heading for one of your home stops
        arrivals, seen = [], set()
        for p in stop_preds:
            dyn = to_int(p.get("dyn"), 0)
            if dyn in DYN_HIDDEN:
                continue
            rt, stpid, vid = str(p.get("rt")), str(p.get("stpid")), str(p.get("vid"))
            t = parse_cta_time(p.get("prdtm"))
            plan = self._plan_for(rt, stpid, vehicles.get(vid))
            if plan is None or t is None or (vid, stpid) in seen:
                continue
            seen.add((vid, stpid))
            walk_to = self.walk_minutes(plan.walk_to_m)
            arrivals.append({
                "key": f"{vid}:{stpid}:{int(t)}",
                "rt": rt,
                "route_name": self.route_names.get(rt, ""),
                "rtdir": p.get("rtdir") or plan.pattern.rtdir,
                "des": p.get("des") or "",
                "vid": vid,
                "stop_id": stpid,
                "stop_name": plan.home["name"],
                "arrive_stop": t,
                "cta_countdown": str(p.get("prdctdn") or ""),
                "dstp_ft": to_int(p.get("dstp")),
                "delayed": truthy(p.get("dly")),
                "canceled": dyn in DYN_CANCELED,
                "expressed": dyn in DYN_EXPRESSED,
                "load": p.get("psgld") or "",
                "walk_to_stop_min": round(walk_to, 1),
                "leave_by": t - (walk_to + door) * 60,
                "_plan": plan,
            })
        arrivals.sort(key=lambda a: a["arrive_stop"])

        # 2) Buses already past your stop and on their way downtown (for the map)
        inflight = []
        for v in vehicles.values():
            plan = self.plans.get(v["pid"])
            if plan and plan.home["pdist"] < v["pdist"] < plan.work["pdist"]:
                inflight.append({"vid": v["vid"], "rt": v["rt"], "des": v["des"],
                                 "track_ft": round(v["pdist"] - plan.home["pdist"]),
                                 "ride_ft": round(plan.ride_ft), "_plan": plan})
        inflight.sort(key=lambda b: -b["track_ft"])

        # 3) Every stop ahead of the buses we care about -> arrival time at your work stop
        watch = list(dict.fromkeys(a["vid"] for a in arrivals if not a["canceled"]))[:8]
        watch += [b["vid"] for b in inflight if b["vid"] not in watch]
        watch = watch[:MAX_TRACKED_VEHICLES]
        vid_preds = defaultdict(list)
        if watch:
            for p in self.client.get_predictions_for_vehicles(watch):
                if to_int(p.get("dyn"), 0) in DYN_HIDDEN | DYN_CANCELED:
                    continue
                t = parse_cta_time(p.get("prdtm"))
                if t is not None:
                    vid_preds[str(p.get("vid"))].append((str(p.get("stpid")), t))

        for a in arrivals:
            plan = a.pop("_plan")
            work_plans = {p.work["stpid"]: p for p in self.plans.values()
                          if p.pattern.rt == a["rt"] and p.home["stpid"] == a["stop_id"]}
            hit = next(((stpid, t) for stpid, t in sorted(vid_preds[a["vid"]], key=lambda x: x[1])
                        if stpid in work_plans and t > a["arrive_stop"]), None)
            if hit:
                work_plan, arrive_work = work_plans[hit[0]], hit[1]
                a["work_eta_source"] = "cta"
            else:
                work_plan = plan
                arrive_work = self._estimate_work_arrival(a["arrive_stop"], plan, vid_preds[a["vid"]])
                a["work_eta_source"] = "estimate"
            walk_from = self.walk_minutes(work_plan.walk_from_m)
            a.update({
                "work_stop_id": work_plan.work["stpid"],
                "work_stop_name": work_plan.work["name"],
                "arrive_work_stop": arrive_work,
                "walk_from_stop_min": round(walk_from, 1),
                "at_desk": arrive_work + (walk_from + desk) * 60,
                "ride_min": round((arrive_work - a["arrive_stop"]) / 60, 1),
                "track_ft": -(a["dstp_ft"] or 0),
            })
            a["door_to_door_min"] = round((a["at_desk"] - a["leave_by"]) / 60, 1)
            v = vehicles.get(a["vid"])
            if v:
                a["vehicle"] = {**{k: v[k] for k in ("lat", "lon", "hdg", "speed_mph", "seen", "des")},
                                **self._where(v, plan)}
                a["load"] = a["load"] or v["load"]
                a["delayed"] = a["delayed"] or v["delayed"]
            else:
                a["vehicle"] = None

        for b in inflight:
            plan = b.pop("_plan")
            t = next((t for stpid, t in sorted(vid_preds[b["vid"]], key=lambda x: x[1])
                      if stpid == plan.work["stpid"]), None)
            b["arrive_work_stop"] = t

        # 4) Everything for the radar
        toward_work = {p.pattern.pid for p in self.plans.values()}
        next_eta = {}
        for a in arrivals:
            next_eta.setdefault(a["vid"], a["arrive_stop"])
        radar = [{
            "vid": v["vid"], "rt": v["rt"], "lat": v["lat"], "lon": v["lon"], "hdg": v["hdg"],
            "toward_work": v["pid"] in toward_work or v["vid"] in next_eta,
            "eta": next_eta.get(v["vid"]),
        } for v in vehicles.values() if v["lat"] is not None]

        self.updated_at = now
        state = self._state(now, arrivals=arrivals, inflight=inflight, vehicles=radar)
        self.last_good = state
        return state

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------

    def _route_summaries(self):
        out = []
        for rt in self.routes:
            plan = self._main_plan(rt)
            entry = {"rt": rt, "name": self.route_names.get(rt, ""), "found": plan is not None}
            if plan:
                entry.update({
                    "rtdir": plan.pattern.rtdir,
                    "home_stop": {"id": plan.home["stpid"], "name": plan.home["name"],
                                  "walk_m": round(plan.walk_to_m)},
                    "work_stop": {"id": plan.work["stpid"], "name": plan.work["name"],
                                  "walk_m": round(plan.walk_from_m)},
                    "walk_to_stop_min": round(self.walk_minutes(plan.walk_to_m), 1),
                    "walk_from_stop_min": round(self.walk_minutes(plan.walk_from_m), 1),
                })
            out.append(entry)
        return out

    def _state(self, now, arrivals=None, inflight=None, vehicles=None, error=None, setup=False):
        stale = error is not None and self.last_good is not None and not setup
        base = self.last_good if stale else {}
        return {
            "generated_at": now,
            "updated_at": self.updated_at,
            "ok": error is None,
            "error": error,
            "stale": stale,
            "setup_needed": setup,
            "warnings": list(dict.fromkeys(self.client.warnings))[:5],
            "demo": self.demo,
            "active": self.is_active(now),
            "home": self.cfg["home"],
            "work": self.cfg["work"],
            "settings": {
                "door_min": self.cfg["minutes_to_get_out_the_door"],
                "desk_min": self.cfg["minutes_from_stop_to_desk"],
                "catch_grace_seconds": self.cfg["catch_grace_seconds"],
                "poll_seconds": self.poll_interval(now),
            },
            "routes": self._route_summaries(),
            "arrivals": arrivals if arrivals is not None else base.get("arrivals", []),
            "inflight": inflight if inflight is not None else base.get("inflight", []),
            "vehicles": vehicles if vehicles is not None else base.get("vehicles", []),
            "alerts": self.alerts,
            "geometry_version": self.geometry["version"],
            "api_calls_today": self.client.calls_today,
        }


# ----------------------------------------------------------------------
# Terminal output
# ----------------------------------------------------------------------

def pick_next(arrivals, now, grace):
    """The first bus you can still make (canceled/no-pickup trips don't count)."""
    for a in arrivals:
        if not a["canceled"] and not a["expressed"] and a["leave_by"] >= now - grace:
            return a
    return None


def clock(epoch):
    return epoch_to_chicago(epoch).strftime("%I:%M %p").lstrip("0") if epoch else "--"


def minutes(seconds):
    m = math.floor(seconds / 60)
    return "now" if -1 < m < 1 else f"{m} min"


def render_text(state):
    now = state["generated_at"]
    lines = [f"CTA COMMUTE  {state['home']['label']} -> {state['work']['label']}   "
             f"{clock(now)}{'   [DEMO]' if state['demo'] else ''}"]
    if state["error"]:
        lines.append(f"!! {state['error']}" + ("  (showing last good data)" if state["stale"] else ""))
    for r in state["routes"]:
        if r["found"]:
            lines.append(f"   {r['rt']:>4} {r['rtdir']:<11} board {r['home_stop']['name']} "
                         f"({r['walk_to_stop_min']:.0f} min walk) -> off at {r['work_stop']['name']} "
                         f"({r['walk_from_stop_min']:.0f} min walk)")
        else:
            lines.append(f"   {r['rt']:>4} (no usable stops found)")
    arrivals = state["arrivals"]
    best = pick_next(arrivals, now, state["settings"]["catch_grace_seconds"])
    if best:
        leave = best["leave_by"] - now
        verdict = "GO NOW" if leave <= 0 else f"leave in {minutes(leave)} (by {clock(best['leave_by'])})"
        lines += [
            "",
            f">> NEXT: #{best['rt']} to {best['des']} reaches {best['stop_name']} in "
            f"{minutes(best['arrive_stop'] - now)} ({clock(best['arrive_stop'])}) - {verdict}",
            f"   At {best['work_stop_name']} {clock(best['arrive_work_stop'])}, at your desk "
            f"{clock(best['at_desk'])} ({best['door_to_door_min']:.0f} min door to door"
            f"{', estimated' if best['work_eta_source'] == 'estimate' else ''})",
        ]
    elif not state["error"]:
        lines += ["", ">> No catchable buses predicted right now."]
    if arrivals:
        lines += ["", f"   {'RT':>4}  {'TO':<18}{'AT STOP':>9}{'LEAVE BY':>10}{'AT DESK':>10}  WHERE"]
        for a in arrivals[:8]:
            flag = " CANCELED" if a["canceled"] else " NO PICKUP" if a["expressed"] else \
                   " DELAYED" if a["delayed"] else ""
            v = a.get("vehicle") or {}
            if v.get("on_trip") and v.get("stops_away") is not None:
                n = v["stops_away"]
                where = f"near {v['near']}, " + ("at your stop" if n == 0 else "your stop is next" if n == 1
                                                 else f"{n} stops away")
            elif v.get("near"):
                where = f"finishing trip, near {v['near']}"
            else:
                where = "position unknown"
            missed = a["leave_by"] < now - state["settings"]["catch_grace_seconds"]
            lines.append(f"   {a['rt']:>4}  {a['des'][:17]:<18}{minutes(a['arrive_stop'] - now):>9}"
                         f"{('missed' if missed else clock(a['leave_by'])):>10}{clock(a['at_desk']):>10}"
                         f"  {where}{flag}")
    for alert in state["alerts"][:3]:
        lines.append(f"   ALERT: {alert['headline']} - {alert['text'][:110]}")
    lines.append(f"   ({state['api_calls_today']} API calls today)")
    return "\n".join(lines)


def build(demo=False, config_path=CONFIG_PATH):
    cfg = load_config(config_path)
    if demo:
        from demo import DemoFeed
        if not cfg["routes"]:
            cfg["routes"] = list(DemoFeed.ROUTES)
        return Tracker(cfg, CTAClient("demo", fetch=DemoFeed(cfg["routes"]).fetch), demo=True)
    return Tracker(cfg, CTAClient(cfg["api_key"]))


def main(argv=None):
    parser = argparse.ArgumentParser(description="CTA bus commute tracker")
    parser.add_argument("--watch", action="store_true", help="keep refreshing")
    parser.add_argument("--stops", action="store_true", help="show the stops picked for each route")
    parser.add_argument("--json", action="store_true", help="print the raw state as JSON")
    parser.add_argument("--demo", action="store_true", help="use simulated buses instead of the API")
    parser.add_argument("--config", default=str(CONFIG_PATH))
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    tracker = build(args.demo, args.config)
    if args.stops:
        state = tracker.poll()
        if state["error"]:
            print("!!", state["error"])
        for plan in sorted(tracker.plans.values(), key=lambda p: (p.pattern.rt, p.pattern.pid)):
            print(f"#{plan.pattern.rt:<4} pattern {plan.pattern.pid:<6} {plan.pattern.rtdir:<11}"
                  f"{' (detour)' if plan.pattern.detour else ''}\n"
                  f"      board  {plan.home['name']} [stop {plan.home['stpid']}] {plan.walk_to_m:.0f} m from home\n"
                  f"      exit   {plan.work['name']} [stop {plan.work['stpid']}] {plan.walk_from_m:.0f} m from work\n"
                  f"      ride   {plan.ride_ft / 5280:.1f} mi")
        return
    while True:
        state = tracker.poll()
        if args.json:
            print(json.dumps(state, indent=2, default=str))
        else:
            if args.watch:
                print("\033[2J\033[H", end="")
            print(render_text(state))
        if not args.watch:
            return
        time.sleep(tracker.poll_interval())


if __name__ == "__main__":
    main()
