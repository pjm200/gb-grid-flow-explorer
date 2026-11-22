// Main map page: playback, panels, info cards, layer toggles, re-solves and missions.
import { TECH, COUNTRY, ICON, api, reqFromParams, paramsFromReq, bodyFromReq, fmtGW, fmtMW, fmtGBP, esc, hhmm, flagImg, store } from "./common.js";
import { MapRenderer, PALETTES, boundaryState } from "./render.js";
import { StackChart, sparkline, MIX_LAYERS, NEG_LAYERS } from "./charts.js";
import { Missions } from "./missions.js";

const $ = (id) => document.getElementById(id);
const T = 48;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const SYSTEM_LAYERS = Object.keys(TECH);
const VISUAL_LAYERS = [
  ["boundaries", "Boundaries", "#3fa9ff"], ["hvdc", "Internal HVDC links", "#c18cff"],
  ["haze", "Embedded solar (regional)", "rgba(255,216,77,0.55)", "Distribution-connected solar: a yellow haze per region (visible in daylight) plus small icons for farms of 10 MW or more. Display only; its output is already in the regional totals."],
  ["embWind", "Embedded wind (regional)", "#4fae96", "Distribution-connected wind farms of 10 MW or more as small icons. Display only; their output is already in the regional totals."],
  ["demand", "Demand by region", "#ffffff"], ["future", "Future links", "#7d89a8"],
];
const OVERLAYS = [["clouds", "Cloud overlay"], ["wind", "Wind streaks"], ["chevrons", "Flow chevrons"], ["tint", "Day / night tint"]];
const SHOW_DEFAULTS = Object.fromEntries([...SYSTEM_LAYERS.map((k) => [k, true]), ["boundaries", true], ["hvdc", true], ["haze", false], ["embWind", false],
  ["demand", false], ["future", false], ["clouds", true], ["wind", true], ["chevrons", true], ["tint", true], ["allBoundaries", false]]);

const st = {
  S: null, meta: null, req: null, sim: null, se: null, renderer: null, chart: null, missions: null,
  t: 34, playing: false, loop: true, speed: 1, lastP: -1, lastClock: "",
  show: { ...SHOW_DEFAULTS, ...store.get("gbgfe.show.v2", {}) },
  solo: null, palette: store.get("gbgfe.palette", "normal"), selected: null,
  history: [], cards: new Set(), playedPeriods: new Set(), boundaryInfo: {},
  busy: false, pending: false,
};
const cur = () => Math.floor(st.t) % T;

// ====================================================================== data
function buildSeries(sim) {
  const P = sim.periods, f32 = () => new Float32Array(T);
  const A = {}, B = {}, IC = {}, ICm = {}, R = {};
  for (const [id, a0] of Object.entries(P[0].assets)) A[id] = { p: f32(), act: f32(), soc: a0.soc != null ? f32() : null, avail: a0.avail != null ? f32() : null };
  for (const [b, v] of Object.entries(P[0].boundaries)) B[b] = { flow: f32(), unc: f32(), cap: f32(), bind: new Uint8Array(T), shadow: f32(), gen: f32(), demand: f32(), chg: f32(), imp: f32(), enforced: v.enforced };
  for (const id of Object.keys(P[0].ic)) { IC[id] = f32(); ICm[id] = f32(); }
  for (const id of Object.keys(P[0].regions)) R[id] = { solar: f32(), wind: f32(), demand: f32() };
  const tot = { mix: {}, demand: f32(), ch_ps: f32(), ch_bat: f32(), exports: f32(), curtailed: f32(), ccost: f32(), ci: f32(), supplied: f32(), soc: f32(), price: f32(), unserved: f32(), wind_lf: f32() };
  MIX_LAYERS.forEach(([k]) => (tot.mix[k] = f32()));
  P.forEach((p, t) => {
    for (const id in A) { const v = p.assets[id], a = A[id]; a.p[t] = v.p; a.act[t] = v.action; if (a.soc) a.soc[t] = v.soc; if (a.avail) a.avail[t] = v.avail; }
    for (const b in B) { const v = p.boundaries[b], o = B[b]; o.flow[t] = v.flow; o.unc[t] = v.flow_unconstrained; o.cap[t] = v.cap; o.bind[t] = v.binding ? 1 : 0; o.shadow[t] = v.shadow_price; o.gen[t] = v.gen; o.demand[t] = v.demand; o.chg[t] = v.storage_charging; o.imp[t] = v.imports; }
    for (const id in IC) { IC[id][t] = p.ic[id]; ICm[id][t] = p.ic_market[id]; }
    for (const id in R) { R[id].solar[t] = p.regions[id].emb_solar; R[id].wind[t] = p.regions[id].emb_wind; R[id].demand[t] = p.regions[id].demand; }
    const tt = p.totals;
    MIX_LAYERS.forEach(([k]) => (tot.mix[k][t] = tt.mix[k]));
    tot.demand[t] = tt.demand; tot.ch_ps[t] = tt.charging.pumped_storage; tot.ch_bat[t] = tt.charging.battery; tot.exports[t] = tt.exports;
    tot.curtailed[t] = tt.curtailed_wind + tt.curtailed_solar; tot.ccost[t] = tt.constraint_cost; tot.ci[t] = tt.carbon_intensity;
    tot.supplied[t] = Object.entries(tt.mix).reduce((s, [k, v]) => s + (k === "pumped_storage" || k === "battery" ? 0 : v), 0);
    tot.soc[t] = tt.soc_total; tot.price[t] = tt.market_price; tot.unserved[t] = tt.unserved; tot.wind_lf[t] = tt.wind_lf;
  });
  tot.maxWindLf = Math.max(0.05, ...tot.wind_lf);
  return { A, B, IC, ICm, R, tot };
}

function hvdcFlows(F) {
  const out = {};
  for (const h of st.hvdcList) {
    if (h.status !== "operational" || !h.follows) continue;
    const [kind, ref] = h.follows.split(":");
    if (kind === "asset") { const v = F.A[ref]; out[h.id] = v ? clamp(v.p, 0, h.capacity_mw) : 0; continue; }
    const b = F.B[ref], cfg = st.bcfg[ref];
    if (!b || !cfg) continue;
    const inj = (cfg.positive === "import" ? -1 : 1) * b.flow, dir = h.a_inside.includes(ref) ? 1 : -1;
    out[h.id] = clamp(dir * inj * h.capacity_mw / b.cap, -h.capacity_mw, h.capacity_mw);
  }
  return out;
}

