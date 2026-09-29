"""
Simulated CTA Bus Tracker feed for trying the display without an API key.

It answers the same calls as the real API with documents in the same JSON shape
(see cta.py), with buses moving in real time along roughly realistic Lake Shore
Drive / Michigan Avenue paths. Stop names and ids are made up.
"""

import hashlib
import math
import time

from cta import format_cta_time

FT_PER_M = 3.28084

# (name, lat, lon, is_stop). Southbound order. Waypoints (is_stop False) shape the path.
EXPRESS_PATH = [
    ("Marine Drive & Foster", 41.9763, -87.6503, True),
    ("Marine Drive & Lawrence", 41.9690, -87.6481, True),
    ("Marine Drive & Montrose", 41.9617, -87.6462, True),
    ("Marine Drive & Irving Park", 41.9543, -87.6449, True),
    ("Inner Lake Shore & Grace", 41.9507, -87.6443, True),
    ("Inner Lake Shore & Addison", 41.9471, -87.6433, True),
    ("Inner Lake Shore & Belmont", 41.9397, -87.6401, True),
    ("Inner Lake Shore & Diversey", 41.9325, -87.6368, True),
    ("", 41.9290, -87.6340, False),
    ("", 41.9253, -87.6311, False),
    ("", 41.9180, -87.6282, False),
    ("", 41.9107, -87.6258, False),
    ("", 41.9036, -87.6238, False),
    ("Michigan & Delaware", 41.8990, -87.6243, True),
    ("Michigan & Chicago", 41.8966, -87.6243, True),
    ("Michigan & Ontario", 41.8932, -87.6243, True),
    ("Michigan & Illinois", 41.8907, -87.6244, True),
    ("Michigan & Wacker", 41.8880, -87.6245, True),
    ("Michigan & Lake", 41.8858, -87.6246, True),
    ("Michigan & Randolph", 41.8847, -87.6246, True),
    ("Michigan & Washington", 41.8834, -87.6246, True),
    ("Michigan & Madison", 41.8820, -87.6246, True),
]

LOCAL_PATH = [
    ("Sheridan & Lawrence", 41.9690, -87.6545, True),
    ("Sheridan & Montrose", 41.9617, -87.6547, True),
    ("Sheridan & Irving Park", 41.9543, -87.6509, True),
    ("Sheridan & Grace", 41.9507, -87.6490, True),
    ("", 41.9489, -87.6462, False),
    ("Inner Lake Shore & Addison", 41.9471, -87.6433, True),
    ("Inner Lake Shore & Cornelia", 41.9456, -87.6427, True),
    ("Inner Lake Shore & Roscoe", 41.9434, -87.6418, True),
    ("Inner Lake Shore & Belmont", 41.9397, -87.6401, True),
    ("Inner Lake Shore & Wellington", 41.9361, -87.6386, True),
    ("Inner Lake Shore & Diversey", 41.9325, -87.6368, True),
    ("", 41.9253, -87.6311, False),
    ("", 41.9107, -87.6258, False),
    ("", 41.9036, -87.6238, False),
    ("Michigan & Delaware", 41.8990, -87.6243, True),
    ("Michigan & Chicago", 41.8966, -87.6243, True),
    ("Michigan & Huron", 41.8946, -87.6243, True),
    ("Michigan & Ontario", 41.8932, -87.6243, True),
    ("Michigan & Grand", 41.8918, -87.6244, True),
    ("Michigan & Illinois", 41.8907, -87.6244, True),
    ("Michigan & Wacker", 41.8880, -87.6245, True),
    ("Michigan & Lake", 41.8858, -87.6246, True),
    ("Michigan & Randolph", 41.8847, -87.6246, True),
    ("Michigan & Washington", 41.8834, -87.6246, True),
    ("Michigan & Madison", 41.8820, -87.6246, True),
    ("Michigan & Adams", 41.8793, -87.6246, True),
]

NAMES = {
    "146": "Inner Lake Shore/Michigan Express",
    "148": "Clarendon/Michigan Express",
    "151": "Sheridan",
    "135": "Clarendon/LaSalle Express",
    "136": "Sheridan/LaSalle Express",
}


