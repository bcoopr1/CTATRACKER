'use strict';
/* Commute — living-room display for the CTA bus tracker.
   Polls /api/state from server.py and redraws; countdowns tick locally every second. */

const REFRESH_MS = 5000;
const TZ = 'America/Chicago';
const THEMES = ['terminal', 'studio', 'mono'];
const THEME_FROM_URL = new URLSearchParams(location.search).get('theme');

// Drawing colors come from the active theme's CSS variables (style.css, themes.css).
let ROUTE_COLORS = [], INK = '', DIM = '', AMBER = '', SCREEN = '';
function loadPalette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  ROUTE_COLORS = [1, 2, 3, 4, 5, 6].map((i) => v(`--c-route-${i}`));
  [INK, DIM, AMBER, SCREEN] = ['--c-ink', '--c-dim', '--c-accent', '--c-bg'].map(v);
}
loadPalette();
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';   // no key needed; attribution required
const LOAD_LABEL = { EMPTY: 'Seats open', HALF_EMPTY: 'Some seats', FULL: 'Crowded' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: TZ });

let state = null;
let geometry = { version: null, routes: [] };
let skew = 0;                 // server clock minus browser clock, seconds
let uplink = 'boot';          // boot | ok | down
let dialogSig = '';
let dismissedSig = null;
const bootStarted = Date.now();

const now = () => Date.now() / 1000 + skew;
const clock = (epoch) => (epoch ? timeFmt.format(new Date(epoch * 1000)) : '--');

function clockParts(epoch) {
  const parts = timeFmt.formatToParts(new Date(epoch * 1000));
  return [
    parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim(),
    (parts.find((p) => p.type === 'dayPeriod') || {}).value || '',
  ];
}

