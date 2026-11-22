// Page 1: "Set the weather". A 2-axis pad (cloud x wind) with a live preview.
import { PRESETS, REGIONAL_FACTORS, api, bodyFromReq, paramsFromReq, reqFromParams, clearSkyIndex, fleetLoadFactor, meanWindSpeed, powerCurve, esc } from "./common.js";
import { drawTurbine, proj } from "./render.js";

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const req = reqFromParams(location.search);
const sunCache = {};
let dragging = false;

// ------------------------------------------------------------------ background map
async function drawBackground() {
  const c = $("bgmap"), dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; c.style.width = innerWidth + "px"; c.style.height = innerHeight + "px";
  const g = c.getContext("2d");
  g.fillStyle = "#0b1020"; g.fillRect(0, 0, c.width, c.height);
  try {
    const S = window.__static || (window.__static = await api("api/static"));
    const [x0, y0] = proj(-9, 61), [x1, y1] = proj(2.5, 49.8);
    const s = Math.min(innerWidth / (x1 - x0), innerHeight / (y1 - y0)) * 0.95;
    const ox = (innerWidth - (x1 - x0) * s) / 2 - x0 * s, oy = (innerHeight - (y1 - y0) * s) / 2 - y0 * s;
    g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const path = new Path2D();
    const add = (geom) => {
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
      for (const poly of polys) for (const ring of poly) { ring.forEach(([lo, la], i) => { const [x, y] = proj(lo, la); i ? path.lineTo(x, y) : path.moveTo(x, y); }); path.closePath(); }
    };
    S.land.features.forEach((f) => add(f.geometry));
    g.fillStyle = "rgba(20,27,47,0.55)"; g.fill(path);
    g.strokeStyle = "rgba(63,169,255,0.12)"; g.lineWidth = 2 / s; g.stroke(path);
    g.strokeStyle = "rgba(43,108,255,0.22)"; g.lineWidth = 1.5 / s; g.setLineDash([6 / s, 6 / s]);
    S.boundaries.features.filter((f) => f.properties.configured && f.properties.core).forEach((f) => {
      const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
      g.beginPath(); lines.forEach((l) => l.forEach(([lo, la], i) => { const [x, y] = proj(lo, la); i ? g.lineTo(x, y) : g.moveTo(x, y); })); g.stroke();
    });
  } catch (e) { /* the page works without the background */ }
}

// ------------------------------------------------------------------ pad preview
const pad = $("pad"), pg = pad.getContext("2d");
let W = 520, H = 520;
function sizePad() {
  const dpr = window.devicePixelRatio || 1, r = pad.getBoundingClientRect();
  W = r.width; H = r.height; pad.width = W * dpr; pad.height = H * dpr; pg.setTransform(dpr, 0, 0, dpr, 0, 0);
}
let seed = 3;
const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const clouds = Array.from({ length: 9 }, () => ({ x: rnd(), y: 0.08 + rnd() * 0.45, s: 0.6 + rnd() * 0.9 }));
const streaks = Array.from({ length: 46 }, () => ({ x: rnd(), y: 0.05 + rnd() * 0.68, l: 0.5 + rnd() }));
const rotors = [0, 1.1, 2.3];
const cloudOf = () => req.cloud;

function cloudBlob(x, y, s, alpha) {
  pg.fillStyle = `rgba(225,230,240,${alpha})`;
  [[0, 0, 34], [30, 6, 26], [-30, 8, 24], [12, -16, 24], [-12, -12, 20]].forEach(([dx, dy, r]) => {
    pg.beginPath(); pg.arc(x + dx * s, y + dy * s, r * s, 0, TAU); pg.fill();
  });
}

