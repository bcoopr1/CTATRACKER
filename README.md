# Commute

A full-screen CTA bus tracker meant for a TV or spare monitor. Enter your home and work
addresses and it works out which buses connect them, counts down to the next one at your stop,
tells you when to leave, and estimates when you'll be at work. A live street map shows where
every bus on your routes is.

Built on the [CTA Bus Tracker API](https://www.transitchicago.com/developers/bustracker/) (v3).
Python standard library only; no packages to install.

## Requirements

- Windows with Python 3.9 or newer (Microsoft Store or python.org)
- A CTA Bus Tracker API key (free, from ctabustracker.com under My Account → Developer API)
- Microsoft Edge for the full-screen launcher (any modern browser works for viewing)

## Setup

1. Double-click `start_display.bat`. On first run the display asks for setup.
2. Click **Open Settings** (or **Settings** in the bottom bar) and enter:
   - **Home and work addresses.** A street address or a building name ("Willis Tower")
     both work. Addresses are looked up with the US Census geocoder, falling back to
     OpenStreetMap.
   - **Your CTA API key.**
   - **Preferred buses (optional).** Leave this blank and the tracker scans every CTA route
     and keeps the ones that connect your two addresses, up to five, within 12 minutes of the
     fastest. The scan takes a few seconds and is repeated twice a day. Enter route numbers
     instead if you only want specific buses.
3. Save. The display switches over as soon as the first lookup finishes.

Settings can also be changed from a phone on the same network at
`http://<pc-address>:8095/#settings`.

Addresses, preferred buses and timing are saved to `settings.local.json`; the key is saved to
`.env`. Both are git-ignored. The key can also be supplied as a `CTA_API_KEY` environment
variable.

For each route, the tracker uses the stop closest to home and the stop closest to work along
that route. To check what it picked:

```
python tracker.py --stops
```

## Running

Double-click `start_display.bat`. It starts the local server (minimized) and opens Edge in
full-screen kiosk mode. Press Alt+F4 to exit the display; close the server window to stop
tracking.

The display is served at `http://localhost:8095`. Other devices on the same network can use
the LAN address printed in the server window. To start on login, place a shortcut to
`start_display.bat` in `shell:startup`.

To preview without an API key: `start_display.bat --demo` (simulated buses).

From a terminal:

```
python tracker.py            # single snapshot
python tracker.py --watch    # continuous
python tracker.py --stops    # stops chosen for each route
python server.py [--demo]    # server only
```

## The display

| Panel | Contents |
| --- | --- |
| Next bus | Countdown to the next catchable bus at your stop, and a countdown to when you need to leave. The status moves from "Plenty of time" to "Get ready" (5 min) to "Leave now" (1 min). |
| Arrival | Estimated time at your desk, door-to-door duration, and the walk/ride breakdown. |
| Along the route | Buses plotted by distance from your stop, both inbound and downtown. |
| Upcoming buses | Next several departures with leave-by time, arrival time, and each bus's position. |
| Map | Street map with your routes, stops, and live bus positions. Labeled buses are headed to your stop; grey ones are running the opposite direction. |

CTA service alerts for your routes scroll along the bottom bar.

### How times are calculated

- **At your stop:** CTA's arrival prediction for your stop.
- **Leave by:** arrival at stop − walking time − `minutes_to_get_out_the_door`.
- **Off the bus:** CTA's prediction for the same vehicle at your work stop. When CTA hasn't
  published a prediction that far out, it's extrapolated from the bus's current pace and
  marked "est."
- **At desk:** off the bus + walking time + `minutes_from_stop_to_desk`.

Walking time is straight-line distance × `walk_detour_factor` at `walk_speed_mph`.

## Configuration

Addresses, preferred buses, the two timing buffers and the API key are edited in Settings on
the display. Everything else is in `config.json`; restart the display after changing it.

| Setting | Description |
| --- | --- |
| `walk_speed_mph`, `walk_detour_factor` | Walking time model. |
| `catch_grace_seconds` | How far past the leave-by time a bus still counts as catchable (shown as "Hurry"). |
| `max_walk_to_stop_m` | Farthest a stop can be from home or work (meters). |
| `stop_overrides` | Pin specific stops per route, e.g. `{"22": {"home": "1234", "work": "5678"}}`. |
| `poll_seconds`, `idle_poll_seconds`, `active_hours` | Refresh rate inside and outside active hours. Outside active hours the display dims slightly. |
| `host`, `port` | Server address. Use `127.0.0.1` to keep it local to this machine. |

Each refresh makes about three API calls. At the default 30-second interval that's roughly
7,000 calls a day, well under CTA's 100,000/day limit. If the limit is reached, the tracker
backs off to one attempt every 15 minutes.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Launcher window closes immediately | Python isn't installed or isn't on `PATH`. |
| "Setup" message on screen | An address or the API key is missing. Open Settings. |
| Address not found | Try the street address rather than a building name, or add ", Chicago, IL". |
| "Server offline" | The server window was closed. Run `start_display.bat` again. |
| Display is slightly dimmed | Outside `active_hours`. |
| Map is blank | No internet connection (map tiles load from OpenStreetMap). |

## Project layout

```
cta.py              CTA Bus Tracker v3 client and Chicago time handling
tracker.py          Route and stop selection, timing, and the terminal interface
geocode.py          Address lookup (US Census geocoder, then OpenStreetMap)
settings.py         Saves what's entered on the Settings screen
server.py           Local web server; polls CTA in the background
demo.py             Simulated feed in the same format as the real API
start_display.bat   Launches the server and a full-screen browser
web/                Display (HTML/CSS/JS); Leaflet is vendored in web/vendor
```

The API key is only used server-side and is never sent to the browser.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Maps rendered with [Leaflet](https://leafletjs.com/) (BSD-2-Clause).