// One frame's worth of tweened values for the renderer.
function frame(dt, time) {
  const F = { dt, time, show: st.show, solo: st.solo, palette: st.palette, selected: st.selected, cloud: st.req.cloud, windVis: st.req.wind };
  const se = st.se;
  if (!se) return F;
  const t = st.t, i0 = Math.floor(t) % T, i1 = st.loop ? (i0 + 1) % T : Math.min(i0 + 1, T - 1), f = t - Math.floor(t);
  const L = (a) => a[i0] + (a[i1] - a[i0]) * f;
  F.A = {};
  for (const id in se.A) { const a = se.A[id]; F.A[id] = { p: L(a.p), action: L(a.act), soc: a.soc ? L(a.soc) : null, ramp: a.p[i1] - a.p[i0] }; }
  F.B = {};
  for (const b in se.B) { const o = se.B[b]; F.B[b] = { flow: L(o.flow), unc: L(o.unc), cap: L(o.cap), binding: !!o.bind[f < 0.5 ? i0 : i1], enforced: o.enforced }; }
  F.IC = {};
  for (const id in se.IC) F.IC[id] = L(se.IC[id]);
  F.R = {};
  for (const id in se.R) F.R[id] = { solarCF: L(se.R[id].solar) / Math.max(1, st.embCap[id]), windCF: L(se.R[id].wind) / Math.max(1, st.embWindCap[id]), demand: L(se.R[id].demand) };
  F.HV = hvdcFlows(F);
  if (st.req.front) F.windVis = st.req.wind * (0.45 + 0.55 * L(se.tot.wind_lf) / se.tot.maxWindLf);
  const elev = st.sim.weather.elevation, hour = t * 0.5 + 0.25;
  F.sunElev = (lon) => {
    const x = (hour + (lon + 1.5) / 15 - 0.25) * 2, k = Math.floor(x), fr = x - k;
    const a = elev[((k % T) + T) % T], b = elev[(((k + 1) % T) + T) % T];
    return a + (b - a) * fr;
  };
  return F;
}

// ====================================================================== text helpers
function sideText(b) { return st.bcfg[b]?.inside_label === "North" ? `north of ${b}` : `inside ${b}`; }
function behindText(list) {
  const known = list.filter((b) => st.bcfg[b]);
  if (!known.length) return "Outside (south of / away from) every boundary shown";
  const north = known.filter((b) => st.bcfg[b].inside_label === "North"), local = known.filter((b) => !north.includes(b));
  const parts = [];
  if (north.length) parts.push(`North of ${north.join(", ")}`);
  local.forEach((b) => parts.push(`inside ${b} (${st.bcfg[b].inside_label})`));
  return parts.join("; ");
}
function dirWord(b, inj) {
  const cfg = st.bcfg[b];
  if (cfg.inside_label === "North") return inj >= 0 ? "southwards" : "northwards";
  return inj >= 0 ? `out of ${cfg.inside_label}` : `into ${cfg.inside_label}`;
}
const injOf = (b, flow) => (st.bcfg[b].positive === "import" ? -1 : 1) * flow;
const pct = (v) => `${Math.round(v * 100)}%`;

// ====================================================================== panels
function renderHeader() {
  const r = st.req, season = r.season === "winter" ? "❄ Winter" : "☀ Summer";
  const extras = [];
  if (r.front) extras.push("weather front");
  if (r.excluded_types.length) extras.push(`${r.excluded_types.length} type${r.excluded_types.length > 1 ? "s" : ""} removed`);
  if (r.excluded_assets.length) extras.push(`${r.excluded_assets.length} asset${r.excluded_assets.length > 1 ? "s" : ""} offline`);
  if (r.lock_ic) extras.push("interconnectors locked");
  $("wxSummary").innerHTML = `${season} · Wind ${Math.round(r.wind * 100)}% · Cloud ${Math.round(r.cloud * 100)}%` +
    (extras.length ? ` <span class="dim">· ${extras.join(" · ")}</span>` : "");
  $("weatherBtn").href = "index.html?" + paramsFromReq(r);
}

function buildBars() {
  const names = st.order.filter((b) => st.bcfg[b].core || st.show.allBoundaries);
  $("bars").innerHTML = names.map((b) => `<div class="bbar" data-b="${b}" tabindex="0">
      <div class="bbar-top"><span class="bname">${b}</span><span class="bval mono"></span></div>
      <div class="btrack"><div class="bghost"></div><div class="bfill"></div><div class="b100"></div></div></div>`).join("");
  $("bars").querySelectorAll(".bbar").forEach((el) => {
    el.addEventListener("click", () => select({ kind: "boundary", id: el.dataset.b }));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") select({ kind: "boundary", id: el.dataset.b }); });
  });
  renderBars();
}

function renderBars() {
  if (!st.se) return;
  const p = cur(), W = (v) => `${Math.min(100, v * 66)}%`;          // 100% capability sits at 66% of the track
  for (const el of $("bars").children) {
    const b = el.dataset.b, o = st.se.B[b];
    if (!o) continue;
    const flow = o.flow[p], unc = o.unc[p], cap = o.cap[p], u = Math.abs(flow) / cap, gu = Math.abs(unc) / cap;
    const key = boundaryState({ flow, cap, binding: o.bind[p] }).key, col = PALETTES[st.palette][key];
    el.querySelector(".bname").style.color = col;
    el.querySelector(".bname").textContent = b + (o.enforced ? "" : " ·");
    el.querySelector(".bval").innerHTML = `${(flow / 1000).toFixed(1)} / ${(cap / 1000).toFixed(1)} GW` + (o.bind[p] ? ` <span class="warn">⚠</span>` : "");
    const fill = el.querySelector(".bfill"); fill.style.width = W(u); fill.style.background = col;
    const ghost = el.querySelector(".bghost"); ghost.style.width = W(gu); ghost.style.display = gu > u + 0.01 ? "" : "none";
    el.title = `${b}: ${pct(u)} of capability${o.bind[p] ? `, market wanted ${pct(gu)}` : ""}${o.enforced ? "" : " (optional boundary, not enforced)"}`;
    el.classList.toggle("sel", st.selected?.kind === "boundary" && st.selected.id === b);
  }
}

