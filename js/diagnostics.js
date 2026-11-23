// Diagnostics: an error panel that stays open, a connection test, a likely-cause guess and a
// plain-text report the user can download or copy. Nothing is sent anywhere.
//
// The static (GitHub Pages) site runs Python in the browser with Pyodide, which downloads
// several files from cdn.jsdelivr.net. Corporate web filters sometimes block or replace some of
// them (zip archives especially). The connection test fetches each file the site needs, checks
// it arrived intact, and also fetches three small probe files from this site with the same zip
// content (.zip, .bin and base64 .txt) to tell blocking by extension from blocking by content.
import { esc } from "./common.js";

const DEFAULT_PYODIDE = "0.29.5";
const cdnBase = (v) => `https://cdn.jsdelivr.net/pyodide/v${v}/full/`;
const PROBE_TIMEOUT_MS = 60000;

// ------------------------------------------------------------------ environment
export function environment() {
  const n = navigator;
  return {
    page: location.href.split("#")[0],
    mode: window.GBGFE_STATIC ? "static site (GitHub Pages, Python in the browser)" : "local tool (Python server)",
    user_agent: n.userAgent,
    platform: (n.userAgentData && n.userAgentData.platform) || n.platform || "?",
    language: n.language,
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return "?"; } })(),
    webassembly: typeof WebAssembly === "object",
    web_worker: typeof Worker === "function",
    shared_array_buffer: typeof SharedArrayBuffer === "function",
    cross_origin_isolated: !!self.crossOriginIsolated,
    secure_context: !!self.isSecureContext,
    online: n.onLine,
    cpu_threads: n.hardwareConcurrency || "?",
    memory_gb_hint: n.deviceMemory || "?",
    screen: `${screen.width}x${screen.height} @${window.devicePixelRatio || 1}x`,
  };
}

// ------------------------------------------------------------------ connection test
const hex = (u8, n = 16) => Array.from(u8.slice(0, n), (b) => b.toString(16).padStart(2, "0")).join(" ");

function isZip(u8) {
  if (u8.length < 22 || u8[0] !== 0x50 || u8[1] !== 0x4b || u8[2] !== 0x03 || u8[3] !== 0x04) return "does not start like a zip file";
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) return "";
  }
  return "zip file is cut short (no end-of-archive record)";
}

async function sha256(u8) {
  if (!(self.crypto && crypto.subtle)) return null;
  const d = await crypto.subtle.digest("SHA-256", u8);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function textSnippet(u8) {
  try {
    const t = new TextDecoder("utf-8", { fatal: false }).decode(u8.slice(0, 4000));
    return t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 300);
  } catch (e) { return ""; }
}

/** Fetch one file and judge whether it arrived intact. kind: js | wasm | zip | json | b64zip */
async function probe(name, url, kind, expect) {
  const rec = { name, url, kind, ok: false, status: null, type: "", bytes: 0, ms: 0, head: "", note: "", snippet: "" };
  const t0 = performance.now();
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctl.signal });
    rec.status = res.status; rec.type = res.headers.get("content-type") || "";
    const u8 = new Uint8Array(await res.arrayBuffer());
    rec.bytes = u8.length; rec.head = hex(u8);
    const looksHtml = /^\s*</.test(new TextDecoder().decode(u8.slice(0, 64))) || /html/i.test(rec.type);
    if (looksHtml && kind !== "js") rec.snippet = textSnippet(u8);
    let bad = "";
    if (!res.ok) bad = `HTTP ${res.status} ${res.statusText}`.trim();
    else if (kind === "wasm") bad = u8[0] === 0 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d ? "" : "not a WebAssembly file";
    else if (kind === "zip") bad = isZip(u8);
    else if (kind === "js") { bad = looksHtml ? "came back as a web page, not JavaScript" : ""; if (bad) rec.snippet = textSnippet(u8); }
    else if (kind === "json") { try { rec.json = JSON.parse(new TextDecoder().decode(u8)); } catch (e) { bad = "not valid JSON"; } }
    else if (kind === "b64zip") {
      try {
        const bin = atob(new TextDecoder().decode(u8).trim());
        const z = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        bad = isZip(z); if (!bad && expect && expect.sha256) { const h = await sha256(z); if (h && h !== expect.sha256) bad = "decoded content differs from the original"; }
      } catch (e) { bad = "not valid base64 text"; }
    }
    if (!bad && expect && expect.sha256 && kind !== "b64zip") {
      const h = await sha256(u8);
      if (h && h !== expect.sha256) bad = `content differs from the published file (${u8.length} bytes, expected ${expect.bytes})`;
    }
    if (looksHtml && bad && !rec.snippet) rec.snippet = textSnippet(u8);
    rec.ok = !bad; rec.note = bad || "intact";
  } catch (e) {
    rec.note = e.name === "AbortError" ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : `could not download (${e.name}: ${e.message})`;
  } finally {
    clearTimeout(timer); rec.ms = Math.round(performance.now() - t0);
  }
  return rec;
}

