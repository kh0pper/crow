#!/usr/bin/env node
/**
 * Phone-width overflow audit for every dashboard panel.
 *
 * Boots a SCRATCH gateway (fresh temp CROW_HOME + data dir, --no-auth,
 * loopback-only, an OS-chosen free port), installs every bundle panel in the
 * repo into that scratch home the same way the Extensions page does
 * (panels/<bundle>.js + <bundle>-routes.js + panels.json, the bundle dir
 * linked under <scratch>/bundles), then opens every panel — and every
 * same-panel ?query sub-view linked from it, plus every shared tabs()
 * trigger — in a private headless Chrome (tests/fixtures/headless-chrome.mjs)
 * at phone sizes, and records where the page is wider than the screen.
 *
 * Two overflow measures, because the phone layout scrolls inside
 * .content-body (layout.js, <=768px: .main-content is overflow:hidden and
 * .content-body is overflow-y:auto, which makes overflow-x auto too):
 *   doc  = documentElement.scrollWidth - innerWidth   (whole page pans)
 *   body = .content-body scrollWidth - clientWidth    (the panel pans sideways
 *          inside its scroller: the "cards cut off at the edge" symptom)
 * Culprits are the frontier elements: right edge past the content box AND
 * past their own parent's right edge, not inside a narrower clipping/scrolling
 * ancestor (a .table-scroll that scrolls on its own is fine).
 *
 * Never touches ~/.crow, the prod gateway, containers or models: GET requests
 * only, against the scratch gateway. Output: JSON + a markdown table.
 *
 *   node scripts/dev/phone-overflow-audit.mjs --out /tmp/audit [--only media,nest]
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "../../tests/fixtures/headless-chrome.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(argVal("--out", join(tmpdir(), "crow-phone-overflow-audit")));
const ONLY = (argVal("--only", "") || "").split(",").filter(Boolean);
// Two phones plus one desktop pass, so a desktop leak of a phone fix shows
// in the same run.
const VIEWPORTS = [[390, 844], [412, 730], [1280, 900]];
// --text-size small|default|large|xlarge: the dashboard's own text-size
// setting (shared/text-size.js, localStorage "crow-text-size"), applied
// before any page script runs.
const TEXT_SIZE = argVal("--text-size", "");
if (TEXT_SIZE && !["small", "default", "large", "xlarge"].includes(TEXT_SIZE)) { console.error("--text-size must be small|default|large|xlarge"); process.exit(2); }
const MAX_VIEWS_PER_PANEL = 30;
const HARD_CAP_MS = 45 * 60 * 1000;      // the whole run, gateway included

// Core panels are registered in servers/gateway/dashboard/index.js.
const CORE = ["nest", "messages", "memory", "projects", "blog", "files", "extensions", "model-catalog",
  "skills", "settings", "contacts", "bot-builder", "bot-board", "design-system", "onboarding", "connect",
  "fediverse", "metering", "perch"];

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/** Install every bundle panel into the scratch home; returns [{bundle, panelId}]. */
function installBundlePanels(home) {
  const panelsDir = join(home, "panels");
  const bundlesDir = join(home, "bundles");
  mkdirSync(panelsDir, { recursive: true });
  mkdirSync(bundlesDir, { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(panelsDir, "node_modules"));
  const out = [];
  for (const b of readdirSync(join(ROOT, "bundles")).sort()) {
    const mPath = join(ROOT, "bundles", b, "manifest.json");
    if (!existsSync(mPath)) continue;
    let m; try { m = JSON.parse(readFileSync(mPath, "utf8")); } catch { continue; }
    if (!m.panel) continue;
    const rel = typeof m.panel === "string" ? m.panel : `panel/${m.panel.id || b}.js`;
    const src = join(ROOT, "bundles", b, rel);
    if (!existsSync(src)) { out.push({ bundle: b, panelId: null, note: `panel file missing: ${rel}` }); continue; }
    copyFileSync(src, join(panelsDir, `${b}.js`));
    if (m.panelRoutes && existsSync(join(ROOT, "bundles", b, m.panelRoutes))) {
      copyFileSync(join(ROOT, "bundles", b, m.panelRoutes), join(panelsDir, `${b}-routes.js`));
    }
    // The bundle dir, as the panel's lazy imports expect. Ramble's server/ is
    // left out on purpose: its presence makes the gateway start the Ramble
    // transport (boot/ramble-boot.js); the panel itself renders without it.
    if (b === "ramble") {
      mkdirSync(join(bundlesDir, b));
      for (const e of readdirSync(join(ROOT, "bundles", b))) if (e !== "server") symlinkSync(join(ROOT, "bundles", b, e), join(bundlesDir, b, e));
    } else symlinkSync(join(ROOT, "bundles", b), join(bundlesDir, b));
    const srcText = readFileSync(src, "utf8");
    const idm = srcText.match(/export default\s*\{\s*id:\s*["']([^"']+)["']/) || srcText.match(/\bid:\s*["']([a-z0-9-]+)["']/);
    out.push({ bundle: b, panelId: idm ? idm[1] : b });
  }
  writeFileSync(join(home, "panels.json"), JSON.stringify({ enabled: out.filter((p) => p.panelId).map((p) => p.bundle) }, null, 2));
  return out;
}

async function bootGateway(home, dataDir, port) {
  const env = { ...process.env, CROW_HOME: home, CROW_DATA_DIR: dataDir, PORT: String(port),
    CROW_GATEWAY_BIND: "127.0.0.1", CROW_GATEWAY_URL: `http://127.0.0.1:${port}`,
    CROW_INSTANCES_JSON_PATH: join(home, "instances.json"), CROW_REFCOUNT_PATH: join(dataDir, "orchestrator-refcounts.json"),
    CROW_BACKUP_DIR: join(home, "backups"), CROW_BOX_RESERVATION_PATH: join(home, "box-reservation.json"),
    CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1", CROW_DISABLE_BOT_RUNTIME: "1", CROW_DISABLE_PERCH: "1",
    CROW_DISABLE_NTFY_AUTOWIRE: "1", CROW_EXTERNAL_ENGINE_POLL_MS: "0", CROW_DISABLE_MODEL_ORCHESTRATION: "1",
    CROW_DISABLE_CROSSPOST_SCHEDULER: "1",
    // Loopback-only bind (above), so the network gate adds nothing here; without
    // this, isAllowedNetwork() 403s bare loopback peers by design.
    CROW_DASHBOARD_PUBLIC: "true" };
  delete env.INVOCATION_ID; delete env.CROW_SUPERVISED;
  execFileSync(process.execPath, ["scripts/init-db.js"], { env, cwd: ROOT, stdio: "pipe" });
  // Bundle tables normally come from each bundle's MCP server at install; the
  // audit has no bundle servers running, so create them up front (idempotent
  // DDL) — otherwise panel views that query them 500 instead of rendering.
  const initCode = `
    import { readdirSync, existsSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { createDbClient } = await import(pathToFileURL(${JSON.stringify(join(ROOT, "servers/db.js"))}).href);
    const db = createDbClient();
    for (const b of readdirSync(${JSON.stringify(join(ROOT, "bundles"))})) {
      const f = ${JSON.stringify(join(ROOT, "bundles"))} + "/" + b + "/server/init-tables.js";
      if (!existsSync(f)) continue;
      try { const m = await import(pathToFileURL(f).href);
        for (const [k, fn] of Object.entries(m)) if (/^init.*Tables$/.test(k) && typeof fn === "function") await fn(db);
      } catch (e) { console.log("init-tables " + b + ": " + e.message); }
    }
    // Stress rows: realistic-but-long values (model ids, URLs, titles) where
    // an empty scratch home would only ever show empty states. Best effort.
    const TOK = "crow-local/qwen3.6-35b-a3b-instruct-q4_k_m-" + "x".repeat(40);
    const URL_ = "https://news.example.com/" + "a-very-long-path-segment-".repeat(6) + "?utm_source=feed";
    const TITLE = "A deliberately long headline about regional transit funding, school budgets and the weather this weekend";
    const MD = "Intro with " + URL_ + "\\n\\n\\u0060\\u0060\\u0060\\nconst model = '" + TOK + "';\\n\\u0060\\u0060\\u0060\\n\\n| Model | Context | Notes |\\n|---|---|---|\\n| " + TOK + " | 256K | the default chat model |\\n";
    const seed = [
      ["INSERT INTO memories (category, content, context, tags, importance) VALUES ('learning', ?, ?, ?, 7)", [MD, URL_, TOK]],
      ["INSERT INTO memories (category, content, importance) VALUES ('project', ?, 5)", [TITLE + " " + TOK]],
      ["INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, bio) VALUES (?, ?, ?, ?, ?)", ["crow:" + "f".repeat(64), "Alexandria-Konstantinopolous-Wellington " + TOK, "a".repeat(64), "b".repeat(64), URL_]],
      ["INSERT INTO messages (contact_id, content, direction) VALUES (1, ?, 'received')", [MD]],
      ["INSERT INTO project_spaces (slug, name, description, tags) VALUES (?, ?, ?, ?)", ["regional-transit-" + "x".repeat(50), TITLE, URL_, TOK]],
      ["INSERT INTO blog_posts (slug, title, content, excerpt, status, tags) VALUES (?, ?, ?, ?, 'published', ?)", ["long-" + "y".repeat(60), TITLE + " " + TOK, MD, URL_, TOK]],
      ["INSERT INTO notifications (type, source, title, body, action_url) VALUES ('system', 'audit', ?, ?, ?)", [TITLE + " " + TOK, MD, URL_]],
      ["INSERT INTO media_sources (source_type, name, url, category) VALUES ('rss', ?, ?, 'news')", [TITLE, URL_]],
      ["INSERT INTO media_articles (source_id, guid, url, title, summary, topics) VALUES (1, 'g1', ?, ?, ?, ?)", [URL_, TITLE + " " + TOK, MD, JSON.stringify(["transit", TOK])]],
      ["INSERT INTO media_articles (source_id, guid, url, title) VALUES (1, 'g2', ?, ?)", [URL_ + "&b", TITLE]],
    ];
    for (const [sql, args] of seed) { try { await db.execute({ sql, args }); } catch (e) { console.log("seed: " + e.message); } }
    try { db.close(); } catch {}`;
  const initOut = execFileSync(process.execPath, ["--input-type=module", "-e", initCode], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  for (const l of initOut.split("\n")) if (/^(seed|init-tables)\b/.test(l)) console.error("[audit] " + l);
  const child = spawn(process.execPath, ["servers/gateway/index.js", "--no-auth"], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString())); child.stderr.on("data", (d) => log.push(d.toString()));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { child, log }; } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill("SIGKILL");
  throw new Error("scratch gateway did not come up:\n" + log.join("").slice(-3000));
}

// ── in-page measurement (no backticks: sent as a string) ────────────────────
const MEASURE = String.raw`(() => {
  const vw = window.innerWidth;
  const cb = document.querySelector('.content-body');
  const doc = document.documentElement.scrollWidth - vw;
  const body = cb ? cb.scrollWidth - cb.clientWidth : 0;
  const limit = cb ? cb.getBoundingClientRect().left + cb.clientWidth : vw;
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const path = (el) => { const p = []; for (let e = el; e && e !== cb && p.length < 3; e = e.parentElement) p.unshift(sel(e)); return p.join(' > '); };
  const clipped = (el) => {
    for (let a = el.parentElement; a && a !== cb && a !== document.body; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox !== 'visible' && a.getBoundingClientRect().right <= limit + 1) return true;
    }
    return false;
  };
  const culprits = [];
  if (doc > 1 || body > 1) {
    const root = cb || document.body;
    // measure with the scroller at its origin
    if (cb) cb.scrollLeft = 0;
    for (const el of root.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= limit + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden') continue;
      const pr = el.parentElement ? el.parentElement.getBoundingClientRect() : { right: 0 };
      if (r.right <= pr.right + 1) continue;          // not the one sticking out
      if (clipped(el)) continue;
      const par = el.parentElement, pcs = par ? getComputedStyle(par) : null;
      culprits.push({ sel: path(el), over: Math.round(r.right - limit), w: Math.round(r.width),
        parent: par ? sel(par) + ' {' + pcs.display + (pcs.display.includes('flex') ? ';' + pcs.flexDirection + ';' + pcs.flexWrap : '') +
          (pcs.display.includes('grid') ? ';cols:' + pcs.gridTemplateColumns.slice(0, 40) : '') + (pcs.whiteSpace !== 'normal' ? ';ws:' + pcs.whiteSpace : '') + '}' : '',
        pstyle: par ? (par.getAttribute('style') || '').slice(0, 90) : '',
        style: (el.getAttribute('style') || '').slice(0, 90), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) });
    }
    culprits.sort((a, b) => b.over - a.over);
  }
  return { url: location.pathname + location.search, doc, body, culprits: culprits.slice(0, 6),
    snippet: (cb ? cb.innerText : document.body.innerText).trim().replace(/\s+/g, ' ').slice(0, 160) };
})()`;

const LINKS = String.raw`(() => {
  const here = location.pathname;
  const cb = document.querySelector('.content-body') || document.body;
  const out = new Set();
  for (const a of cb.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
    if (u.origin !== location.origin || u.pathname !== here || !u.search) continue;
    if (/logout|delete|remove|action=/i.test(u.search)) continue;
    out.add(u.pathname + u.search);
  }
  return [...out];
})()`;

const TAB_COUNT = `document.querySelectorAll('.content-body .tabs .tab-trigger').length`;
const clickTab = (i) => `(() => { const t = document.querySelectorAll('.content-body .tabs .tab-trigger')[${i}]; if (!t) return null; t.click(); return t.textContent.trim(); })()`;

/** First-run password setup on the scratch gateway (a random throwaway
 *  password, never written anywhere) → the session + csrf cookies. */
async function scratchLogin(base) {
  const pw = "Audit-" + randomBytes(12).toString("hex");
  const r = await fetch(base + "/dashboard/login", { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: pw, confirm: pw }).toString() });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).filter((c) => /^crow_(session|csrf)=/.test(c));
  if (!cookies.some((c) => c.startsWith("crow_session="))) throw new Error("scratch login failed: HTTP " + r.status);
  return cookies.map((c) => { const i = c.indexOf("="); return { name: c.slice(0, i), value: c.slice(i + 1) }; });
}

