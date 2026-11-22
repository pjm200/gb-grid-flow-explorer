// Guided missions (spec 4.5). Each check receives a context object from the app.
import { esc, store } from "./common.js";

const KEY = "gbgfe.missions.v1";

export const MISSIONS = [
  {
    id: "b6red", title: "Turn B6 red",
    task: "Find a weather setting where the Anglo-Scottish boundary (B6) constrains.",
    hint: "Scotland has lots of wind and not much demand. Go back to the weather page and drag the handle up towards a gale.",
    check: (c) => c.sim && c.sim.summary.binding_periods.B6 > 0,
    why: () => "B6 is the main route from Scotland into England. On a windy day Scottish wind farms produce far more than Scotland uses, and the surplus has to squeeze through a 6.7 GW corridor. When the surplus is bigger than that, wind behind B6 is turned down and gas in England is turned up, and the difference in cost is the constraint cost.",
  },
  {
    id: "rescue", title: "Rescue the wind",
    task: "Find a day where B4 is constrained, then switch off all batteries (the power button on the Batteries layer) and compare the curtailed GWh.",
    hint: "Use a breezy day, about half-way up the pad (the Breezy spring-like day preset works). In a full gale the boundaries stay red all day, so batteries behind them never get a chance to empty and make little difference. Then click the power button next to Batteries; the toast shows the change.",
    check: (c) => {
      for (const on of c.history) {
        if (on.batteryOff || !on.b4) continue;
        const off = c.history.find((h) => h.batteryOff && h.weather === on.weather);
        if (off) { c.found = { on, off }; return true; }
      }
      return false;
    },
    why: (c) => {
      const f = c.found;
      const nums = f ? ` This time: ${f.on.curtailed.toFixed(1)} GWh curtailed with batteries, ${f.off.curtailed.toFixed(1)} GWh without.` : "";
      return "Batteries behind a constraint can soak up power that cannot get across the boundary and release it later, when the line has room. Without them more wind has to be switched off. Storage does not raise the boundary's capability; it moves energy to a time when there is space, which is why it helps most when the constraint comes and goes, and hardly at all when it lasts all day." + nums;
    },
  },
  {
    id: "ec5", title: "Light up East Anglia",
    task: "Make the East Anglia boundary (EC5) constrain.",
    hint: "East Anglia ONE, Greater Gabbard and Galloper land at Bramford and Leiston, right beside Sizewell B. Try a windy day.",
    check: (c) => c.sim && c.sim.summary.binding_periods.EC5 > 0,
    why: () => "East Anglia has big offshore wind farms and Sizewell B nuclear station, but only a 2.3 GW route out to the rest of the network. Local demand is small, so on a windy day most of that power has to leave through EC5 and the limit is reached quickly.",
  },
  {
    id: "reverse", title: "Reverse the flow",
    task: "Find a winter evening (16:00–20:00) where B6 flows south-to-north, from England into Scotland.",
    hint: "Choose the Winter dunkelflaute preset, then scrub the timeline to the evening and watch the chevrons on B6.",
    check: (c) => {
      if (!c.sim || c.req.season !== "winter" || c.period == null) return false;
      const hr = c.period / 2;
      return hr >= 16 && hr < 20 && c.sim.periods[c.period].boundaries.B6.flow < -100;
    },
    why: () => "With no wind, Scotland has little to export. At the evening peak Scottish demand is more than Scottish nuclear, gas and storage produce, so power flows north from England across B6. Boundaries are limits in both directions, and the flow follows wherever the surplus is.",
  },
  {
    id: "evening", title: "The evening peak",
    task: "On a winter day, play through 16:30 to 19:30 and watch total storage state of charge fall.",
    hint: "Run any winter day, jump to about 16:00 and press Play. Watch the Storage SoC counter on the right.",
    check: (c) => {
      if (!c.sim || c.req.season !== "winter") return false;
      for (let p = 33; p <= 38; p++) if (!c.playedPeriods.has(p)) return false;
      return c.sim.periods[38].totals.soc_total < c.sim.periods[33].totals.soc_total - 100;
    },
    why: () => "Storage charges when power is cheap, overnight or when the wind is strong, and empties during the 16:30–19:30 peak, when gas would otherwise have to run harder. It shifts energy in time and lowers the cost of the peak.",
  },
  {
    id: "ireland", title: "Ireland and Wales",
    task: "See how Greenlink and EWIC exports affect NW4 and SW1: open the card for one of those interconnectors, then the card for NW4 or SW1.",
    hint: "Click the cables running west to Ireland from Pembroke (Greenlink) and Deeside (EWIC), then click the NW4 or SW1 boundary.",
    check: (c) => (c.cards.has("ic:greenlink") || c.cards.has("ic:ewic")) && (c.cards.has("boundary:NW4") || c.cards.has("boundary:SW1")),
    why: () => "EWIC lands at Connah's Quay inside NW4, and Greenlink at Pembroke inside SW1. Exporting to Ireland uses power inside those areas, which reduces what has to flow out across NW4 and SW1. Interconnectors can relieve a constraint or make it worse, depending on where they land and which way they flow.",
  },
];

export class Missions {
  constructor(root, countEl, onComplete) {
    this.root = root; this.countEl = countEl; this.onComplete = onComplete;
    this.done = store.get(KEY, {});            // id -> why text
    this.open = null;
    this.render();
  }
  evaluate(ctx) {
    for (const m of MISSIONS) {
      if (this.done[m.id]) continue;
      let ok = false;
      try { ok = m.check(ctx); } catch (e) { ok = false; }
      if (ok) {
        this.done[m.id] = m.why(ctx);
        store.set(KEY, this.done);
        this.open = m.id;
        this.onComplete(m, this.done[m.id]);
        this.render();
      }
    }
  }
  reset() { this.done = {}; store.set(KEY, this.done); this.render(); }
  render() {
    const n = Object.keys(this.done).length;
    this.countEl.textContent = `${n}/${MISSIONS.length}`;
    this.root.innerHTML = MISSIONS.map((m, i) => {
      const done = !!this.done[m.id], open = this.open === m.id;
      return `<div class="mission ${done ? "done" : ""} ${open ? "open" : ""}" data-id="${m.id}">
        <div class="m-head"><span class="m-tick">${done ? "✓" : i + 1}</span><span class="m-title">${esc(m.title)}</span></div>
        <div class="m-body"><p>${esc(m.task)}</p>${done ? `<p class="m-why"><b>Why:</b> ${esc(this.done[m.id])}</p>` : `<p class="m-hint"><b>Hint:</b> ${esc(m.hint)}</p>`}</div>
      </div>`;
    }).join("") + `<button class="link small" id="missionReset">Reset missions</button>`;
    this.root.querySelectorAll(".m-head").forEach((h) => h.addEventListener("click", () => {
      const id = h.parentElement.dataset.id; this.open = this.open === id ? null : id; this.render();
    }));
    this.root.querySelector("#missionReset").addEventListener("click", () => this.reset());
  }
}