/** Runs every probe in turn. onStep(record) is called after each one. */
export async function connectionTest(onStep = () => {}, pyodideVersion = DEFAULT_PYODIDE) {
  const started = new Date();
  const cdn = cdnBase(pyodideVersion);
  const results = [];
  const step = async (...a) => { const r = await probe(...a); results.push(r); onStep(r, results); return r; };
  let manifest = null;
  try { const r = await fetch("diag/manifest.json", { cache: "no-store" }); if (r.ok) manifest = await r.json(); } catch (e) { /* older build */ }
  const exp = (p) => (manifest && manifest.files && manifest.files[p]) || null;

  await step("pyodide.js (Python loader)", cdn + "pyodide.js", "js");
  await step("pyodide.asm.wasm (Python runtime)", cdn + "pyodide.asm.wasm", "wasm");
  await step("python_stdlib.zip (Python standard library)", cdn + "python_stdlib.zip", "zip");
  const lock = await step("pyodide-lock.json (package list)", cdn + "pyodide-lock.json", "json");
  const wheel = lock.json && lock.json.packages && lock.json.packages.numpy && lock.json.packages.numpy.file_name;
  delete lock.json;
  if (wheel) await step(`${wheel} (numpy package)`, cdn + wheel, "zip");
  await step("py/bundle.zip (this site's model bundle)", "py/bundle.zip", "zip", exp("py/bundle.zip"));
  await step("diag/probe.zip (test file, .zip)", "diag/probe.zip", "zip", exp("diag/probe.zip"));
  await step("diag/probe.bin (same file, renamed .bin)", "diag/probe.bin", "zip", exp("diag/probe.bin"));
  await step("diag/probe.txt (same file, as base64 text)", "diag/probe.txt", "b64zip", exp("diag/probe.txt"));
  return { started, finished: new Date(), results, build: manifest && manifest.build };
}

// ------------------------------------------------------------------ likely cause
const START_STAGES = ["start worker", "download pyodide.js", "start Python runtime", "load packages",
  "download model bundle", "unpack model bundle", "import model"];