function renderCounters() {
  if (!st.se) return;
  const p = cur(), tot = st.se.tot;
  let curt = 0, cc = 0, em = 0, sup = 0, uns = 0;
  for (let k = 0; k <= p; k++) { curt += tot.curtailed[k] * 0.5 / 1000; cc += tot.ccost[k]; em += tot.ci[k] * tot.supplied[k]; sup += tot.supplied[k]; uns += tot.unserved[k] * 0.5 / 1000; }
  const homes = Math.round(curt * 1e6 / st.meta.homes_kwh_per_day / 1000) * 1000, s = st.sim.summary;
  $("counters").innerHTML = `
    <div class="ctr"><span>Wind & solar curtailed</span><b class="mono">${curt.toFixed(1)} GWh</b><small>≈ ${homes.toLocaleString()} homes for a day · day total ${s.curtailed_gwh.toFixed(1)} GWh</small></div>
    <div class="ctr"><span>Constraint cost</span><b class="mono">${fmtGBP(cc)}</b><small>day total ${fmtGBP(s.constraint_cost)}</small></div>
    <div class="ctr"><span>CO₂ intensity (average so far)</span><b class="mono">${sup ? Math.round(em / sup) : 0} g/kWh</b><small>now ${Math.round(tot.ci[p])} g/kWh</small></div>
    <div class="ctr"><span>Storage state of charge</span><b class="mono">${(tot.soc[p] / 1000).toFixed(1)} GWh</b><small>total across all pumped storage and batteries</small></div>
    <div class="ctr ${tot.unserved[p] > 0.5 ? "warnbox" : ""}"><span>Market price (GB, this half hour)</span><b class="mono">£${tot.price[p].toFixed(0)}/MWh</b>
      <small class="${tot.unserved[p] > 0.5 ? "warn" : ""}">Loss of load now: ${fmtMW(tot.unserved[p])}${uns > 0.005 ? ` · so far ${uns.toFixed(2)} GWh` : ""} · day total ${s.unserved_gwh.toFixed(2)} GWh</small></div>`;
}

function renderTime() {
  const clock = hhmm(st.t * 30);
  if (clock !== st.lastClock) { $("clock").textContent = clock; st.lastClock = clock; }
}

function onPeriod(p) {
  if (st.playing) st.playedPeriods.add(p);
  $("spLabel").textContent = st.sim ? st.sim.periods[p].label : "";
  renderBars(); renderCounters(); renderCard(); evaluateMissions();
}

// ====================================================================== cards
function select(hit) {
  st.selected = hit;
  if (hit) st.cards.add(`${hit.kind}:${hit.id}`);
  if (hit?.kind === "boundary" && !st.boundaryInfo[hit.id]) {
    api(`api/boundary/${encodeURIComponent(hit.id)}`).then((info) => { st.boundaryInfo[hit.id] = info; renderCard(); }).catch(() => {});
  }
  renderBars(); renderCard(); evaluateMissions();
}

function offlineButton(id, name) {
  if (!st.sim) return "";
  const off = st.req.excluded_assets.includes(id);
  return `<button class="btn small ${off ? "primary" : ""}" data-offline="${esc(id)}">${off ? `Bring ${esc(name)} back online` : `Take ${esc(name)} offline`}</button>`;
}

function renderCard() {
  const el = $("card"), sel = st.selected;
  if (!sel) { el.classList.add("hidden"); return; }
  const scroll = el.scrollTop;
  let html = "", charts = [];
  if (sel.kind === "asset") [html, charts] = assetCard(sel.id);
  else if (sel.kind === "ic") [html, charts] = icCard(sel.id);
  else if (sel.kind === "boundary") [html, charts] = boundaryCard(sel.id);
  else if (sel.kind === "hvdc") [html, charts] = hvdcCard(sel.id);
  else if (sel.kind === "region") [html, charts] = regionCard(sel.id);
  else if (sel.kind === "embedded") [html, charts] = embeddedCard(sel.id);
  el.innerHTML = `<button class="icon close" id="cardClose" title="Close (Esc)">${ICON.close}</button>${html}`;
  el.classList.remove("hidden");
  el.scrollTop = scroll;
  $("cardClose").addEventListener("click", () => select(null));
  el.querySelectorAll("[data-offline]").forEach((b) => b.addEventListener("click", () => toggleAsset(b.dataset.offline)));
  for (const [id, series, opts] of charts) { const c = document.getElementById(id); if (c) sparkline(c, series, { t: cur(), ...opts }); }
}

function legend(items) {
  return `<div class="spark-legend">${items.map(([c, l, dash]) => `<span><i style="border-color:${c};border-style:${dash ? "dashed" : "solid"}"></i>${esc(l)}</span>`).join("")}</div>`;
}

function assetCard(id) {
  const a = st.assetById[id], p = cur(), tech = TECH[a.tech];
  const sa = st.se?.A[id], v = st.sim?.periods[p].assets[id];
  const excludedType = st.req.excluded_types.includes(a.tech), excludedAsset = st.req.excluded_assets.includes(id);
  const storage = a.tech === "battery" || a.tech === "pumped_storage";
  const energy = a.energy_mwh || (a.tech === "battery" ? a.capacity_mw * st.meta.battery_default_duration_h : null);
  let h = `<div class="card-kicker" style="color:${tech.color}">${esc(tech.name)}</div><h2>${esc(a.name)}</h2>
    <p class="dim">${fmtMW(a.capacity_mw)}${energy ? ` · ${(energy / 1000).toFixed(1)} GWh storage` : ""}${a.offshore ? ` · connects onshore at <b>${esc(a.conn_site)}</b>` : a.conn_site ? ` · ${esc(a.conn_site)}` : ""}</p>`;
  const charts = [];
  if (excludedType || excludedAsset) {
    h += `<p class="warnbox">Removed from the system${excludedType ? ` (all ${esc(tech.name.toLowerCase())} are switched off in Layers)` : ""}. The day was re-solved without it.</p>`;
  } else if (v) {
    if (storage) {
      const mode = v.p > 1 ? `Discharging <b>${fmtMW(v.p)}</b>` : v.p < -1 ? `Charging <b>${fmtMW(-v.p)}</b>` : "Idle";
      h += `<p class="big">${mode}</p><p>State of charge <b>${(v.soc / 1000).toFixed(2)} GWh</b> of ${(energy / 1000).toFixed(1)} (${pct(v.soc / energy)})</p>`;
    } else {
      h += `<p class="big"><b>${fmtMW(v.p)}</b> <span class="dim">(${pct(v.p / a.capacity_mw)} of capacity)</span></p>`;
      if (v.avail != null) h += `<p>The weather allows ${fmtMW(v.avail)}${v.avail - v.p > 1 ? `; <span class="warn">${fmtMW(v.avail - v.p)} curtailed</span>` : ""}.</p>`;
    }
    h += `<p class="action">${actionText(a, v, p)}</p>`;
    const series = [{ data: sa.p, color: tech.color, width: 2 }, { data: sa.p.map((x, t) => x - sa.act[t]), color: "rgba(255,255,255,0.6)", dash: [4, 3] }];
    const items = [[tech.color, storage ? "Output (+ discharge, − charge)" : "Output"], ["rgba(255,255,255,0.6)", "Market position (no constraints)", true]];
    if (sa.avail) { series.push({ data: sa.avail, color: "rgba(255,216,77,0.7)", dash: [1, 3] }); items.push(["rgba(255,216,77,0.7)", "Weather allows", true]); }
    h += `<canvas class="spark" id="sparkA"></canvas>${legend(items)}`;
    charts.push(["sparkA", series, { div: 1, unit: "MW" }]);
    if (storage) {
      h += `<canvas class="spark short" id="sparkSoc"></canvas>${legend([[tech.color, "State of charge (MWh)"]])}`;
      charts.push(["sparkSoc", [{ data: sa.soc, color: tech.color, fill: "rgba(61,123,255,0.18)" }], { div: 1, unit: "MWh", max: energy }]);
    }
  }
  h += `<p><b>Sits behind:</b> ${esc(behindText(a.inside))}</p>`;
  if (a.offshore) h += `<p class="dim small">The turbines are at sea, but which side of a boundary a farm is on depends on where its cable reaches the shore.</p>`;
  if (a.note) h += `<p class="dim small">${esc(a.note)}</p>`;
  if (a.source) h += `<p class="dim small">Data: ${esc(a.source)}</p>`;
  if (!excludedType) h += offlineButton(id, a.name);
  return [h, charts];
}