def _dist_ft(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h)) * FT_PER_M


def _stop_id(name, direction):
    base = int(hashlib.md5(name.encode()).hexdigest()[:6], 16) % 9000 + 1000
    return str(base if direction == "Southbound" else base + 10000)


class _SimPattern:
    def __init__(self, pid, rt, rtdir, path):
        self.pid, self.rt, self.rtdir = pid, rt, rtdir
        east = 0.0 if rtdir == "Southbound" else 0.00025   # other side of the street
        self.points, dist, prev = [], 0.0, None
        for name, lat, lon, is_stop in path:
            here = (lat, lon + east)
            if prev:
                dist += _dist_ft(prev, here)
            self.points.append({"name": name, "lat": here[0], "lon": here[1], "stop": is_stop,
                                "pdist": dist, "stpid": _stop_id(name, rtdir) if is_stop else None})
            prev = here
        self.length = dist
        self.stops = [p for p in self.points if p["stop"]]

    def ptr(self):
        pts = []
        for seq, p in enumerate(self.points, 1):
            pt = {"seq": seq, "lat": p["lat"], "lon": p["lon"], "typ": "S" if p["stop"] else "W", "pdist": 0.0}
            if p["stop"]:
                pt.update(stpid=p["stpid"], stpnm=p["name"], pdist=round(p["pdist"], 1))
            pts.append(pt)
        return {"pid": int(self.pid), "ln": round(self.length, 1), "rtdir": self.rtdir, "pt": pts}

    def locate(self, pdist):
        """lat, lon, heading at a distance along the pattern."""
        pts = self.points
        for a, b in zip(pts, pts[1:]):
            if b["pdist"] >= pdist:
                span = (b["pdist"] - a["pdist"]) or 1
                f = max(0.0, min(1.0, (pdist - a["pdist"]) / span))
                lat = a["lat"] + (b["lat"] - a["lat"]) * f
                lon = a["lon"] + (b["lon"] - a["lon"]) * f
                hdg = math.degrees(math.atan2((b["lon"] - a["lon"]) * math.cos(math.radians(lat)),
                                              b["lat"] - a["lat"])) % 360
                return lat, lon, round(hdg)
        last = pts[-1]
        return last["lat"], last["lon"], 180


