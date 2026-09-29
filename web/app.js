'use strict';
/* Commute Control 95 — living-room display for the CTA commute tracker.
   Polls /api/state from server.py and redraws; countdowns tick locally every second. */

const REFRESH_MS = 5000;
const TZ = 'America/Chicago';
const ROUTE_COLORS = ['#3ef2ff', '#ffb52e', '#ff5ce1', '#9dff4d', '#a894ff', '#ff7a45'];
const LOAD_LABEL = { EMPTY: 'Seats open', HALF_EMPTY: 'Some seats', FULL: 'Crowded' };
// Chicago's street grid: 800 address numbers per mile, so these are exact enough for a map.
const STREETS = [
  ['Foster', 41.9760], ['Lawrence', 41.9688], ['Montrose', 41.9616], ['Irving Park', 41.9543],
  ['Addison', 41.9471], ['Belmont', 41.9398], ['Diversey', 41.9325], ['Fullerton', 41.9253],
  ['Armitage', 41.9180], ['North Ave', 41.9107], ['Division', 41.9036], ['Chicago Ave', 41.8966],
  ['Grand', 41.8918], ['Lake', 41.8857], ['Madison', 41.8820], ['Jackson', 41.8781], ['Roosevelt', 41.8674],
];

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

function onState() {
  document.body.classList.toggle('sleep', !state.active);
  renderRadar();
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

/* ------------------------------------------------------------------ T-MINUS */

function emptyReason(t) {
  if (!state) return ['Scanning…', 'Waiting for the first telemetry from CTA.'];
  if (state.setup_needed) return ['Setup needed', state.error];
  if (state.error && !state.stale) return ['No signal', state.error];
  const routes = state.routes.map((r) => '#' + r.rt).join(', ');
  if (!state.active) return ['Night mode', `Outside your active hours. Checking ${routes} every few minutes.`];
  if ((state.arrivals || []).length) return ['Next bus leaves too soon', 'Every predicted bus is out of reach. Hang tight for the next prediction.'];
  return ['No buses predicted', `CTA has no predictions for ${routes} at your stop. Service may not be running right now.`];
}

function renderHero(hero, t) {
  const el = $('#hero');
  el.classList.toggle('empty', !hero);
  $('#hero-tflag').textContent = state?.stale ? 'SIGNAL LOST' : state?.demo ? 'DEMO' : '';

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
    [mode, title, sub] = ['standby', 'STANDBY', `by ${clock(hero.leave_by)}`];
  } else if (leaveIn > 60) {
    [mode, title, sub] = ['prepare', 'GET READY', `out by ${clock(hero.leave_by)}`];
  } else if (leaveIn > 0) {
    [mode, title, sub] = ['go', 'GO NOW', `${Math.round(hero.walk_to_stop_min)} min walk to the stop`];
  } else {
    [mode, title, sub] = ['run', 'RUN FOR IT', `bus in ${mmss(toStop)}`];
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

/* ------------------------------------------------------------------ ARRIVAL */

function renderDest(hero, t) {
  if (state) $('#dest-tsub').textContent = state.work.label;
  $('#dest-date').textContent = dateFmt.format(new Date(t * 1000));
  if (!hero) {
    $('#dest-time').textContent = '--:--';
    $('#dest-ampm').textContent = '';
    $('#dest-total').textContent = 'AWAITING LAUNCH WINDOW';
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

/* ------------------------------------------------------------------ TRAJECTORY */

function busGlyph(x, y, size, color, extra = '') {
  const w = size * 2.3, h = size;
  return `<g transform="translate(${(x - w / 2).toFixed(1)},${(y - h * 1.2).toFixed(1)})" ${extra}>
    <rect width="${w}" height="${h}" rx="${h * 0.2}" fill="${color}"/>
    <rect x="${w * 0.07}" y="${h * 0.18}" width="${w * 0.6}" height="${h * 0.34}" fill="#03101a"/>
    <rect x="${w * 0.74}" y="${h * 0.18}" width="${w * 0.19}" height="${h * 0.52}" fill="#03101a"/>
    <circle cx="${w * 0.24}" cy="${h}" r="${h * 0.2}" fill="#03060e" stroke="${color}" stroke-width="${h * 0.08}"/>
    <circle cx="${w * 0.72}" cy="${h}" r="${h * 0.2}" fill="#03060e" stroke="${color}" stroke-width="${h * 0.08}"/>
  </g>`;
}

function renderTrajectory(hero, t) {
  const svg = $('#traj');
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H) return;
  const fs = clamp(Math.min(H * 0.12, W * 0.016), 11, 34);
  const g = geometry.routes.find((r) => r.rt === hero?.rt) || geometry.routes[0];
  if (!state || !g) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#6f8fa6" font-size="${fs * 1.4}" text-anchor="middle">AWAITING ROUTE GEOMETRY</text>`;
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
  let s = `<defs><filter id="tglow" x="-20%" y="-200%" width="140%" height="500%">
      <feGaussianBlur stdDeviation="${fs * 0.22}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter></defs>`;

  // track: dashed on the way in, solid for your ride
  s += `<line x1="${xL}" y1="${yLine}" x2="${xHome}" y2="${yLine}" stroke="${color}" stroke-opacity=".45" stroke-width="${fs * 0.16}" stroke-dasharray="${fs * 0.5} ${fs * 0.35}"/>`;
  s += `<line x1="${xHome}" y1="${yLine}" x2="${xR}" y2="${yLine}" stroke="${color}" stroke-width="${fs * 0.28}" filter="url(#tglow)"/>`;
  for (let m = 1; m * 5280 < up; m++) {
    const x = X(-m * 5280);
    s += `<line x1="${x}" y1="${yLine - fs * 0.35}" x2="${x}" y2="${yLine + fs * 0.35}" stroke="#6f8fa6"/>`;
    s += `<text x="${x}" y="${yLine + fs * 1.3}" fill="#6f8fa6" font-size="${fs}" text-anchor="middle">${m} MI</text>`;
  }
  for (const st of g.stops) {
    s += `<circle cx="${X(st.offset_ft).toFixed(1)}" cy="${yLine}" r="${fs * 0.17}" fill="#03060e" stroke="${color}" stroke-width="${fs * 0.08}"/>`;
  }

  // your stop and your office
  s += `<line x1="${xHome}" y1="${yLine - fs * 0.9}" x2="${xHome}" y2="${yLine + fs * 0.9}" stroke="#fff" stroke-width="${fs * 0.14}"/>`;
  s += `<text x="${xHome}" y="${yLine + fs * 1.5}" fill="#fff" font-size="${fs * 1.05}" text-anchor="middle">▲ YOUR STOP</text>`;
  s += `<text x="${xHome}" y="${yLine + fs * 2.55}" fill="#d9f6ff" font-size="${fs}" text-anchor="middle">${esc(g.home_stop.name)}</text>`;
  s += `<rect x="${xR - fs * 0.35}" y="${yLine - fs * 0.7}" width="${fs * 0.7}" height="${fs * 1.4}" fill="#ffb52e"/>`;
  s += `<text x="${xR}" y="${yLine + fs * 1.5}" fill="#ffb52e" font-size="${fs * 1.05}" text-anchor="end">${esc(state.work.label.toUpperCase())} ▲</text>`;
  s += `<text x="${xR}" y="${yLine + fs * 2.55}" fill="#d9f6ff" font-size="${fs}" text-anchor="end">${esc(g.work_stop.name)}</text>`;

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
  s += `<text x="${xL}" y="${yLine + fs * 2.55}" fill="#6f8fa6" font-size="${fs}">◀ ${
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

/* ------------------------------------------------------------------ MANIFEST */

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
  $('#list-routes').textContent = state.routes
    .map((r) => (r.found ? `#${r.rt} from ${r.home_stop.name}` : `#${r.rt}: no nearby stops`)).join('   ');
}

/* ------------------------------------------------------------------ RADAR */

function renderRadar() {
  const svg = $('#radar');
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H || !state) return;
  const t = now();
  const fs = clamp(Math.min(W * 0.032, H * 0.024), 11, 30);
  const { home, work } = state;
  if (home.lat == null || work.lat == null) {
    svg.innerHTML = '';
    return;
  }

  const tracked = (state.vehicles || []).filter((v) => v.eta && v.eta > t - 60 && v.eta - t < 45 * 60);
  const pts = [[home.lat, home.lon], [work.lat, work.lon]];
  for (const r of geometry.routes) for (const p of r.path) pts.push(p);
  for (const v of tracked) pts.push([v.lat, v.lon]);
  const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 0.02);
  const spanX = Math.max((Math.max(...lons) - Math.min(...lons)) * kx, 0.01);
  const scale = Math.min(W / (spanX * 1.3), H / (spanY * 1.15));
  const P = (lat, lon) => [W / 2 + (lon - midLon) * kx * scale, H / 2 - (lat - midLat) * scale];
  const [hx, hy] = P(home.lat, home.lon);
  const [wx, wy] = P(work.lat, work.lon);
  const R = Math.hypot(W, H);

  let s = `<defs>
    <filter id="rglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${fs * 0.3}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="sweep" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#4dff88" stop-opacity=".32"/><stop offset="1" stop-color="#4dff88" stop-opacity="0"/></linearGradient>
  </defs>`;

  // street grid (latitude lines) and range rings around home
  const latTop = midLat + H / 2 / scale, latBottom = midLat - H / 2 / scale;
  for (const [name, lat] of STREETS) {
    if (lat > latTop || lat < latBottom) continue;
    const y = P(lat, midLon)[1];
    s += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#1d5a45" stroke-dasharray="2 6"/>`;
    s += `<text x="${fs * 0.4}" y="${y - fs * 0.25}" fill="#3fb88a" font-size="${fs * 0.85}">${name.toUpperCase()}</text>`;
  }
  const pxPerMile = scale / 69.05;
  for (let m = 1; m <= 12 && m * pxPerMile < R; m++) {
    const r = m * pxPerMile;
    s += `<circle cx="${hx}" cy="${hy}" r="${r}" fill="none" stroke="#1f7a5a" stroke-opacity=".5"/>`;
    s += `<text x="${hx + r * 0.72}" y="${hy + r * 0.69}" fill="#2f9470" font-size="${fs * 0.75}">${m} MI</text>`;
  }
  const a = (-38 * Math.PI) / 180;
  s += `<g transform="translate(${hx},${hy})"><g>
      <path d="M0 0L${R} 0A${R} ${R} 0 0 0 ${R * Math.cos(a)} ${R * Math.sin(a)}Z" fill="url(#sweep)"/>
      <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="8s" repeatCount="indefinite"/>
    </g></g>`;
  s += `<text transform="translate(${W - fs * 0.7},${H / 2}) rotate(90)" fill="#2a7fa0" font-size="${fs}" text-anchor="middle" letter-spacing="${fs * 0.5}">LAKE MICHIGAN</text>`;

  // routes, then the walk legs, then home & office
  for (const r of geometry.routes) {
    const c = routeColor(r.rt);
    const d = r.path.map((p, i) => (i ? 'L' : 'M') + P(p[0], p[1]).map((n) => n.toFixed(1)).join(' ')).join('');
    s += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${fs * 0.22}" stroke-linejoin="round" stroke-linecap="round" stroke-opacity=".85" filter="url(#rglow)"/>`;
    for (const st of r.stops) {
      const [x, y] = P(st.lat, st.lon);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${fs * 0.13}" fill="#010806" stroke="${c}" stroke-width="${fs * 0.07}"/>`;
    }
    const [sx, sy] = P(r.home_stop.lat, r.home_stop.lon);
    const [ex, ey] = P(r.work_stop.lat, r.work_stop.lon);
    s += `<line x1="${hx}" y1="${hy}" x2="${sx}" y2="${sy}" stroke="#ffb52e" stroke-width="${fs * 0.12}" stroke-dasharray="${fs * 0.2} ${fs * 0.2}"/>`;
    s += `<line x1="${ex}" y1="${ey}" x2="${wx}" y2="${wy}" stroke="#ffb52e" stroke-width="${fs * 0.12}" stroke-dasharray="${fs * 0.2} ${fs * 0.2}"/>`;
  }
  s += `<circle cx="${hx}" cy="${hy}" r="${fs * 0.5}" fill="none" stroke="#fff" stroke-width="${fs * 0.1}">
      <animate attributeName="r" values="${fs * 0.5};${fs * 1.6}" dur="2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;0" dur="2s" repeatCount="indefinite"/></circle>`;
  s += `<circle cx="${hx}" cy="${hy}" r="${fs * 0.38}" fill="#fff"/>`;
  s += `<text x="${hx - fs * 0.9}" y="${hy + fs * 0.35}" fill="#fff" font-size="${fs * 1.1}" text-anchor="end">HOME</text>`;
  s += `<rect x="${wx - fs * 0.4}" y="${wy - fs * 0.4}" width="${fs * 0.8}" height="${fs * 0.8}" fill="#ffb52e" transform="rotate(45 ${wx} ${wy})"/>`;
  s += `<text x="${wx - fs * 0.9}" y="${wy + fs * 0.35}" fill="#ffb52e" font-size="${fs * 1.1}" text-anchor="end">${esc(state.work.label.toUpperCase())}</text>`;

  // buses: bright = heading your way, grey = other direction
  let visible = 0;
  const placed = [{ x: hx - fs * 2, y: hy + fs * 0.35, w: fs * 3 }, { x: wx - fs * 6, y: wy + fs * 0.35, w: fs * 7 }];
  const labelSpot = (x, y, w) => {
    for (let i = 0; i < 4; i++) {
      const ly = y + i * fs * 1.05;
      if (!placed.some((p) => Math.abs(p.x - x) < Math.max(p.w, w) && Math.abs(p.y - ly) < fs)) {
        placed.push({ x, y: ly, w });
        return ly;
      }
    }
    return null;
  };
  const ordered = [...(state.vehicles || [])].sort((p, q) => (p.eta || Infinity) - (q.eta || Infinity));
  for (const v of ordered) {
    const [x, y] = P(v.lat, v.lon);
    if (x < -fs || x > W + fs || y < -fs || y > H + fs) continue;
    visible++;
    const c = v.toward_work ? routeColor(v.rt) : '#5f7f74';
    const z = v.toward_work ? fs * 0.6 : fs * 0.4;
    s += `<path transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${v.hdg || 0})" d="M0 ${-z}L${z * 0.7} ${z * 0.8}L0 ${z * 0.4}L${-z * 0.7} ${z * 0.8}Z" fill="${c}"${v.toward_work ? ' filter="url(#rglow)"' : ''}/>`;
    if (v.eta && v.eta > t - 60 && v.eta - t < 45 * 60) {
      const label = `#${v.rt} ${minsLabel(v.eta - t)}`;
      const ly = labelSpot(x + z * 1.3, y + fs * 0.35, label.length * fs * 0.5);
      if (ly != null) s += `<text x="${x + z * 1.3}" y="${ly}" fill="${c}" font-size="${fs}">${esc(label)}</text>`;
    }
  }
  svg.innerHTML = s;
  $('#radar-status').textContent = `${visible} bus${visible === 1 ? '' : 'es'} in view · ${tracked.length} inbound to your stop`;
  $('#radar-coords').textContent = `${home.lat.toFixed(3)}°N ${Math.abs(home.lon).toFixed(3)}°W`;
}

/* ------------------------------------------------------------------ taskbar, ticker, dialogs */

function renderTray(t) {
  let cls = '', text = 'BOOT';
  if (uplink === 'down') [cls, text] = ['down', 'NO UPLINK'];
  else if (state?.setup_needed) [cls, text] = ['stale', 'SETUP'];
  else if (state?.error && !state.stale) [cls, text] = ['down', 'CTA ERROR'];
  else if (state?.stale) [cls, text] = ['stale', 'SIGNAL LOST'];
  else if (state?.demo) [cls, text] = ['demo', 'DEMO'];
  else if (state) [cls, text] = ['ok', 'LIVE'];
  $('#led').className = `led ${cls}`;
  $('#tray-link').textContent = text;
  $('#tray-clock').textContent = clock(t);
}

function renderTicker() {
  const alerts = state.alerts || [];
  const routes = state.routes.map((r) => '#' + r.rt).join(', ') || 'your routes';
  let text;
  if (state.demo) {
    text = 'DEMO MODE — simulated buses. Add your CTA API key and route numbers to config.json for live tracking.';
  } else if (alerts.length) {
    text = alerts.map((a) => `▲ ${a.routes.length ? '#' + a.routes.join('/#') + ' ' : ''}${a.headline.toUpperCase()}: ${a.text}`).join('      ✦      ');
  } else {
    text = `ALL SYSTEMS NOMINAL — no CTA service alerts for ${routes}.`;
  }
  const el = $('#ticker-text');
  if (el.textContent !== text) {
    el.textContent = text;
    el.style.setProperty('--dur', `${Math.max(18, text.length * 0.11 + 8)}s`);
  }
  $('#ticker').classList.toggle('calm', !alerts.length);
}

function renderDialog() {
  let title = '', msg = '', icon = 'error', steps = false;
  if (state?.setup_needed) {
    [title, msg, icon, steps] = ['Commute Control Setup', state.error, 'info', true];
  } else if (state?.error && !state.stale) {
    [title, msg] = ['CTA BusTime', state.error];
  } else if (uplink === 'down' && !state) {
    [title, msg] = ['Commute Control', 'Can’t reach the tracker. Is server.py (start_display.bat) running?'];
  }
  dialogSig = title + msg;
  $('#dialog-layer').hidden = !msg || dismissedSig === dialogSig;
  if (!msg) return;
  $('#dlg-title').textContent = title;
  $('#dlg-msg').textContent = msg;
  $('#dlg-icon').className = `dialog-icon ${icon}`;
  const ol = $('#dlg-steps');
  ol.hidden = !steps;
  if (steps) {
    ol.innerHTML = '<li>Put <code>CTA_API_KEY=your-key</code> in the <code>.env</code> file in the tracker folder.</li>' +
      '<li>Open <code>config.json</code>.</li>' +
      '<li>List your buses, e.g. <code>"routes": ["146", "151"]</code>.</li>' +
      '<li>Restart <code>start_display.bat</code>.</li>';
  }
}

$('#dlg-ok').addEventListener('click', () => {
  dismissedSig = dialogSig;
  $('#dialog-layer').hidden = true;
  refresh();
});

/* ------------------------------------------------------------------ starfield (the Win95 screensaver, at warp 0.5) */

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
    if (document.hidden || ts - last < 33) return;
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
  resizeTimer = setTimeout(() => { if (state) { renderRadar(); tick(); } }, 150);
});

const bootEl = $('#boot');
bootEl.addEventListener('transitionend', () => bootEl.remove());
if (new URLSearchParams(location.search).has('nosplash')) bootEl.remove();
setTimeout(() => bootEl.classList.add('done'), 8000);   // never hide the dashboard behind the splash
setInterval(tick, 1000);
setInterval(refresh, REFRESH_MS);
refresh();
