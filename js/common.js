// Shared constants and helpers for both pages.

export const TECH = {
  wind_offshore: { name: "Offshore wind", color: "#4fd1ff", system: true },
  wind_onshore: { name: "Onshore wind", color: "#7ee8c7", system: true },
  solar: { name: "Solar farms", color: "#ffd84d", system: true },
  ccgt: { name: "CCGT (gas)", color: "#ff8a3d", system: true },
  ocgt: { name: "OCGT (gas peakers)", color: "#ff5a3d", system: true },
  biomass: { name: "Biomass", color: "#9be15d", system: true },
  nuclear: { name: "Nuclear", color: "#c18cff", system: true },
  pumped_storage: { name: "Pumped storage", color: "#3d7bff", system: true },
  battery: { name: "Batteries", color: "#2ee6a6", system: true },
  interconnector: { name: "Interconnectors", color: "#e6e6e6", system: true },
};

export const COUNTRY = { FR: "France", NL: "Netherlands", BE: "Belgium", NO: "Norway", DK: "Denmark",
  IE: "Ireland", NI: "Northern Ireland", DE: "Germany" };

export const PRESETS = [
  { id: "dunkelflaute", label: "Winter dunkelflaute", wind: 0.08, cloud: 1.0, season: "winter", note: "Calm and overcast" },
  { id: "stormy", label: "Stormy winter night", wind: 0.85, cloud: 1.0, season: "winter", note: "Gale and overcast" },
  { id: "heatwave", label: "Summer heatwave", wind: 0.10, cloud: 0.0, season: "summer", note: "Calm and clear" },
  { id: "breezy", label: "Breezy spring-like day", wind: 0.45, cloud: 0.5, season: "summer", note: "Moderate wind, broken cloud" },
  { id: "perfect", label: "Perfect storm", wind: 0.80, cloud: 0.0, season: "summer", note: "Sunny and windy" },
];

export const DEFAULT_REQ = {
  wind: 0.5, cloud: 0.5, season: "winter", seed: 0, front: false, summer_derate: 0.9, start_soc: 0.5,
  excluded_types: [], excluded_assets: [], lock_ic: false, enforce_optional: false,
};

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (v == null || v === "" || isNaN(+v) ? d : +v);

export function reqFromParams(search) {
  const q = new URLSearchParams(search);
  const list = (k) => (q.get(k) ? q.get(k).split(",").filter(Boolean) : []);
  return {
    wind: clamp(num(q.get("wind"), DEFAULT_REQ.wind), 0, 1),
    cloud: clamp(num(q.get("cloud"), DEFAULT_REQ.cloud), 0, 1),
    season: q.get("season") === "summer" ? "summer" : "winter",
    seed: Math.trunc(num(q.get("seed"), 0)),
    front: q.get("front") === "1",
    summer_derate: clamp(num(q.get("derate"), DEFAULT_REQ.summer_derate), 0.5, 1.2),
    start_soc: clamp(num(q.get("soc"), DEFAULT_REQ.start_soc), 0, 1),
    excluded_types: list("ex"),
    excluded_assets: list("exa"),
    lock_ic: q.get("lock") === "1",
    enforce_optional: q.get("opt") === "1",
  };
}

export function paramsFromReq(r) {
  const q = new URLSearchParams();
  q.set("wind", r2(r.wind)); q.set("cloud", r2(r.cloud)); q.set("season", r.season);
  if (r.seed) q.set("seed", r.seed);
  if (r.front) q.set("front", "1");
  if (Math.abs(r.summer_derate - DEFAULT_REQ.summer_derate) > 1e-6) q.set("derate", r2(r.summer_derate));
  if (Math.abs(r.start_soc - DEFAULT_REQ.start_soc) > 1e-6) q.set("soc", r2(r.start_soc));
  if (r.excluded_types.length) q.set("ex", [...r.excluded_types].sort().join(","));
  if (r.excluded_assets.length) q.set("exa", [...r.excluded_assets].sort().join(","));
  if (r.lock_ic) q.set("lock", "1");
  if (r.enforce_optional) q.set("opt", "1");
  return q.toString();
}

// Both pages build the request body the same way, so the server's result cache hits.
export function bodyFromReq(r) {
  return {
    wind: r2(r.wind), cloud: r2(r.cloud), season: r.season, seed: r.seed, front: r.front,
    excluded_types: [...r.excluded_types].sort(), excluded_assets: [...r.excluded_assets].sort(),
    lock_ic: r.lock_ic, summer_derate: r2(r.summer_derate), start_soc: r2(r.start_soc),
    enforce_optional: r.enforce_optional,
  };
}

export async function api(path, body) {
  if (window.GBGFE_STATIC) {                     // GitHub Pages build: no server, see deploy/static_api.js
    const { staticApi } = await import("./static_api.js");
    return staticApi(path, body);
  }
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (e) { /* keep statusText */ }
    throw new Error(msg);
  }
  return res.json();
}

// Same generic power curve as config/weather.yaml (cut-in 3.5, rated 12.5, cut-out 25 m/s).
export function powerCurve(v) {
  if (v < 3.5 || v > 25) return 0;
  return clamp((v ** 3 - 3.5 ** 3) / (12.5 ** 3 - 3.5 ** 3), 0, 1);
}
export const meanWindSpeed = (y) => 1 + 21 * clamp(y, 0, 1);
export const REGIONAL_FACTORS = [["Offshore", 1.15], ["Scotland", 1.10], ["England & Wales", 0.90]];
export function fleetLoadFactor(y) {
  const v = meanWindSpeed(y);
  return 0.95 * REGIONAL_FACTORS.reduce((s, [, f]) => s + powerCurve(v * f), 0) / REGIONAL_FACTORS.length;
}
export const clearSkyIndex = (cloud) => 1 - 0.75 * Math.pow(clamp(cloud, 0, 1), 3.4);

export const fmtGW = (mw, d = 1) => `${(mw / 1000).toFixed(d)} GW`;
export const fmtMW = (mw) => `${Math.round(mw).toLocaleString()} MW`;
export const fmtGBP = (v) => (Math.abs(v) >= 1e6 ? `£${(v / 1e6).toFixed(2)}m` : `£${Math.round(v / 1000).toLocaleString()}k`);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const hhmm = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
export const flagSrc = (code) => `img/flags/${String(code).toLowerCase()}.svg`;
export const flagImg = (code) => `<img class="flag" src="${flagSrc(code)}" alt="${esc(COUNTRY[code] || code)}">`;

// Per-viewer conveniences only; the page works without storage.
export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ } },
};

// Inline SVG icons (emoji such as the power symbol do not render reliably on Windows).
const svg = (body, vb = "0 0 24 24") => `<svg viewBox="${vb}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON = {
  eye: svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'),
  power: svg('<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><line x1="12" y1="2" x2="12" y2="12"/>'),
  target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.8" fill="currentColor"/>'),
  play: svg('<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>'),
  back: svg('<polygon points="17 5 8 12 17 19" fill="currentColor"/><line x1="6" y1="5" x2="6" y2="19"/>'),
  fwd: svg('<polygon points="7 5 16 12 7 19" fill="currentColor"/><line x1="18" y1="5" x2="18" y2="19"/>'),
  start: svg('<polygon points="19 5 10 12 19 19" fill="currentColor"/><polygon points="12 5 3 12 12 19" fill="currentColor"/>'),
  end: svg('<polygon points="5 5 14 12 5 19" fill="currentColor"/><polygon points="12 5 21 12 12 19" fill="currentColor"/>'),
  loop: svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  close: svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
};