function actionText(a, v, p) {
  const P = st.sim.periods[p], mag = Math.abs(v.action);
  if (mag < Math.max(5, 0.01 * a.capacity_mw)) return `No constraint action this period: it runs where the market put it.`;
  const storage = a.tech === "battery" || a.tech === "pumped_storage";
  if (v.action < 0) {
    const why = v.relieves?.length ? ` to relieve ${v.relieves.join(", ")}` : "";
    return storage ? `<span class="warn">▼</span> Charging ${fmtMW(mag)} more than the market wanted${why}, soaking up power that cannot get across.`
      : `<span class="warn">▼</span> Turned down ${fmtMW(mag)}${why}.`;
  }
  const blocked = Object.entries(P.boundaries).filter(([b, x]) => x.binding && !a.inside.includes(b)).map(([b]) => b);
  const where = blocked.length ? ` to replace power that cannot get across ${blocked.join(", ")}` : "";
  return storage ? `▲ Discharging ${fmtMW(mag)} more than the market wanted${where}.` : `▲ Turned up ${fmtMW(mag)}${where}.`;
}

function icCard(id) {
  const ic = st.icById[id], p = cur(), country = COUNTRY[ic.far_country] || ic.far_country, charts = [];
  let h = `<div class="card-kicker">Interconnector</div><h2>${flagImg(ic.far_country)} ${esc(ic.name)}</h2>
    <table class="kv"><tr><td>GB landing</td><td>${esc(ic.gb_site)}</td></tr><tr><td>Far end</td><td>${esc(ic.far_site)}, ${esc(country)}</td></tr>
    <tr><td>Capacity</td><td>${fmtGW(ic.capacity_mw)}</td></tr></table>`;
  if (ic.status === "future") return [h + `<p class="warnbox">Under construction. Shown for context only; it is not in the model.</p>`, charts];
  const se = st.se, mw = se?.IC[id]?.[p], mkt = se?.ICm[id]?.[p];
  if (se && mw == null) h += `<p class="warnbox">Removed from the system. The day was re-solved without it.</p>`;
  else if (se) {
    h += `<p class="big">${mw > 1 ? `Importing <b>${fmtGW(mw, 2)}</b> from ${esc(country)}` : mw < -1 ? `Exporting <b>${fmtGW(-mw, 2)}</b> to ${esc(country)}` : "Idle"}</p>`;
    if (st.req.lock_ic) h += `<p class="dim">All interconnectors are locked at 0 MW.</p>`;
    else if (Math.abs(mw - mkt) > 1) h += `<p class="action">The market wanted ${mkt >= 0 ? "an import" : "an export"} of ${fmtGW(Math.abs(mkt), 2)}; the system operator re-routed it by ${fmtGW(Math.abs(mw - mkt), 2)} to help the boundaries.</p>`;
    h += `<canvas class="spark" id="sparkI"></canvas>${legend([["#f2f2f2", "Flow (+ import into GB)"], ["rgba(255,255,255,0.5)", "Market flow", true], ["rgba(255,176,32,0.7)", "± capacity", true]])}`;
    charts.push(["sparkI", [{ data: se.IC[id], color: "#f2f2f2", width: 2 }, { data: se.ICm[id], color: "rgba(255,255,255,0.5)", dash: [4, 3] }], { band: ic.capacity_mw }]);
  }
  const pr = st.sim?.prices;
  if (pr && pr[ic.far_country]) {
    const fp = pr[ic.far_country][p], gp = pr.GB[p], gap = fp - gp;
    h += `<h4>Prices this half hour</h4><table class="kv">
      <tr><td>${flagImg(ic.far_country)} ${esc(country)}</td><td class="mono">£${fp.toFixed(0)}/MWh</td></tr>
      <tr><td>Great Britain</td><td class="mono">£${gp.toFixed(0)}/MWh</td></tr></table>
      <p class="dim small">${Math.abs(gap) < 1 ? `The two prices are level: the link is only partly used, and it is setting the GB price.`
        : gap > 0 ? `${esc(country)} is dearer by £${gap.toFixed(0)}/MWh, so the market sends power there.`
        : `GB is dearer by £${(-gap).toFixed(0)}/MWh, so the market imports from ${esc(country)}.`} Power flows towards the dearer market, at full capacity unless the ramp limit holds it back or the two prices meet.</p>
      <canvas class="spark short" id="sparkP"></canvas>${legend([["#ffb020", `${country} price`], ["#f2f2f2", "GB price"]])}`;
    charts.push(["sparkP", [{ data: pr[ic.far_country], color: "#ffb020", width: 2 }, { data: pr.GB, color: "#f2f2f2", width: 1.5 }], { unit: "£/MWh", div: 1, zero: false }]);
  }
  h += `<p class="dim small">The ${esc(country)} price is an illustrative profile (config/ic_prices.yaml) that drops when the North Sea is windy; the GB price is the market's marginal cost in the model. Flows stay within ±capacity and change by at most 30% of capacity per half hour.</p>`;
  h += `<p><b>Lands:</b> ${esc(behindText(ic.inside))}</p>`;
  h += offlineButton(id, ic.name);
  return [h, charts];
}

