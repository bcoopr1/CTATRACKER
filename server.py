"""
Serves the living-room display and keeps polling CTA in the background.

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

from tracker import CONFIG_PATH, build

WEB_DIR = Path(__file__).resolve().parent / "web"


class Poller(threading.Thread):
    """Polls CTA on the tracker's schedule and keeps the latest state for the web page."""

    def __init__(self, tracker):
        super().__init__(daemon=True)
        self.tracker = tracker
        self._lock = threading.Lock()
        self._state = None

    def run(self):
        while True:
            try:
                state = self.tracker.poll()
            except Exception as exc:  # keep the display alive no matter what
                traceback.print_exc()
                state = self.tracker._state(time.time(), error=f"Tracker crashed: {exc}")
            with self._lock:
                self._state = state
            if state.get("error"):
                print(time.strftime("%H:%M:%S"), "!!", state["error"], flush=True)
            time.sleep(self.tracker.poll_interval())

    def snapshot(self):
        with self._lock:
            state = self._state
        if state is None:
            return {"booting": True, "served_at": time.time()}
        return {**state, "served_at": time.time()}


def make_handler(poller):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(WEB_DIR), **kwargs)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/state":
                return self._json(poller.snapshot())
            if path == "/api/geometry":
                return self._json(poller.tracker.geometry)
            return super().do_GET()

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _json(self, payload):
            body = json.dumps(payload, default=str).encode("utf-8")
            self.send_response(200)
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
        server = ThreadingHTTPServer((host, port), make_handler(poller))
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