function mmss(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

function minsLabel(sec) {
  return sec < 60 ? 'Due' : `${Math.floor(sec / 60)} min`;
}

function routeColor(rt) {
  const i = (state?.routes || []).findIndex((r) => r.rt === rt);
  return ROUTE_COLORS[Math.max(0, i) % ROUTE_COLORS.length];
}

function catchable(a, t) {
  return !a.canceled && !a.expressed && a.leave_by >= t - state.settings.catch_grace_seconds;
}

function pickHero(t) {
  return (state?.arrivals || []).find((a) => catchable(a, t)) || null;
}

function whereText(a) {
  const v = a.vehicle;
  if (!v) return 'No GPS fix yet';
  if (v.on_trip) {
    const n = v.stops_away;
    const away = n === 0 ? 'at your stop' : n === 1 ? 'your stop is next' : `${n} stops away`;
    return v.near ? `Near ${v.near} · ${away}` : away;
  }
  if (v.near) return `Finishing ${(v.rtdir || 'its').toLowerCase()} trip · near ${v.near}`;
  return 'Position unknown';
}

function distText(a) {
  const v = a.vehicle;
  if (v && v.on_trip && v.miles_away != null) return `${v.miles_away.toFixed(1)} mi out`;
  if (a.dstp_ft) return `${(a.dstp_ft / 5280).toFixed(1)} mi by route`;
  return '';
}

/* ------------------------------------------------------------------ data */

async function refresh() {
  try {
    const res = await fetch('api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    skew = next.served_at - Date.now() / 1000;
    uplink = 'ok';
    if (!next.booting) {
      if (next.geometry_version && next.geometry_version !== geometry.version) {
        const g = await fetch('api/geometry', { cache: 'no-store' });
        if (g.ok) geometry = await g.json();
      }
      state = next;
      onState();
    }
  } catch (err) {
    uplink = 'down';
    renderDialog();
  }
  renderTray(now());
}

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'terminal';
  const root = document.documentElement;
  if (root.dataset.theme === name) return;
  root.dataset.theme = name;
  try { localStorage.setItem('commute-theme', name); } catch (err) { /* storage blocked */ }
  loadPalette();
  map.drawn = '';                  // redraw the route lines in the new colors
  if (state) { renderMap(); tick(); }
}

function onState() {
  if (!THEME_FROM_URL && $('#settings-layer').hidden) applyTheme(state.settings.theme);
  document.body.classList.toggle('idle', !state.active);
  renderMap();
  renderTicker();
  renderDialog();
  tick();
  const boot = $('#boot');
  if (boot && boot.isConnected && !boot.classList.contains('done')) {
    setTimeout(() => boot.classList.add('done'), Math.max(0, 1600 - (Date.now() - bootStarted)));
  }
}

function tick() {
  const t = now();
  const hero = state ? pickHero(t) : null;
  renderHero(hero, t);
  renderDest(hero, t);
  renderTrajectory(hero, t);
  renderList(hero, t);
  renderTray(t);
}

/* ------------------------------------------------------------------ next bus */

function emptyReason(t) {
  if (!state) return ['Loading…', 'Waiting for the first update from CTA.'];
  if (state.status_message) return ['Setting up', state.status_message];
  if (state.setup_needed) return ['Setup needed', state.error];
  if (state.error && !state.stale) return ['Can’t reach CTA', state.error];
  const routes = state.routes.map((r) => '#' + r.rt).join(', ');
  if (!state.active) return ['Quiet hours', `Outside your active hours, so ${routes} is checked every few minutes.`];
  if ((state.arrivals || []).length) return ['Nothing you can catch', 'The buses CTA knows about are too close to make. More will show up soon.'];
  return ['No buses predicted', `CTA has no predictions for ${routes} at your stop. Service may not be running right now.`];
}

function renderHero(hero, t) {
  const el = $('#hero');
  el.classList.toggle('empty', !hero);
  $('#hero-tflag').textContent = state?.stale ? 'Offline' : state?.demo ? 'Demo' : '';

  if (!hero) {
    const [title, sub] = emptyReason(t);
    $('#empty-title').textContent = title;
    $('#empty-sub').textContent = sub;
    for (const id of ['#st-bus', '#st-dist', '#st-load']) $(id).textContent = '';
    $('#st-where').textContent = state?.updated_at ? `Last update ${clock(state.updated_at)}` : 'Standing by';
    return;
  }

  const badge = $('#hero-rt');
  badge.textContent = hero.rt;
  badge.style.setProperty('--rc', routeColor(hero.rt));
  $('#hero-name').textContent = hero.route_name || `Route ${hero.rt}`;
  $('#hero-dir').textContent = `${hero.rtdir || ''} to ${hero.des || '?'}`.trim();

  const flags = [];
  if (hero.delayed) flags.push(['DELAYED', 'warn']);
  if (hero.load === 'FULL') flags.push(['CROWDED', 'warn']);
  if (hero.load === 'EMPTY') flags.push(['SEATS', 'ok']);
  $('#hero-flags').innerHTML = flags.map(([txt, cls]) => `<span class="flag ${cls}">${txt}</span>`).join('');

  const toStop = hero.arrive_stop - t;
  $('#hero-count').textContent = toStop <= 0 ? 'DUE' : mmss(toStop);
  $('#hero-stop').textContent = `${clock(hero.arrive_stop)} · ${hero.stop_name}`;

  const leaveIn = hero.leave_by - t;
  let mode, title, sub;
  if (leaveIn > 300) {
    [mode, title, sub] = ['standby', 'Plenty of time', `by ${clock(hero.leave_by)}`];
  } else if (leaveIn > 60) {
    [mode, title, sub] = ['prepare', 'Get ready', `by ${clock(hero.leave_by)}`];
  } else if (leaveIn > 0) {
    [mode, title, sub] = ['go', 'Leave now', hero.walk_to_stop_min < 1 ? 'it’s right outside' : `${Math.round(hero.walk_to_stop_min)} min walk to the stop`];
  } else {
    [mode, title, sub] = ['run', 'Hurry', `bus in ${mmss(toStop)}`];
  }
  const beacon = $('#hero-beacon');
  for (const m of ['standby', 'prepare', 'go', 'run']) beacon.classList.toggle(m, m === mode);
  $('#beacon-title').textContent = title;
  $('#beacon-count').textContent = mmss(leaveIn);
  $('#beacon-sub').textContent = sub;
  $('#hero-bar').style.width = `${clamp(1 - leaveIn / 1200, 0, 1) * 100}%`;

  const alt = state.arrivals
    .filter((a) => a.key !== hero.key && catchable(a, t))
    .sort((a, b) => a.at_desk - b.at_desk)[0];
  const tip = $('#hero-tip');
  if (alt && alt.at_desk < hero.at_desk - 90) {
    tip.hidden = false;
    tip.textContent = `TIP: the #${alt.rt} at ${clock(alt.arrive_stop)} gets you to your desk ` +
      `${Math.round((hero.at_desk - alt.at_desk) / 60)} min sooner (${clock(alt.at_desk)}).`;
  } else {
    tip.hidden = true;
  }

  $('#st-bus').textContent = `Bus #${hero.vid}`;
  $('#st-where').textContent = whereText(hero);
  $('#st-dist').textContent = distText(hero);
  $('#st-load').textContent = LOAD_LABEL[hero.load] || '';
}

/* ------------------------------------------------------------------ arrival */

function renderDest(hero, t) {
  if (state) $('#dest-tsub').textContent = state.work.label;
  $('#dest-date').textContent = dateFmt.format(new Date(t * 1000));
  if (!hero) {
    $('#dest-time').textContent = '--:--';
    $('#dest-ampm').textContent = '';
    $('#dest-total').textContent = 'Waiting for a bus';
    for (const id of ['#dest-leave', '#dest-off']) $(id).textContent = '--';
    $('#dest-exit').textContent = '';
    $('#dest-src').textContent = '';
    return;
  }
  const [hm, ampm] = clockParts(hero.at_desk);
  $('#dest-time').textContent = hm;
  $('#dest-ampm').textContent = ampm;
  $('#dest-total').textContent = `${Math.round(hero.door_to_door_min)} MIN DOOR TO DOOR`;

  const out = state.settings.door_min + hero.walk_to_stop_min;
  const into = hero.walk_from_stop_min + state.settings.desk_min;
  for (const [id, minutes] of [['#leg-out', out], ['#leg-ride', hero.ride_min], ['#leg-in', into]]) {
    const leg = $(id);
    leg.style.flexGrow = Math.max(minutes, 0.5);
    leg.querySelector('span').textContent = `${Math.round(minutes)} min`;
  }
  $('#dest-leave').textContent = clock(hero.leave_by);
  $('#dest-off').textContent = `${clock(hero.arrive_work_stop)} · ${hero.work_stop_name}`;
  $('#dest-exit').textContent = `then ${Math.round(hero.walk_from_stop_min)} min on foot to ${state.work.label}`;
  $('#dest-src').textContent = hero.work_eta_source === 'cta'
    ? 'Arrival time from CTA live prediction'
    : 'Arrival time estimated from bus pace';
}

/* ------------------------------------------------------------------ along the route */

function busGlyph(x, y, size, color, extra = '') {
  const w = size * 2.3, h = size;
  return `<g transform="translate(${(x - w / 2).toFixed(1)},${(y - h * 1.2).toFixed(1)})" ${extra}>
    <rect width="${w}" height="${h}" rx="${h * 0.2}" fill="${color}"/>
    <rect x="${w * 0.07}" y="${h * 0.18}" width="${w * 0.6}" height="${h * 0.34}" fill="${SCREEN}"/>
    <rect x="${w * 0.74}" y="${h * 0.18}" width="${w * 0.19}" height="${h * 0.52}" fill="${SCREEN}"/>
    <circle cx="${w * 0.24}" cy="${h}" r="${h * 0.2}" fill="${SCREEN}" stroke="${color}" stroke-width="${h * 0.08}"/>
    <circle cx="${w * 0.72}" cy="${h}" r="${h * 0.2}" fill="${SCREEN}" stroke="${color}" stroke-width="${h * 0.08}"/>
  </g>`;
}

function renderTrajectory(hero, t) {
  const svg = $('#traj');
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H) return;
  // The Terminal pixel font runs small; Studio and Mono fonts need less size for the same look.
  const typeScale = document.documentElement.dataset.theme === 'terminal' ? 1 : 0.8;
  const fs = clamp(Math.min(H * 0.12, W * 0.016), 11, 34) * typeScale;
  const g = geometry.routes.find((r) => r.rt === hero?.rt) || geometry.routes[0];
  if (!state || !g) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="${DIM}" font-size="${fs * 1.4}" text-anchor="middle">Waiting for route data</text>`;
    return;
  }
  $('#track-tsub').textContent = `#${g.rt} ${g.rtdir.toLowerCase()} · ${(g.ride_ft / 5280).toFixed(1)} mi ride`;

  // Left half = distance still to go to your stop; stretch it to fit buses due in the next half hour.
  const soon = (state.arrivals || []).filter((a) => !a.canceled && a.arrive_stop > t && a.arrive_stop - t < 1800);
  const up = clamp(Math.max(g.upstream_ft, ...soon.map((a) => -a.track_ft)) * 1.05, 2640, 5 * 5280);
  const ride = Math.max(g.ride_ft, 1000);
  const xL = W * 0.03, xR = W * 0.965, xHome = W * 0.5;
  const X = (ft) => (ft <= 0
    ? xHome + (Math.max(ft, -up) / up) * (xHome - xL)
    : xHome + (Math.min(ft, ride) / ride) * (xR - xHome));
  const yLine = H * 0.6;
  const color = routeColor(g.rt);
  let s = '';

  // track: dashed on the way in, solid for your ride
  s += `<line x1="${xL}" y1="${yLine}" x2="${xHome}" y2="${yLine}" stroke="${color}" stroke-opacity=".45" stroke-width="${fs * 0.16}" stroke-dasharray="${fs * 0.5} ${fs * 0.35}"/>`;
  s += `<line x1="${xHome}" y1="${yLine}" x2="${xR}" y2="${yLine}" stroke="${color}" stroke-width="${fs * 0.28}"/>`;
  for (let m = 1; m * 5280 < up; m++) {
    const x = X(-m * 5280);
    s += `<line x1="${x}" y1="${yLine - fs * 0.35}" x2="${x}" y2="${yLine + fs * 0.35}" stroke="${DIM}"/>`;
    s += `<text x="${x}" y="${yLine + fs * 1.3}" fill="${DIM}" font-size="${fs}" text-anchor="middle">${m} MI</text>`;
  }
  for (const st of g.stops) {
    s += `<circle cx="${X(st.offset_ft).toFixed(1)}" cy="${yLine}" r="${fs * 0.17}" fill="${SCREEN}" stroke="${color}" stroke-width="${fs * 0.08}"/>`;
  }

  // your stop and your office
  s += `<line x1="${xHome}" y1="${yLine - fs * 0.9}" x2="${xHome}" y2="${yLine + fs * 0.9}" stroke="${INK}" stroke-width="${fs * 0.14}"/>`;
  s += `<text x="${xHome}" y="${yLine + fs * 1.5}" fill="${INK}" font-size="${fs * 1.05}" text-anchor="middle">▲ YOUR STOP</text>`;
  s += `<text x="${xHome}" y="${yLine + fs * 2.55}" fill="${INK}" font-size="${fs}" text-anchor="middle">${esc(g.home_stop.name)}</text>`;
  s += `<rect x="${xR - fs * 0.35}" y="${yLine - fs * 0.7}" width="${fs * 0.7}" height="${fs * 1.4}" fill="${AMBER}"/>`;
  s += `<text x="${xR}" y="${yLine + fs * 1.5}" fill="${AMBER}" font-size="${fs * 1.05}" text-anchor="end">${esc(state.work.label.toUpperCase())} ▲</text>`;
  s += `<text x="${xR}" y="${yLine + fs * 2.55}" fill="${INK}" font-size="${fs}" text-anchor="end">${esc(g.work_stop.name)}</text>`;

  // buses: positions glide toward your stop between server updates
  const items = [];
  const far = [];
  const seen = new Set();
  for (const a of state.arrivals || []) {
    if (a.canceled || a.arrive_stop < t - 20 || seen.has(a.vid)) continue;
    seen.add(a.vid);
    const span = a.arrive_stop - state.generated_at;
    const frac = span > 0 ? clamp((a.arrive_stop - t) / span, 0, 1) : 0;
    const ft = a.track_ft * frac;
    const secs = a.arrive_stop - t;
    const label = `#${a.rt} ${secs < 60 ? 'DUE' : Math.floor(secs / 60) + 'm'}`;
    if (-ft > up) far.push(label);
    else items.push({ x: X(ft), rt: a.rt, hero: hero && a.key === hero.key, dim: !catchable(a, t), label });
  }
  s += `<text x="${xL}" y="${yLine + fs * 2.55}" fill="${DIM}" font-size="${fs}">◀ ${
    far.length ? 'FARTHER: ' + esc(far.slice(0, 3).join(' · ')) : 'INBOUND'}</text>`;
  for (const b of state.inflight || []) {
    if (!seen.has(b.vid)) items.push({ x: X(b.track_ft), rt: b.rt, dim: true, label: `#${b.rt}`, small: true });
  }
  items.sort((a, b) => a.x - b.x);
  const lanes = [];
  const labelW = fs * 4.4;
  for (const it of items) {
    let lane = lanes.findIndex((lastX) => it.x - lastX > labelW);
    if (lane === -1) lane = lanes.length < 3 ? lanes.length : 2;
    lanes[lane] = it.x;
    const c = routeColor(it.rt);
    const size = it.small ? fs * 0.7 : it.hero ? fs * 1.15 : fs * 0.9;
    it.x = clamp(it.x, xL + size * 1.2, xR - size * 1.2);
    const ly = yLine - size * 1.6 - fs * 0.2 - lane * fs * 1.15;
    const op = it.dim ? ' opacity=".45"' : '';
    if (it.hero) {
      s += `<circle cx="${it.x}" cy="${yLine - size * 0.7}" r="${size}" fill="none" stroke="${c}" stroke-width="${fs * 0.1}">
        <animate attributeName="r" from="${size}" to="${size * 2.2}" dur="1s" repeatCount="indefinite"/>
        <animate attributeName="opacity" from=".9" to="0" dur="1s" repeatCount="indefinite"/></circle>`;
    }
    s += busGlyph(it.x, yLine, size, c, op);
    if (lane > 0) s += `<line x1="${it.x}" y1="${ly + fs * 0.2}" x2="${it.x}" y2="${yLine - size * 1.25}" stroke="${c}" stroke-opacity=".5"${op}/>`;
    s += `<text x="${it.x}" y="${ly}" fill="${c}" font-size="${fs * (it.hero ? 1.2 : 1)}" text-anchor="middle"${op}>${esc(it.label)}</text>`;
  }
  svg.innerHTML = s;
}

