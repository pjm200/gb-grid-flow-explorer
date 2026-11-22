// Web Worker for the GitHub Pages build: runs the Python dispatch model in the browser with
// Pyodide, so the static site can solve days exactly like the local server does.
// Only used by the deployed site (copied in by gridviz/build_site.py); the local tool never loads it.
/* global loadPyodide, importScripts */
const PYODIDE_VERSION = "0.29.5";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let ready = null;
const cache = new Map();

function progress(text) { self.postMessage({ type: "progress", text }); }

async function init() {
  progress("Loading Python in your browser (first visit downloads ~30 MB, then it is cached)…");
  importScripts(INDEX_URL + "pyodide.js");
  const pyodide = await loadPyodide({ indexURL: INDEX_URL });
  progress("Loading numpy, scipy and pandas…");
  await pyodide.loadPackage(["numpy", "scipy", "pandas", "pyyaml", "pydantic"]);
  progress("Loading the model and data…");
  const res = await fetch(new URL("../py/bundle.zip", self.location));
  if (!res.ok) throw new Error(`model bundle: HTTP ${res.status}`);
  pyodide.unpackArchive(await res.arrayBuffer(), "zip", { extractDir: "/home/pyodide/app" });
  pyodide.runPython(`
import sys, json
sys.path.insert(0, "/home/pyodide/app")
from gridviz.dispatch import simulate
from gridviz.models import SimRequest
from gridviz import data as _store
_store.load()
def run_json(body):
    return json.dumps(simulate(SimRequest(**json.loads(body))), separators=(",", ":"))
`);
  return pyodide;
}

self.onmessage = async (e) => {
  const { id, body } = e.data;
  try {
    if (!ready) ready = init();
    const pyodide = await ready;
    const key = JSON.stringify(body);
    if (!cache.has(key)) {
      progress("Solving the day (48 half-hours, two passes)…");
      const run = pyodide.globals.get("run_json");
      cache.set(key, run(key));
      run.destroy();
    }
    self.postMessage({ type: "result", id, json: cache.get(key) });
  } catch (err) {
    ready = null;                                    // allow a retry after a failed start
    self.postMessage({ type: "error", id, message: String(err && err.message ? err.message : err) });
  }
};
