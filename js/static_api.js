// API adapter for the GitHub Pages build. The local tool's FastAPI server answers api/...
// requests; on a static host this module answers them instead:
//   api/static            -> data/static.json (built by gridviz/build_site.py)
//   api/boundary/{id}     -> data/boundary/{id}.json
//   api/weather_preview   -> sunrise/sunset from data/static.json
//   api/simulate          -> the Python model running in a Web Worker (pyworker.js, Pyodide)
let staticData = null, worker = null, nextId = 1;
const pending = new Map();

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

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./pyworker.js", import.meta.url));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") { showProgress(m.text); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === "result") p.resolve(JSON.parse(m.json)); else p.reject(new Error(m.message));
    };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || "worker failed")); pending.clear(); worker = null; };
  }
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
      getWorker().postMessage({ id, body });
    });
  }
  throw new Error(`${p} is not available in the static site`);
}
