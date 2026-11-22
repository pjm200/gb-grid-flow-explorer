// Canvas map renderer. Every animation encodes a quantity:
// rotor speed = output, flame height = output, glow = loading, dash speed = MW, etc.
import { TECH, flagSrc } from "./common.js";

const K = 100, LON0 = -11, LAT0 = 62, COS = Math.cos(54.5 * Math.PI / 180);
export const proj = (lon, lat) => [(lon - LON0) * COS * K, (LAT0 - lat) * K];
export const unproj = (x, y) => [x / (COS * K) + LON0, LAT0 - y / K];
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hypot = Math.hypot;

export const PALETTES = {
  normal: { light: "#2b6cff", loaded: "#3fa9ff", near: "#ffb020", con: "#ff2d55", idle: "#2b6cff" },
  cb: { light: "#178f86", loaded: "#3fe0d0", near: "#ffd23f", con: "#e040fb", idle: "#178f86" },
};
const STYLE = {
  idle: { w: 2, a: 0.55, glow: 0 }, light: { w: 2, a: 0.5, glow: 0 }, loaded: { w: 3, a: 0.9, glow: 0.35 },
  near: { w: 4, a: 1, glow: 0.7 }, con: { w: 5, a: 1, glow: 1 },
};
// spec 5.2: u = |flow| / capability
export function boundaryState(b) {
  if (!b) return { key: "idle", u: 0 };
  const u = Math.abs(b.flow) / b.cap;
  if (b.binding) return { key: "con", u };
  if (u >= 0.9) return { key: "near", u };
  if (u >= 0.5) return { key: "loaded", u };
  return { key: "light", u };
}

function ringsOf(g) { return g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []; }
function linesOf(g) { return g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : []; }
function polyPath(geom) {
  const p = new Path2D();
  for (const poly of ringsOf(geom)) for (const ring of poly) {
    ring.forEach(([lon, lat], i) => { const [x, y] = proj(lon, lat); i ? p.lineTo(x, y) : p.moveTo(x, y); });
    p.closePath();
  }
  return p;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return hypot(px - ax - t * dx, py - ay - t * dy);
}
function quad(a, c, b, t) {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

// ------------------------------------------------------------------ icon drawers
export function drawTurbine(ctx, x, y, size, angle, color, alpha = 1) {
  const hubY = y - size * 0.45;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color; ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, size * 0.11);
  ctx.beginPath(); ctx.moveTo(x, y + size * 0.55); ctx.lineTo(x, hubY); ctx.stroke();
  ctx.lineWidth = Math.max(1, size * 0.13);
  for (let k = 0; k < 3; k++) {
    const a = angle + k * TAU / 3;
    ctx.beginPath(); ctx.moveTo(x, hubY);
    ctx.lineTo(x + Math.cos(a) * size * 0.72, hubY + Math.sin(a) * size * 0.72); ctx.stroke();
  }
  ctx.fillStyle = "#e9f6ff";
  ctx.beginPath(); ctx.arc(x, hubY, Math.max(1, size * 0.1), 0, TAU); ctx.fill();
  ctx.globalAlpha = 1;
}