let last = performance.now();
function drawPad(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const cloud = cloudOf(), wind = req.wind, v = meanWindSpeed(wind);
  // sky
  const sky = pg.createLinearGradient(0, 0, 0, H);
  const mix = (a, b) => a.map((x, i) => Math.round(x + (b[i] - x) * cloud));
  const top = mix([24, 78, 160], [52, 58, 74]), bot = mix([92, 150, 220], [86, 92, 106]);
  sky.addColorStop(0, `rgb(${top})`); sky.addColorStop(1, `rgb(${bot})`);
  pg.fillStyle = sky; pg.fillRect(0, 0, W, H);
  // sun, brightness = 1 - cloud
  const sx = W * 0.8, sy = H * 0.2, sun = 1 - cloud;
  const sg = pg.createRadialGradient(sx, sy, 0, sx, sy, W * 0.3);
  sg.addColorStop(0, `rgba(255,236,160,${0.95 * sun})`); sg.addColorStop(0.15, `rgba(255,216,77,${0.7 * sun})`); sg.addColorStop(1, "rgba(255,216,77,0)");
  pg.fillStyle = sg; pg.beginPath(); pg.arc(sx, sy, W * 0.3, 0, TAU); pg.fill();
  pg.fillStyle = `rgba(255,248,220,${0.4 + 0.6 * sun})`; pg.beginPath(); pg.arc(sx, sy, W * 0.045, 0, TAU); pg.fill();
  // wind streaks, speed ∝ wind
  pg.strokeStyle = "#ffffff"; pg.lineCap = "round"; pg.lineWidth = 1.4;
  for (const s of streaks) {
    s.x += dt * (0.02 + 0.9 * wind) * s.l;
    if (s.x > 1.1) { s.x = -0.1; s.y = 0.05 + Math.random() * 0.68; }
    pg.globalAlpha = 0.05 + 0.45 * wind;
    const len = (0.01 + 0.09 * wind) * s.l * W;
    pg.beginPath(); pg.moveTo(s.x * W, s.y * H); pg.lineTo(s.x * W - len, s.y * H + len * 0.05); pg.stroke();
  }
  pg.globalAlpha = 1;
  // clouds: opacity = cloud cover, drift ∝ wind
  for (const c of clouds) {
    c.x += dt * (0.005 + 0.12 * wind) / c.s;
    if (c.x > 1.25) c.x = -0.25;
    cloudBlob(c.x * W, c.y * H, c.s * W / 520, 0.92 * cloud);
  }
  if (cloud > 0.5) { pg.fillStyle = `rgba(70,76,92,${(cloud - 0.5) * 0.7})`; pg.fillRect(0, 0, W, H); }
  // hills
  pg.fillStyle = "#162036";
  pg.beginPath(); pg.moveTo(0, H); pg.lineTo(0, H * 0.82);
  pg.bezierCurveTo(W * 0.25, H * 0.74, W * 0.45, H * 0.86, W * 0.65, H * 0.79); pg.bezierCurveTo(W * 0.82, H * 0.74, W * 0.92, H * 0.8, W, H * 0.78);
  pg.lineTo(W, H); pg.fill();
  // three turbines, rotor speed from the actual power curve (offshore, Scottish, English wind speeds)
  const spots = [[0.22, 0.79, 1.0], [0.5, 0.81, 0.9], [0.78, 0.77, 0.95]];
  pg.font = "11px 'Segoe UI', sans-serif"; pg.textAlign = "center";
  REGIONAL_FACTORS.forEach(([label, f], i) => {
    const cf = powerCurve(v * f);
    rotors[i] += dt * TAU * 1.2 * cf;
    const [px, py, sc] = spots[i], size = W * 0.075 * sc;
    drawTurbine(pg, px * W, py * H - size * 0.55, size, rotors[i], "#eef6ff", 1);
    pg.fillStyle = "rgba(255,255,255,0.6)";
    pg.fillText(`${label} ${(v * f).toFixed(0)} m/s`, px * W, py * H + 22);
    if (v * f > 25) { pg.fillStyle = "#ff2d55"; pg.fillText("storm cut-out", px * W, py * H + 36); }
  });
  // grid and handle
  pg.strokeStyle = "rgba(255,255,255,0.08)"; pg.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    pg.beginPath(); pg.moveTo(W * k / 4, 0); pg.lineTo(W * k / 4, H); pg.moveTo(0, H * k / 4); pg.lineTo(W, H * k / 4); pg.stroke();
  }
  const hx = Math.min(W - 16, Math.max(16, (1 - cloud) * W)), hy = Math.min(H - 16, Math.max(16, (1 - wind) * H));
  pg.strokeStyle = "rgba(255,255,255,0.35)"; pg.setLineDash([4, 4]);
  pg.beginPath(); pg.moveTo(hx, 0); pg.lineTo(hx, H); pg.moveTo(0, hy); pg.lineTo(W, hy); pg.stroke(); pg.setLineDash([]);
  pg.fillStyle = "rgba(11,16,32,0.55)"; pg.strokeStyle = "#ffffff"; pg.lineWidth = 3;
  pg.beginPath(); pg.arc(hx, hy, dragging ? 17 : 14, 0, TAU); pg.fill(); pg.stroke();
  pg.fillStyle = "#ffb020"; pg.beginPath(); pg.arc(hx, hy, 4, 0, TAU); pg.fill();
  requestAnimationFrame(drawPad);
}