/* ------------------------------------------------------------------ upcoming list */

function renderList(hero, t) {
  const body = $('#list-body');
  if (!state) return;
  const rows = (state.arrivals || []).filter((a) => a.arrive_stop > t - 30).slice(0, 7);
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(emptyReason(t).join(' — '))}</td></tr>`;
  } else {
    body.innerHTML = rows.map((a) => {
      const missed = !a.canceled && !a.expressed && !catchable(a, t);
      const cls = hero && a.key === hero.key ? 'sel' : a.canceled ? 'canceled' : (missed || a.expressed) ? 'missed' : '';
      const tag = a.canceled ? 'CANCELED' : a.expressed ? 'NO PICKUP' : a.delayed ? 'DELAYED' : '';
      const gone = a.canceled || a.expressed;
      return `<tr class="${cls}">
        <td><span class="rt-badge" style="--rc:${routeColor(a.rt)}">${esc(a.rt)}</span></td>
        <td>${esc(a.des)}</td>
        <td>${minsLabel(a.arrive_stop - t)}<small>${esc(clock(a.arrive_stop))}</small></td>
        <td>${missed ? 'Missed' : gone ? '—' : esc(clock(a.leave_by))}</td>
        <td>${gone ? '—' : esc(clock(a.at_desk))}${!gone && a.work_eta_source === 'estimate' ? '<small>est.</small>' : ''}</td>
        <td class="col-where">${esc(whereText(a))}${tag ? `<span class="tag">${tag}</span>` : ''}</td>
      </tr>`;
    }).join('');
  }
  const ago = state.updated_at ? Math.max(0, Math.round(t - state.updated_at)) : null;
  $('#list-status').textContent = ago == null ? 'No data yet'
    : `Updated ${ago < 90 ? ago + 's' : Math.round(ago / 60) + ' min'} ago · refresh every ${state.settings.poll_seconds}s · ${state.api_calls_today} API calls today`;
  $('#list-routes').textContent = (state.auto_routes && state.routes.length ? 'Picked automatically: ' : '') + state.routes
    .map((r) => (r.found ? `#${r.rt} from ${r.home_stop.name}` : `#${r.rt}: no nearby stops`)).join('   ');
}