async function openTab(cdp) {
  const tab = await (await fetch(cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0; const waiters = new Map(); const events = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw);
    if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result || {}); }
    else if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
    else if (m.method) events.push(m); });
  // Every CDP call is bounded: a page that never settles (a dialog, a busy
  // loop, a long poll) costs one view, not the whole run.
  const send = (method, params = {}, ms = 20000) => new Promise((res, rej) => { const mine = ++id;
    const t = setTimeout(() => { waiters.delete(mine); rej(new Error(method + " timed out")); }, ms);
    waiters.set(mine, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ id: mine, method, params })); });
  const evalIn = async (expr) => { const o = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error(JSON.stringify(o.exceptionDetails).slice(0, 300)); return o.result.value; };
  await send("Page.enable");
  if (TEXT_SIZE) await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("crow-text-size", ${JSON.stringify(TEXT_SIZE)}); } catch (e) {}` });
  const navigate = async (url) => {
    events.length = 0;
    await send("Page.navigate", { url });
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && !events.some((e) => e.method === "Page.loadEventFired")) {
      await new Promise((r) => setTimeout(r, 100));
      if (Date.now() - t0 > 500) {   // a missed event must not cost the full budget
        try { const rs = await send("Runtime.evaluate", { expression: "document.readyState + '|' + location.href", returnByValue: true }, 2000);
          const [state, href] = String(rs.result.value).split("|");
          if (state === "complete" && href !== "about:blank") break; } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 500));      // client scripts, ResizeObservers, fonts
  };
  const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 900 ? 2 : 1, mobile: w < 900 });
  return { send, evalIn, navigate, viewport, close: async () => { try { ws.close(); await fetch(cdp + "/json/close/" + tab.id); } catch {} } };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "crow-overflow-audit-"));
  const home = join(scratch, "home"), dataDir = join(scratch, "data");
  mkdirSync(home, { recursive: true }); mkdirSync(dataDir, { recursive: true });
  let gw = null, chrome = null, tab = null;
  const cleanup = async () => { try { if (tab) await tab.close(); } catch {} try { if (chrome) await chrome.close(); } catch {}
    try { if (gw) { gw.child.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 1500)); gw.child.kill("SIGKILL"); } } catch {}
    try { rmSync(scratch, { recursive: true, force: true }); } catch {} };
  const cap = setTimeout(async () => { console.error("[audit] hard cap reached — stopping"); await cleanup(); process.exit(3); }, HARD_CAP_MS);
  process.once("SIGINT", async () => { await cleanup(); process.exit(130); });
  try {
    const bundlePanels = installBundlePanels(home);
    const port = await freePort();
    gw = await bootGateway(home, dataDir, port);
    chrome = await startHeadlessChrome();
    if (!chrome) throw new Error("no headless Chrome found (see tests/fixtures/headless-chrome.mjs)");
    tab = await openTab(chrome.cdp);
    const base = `http://127.0.0.1:${port}`;
    const cookies = await scratchLogin(base);
    for (const c of cookies) await tab.send("Network.setCookie", { name: c.name, value: c.value, url: base, path: "/" });
    const cookieHeader = cookies.map((c) => c.name + "=" + c.value).join("; ");
    const panels = [...CORE.map((id) => ({ source: "core", panelId: id })),
      ...bundlePanels.filter((p) => p.panelId).map((p) => ({ source: "bundle:" + p.bundle, panelId: p.panelId }))]
      .filter((p) => !ONLY.length || ONLY.includes(p.panelId));
    const rows = [];
    for (const p of panels) {
      const root = `/dashboard/${p.panelId}`;
      const queue = [root]; const seen = new Set();
      while (queue.length && seen.size < MAX_VIEWS_PER_PANEL) {
        const path = queue.shift(); if (seen.has(path)) continue; seen.add(path);
        try { await auditView(path); } catch (e) {
          rows.push({ ...p, view: path, note: "audit error: " + String(e.message).slice(0, 80) });
          try { await tab.close(); } catch {}
          tab = await openTab(chrome.cdp);
          for (const c of cookies) await tab.send("Network.setCookie", { name: c.name, value: c.value, url: base, path: "/" });
        }
      }
      async function auditView(path) {
        await tab.viewport(...VIEWPORTS[0]);
        let status = 0;
        try { status = (await fetch(base + path, { redirect: "manual", headers: { cookie: cookieHeader }, signal: AbortSignal.timeout(20000) })).status; } catch {}
        await tab.navigate(base + path);
        const landed = await tab.evalIn("location.pathname + location.search");
        if (!landed.startsWith(root)) { rows.push({ ...p, view: path, status, note: "redirected to " + landed }); return; }
        if (status >= 400) { rows.push({ ...p, view: path, status, note: "HTTP " + status + ": " + (await tab.evalIn(MEASURE)).snippet.slice(0, 80) }); return; }
        if (path === root || seen.size <= 6) for (const l of await tab.evalIn(LINKS)) if (!seen.has(l)) queue.push(l);
        const views = [{ view: path, prep: null }];
        const nTabs = await tab.evalIn(TAB_COUNT);
        for (let i = 1; i < nTabs; i++) views.push({ view: path + ` [tab ${i}]`, prep: i });
        for (const v of views) {
          if (v.prep != null) { const label = await tab.evalIn(clickTab(v.prep)); v.view = path + ` [tab: ${label}]`; await new Promise((r) => setTimeout(r, 250)); }
          for (const [w, h] of VIEWPORTS) {
            await tab.viewport(w, h); await new Promise((r) => setTimeout(r, 250));
            const m = await tab.evalIn(MEASURE);
            rows.push({ ...p, view: v.view, status, vp: `${w}x${h}`, doc: m.doc, body: m.body, culprits: m.culprits, snippet: m.snippet });
          }
          await tab.viewport(...VIEWPORTS[0]);
        }
      }
      const bad = rows.filter((r) => r.panelId === p.panelId && (r.doc > 1 || r.body > 1));
      console.error(`[audit] ${p.panelId}: ${seen.size} view(s), ${bad.length} overflowing measurement(s)`);
    }
    writeFileSync(join(OUT, "audit.json"), JSON.stringify({ when: new Date().toISOString(), viewports: VIEWPORTS, rows, gatewayLogTail: gw.log.join("").slice(-4000) }, null, 2));
    writeFileSync(join(OUT, "audit.md"), toMarkdown(rows));
    const over = rows.filter((r) => r.doc > 1 || r.body > 1);
    console.log(`[audit] ${rows.length} measurements, ${over.length} overflowing; ${new Set(over.map((r) => r.panelId + " " + r.view)).size} distinct views; out: ${OUT}`);
  } finally { clearTimeout(cap); await cleanup(); }
}