function setFromPointer(e) {
  const r = pad.getBoundingClientRect();
  req.cloud = Math.round(Math.min(1, Math.max(0, 1 - (e.clientX - r.left) / r.width)) * 100) / 100;
  req.wind = Math.round(Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) * 100) / 100;
  update();
}
pad.addEventListener("pointerdown", (e) => { dragging = true; pad.setPointerCapture(e.pointerId); setFromPointer(e); });
pad.addEventListener("pointermove", (e) => { if (dragging) setFromPointer(e); });
pad.addEventListener("pointerup", () => (dragging = false));
pad.addEventListener("keydown", (e) => {
  const d = e.shiftKey ? 0.1 : 0.02, k = e.key;
  if (k === "ArrowUp") req.wind = Math.min(1, req.wind + d);
  else if (k === "ArrowDown") req.wind = Math.max(0, req.wind - d);
  else if (k === "ArrowLeft") req.cloud = Math.min(1, req.cloud + d);
  else if (k === "ArrowRight") req.cloud = Math.max(0, req.cloud - d);
  else if (k === "Enter") { simulate(); return; }
  else return;
  e.preventDefault(); req.wind = Math.round(req.wind * 100) / 100; req.cloud = Math.round(req.cloud * 100) / 100; update();
});

// ------------------------------------------------------------------ readouts & controls
async function sunTimes(season) {
  if (!sunCache[season]) {
    try { sunCache[season] = await api(`api/weather_preview?wind=0.5&cloud=0.5&season=${season}`); } catch (e) { sunCache[season] = {}; }
  }
  return sunCache[season];
}

async function update() {
  const v = meanWindSpeed(req.wind), lf = fleetLoadFactor(req.wind), k = clearSkyIndex(req.cloud);
  const sun = await sunTimes(req.season);
  $("readouts").innerHTML = `
    <div><span>Mean wind speed at hub height</span><b>${v.toFixed(0)} m/s</b></div>
    <div><span>Fleet wind load factor</span><b>${Math.round(lf * 100)}%</b></div>
    <div><span>Cloud cover</span><b>${Math.round(req.cloud * 100)}%</b></div>
    <div><span>Solar clear-sky index</span><b>${k.toFixed(2)}</b></div>
    <div><span>Sunrise · sunset</span><b>${esc(sun.sunrise || "–")} · ${esc(sun.sunset || "–")}</b></div>`;
  document.querySelectorAll(".season button").forEach((b) => b.classList.toggle("on", b.dataset.season === req.season));
  $("seasonNote").textContent = req.season === "winter"
    ? "15 January: short days, high demand with a 17:00 peak, full winter boundary capability."
    : `15 July: long days, lower and flatter demand, boundary capability derated to ${Math.round(req.summer_derate * 100)}% (assumption).`;
  document.querySelectorAll("#presets button").forEach((b) => {
    const p = PRESETS.find((x) => x.id === b.dataset.id);
    b.classList.toggle("on", Math.abs(p.wind - req.wind) < 0.005 && Math.abs(p.cloud - req.cloud) < 0.005 && p.season === req.season);
  });
  $("derateVal").textContent = req.summer_derate.toFixed(2);
  $("socVal").textContent = `${Math.round(req.start_soc * 100)}%`;
  try { history.replaceState(null, "", "?" + paramsFromReq(req)); } catch (e) { /* ignore */ }
}