/* ------------------------------------------------------------------ map */

const map = { view: null, routes: null, buses: new Map(), drawn: '', bounds: null };

function fitMap() {
  if (!map.view || !map.bounds) return;
  map.view.invalidateSize();
  map.view.fitBounds(map.bounds, { padding: [24, 24] });
}

function placeMarker(lat, lon, cls, label, color) {
  const html = `<div class="place ${cls}" style="--c:${color}"><i></i><span>${esc(label)}</span></div>`;
  return L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: 2000,
  });
}

function renderMap() {
  const el = $('#map');
  if (!state) return;
  if (!window.L) {
    el.innerHTML = '<div class="map-error">The map couldn’t load.</div>';
    return;
  }
  const { home, work } = state;
  if (home.lat == null || work.lat == null) return;
  const t = now();

  if (!map.view) {
    map.view = L.map(el, { zoomControl: false, zoomSnap: 0.25, scrollWheelZoom: false, keyboard: false });
    map.view.attributionControl.setPrefix(false);
    L.tileLayer(TILES, { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map.view);
    map.routes = L.layerGroup().addTo(map.view);
  }

  // Routes, stops and the two walks are redrawn only when the route shapes change.
  const key = `${geometry.version}|${home.lat},${home.lon}|${work.lat},${work.lon}`;
  if (map.drawn !== key) {
    map.drawn = key;
    map.routes.clearLayers();
    const bounds = L.latLngBounds([[home.lat, home.lon], [work.lat, work.lon]]);
    for (const r of geometry.routes) {
      const c = routeColor(r.rt);
      L.polyline(r.path, { color: SCREEN, weight: 8, opacity: 0.6, interactive: false }).addTo(map.routes);
      L.polyline(r.path, { color: c, weight: 4, opacity: 0.95, interactive: false }).addTo(map.routes);
      for (const st of r.stops) {
        L.circleMarker([st.lat, st.lon], {
          radius: 3, color: c, weight: 1.5, fillColor: SCREEN, fillOpacity: 1, interactive: false,
        }).addTo(map.routes);
      }
      const walk = { color: AMBER, weight: 2.5, dashArray: '3 5', interactive: false };
      L.polyline([[home.lat, home.lon], [r.home_stop.lat, r.home_stop.lon]], walk).addTo(map.routes);
      L.polyline([[r.work_stop.lat, r.work_stop.lon], [work.lat, work.lon]], walk).addTo(map.routes);
      for (const p of r.path) bounds.extend(p);
    }
    placeMarker(home.lat, home.lon, 'home', 'Home', INK).addTo(map.routes);
    placeMarker(work.lat, work.lon, 'work left', work.label, AMBER).addTo(map.routes);
    map.bounds = bounds;
    fitMap();
  }

  // Buses: labelled when they're coming to your stop, small otherwise, grey going the other way.
  const seen = new Set();
  let inbound = 0;
  for (const v of state.vehicles || []) {
    if (v.lat == null) continue;
    seen.add(v.vid);
    const coming = v.eta && v.eta > t - 60 && v.eta - t < 45 * 60;
    if (coming) inbound++;
    const cls = coming ? '' : v.toward_work ? 'quiet' : 'other';
    const color = v.toward_work || coming ? routeColor(v.rt) : '';
    const html = `<div class="pin ${cls}"${color ? ` style="--c:${color}"` : ''}>` +
      `<span class="arrow" style="transform:rotate(${v.hdg || 0}deg)"><svg viewBox="0 0 10 10"><path d="M5 .5L9.5 9.5 5 7 .5 9.5Z"/></svg></span>` +
      `<span>${esc(`#${v.rt} ${coming ? minsLabel(v.eta - t) : ''}`)}</span></div>`;
    const icon = L.divIcon({ className: '', html, iconSize: [0, 0] });
    const z = coming ? 1000 : v.toward_work ? 500 : 0;
    let m = map.buses.get(v.vid);
    if (!m) {
      m = L.marker([v.lat, v.lon], { icon, interactive: false, keyboard: false, zIndexOffset: z }).addTo(map.view);
      map.buses.set(v.vid, m);
    } else {
      m.setLatLng([v.lat, v.lon]).setIcon(icon).setZIndexOffset(z);
    }
  }
  for (const [vid, m] of map.buses) {
    if (!seen.has(vid)) {
      m.remove();
      map.buses.delete(vid);
    }
  }
  const total = (state.vehicles || []).length;
  $('#map-status').textContent = `${inbound} coming to your stop · ${total} bus${total === 1 ? '' : 'es'} on your routes`;
}

/* ------------------------------------------------------------------ taskbar, ticker, dialogs */

function renderTray(t) {
  let cls = '', text = 'Starting';
  if (uplink === 'down') [cls, text] = ['down', 'Server offline'];
  else if (state?.setup_needed) [cls, text] = ['stale', 'Setup'];
  else if (state?.error && !state.stale) [cls, text] = ['down', 'CTA error'];
  else if (state?.stale) [cls, text] = ['stale', 'Offline'];
  else if (state?.demo) [cls, text] = ['demo', 'Demo'];
  else if (state && !state.active) [cls, text] = ['idle', 'Quiet hours'];
  else if (state?.status_message) [cls, text] = ['idle', 'Loading'];
  else if (state) [cls, text] = ['ok', 'Live'];
  $('#led').className = `led ${cls}`;
  $('#tray-link').textContent = text;
  $('#tray-clock').textContent = clock(t);
}

function renderTicker() {
  const alerts = state.alerts || [];
  const routes = state.routes.map((r) => '#' + r.rt).join(', ') || 'your routes';
  let text;
  if (state.demo) {
    text = 'Demo mode: these buses are simulated. Run start_display.bat without --demo for the real thing.';
  } else if (alerts.length) {
    text = alerts.map((a) => `${a.routes.length ? '#' + a.routes.join(', #') + ' — ' : ''}${a.headline}: ${a.text}`).join('        •        ');
  } else {
    text = `No CTA service alerts for ${routes}.`;
  }
  const el = $('#ticker-text');
  if (el.textContent !== text) {
    el.textContent = text;
    el.style.setProperty('--dur', `${Math.max(18, text.length * 0.11 + 8)}s`);
  }
  $('#ticker').classList.toggle('calm', !alerts.length);
}

function renderDialog() {
  let title = '', msg = '', icon = 'error';
  if (state?.setup_needed) {
    [title, msg, icon] = ['Setup', state.error, 'info'];
  } else if (state?.error && !state.stale) {
    [title, msg] = ['CTA Bus Tracker', state.error];
  } else if (uplink === 'down' && !state) {
    [title, msg] = ['Commute', 'Can’t reach the tracker. Is start_display.bat still running?'];
  }
  dialogSig = title + msg;
  const settingsOpen = !$('#settings-layer').hidden;
  $('#dialog-layer').hidden = !msg || dismissedSig === dialogSig || settingsOpen;
  if (!msg) return;
  $('#dlg-title').textContent = title;
  $('#dlg-msg').textContent = msg;
  $('#dlg-icon').className = `dialog-icon ${icon}`;
  $('#dlg-ok').textContent = state?.setup_needed ? 'Open Settings' : 'OK';
}

$('#dlg-ok').addEventListener('click', () => {
  dismissedSig = dialogSig;
  $('#dialog-layer').hidden = true;
  if (state?.setup_needed) openSettings();
  else refresh();
});

/* ------------------------------------------------------------------ settings */

const settingsForm = $('#settings-form');

function settingsMessage(text, isError = false) {
  const el = $('#settings-msg');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

function routesNote(s) {
  const list = s.picked.map((p) => `#${p.rt}${p.minutes ? ` (about ${p.minutes} min)` : ''}`).join(', ');
  if (s.auto) return list ? `Blank means automatic. Currently using ${list}.` : 'Blank means automatic.';
  return list ? `Using ${list}. Clear this to pick automatically.` : 'Clear this to pick automatically.';
}

async function openSettings() {
  $('#dialog-layer').hidden = true;
  $('#settings-layer').hidden = false;
  settingsMessage('Loading…');
  try {
    const res = await fetch('api/settings', { cache: 'no-store' });
    const s = await res.json();
    const f = settingsForm.elements;
    f.home_address.value = s.home_address;
    f.work_address.value = s.work_address;
    f.routes.value = s.routes;
    f.door_min.value = s.door_min;
    f.desk_min.value = s.desk_min;
    f.theme.value = s.theme;
    f.api_key.value = '';
    f.api_key.placeholder = s.api_key_set ? 'Saved. Leave blank to keep it.' : 'Paste your key here';
    $('#home-matched').textContent = s.home_matched ? `Found: ${s.home_matched}` : '';
    $('#work-matched').textContent = s.work_matched ? `Found: ${s.work_matched}` : '';
    $('#routes-note').textContent = routesNote(s);
    settingsMessage('');
    (s.home_address ? (s.work_address ? f.routes : f.work_address) : f.home_address).focus();
  } catch (err) {
    settingsMessage('Couldn’t load the current settings.', true);
  }
}

function closeSettings() {
  $('#settings-layer').hidden = true;
  $('#open-settings').focus();
}

function cancelSettings() {
  closeSettings();
  if (state && !THEME_FROM_URL) applyTheme(state.settings.theme);   // undo a theme preview
}

// Preview a theme as soon as it's picked; Save keeps it, Cancel puts the old one back.
settingsForm.elements.theme.addEventListener('change', (event) => applyTheme(event.target.value));

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const save = $('#settings-save');
  save.disabled = true;
  settingsMessage('Looking up addresses…');
  try {
    const res = await fetch('api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(settingsForm))),
    });
    const body = await res.json();
    if (!res.ok) {
      settingsMessage(body.error || 'Couldn’t save.', true);
      return;
    }
    dismissedSig = null;
    closeSettings();
    refresh();
  } catch (err) {
    settingsMessage('Couldn’t reach the tracker.', true);
  } finally {
    save.disabled = false;
  }
});