export function likelyCause({ error, diag, test, env, stalled, mode }) {
  const msg = String((diag && diag.message) || (error && error.message) || "");
  const stage = diag && diag.stage;
  const out = ((diag && diag.output) || []).join("\n");
  const R = {}; (test ? test.results : []).forEach((r) => { R[r.name.split(" ")[0]] = r; });
  const bad = (k) => R[k] && !R[k].ok;
  const good = (k) => R[k] && R[k].ok;
  const cdnZipBad = bad("python_stdlib.zip") || Object.keys(R).some((k) => k.endsWith(".whl") && bad(k));

  if (mode === "local") {
    if (/failed to fetch|networkerror|load failed/i.test(msg)) return { title: "Could not reach the local server",
      cause: "The page could not contact the Python server that runs the model.", fix: "Check that run_tool.bat (or the server window) is still running, then press Retry." };
    return { title: "The simulation failed", cause: "The local Python server reported an error while solving this day.", fix: "Download the report and send it with a note of what you changed." };
  }
  if (env && !env.webassembly) return { title: "Python cannot run in this browser",
    cause: "WebAssembly is switched off in this browser, so Python cannot run here (often a security policy, or Edge's enhanced security mode).",
    fix: "Use another browser or ask IT whether WebAssembly can be allowed for this site. The local tool (run_tool.bat) works without it." };
  if (env && !env.web_worker) return { title: "Python cannot run in this browser", cause: "Web Workers are switched off in this browser.", fix: "Use another browser, or the local tool." };
  if (bad("pyodide.js") || stage === "download pyodide.js") return { title: "Python could not be downloaded",
    cause: "This network blocks the Python loader from cdn.jsdelivr.net.", fix: "The site could host Python itself on github.io; send the report so that can be tested." };
  if (test && (cdnZipBad || bad("pyodide.asm.wasm"))) {
    const what = bad("pyodide.asm.wasm") && !cdnZipBad ? "the Python runtime (.wasm)" : "zip archives from cdn.jsdelivr.net (Python's standard library and packages)";
    let how, fix;
    if (bad("diag/probe.zip") && good("diag/probe.bin")) { how = "The same file from this site arrives intact when renamed, so the filter blocks by file extension (.zip)."; fix = "Serve renamed copies of Python's files from this site."; }
    else if (bad("diag/probe.zip") && bad("diag/probe.bin") && good("diag/probe.txt")) { how = "Zip files from this site are blocked even when renamed, but arrive intact as text, so the filter inspects file content."; fix = "Serve Python's files encoded as text and decode them in the browser."; }
    else if (good("diag/probe.zip")) { how = "The same kind of file from github.io arrives intact, so only cdn.jsdelivr.net is affected."; fix = "Host Python's files on github.io with the site."; }
    else { how = "Files from this site are affected too."; fix = "Send the report; the local tool (run_tool.bat) works offline in the meantime."; }
    return { title: "Python could not start in this browser", cause: `This network blocks or alters ${what}. ${how}`, fix };
  }
  if (/No module named 'encodings'/.test(out) || /exit\(1\)/.test(msg)) {
    const base = "Python started but could not load its standard library (python_stdlib.zip from cdn.jsdelivr.net).";
    if (good("python_stdlib.zip")) return { title: "Python could not start in this browser",
      cause: `${base} The connection test has just downloaded that file intact, so the block may be intermittent (for example a filter that releases files after scanning), or the browser reused a bad cached copy.`,
      fix: "Press Retry. If it fails again, send the report." };
    return { title: "Python could not start in this browser",
      cause: `${base} A web filter blocking or replacing zip downloads is the usual reason.`,
      fix: test ? "Send the report." : "Run the connection test below to see how the filter decides, then send the report." };
  }
  if (bad("py/bundle.zip") || stage === "download model bundle" || stage === "unpack model bundle") return { title: "The model could not be loaded",
    cause: "This site's model bundle (py/bundle.zip) did not arrive intact.", fix: "Send the report; serving the bundle in another form may help." };
  if (stage === "load packages") return { title: "Python packages could not be loaded",
    cause: "Python started but numpy, scipy or pandas could not be downloaded from cdn.jsdelivr.net.", fix: "Send the report." };
  if (stalled) return { title: "Python is taking unusually long to start",
    cause: `Start-up has made no progress for over 90 s (at: ${stalled.stage || "?"}). A web filter holding downloads for scanning can cause this.`,
    fix: "It may still finish. If not, send the report." };
  if (stage === "import model" || stage === "solve") return { title: "The model failed",
    cause: "Python and its packages loaded, but the model itself raised an error.", fix: "This is probably a bug: please send the report." };
  if (test && test.results.every((r) => r.ok)) return { title: error ? "The simulation failed" : "This browser passed the test",
    cause: error ? "Every file downloaded intact, so the problem is elsewhere." : "Every file the site needs downloads intact in this browser.", fix: error ? "Send the report." : "" };
  return { title: "The simulation failed", cause: msg ? "The error message gives no clear cause." : "No error message was given.", fix: "Run the connection test and send the report." };
}