function boundaryCard(b) {
  const cfg = st.bcfg[b], info = st.boundaryInfo[b], p = cur(), charts = [];
  const derate = st.req.season === "summer" ? st.req.summer_derate : 1;
  let h = `<div class="card-kicker">${cfg.type === "local" ? "Local" : "Wider"} boundary${cfg.core ? "" : " · optional"}</div><h2>${esc(b)}</h2>
    <p>${esc(cfg.description)}</p>
    <table class="kv"><tr><td>Limiting circuit</td><td>${esc(cfg.limiting)}</td></tr>
    <tr><td>Capability</td><td>${fmtGW(cfg.capability_mw)} winter (ETYS 2025)${derate !== 1 ? ` × ${derate.toFixed(2)} summer derate = <b>${fmtGW(cfg.capability_mw * derate)}</b>` : ""}</td></tr>
    <tr><td>"Inside" side</td><td>${esc(cfg.inside_label)}${cfg.positive === "import" ? " (ETYS counts LE1 positive when importing)" : ""}</td></tr></table>`;
  const o = st.se?.B[b];
  if (o) {
    if (!o.enforced) h += `<p class="warnbox">Optional boundary: its flow is shown but it is not enforced. Tick "Enforce optional boundaries" to include it in the dispatch.</p>`;
    const gen = o.gen[p], dem = o.demand[p], chg = o.chg[p], imp = o.imp[p], flow = o.flow[p], unc = o.unc[p], cap = o.cap[p];
    const surplus = gen - dem - chg + imp, side = sideText(b), injU = injOf(b, unc);
    h += `<div class="equation">Generation ${side} = <b>${fmtGW(gen)}</b>, demand ${side} = <b>${fmtGW(dem)}</b>, net storage charging = <b>${fmtGW(chg)}</b>, net imports = <b>${fmtGW(imp)}</b>
      → ${surplus >= 0 ? "surplus" : "shortfall"} <b>${fmtGW(Math.abs(surplus))}</b> flows ${dirWord(b, surplus)}.<br>
      Market wanted <b>${fmtGW(Math.abs(unc))}</b> ${dirWord(b, injU)}; capability <b>${fmtGW(cap)}</b> → ` +
      (o.bind[p] ? `<b class="warn">constrained by ${fmtGW(Math.abs(unc) - cap)}</b>` : `${pct(Math.abs(flow) / cap)} loaded, not constrained`) + `</div>`;
    if (o.bind[p] && o.shadow[p] > 0) h += `<p class="dim small">Shadow price £${o.shadow[p].toFixed(0)}/MWh: what one more MW of capability would save the system in this half hour.</p>`;
    h += `<canvas class="spark" id="sparkB"></canvas>${legend([[PALETTES[st.palette].loaded, "Flow"], ["rgba(255,255,255,0.65)", "Market (unconstrained) flow", true], ["rgba(255,176,32,0.7)", "± capability", true], ["rgba(255,45,85,0.5)", "Constrained periods"]])}`;
    charts.push(["sparkB", [{ data: o.flow, color: PALETTES[st.palette].loaded, width: 2 }, { data: o.unc, color: "rgba(255,255,255,0.65)", dash: [4, 3] }], { band: cap, mark: o.bind }]);
    h += `<p class="dim small">Generation includes embedded wind and solar; demand is underlying demand. Positive flow = ${cfg.positive === "import" ? "into" : "out of"} the inside side.</p>`;
  }
  if (info) {
    const byTech = {};
    info.inside_assets.forEach((x) => (byTech[x.tech] = (byTech[x.tech] || 0) + x.capacity_mw));
    h += `<h4>What is ${esc(side2(b))}</h4><table class="kv">` + Object.entries(byTech).sort((x, y) => y[1] - x[1])
      .map(([t, mw]) => `<tr><td><span class="swatch" style="background:${TECH[t].color}"></span>${esc(TECH[t].name)}</td><td class="mono">${fmtGW(mw)}</td></tr>`).join("") + `</table>`;
    h += `<p class="dim small">Interconnectors: ${info.inside_interconnectors.map((x) => esc(x.name)).join(", ") || "none"} · ${info.inside_regions.length} demand regions</p>`;
  }
  h += `<p class="dim small">Assumptions: ETYS publishes winter-peak, SQSS-secured capabilities. Summer uses an assumed derate, and the reverse-direction limit is assumed equal to the forward one because ETYS does not publish it.</p>`;
  return [h, charts];
}
const side2 = (b) => (st.bcfg[b].inside_label === "North" ? `north of ${b}` : `inside ${b}`);

function hvdcCard(id) {
  const h0 = st.hvdcList.find((x) => x.id === id), charts = [];
  let h = `<div class="card-kicker" style="color:#c18cff">Internal HVDC link</div><h2>${esc(h0.name)}</h2>
    <table class="kv"><tr><td>Route</td><td>${esc(h0.a_site)} ⇄ ${esc(h0.b_site)}</td></tr><tr><td>Capacity</td><td>${fmtGW(h0.capacity_mw)}</td></tr>
    <tr><td>Crosses</td><td>${h0.crosses.length ? esc(h0.crosses.join(", ")) : "no boundary shown"}</td></tr></table>`;
  if (h0.status === "future") return [h + `<p class="warnbox">Future link (not built yet). Shown for context only.</p>`, charts];
  const [kind, ref] = (h0.follows || ":").split(":");
  if (st.se && st.lastF?.HV?.[id] != null) {
    const mw = st.lastF.HV[id];
    h += `<p class="big">${fmtGW(Math.abs(mw), 2)} ${mw >= 0 ? `${esc(h0.a_site)} → ${esc(h0.b_site)}` : `${esc(h0.b_site)} → ${esc(h0.a_site)}`}</p>`;
  }
  h += `<p class="dim small">In a boundary-cut model an internal link does not change any boundary total, and the ETYS capabilities already include it. The flow drawn here is only a display share: ${kind === "asset" ? `the output of ${esc(st.assetById[ref]?.name || ref)}, which it exports` : `the ${esc(ref)} flow pro rata by capacity`}.</p>`;
  return [h, charts];
}