function flamePath(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.bezierCurveTo(x - w / 2, y - h * 0.45, x - w * 0.15, y - h * 0.6, x, y - h);
  ctx.bezierCurveTo(x + w * 0.15, y - h * 0.6, x + w / 2, y - h * 0.45, x + w / 2, y);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ===================================================================== renderer
export class MapRenderer {
  constructor(canvas, S) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.S = S;
    this.view = { s: 1, ox: 0, oy: 0 }; this.s0 = 1;
    this.w = 1; this.h = 1; this.dpr = 1;
    this.anim = new Map();
    this.smoke = []; this.particles = []; this.clouds = [];
    this.hits = []; this.lastF = null;
    this.staticCanvas = document.createElement("canvas");
    this.staticDirty = true;
    this.handlers = { hover: () => {}, click: () => {} };
    this._build();
    this._bindPointer();
  }

  // ------------------------------------------------------------------ geometry
  _build() {
    const S = this.S;
    this.landPath = new Path2D();
    S.land.features.forEach((f) => this.landPath.addPath(polyPath(f.geometry)));
    this.neighPaths = S.neighbours.features.map((f) => polyPath(f.geometry));
    this.boundaries = S.boundaries.features.map((f) => {
      const p = f.properties;
      const lines = linesOf(f.geometry).map((l) => l.map(([lo, la]) => proj(lo, la)));
      const path = new Path2D();
      lines.forEach((l) => l.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))));
      const label = p.label_lon != null ? proj(p.label_lon, p.label_lat) : lines[0][Math.floor(lines[0].length / 2)];
      return { ...p, lines, path, label, inPt: p.in_lon != null ? proj(p.in_lon, p.in_lat) : null };
    });
    this.sides = {};
    S.boundary_sides.features.forEach((f) => (this.sides[f.properties.name] = polyPath(f.geometry)));
    this.assets = S.assets.features.map((f) => {
      const p = f.properties;
      const offshore = Math.abs(p.conn_lat - p.display_lat) + Math.abs(p.conn_lon - p.display_lon) > 0.05;
      return { ...p, pos: proj(p.display_lon, p.display_lat), conn: proj(p.conn_lon, p.conn_lat), offshore };
    }).sort((a, b) => b.capacity_mw - a.capacity_mw);          // small icons drawn last, on top
    // Assets at (almost) the same spot, e.g. Heysham 1 and 2 share coordinates in DUKES, are
    // fanned out a few pixels around their centre so each one stays visible and clickable.
    const groups = [];
    for (const a of this.assets) {
      let g = groups.find((g) => Math.hypot(g.x - a.pos[0], g.y - a.pos[1]) < 1.4);       // ~1.5 km
      if (!g) { g = { x: a.pos[0], y: a.pos[1], m: [] }; groups.push(g); }
      g.m.push(a);
    }
    for (const g of groups) {
      if (g.m.length < 2) continue;
      const maxCap = Math.max(...g.m.map((a) => a.capacity_mw));
      g.m.forEach((a, k) => {
        const ang = -Math.PI / 2 + k * TAU / g.m.length;
        a.spread = { dx: Math.cos(ang), dy: Math.sin(ang), cap: maxCap, n: g.m.length };
      });
    }
    this._buildMask();
    const seaCtrl = (a, b, bend) => {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], L = hypot(dx, dy) || 1;
      const c1 = [mx - dy / L * L * bend, my + dx / L * L * bend], c2 = [mx + dy / L * L * bend, my - dx / L * L * bend];
      return this.isLand(...c1) && !this.isLand(...c2) ? c2 : c1;
    };
    this.ics = S.interconnectors.features.map((f) => {
      const p = f.properties, a = proj(p.gb_lon, p.gb_lat), b = proj(p.far_lon, p.far_lat);
      return { ...p, a, b, ctrl: seaCtrl(a, b, 0.08) };
    });
    this.hvdc = S.hvdc_internal.features.map((f) => {
      const p = f.properties, a = proj(p.a_lon, p.a_lat), b = proj(p.b_lon, p.b_lat);
      return { ...p, a, b, ctrl: seaCtrl(a, b, p.id === "western_link" ? 0.22 : 0.12) };
    });
    this.regions = S.regions.features.map((f) => ({ ...f.properties, pos: proj(...f.geometry.coordinates) }));
    this.embedded = (S.embedded_sites?.features || []).map((f) => ({ ...f.properties, pos: proj(...f.geometry.coordinates) }));
    this.flags = {};
    for (const ic of this.ics) {
      if (!this.flags[ic.far_country]) { const img = new Image(); img.src = flagSrc(ic.far_country); this.flags[ic.far_country] = img; }
    }
    this._buildCloudSprites();
  }

  _buildMask() {
    const [x0, y0] = proj(-9.5, 61.5), [x1, y1] = proj(2.5, 49.5);
    const W = 260, H = Math.round(W * (y1 - y0) / (x1 - x0));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d");
    g.setTransform(W / (x1 - x0), 0, 0, H / (y1 - y0), -x0 * W / (x1 - x0), -y0 * H / (y1 - y0));
    g.fill(this.landPath);
    this.mask = { x0, y0, x1, y1, W, H, d: g.getImageData(0, 0, W, H).data };
  }
  isLand(x, y) {
    const m = this.mask;
    const i = Math.floor((x - m.x0) / (m.x1 - m.x0) * m.W), j = Math.floor((y - m.y0) / (m.y1 - m.y0) * m.H);
    if (i < 0 || j < 0 || i >= m.W || j >= m.H) return false;
    return m.d[(j * m.W + i) * 4 + 3] > 0;
  }

  _buildCloudSprites() {
    this.cloudSprites = [];
    for (let k = 0; k < 4; k++) {
      const c = document.createElement("canvas"); c.width = 256; c.height = 140;
      const g = c.getContext("2d");
      let seed = 17 + k * 31;
      const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      for (let i = 0; i < 9; i++) {
        const x = 50 + rnd() * 156, y = 50 + rnd() * 40, r = 26 + rnd() * 34;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, "rgba(235,240,250,0.55)"); gr.addColorStop(1, "rgba(235,240,250,0)");
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      this.cloudSprites.push(c);
    }
  }

  // ------------------------------------------------------------------ view
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const first = this.w <= 1;
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + "px"; this.canvas.style.height = this.h + "px";
    if (first) this.fit(); else this.staticDirty = true;
  }
  fit() {
    const [x0, y0] = proj(-9.6, 61.0), [x1, y1] = proj(9.8, 48.9);
    const s = Math.min(this.w / (x1 - x0), this.h / (y1 - y0)) * 0.98;
    this.view = { s, ox: (this.w - (x1 - x0) * s) / 2 - x0 * s, oy: (this.h - (y1 - y0) * s) / 2 - y0 * s };
    this.s0 = s; this.staticDirty = true;
  }
  zoomAt(mx, my, f) {
    const v = this.view, ns = clamp(v.s * f, this.s0 * 0.6, this.s0 * 12);
    f = ns / v.s;
    this.view = { s: ns, ox: mx - (mx - v.ox) * f, oy: my - (my - v.oy) * f };
    this.staticDirty = true;
  }
  assetXY(as) {
    const [x, y] = this.toScreen(as.pos), sp = as.spread;
    if (!sp) return [x, y];
    const r = (3 + Math.sqrt(sp.cap) / 4.4) * this.zf * (sp.n > 2 ? 1.25 : 0.95);
    return [x + sp.dx * r, y + sp.dy * r];
  }
  toScreen(p) { return [p[0] * this.view.s + this.view.ox, p[1] * this.view.s + this.view.oy]; }
  toWorld(x, y) { return [(x - this.view.ox) / this.view.s, (y - this.view.oy) / this.view.s]; }
  get zf() { return clamp(Math.sqrt(this.view.s / this.s0), 0.75, 2.4); }

  _bindPointer() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY > 0 ? 1 / 1.18 : 1.18);
    }, { passive: false });
    c.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.view.ox = drag.ox + dx; this.view.oy = drag.oy + dy; this.staticDirty = true;
          c.style.cursor = "grabbing"; this.handlers.hover(null, mx, my); return;
        }
      }
      const hit = this.hitTest(mx, my);
      c.style.cursor = hit ? "pointer" : "grab";
      this.handlers.hover(hit, mx, my);
    });
    c.addEventListener("pointerup", (e) => {
      const r = c.getBoundingClientRect();
      if (drag && !drag.moved) this.handlers.click(this.hitTest(e.clientX - r.left, e.clientY - r.top));
      drag = null; c.style.cursor = "grab";
    });
    c.addEventListener("pointerleave", () => this.handlers.hover(null, 0, 0));
    c.addEventListener("dblclick", (e) => {
      const r = c.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, 1.6);
    });
  }

  // ------------------------------------------------------------------ static layer
  _drawStatic() {
    const c = this.staticCanvas, g = c.getContext("2d"), { s, ox, oy } = this.view, d = this.dpr;
    c.width = this.canvas.width; c.height = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#0b1020"; g.fillRect(0, 0, c.width, c.height);
    g.setTransform(d * s, 0, 0, d * s, d * ox, d * oy);
    g.lineJoin = "round";
    g.fillStyle = "#10162a"; g.strokeStyle = "#1d2746"; g.lineWidth = 0.8 / s;
    for (const p of this.neighPaths) { g.fill(p); g.stroke(p); }
    g.strokeStyle = "rgba(63,169,255,0.05)"; g.lineWidth = 16 / s; g.stroke(this.landPath);
    g.strokeStyle = "rgba(63,169,255,0.08)"; g.lineWidth = 7 / s; g.stroke(this.landPath);
    g.fillStyle = "#141b2f"; g.fill(this.landPath);
    g.strokeStyle = "#2d3e69"; g.lineWidth = 1 / s; g.stroke(this.landPath);
  }

  // ------------------------------------------------------------------ frame
  // F: built by the app each frame (see app.js frame()).
  draw(F) {
    const ctx = this.ctx, d = this.dpr;
    this.lastF = F;
    if (this.staticDirty) { this._drawStatic(); this.staticDirty = false; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    this.hits = [];
    const show = F.show;
    if (show.tint && F.sunElev) this._tint(F);
    if (F.selected?.kind === "boundary") this._side(F);
    if (show.haze && F.R) this._haze(F);
    if (show.demand && F.R) this._demand(F);
    if (show.haze || show.embWind) this._embedded(F);
    if (show.hvdc) this._hvdc(F);
    if (show.interconnector) this._cables(F);
    this._exportCables(F);
    if (show.boundaries) this._boundaries(F);
    this._assets(F);
    this._smoke(F);
    if (show.wind) this._wind(F);
    if (show.clouds) this._clouds(F);
    this.labelRects = [];
    if (show.boundaries) this._boundaryLabels(F);
    if (show.interconnector) this._chips(F);
    this._selection(F);
  }

  alpha(F, key) { return F.solo && F.solo !== key && key !== "boundaries" ? 0.1 : 1; }
  st(id) { let a = this.anim.get(id); if (!a) { a = { angle: Math.random() * TAU, phase: Math.random(), dash: 0, pulse: 0 }; this.anim.set(id, a); } return a; }

  _tint(F) {
    const ctx = this.ctx, W = this.w, H = this.h;
    const night = ctx.createLinearGradient(0, 0, W, 0), day = ctx.createLinearGradient(0, 0, W, 0), warm = ctx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= 8; i++) {
      const [lon] = unproj(this.toWorld(W * i / 8, 0)[0], 0);
      const e = F.sunElev(lon);
      const dark = e < 0 ? clamp(-e / 10, 0, 1) : 0;
      night.addColorStop(i / 8, `rgba(2,4,14,${(0.24 * dark).toFixed(3)})`);
      day.addColorStop(i / 8, `rgba(150,180,230,${(e > 0 ? 0.15 * clamp(e / 40, 0, 1) : 0).toFixed(3)})`);
      warm.addColorStop(i / 8, `rgba(255,135,60,${(0.17 * Math.exp(-(((e - 1) / 5) ** 2))).toFixed(3)})`);
    }
    ctx.fillStyle = night; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = day; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = warm; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }

  _side(F) {
    const path = this.sides[F.selected.id];
    if (!path) return;
    const ctx = this.ctx, { s, ox, oy } = this.view, b = F.B?.[F.selected.id];
    const col = PALETTES[F.palette][boundaryState(b).key];
    ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s);
    ctx.globalAlpha = 0.13; ctx.fillStyle = col; ctx.fill(path);
    ctx.restore();
  }

  _haze(F) {
    const ctx = this.ctx, s = this.view.s, a = this.alpha(F, "solar");
    ctx.globalCompositeOperation = "screen";
    for (const r of this.regions) {
      const cf = F.R[r.id]?.solarCF || 0;
      if (cf < 0.01) continue;
      const [x, y] = this.toScreen(r.pos), rad = (28 + 280 * Math.sqrt(r.emb_solar_share)) * s;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(255,216,77,${(0.34 * cf * a).toFixed(3)})`); g.addColorStop(1, "rgba(255,216,77,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // Distribution-connected farms: small, faded, display only. Animated from their region's
  // embedded output per MW (the dispatch only knows the regional total).
  _embedded(F) {
    const ctx = this.ctx, zf = this.zf, t = F.time;
    if (!this.embedded.length) return;
    for (const e of this.embedded) {
      if (e.tech === "solar" ? !F.show.haze : !F.show.embWind) continue;
      const [x, y] = this.toScreen(e.pos);
      if (x < -10 || y < -10 || x > this.w + 10 || y > this.h + 10) continue;
      const size = (1.6 + Math.sqrt(e.capacity_mw) / 4.2) * zf, a0 = this.alpha(F, e.tech) * 0.6;
      const reg = F.R?.[e.region];
      this.hits.push({ kind: "embedded", id: e.id, x, y, r: size + 2, prio: 3 });
      ctx.globalAlpha = a0;
      if (e.tech === "solar") {
        const cf = reg ? Math.min(1, reg.solarCF) : 0.3;
        if (cf > 0.05) {
          const g = ctx.createRadialGradient(x, y, 0, x, y, size * (1 + 2 * cf));
          g.addColorStop(0, `rgba(255,216,77,${0.5 * cf})`); g.addColorStop(1, "rgba(255,216,77,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, size * (1 + 2 * cf), 0, TAU); ctx.fill();
        }
        ctx.fillStyle = "#2a3f6e"; ctx.strokeStyle = "#ffd84d"; ctx.lineWidth = 0.8;
        ctx.fillRect(x - size * 0.6, y - size * 0.4, size * 1.2, size * 0.8); ctx.strokeRect(x - size * 0.6, y - size * 0.4, size * 1.2, size * 0.8);
      } else {
        const st = this.st(e.id), cf = reg ? Math.min(1, reg.windCF) : 0.3;
        st.angle += F.dt * TAU * 1.1 * cf;
        drawTurbine(ctx, x, y, size * 1.3, st.angle, TECH.wind_onshore.color, a0);
      }
      ctx.globalAlpha = 1;
    }
  }

  _demand(F) {
    const ctx = this.ctx, s = this.view.s;
    for (const r of this.regions) {
      const dmw = F.R[r.id]?.demand || 0, [x, y] = this.toScreen(r.pos), rad = (2 + Math.sqrt(dmw) / 3.2) * s;
      ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill(); ctx.stroke();
      this.hits.push({ kind: "region", id: r.id, x, y, r: Math.max(6, rad), prio: 0 });
    }
  }

  _cable(a, c, b, base, width, dash, color, alpha) {
    const ctx = this.ctx;
    ctx.beginPath(); ctx.moveTo(...a); ctx.quadraticCurveTo(...c, ...b);
    ctx.globalAlpha = alpha; ctx.strokeStyle = base; ctx.lineWidth = width; ctx.setLineDash([]); ctx.stroke();
    if (dash != null) {
      ctx.setLineDash([5, 9]); ctx.lineDashOffset = dash; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.4, width * 0.8); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  _cables(F) {
    const a0 = this.alpha(F, "interconnector");
    for (const ic of this.ics) {
      const future = ic.status === "future";
      if (future && !F.show.future) continue;
      const a = this.toScreen(ic.a), b = this.toScreen(ic.b), c = this.toScreen(ic.ctrl);
      const width = 1 + ic.capacity_mw / 900;
      if (future) {
        this.ctx.setLineDash([3, 6]); this._cable(a, c, b, "rgba(230,230,230,0.35)", 1.2, null, null, a0); this.ctx.setLineDash([]);
      } else {
        const mw = F.IC ? F.IC[ic.id] : null, excl = F.IC && mw == null;
        const st = this.st("ic:" + ic.id);
        if (mw != null && Math.abs(mw) > 1) {
          // dashes travel towards the receiving end: imports flow far end -> GB (towards path start)
          st.dash += Math.sign(mw) * (10 + 70 * Math.abs(mw) / ic.capacity_mw) * F.dt;
        }
        this._cable(a, c, b, excl ? "rgba(120,130,160,0.25)" : "rgba(230,230,230,0.22)", width,
          mw != null && Math.abs(mw) > 1 ? st.dash : null, "#f2f2f2", a0 * (excl ? 0.4 : 1));
      }
      // hit samples
      const pts = []; for (let i = 0; i <= 16; i++) pts.push(quad(a, c, b, i / 16));
      this.hits.push({ kind: "ic", id: ic.id, pts, prio: 1 });
    }
  }

  _hvdc(F) {
    const a0 = this.alpha(F, "interconnector");
    for (const h of this.hvdc) {
      const future = h.status === "future";
      if (future && !F.show.future) continue;
      const a = this.toScreen(h.a), b = this.toScreen(h.b), c = this.toScreen(h.ctrl);
      const mw = F.HV?.[h.id];
      const st = this.st("hv:" + h.id);
      if (mw != null && Math.abs(mw) > 1) st.dash -= Math.sign(mw) * (10 + 60 * Math.abs(mw) / h.capacity_mw) * F.dt;   // + = a -> b
      this.ctx.setLineDash(future ? [3, 6] : []);
      this._cable(a, c, b, future ? "rgba(193,140,255,0.35)" : "rgba(193,140,255,0.28)", future ? 1.2 : 1.6 + h.capacity_mw / 1500,
        !future && mw != null && Math.abs(mw) > 1 ? st.dash : null, "#d7b6ff", a0);
      const pts = []; for (let i = 0; i <= 16; i++) pts.push(quad(a, c, b, i / 16));
      this.hits.push({ kind: "hvdc", id: h.id, pts, prio: 1 });
    }
  }

  _exportCables(F) {
    const ctx = this.ctx;
    for (const as of this.assets) {
      if (!as.offshore || !F.show[as.tech]) continue;
      const v = F.A?.[as.id], a = this.assetXY(as), b = this.toScreen(as.conn), st = this.st(as.id);
      const frac = v ? clamp(v.p / as.capacity_mw, 0, 1) : 0;
      st.dash -= (frac > 0.01 ? 6 + 40 * frac : 0) * F.dt;             // towards the shore
      ctx.globalAlpha = 0.5 * this.alpha(F, as.tech);
      ctx.strokeStyle = TECH[as.tech].color; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.lineDashOffset = st.dash;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  _boundaryVisible(F, b) {
    if (!b.configured) return F.show.allBoundaries;
    return b.core || F.show.allBoundaries;
  }

  _boundaries(F) {
    const ctx = this.ctx, d = this.dpr, { s, ox, oy } = this.view, pal = PALETTES[F.palette];
    ctx.save(); ctx.setTransform(d * s, 0, 0, d * s, d * ox, d * oy);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const b of this.boundaries) {
      if (!this._boundaryVisible(F, b)) continue;
      if (!b.configured) {
        ctx.globalAlpha = 0.5; ctx.strokeStyle = "#56628a"; ctx.lineWidth = 1 / s; ctx.setLineDash([2 / s, 4 / s]);
        ctx.stroke(b.path); ctx.setLineDash([]); continue;
      }
      const live = F.B?.[b.name], { key } = boundaryState(live), col = pal[key], sty = STYLE[key];
      const st = this.st("b:" + b.name);
      let pulse = 1;
      if (key === "con") {
        const over = clamp(Math.abs(live.unc) / live.cap, 1, 3);
        st.pulse += F.dt * TAU * (0.5 + 1.1 * (over - 1));            // pulse rate ∝ overshoot
        pulse = 0.55 + 0.45 * Math.sin(st.pulse);
      }
      ctx.setLineDash(b.core ? [] : [8 / s, 6 / s]);
      ctx.strokeStyle = col;
      if (sty.glow > 0) {
        ctx.globalAlpha = 0.3 * sty.glow * pulse; ctx.lineWidth = 18 / s; ctx.stroke(b.path);
        ctx.globalAlpha = 0.5 * sty.glow * pulse; ctx.lineWidth = 8 / s; ctx.stroke(b.path);
      }
      if (key === "con") { ctx.shadowColor = col; ctx.shadowBlur = 12 * d; }
      ctx.globalAlpha = sty.a; ctx.lineWidth = sty.w / s; ctx.stroke(b.path);
      ctx.shadowBlur = 0;
    }
    ctx.restore(); ctx.setLineDash([]);
  }

  _boundaryLabels(F) {
    const ctx = this.ctx, pal = PALETTES[F.palette];
    ctx.textBaseline = "middle";
    for (const b of this.boundaries) {
      if (!this._boundaryVisible(F, b)) continue;
      const [x, y] = this.toScreen(b.label);
      const live = b.configured ? F.B?.[b.name] : null, { key } = boundaryState(live), col = b.configured ? pal[key] : "#56628a";
      // flow chevrons, pointing the way power physically moves
      if (live && F.show.chevrons && b.inPt && Math.abs(live.flow) > 50) {
        const [ix, iy] = this.toScreen(b.inPt), L = hypot(ix - x, iy - y) || 1;
        const inj = (b.positive === "import" ? -1 : 1) * live.flow;       // net injection inside
        const dir = inj > 0 ? -1 : 1, dx = dir * (ix - x) / L, dy = dir * (iy - y) / L;
        const n = clamp(Math.ceil(Math.abs(live.flow) / 2000), 1, 5), st = this.st("c:" + b.name);
        st.phase = (st.phase + F.dt * (0.15 + 0.6 * Math.min(1, Math.abs(live.flow) / 10000))) % 1;
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineCap = "round";
        for (let i = 0; i < n; i++) {
          const u = (st.phase + i / n) % 1, off = (u - 0.5) * 46, cx = x + dx * off, cy = y + dy * off;
          ctx.globalAlpha = Math.sin(u * Math.PI);
          ctx.beginPath();
          ctx.moveTo(cx - dx * 5 - dy * 5, cy - dy * 5 + dx * 5); ctx.lineTo(cx, cy); ctx.lineTo(cx - dx * 5 + dy * 5, cy - dy * 5 - dx * 5);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
      ctx.lineWidth = 3; ctx.strokeStyle = "#0b1020"; ctx.fillStyle = col; ctx.textAlign = "left";
      ctx.strokeText(b.name, x + 8, y - 10); ctx.fillText(b.name, x + 8, y - 10);
      if (live && live.binding) {
        // full wording when zoomed in; compact when the whole country is in view, to avoid a pile-up
        const over = `+${((Math.abs(live.unc) - live.cap) / 1000).toFixed(1)} GW`;
        const txt = this.view.s > this.s0 * 1.5 ? `⚠ CONSTRAINED ${over}` : `⚠ ${over}`;
        ctx.font = "700 10.5px 'Segoe UI', system-ui, sans-serif";
        const w = ctx.measureText(txt).width + 10;
        this.labelRects.push({ x: x + 6, y: y - 18, w: Math.max(w, 30), h: 36 });
        ctx.fillStyle = col; ctx.globalAlpha = 0.92; roundRect(ctx, x + 6, y + 2, w, 16, 4); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = "#fff"; ctx.fillText(txt, x + 11, y + 10);
      } else if (live && !live.enforced && Math.abs(live.flow) > live.cap) {
        ctx.font = "600 10px 'Segoe UI', system-ui, sans-serif"; ctx.fillStyle = col;
        ctx.fillText("over capability (not enforced)", x + 8, y + 6);
      }
      // hit polyline in screen space
      this.hits.push({ kind: "boundary", id: b.name, lines: b.lines, prio: 2, configured: b.configured });
    }
  }

  _assets(F) {
    const ctx = this.ctx, zf = this.zf, t = F.time;
    for (const as of this.assets) {
      if (!F.show[as.tech]) continue;
      const v = F.A ? F.A[as.id] : null, excluded = F.A && !v;
      const [x, y] = this.assetXY(as);
      if (x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) continue;
      const size = (3 + Math.sqrt(as.capacity_mw) / 4.4) * zf, col = TECH[as.tech].color, a0 = this.alpha(F, as.tech);
      this.hits.push({ kind: "asset", id: as.id, x, y, r: size + 3, prio: 5 });
      if (excluded) {
        ctx.globalAlpha = 0.45 * a0; ctx.strokeStyle = "#8a94b0"; ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, size * 0.7, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x - size * 0.4, y - size * 0.4); ctx.lineTo(x + size * 0.4, y + size * 0.4);
        ctx.moveTo(x + size * 0.4, y - size * 0.4); ctx.lineTo(x - size * 0.4, y + size * 0.4); ctx.stroke();
        ctx.globalAlpha = 1; continue;
      }
      const frac = v ? clamp(Math.abs(v.p) / as.capacity_mw, 0, 1) : 0.5;
      const st = this.st(as.id);
      ctx.save(); ctx.globalAlpha = a0;
      switch (as.tech) {
        case "wind_offshore": case "wind_onshore": {
          st.angle += F.dt * TAU * 1.1 * (v ? clamp(v.p / as.capacity_mw, 0, 1) : 0.3);   // rotor speed ∝ output
          if (as.tech === "wind_offshore") {
            const s2 = size * 0.62;
            [[-0.75, 0.25, 0], [0.75, 0.25, 1.3], [0, -0.45, 2.6]].forEach(([dx, dy, ph]) =>
              drawTurbine(ctx, x + dx * size, y + dy * size, s2, st.angle + ph, col, a0));
          } else drawTurbine(ctx, x, y, size, st.angle, col, a0);
          break;
        }
        case "solar": {
          const gr = size * (0.6 + 2.2 * frac);
          const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
          g.addColorStop(0, `rgba(255,216,77,${0.55 * frac})`); g.addColorStop(1, "rgba(255,216,77,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
          const w = size * 1.3, h = size * 0.85;
          ctx.fillStyle = "#1b3566"; ctx.strokeStyle = col; ctx.lineWidth = 1;
          ctx.fillRect(x - w / 2, y - h / 2, w, h); ctx.strokeRect(x - w / 2, y - h / 2, w, h);
          ctx.beginPath(); ctx.moveTo(x, y - h / 2); ctx.lineTo(x, y + h / 2); ctx.moveTo(x - w / 2, y); ctx.lineTo(x + w / 2, y); ctx.stroke();
          if (frac > 0.55) {                                            // sun-glint shimmer at high output
            const u = (t * 0.6 + st.phase) % 1, sx = x - w / 2 + u * w;
            ctx.globalAlpha = a0 * (frac - 0.5) * 1.6 * Math.sin(u * Math.PI);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(sx - 2, y + h / 2); ctx.lineTo(sx + 2, y - h / 2); ctx.stroke();
          }
          break;
        }
        case "ccgt": case "ocgt": case "biomass": {
          const cw = size * (as.tech === "ocgt" ? 0.42 : 0.5), ch = size * (as.tech === "ocgt" ? 0.9 : 1.15);
          const top = y + size * 0.6 - ch;
          const on = v ? v.p / as.capacity_mw > 0.02 : true;
          if (on) {
            const flick = as.tech === "ocgt" ? 0.25 : 0.12;
            const fh = size * (0.25 + 1.35 * frac) * (1 + flick * Math.sin(t * 13 + st.phase * 9) * Math.sin(t * 7.3));
            const fw = cw * 1.05;
            const fc = as.tech === "biomass" ? ["#d8ff9a", col] : ["#fff2b0", col];
            const g = ctx.createLinearGradient(0, top, 0, top - fh);
            g.addColorStop(0, fc[0]); g.addColorStop(0.45, fc[1]); g.addColorStop(1, "rgba(255,90,40,0.1)");
            ctx.shadowColor = col; ctx.shadowBlur = 8 * frac;
            ctx.fillStyle = g; flamePath(ctx, x, top + 1, fw, fh); ctx.fill(); ctx.shadowBlur = 0;
            if (v && v.ramp > 0.06 * as.capacity_mw && Math.random() < F.dt * 6) {     // smoke puffs when ramping up
              this.smoke.push({ x: as.pos[0], y: as.pos[1], off: [0, -(ch + fh * 0.3) / this.view.s], age: 0, life: 2.2, r: size * 0.25 });
            }
          }
          ctx.fillStyle = on ? "#3a4462" : "#2a3045"; ctx.strokeStyle = on ? "#69759c" : "#454c63"; ctx.lineWidth = 1;
          ctx.fillRect(x - cw / 2, top, cw, ch); ctx.strokeRect(x - cw / 2, top, cw, ch);
          break;
        }
        case "nuclear": {
          const pulse = 0.85 + 0.15 * Math.sin(t * 2 + st.phase * TAU);
          const gr = size * 1.7 * pulse;
          const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
          g.addColorStop(0, `rgba(193,140,255,${0.75 * frac})`); g.addColorStop(1, "rgba(193,140,255,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = a0 * (0.4 + 0.6 * frac);
          for (let k = 0; k < 3; k++) {
            ctx.beginPath(); ctx.ellipse(x, y, size * 0.85, size * 0.32, t * 0.4 + k * Math.PI / 3, 0, TAU); ctx.stroke();
          }
          ctx.globalAlpha = a0; ctx.fillStyle = "#f3e8ff"; ctx.beginPath(); ctx.arc(x, y, size * 0.2, 0, TAU); ctx.fill();
          break;
        }
        case "pumped_storage": {
          const soc = v && v.soc != null ? clamp(v.soc / (as.energy_mwh || 1), 0, 1) : 0.5;
          const wt = size * 1.6, wb = size * 1.0, h = size * 1.15, top = y - h / 2;
          ctx.beginPath(); ctx.moveTo(x - wt / 2, top); ctx.lineTo(x + wt / 2, top); ctx.lineTo(x + wb / 2, top + h); ctx.lineTo(x - wb / 2, top + h); ctx.closePath();
          ctx.fillStyle = "#0f1a36"; ctx.fill();
          ctx.save(); ctx.clip();
          ctx.fillStyle = col; ctx.fillRect(x - wt, top + h * (1 - soc), wt * 2, h * soc);
          ctx.restore();
          ctx.strokeStyle = "#8fb3ff"; ctx.lineWidth = 1.2; ctx.stroke();
          if (v && Math.abs(v.p) > 0.01 * as.capacity_mw) {             // pumping up (charging) or flowing down
            const up = v.p < 0, sp = 0.4 + 1.6 * Math.abs(v.p) / as.capacity_mw;
            st.phase = (st.phase + F.dt * sp) % 1;
            const ax = x + wt / 2 + 5;
            ctx.fillStyle = up ? "#7ee8ff" : "#3d7bff";
            for (let k = 0; k < 2; k++) {
              const u = (st.phase + k / 2) % 1, ay = up ? top + h - u * h : top + u * h;
              ctx.globalAlpha = a0 * Math.sin(u * Math.PI);
              ctx.beginPath();
              if (up) { ctx.moveTo(ax, ay - 3.5); ctx.lineTo(ax - 3, ay + 2); ctx.lineTo(ax + 3, ay + 2); }
              else { ctx.moveTo(ax, ay + 3.5); ctx.lineTo(ax - 3, ay - 2); ctx.lineTo(ax + 3, ay - 2); }
              ctx.fill();
            }
          }
          break;
        }
        case "battery": {
          const energy = as.energy_mwh || as.capacity_mw * 2;
          const soc = v && v.soc != null ? clamp(v.soc / energy, 0, 1) : 0.5;
          if (v && Math.abs(v.p) > 0.01 * as.capacity_mw) {
            const charging = v.p < 0, rate = 0.5 + 1.5 * Math.abs(v.p) / as.capacity_mw;
            st.phase = (st.phase + F.dt * rate) % 1;
            const u = charging ? 1 - st.phase : st.phase, rr = size * (0.9 + 1.4 * u);
            ctx.globalAlpha = a0 * (charging ? u : 1 - u) * 0.9;
            ctx.strokeStyle = charging ? "#2ee6a6" : "#ff9f43"; ctx.lineWidth = 1.6;
            ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.stroke();
            ctx.globalAlpha = a0;
          }
          const bw = size * 0.85, bh = size * 1.4;
          roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, 2); ctx.fillStyle = "#0e2a24"; ctx.fill();
          ctx.save(); ctx.clip(); ctx.fillStyle = col; ctx.fillRect(x - bw / 2, y + bh / 2 - bh * soc, bw, bh * soc); ctx.restore();
          ctx.strokeStyle = "#bff7e4"; ctx.lineWidth = 1; roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, 2); ctx.stroke();
          ctx.fillStyle = "#bff7e4"; ctx.fillRect(x - bw * 0.2, y - bh / 2 - 2, bw * 0.4, 2);
          break;
        }
      }
      // constraint-action badges: ▼ turned down, ▲ turned up
      if (v && Math.abs(v.action) > Math.max(5, 0.02 * as.capacity_mw)) {
        const down = v.action < 0, bx = x + size * 0.95, by = y - size * 0.8;
        ctx.globalAlpha = a0;
        ctx.fillStyle = down ? PALETTES[F.palette].con : "#ffffff";
        ctx.beginPath();
        if (down) { ctx.moveTo(bx - 4, by - 3); ctx.lineTo(bx + 4, by - 3); ctx.lineTo(bx, by + 4); }
        else { ctx.moveTo(bx - 4, by + 3); ctx.lineTo(bx + 4, by + 3); ctx.lineTo(bx, by - 4); }
        ctx.fill();
      }
      ctx.restore();
    }
  }

  _smoke(F) {
    const ctx = this.ctx, wind = F.windVis || 0.3;
    this.smoke = this.smoke.filter((p) => (p.age += F.dt) < p.life);
    for (const p of this.smoke) {
      const [x, y] = this.toScreen([p.x + p.off[0], p.y + p.off[1]]), u = p.age / p.life;
      ctx.globalAlpha = 0.35 * (1 - u);
      ctx.fillStyle = "#9aa3b8";
      ctx.beginPath(); ctx.arc(x + u * 30 * wind * this.zf, y - u * 22 * this.zf, p.r * (1 + 2 * u), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _wind(F) {
    const ctx = this.ctx, w = F.windVis, s = this.view.s, t = F.time;
    const target = Math.round(clamp(this.w * this.h / 2200, 150, 650));
    const [wx0, wy0] = this.toWorld(0, 0), [wx1, wy1] = this.toWorld(this.w, this.h);
    const spawn = (p) => { p.x = wx0 + Math.random() * (wx1 - wx0); p.y = wy0 + Math.random() * (wy1 - wy0); p.age = 0; p.life = 1.5 + Math.random() * 3; return p; };
    while (this.particles.length < target) this.particles.push(spawn({}));
    this.particles.length = target;
    if (w < 0.02) return;
    ctx.lineCap = "round"; ctx.lineWidth = 1.1; ctx.strokeStyle = "#dbe9ff";
    for (const p of this.particles) {
      p.age += F.dt;
      if (p.age > p.life || p.x < wx0 || p.x > wx1 || p.y < wy0 || p.y > wy1) spawn(p);
      const ang = -0.35 + 0.45 * Math.sin(p.y * 0.006 + t * 0.08) + 0.3 * Math.cos(p.x * 0.007 - t * 0.05);
      const land = this.isLand(p.x, p.y), lat = LAT0 - p.y / K;
      const fac = land ? (lat > 55.3 ? 1.0 : 0.7) : 1.3;               // stronger over the sea and Scotland
      const sp = (3 + 55 * w) * fac;
      const vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;
      p.x += vx * F.dt; p.y += vy * F.dt;
      const [x, y] = this.toScreen([p.x, p.y]), tl = 0.35;
      const fade = Math.sin(clamp(p.age / p.life, 0, 1) * Math.PI);
      ctx.globalAlpha = (0.08 + 0.32 * w) * fade;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - vx * tl * s, y - vy * tl * s); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _clouds(F) {
    const ctx = this.ctx, s = this.view.s, cloud = F.cloud ?? 0;
    const [bx0, by0] = proj(-14, 62.5), [bx1, by1] = proj(12, 48);
    const n = Math.round(cloud * 34);
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    while (this.clouds.length < 34) this.clouds.push({ x: bx0 + rnd() * (bx1 - bx0), y: by0 + rnd() * (by1 - by0), sc: 0.8 + rnd() * 1.6, k: Math.floor(rnd() * 4) });
    if (n === 0) return;
    const drift = (2 + 30 * (F.windVis || 0)) * F.dt;                  // drift speed ∝ wind
    ctx.globalAlpha = 0.07 + 0.17 * cloud;
    for (let i = 0; i < n; i++) {
      const c = this.clouds[i];
      c.x += drift; c.y -= drift * 0.25;
      if (c.x > bx1) c.x = bx0; if (c.y < by0) c.y = by1;
      const [x, y] = this.toScreen([c.x, c.y]), w = 256 * 0.55 * c.sc * s, h = 140 * 0.55 * c.sc * s;
      if (x > this.w + w || y > this.h + h || x < -w * 2 || y < -h * 2) continue;
      ctx.drawImage(this.cloudSprites[c.k], x - w / 2, y - h / 2, w, h);
    }
    ctx.globalAlpha = 1;
  }

  _chips(F) {
    const ctx = this.ctx, placed = [...this.labelRects], zoomed = this.view.s > this.s0 * 1.7;
    ctx.font = "600 10.5px 'Segoe UI', system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const cands = [[10, -14], [10, 6], [-10, -14], [-10, 6], [10, -32], [10, 24], [-10, -32], [-10, 24], [10, -50], [10, 42]];
    for (const ic of this.ics) {
      if (ic.status === "future" && !F.show.future) continue;
      const [x, y] = this.toScreen(ic.b), mw = F.IC ? F.IC[ic.id] : null;
      let txt = zoomed ? `${ic.name} · ${ic.gb_site.split(",")[0]} ⇄ ${ic.far_site.split(",")[0]} (${ic.far_country}) · ${(ic.capacity_mw / 1000).toFixed(1)} GW`
        : `${ic.name} · ${(ic.capacity_mw / 1000).toFixed(1)} GW`;
      if (ic.status === "future") txt += " (future)";
      let flow = "";
      if (mw != null && Math.abs(mw) > 1) flow = mw > 0 ? ` ▸GB ${(mw / 1000).toFixed(1)}` : ` GB▸ ${(-mw / 1000).toFixed(1)}`;
      const w = ctx.measureText(txt + flow).width + 30, h = 18;
      let best = null;
      for (const [dx, dy] of cands) {
        const rx = dx > 0 ? x + dx : x + dx - w, ry = y + dy;
        if (!placed.some((p) => rx < p.x + p.w + 2 && rx + w + 2 > p.x && ry < p.y + p.h + 2 && ry + h + 2 > p.y)) { best = { x: rx, y: ry, w, h }; break; }
      }
      if (!best) best = { x: x + 10, y: y - 14, w, h };
      placed.push(best);
      const a0 = this.alpha(F, "interconnector");
      ctx.globalAlpha = 0.9 * a0;
      ctx.strokeStyle = "rgba(230,230,230,0.35)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(best.x + (best.x > x ? 0 : w), best.y + h / 2); ctx.stroke();
      ctx.fillStyle = "rgba(14,20,38,0.92)"; roundRect(ctx, best.x, best.y, w, h, 4); ctx.fill();
      ctx.strokeStyle = mw == null ? "#46506e" : mw > 1 ? "#7ee8c7" : mw < -1 ? "#ffb020" : "#46506e"; ctx.stroke();
      const flag = this.flags[ic.far_country];
      if (flag && flag.complete && flag.naturalWidth) ctx.drawImage(flag, best.x + 5, best.y + 4, 15, 10);
      ctx.fillStyle = "#e6ebf7"; ctx.fillText(txt, best.x + 24, best.y + h / 2 + 0.5);
      if (flow) { ctx.fillStyle = mw > 0 ? "#7ee8c7" : "#ffb020"; ctx.fillText(flow, best.x + 24 + ctx.measureText(txt).width, best.y + h / 2 + 0.5); }
      ctx.fillStyle = "#e6e6e6"; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      this.hits.push({ kind: "ic", id: ic.id, rect: best, prio: 4 });
    }
  }

  _selection(F) {
    const sel = F.selected;
    if (!sel || sel.kind !== "asset") return;
    const as = this.assets.find((a) => a.id === sel.id);
    if (!as) return;
    const [x, y] = this.assetXY(as), r = (3 + Math.sqrt(as.capacity_mw) / 4.4) * this.zf + 7;
    const ctx = this.ctx;
    ctx.strokeStyle = "#ffffff"; ctx.globalAlpha = 0.6 + 0.3 * Math.sin(F.time * 4); ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    if (as.offshore) {
      const [cx, cy] = this.toScreen(as.conn);
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ hit test
  hitTest(mx, my) {
    let best = null, bestScore = Infinity;
    for (const h of this.hits) {
      let d = Infinity;
      if (h.r != null) d = hypot(mx - h.x, my - h.y) - h.r;
      else if (h.rect) d = mx >= h.rect.x && mx <= h.rect.x + h.rect.w && my >= h.rect.y && my <= h.rect.y + h.rect.h ? -1 : Infinity;
      else if (h.pts) { for (let i = 1; i < h.pts.length; i++) d = Math.min(d, segDist(mx, my, ...h.pts[i - 1], ...h.pts[i]) - 5); }
      else if (h.lines) {
        if (!h.configured) continue;
        for (const l of h.lines) {
          let prev = this.toScreen(l[0]);
          for (let i = 1; i < l.length; i++) { const cur = this.toScreen(l[i]); d = Math.min(d, segDist(mx, my, ...prev, ...cur) - 6); prev = cur; }
        }
      }
      if (d > 0) continue;
      const score = -h.prio * 100 + d;
      if (score < bestScore) { bestScore = score; best = h; }
    }
    return best ? { kind: best.kind, id: best.id } : null;
  }
}