// ------------------------------------------------------------------ report
export function buildReport({ error, diag, test, env, stalled, mode, request, cause }) {
  const L = [], line = (s = "") => L.push(s), hr = () => line("-".repeat(72));
  const now = new Date();
  line("GB Grid Flow Explorer - diagnostic report");
  line(`Generated: ${now.toISOString()} (local ${now.toLocaleString()})`);
  line(`Page: ${env.page}`);
  line(`Mode: ${env.mode}`);
  if (test && test.build) line(`Site build: ${test.build.commit || "?"} at ${test.build.time || "?"}`);
  line("Nothing in this report was sent anywhere; it was generated in your browser.");
  hr(); line("SUMMARY");
  line(cause.title); line(`${error || diag || stalled ? "Likely cause" : "Result"}: ${cause.cause}`); if (cause.fix) line(`Suggested next step: ${cause.fix}`);
  if (stalled) line(`Start-up stalled after ${stalled.seconds} s at stage: ${stalled.stage || "?"}`);
  if (error || diag) {
    hr(); line("ERROR");
    line(`Stage: ${(diag && diag.stage) || "?"}`);
    line(`Message: ${(diag && diag.message) || (error && error.message) || "(none)"}`);
    if (diag && diag.name) line(`Type: ${diag.name}`);
    if (diag && diag.test) line(`Test hook active: diagtest=${diag.test}`);
    if (diag && diag.pyodide_version) line(`Pyodide: ${diag.pyodide_version} from ${diag.index_url}`);
    if (diag && diag.stack) { line("Stack:"); diag.stack.split("\n").forEach((s) => line("  " + s)); }
  }
  if (diag && diag.stages && diag.stages.length) {
    hr(); line("START-UP STAGES");
    diag.stages.forEach((s) => line(`  ${s.ok ? "ok  " : "FAIL"}  ${String(s.ms).padStart(7)} ms  ${s.name}`));
    const reached = diag.stages.map((s) => s.name);
    START_STAGES.filter((s) => s !== "start worker" && !reached.includes(s)).forEach((s) => line(`  --          not reached  ${s}`));
  }
  if (diag && diag.output && diag.output.length) {
    hr(); line(`PYTHON OUTPUT (last ${diag.output.length} lines)`);
    diag.output.forEach((s) => line("  " + s));
  }
  hr(); line("CONNECTION TEST");
  if (!test) line(mode === "local" ? "  Not applicable to the local tool." : "  Not run.");
  else {
    line(`  Run ${test.started.toISOString()}, took ${Math.round((test.finished - test.started) / 1000)} s`);
    test.results.forEach((r) => {
      line(`  [${r.ok ? "OK  " : "FAIL"}] ${r.name}`);
      line(`         ${r.url}`);
      line(`         ${r.note}; HTTP ${r.status ?? "-"}; ${r.type || "no content type"}; ${r.bytes} bytes; ${r.ms} ms`);
      if (r.head) line(`         first bytes: ${r.head}`);
      if (r.snippet) line(`         page text: ${r.snippet}`);
    });
  }
  hr(); line("ENVIRONMENT");
  Object.entries(env).forEach(([k, v]) => line(`  ${k}: ${v}`));
  if (request) { hr(); line("REQUEST"); line("  " + JSON.stringify(request)); }
  return L.join("\r\n") + "\r\n";
}