class DemoFeed:
    ROUTES = ("146", "151")

    def __init__(self, routes):
        self.routes = []
        for i, rt in enumerate(routes):
            express = rt in ("146", "148", "135", "136") or (rt not in ("151",) and i % 2 == 0)
            path = EXPRESS_PATH if express else LOCAL_PATH
            base = 5000 + 100 * i
            sb = _SimPattern(str(base + 1), rt, "Southbound", path)
            nb = _SimPattern(str(base + 2), rt, "Northbound", list(reversed(path)))
            mph = 13.0 if express else 9.0
            headway = (9 if express else 7) * 60
            self.routes.append({"rt": rt, "sb": sb, "nb": nb, "ft_s": mph * 5280 / 3600,
                                "headway": headway, "vid_base": 1000 + 300 * i})
        self.by_pid = {r[d].pid: r[d] for r in self.routes for d in ("sb", "nb")}

    # -- simulation ----------------------------------------------------

    def _buses(self, now):
        """Every bus currently on a trip, plus ones laying over before departure."""
        buses = []
        for r in self.routes:
            for direction, offset in (("sb", 0), ("nb", 0.37)):
                pattern = r[direction]
                trip_s = pattern.length / r["ft_s"]
                h = r["headway"]
                first = math.ceil((now - trip_s) / h - offset)
                last = math.floor(now / h - offset) + 2      # +2: two buses waiting at the terminal
                for k in range(first, last + 1):
                    depart = (k + offset) * h
                    pdist = max(0.0, (now - depart) * r["ft_s"])
                    if pdist > pattern.length:
                        continue
                    buses.append({
                        "vid": str(r["vid_base"] + (k % 97) + (0 if direction == "sb" else 150)),
                        "rt": r["rt"], "pattern": pattern, "pdist": pdist, "depart": depart,
                        "ft_s": r["ft_s"], "k": k,
                    })
        return buses

    @staticmethod
    def _time(epoch, params):
        if params.get("unixTime") == "true":
            return int(epoch * 1000)
        return format_cta_time(epoch, seconds=params.get("tmres") == "s")

    def _predictions(self, bus, now, params, only_stops=None):
        out = []
        k = bus["k"]
        for stop in bus["pattern"].stops:
            if stop["pdist"] < bus["pdist"] or (only_stops and stop["stpid"] not in only_stops):
                continue
            eta = max(now, bus["depart"]) + (stop["pdist"] - bus["pdist"]) / bus["ft_s"]
            if eta - now > 45 * 60:
                continue
            mins = int((eta - now) // 60)
            out.append({
                "tmstmp": self._time(now, params), "typ": "A", "stpnm": stop["name"], "stpid": stop["stpid"],
                "vid": bus["vid"], "dstp": int(stop["pdist"] - bus["pdist"]), "rt": bus["rt"], "rtdd": bus["rt"],
                "rtdir": bus["pattern"].rtdir, "des": bus["pattern"].stops[-1]["name"].split("&")[-1].strip(),
                "prdtm": self._time(eta, params), "dly": k % 7 == 3, "dyn": 1 if k % 13 == 5 else 0,
                "tablockid": f"{bus['rt']} -{k % 900}", "tatripid": str(100000 + k), "origtatripno": str(k),
                "prdctdn": "DUE" if mins <= 1 else str(mins), "zone": "",
                "psgld": ("EMPTY", "HALF_EMPTY", "FULL")[k % 3], "flagstop": 0, "_eta": eta,
            })
        return out

    # -- the fake HTTP endpoint -------------------------------------------

    def fetch(self, method, params):
        now = time.time()
        body = {}
        if method == "getroutes":
            body["routes"] = [{"rt": r["rt"], "rtnm": NAMES.get(r["rt"], f"Route {r['rt']}"),
                               "rtclr": "#565a5c", "rtdd": r["rt"]} for r in self.routes]
        elif method == "getpatterns":
            if "rt" in params:
                body["ptr"] = [r[d].ptr() for r in self.routes if r["rt"] == params["rt"] for d in ("sb", "nb")]
            else:
                body["ptr"] = [self.by_pid[p].ptr() for p in params["pid"].split(",") if p in self.by_pid]
        elif method == "getvehicles":
            wanted = set(params["rt"].split(","))
            body["vehicle"] = []
            for b in self._buses(now):
                if b["rt"] not in wanted:
                    continue
                lat, lon, hdg = b["pattern"].locate(b["pdist"])
                body["vehicle"].append({
                    "vid": b["vid"], "tmstmp": self._time(now - 12, params), "lat": str(lat), "lon": str(lon),
                    "hdg": str(hdg), "pid": int(b["pattern"].pid), "rt": b["rt"],
                    "des": b["pattern"].stops[-1]["name"].split("&")[-1].strip(),
                    "pdist": int(b["pdist"]), "dly": b["k"] % 7 == 3, "spd": 0 if b["pdist"] == 0 else 24,
                    "tatripid": str(100000 + b["k"]), "tablockid": "", "origtatripno": "", "zone": "",
                    "mode": 1, "psgld": ("EMPTY", "HALF_EMPTY", "FULL")[b["k"] % 3],
                })
        elif method == "getpredictions":
            prds = []
            if "stpid" in params:
                stops = set(params["stpid"].split(","))
                routes = set(params["rt"].split(",")) if params.get("rt") else None
                for b in self._buses(now):
                    if routes is None or b["rt"] in routes:
                        prds += self._predictions(b, now, params, only_stops=stops)
            else:
                vids = set(params["vid"].split(","))
                for b in self._buses(now):
                    if b["vid"] in vids:
                        prds += self._predictions(b, now, params)
            prds.sort(key=lambda p: p.pop("_eta"))
            if prds:
                body["prd"] = prds
            else:
                body["error"] = [{"msg": "No arrival times"}]
        else:
            body["error"] = [{"msg": "Unsupported function"}]
        return {"bustime-response": body}
