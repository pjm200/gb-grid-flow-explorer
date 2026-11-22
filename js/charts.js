// Small canvas charts: the stacked generation chart (with scrubbing) and card sparklines.

export const MIX_LAYERS = [
  ["nuclear", "Nuclear", "#c18cff"], ["biomass", "Biomass", "#9be15d"], ["ccgt", "CCGT", "#ff8a3d"], ["ocgt", "OCGT", "#ff5a3d"],
  ["wind_offshore", "Offshore wind", "#4fd1ff"], ["wind_onshore", "Onshore wind", "#7ee8c7"], ["embedded_wind", "Embedded wind", "#4fae96"],
  ["solar", "Solar farms", "#ffd84d"], ["embedded_solar", "Embedded solar", "#b89a35"],
  ["pumped_storage", "Pumped storage", "#3d7bff"], ["battery", "Battery", "#2ee6a6"], ["imports", "Imports", "#d9dde8"],
];
export const NEG_LAYERS = [["ch_ps", "Pumped storage charging", "#3d7bff"], ["ch_bat", "Battery charging", "#2ee6a6"], ["exports", "Exports", "#d9dde8"]];

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  const w = Math.max(10, r.width), h = Math.max(10, r.height);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

export class StackChart {
  constructor(canvas, onScrub) {
    this.c = canvas; this.onScrub = onScrub; this.bg = document.createElement("canvas"); this.se = null;
    this.pad = { l: 42, r: 10, t: 8, b: 18 };
    let down = false;
    const scrub = (e) => {
      const r = this.c.getBoundingClientRect(), x = e.clientX - r.left;
      const t = (x - this.pad.l) / (this.w - this.pad.l - this.pad.r) * 48 - 0.5;
      this.onScrub(Math.max(0, Math.min(47.999, t)));
    };
    canvas.addEventListener("pointerdown", (e) => { down = true; canvas.setPointerCapture(e.pointerId); scrub(e); });
    canvas.addEventListener("pointermove", (e) => { if (down) scrub(e); });
    canvas.addEventListener("pointerup", () => (down = false));
  }
  resize() { this.render(); }
  setData(se) { this.se = se; this.render(); }
  x(t) { return this.pad.l + (t + 0.5) / 48 * (this.w - this.pad.l - this.pad.r); }
  y(v) { return this.pad.t + (this.vmax - v) / (this.vmax - this.vmin) * (this.h - this.pad.t - this.pad.b); }

  render() {
    const { ctx, w, h, dpr } = setup(this.c);
    this.w = w; this.h = h; this.dpr = dpr;
    this.bg.width = this.c.width; this.bg.height = this.c.height;
    const g = this.bg.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const se = this.se;
    if (!se) { this.blank = true; return; }
    this.blank = false;
    const T = 48, tot = se.tot;
    const pos = MIX_LAYERS.map(([k]) => tot.mix[k]);
    const neg = [tot.ch_ps, tot.ch_bat, tot.exports];
    let vmax = 0, vmin = 0;
    for (let t = 0; t < T; t++) {
      let p = 0, n = 0;
      pos.forEach((a) => (p += a[t])); neg.forEach((a) => (n += a[t]));
      vmax = Math.max(vmax, p + tot.curtailed[t], tot.demand[t]); vmin = Math.min(vmin, -n);
    }
    const step = 10000;
    this.vmax = Math.ceil(vmax / step) * step || step; this.vmin = Math.floor(vmin / step) * step;
    // grid
    g.font = "10px Consolas, 'Cascadia Mono', monospace"; g.fillStyle = "#7d89a8"; g.strokeStyle = "rgba(125,137,168,0.15)"; g.lineWidth = 1;
    g.textAlign = "right"; g.textBaseline = "middle";
    for (let v = this.vmin; v <= this.vmax; v += step) {
      const y = Math.round(this.y(v)) + 0.5;
      g.beginPath(); g.moveTo(this.pad.l, y); g.lineTo(w - this.pad.r, y); g.stroke();
      g.fillText(`${v / 1000} GW`, this.pad.l - 4, y);
    }
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    for (let hr = 0; hr <= 24; hr += 3) {
      const x = this.pad.l + hr / 24 * (w - this.pad.l - this.pad.r);
      g.fillText(`${String(hr).padStart(2, "0")}:00`, x, h - 4);
    }
    const xs = Array.from({ length: T }, (_, t) => this.x(t));
    const area = (lower, upper, color) => {
      g.beginPath();
      g.moveTo(this.pad.l, this.y(upper[0]));
      for (let t = 0; t < T; t++) g.lineTo(xs[t], this.y(upper[t]));
      g.lineTo(w - this.pad.r, this.y(upper[T - 1]));
      g.lineTo(w - this.pad.r, this.y(lower[T - 1]));
      for (let t = T - 1; t >= 0; t--) g.lineTo(xs[t], this.y(lower[t]));
      g.lineTo(this.pad.l, this.y(lower[0]));
      g.closePath(); g.fillStyle = color; g.fill();
    };
    let base = new Float32Array(T);
    MIX_LAYERS.forEach(([, , color], i) => {
      const top = base.map((b, t) => b + pos[i][t]);
      area(base, top, color); base = top;
    });
    // curtailed renewables: hatched ghost above the stack (energy that was available but not used)
    const hatch = document.createElement("canvas"); hatch.width = hatch.height = 6;
    const hg = hatch.getContext("2d"); hg.strokeStyle = "rgba(255,45,85,0.75)"; hg.lineWidth = 1.2;
    hg.beginPath(); hg.moveTo(0, 6); hg.lineTo(6, 0); hg.stroke();
    area(base, base.map((b, t) => b + tot.curtailed[t]), g.createPattern(hatch, "repeat"));
    let nb = new Float32Array(T);
    NEG_LAYERS.forEach(([, , color], i) => {
      const bot = nb.map((b, t) => b - neg[i][t]);
      g.globalAlpha = 0.75; area(bot, nb, color); g.globalAlpha = 1; nb = bot;
    });
    g.strokeStyle = "rgba(255,255,255,0.4)"; g.beginPath(); g.moveTo(this.pad.l, this.y(0)); g.lineTo(w - this.pad.r, this.y(0)); g.stroke();
    // demand line
    g.strokeStyle = "#ffffff"; g.lineWidth = 2; g.beginPath();
    g.moveTo(this.pad.l, this.y(tot.demand[0]));
    for (let t = 0; t < T; t++) g.lineTo(xs[t], this.y(tot.demand[t]));
    g.lineTo(w - this.pad.r, this.y(tot.demand[T - 1])); g.stroke();
  }

