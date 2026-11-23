// API adapter for the GitHub Pages build. The local tool's FastAPI server answers api/...
// requests; on a static host this module answers them instead:
//   api/static            -> data/static.json (built by gridviz/build_site.py)
//   api/boundary/{id}     -> data/boundary/{id}.json
//   api/weather_preview   -> sunrise/sunset from data/static.json
//   api/simulate          -> the Python model running in a Web Worker (pyworker.js, Pyodide)
// Failures reject with an Error carrying .diag (stage, Python output, timings) for the report.
import { DIAGTEST } from "./common.js";

const STALL_MS = 90000;                       // no sign of progress for this long -> offer the report
let staticData = null, worker = null, nextId = 1;
const pending = new Map();
const status = { stage: null, text: "", lastActivity: 0, started: 0, stalled: false };
let stallHandler = null, stallTimer = null;

/** The page registers a callback for a start-up that hangs (a filter holding files for scanning). */
export function setStallHandler(fn) { stallHandler = fn; }
export function workerStatus() { return { ...status, pending: pending.size }; }

async function getStatic() {
  if (!staticData) {
    const res = await fetch("data/static.json");
    if (!res.ok) throw new Error(`data/static.json: HTTP ${res.status}`);
    staticData = await res.json();
  }
  return staticData;
}

function showProgress(text) {
  const el = document.getElementById("busy") || document.getElementById("overlayText");
  if (!el) return;
  if (el.id === "busy") { el.classList.remove("hidden"); el.innerHTML = `<span class="spinner"></span> ${text}`; }
  else el.textContent = text;
}

function stopWorker() {
  if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
  worker = null; clearInterval(stallTimer); stallTimer = null;
}

function failAll(err) { for (const p of pending.values()) p.reject(err); pending.clear(); }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./pyworker.js", import.meta.url));
  Object.assign(status, { stage: "start worker", text: "", lastActivity: Date.now(), started: Date.now(), stalled: false });
  worker.onmessage = (e) => {
    const m = e.data;
    status.lastActivity = Date.now();
    if (m.type === "activity") return;
    if (m.type === "progress") { status.stage = m.stage || status.stage; status.text = m.text; showProgress(m.text); return; }
    if (m.type === "error" && m.diag && m.diag.stage !== "solve") {             // a failed start: begin afresh next time
      stopWorker(); failAll(Object.assign(new Error(m.message), { diag: m.diag })); return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === "result") p.resolve(JSON.parse(m.json));
    else p.reject(Object.assign(new Error(m.message), { diag: m.diag }));
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    const message = e.message || "The Python worker could not start (the browser gave no reason).";
    const diag = { stage: status.stage || "start worker", message, name: "WorkerError",
      stack: e.filename ? `${e.filename}:${e.lineno || "?"}:${e.colno || "?"}` : "", output: [], stages: [], test: DIAGTEST };
    stopWorker();
    failAll(Object.assign(new Error(message), { diag }));
  };
  stallTimer = setInterval(() => {
    if (!pending.size || status.stalled || status.stage === "solve") return;
    if (Date.now() - status.lastActivity > STALL_MS) {
      status.stalled = true;
      if (stallHandler) stallHandler({ stage: status.stage, text: status.text, seconds: Math.round((Date.now() - status.started) / 1000) });
    }
  }, 5000);
  return worker;
}

export async function staticApi(path, body) {
  const p = path.replace(/^\.?\//, "");
  if (p === "api/static") return getStatic();
  if (p.startsWith("api/boundary/")) {
    const id = decodeURIComponent(p.slice("api/boundary/".length));
    const res = await fetch(`data/boundary/${encodeURIComponent(id)}.json`);
    if (!res.ok) throw new Error(`Unknown boundary '${id}'`);
    return res.json();
  }
  if (p.startsWith("api/weather_preview")) {
    const season = new URLSearchParams(p.split("?")[1] || "").get("season") === "summer" ? "summer" : "winter";
    return (await getStatic()).meta.sun[season];
  }
  if (p === "api/simulate") {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, body, diagtest: DIAGTEST });
    });
  }
  throw new Error(`${p} is not available in the static site`);
}