function embeddedCard(id) {
  const e = st.embeddedById[id], r = st.regionById[e.region], p = cur(), v = st.sim?.periods[p].regions[e.region];
  const tech = TECH[e.tech];
  let h = `<div class="card-kicker" style="color:${tech.color}">${esc(tech.name)} · embedded</div><h2>${esc(e.name)}</h2>
    <p class="dim">${fmtMW(e.capacity_mw)} · connected to the local distribution network</p>
    <p>Its output is part of the <b>embedded ${e.tech === "solar" ? "solar" : "wind"}</b> of ${esc(r?.name || e.region)}, which lowers the demand the transmission system sees. It is drawn for context only and is not a separate asset in the dispatch, so nothing is counted twice.</p>`;
  if (v) {
    const cap = e.tech === "solar" ? st.embCap[e.region] : st.embWindCap[e.region], now = e.tech === "solar" ? v.emb_solar : v.emb_wind;
    if (cap > 0) h += `<p>Regional embedded ${e.tech === "solar" ? "solar" : "wind"} is running at <b>${pct(now / cap)}</b> of capacity, so this farm is producing about ${fmtMW(e.capacity_mw * now / cap)}.</p>`;
  }
  h += `<p class="dim small">Data: REPD ref ${esc(e.ref_id)}. Only farms of ${esc(String(st.meta.embedded_min_mw ?? 10))} MW or more are drawn; smaller ones and rooftop panels are in the regional totals.</p>`;
  return [h, []];
}

function regionCard(id) {
  const r = st.regionById[id], p = cur(), v = st.sim?.periods[p].regions[id];
  let h = `<div class="card-kicker">Demand region</div><h2>${esc(r.name)}</h2>`;
  if (v) h += `<table class="kv"><tr><td>Underlying demand</td><td>${fmtMW(v.demand)}</td></tr><tr><td>Embedded solar</td><td>${fmtMW(v.emb_solar)}</td></tr>
      <tr><td>Embedded wind</td><td>${fmtMW(v.emb_wind)}</td></tr><tr><td>Net from the grid</td><td>${fmtMW(v.demand - v.emb_solar - v.emb_wind)}</td></tr></table>`;
  h += `<p><b>Sits behind:</b> ${esc(behindText(r.inside))}</p><p class="dim small">Demand is split by fixed regional shares (data/seed/demand_regions.csv); embedded generation follows the same synthetic weather.</p>`;
  return [h, []];
}

// ====================================================================== tooltip
function tooltipHtml(hit) {
  const p = st.se ? cur() : null;
  if (hit.kind === "asset") {
    const a = st.assetById[hit.id], v = p != null ? st.sim.periods[p].assets[hit.id] : null;
    let out = v ? `<b>${fmtMW(v.p)}</b> now` : st.sim ? "removed from system" : "";
    if (v && Math.abs(v.action) > 5) out += v.action < 0 ? ` · <span class="warn">▼ ${fmtMW(-v.action)}</span>` : ` · ▲ ${fmtMW(v.action)}`;
    return `<b>${esc(a.name)}</b><br>${esc(TECH[a.tech].name)} · ${fmtMW(a.capacity_mw)}<br>${out}`;
  }
  if (hit.kind === "ic") {
    const ic = st.icById[hit.id], mw = p != null ? st.se.IC[hit.id]?.[p] : null;
    return `<b>${esc(ic.name)}</b> ${flagImg(ic.far_country)}<br>${esc(ic.gb_site)} ⇄ ${esc(ic.far_site)}<br>${fmtGW(ic.capacity_mw)}${mw != null ? ` · ${mw > 1 ? "importing" : mw < -1 ? "exporting" : "idle"} ${fmtGW(Math.abs(mw), 2)}` : ""}`;
  }
  if (hit.kind === "boundary") {
    const cfg = st.bcfg[hit.id], o = st.se?.B[hit.id];
    return `<b>${esc(hit.id)}</b> · ${fmtGW(cfg.capability_mw)} winter<br>${esc(cfg.description)}` + (o ? `<br>flow ${fmtGW(o.flow[p])} of ${fmtGW(o.cap[p])}${o.bind[p] ? ` · <span class="warn">constrained</span>` : ""}` : "");
  }
  if (hit.kind === "hvdc") { const h = st.hvdcList.find((x) => x.id === hit.id); return `<b>${esc(h.name)}</b> (internal HVDC)<br>${esc(h.a_site)} ⇄ ${esc(h.b_site)} · ${fmtGW(h.capacity_mw)}`; }
  if (hit.kind === "embedded") { const e = st.embeddedById[hit.id]; return `<b>${esc(e.name)}</b><br>${esc(TECH[e.tech].name)} · ${fmtMW(e.capacity_mw)} · embedded`; }
  if (hit.kind === "region") { const r = st.regionById[hit.id], v = p != null ? st.sim.periods[p].regions[hit.id] : null; return `<b>${esc(r.name)}</b>${v ? `<br>demand ${fmtMW(v.demand)}` : ""}`; }
  return "";
}

// ====================================================================== layers
function layerRow(key, label, color, opts) {
  return `<div class="layer" data-key="${key}"${opts.title ? ` title="${esc(opts.title)}"` : ""}>
    <button class="icon eye ${st.show[key] ? "on" : ""}" data-act="show" title="Show / hide (visual only)">${ICON.eye}</button>
    ${opts.system ? `<button class="icon pow ${st.req.excluded_types.includes(key) ? "" : "on"}" data-act="include" title="Include in system: switching off removes the whole type and re-solves the day">${ICON.power}</button>` : `<span class="icon-spacer"></span>`}
    <span class="swatch" style="background:${color}"></span><span class="lname">${esc(label)}</span>
    ${opts.solo ? `<button class="icon solo ${st.solo === key ? "on" : ""}" data-act="solo" title="Solo: show only this layer plus boundaries">${ICON.target}</button>` : ""}
  </div>`;
}

function buildLayers() {
  $("layers").innerHTML = SYSTEM_LAYERS.map((k) => layerRow(k, TECH[k].name, TECH[k].color, { system: true, solo: true })).join("") +
    `<div class="sep"></div>` + VISUAL_LAYERS.map(([k, l, c, title]) => layerRow(k, l, c, { system: false, solo: false, title })).join("");
  $("layers").querySelectorAll(".layer button").forEach((btn) => btn.addEventListener("click", () => {
    const key = btn.closest(".layer").dataset.key, act = btn.dataset.act;
    if (act === "show") { st.show[key] = !st.show[key]; saveShow(); buildLayers(); }
    else if (act === "solo") { st.solo = st.solo === key ? null : key; buildLayers(); }
    else if (act === "include") toggleType(key);
  }));
  $("overlays").innerHTML = OVERLAYS.map(([k, l]) => `<label class="check"><input type="checkbox" data-ov="${k}" ${st.show[k] ? "checked" : ""}> ${esc(l)}</label>`).join("");
  $("overlays").querySelectorAll("input").forEach((i) => i.addEventListener("change", () => { st.show[i.dataset.ov] = i.checked; saveShow(); }));
}
const saveShow = () => store.set("gbgfe.show.v2", st.show);