$('#settings-cancel').addEventListener('click', cancelSettings);
$('#open-settings').addEventListener('click', openSettings);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#settings-layer').hidden) cancelSettings();
});

/* ------------------------------------------------------------------ starfield background */

(function starfield() {
  const canvas = $('#starfield');
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tints = ['#ffffff', '#ffffff', '#ffffff', '#bfefff', '#ffe2a8', '#d9ccff'];
  let w = 0, h = 0, dpr = 1, stars = [], last = 0;

  const reset = (s, far) => Object.assign(s, {
    x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: far ? 1 : 0.05 + Math.random() * 0.95,
    c: tints[(Math.random() * tints.length) | 0],
  });
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = Math.round(innerWidth * dpr);
    h = canvas.height = Math.round(innerHeight * dpr);
    const n = Math.round(clamp((innerWidth * innerHeight) / 5000, 120, 420));
    stars = Array.from({ length: n }, () => reset({}, false));
  }
  function frame(ts) {
    requestAnimationFrame(frame);
    if (document.hidden || ts - last < 33 || document.documentElement.dataset.theme !== 'terminal') return;
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
    last = ts;
    ctx.clearRect(0, 0, w, h);
    const f = Math.max(w, h) * 0.5;
    for (const s of stars) {
      if (!still) s.z -= dt * 0.035;
      if (s.z <= 0.03) reset(s, true);
      const x = w / 2 + (s.x / s.z) * f * 0.5;
      const y = h / 2 + (s.y / s.z) * f * 0.5;
      if (x < 0 || x > w || y < 0 || y > h) { reset(s, true); continue; }
      const r = Math.max(0.6, (1 - s.z) * 2.6) * dpr;
      ctx.globalAlpha = clamp((1 - s.z) * 1.5, 0.15, 1);
      ctx.fillStyle = s.c;
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
  }
  resize();
  addEventListener('resize', resize);
  requestAnimationFrame(frame);
})();

/* ------------------------------------------------------------------ go */

// Nudge everything a few pixels every few minutes so a TV doesn't burn in the window chrome.
setInterval(() => {
  const dx = Math.round(Math.random() * 8 - 4), dy = Math.round(Math.random() * 6 - 3);
  $('#desktop').style.transform = `translate(${dx}px, ${dy}px)`;
  $('#taskbar').style.transform = `translateX(${dx}px)`;
}, 180000);

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { fitMap(); if (state) tick(); }, 150);
});

const bootEl = $('#boot');
bootEl.addEventListener('transitionend', () => bootEl.remove());
if (new URLSearchParams(location.search).has('nosplash')) bootEl.remove();
setTimeout(() => bootEl.classList.add('done'), 8000);   // never hide the dashboard behind the splash
setInterval(tick, 1000);
setInterval(refresh, REFRESH_MS);
refresh();
if (location.hash === '#settings') openSettings();   // bookmarkable, e.g. from a phone
