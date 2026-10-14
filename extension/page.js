// Page helper, injected on demand (chrome.scripting, files: ["page.js"]) into
// the ISOLATED world of a tab's top frame. The isolated world keeps its
// globals for the life of the document, so element refs, the overlay and the
// cursor survive between calls and vanish with the page on navigation.
//
// The service worker calls it as __nsPage.call(name, args); errors come back
// as { __nsError } so they survive the trip through chrome.scripting.
//
// Everything visible lives in ONE host element with a closed shadow root:
// the glow, the island, the element highlight and the agent cursor. It is
// pointer-events: none throughout and is hidden while a screenshot is taken.
(() => {
  const VERSION = 1;
  if (globalThis.__nsPage && globalThis.__nsPage.version === VERSION) return;

  const RU = /^ru\b/i.test(navigator.language || "");
  const pick = (label) => (Array.isArray(label) ? label[RU ? 1 : 0] : label || "");
  const HOST_ID = "__webmcp_overlay__";
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------------------
  // Overlay host
  // ---------------------------------------------------------------------------
  const ui = { host: null, root: null };
  const glow = { on: false };

  const MARK_SVG = `<svg class="mark" viewBox="0 0 120 80" aria-hidden="true">
      <defs><linearGradient id="g" x1="4" y1="0" x2="116" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#a3e635"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs>
      <g transform="translate(6,-4) skewX(-11)">
        <polyline points="14,22 32,42 14,62" fill="none" stroke="url(#g)" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <g transform="translate(40,4) scale(.72) translate(9,0) skewX(-11)">
        <polyline points="86,10 32,10 32,41 80,41 80,74 24,74" fill="none" stroke="url(#g)" stroke-width="15" stroke-linejoin="miter"/>
      </g>
    </svg>`;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    /* ---- Glow: one shape, one colour: a solid frame whose inner edge is a
       rounded rectangle (the frame also runs past the window, so the blur has
       colour to sample beyond the edge), blurred as a whole. */
    .ring {
      position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
      overflow: hidden;
      opacity: 0; transition: opacity .6s ease;
      animation: hue 4.5s ease-in-out infinite;
    }
    .ring.on { opacity: 1; }
    .breath {
      position: absolute; inset: 0; animation: inhale 3.2s ease-in-out infinite;
      /* A blurred frame is brighter in the corners: each corner is dimmed by
         a soft radial mask so it matches the edges. */
      --dim: radial-gradient(circle closest-side, rgba(0,0,0,.2), rgba(0,0,0,.1) 45%, transparent 100%);
      mask:
        linear-gradient(#000, #000),
        var(--dim) -140px -140px / 280px 280px no-repeat,
        var(--dim) calc(100% + 140px) -140px / 280px 280px no-repeat,
        var(--dim) -140px calc(100% + 140px) / 280px 280px no-repeat,
        var(--dim) calc(100% + 140px) calc(100% + 140px) / 280px 280px no-repeat;
      mask-composite: subtract, add, add, add, add;
    }
    .layer { position: absolute; inset: 0; }
    .hole { position: absolute; border-radius: 40px; }
    .wide { filter: blur(34px); opacity: .33; }
    .wide .hole { inset: 26px; box-shadow: 0 0 0 400px #10d090; }
    .near { filter: blur(9px); opacity: .5; }
    .near .hole { inset: 7px; border-radius: 30px; box-shadow: 0 0 0 400px #22f5a8; }
    .ring:not(.on) .breath, .ring:not(.on) { animation-play-state: paused; }
    @keyframes hue {
      0%, 100% { filter: hue-rotate(0deg); }
      33% { filter: hue-rotate(30deg); }
      66% { filter: hue-rotate(-40deg); }
    }
    @keyframes inhale {
      0%, 100% { filter: brightness(.72) saturate(.9); }
      50% { filter: brightness(1.2) saturate(1.15); }
    }
    /* ---- The island: "NeuroSquad MCP is working" + the current action. */
    .island {
      position: fixed; left: 50%; bottom: 18px; z-index: 2147483646; pointer-events: none;
      transform: translate(-50%, 14px) scale(.96); opacity: 0;
      transition: opacity .35s ease, transform .45s cubic-bezier(.2, .9, .25, 1.15);
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px 8px 10px; border-radius: 999px;
      background: rgba(12, 13, 13, .86);
      border: 1px solid rgba(163, 230, 53, .28);
      box-shadow: 0 10px 34px rgba(0, 0, 0, .45), 0 0 22px rgba(16, 185, 129, .22);
      backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3);
      font: 500 13px/1.2 Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #f4f4f5; letter-spacing: .01em; white-space: nowrap;
    }
    .island.on { opacity: 1; transform: translate(-50%, 0) scale(1); }
    .mark { width: 26px; height: 18px; flex: none; }
    .title { font-weight: 650; }
    .sep { width: 1px; height: 14px; background: rgba(255, 255, 255, .16); }
    .action { color: #a1a1aa; display: flex; align-items: center; gap: 7px; }
    .action:empty { display: none; }
    .dot {
      width: 7px; height: 7px; border-radius: 50%; flex: none;
      background: #22f5a8; box-shadow: 0 0 0 0 rgba(34, 245, 168, .6);
      animation: ping 1.6s ease-out infinite;
    }
    .shine {
      background: linear-gradient(90deg, #a3e635, #10b981 40%, #f4f4f5 50%, #10b981 60%, #a3e635);
      background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
      animation: shine 3.2s linear infinite;
    }
    @keyframes ping {
      0% { box-shadow: 0 0 0 0 rgba(34, 245, 168, .55); }
      80%, 100% { box-shadow: 0 0 0 8px rgba(34, 245, 168, 0); }
    }
    @keyframes shine { from { background-position: 100% 0; } to { background-position: -150% 0; } }

    /* ---- Element highlight: soft accent outline, subtle fill, action label. */
    .hl {
      position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none;
      border-radius: 9px; opacity: 0; transition: opacity .22s ease;
      border: 1.5px solid rgba(34, 245, 168, .9);
      background: linear-gradient(135deg, rgba(163, 230, 53, .07), rgba(16, 185, 129, .11));
      box-shadow: 0 0 0 4px rgba(34, 245, 168, .12), 0 0 22px rgba(16, 185, 129, .38),
        inset 0 0 14px rgba(34, 245, 168, .14);
      will-change: transform, width, height;
    }
    .hl.on { opacity: 1; }
    .hl.out { transition: opacity .45s ease; }
    .hl::after {
      content: ""; position: absolute; inset: -1.5px; border-radius: inherit;
      border: 1.5px solid rgba(163, 230, 53, .0);
      animation: hlpulse 1.6s ease-out infinite;
    }
    .hl:not(.on)::after { animation: none; }
    @keyframes hlpulse {
      0% { box-shadow: 0 0 0 0 rgba(34, 245, 168, .45); }
      100% { box-shadow: 0 0 0 9px rgba(34, 245, 168, 0); }
    }
    .hl-label {
      position: absolute; left: -1.5px; bottom: calc(100% + 6px);
      display: flex; align-items: center; gap: 6px;
      padding: 3px 9px 3px 7px; border-radius: 999px;
      background: rgba(12, 13, 13, .9); border: 1px solid rgba(163, 230, 53, .3);
      box-shadow: 0 6px 18px rgba(0, 0, 0, .4), 0 0 14px rgba(16, 185, 129, .25);
      font: 600 11px/1.25 Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #f4f4f5; letter-spacing: .02em; white-space: nowrap;
    }
    .hl.below .hl-label { bottom: auto; top: calc(100% + 6px); }
    .hl.inside .hl-label { bottom: auto; top: 5px; left: 5px; }
    .hl-label .dot { width: 6px; height: 6px; }
    .hl-text {
      background: linear-gradient(90deg, #a3e635, #22f5a8);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }

    /* ---- The agent cursor. Positioned by transform only (compositor). */
    .cursor {
      position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
      opacity: 0; transition: opacity .28s ease;
      will-change: transform, opacity;
    }
    .cursor.on { opacity: 1; }
    .cursor.parked { opacity: 0; transition: opacity .6s ease; }
    .ptr {
      position: absolute; left: -3px; top: -2px; width: 24px; height: 28px;
      transform-origin: 3px 2px;
      filter: drop-shadow(0 0 5px rgba(34, 245, 168, .55)) drop-shadow(0 3px 5px rgba(0, 0, 0, .45));
    }
    .ptr svg { width: 100%; height: 100%; display: block; overflow: visible; }
    .cursor.press .ptr { animation: press .26s cubic-bezier(.3, .7, .4, 1); }
    @keyframes press { 0% { transform: scale(1); } 35% { transform: scale(.78); } 100% { transform: scale(1); } }
    .badge {
      position: absolute; left: 17px; top: 21px; height: 15px; padding: 0 5px;
      display: flex; align-items: center; border-radius: 999px;
      background: rgba(12, 13, 13, .88); border: 1px solid rgba(163, 230, 53, .32);
      box-shadow: 0 0 10px rgba(16, 185, 129, .3);
    }
    .badge .mark { width: 15px; height: 10px; }
    .caret {
      position: absolute; left: 22px; top: -3px; width: 2px; height: 17px; border-radius: 2px;
      background: linear-gradient(#a3e635, #10b981); box-shadow: 0 0 8px rgba(34, 245, 168, .8);
      opacity: 0; transition: opacity .15s ease;
    }
    .cursor.typing .caret { opacity: 1; animation: caret .9s ease-in-out infinite; }
    @keyframes caret { 0%, 100% { opacity: 1; transform: scaleY(1); } 50% { opacity: .25; transform: scaleY(.8); } }
    .ripple {
      position: fixed; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
      z-index: 2147483647; pointer-events: none; border-radius: 50%;
      border: 2px solid rgba(34, 245, 168, .95);
      box-shadow: 0 0 14px rgba(16, 185, 129, .7), inset 0 0 8px rgba(163, 230, 53, .5);
      animation: ripple .55s cubic-bezier(.2, .7, .3, 1) forwards;
    }
    @keyframes ripple { 0% { transform: scale(.2); opacity: 1; } 100% { transform: scale(1.5); opacity: 0; } }

    @media (prefers-reduced-motion: reduce) {
      .ring, .breath, .dot, .shine, .hl::after { animation: none; }
      .island { transition: opacity .2s ease; transform: translate(-50%, 0); }
      .cursor.press .ptr, .cursor.typing .caret { animation: none; }
      .ripple { animation: fade .3s ease forwards; transform: scale(.9); }
      @keyframes fade { from { opacity: .9; } to { opacity: 0; } }
    }
  `;

  const ARROW_SVG = `<svg viewBox="0 0 24 28" aria-hidden="true">
      <defs><linearGradient id="cg" x1="3" y1="2" x2="18" y2="24" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#a3e635"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs>
      <path d="M3.2 2.2 L3.2 22.4 L8.4 17.6 L11.9 25.4 L15.3 23.9 L11.8 16.2 L18.6 16.2 Z"
        fill="#0c0d0d" fill-opacity=".92" stroke="url(#cg)" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M5.4 7 L5.4 16.6 L8.3 13.9" fill="none" stroke="#22f5a8" stroke-opacity=".55" stroke-width="1.1" stroke-linecap="round"/>
    </svg>`;

  function ensureHost() {
    if (ui.host && ui.host.isConnected) return ui;
    // A host left by an older extension build (or a page that cloned it).
    for (const id of [HOST_ID, "__webmcp_glow__"]) document.getElementById(id)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="ring"><div class="breath">
        <div class="layer wide"><div class="hole"></div></div>
        <div class="layer near"><div class="hole"></div></div>
      </div></div>
      <div class="hl"><div class="hl-label"><span class="dot"></span><span class="hl-text"></span></div></div>
      <div class="island" role="status" aria-live="polite">
        ${MARK_SVG}
        <span class="title shine"></span>
        <span class="sep"></span>
        <span class="action"><span class="dot"></span><span class="label"></span></span>
      </div>
      <div class="cursor"><div class="ptr">${ARROW_SVG}</div><div class="badge">${MARK_SVG}</div><div class="caret"></div></div>`;
    (document.documentElement || document.body).appendChild(host);
    root.querySelector(".title").textContent = RU ? "NeuroSquad MCP работает" : "NeuroSquad MCP is working";
    ui.host = host;
    ui.root = root;
    ui.ring = root.querySelector(".ring");
    ui.island = root.querySelector(".island");
    ui.label = root.querySelector(".label");
    ui.hl = root.querySelector(".hl");
    ui.hlText = root.querySelector(".hl-text");
    ui.cursor = root.querySelector(".cursor");
    cursor.drawn = null;
    hl.shown = null;
    return ui;
  }

  // Removes the host once nothing is showing, so idle pages carry no extra node.
  let teardownTimer = null;
  function scheduleTeardown() {
    clearTimeout(teardownTimer);
    teardownTimer = setTimeout(() => {
      if (glow.on || hl.el || cursor.visible || cursor.anim) return;
      ui.host?.remove();
      ui.host = null;
    }, 900);
  }

  function glowShow(label) {
    ensureHost();
    clearTimeout(teardownTimer);
    glow.on = true;
    ui.host.style.visibility = "";
    const action = pick(label);
    if (action) ui.label.textContent = action;
    requestAnimationFrame(() => {
      if (!glow.on || !ui.host) return;
      ui.ring.classList.add("on");
      ui.island.classList.add("on");
    });
    return true;
  }

  function glowHide() {
    glow.on = false;
    if (!ui.host) return true;
    ui.ring.classList.remove("on");
    ui.island.classList.remove("on");
    scheduleTeardown();
    return true;
  }

  // Screenshots must show the page, not our overlay.
  function setHidden(hidden) {
    if (ui.host) ui.host.style.visibility = hidden ? "hidden" : "";
    for (const id of [HOST_ID, "__webmcp_glow__"]) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = hidden ? "hidden" : "";
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Element highlight: follows the element while visible (rAF only then).
  // ---------------------------------------------------------------------------
  const hl = { el: null, shown: null, raf: 0, fadeTimer: null, from: null, moveStart: 0 };
  const HL_PAD = 4;
  const HL_MOVE_MS = 200;

  function hlTargetRect() {
    if (!hl.el || !hl.el.isConnected) return null;
    const r = hl.el.getBoundingClientRect();
    return { x: r.left - HL_PAD, y: r.top - HL_PAD, w: r.width + HL_PAD * 2, h: r.height + HL_PAD * 2 };
  }

  function hlTick() {
    hl.raf = 0;
    if (!ui.host || !hl.el) return;
    const t = hlTargetRect();
    if (!t) return highlightDone(0);
    let r = t;
    const k = Math.min(1, (performance.now() - hl.moveStart) / HL_MOVE_MS);
    if (hl.from && k < 1) {
      const e = 1 - Math.pow(1 - k, 3);
      r = {
        x: hl.from.x + (t.x - hl.from.x) * e,
        y: hl.from.y + (t.y - hl.from.y) * e,
        w: hl.from.w + (t.w - hl.from.w) * e,
        h: hl.from.h + (t.h - hl.from.h) * e,
      };
    }
    const s = ui.hl.style;
    s.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
    s.width = `${r.w}px`;
    s.height = `${r.h}px`;
    ui.hl.classList.toggle("below", r.y < 26 && r.h < innerHeight - 60);
    ui.hl.classList.toggle("inside", r.y < 26 && r.h >= innerHeight - 60);
    hl.shown = r;
    hl.raf = requestAnimationFrame(hlTick);
  }

  function highlightShow(el, label) {
    ensureHost();
    clearTimeout(teardownTimer);
    clearTimeout(hl.fadeTimer);
    const visible = ui.hl.classList.contains("on");
    hl.from = visible && hl.shown ? hl.shown : null;
    hl.moveStart = performance.now();
    hl.el = el;
    ui.hlText.textContent = pick(label);
    ui.hl.classList.remove("out");
    ui.hl.classList.add("on");
    if (!hl.raf) hlTick();
    return true;
  }

  function highlightDone(delay = 1200) {
    clearTimeout(hl.fadeTimer);
    hl.fadeTimer = setTimeout(() => {
      if (!ui.host) return;
      ui.hl.classList.add("out");
      ui.hl.classList.remove("on");
      hl.fadeTimer = setTimeout(() => {
        hl.el = null;
        hl.shown = null;
        if (hl.raf) cancelAnimationFrame(hl.raf);
        hl.raf = 0;
        scheduleTeardown();
      }, 460);
    }, delay);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Agent cursor. The service worker computes the path (it also replays it as
  // real CDP mouse moves); here we only draw it.
  // ---------------------------------------------------------------------------
  const cursor = { x: 0, y: 0, drawn: null, visible: false, anim: 0, parkTimer: null };
  const CURSOR_PARK_MS = 3000;

  function cursorDraw(x, y) {
    cursor.x = x;
    cursor.y = y;
    ui.cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    cursor.drawn = { x, y };
  }

  function cursorWake(x, y) {
    ensureHost();
    clearTimeout(teardownTimer);
    clearTimeout(cursor.parkTimer);
    if (!cursor.drawn || !cursor.visible) cursorDraw(x, y);
    ui.cursor.classList.remove("parked");
    ui.cursor.classList.add("on");
    cursor.visible = true;
  }

  function cursorParkLater() {
    clearTimeout(cursor.parkTimer);
    cursor.parkTimer = setTimeout(() => {
      if (!ui.host || cursor.anim) return;
      ui.cursor.classList.add("parked");
      ui.cursor.classList.remove("on", "typing");
      cursor.visible = false;
      scheduleTeardown();
    }, CURSOR_PARK_MS);
  }

  // points: [[x, y], ...] sampled every `step` ms along the eased path.
  function cursorGlide(points, step) {
    if (!points.length) return true;
    const [sx, sy] = points[0];
    cursorWake(sx, sy);
    if (cursor.anim) cancelAnimationFrame(cursor.anim);
    const start = performance.now();
    const total = (points.length - 1) * step;
    const tick = () => {
      const t = Math.min(total, performance.now() - start);
      const f = step ? t / step : 0;
      const i = Math.min(points.length - 1, Math.floor(f));
      const j = Math.min(points.length - 1, i + 1);
      const k = f - i;
      cursorDraw(points[i][0] + (points[j][0] - points[i][0]) * k, points[i][1] + (points[j][1] - points[i][1]) * k);
      if (t < total) cursor.anim = requestAnimationFrame(tick);
      else {
        cursor.anim = 0;
        cursorParkLater();
      }
    };
    cursor.anim = requestAnimationFrame(tick);
    return true;
  }

  // prefers-reduced-motion: no glide, a short fade out and in at the target.
  async function cursorJump(x, y) {
    if (cursor.visible && cursor.drawn) {
      ui.cursor.classList.remove("on");
      await sleep(90);
    } else ensureHost();
    cursorDraw(x, y);
    cursorWake(x, y);
    cursorParkLater();
    return true;
  }

  function cursorPress(x, y) {
    if (!ui.host || !cursor.drawn) cursorWake(x, y);
    cursorDraw(x, y);
    ui.cursor.classList.remove("press");
    void ui.cursor.offsetWidth; // restart the animation
    ui.cursor.classList.add("press");
    const ripple = document.createElement("div");
    ripple.className = "ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ui.root.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
    cursorParkLater();
    return true;
  }

  function cursorTyping(on) {
    if (!ui.host) return true;
    ui.cursor.classList.toggle("typing", !!on);
    cursorParkLater();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Element refs (from browser_snapshot) and target resolution
  // ---------------------------------------------------------------------------
  const refs = new Map(); // "e12" -> WeakRef(element)
  const refOf = new WeakMap(); // element -> "e12"
  let refSeq = 0;
  let refsUrl = "";
  const pageKey = () => location.origin + location.pathname + location.search;

  function refFor(el) {
    let id = refOf.get(el);
    if (!id) {
      id = `e${++refSeq}`;
      refOf.set(el, id);
      refs.set(id, new WeakRef(el));
    }
    return id;
  }

  function resolve(t) {
    if (t && t.ref) {
      if (refsUrl && refsUrl !== pageKey()) {
        refs.clear();
        refsUrl = "";
      }
      const el = refs.get(t.ref)?.deref();
      if (!el || !el.isConnected) {
        throw new Error(`Ref ${t.ref} is stale or unknown (the page navigated or re-rendered). Call browser_snapshot again.`);
      }
      return el;
    }
    if (t && t.selector) {
      let el;
      try {
        el = document.querySelector(t.selector);
      } catch {
        throw new Error(`Invalid CSS selector: ${t.selector}`);
      }
      if (!el) throw new Error(`No element matches ${t.selector}`);
      return el;
    }
    throw new Error("Pass a selector or a ref.");
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return undefined;
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const tid = el.getAttribute("data-testid");
    if (tid) s += `[data-testid="${tid}"]`;
    else if (typeof el.className === "string" && el.className.trim()) s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    return s;
  }

  // Deepest element at a point, through open shadow roots.
  function hitAt(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  function composedContains(outer, inner) {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  function fullyInView(r) {
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  }

  function viewport() {
    return {
      vw: innerWidth,
      vh: innerHeight,
      dpr: devicePixelRatio,
      reduced: reducedMotion(),
      hidden: document.visibilityState === "hidden",
    };
  }

  // Scrolls the element into view, highlights it and returns the point to
  // press (its centre, clamped to the viewport) in CSS pixels.
  async function prepare(t, opts = {}) {
    const el = resolve(t);
    if (opts.scroll !== false && !fullyInView(el.getBoundingClientRect())) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await frame();
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) throw new Error(`The element ${describe(el)} has no size (hidden or not rendered).`);
    const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1));
    const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
    const hit = hitAt(x, y);
    const covered = hit && !composedContains(el, hit) && !composedContains(hit, el) ? describe(hit) : undefined;
    if (opts.highlight !== false) highlightShow(el, opts.label);
    return { x, y, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, element: describe(el), covered, ...viewport() };
  }

  // ---- Typing helpers -------------------------------------------------------
  const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|)$/i;

  function editableIn(el) {
    if (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_INPUTS.test(el.type))) return el;
    return el.querySelector('[contenteditable=""], [contenteditable="true"], textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=password], input[type=number]') || el;
  }

  // Focuses the field and puts the caret at the end (or selects everything
  // when clearing, so the next Backspace deletes it as a real keystroke).
  async function focusField(t, { clear } = {}) {
    const el = editableIn(resolve(t));
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!clear) range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else if ("value" in el) {
      try {
        if (clear) el.select();
        else el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        /* type=email/number: no selection API */
        if (clear) el.select?.();
      }
    }
    await frame();
    return { focused: document.activeElement === el || el.contains(document.activeElement), hasContent: fieldValue(el).length > 0 };
  }

  function fieldValue(el) {
    if (!el) return "";
    if (el.isContentEditable) return el.innerText.replace(/\n$/, "");
    if ("value" in el && typeof el.value === "string") return el.type === "password" ? "•".repeat(el.value.length) : el.value;
    return "";
  }

  function activeValue(t) {
    let el = document.activeElement;
    if (t && (t.selector || t.ref)) {
      try {
        el = editableIn(resolve(t));
      } catch {
        /* fall back to the focused element */
      }
    }
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    const v = fieldValue(el);
    return { element: describe(el), value: v.length > 300 ? v.slice(0, 300) + "…" : v };
  }

  async function focusOnly(t) {
    const el = resolve(t);
    el.focus({ preventScroll: true });
    await frame();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Snapshot: interactive elements and headings, each with a ref.
  // ---------------------------------------------------------------------------
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "textbox", "searchbox", "combobox", "listbox", "slider",
    "spinbutton", "treeitem", "gridcell", "heading", "dialog", "alertdialog",
  ]);

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").split(/\s+/)[0];
    if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
    const tag = el.tagName;
    switch (tag) {
      case "A":
        return el.hasAttribute("href") ? "link" : null;
      case "BUTTON":
      case "SUMMARY":
        return "button";
      case "SELECT":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "TEXTAREA":
        return "textbox";
      case "DIALOG":
        return el.open ? "dialog" : null;
      case "INPUT": {
        const type = (el.type || "text").toLowerCase();
        if (type === "hidden") return null;
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox" || type === "radio") return type;
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        if (type === "file") return "button";
        return "textbox";
      }
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
    }
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return "textbox";
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0) return "focusable";
    return null;
  }

  const squash = (s, n = 80) => {
    const v = String(s || "").replace(/\s+/g, " ").trim();
    return v.length > n ? v.slice(0, n - 1) + "…" : v;
  };

  function nameOf(el, role) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return squash(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => el.getRootNode().getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || "").join(" ");
      if (t.trim()) return squash(t);
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map((l) => l.innerText).join(" ");
      if (t.trim()) return squash(t);
    }
    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton") {
      const ph = el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder");
      if (ph) return squash(ph);
      return squash(el.getAttribute("title") || el.getAttribute("name") || "");
    }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return squash(el.value || el.type);
    if (el.tagName === "INPUT" && el.type === "image") return squash(el.alt || el.title);
    const text = el.innerText;
    if (text && text.trim()) return squash(text);
    const img = el.querySelector("img[alt], svg[aria-label], [aria-label]");
    if (img) return squash(img.getAttribute("alt") || img.getAttribute("aria-label"));
    return squash(el.getAttribute("title") || "");
  }

  function stateOf(el, role) {
    const out = [];
    if (role === "heading") {
      const lvl = el.getAttribute("aria-level") || (/^H(\d)$/.exec(el.tagName) || [])[1];
      if (lvl) out.push(`level=${lvl}`);
    }
    const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    if (role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "combobox" || role === "slider") {
      let v = "";
      if (el.tagName === "SELECT") v = Array.from(el.selectedOptions).map((o) => o.text).join(", ");
      else if (isInput) v = el.type === "password" ? "•".repeat(el.value.length) : el.value;
      else if (el.isContentEditable) v = el.innerText;
      if (v) out.push(`value=${JSON.stringify(squash(v, 120))}`);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    const checked = el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio") ? el.checked : el.getAttribute("aria-checked");
    if (checked === true || checked === "true") out.push("checked");
    else if (checked === "mixed") out.push("mixed");
    const exp = el.getAttribute("aria-expanded");
    if (exp) out.push(exp === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true") out.push("selected");
    if (el.getAttribute("aria-pressed") === "true") out.push("pressed");
    if (el.required || el.getAttribute("aria-required") === "true") out.push("required");
    if (el.readOnly && isInput) out.push("readonly");
    if (el.tagName === "INPUT" && !["text", "search", "submit", "button", "checkbox", "radio"].includes(el.type)) out.push(`type=${el.type}`);
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (active === el) out.push("focused");
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) out.push(`href=${JSON.stringify(squash(href, 100))}`);
    }
    return out;
  }

  function isRendered(el) {
    if (el.checkVisibility) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function snapshot({ selector, maxNodes = 400, maxLength = 20000 } = {}) {
    let root = document.body || document.documentElement;
    if (selector) {
      try {
        root = document.querySelector(selector);
      } catch {
        throw new Error(`Invalid CSS selector: ${selector}`);
      }
      if (!root) throw new Error(`No element matches ${selector}`);
    }
    refsUrl = pageKey();
    const lines = [];
    let length = 0;
    let count = 0;
    let truncated = false;
    let skippedOffscreen = 0;

    const visit = (node, depth) => {
      if (truncated) return;
      for (let el = node.firstElementChild; el; el = el.nextElementSibling) {
        if (truncated) return;
        if (el.id === HOST_ID) continue;
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "SVG" || tag === "svg") continue;
        if (el.getAttribute("aria-hidden") === "true" || el.inert) continue;
        // display: none prunes the whole subtree.
        if (el.checkVisibility && !el.checkVisibility() && getComputedStyle(el).display !== "contents") continue;
        const role = roleOf(el);
        let nextDepth = depth;
        if (role && INTERACTIVE_ROLES.has(role) || role === "focusable") {
          if (isRendered(el)) {
            const r = el.getBoundingClientRect();
            const off = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
            const name = nameOf(el, role);
            const parts = [`[${refFor(el)}]`, role === "focusable" ? el.tagName.toLowerCase() : role];
            if (name) parts.push(JSON.stringify(name));
            parts.push(...stateOf(el, role));
            if (off) {
              parts.push("offscreen");
              skippedOffscreen++;
            }
            const line = "  ".repeat(depth) + "- " + parts.join(" ");
            if (count >= maxNodes || length + line.length + 1 > maxLength) {
              truncated = true;
              return;
            }
            lines.push(line);
            length += line.length + 1;
            count++;
            if (role === "dialog" || role === "alertdialog" || role === "listbox" || role === "combobox") nextDepth = depth + 1;
          } else if (role === "dialog" || role === "alertdialog") continue;
        }
        if (el.shadowRoot) visit(el.shadowRoot, nextDepth);
        visit(el, nextDepth);
      }
    };
    if (isRendered(root) || root === document.body) {
      const role = roleOf(root);
      if (selector && role && (INTERACTIVE_ROLES.has(role) || role === "focusable")) {
        lines.push(`- [${refFor(root)}] ${role} ${JSON.stringify(nameOf(root, role))} ${stateOf(root, role).join(" ")}`.trimEnd());
        count++;
      }
      visit(root, 0);
    }
    return { url: location.href, title: document.title, count, truncated, offscreen: skippedOffscreen, text: lines.join("\n") };
  }

  // ---------------------------------------------------------------------------
  // Scroll
  // ---------------------------------------------------------------------------
  async function scroll({ target, dx = 0, dy = 0, to, within, waitMs = 600, label }) {
    let box = null;
    if (within) {
      try {
        box = document.querySelector(within);
      } catch {
        throw new Error(`Invalid CSS selector: ${within}`);
      }
      if (!box) throw new Error(`No element matches ${within}`);
    }
    const se = document.scrollingElement || document.documentElement;
    const read = () =>
      box
        ? { x: box.scrollLeft, y: box.scrollTop, height: box.scrollHeight, client: box.clientHeight }
        : { x: scrollX, y: scrollY, height: Math.max(se.scrollHeight, document.body?.scrollHeight || 0), client: innerHeight };
    const before = read();
    let element;
    if (target) {
      const el = resolve(target);
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      highlightShow(el, label);
      element = describe(el);
    } else if (to === "top") {
      (box || window).scrollTo({ top: 0, behavior: "instant" });
    } else if (to === "bottom") {
      (box || window).scrollTo({ top: (box || se).scrollHeight, behavior: "instant" });
    } else {
      (box || window).scrollBy({ left: dx, top: dy, behavior: "instant" });
    }
    await frame();
    // Infinite feeds load the next page a moment after the scroll.
    const deadline = performance.now() + Math.max(0, Math.min(waitMs, 5000));
    let after = read();
    while (after.height === before.height && performance.now() < deadline) {
      await sleep(50);
      after = read();
    }
    return {
      element,
      scrollX: after.x,
      scrollY: after.y,
      scrolledBy: { x: after.x - before.x, y: after.y - before.y },
      scrollHeightBefore: before.height,
      scrollHeightAfter: after.height,
      newContent: after.height > before.height,
      atTop: after.y <= 0,
      atBottom: after.y + after.client >= after.height - 2,
    };
  }

  // ---------------------------------------------------------------------------
  // wait_for checks (polled by the service worker)
  // ---------------------------------------------------------------------------
  function findTextElement(text) {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue && n.nodeValue.includes(text) && n.parentElement && isRendered(n.parentElement)) return n.parentElement;
    }
    return null;
  }

  function waitCheck({ target, state = "visible", text, label }) {
    const res = { readyState: document.readyState, resources: performance.getEntriesByType("resource").length };
    if (target) {
      let el = null;
      try {
        el = resolve(target);
      } catch (err) {
        if (target.ref && state !== "detached" && state !== "hidden") throw err;
      }
      const visible = !!el && isRendered(el);
      const ok =
        state === "attached" ? !!el : state === "detached" ? !el : state === "hidden" ? !visible : visible;
      if (!ok) return { ...res, matched: false };
      if (el && visible && label) highlightShow(el, label);
      res.element = describe(el);
    }
    if (text) {
      const body = document.body ? document.body.innerText : "";
      if (!body.includes(text)) return { ...res, matched: false };
      const el = findTextElement(text);
      if (el && label) highlightShow(el, label);
      res.textElement = describe(el);
    }
    return { ...res, matched: true };
  }

  // ---------------------------------------------------------------------------
  // Screenshot target: element rect in page (document) coordinates.
  // ---------------------------------------------------------------------------
  async function captureRect(target, label) {
    const el = resolve(target);
    const r0 = el.getBoundingClientRect();
    if (!fullyInView(r0)) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await frame();
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) throw new Error(`The element ${describe(el)} has no size (hidden or not rendered).`);
    if (label) highlightShow(el, label);
    return {
      element: describe(el),
      page: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
      viewport: { x: r.left, y: r.top, width: r.width, height: r.height },
      dpr: devicePixelRatio,
    };
  }

  // ---------------------------------------------------------------------------
  // fetch() with the page's origin and cookies (content-script fetches are
  // same-origin with the page and follow its CORS rules).
  // ---------------------------------------------------------------------------
  async function pageFetch({ url, method = "GET", headers, body, responseType = "auto", maxLength = 20000 }) {
    const abs = new URL(url, location.href);
    const crossOrigin = abs.origin !== location.origin;
    let res;
    try {
      res = await fetch(abs.href, { method, headers: headers || undefined, body: body ?? undefined, credentials: "same-origin" });
    } catch (err) {
      throw new Error(
        `fetch ${abs.href} failed: ${err.message}` +
          (crossOrigin ? ` (cross-origin from ${location.origin}: the server's CORS headers don't allow it, or the page's CSP blocks it)` : ""),
        { cause: err }
      );
    }
    const resHeaders = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const raw = method === "HEAD" ? "" : await res.text();
    const type = res.headers.get("content-type") || "";
    let bodyOut = raw;
    let bodyType = "text";
    const truncated = raw.length > maxLength;
    if (!truncated && (responseType === "json" || (responseType === "auto" && /[/+]json\b/i.test(type)))) {
      try {
        bodyOut = JSON.parse(raw);
        bodyType = "json";
      } catch {
        /* not JSON after all: return the text */
      }
    }
    if (bodyType === "text" && truncated) bodyOut = raw.slice(0, maxLength);
    return {
      url: res.url || abs.href,
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      redirected: res.redirected,
      crossOrigin,
      headers: resHeaders,
      bodyType,
      truncated,
      length: raw.length,
      body: bodyOut,
    };
  }

  // Legacy synthetic click (browser_click with trusted: false).
  function syntheticClick(target, label) {
    const el = resolve(target);
    el.scrollIntoView({ block: "center", inline: "center" });
    if (label) highlightShow(el, label);
    el.click();
    return { clicked: true, trusted: false, element: describe(el) };
  }

  // Legacy fill (browser_fill), unchanged semantics.
  function fill(target, value, label) {
    const el = resolve(target);
    if (label) highlightShow(el, label);
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true };
  }

  // Marks an element so the DevTools protocol can find it (DOM.setFileInputFiles).
  function markTarget(target, token, label) {
    const el = resolve(target);
    if (label) highlightShow(el, label);
    el.setAttribute("data-webmcp-target", token);
    setTimeout(() => el.removeAttribute("data-webmcp-target"), 5000);
    return describe(el);
  }

  function unmark(token) {
    document.querySelector(`[data-webmcp-target="${token}"]`)?.removeAttribute("data-webmcp-target");
    return true;
  }

  const api = {
    glowShow, glowHide, setHidden, highlightDone, viewport, prepare,
    cursorGlide, cursorJump, cursorPress, cursorTyping,
    focusField, focusOnly, activeValue, snapshot, scroll, waitCheck, captureRect,
    pageFetch, syntheticClick, fill, markTarget, unmark,
  };

  globalThis.__nsPage = {
    version: VERSION,
    async call(name, args) {
      try {
        const fn = api[name];
        if (!fn) throw new Error(`page helper has no "${name}"`);
        const out = await fn(...(args || []));
        return out === undefined ? null : out;
      } catch (err) {
        return { __nsError: err?.message || String(err) };
      }
    },
  };
})();