  draw(t) {
    const ctx = this.c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.c.width, this.c.height);
    if (this.blank) return;
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const x = this.x(t);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(x, this.pad.t); ctx.lineTo(x, this.h - this.pad.b); ctx.stroke();
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.moveTo(x - 5, this.pad.t); ctx.lineTo(x + 5, this.pad.t); ctx.lineTo(x, this.pad.t + 6); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// series: [{data, color, dash, width, fill, label}], opts: {t, band: number|null (±capability), zero, mark (Uint8Array)}
export function sparkline(canvas, series, opts = {}) {
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 34, r: 6, t: 6, b: 14 };
  let vmin = Infinity, vmax = -Infinity;
  series.forEach((s) => s.data.forEach((v) => { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }));
  if (opts.band) { vmin = Math.min(vmin, -opts.band); vmax = Math.max(vmax, opts.band); }
  if (opts.zero !== false) { vmin = Math.min(vmin, 0); vmax = Math.max(vmax, 0); }
  if (opts.min != null) vmin = Math.min(vmin, opts.min);
  if (opts.max != null) vmax = Math.max(vmax, opts.max);
  if (vmax - vmin < 1) vmax = vmin + 1;
  const span = vmax - vmin; vmax += span * 0.06; vmin -= opts.zero === false ? span * 0.06 : (vmin < 0 ? span * 0.06 : 0);
  const X = (t) => pad.l + (t + 0.5) / 48 * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (vmax - v) / (vmax - vmin) * (h - pad.t - pad.b);
  ctx.font = "9.5px Consolas, monospace"; ctx.fillStyle = "#7d89a8"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const unit = opts.unit || "GW", div = opts.div ?? 1000;
  [vmax, vmin].forEach((v) => ctx.fillText(`${(v / div).toFixed(Math.abs(v / div) < 10 ? 1 : 0)}`, pad.l - 3, Y(v)));
  ctx.fillText(unit, pad.l - 3, (Y(vmax) + Y(vmin)) / 2);
  ctx.textAlign = "center";
  [0, 6, 12, 18, 24].forEach((hr) => ctx.fillText(String(hr).padStart(2, "0"), pad.l + hr / 24 * (w - pad.l - pad.r), h - 5));
  if (opts.mark) {
    ctx.fillStyle = "rgba(255,45,85,0.18)";
    for (let t = 0; t < 48; t++) if (opts.mark[t]) ctx.fillRect(X(t) - (w - pad.l - pad.r) / 96, pad.t, (w - pad.l - pad.r) / 48, h - pad.t - pad.b);
  }
  ctx.lineWidth = 1;
  if (vmin < 0) { ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke(); }
  if (opts.band) {
    ctx.strokeStyle = "rgba(255,176,32,0.7)"; ctx.setLineDash([3, 3]);
    [opts.band, -opts.band].forEach((v) => { ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke(); });
    ctx.setLineDash([]);
  }
  for (const s of series) {
    ctx.beginPath();
    s.data.forEach((v, t) => (t ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
    if (s.fill) {
      ctx.save(); ctx.lineTo(X(47), Y(Math.max(vmin, 0))); ctx.lineTo(X(0), Y(Math.max(vmin, 0))); ctx.closePath();
      ctx.fillStyle = s.fill; ctx.fill(); ctx.restore();
      ctx.beginPath(); s.data.forEach((v, t) => (t ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6; ctx.setLineDash(s.dash || []); ctx.stroke(); ctx.setLineDash([]);
  }
  if (opts.t != null) {
    const x = X(opts.t);
    ctx.strokeStyle = "#fff"; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke(); ctx.globalAlpha = 1;
  }
}
