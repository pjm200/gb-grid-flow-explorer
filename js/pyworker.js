// Web Worker for the GitHub Pages build: runs the Python dispatch model in the browser with
// Pyodide, so the static site can solve days exactly like the local server does.
// Only used by the deployed site (copied in by gridviz/build_site.py); the local tool never loads it.
//
// Where the files come from (py/hosted.json, written by build_site.py):
//   pyodide.js, pyodide.asm.wasm, pyodide-lock.json  - the jsDelivr CDN
//   Python's standard library                         - this site's copy (py/stdlib.b64.txt)
//   package wheels (numpy, scipy, ...)                - the CDN
//   the model (code, config, data)                    - this site's copy (py/model.b64.txt)
// This site's copies are zip files published as base64 TEXT: a corporate web filter (Zscaler)
// was seen blocking the .zip downloads that contain code - Python's standard library from the
// CDN, and this site's own bundle.zip (HTTP 403) - while letting the same bytes through as text.
// The standard library is handed to Pyodide as a Blob (stdLibURL) decoded from that text, and the
// model is decoded the same way; neither is fetched as a .zip.
//
// Start-up goes through named stages. If one fails, the worker posts a structured "diag"
// (stage, message, Python's own output, timings) that the page turns into a downloadable report.
// Test hooks (page query ?diagtest=...):
//   cdn    - pyodide.js cannot be fetched
//   stdlib - this site's copy of the standard library is missing
//   bundle - the model is missing
/* global loadPyodide, importScripts */
const SITE_PY = new URL("../py/", self.location);

let ready = null, test = null, hosted = null, indexURL = "";
const cache = new Map();
const output = [];                                   // last lines of Python's output
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

function b64ToBytes(txt) {
  txt = txt.trim();
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(txt);
  const bin = atob(txt), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

const isZip = (u8) => u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;

/** One of this site's base64 copies, decoded to bytes. */
async function siteCopy(rel) {
  const url = new URL(rel, SITE_PY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status} ${res.statusText}`.trim());
  const txt = await res.text();
  if (/^\s*</.test(txt.slice(0, 64))) throw new Error(`${url.pathname}: came back as a web page (blocked?)`);
  let u8;
  try { u8 = b64ToBytes(txt); } catch (e) { throw new Error(`${url.pathname}: not valid base64 text (${txt.length} characters)`); }
  if (!isZip(u8)) throw new Error(`${url.pathname}: did not decode to a zip archive (${u8.length} bytes)`);
  return u8;
}

async function init() {
  stages = [];
  await stage("read site settings", async () => {
    const res = await fetch(new URL("hosted.json", SITE_PY), { cache: "no-cache" });
    if (!res.ok) throw new Error(`py/hosted.json: HTTP ${res.status}`);
    hosted = await res.json();
  });
  indexURL = test === "cdn" ? "https://cdn.jsdelivr.net/pyodide/v0.0.0-diagtest/full/" : hosted.cdn;

  // Python's standard library: decode this site's text copy and hand it to Pyodide as a Blob,
  // so nothing fetches python_stdlib.zip (which the work filter blocked).
  progress("Loading Python in your browser (first visit downloads ~35 MB, then it is cached)…", "download standard library");
  const stdLibURL = await stage("download standard library", async () => {
    const u8 = await siteCopy(test === "stdlib" ? "missing-diagtest.b64.txt" : hosted.stdlib.path);
    keep("net", `python standard library: this site's copy (${u8.length} bytes)`);
    return URL.createObjectURL(new Blob([u8], { type: "application/octet-stream" }));
  });

  await stage("download pyodide.js", () => importScripts(indexURL + "pyodide.js"));
  progress("Starting Python…", "start Python runtime");
  const pyodide = await stage("start Python runtime", () => loadPyodide({
    indexURL, stdLibURL, stdout: (s) => keep("out", s), stderr: (s) => keep("err", s),
  }));
  progress("Loading numpy, scipy and pandas…", "load packages");
  await stage("load packages", () => pyodide.loadPackage(hosted.packages, {
    messageCallback: (s) => { keep("pkg", s); self.postMessage({ type: "activity" }); },
    errorCallback: (s) => keep("pkg-err", s),
  }));
  progress("Loading the model and data…", "download model bundle");
  const model = await stage("download model bundle", () => siteCopy(test === "bundle" ? "missing-diagtest.b64.txt" : hosted.model.path));
  await stage("unpack model bundle", () => pyodide.unpackArchive(model, "zip", { extractDir: "/home/pyodide/app" }));
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
    pyodide_version: hosted ? hosted.pyodide_version : "?", index_url: indexURL,
    packages: hosted ? hosted.packages : [], test,
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
