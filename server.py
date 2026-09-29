"""
Serves the display and keeps polling CTA in the background.

    python server.py              then open http://localhost:8095
    python server.py --demo       simulated buses, no API key needed
    python server.py --open       also open the display in the default browser

The API key stays on this machine; the browser only ever talks to this server.
"""

import argparse
import json
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import settings
from tracker import CONFIG_PATH, build, placeholder_state

WEB_DIR = Path(__file__).resolve().parent / "web"
MAX_BODY = 16 * 1024


class Poller(threading.Thread):
    """Polls CTA on the tracker's schedule and keeps the latest state for the page."""

    def __init__(self, tracker):
        super().__init__(daemon=True)
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self.tracker = tracker
        self._state = placeholder_state(tracker, starting_message(tracker))

    def run(self):
        while True:
            tracker = self.tracker
            try:
                state = tracker.poll()
            except Exception as exc:  # keep the display alive no matter what
                traceback.print_exc()
                state = tracker._state(time.time(), error=f"Tracker crashed: {exc}")
            with self._lock:
                current = tracker is self.tracker   # settings may have changed mid-poll
                if current:
                    self._state = state
            if current and state.get("error"):
                print(time.strftime("%H:%M:%S"), "!!", state["error"], flush=True)
            self._wake.wait(tracker.poll_interval() if current else 0)
            self._wake.clear()

    def replace(self, tracker):
        """Swap in a tracker built from new settings and poll it right away."""
        with self._lock:
            self.tracker = tracker
            self._state = placeholder_state(tracker, starting_message(tracker))
        self._wake.set()

    def snapshot(self):
        with self._lock:
            return {**self._state, "served_at": time.time()}


def starting_message(tracker):
    if tracker.auto:
        return "Finding the buses that connect home and work. This takes a few seconds."
    return "Loading your buses…"


def make_handler(poller, demo, config_path):
    folder = Path(config_path).resolve().parent

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(WEB_DIR), **kwargs)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/state":
                return self._json(poller.snapshot())
            if path == "/api/geometry":
                return self._json(poller.tracker.geometry)
            if path == "/api/settings":
                return self._json(settings.describe(poller.tracker))
            return super().do_GET()

        def do_POST(self):
            if self.path.split("?", 1)[0] != "/api/settings":
                return self._json({"error": "Not found"}, 404)
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= MAX_BODY:
                return self._json({"error": "Request too large"}, 413)
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                settings.save(payload, poller.tracker.cfg, folder)
            except settings.SettingsError as exc:
                return self._json({"error": str(exc)}, 400)
            except (ValueError, AttributeError):
                return self._json({"error": "Couldn't read the form."}, 400)
            tracker = build(demo, config_path)
            poller.replace(tracker)
            return self._json({"ok": True, **settings.describe(tracker)})

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _json(self, payload, status=200):
            body = json.dumps(payload, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass  # the display polls every few seconds; keep the console readable

    return Handler


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description="CTA commute display server")
    parser.add_argument("--demo", action="store_true", help="simulated buses, no API key needed")
    parser.add_argument("--open", action="store_true", help="open the display in a browser")
    parser.add_argument("--port", type=int)
    parser.add_argument("--host")
    parser.add_argument("--config", default=str(CONFIG_PATH))
    args = parser.parse_args(argv)

    tracker = build(args.demo, args.config)
    host = args.host or tracker.cfg["host"]
    port = args.port or tracker.cfg["port"]
    poller = Poller(tracker)
    poller.start()

    try:
        server = ThreadingHTTPServer((host, port), make_handler(poller, args.demo, args.config))
    except OSError as exc:
        sys.exit(f"Can't listen on {host}:{port} ({exc}). Is the display already running? "
                 f"Change \"port\" in config.json to use another port.")

    url = f"http://localhost:{port}/"
    print(f"CTA commute display running{' in DEMO mode' if args.demo else ''}")
    print(f"  this computer:  {url}")
    lan = lan_address()
    if lan and host in ("0.0.0.0", ""):
        print(f"  other screens:  http://{lan}:{port}/")
    print("  Ctrl+C to stop", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