export function downloadText(text) {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const name = `gbgfe-diagnostics-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
  ta.remove(); return ok;
}

// ------------------------------------------------------------------ panel
let panel = null;

/**
 * Open the diagnostics panel.
 * opts: { error, request, stalled, onRetry, testOnly }
 * Static site: runs the connection test automatically unless the failure was in the model itself.
 */
export function openDiagPanel(opts = {}) {
  const mode = window.GBGFE_STATIC ? "static" : "local";
  const ctx = { mode, error: opts.error || null, diag: (opts.error && opts.error.diag) || null, request: opts.request || null,
    stalled: opts.stalled || null, env: environment(), test: null };
  if (panel) panel.remove();
  panel = document.createElement("div");
  panel.className = "modal diag"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true");
  panel.innerHTML = `<div class="modal-box diag-box">
    <button class="icon close" data-act="close" title="Close">✕</button>
    <h2 class="diag-title"></h2>
    <p class="diag-cause"></p>
    <p class="diag-fix small"></p>
    <div class="diag-err mono small"></div>
    <div class="diag-test"></div>
    <div class="diag-actions">
      <button class="btn primary" data-act="download">Download report (.txt)</button>
      <button class="btn" data-act="copy">Copy report</button>
      ${mode === "static" ? '<button class="btn" data-act="test">Run connection test</button>' : ""}
      ${opts.onRetry ? '<button class="btn" data-act="retry">Retry</button>' : ""}
      <span class="diag-msg small dim"></span>
    </div>
    <p class="small dim">Nothing is sent anywhere: the report is made in your browser. Send the .txt file to whoever is helping you.
      ${mode === "static" ? "The local tool (<code>run_tool.bat</code>) runs the same model without the internet." : ""}</p>
  </div>`;
  document.body.appendChild(panel);
  const $p = (s) => panel.querySelector(s);
  const report = () => buildReport({ ...ctx, cause: likelyCause(ctx) });
  const render = () => {
    const c = likelyCause(ctx);
    $p(".diag-title").textContent = opts.testOnly && !ctx.test ? "Browser test" : c.title;
    const label = ctx.error || ctx.diag || ctx.stalled ? "Likely cause" : "Result";
    $p(".diag-cause").innerHTML = `<b>${label}:</b> ${esc(c.cause)}`;
    $p(".diag-fix").textContent = c.fix ? `Next step: ${c.fix}` : "";
    const d = ctx.diag;
    $p(".diag-err").innerHTML = ctx.error || d
      ? `${d && d.stage ? `Stage: ${esc(d.stage)}<br>` : ""}${esc((d && d.message) || (ctx.error && ctx.error.message) || "")}` +
        ((d && d.output && d.output.length) ? `<details><summary>Python output (${d.output.length} lines)</summary><pre>${esc(d.output.join("\n"))}</pre></details>` : "")
      : "";
    $p(".diag-err").classList.toggle("hidden", !(ctx.error || d));
  };
  const runTest = async () => {
    const btn = $p('[data-act="test"]'); if (btn) btn.disabled = true;
    const box = $p(".diag-test");
    box.innerHTML = `<p class="small"><span class="spinner"></span> Running the connection test (downloads about 20 MB)…</p><table class="kv diag-table"></table>`;
    const tbl = box.querySelector("table");
    ctx.test = await connectionTest((r) => {
      tbl.insertAdjacentHTML("beforeend", `<tr><td>${esc(r.name)}</td><td class="${r.ok ? "ok" : "bad"}">${r.ok ? "✓ intact" : "✗ " + esc(r.note)}</td></tr>`);
    }, (ctx.diag && ctx.diag.pyodide_version) || DEFAULT_PYODIDE);
    box.querySelector("p").textContent = `Connection test finished in ${Math.round((ctx.test.finished - ctx.test.started) / 1000)} s.`;
    if (btn) { btn.disabled = false; btn.textContent = "Run connection test again"; }
    render();
  };
  panel.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (e.target === panel || act === "close") { panel.remove(); panel = null; return; }
    const msg = $p(".diag-msg");
    if (act === "download") msg.textContent = `Saved ${downloadText(report())} (check your Downloads folder).`;
    if (act === "copy") msg.textContent = (await copyText(report())) ? "Report copied to the clipboard." : "Copy failed: use Download instead.";
    if (act === "test") runTest();
    if (act === "retry") { panel.remove(); panel = null; opts.onRetry(); }
  });
  render();
  const modelStage = ctx.diag && (ctx.diag.stage === "solve" || ctx.diag.stage === "import model");
  if (mode === "static" && (opts.testOnly || ((ctx.error || ctx.stalled) && !modelStage))) runTest();
  return { ctx, report };
}