function toggleType(key) {
  const ex = st.req.excluded_types, on = !ex.includes(key);
  st.req.excluded_types = on ? [...ex, key] : ex.filter((k) => k !== key);
  buildLayers(); renderHeader();
  resolve(on ? `${TECH[key].name} removed` : `${TECH[key].name} back`);
}
function toggleAsset(id) {
  const ex = st.req.excluded_assets, on = !ex.includes(id);
  st.req.excluded_assets = on ? [...ex, id] : ex.filter((k) => k !== id);
  const name = st.assetById[id]?.name || st.icById[id]?.name || id;
  renderHeader();
  resolve(on ? `${name} offline` : `${name} back online`);
}

// ====================================================================== re-solve
function syncUrl() { try { history.replaceState(null, "", "?" + paramsFromReq(st.req)); } catch (e) { /* ignore */ } }

async function resolve(label) {
  if (st.busy) { st.pending = label || true; return; }
  st.busy = true; $("busy").classList.remove("hidden"); syncUrl();
  const prev = st.sim?.summary;
  try {
    const sim = await api("api/simulate", bodyFromReq(st.req));
    setSim(sim);
    if (prev && label) compareToast(prev, sim.summary, label);
  } catch (e) {
    toast(`<b>Simulation failed</b><br>${esc(e.message)}`, "error", 9000);
  }
  st.busy = false; $("busy").classList.add("hidden");
  if (st.pending) { const l = st.pending; st.pending = false; resolve(l === true ? null : l); }
}

function setSim(sim) {
  st.sim = sim; st.se = buildSeries(sim);
  st.chart.setData(st.se);
  st.playedPeriods.clear(); st.lastP = -1;
  const r = st.req;
  st.history.push({ weather: JSON.stringify([r.wind, r.cloud, r.season, r.seed, r.front, r.summer_derate, r.start_soc]),
    batteryOff: r.excluded_types.includes("battery"), b4: sim.summary.binding_periods.B4 > 0, curtailed: sim.summary.curtailed_gwh });
  $("sun").textContent = `☀↑ ${sim.weather.sunrise}   ☀↓ ${sim.weather.sunset}`;
  renderHeader(); buildBars();
  st.lastP = cur(); onPeriod(st.lastP);
  if (sim.summary.unserved_gwh > 0) toast(`⚠ Demand could not be fully met: <b>${sim.summary.unserved_gwh.toFixed(2)} GWh</b> unserved.`, "error", 8000);
}

function compareToast(prev, next, label) {
  const lines = [], arrow = (d) => (d > 0 ? "↑" : "↓");
  const dc = next.curtailed_gwh - prev.curtailed_gwh, dk = next.constraint_cost - prev.constraint_cost, dci = next.carbon_intensity - prev.carbon_intensity;
  if (Math.abs(dc) >= 0.05) lines.push(`Curtailment ${arrow(dc)} <b>${Math.abs(dc).toFixed(1)} GWh</b> vs previous run`);
  if (Math.abs(dk) >= 5000) lines.push(`Constraint cost ${arrow(dk)} <b>${fmtGBP(Math.abs(dk))}</b>`);
  if (Math.abs(dci) >= 1) lines.push(`CO₂ ${arrow(dci)} ${Math.abs(dci).toFixed(0)} g/kWh`);
  if (!lines.length) lines.push("No change in curtailment or constraint cost");
  toast(`<b>${esc(label)}</b> · day re-solved<br>${lines.join("<br>")}`, "info", 6500);
}