function bindControls() {
  document.querySelectorAll(".season button").forEach((b) => b.addEventListener("click", () => { req.season = b.dataset.season; update(); }));
  $("presets").innerHTML = PRESETS.map((p) => `<button class="btn" data-id="${p.id}" title="${esc(p.note)}">${esc(p.label)}</button>`).join("");
  $("presets").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const p = PRESETS.find((x) => x.id === b.dataset.id);
    req.wind = p.wind; req.cloud = p.cloud; req.season = p.season; update();
  }));
  $("seed").value = req.seed; $("seed").addEventListener("change", (e) => { req.seed = Math.max(0, Math.trunc(+e.target.value || 0)); update(); });
  $("front").checked = req.front; $("front").addEventListener("change", (e) => { req.front = e.target.checked; update(); });
  $("derate").value = req.summer_derate; $("derate").addEventListener("input", (e) => { req.summer_derate = +e.target.value; update(); });
  $("soc").value = req.start_soc; $("soc").addEventListener("input", (e) => { req.start_soc = +e.target.value; update(); });
  if (req.front || req.seed || req.summer_derate !== 0.9 || req.start_soc !== 0.5) document.querySelector("details.adv").open = true;
  $("go").addEventListener("click", simulate);
  $("overlayClose").addEventListener("click", () => { $("overlay").classList.add("hidden"); spinning = false; });
}

// ------------------------------------------------------------------ simulate
let spinning = false;
function spin() {
  const c = $("spinCanvas"), dpr = window.devicePixelRatio || 1;
  c.width = 260 * dpr; c.height = 140 * dpr;
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t0 = performance.now(), angles = [0, 0.7, 1.9];
  let prev = t0;
  const frame = (now) => {
    if (!spinning) return;
    const dt = (now - prev) / 1000; prev = now;
    const omega = TAU * Math.min(1.4, (now - t0) / 1400);          // turbines spin up
    g.clearRect(0, 0, 260, 140);
    [[50, 0.9], [130, 1.15], [210, 0.9]].forEach(([x, s], i) => {
      angles[i] += dt * omega * (0.9 + 0.1 * i);
      drawTurbine(g, x, 82, 46 * s, angles[i], "#eef6ff", 1);
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function simulate() {
  $("overlay").classList.remove("hidden"); $("overlayClose").classList.add("hidden");
  $("overlayText").textContent = "Starting the turbines… solving 48 half-hours";
  spinning = true; spin();
  const started = performance.now();
  try {
    // Local tool: warms the server's cache so the map loads instantly. Static site: the map
    // page solves the day itself (a new page would have to start Python again anyway).
    if (!window.GBGFE_STATIC) await api("api/simulate", bodyFromReq(req));
    const wait = Math.max(0, 700 - (performance.now() - started));
    setTimeout(() => (location.href = "map.html?" + paramsFromReq(req)), wait);
  } catch (e) {
    $("overlayText").innerHTML = `The simulation failed: ${esc(e.message)}`;
    $("overlayClose").classList.remove("hidden"); spinning = false;
  }
}

// ------------------------------------------------------------------ init
bindControls();
sizePad();
new ResizeObserver(sizePad).observe(pad);
window.addEventListener("resize", drawBackground);
drawBackground();
update();
requestAnimationFrame(drawPad);
