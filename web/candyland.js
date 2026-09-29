'use strict';
/* Candy theme extra: nine candy characters wander the map and now and then get into a fight.
   Purely decorative.
     ?crew=off    hide them on this screen
     ?crew=fight  every meeting turns into a fight that ends with the revolver (preview)
   The "Angry mode" button on the bottom bar makes every meeting a fight; remembered per screen. */

(function candyCrew() {
  const mode = new URLSearchParams(location.search).get('crew');
  if (mode === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = document.querySelector('.map-screen');
  if (!host) return;
  const FIGHT_PREVIEW = mode === 'fight';

  const ANGER_CHANCE = 1 / 3;      // a meeting goes sour
  const REVOLVER_CHANCE = 1 / 2;   // after the rock, the one who got hit shoots instead of running
  const GORE_SECONDS = 30;         // then the mess fades so the map stays readable

  /* ---------------------------------------------------------------- Angry mode button */

  const angryButton = document.getElementById('angry-toggle');
  let angryMode = false;
  try { angryMode = localStorage.getItem('commute-angry') === 'on'; } catch (err) { /* storage blocked */ }
  function showAngry() {
    if (!angryButton) return;
    angryButton.setAttribute('aria-pressed', String(angryMode));
    angryButton.textContent = angryMode ? 'Angry mode: on' : 'Angry mode';
  }
  angryButton?.addEventListener('click', () => {
    angryMode = !angryMode;
    try { localStorage.setItem('commute-angry', angryMode ? 'on' : 'off'); } catch (err) { /* storage blocked */ }
    showAngry();
  });
  showAngry();

  /* ---------------------------------------------------------------- layers */

  const layer = document.createElement('div');
  layer.id = 'candy-crew';
  layer.setAttribute('aria-hidden', 'true');
  host.appendChild(layer);
  // Pools, drops and landed pieces. Once the street map exists this moves into a map pane between
  // the streets and the route lines, so bus lines and labels always stay readable on top of it.
  const ground = document.createElement('div');
  ground.className = 'cc-ground';
  layer.appendChild(ground);

  function placeGround() {
    const view = typeof map !== 'undefined' && map.view;   // app.js's Leaflet map
    if (!view || !window.L) return;
    let pane = view.getPane('candyGround');
    if (!pane) {
      pane = view.createPane('candyGround');
      pane.style.zIndex = 350;             // tiles are 200, route lines 400, bus markers 600
      pane.style.pointerEvents = 'none';
    }
    if (ground.parentNode !== pane) pane.appendChild(ground);
    const pos = L.DomUtil.getPosition(view.getPane('mapPane'));   // undo any map panning
    ground.style.transform = `translate(${-pos.x}px, ${-pos.y}px)`;
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[(Math.random() * list.length) | 0];
  const chance = (p) => Math.random() < p;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clampN = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  function mix(a, b, t) {
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const A = rgb(a), B = rgb(b);
    return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  }

  /* ---------------------------------------------------------------- drawing (SVG, 60 x 80 units, feet at y≈78) */

  // shared bits; `n` keeps gradient ids unique per character
  const defs = (n, extra = '') => `<defs>
    <radialGradient id="sh${n}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="st${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9ced8"/><stop offset=".5" stop-color="#7d8390"/><stop offset="1" stop-color="#4a4f5a"/></linearGradient>
    <linearGradient id="wd${n}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b8743a"/><stop offset="1" stop-color="#5c3013"/></linearGradient>
    <radialGradient id="gl${n}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#dcdcdc"/></radialGradient>
    ${extra}</defs>`;
  const shadow = `<ellipse class="shadow" cx="30" cy="78.5" rx="16" ry="2.6" fill="#3a1d48" opacity=".22"/>`;

  function eyes(x1, x2, y, iris, lid) {
    const one = (x) => `
      <ellipse cx="${x}" cy="${y}" rx="3.6" ry="4.3" fill="#fff" stroke="${lid}" stroke-width=".7"/>
      <g class="pupil" style="transform-origin:${x}px ${y + 0.6}px">
        <circle cx="${x}" cy="${y + 0.6}" r="2.3" fill="${iris}"/><circle cx="${x}" cy="${y + 0.6}" r="1.15" fill="#111"/>
        <circle cx="${x + 0.9}" cy="${y - 0.4}" r=".75" fill="#fff"/></g>
      <path d="M${x - 3.8} ${y - 1.4}q3.8-4.6 7.6 0" fill="none" stroke="${lid}" stroke-width="1.2" stroke-linecap="round"/>`;
    return `
      <g class="eyes">${one(x1)}${one(x2)}</g>
      <g class="ko-eyes" stroke="${lid}" stroke-width="1.8" stroke-linecap="round">
        <path d="M${x1 - 3} ${y - 3}l6 6M${x1 + 3} ${y - 3}l-6 6M${x2 - 3} ${y - 3}l6 6M${x2 + 3} ${y - 3}l-6 6"/></g>
      <g class="brows" stroke="${lid}" stroke-width="2.2" stroke-linecap="round">
        <path d="M${x1 - 4.5} ${y - 9}l7.5 3.5M${x2 + 4.5} ${y - 9}l-7.5 3.5"/></g>
      <g class="scared-brows" stroke="${lid}" stroke-width="1.8" stroke-linecap="round">
        <path d="M${x1 - 4.5} ${y - 6.5}l7 -3.5M${x2 + 4.5} ${y - 6.5}l-7 -3.5"/></g>`;
  }
  const mouths = (ink, cx, y) => `
    <path class="mouth" d="M${cx - 4.5} ${y}Q${cx} ${y + 4.5} ${cx + 4.5} ${y}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>
    <path class="frown" d="M${cx - 4.5} ${y + 3}Q${cx} ${y - 1.5} ${cx + 4.5} ${y + 3}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>
    <g class="gasp"><ellipse cx="${cx}" cy="${y + 2}" rx="2.6" ry="3.4" fill="#2a0a12"/><ellipse cx="${cx}" cy="${y + 3.6}" rx="1.6" ry="1.1" fill="#c2485a"/></g>`;
  const legs = (color, shoe, y) => `
    <g class="leg-l" style="transform-origin:25px ${y}px"><path d="M25 ${y}v10.5" stroke="${color}" stroke-width="4.2" stroke-linecap="round"/>
      <path d="M18.5 ${y + 14.5}q.5-5 6.5-4.6q5 .3 4.8 4.6z" fill="${shoe}"/><ellipse cx="22" cy="${y + 11.6}" rx="2.2" ry=".7" fill="#fff" opacity=".35"/></g>
    <g class="leg-r" style="transform-origin:35px ${y}px"><path d="M35 ${y}v10.5" stroke="${color}" stroke-width="4.2" stroke-linecap="round"/>
      <path d="M30.2 ${y + 14.5}q-.2-4.3 4.8-4.6q6-.4 6.5 4.6z" fill="${shoe}"/><ellipse cx="37" cy="${y + 11.6}" rx="2.2" ry=".7" fill="#fff" opacity=".35"/></g>`;
  // The right hand holds the revolver, drawn along the arm so a -45deg turn levels it.
  const arms = (n, color, sx, sy) => `
    <g class="arm-l" style="transform-origin:${60 - sx}px ${sy}px"><path d="M${60 - sx} ${sy}l-7 8" stroke="${color}" stroke-width="3.6" stroke-linecap="round"/>
      <circle cx="${60 - sx - 7.5}" cy="${sy + 8.8}" r="3" fill="url(#gl${n})" stroke="#9a9a9a" stroke-width=".5"/></g>
    <g class="arm-r" style="transform-origin:${sx}px ${sy}px"><path d="M${sx} ${sy}l7 8" stroke="${color}" stroke-width="3.6" stroke-linecap="round"/>
      <g class="gun" transform="translate(${sx + 7.5} ${sy + 8.8}) rotate(45)">
        <rect x="3" y="-2.4" width="13" height="2.9" rx=".7" fill="url(#st${n})"/>
        <rect x="14.2" y="-3.4" width="1.1" height="1.2" fill="#4a4f5a"/>
        <rect x="-1" y="-3.2" width="6" height="5.4" rx="1.3" fill="url(#st${n})"/>
        <g fill="#454a55"><rect x="-.2" y="-2.5" width="4.4" height=".7"/><rect x="-.2" y="-.7" width="4.4" height=".7"/><rect x="-.2" y="1.1" width="4.4" height=".7"/></g>
        <path d="M-1.2 1.6q-3.4 6.4.6 9l3.2-.2q-1.4-4.2 1.4-8.4z" fill="url(#wd${n})"/>
        <path d="M2.4 2.1q.8 3 3 2.8" fill="none" stroke="#454a55" stroke-width=".8"/></g>
      <circle cx="${sx + 7.5}" cy="${sy + 8.8}" r="3" fill="url(#gl${n})" stroke="#9a9a9a" stroke-width=".5"/></g>`;

  const gumdrop = (p, n) => `<svg viewBox="0 0 60 80">
    ${defs(n, `<radialGradient id="bd${n}" cx="36%" cy="28%" r="80%"><stop offset="0" stop-color="${mix(p.body, '#ffffff', 0.45)}"/><stop offset=".5" stop-color="${p.body}"/><stop offset="1" stop-color="${mix(p.body, '#000000', 0.45)}"/></radialGradient>
      <pattern id="sg${n}" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="#fff" opacity=".6"/><rect x="3" y="3" width=".9" height=".9" fill="#fff" opacity=".45" transform="rotate(30 3.4 3.4)"/></pattern>`)}
    ${shadow}${legs(mix(p.body, '#000000', 0.5), '#3b2a2a', 63)}
    <path d="M8 65C8 30 16 13 30 13S52 30 52 65Q30 70 8 65Z" fill="url(#bd${n})"/>
    <path d="M8 65C8 30 16 13 30 13S52 30 52 65Q30 70 8 65Z" fill="url(#sg${n})"/>
    <path d="M8 65Q30 70 52 65" fill="none" stroke="${mix(p.body, '#000000', 0.5)}" stroke-width="1.2" opacity=".6"/>
    <ellipse cx="20" cy="27" rx="6" ry="9.5" fill="url(#sh${n})" opacity=".75" transform="rotate(-22 20 27)"/>
    ${arms(n, mix(p.body, '#000000', 0.4), 50, 46)}
    ${eyes(23.5, 36.5, 38, p.iris, p.ink)}${mouths(p.ink, 30, 47.5)}
  </svg>`;

  const cop = (p, n) => `<svg viewBox="0 0 60 80">
    ${defs(n, `<pattern id="cn${n}" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(40)"><rect width="4.5" height="9" fill="${p.stripe}"/></pattern>
      <linearGradient id="cy${n}" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset=".3" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient>
      <linearGradient id="cp${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(p.cap, '#ffffff', 0.25)}"/><stop offset="1" stop-color="${mix(p.cap, '#000000', 0.35)}"/></linearGradient>
      <radialGradient id="au${n}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff3b0"/><stop offset=".6" stop-color="#e8b020"/><stop offset="1" stop-color="#9a6a00"/></radialGradient>`)}
    ${shadow}${legs(p.cap, '#111418', 65)}
    <path d="M37 28C38 6 15 4 15 19" fill="none" stroke="${p.edge}" stroke-width="11" stroke-linecap="round"/>
    <path d="M37 28C38 6 15 4 15 19" fill="none" stroke="#f4f4f4" stroke-width="8.4" stroke-linecap="round"/>
    <path d="M37 28C38 6 15 4 15 19" fill="none" stroke="${p.stripe}" stroke-width="8.4" stroke-dasharray="4 5"/>
    <path d="M35.2 26C36 8.5 17 6.5 16.6 17" fill="none" stroke="#fff" stroke-width="1.6" opacity=".7" stroke-linecap="round"/>
    <rect x="19" y="24" width="22" height="43" rx="11" fill="#f4f4f4" stroke="${p.edge}" stroke-width="1.6"/>
    <rect x="19.8" y="24.8" width="20.4" height="41.4" rx="10.2" fill="url(#cn${n})"/>
    <rect x="19.8" y="24.8" width="20.4" height="41.4" rx="10.2" fill="url(#cy${n})"/>
    <ellipse cx="30" cy="38.5" rx="9.2" ry="8.8" fill="#fbf4ef"/>
    <ellipse cx="27" cy="35" rx="4" ry="2.5" fill="url(#sh${n})" opacity=".5"/>
    <path d="M17.5 25h25l-3.2-8.5H20.7Z" fill="url(#cp${n})"/>
    <path d="M15.6 23.6h28.8q1.6 3.4-1.8 3.8H17.4q-3.4-.4-1.8-3.8Z" fill="#0b1026"/>
    <path d="M18 24.3h22" stroke="#fff" stroke-width=".6" opacity=".35"/>
    <path d="M30 17.8l1.3 2.4 2.6.3-1.9 1.8.5 2.6-2.5-1.3-2.5 1.3.5-2.6-1.9-1.8 2.6-.3Z" fill="url(#au${n})"/>
    ${arms(n, p.cap, 41.5, 45)}
    ${eyes(26.6, 33.4, 36.5, p.iris, '#1b1b2e')}
    <path d="M23.8 43q3.2-3.4 6.2 0q3-3.4 6.2 0q-3 2.8-6.2.6q-3.2 2.2-6.2-.6Z" fill="${p.stache}" stroke="${mix(p.stache, '#000000', 0.4)}" stroke-width=".5"/>
    ${mouths('#1b1b2e', 30, 45.5)}
    <path d="M30 52l1.4 2.8 3.1.4-2.3 2.1.6 3.1-2.8-1.5-2.8 1.5.6-3.1-2.3-2.1 3.1-.4Z" fill="url(#au${n})" stroke="#9a6a00" stroke-width=".4"/>
  </svg>`;

  const redHot = (p, n) => `<svg viewBox="0 0 60 80">
    ${defs(n, `<radialGradient id="rb${n}" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="${mix(p.body, '#ffffff', 0.4)}"/><stop offset=".45" stop-color="${p.body}"/><stop offset="1" stop-color="${mix(p.body, '#000000', 0.55)}"/></radialGradient>
      <linearGradient id="fl${n}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${p.flame}"/><stop offset="1" stop-color="${p.flame2}"/></linearGradient>
      <radialGradient id="bw${n}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="${mix(p.bow, '#ffffff', 0.4)}"/><stop offset="1" stop-color="${mix(p.bow, '#000000', 0.25)}"/></radialGradient>
      <radialGradient id="bl${n}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ff7fa8" stop-opacity=".7"/><stop offset="1" stop-color="#ff7fa8" stop-opacity="0"/></radialGradient>`)}
    ${shadow}${legs(mix(p.body, '#000000', 0.55), '#2a1414', 63)}
    <path d="M21 26C19.5 15 27 14 26 4.5c7 5 9.5 9.5 7.2 14.5 4.2-4.2 7.4-1 6.2 7Z" fill="url(#fl${n})"/>
    <path d="M25.4 25c-.2-6.4 4.2-7.4 3.8-12.6 4.4 4.2 5.2 7.6 3.2 12.6Z" fill="${p.flame2}" opacity=".85"/>
    <ellipse cx="30" cy="44" rx="20" ry="21" fill="url(#rb${n})"/>
    <path d="M46 55q5-8 3.5-18" fill="none" stroke="#fff" stroke-width="1.4" opacity=".35" stroke-linecap="round"/>
    <ellipse cx="21" cy="33" rx="5.5" ry="8.5" fill="url(#sh${n})" opacity=".8" transform="rotate(-28 21 33)"/>
    <circle cx="25" cy="29" r="1.3" fill="#fff" opacity=".9"/>
    <g transform="translate(41 26)"><path d="M0 0l-7.5-5.5v11ZM0 0l7.5-5.5v11Z" fill="url(#bw${n})"/><circle r="2.3" fill="url(#bw${n})"/></g>
    <ellipse cx="17.5" cy="47" rx="4.2" ry="2.8" fill="url(#bl${n})"/><ellipse cx="42.5" cy="47" rx="4.2" ry="2.8" fill="url(#bl${n})"/>
    ${arms(n, mix(p.body, '#000000', 0.5), 49.5, 45)}
    <g stroke="${p.ink}" stroke-width="1.2" stroke-linecap="round"><path d="M19.5 36.5l-2.2-2M21 35.2l-1.2-2.6M40.5 36.5l2.2-2M39 35.2l1.2-2.6"/></g>
    ${eyes(23.5, 36.5, 39.5, p.iris, p.ink)}
    ${mouths(p.ink, 30, 49)}
  </svg>`;

  /* ---------------------------------------------------------------- the cast */

  // Everyday lines, used sparingly.
  const KINDS = {
    gumdrop: {
      draw: gumdrop, cut: 0.62, stump: '64%',
      parts: ['gd-chunk', 'gd-chunk gd-small', 'gd-leg', 'gd-chunk gd-tiny'],
      hello: ['Hey.', "How's it going?", 'Morning.', "What's up?"],
      chat: ['Bus is running late again.', 'Long day.', 'You heading downtown?', "Traffic's bad on Lake Shore."],
      angry: ['What did you just say?', 'You got a problem?', 'Back off.'],
      hurt: ['Ow!', 'Are you serious?!'],
      threat: ['Bad move.', "That's it."],
      plead: ['Wait, wait!', 'Whoa, hold on!'],
    },
    cop: {
      draw: cop, cut: 0.6, stump: '38%',
      parts: ['cane-chunk', 'cane-chunk cane-short', 'cop-leg', 'cop-cap'],
      hello: ['Evening.', 'How you doing.', 'Hey there.'],
      chat: ['Quiet shift so far.', 'Watch yourself crossing Michigan.', 'That bus ran the light.'],
      angry: ["You're under arrest.", 'Hands where I can see them.', "Don't test me."],
      hurt: ['You just assaulted an officer.', 'Ow! Hey!'],
      threat: ['Freeze, SUCKER!', 'Drop it!', 'Last warning.'],
      plead: ['Easy, easy!', 'Put it down!'],
    },
    redHot: {
      draw: redHot, cut: 0.66, stump: '56%',
      parts: ['rh-chunk', 'rh-chunk rh-small', 'rh-leg', 'rh-bow'],
      hello: ['Hi.', 'Oh, hey.', 'How are you?'],
      chat: ["It's freezing out.", 'My bus is 20 minutes out.', 'Did you see that accident?'],
      angry: ['Excuse me?', "Don't talk to me like that.", 'You want to go?'],
      hurt: ['Ow! What is wrong with you?!', 'Hey!'],
      threat: ['Big mistake.', 'Try that again.'],
      plead: ['No, no, no!', "Please, don't!"],
    },
  };
  const RUN_LINES = ['Get away from me!', 'Help!'];
  const BYE_LINES = ['See you.', 'Later.', 'Take care.'];
  const SCREAMS = ['AAAH!', 'Oh my God!', 'Somebody call 911!', 'Run!'];
  const SHRUGS = ['Yeah, keep walking.', 'Hmph.'];

  // Nine characters: three variations of each kind (color, size, name).
  const CAST = [
    { kind: 'gumdrop', name: 'Gumdrop Man', size: 1, body: '#35c96a', ink: '#123d22', iris: '#5b3a1a' },
    { kind: 'gumdrop', name: 'Grape Gumdrop', size: 0.9, body: '#a06cf5', ink: '#2a1050', iris: '#2f6fb0' },
    { kind: 'gumdrop', name: 'Orange Gumdrop', size: 1.1, body: '#ff9a2e', ink: '#4a2300', iris: '#3d7a3d' },
    { kind: 'cop', name: 'Candy Cane Cop', size: 1, stripe: '#e3242b', edge: '#a50f22', cap: '#1b2a5e', stache: '#6b3a1f', iris: '#3a6ea5' },
    { kind: 'cop', name: 'Peppermint Sergeant', size: 1.08, stripe: '#1faa55', edge: '#137a3b', cap: '#1d2433', stache: '#d8d8d8', iris: '#4a4a4a' },
    { kind: 'cop', name: 'Blue Raspberry Cop', size: 0.92, stripe: '#2f7fe0', edge: '#1b4f99', cap: '#1b2a5e', stache: '#3b2412', iris: '#6b4a2a' },
    { kind: 'redHot', name: 'Red Hot Babe', size: 1, body: '#e3242b', flame: '#ff7a1a', flame2: '#ffd23f', bow: '#ff5fa8', ink: '#3a0a10', iris: '#6b3a1f' },
    { kind: 'redHot', name: 'Hot Pink Babe', size: 0.9, body: '#ff4fa3', flame: '#b34dff', flame2: '#ffc6ef', bow: '#ffd23f', ink: '#4a0a2a', iris: '#2f6fb0' },
    { kind: 'redHot', name: 'Cinnamon Babe', size: 1.08, body: '#c1440e', flame: '#ff9a1a', flame2: '#fff1a0', bow: '#ff8fb8', ink: '#2e0d02', iris: '#3d7a3d' },
  ].map((p, n) => {
    const kind = KINDS[p.kind];
    const dark = p.kind === 'cop' ? p.edge : mix(p.body, '#000000', 0.45);
    return {
      ...kind, name: p.name, size: p.size, svg: kind.draw(p, n),
      // colors for the pieces that come off
      partStyle: p.kind === 'cop'
        ? `--stripe:${p.stripe};--dark:${p.edge};--leg:${p.cap};--cap:${p.cap}`
        : `--body:${p.body};--dark:${dark};--leg:${dark}${p.bow ? `;--bow:${p.bow}` : ''}`,
    };
  });

  /* ---------------------------------------------------------------- characters */

  const crew = CAST.map((who) => {
    const el = document.createElement('div');
    el.className = 'cc';
    el.dataset.name = who.name;
    el.style.setProperty('--size', who.size);
    el.style.setProperty('--cut', who.cut);
    el.style.setProperty('--stump-w', who.stump);
    el.innerHTML = `<div class="cc-flip"><div class="cc-sprite">${who.svg}<div class="cc-stump"></div></div></div>
      <div class="cc-sweat"><i></i><i></i></div><div class="cc-bubble"></div>`;
    layer.appendChild(el);
    return {
      ...who, el,
      flip: el.querySelector('.cc-flip'),
      bubble: el.querySelector('.cc-bubble'),
      x: 0, y: 0, tx: 0, ty: 0, speed: 0, facing: 1, w: 40, h: 54,
      state: 'idle', idleUntil: 0, busy: false, gone: false, dead: false, readyAt: 0, bubbleTimer: null,
    };
  });

  let W = 0, H = 0, charW = 40, charH = 54, placed = false, last = 0;
  const pairReadyAt = new Map();

  const bounds = () => ({ x0: charW * 0.6, x1: W - charW * 0.6, y0: charH + 44, y1: H - 6 });
  function randomSpot() {
    const b = bounds();
    return [rand(b.x0, Math.max(b.x0, b.x1)), rand(b.y0, Math.max(b.y0, b.y1))];
  }
  function measure() {
    W = layer.clientWidth;
    H = layer.clientHeight;
    ground.style.width = `${W}px`;
    ground.style.height = `${H}px`;
    for (const c of crew) {
      c.w = c.el.offsetWidth || c.w;
      c.h = c.el.offsetHeight || c.h;
    }
    charW = Math.max(...crew.map((c) => c.w));   // the biggest one sets the walking bounds
    charH = Math.max(...crew.map((c) => c.h));
  }
  new ResizeObserver(measure).observe(layer);

  function setClass(c, name, on) { c.el.classList.toggle(name, on); }

  function say(c, text, style = '', ms = 1900) {
    if (c.dead) return;                     // no talking without a head
    clearTimeout(c.bubbleTimer);
    c.bubble.textContent = text;
    c.bubble.className = `cc-bubble ${style}`;
    c.bubble.style.setProperty('--shift', '0px');
    const bw = c.bubble.offsetWidth;
    const left = c.x - bw / 2;
    c.bubble.style.setProperty('--shift', `${clampN(left, 4, W - bw - 4) - left}px`);
    requestAnimationFrame(() => c.bubble.classList.add('show'));
    c.bubbleTimer = setTimeout(() => c.bubble.classList.remove('show'), ms);
  }

  function walkTo(c, x, y, speed, state = 'walk') {
    const b = bounds();
    c.tx = clampN(x, b.x0, b.x1);
    c.ty = clampN(y, b.y0, b.y1);
    c.speed = speed;
    c.state = state;
  }

  function runFrom(c, from, dist, speed) {
    const dx = c.x - from[0] || rand(-1, 1), dy = c.y - from[1] || rand(-1, 1);
    const len = Math.hypot(dx, dy);
    walkTo(c, c.x + (dx / len) * dist, c.y + (dy / len) * dist * 0.6, speed, 'run');
  }

  function wander(c, now) {
    // Sometimes stroll toward someone, which is how meetings happen.
    const others = crew.filter((o) => o !== c && !o.gone);
    if (others.length && chance(FIGHT_PREVIEW ? 0.6 : 0.2)) {
      const o = pick(others);
      walkTo(c, o.x + rand(-50, 50), o.y + rand(-20, 20), rand(26, 38));
    } else {
      const [x, y] = randomSpot();
      walkTo(c, x, y, rand(22, 36));
    }
    c.idleUntil = now;
  }

  function faceEachOther(a, b) {
    a.facing = b.x >= a.x ? 1 : -1;
    b.facing = -a.facing;
  }

  function step(c, dt, now) {
    if (c.gone) return;
    if (c.state === 'walk' || c.state === 'run') {
      const dx = c.tx - c.x, dy = c.ty - c.y;
      const dist = Math.hypot(dx, dy);
      const move = c.speed * dt;
      if (dist <= move) {
        c.x = c.tx; c.y = c.ty;
        if (c.state === 'walk' && !c.busy) { c.state = 'idle'; c.idleUntil = now + rand(700, 3000); }
        else if (c.state === 'run') c.state = 'idle';
      } else {
        c.x += (dx / dist) * move;
        c.y += (dy / dist) * move;
        if (Math.abs(dx) > 1) c.facing = dx > 0 ? 1 : -1;
      }
    } else if (!c.busy && now >= c.idleUntil) {
      wander(c, now);
    }
    setClass(c, 'walking', c.state === 'walk');
    setClass(c, 'running', c.state === 'run');
  }

  function draw(c) {
    c.el.style.transform = `translate(${(c.x - c.w / 2).toFixed(1)}px, ${(c.y - c.h).toFixed(1)}px)`;
    c.el.style.zIndex = String(Math.round(c.y));
    c.flip.style.transform = `scaleX(${c.facing})`;
  }

  const handPoint = (c) => [c.x + c.facing * c.w * 0.55, c.y - c.h * 0.35];
  const muzzlePoint = (c) => [c.x + c.facing * c.w * 0.8, c.y - c.h * 0.36];
  const chestPoint = (c) => [c.x, c.y - c.h * 0.5];
  const headPoint = (c) => [c.x, c.y - c.h * (1 - c.cut * 0.55)];
  const neckPoint = (c) => [c.x, c.y - c.h * (1 - c.cut)];

  /* ---------------------------------------------------------------- props and effects */

  // Moves an element along an arc; `landed` runs where it comes down.
  function fly(el, from, to, ms, arc, spin, landed) {
    layer.appendChild(el);
    const start = performance.now();
    return new Promise((resolve) => {
      function frame(t) {
        const k = Math.min(1, (t - start) / ms);
        const gx = from[0] + (to[0] - from[0]) * k;
        const gy = from[1] + (to[1] - from[1]) * k;
        el.style.transform = `translate(${gx}px, ${gy - arc * 4 * k * (1 - k)}px) rotate(${spin * k}deg)`;
        if (landed && landed.during) landed.during(k, gx, gy);
        if (k < 1) { requestAnimationFrame(frame); return; }
        if (landed) landed(el);
        else el.remove();
        resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  function prop(cls) {
    const el = document.createElement('div');
    el.className = cls;
    return el;
  }

  function burst(cls, x, y, ms = 450) {
    const fx = prop(cls);
    fx.style.transform = `translate(${x}px, ${y}px)`;
    layer.appendChild(fx);
    setTimeout(() => fx.remove(), ms);
  }

  function screenFlash([x, y]) {
    const fx = prop('cc-screenflash');
    fx.style.setProperty('--fx', `${x}px`);
    fx.style.setProperty('--fy', `${y}px`);
    layer.appendChild(fx);
    setTimeout(() => fx.remove(), 300);
  }

  function quake() {
    const desk = document.getElementById('desktop');
    if (!desk) return;
    desk.classList.remove('cc-quake');
    void desk.offsetWidth;          // restart the animation
    desk.classList.add('cc-quake');
    setTimeout(() => desk.classList.remove('cc-quake'), 500);
  }

  /* ---------------------------------------------------------------- the mess (fades after GORE_SECONDS) */

  function leaveOnGround(el) {
    ground.appendChild(el);
    setTimeout(() => {
      el.classList.add('cc-fade');
      setTimeout(() => el.remove(), 2500);
    }, GORE_SECONDS * 1000);
    while (ground.childElementCount > 600) ground.firstElementChild.remove();
  }

  function pool(x, y, w, h, growMs, cls = '') {
    const p = prop(`cc-pool ${cls}`);
    p.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;transition-duration:${growMs}ms,2.5s`;
    leaveOnGround(p);
    requestAnimationFrame(() => requestAnimationFrame(() => p.classList.add('grown')));
  }

  function drop(x, y, big = 1) {
    const d = prop('cc-drop');
    const size = rand(3, 7) * big;
    d.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size * rand(0.6, 1)}px`;
    leaveOnGround(d);
  }

  // A piece flies off in an arc, dripping on the ground under its path, and splats where it lands.
  function throwPiece(el, from, to, ms, arc, splat = [16, 28]) {
    let lastDrop = 0;
    const landed = (piece) => {
      piece.classList.add('landed');
      leaveOnGround(piece);
      pool(to[0] + rand(-3, 3), to[1] + rand(2, 6), rand(...splat), rand(...splat) * 0.45, 2500, 'small');
    };
    landed.during = (k, gx, gy) => {
      if (k - lastDrop > 0.07) { lastDrop = k; drop(gx + rand(-4, 4), gy + rand(-3, 3)); }
    };
    return fly(el, from, to, ms, arc, rand(360, 1000) * (chance(0.5) ? -1 : 1), landed);
  }

  function droplet(from, to) {
    const d = prop('cc-droplet');
    const landed = (el) => { el.remove(); drop(to[0], to[1], rand(0.6, 1.2)); };
    fly(d, from, to, rand(320, 480), rand(18, 46), 0, landed);
  }

  // Blood keeps spurting from the neck for a while.
  function spurt(c, away, ms) {
    const end = performance.now() + ms;
    const timer = setInterval(() => {
      if (performance.now() > end || c.gone) { clearInterval(timer); return; }
      const [nx, ny] = neckPoint(c);
      droplet([nx, ny], [nx + away * rand(6, 55) + rand(-8, 8), c.y + rand(-12, 8)]);
    }, 60);
  }

  function headshot(body, shooter) {
    const away = body.x >= shooter.x ? 1 : -1;
    const b = bounds();
    const landAt = (lo, hi) => [
      clampN(body.x + away * rand(lo, hi), 8, W - 8),
      clampN(body.y + rand(-30, 30), b.y0 - charH * 0.5, H - 6),
    ];

    // the head comes off: a copy of the top of the character, eyes X'd out
    body.dead = true;
    clearTimeout(body.bubbleTimer);
    body.bubble.classList.remove('show');
    setClass(body, 'headless', true);
    setClass(body, 'scared', false);
    const head = prop('cc-part cc-head');
    head.style.cssText = `width:${body.w}px;height:${body.h}px;margin:${-body.h * body.cut * 0.5}px 0 0 ${-body.w / 2}px;--cut:${body.cut}`;
    const copy = body.el.querySelector('.cc-sprite svg').cloneNode(true);
    copy.style.transform = `scaleX(${body.facing})`;
    head.appendChild(copy);
    throwPiece(head, headPoint(body), landAt(90, 180), rand(850, 1150), rand(90, 140), [26, 40]);

    // candy pieces and meat
    const from = chestPoint(body);
    body.parts.forEach((cls, i) => {
      const piece = prop(`cc-part ${cls}`);
      piece.style.cssText = body.partStyle;
      setTimeout(() => throwPiece(piece, from, landAt(40, 150), rand(550, 900), rand(40, 90)), i * 60);
    });
    for (let i = 0; i < 8; i++) {
      const piece = prop(`cc-part meat m${1 + (i % 3)}`);
      piece.style.setProperty('--s', rand(0.6, 1.3).toFixed(2));
      setTimeout(() => throwPiece(piece, neckPoint(body), landAt(20, 170), rand(450, 950), rand(30, 110)), 30 + i * 45);
    }

    // spray behind them
    const [nx] = neckPoint(body);
    for (let i = 0; i < 34; i++) {
      const d = rand(6, 110);
      drop(nx + away * d + rand(-10, 10), body.y + rand(-16, 14) * (1 - d / 160), rand(0.6, 1.5));
    }
    spurt(body, away, 1500);
  }

  // Anyone close enough panics and runs.
  function panic(body, shooter) {
    let screamers = 0;
    for (const c of crew) {
      if (c === body || c === shooter || c.gone || c.dead) continue;
      if (Math.hypot(c.x - body.x, c.y - body.y) > 340) continue;
      setClass(c, 'scared', true);
      setTimeout(() => setClass(c, 'scared', false), 3500);
      if (screamers < 2 && chance(0.7)) {
        screamers++;
        setTimeout(() => say(c, pick(SCREAMS), 'scream', 1400), rand(150, 600));
      }
      if (!c.busy) runFrom(c, [body.x, body.y], rand(170, 260), rand(130, 170));
    }
  }

  /* ---------------------------------------------------------------- a meeting */

  async function encounter(a, b) {
    for (const c of [a, b]) { c.busy = true; c.state = 'idle'; }
    faceEachOther(a, b);
    const talker = chance(0.5) ? a : b;
    const other = talker === a ? b : a;
    if (chance(0.6)) {
      say(talker, pick(talker.hello));
      await wait(1400);
      if (chance(0.45)) { say(other, pick(other.hello)); await wait(1300); }
    } else {
      await wait(1000);
    }

    if (FIGHT_PREVIEW || angryMode || chance(ANGER_CHANCE)) {
      const [attacker, victim] = chance(0.5) ? [a, b] : [b, a];
      await fight(attacker, victim);
    } else {
      if (chance(0.35)) { say(talker, pick(talker.chat), '', 2200); await wait(2300); }
      if (chance(0.4)) { say(other, pick(BYE_LINES)); await wait(900); }
      await wait(400);
    }

    const now = performance.now();
    pairReadyAt.set(pairKey(a, b), now + (FIGHT_PREVIEW ? 4000 : 25000));
    for (const c of [a, b]) {
      if (c.gone) continue;
      c.busy = false;
      c.readyAt = now + 12000;
      for (const cls of ['angry', 'scared', 'armed']) setClass(c, cls, false);
      wander(c, now);
    }
  }

  async function fight(attacker, victim) {
    setClass(attacker, 'angry', true);
    if (chance(0.7)) say(attacker, pick(attacker.angry), 'mad');
    await wait(1300);

    setClass(attacker, 'throwing', true);
    await fly(prop('cc-rock'), handPoint(attacker), chestPoint(victim), 620, 55, 540);
    setClass(attacker, 'throwing', false);
    burst('cc-bonk', ...chestPoint(victim));
    setClass(victim, 'hurt', true);
    if (chance(0.6)) say(victim, pick(victim.hurt), 'mad', 1200);
    await wait(650);
    setClass(victim, 'hurt', false);

    if (FIGHT_PREVIEW || chance(REVOLVER_CHANCE)) {
      await execute(victim, attacker);      // no running: they shoot right away
      return;
    }

    // otherwise the one who got hit runs off for a bit
    runFrom(victim, [attacker.x, attacker.y], 200, 150);
    if (chance(0.4)) say(victim, pick(RUN_LINES), '', 1100);
    await wait(2200);
    victim.state = 'idle';
    if (chance(0.5)) say(attacker, pick(SHRUGS), '', 1200);
    await wait(800);
  }

  async function execute(shooter, target) {
    faceEachOther(shooter, target);
    setClass(target, 'angry', false);
    setClass(target, 'scared', true);        // the target sees the gun
    setClass(shooter, 'armed', true);
    setClass(shooter, 'angry', true);
    if (chance(0.85)) say(target, pick(target.plead), 'scream', 1300);
    await wait(550);
    if (chance(0.35)) say(shooter, pick(shooter.threat), 'mad', 900);
    await wait(750);

    const muzzle = muzzlePoint(shooter);
    burst('cc-flash big', ...muzzle, 320);
    screenFlash(muzzle);
    quake();
    say(shooter, 'BANG!', 'bang', 900);
    await fly(prop('cc-bullet'), muzzle, headPoint(target), 80, 0, 0);
    headshot(target, shooter);
    panic(target, shooter);

    await wait(1500);                        // the body stands a moment, then drops
    setClass(target, 'ko', true);
    pool(target.x - target.facing * target.w * 0.35, target.y - target.h * 0.06,
      target.w * 3, target.w * 1.15, 9000, 'body');
    await wait(1200);
    setClass(shooter, 'armed', false);
    setClass(shooter, 'angry', false);
    await wait(6500);

    // gone, then back from the edge a little later
    setClass(target, 'poof', true);
    target.gone = true;
    await wait(3500);
    const [x, y] = randomSpot();
    Object.assign(target, { x: chance(0.5) ? bounds().x0 : bounds().x1, y, gone: false, dead: false, state: 'idle' });
    for (const cls of ['headless', 'ko', 'poof', 'scared', 'angry']) setClass(target, cls, false);
    draw(target);
    walkTo(target, x, y, 30);
  }

  const pairKey = (a, b) => [a.name, b.name].sort().join('|');

  function maybeMeet(now) {
    for (let i = 0; i < crew.length; i++) {
      for (let j = i + 1; j < crew.length; j++) {
        const a = crew[i], b = crew[j];
        if (a.busy || b.busy || a.gone || b.gone || a.dead || b.dead || now < a.readyAt || now < b.readyAt) continue;
        if (now < (pairReadyAt.get(pairKey(a, b)) || 0)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.w + b.w) * 0.8) { encounter(a, b); return; }
      }
    }
  }

  /* ---------------------------------------------------------------- loop */

  function frame(ts) {
    requestAnimationFrame(frame);
    const on = document.documentElement.dataset.theme === 'candy' && !document.hidden;
    layer.hidden = !on;
    ground.hidden = !on;
    if (angryButton) angryButton.hidden = document.documentElement.dataset.theme !== 'candy';
    if (on) placeGround();
    if (!on) { last = 0; return; }
    if (!W || !H) measure();
    if (!W || !H) return;
    if (!placed) {
      placed = true;
      crew.forEach((c, i) => {
        [c.x, c.y] = randomSpot();
        c.idleUntil = ts + 250 * i;
        c.readyAt = ts + 3000 + 600 * i;
      });
    }
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
    last = ts;
    for (const c of crew) step(c, dt, ts);
    maybeMeet(ts);
    for (const c of crew) draw(c);
  }
  requestAnimationFrame(frame);
})();
