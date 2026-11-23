// Web Worker for the GitHub Pages build: runs the Python dispatch model in the browser with
// Pyodide, so the static site can solve days exactly like the local server does.
// Only used by the deployed site (copied in by gridviz/build_site.py); the local tool never loads it.
//
// Start-up goes through named stages. If one fails, the worker posts a structured "diag"
// (stage, message, Python's own output, timings) that the page turns into a downloadable report.
// Test hooks (page query ?diagtest=...) reproduce the failures seen behind corporate web filters:
//   cdn    - pyodide.js cannot be fetched
//   stdlib - Python's standard library arrives as an HTML page (gives "Program terminated with exit(1)")
//   bundle - the model bundle is missing
/* global loadPyodide, importScripts */
const PYODIDE_VERSION = "0.29.5";
const CDN_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PACKAGES = ["numpy", "scipy", "pandas", "pyyaml", "pydantic"];

let ready = null, test = null, indexURL = CDN_URL;
const cache = new Map();
const output = [];                                   // last lines of Python's stdout/stderr
let stages = [];

function progress(text, stage) { self.postMessage({ type: "progress", text, stage }); }
function keep(stream, line) { output.push(`${stream}: ${line}`); if (output.length > 200) output.shift(); }

async function stage(name, fn) {
  const rec = { name, ok: false, ms: 0 }; stages.push(rec);
  const t0 = performance.now();
  try { const v = await fn(); rec.ok = true; return v; }
  catch (err) { err.stage = err.stage || name; throw err; }
  finally { rec.ms = Math.round(performance.now() - t0); }
}

async function init() {
  stages = [];
  indexURL = test === "cdn" ? "https://cdn.jsdelivr.net/pyodide/v0.0.0-diagtest/full/" : CDN_URL;
  const stdLibURL = test === "stdlib" ? new URL("../index.html", self.location).href : undefined;
  const bundleURL = new URL(test === "bundle" ? "../py/missing-diagtest.zip" : "../py/bundle.zip", self.location);

  progress("Loading Python in your browser (first visit downloads ~30 MB, then it is cached)…", "download pyodide.js");
  await stage("download pyodide.js", () => importScripts(indexURL + "pyodide.js"));
  progress("Starting Python…", "start Python runtime");
  const pyodide = await stage("start Python runtime", () => loadPyodide({
    indexURL, ...(stdLibURL ? { stdLibURL } : {}),
    stdout: (s) => keep("out", s), stderr: (s) => keep("err", s),
  }));
  progress("Loading numpy, scipy and pandas…", "load packages");
  await stage("load packages", () => pyodide.loadPackage(PACKAGES, {
    messageCallback: (s) => { keep("pkg", s); self.postMessage({ type: "activity" }); },
    errorCallback: (s) => keep("pkg-err", s),
  }));
  progress("Loading the model and data…", "download model bundle");
  const buf = await stage("download model bundle", async () => {
    const res = await fetch(bundleURL);
    if (!res.ok) throw new Error(`${bundleURL.pathname}: HTTP ${res.status} ${res.statusText}`);
    return res.arrayBuffer();
  });
  await stage("unpack model bundle", () => pyodide.unpackArchive(buf, "zip", { extractDir: "/home/pyodide/app" }));
  await stage("import model", () => pyodide.runPython(`
import sys, json
sys.path.insert(0, "/home/pyodide/app")
from gridviz.dispatch import simulate
from gridviz.models import SimRequest
from gridviz import data as _store
_store.load()
def run_json(body):
    return json.dumps(simulate(SimRequest(**json.loads(body))), separators=(",", ":"))
`));
  return pyodide;
}

function diag(err) {
  return {
    stage: err && err.stage ? err.stage : "solve",
    message: String(err && err.message ? err.message : err),
    name: err && err.name ? err.name : "",
    stack: err && err.stack ? String(err.stack).split("\n").slice(0, 12).join("\n") : "",
    output: output.slice(-80),
    stages: stages.map((s) => ({ ...s })),
    pyodide_version: PYODIDE_VERSION, index_url: indexURL, packages: PACKAGES, test,
  };
}

self.onmessage = async (e) => {
  const { id, body, diagtest } = e.data;
  if (diagtest && test === null) test = diagtest;
  try {
    if (!ready) ready = init();
    const pyodide = await ready;
    const key = JSON.stringify(body);
    if (!cache.has(key)) {
      progress("Solving the day (48 half-hours, two passes)…", "solve");
      const run = pyodide.globals.get("run_json");
      try { cache.set(key, run(key)); }
      catch (err) { err.stage = "solve"; throw err; }
      finally { run.destroy(); }
    }
    self.postMessage({ type: "result", id, json: cache.get(key) });
  } catch (err) {
    const d = diag(err);
    ready = null;                                    // the page restarts the worker after a failed start
    self.postMessage({ type: "error", id, message: d.message, diag: d });
  }
};