function toMarkdown(rows) {
  const views = new Map();
  for (const r of rows) {
    const k = r.panelId + "\u0000" + r.view;
    const v = views.get(k) || { panel: r.panelId, source: r.source, view: r.view, note: r.note || "", vps: [] };
    if (r.vp) v.vps.push(r); views.set(k, v);
  }
  const vps = VIEWPORTS.map(([w, h]) => `${w}x${h}`);
  const lines = [`text size: ${TEXT_SIZE || "default"}`, "",
    "| panel | source | view | " + vps.map((v) => v.split("x")[0] + " doc/body px").join(" | ") + " | top culprit (overflow px) |",
    "|---|---|---|" + vps.map(() => "---|").join("") + "---|"];
  let ok = 0;
  for (const v of views.values()) {
    const per = vps.map((vp) => v.vps.find((r) => r.vp === vp));
    const bad = v.vps.some((r) => r.doc > 1 || r.body > 1);
    if (!bad && !v.note) { ok++; continue; }
    const c = per.map((r) => r && r.culprits && r.culprits[0]).find(Boolean);
    const cell = (r) => r ? `${r.doc}/${r.body}` : "-";
    const esc = (s) => String(s).replace(/\|/g, "\\|");
    lines.push(`| ${v.panel} | ${v.source} | \`${esc(v.view)}\` | ${per.map(cell).join(" | ")} | ${c ? "`" + esc(c.sel) + "` (+" + c.over + "px) in `" + esc(c.parent) + "`" + (c.pstyle ? " parent style=`" + esc(c.pstyle) + "`" : "") : esc(v.note)} |`);
  }
  lines.push("", `${ok} other view(s) fit at every size.`);
  return lines.join("\n") + "\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