function toast(html, kind = "info", ms = 5000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`; el.innerHTML = html;
  el.addEventListener("click", () => el.remove());
  $("toasts").appendChild(el);
  while ($("toasts").children.length > 3) $("toasts").firstElementChild.remove();
  setTimeout(() => el.classList.add("fade"), ms - 400);
  setTimeout(() => el.remove(), ms);
}

// ====================================================================== missions
function evaluateMissions() {
  if (!st.missions) return;
  st.missions.evaluate({ sim: st.sim, req: st.req, history: st.history, period: st.sim ? cur() : null, playedPeriods: st.playedPeriods, cards: st.cards });
}

// ====================================================================== playback
function setPlaying(on) {
  st.playing = on && !!st.sim;
  $("playBtn").innerHTML = st.playing ? ICON.pause : ICON.play;
  $("playBtn").title = st.playing ? "Pause (space)" : "Play (space)";
  if (st.playing) st.playedPeriods.add(cur());
}
function step(d) {
  setPlaying(false);
  let p = Math.floor(st.t) + d;
  p = st.loop ? ((p % T) + T) % T : clamp(p, 0, T - 1);
  st.t = p;
}
function jump(p) { setPlaying(false); st.t = p; }

let lastNow = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
  if (st.playing) {
    st.t += dt * st.speed * 0.5;                       // at 1x one half hour lasts 2 seconds
    if (st.loop) { if (st.t >= T) st.t -= T; }
    else if (st.t >= T - 1) { st.t = T - 1; setPlaying(false); }
  }
  const p = cur();
  if (p !== st.lastP && st.sim) { st.lastP = p; onPeriod(p); }
  renderTime();
  const F = frame(dt, now / 1000);
  st.lastF = F;
  st.renderer.draw(F);
  st.chart.draw(st.t);
  requestAnimationFrame(loop);
}

// ====================================================================== controls
function buildControls() {
  $("startBtn").innerHTML = ICON.start; $("backBtn").innerHTML = ICON.back; $("playBtn").innerHTML = ICON.play;
  $("fwdBtn").innerHTML = ICON.fwd; $("endBtn").innerHTML = ICON.end; $("loopBtn").innerHTML = ICON.loop;
  $("resetView").innerHTML = ICON.reset; $("weatherBtn").innerHTML = `${ICON.gear} Weather`;
  $("startBtn").onclick = () => jump(0);
  $("endBtn").onclick = () => jump(T - 1);
  $("backBtn").onclick = () => step(-1);
  $("fwdBtn").onclick = () => step(1);
  $("playBtn").onclick = () => setPlaying(!st.playing);
  $("loopBtn").onclick = () => { st.loop = !st.loop; $("loopBtn").classList.toggle("on", st.loop); };
  $("loopBtn").classList.toggle("on", st.loop);
  const speed = $("speed");
  const setSpeed = () => { st.speed = Math.pow(2, Number(speed.value)); $("speedLabel").textContent = `${st.speed < 1 ? st.speed : Math.round(st.speed)}×`; };
  speed.addEventListener("input", setSpeed); setSpeed();
  $("resetView").onclick = () => st.renderer.fit();
  document.querySelectorAll(".controls button").forEach((b) => b.addEventListener("mouseup", () => b.blur()));

  $("allOn").onclick = () => { [...SYSTEM_LAYERS, ...VISUAL_LAYERS.map(([k]) => k)].forEach((k) => (st.show[k] = k === "demand" || k === "future" ? st.show[k] : true)); st.solo = null; saveShow(); buildLayers(); };
  $("allOff").onclick = () => { [...SYSTEM_LAYERS, ...VISUAL_LAYERS.map(([k]) => k)].forEach((k) => (st.show[k] = k === "boundaries")); st.solo = null; saveShow(); buildLayers(); };
  $("lockIc").checked = st.req.lock_ic;
  $("lockIc").onchange = (e) => { st.req.lock_ic = e.target.checked; renderHeader(); resolve(e.target.checked ? "Interconnectors locked at 0" : "Interconnectors free"); };
  $("showAll").checked = st.show.allBoundaries;
  $("showAll").onchange = (e) => { st.show.allBoundaries = e.target.checked; saveShow(); buildBars(); };
  $("enforceOpt").checked = st.req.enforce_optional;
  $("enforceOpt").onchange = (e) => {
    st.req.enforce_optional = e.target.checked;
    if (e.target.checked && !st.show.allBoundaries) { st.show.allBoundaries = true; $("showAll").checked = true; saveShow(); }
    resolve(e.target.checked ? "Optional boundaries enforced" : "Optional boundaries not enforced");
  };
  $("cbPalette").checked = st.palette === "cb";
  $("cbPalette").onchange = (e) => { st.palette = e.target.checked ? "cb" : "normal"; store.set("gbgfe.palette", st.palette); renderBars(); renderCard(); };

  const mh = $("missionsHead");
  const setCollapsed = (c) => { mh.parentElement.classList.toggle("collapsed", c); store.set("gbgfe.missionsCollapsed", c); };
  setCollapsed(store.get("gbgfe.missionsCollapsed", false));
  mh.onclick = () => setCollapsed(!mh.parentElement.classList.contains("collapsed"));

  $("aboutBtn").onclick = $("noticeBtn").onclick = () => $("modal").classList.remove("hidden");
  if (location.hash === "#about") $("modal").classList.remove("hidden");   // from the weather page's notice
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal" || e.target.closest("[data-close]")) $("modal").classList.add("hidden"); });

  $("chartLegend").innerHTML = MIX_LAYERS.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("") +
    NEG_LAYERS.map(([, l, c]) => `<span><i style="background:${c};opacity:.6"></i>${l} (below 0)</span>`).join("") +
    `<span><i class="line"></i>Demand</span><span><i class="hatch"></i>Curtailed</span>`;

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input[type=number], input[type=text], textarea, select")) return;
    if (e.code === "Space") { e.preventDefault(); setPlaying(!st.playing); }
    else if (e.key === "ArrowLeft" && !e.target.matches("input[type=range]")) { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight" && !e.target.matches("input[type=range]")) { e.preventDefault(); step(1); }
    else if (e.key === "Home") jump(0);
    else if (e.key === "End") jump(T - 1);
    else if (e.key === "Escape") { if (!$("modal").classList.contains("hidden")) $("modal").classList.add("hidden"); else select(null); }
  });
}

// ====================================================================== init
async function init() {
  st.req = reqFromParams(location.search);
  buildControls();
  try {
    st.S = await api("api/static");
  } catch (e) {
    $("busy").classList.remove("hidden"); $("busy").textContent = "Could not load map data: " + e.message; return;
  }
  const S = st.S;
  st.meta = S.meta; st.order = S.meta.boundary_order;
  st.bcfg = {}; S.boundaries.features.forEach((f) => { if (f.properties.configured) st.bcfg[f.properties.name] = f.properties; });
  st.assetById = {}; S.assets.features.forEach((f) => {
    const p = f.properties;
    st.assetById[p.id] = { ...p, offshore: Math.abs(p.conn_lat - p.display_lat) + Math.abs(p.conn_lon - p.display_lon) > 0.05 };
  });
  st.icById = {}; S.interconnectors.features.forEach((f) => (st.icById[f.properties.id] = f.properties));
  st.hvdcList = S.hvdc_internal.features.map((f) => f.properties);
  st.regionById = {}; st.embCap = {}; st.embWindCap = {};
  S.regions.features.forEach((f) => { st.regionById[f.properties.id] = f.properties; st.embCap[f.properties.id] = f.properties.emb_solar_share * S.meta.emb_solar_capacity_mw;
    st.embWindCap[f.properties.id] = f.properties.emb_wind_share * S.meta.emb_wind_capacity_mw; });
  st.embeddedById = {}; (S.embedded_sites?.features || []).forEach((f) => (st.embeddedById[f.properties.id] = f.properties));

  st.renderer = new MapRenderer($("map"), S);
  st.renderer.resize();
  st.renderer.handlers.hover = (hit, x, y) => {
    const tip = $("tooltip");
    if (!hit) { tip.style.display = "none"; return; }
    tip.innerHTML = tooltipHtml(hit); tip.style.display = "block";
    const W = $("mapcol").clientWidth;
    tip.style.left = Math.min(x + 14, W - 280) + "px"; tip.style.top = y + 14 + "px";
  };
  st.renderer.handlers.click = (hit) => select(hit);
  st.chart = new StackChart($("chart"), (t) => { setPlaying(false); st.t = t; });
  new ResizeObserver(() => st.renderer.resize()).observe($("mapcol"));
  new ResizeObserver(() => st.chart.resize()).observe($("chartwrap"));

  st.missions = new Missions($("missions"), $("missionCount"), (m, why) => {
    toast(`🏅 <b>Mission complete: ${esc(m.title)}</b><br>${esc(why)}`, "success", 12000);
    $("missionsHead").parentElement.classList.remove("collapsed");
  });

  buildLayers(); renderHeader();
  window.gbgfe = { st, frame, select, resolve };          // handle for debugging from the console
  requestAnimationFrame((now) => { lastNow = now; loop(now); });
  await resolve(null);
}

init();
