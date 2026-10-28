/**
 * A live rig for the player bar across first-party pages (bar on every Crow page, 2026-10-16).
 *
 * Real parts: core auth (dashboardAuth / sessions on an init-db'd scratch database), the Funnel middleware,
 * the kiosk runtime's router (the B3 endpoint /api/kiosk/session/media AND the /display/t/* ticket mount
 * with its MAX_CONCURRENT=2 → 429), its media store and tickets, the artifacts bundle's router (the real
 * viewer page, its CSP, its static files, the core player shell through appImport), the vendored Turbo,
 * the emitted player script. Stubbed: the kiosk relay's upstream (a quiet WAV tone is streamed as the
 * "station"), and Tailscale Serve (a request without the Funnel header is given a tailnet login header).
 *
 * Pages (all behind dashboardAuth): /dashboard/nest and /dashboard/artifacts are dashboard-like pages
 * (Turbo + the layout's bar), /dashboard/perch frames the viewer like Perch's "Open beside chat".
 * restart() swaps in a fresh kiosk runtime and cuts every open connection: what a gateway restart does
 * to the in-memory media store and tickets.
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { actAsServe, serveHeaders } from "./serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const REPO = new URL("../..", import.meta.url).pathname;
export const ART_ID = "art_barTest01";
export const MEDIA_PATH = "/api/kiosk/session/media";
export const CSRF = "c5f0c5f0c5f0c5f0c5f0c5f0c5f0c5f0";

/** A quiet 8 kHz tone, `sec` seconds long. */
export function wav(sec) {
  const n = 8000 * sec, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(10 * Math.sin(i / 5));
  return b;
}

export async function startBarRig() {
  const dir = mkdtempSync(join(tmpdir(), "bar-rig-"));
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_HOME = join(dir, "home");
  delete process.env.CROW_DB_PATH;
  delete process.env.CROW_DASHBOARD_PUBLIC;
  delete process.env.CROW_CSRF_STRICT;
  process.env.CROW_APP_ROOT = REPO;
  execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO, env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "ignore" });

  const auth = await import("../../servers/gateway/dashboard/auth.js");
  const csrf = await import("../../servers/gateway/dashboard/shared/csrf.js");
  const store = await import("../../servers/shared/device-store.js");
  const registry = await import("../../servers/gateway/dashboard/settings/registry.js");
  const { createDbClient } = await import("../../servers/db.js");
  const kiosk = await import("../../bundles/kiosk/server/runtime.js");
  const { sessionDisplayId } = await import("../../bundles/kiosk/server/session-display.js");
  const { wrapPcmAsWav } = await import("../../servers/gateway/voice/turn-helpers.js");
  const { rejectFunneledMiddleware } = await import("../../servers/gateway/funnel.js");
  const { playerBarHtml, playerBarJs } = await import("../../servers/gateway/dashboard/shared/player.js");
  const { designTokensCss } = await import("../../servers/gateway/dashboard/shared/design-tokens.js");
  const { default: artifactsRouter } = await import("../../bundles/artifacts/panel/routes.js");
  const artRuntime = await import("../../servers/gateway/artifact-origin/runtime.js");
  const policy = await import("../../servers/gateway/artifact-origin/policy.js");
  const { createLocalBlobStore } = await import("../../bundles/artifacts/server/blob-store.js");
  const { initArtifactsTables } = await import("../../bundles/artifacts/server/init-tables.js");
  const { markdownBlocks } = await import("../../servers/blog/renderer.js");
  const TURBO = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"), "utf8");

  await (await import("./sso-source.mjs")).trustedSsoSource("test");
  const { token: sessionToken } = await auth.mintSsoSession("test");
  const displayId = sessionDisplayId(sessionToken);
  const WAV = wav(240);

  const logs = [];
  const streams = [];          // { status, at } per /display/t request (never the ticket)
  const gets = [];             // the B3 GETs: { owner, item }
  const mediaHits = [];        // every /media/tone.wav request: { range, at }
  let restarts = 0;

  function newRuntime() {
    return kiosk.createKioskRuntime({
      Router: express.Router, json: express.json, WebSocketServer,
      isAllowedNetwork: auth.isAllowedNetwork, csrfMiddleware: csrf.csrfMiddleware, csrfTokenAccepted: csrf.csrfTokenAccepted,
      sessionFromRequest: auth.sessionFromRequest, verifySession: auth.verifySession,
      openDb: () => createDbClient(), deviceStore: store,
      settings: { readSetting: registry.readSetting, writeSetting: registry.writeSetting },
      voice: { runVoiceTurn: async () => ({ route: "fast", timings: {} }), speakText: async () => true },
      sttWarmup: async () => {},
      resolveDisplayBird: async () => ({ species: "crow", seed: 0, mood: "happy", outfit: null, source: "default" }),
      themeCss: () => "", files: { publicDir: join(REPO, "bundles", "kiosk", "public"), birdSvgPath: join(REPO, "bundles", "ramble", "server", "bird-svg.cjs") },
      announceToken: { validate: async () => false }, helloTimeoutMs: 300, wrapPcmAsWav,
      // The upstream: the tone, streamed slowly enough to stay a live stream for the test's length.
      relay: {
        toResponse: async (_resource, req, res, { signal }) => {
          res.status(200).setHeader("content-type", "audio/wav");
          let off = 0, done = false;
          const finish = () => { done = true; };
          signal.addEventListener("abort", () => { finish(); res.destroy(); }, { once: true });
          res.on("close", finish);
          while (!done && off < WAV.length) {
            const n = off === 0 ? 240000 : 8000;   // 30 s at once (the media demuxer probes before it plays), then 1 s per second
            if (!res.write(WAV.subarray(off, off + n))) await new Promise((r) => res.once("drain", r));
            off += n;
            await new Promise((r) => setTimeout(r, 900));
          }
          if (!done) res.end();
          return signal.aborted ? "aborted" : "ok";
        },
      },
      setInterval: () => ({ unref() {} }),
      log: (m) => logs.push(m),
    });
  }
  let k = newRuntime();
  let kRouter = k.router(auth.dashboardAuth);

  // The artifacts bundle's own router, on its own tables (as tests/artifacts-panel-routes.test.js).
  const artDb = createDbClient(join(dir, "artifacts.db"));
  await initArtifactsTables(artDb);
  artRuntime._resetForTest();

  const page = (title, body, { turbo = true, bar = true } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
${turbo ? `<script>${TURBO}</script>` : ""}<style>${designTokensCss()} body{margin:0;font:15px system-ui;background:var(--crow-bg-deep)} main{padding:16px 16px 120px} a{display:inline-block;padding:12px;margin:4px;background:#ddd}</style></head>
<body><main><h1 id="h">${title}</h1>${body}</main>${bar ? `${playerBarHtml("en")}<script>${playerBarJs("en")}</script>` : ""}</body></html>`;
  const viewerHref = `/dashboard/artifacts/view/${ART_ID}`;

  const app = express();
  app.set("trust proxy", false);
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  // Tailscale Serve stand-in: tailnet requests carry Serve's headers (this process plays tailscaled's uid,
  // see serve-peer.mjs); a Funnel request carries only its own header.
  app.use((req, _res, next) => { if (!req.headers["tailscale-funnel-request"]) Object.assign(req.headers, serveHeaders("alex@example.com")); next(); });
  app.use(rejectFunneledMiddleware());
  app.use((req, res, next) => {
    if (req.path.startsWith("/display/t/")) { streams.push({ start: true, range: req.headers.range || null }); res.on("finish", () => streams.push({ status: res.statusCode, at: Date.now() })); res.on("close", () => { if (!res.writableFinished) streams.push({ status: res.statusCode, at: Date.now(), cut: true }); }); }
    if (req.path === MEDIA_PATH && req.method === "GET") {
      const owner = req.headers["x-crow-owner"] || null;
      const orig = res.json.bind(res);
      res.json = (b) => { gets.push({ owner, item: !!(b && b.item), title: b && b.item ? b.item.title : null }); return orig(b); };
    }
    next();
  });
  app.get("/dashboard/nest", auth.dashboardAuth, (_req, res) => res.type("html").send(page("Nest", `<a id="viewer" data-turbo="false" href="${viewerHref}">Open artifact</a><a id="lib" href="/dashboard/artifacts">Artifacts</a>`)));
  app.get("/dashboard/artifacts", auth.dashboardAuth, (_req, res) => res.type("html").send(page("Library", `<a id="viewer" data-turbo="false" href="${viewerHref}">Open artifact</a><a id="nest" href="/dashboard/nest">Nest</a>`)));
  app.get("/dashboard/perch", auth.dashboardAuth, (_req, res) => res.type("html").send(page("Perch", `<iframe id="sheet" src="${viewerHref}" style="width:100%;height:500px;border:0"></iframe>`)));
  // A podcast-like file: seekable (byte ranges), as a real podcast host serves it.
  app.get("/media/tone.wav", auth.dashboardAuth, (req, res) => {
    mediaHits.push({ range: req.headers.range || null, at: Date.now() });
    res.type("audio/wav").setHeader("accept-ranges", "bytes");
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ""));
    if (!m) { res.setHeader("content-length", WAV.length); return res.end(WAV); }
    const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), WAV.length - 1) : WAV.length - 1;
    res.status(206).setHeader("content-range", `bytes ${start}-${end}/${WAV.length}`);
    res.setHeader("content-length", end - start + 1);
    res.end(WAV.subarray(start, end + 1));
  });
  app.use(artifactsRouter(auth.dashboardAuth, {
    db: artDb, blobs: createLocalBlobStore(join(dir, "blobs")), runtime: artRuntime, policy, csrf: csrf.csrfMiddleware, renderDeps: { markdownBlocks },
    engine: { async list() { return []; }, async spawn() { return {}; }, async message() {} },
    loadBotDef: async () => ({ tools: {} }), createBoardCard: null, emitExternal: async () => ({ delivered: false }), notify: async () => {},
  }));
  app.use((req, res, next) => kRouter(req, res, next));

  const srv = http.createServer(app);
  const conns = new Set();
  srv.on("connection", (c) => { conns.add(c); c.on("close", () => conns.delete(c)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  return {
    base, viewerHref, sessionToken, displayId, logs, streams, gets, mediaHits,
    get k() { return k; },
    get restarts() { return restarts; },
    cookies: () => [
      { name: "crow_session", value: sessionToken, url: base },
      { name: "crow_csrf", value: CSRF, url: base },
    ],
    /** The voice overlay played a station for this login, handed to the tab that owns `owner`. → the load op. */
    playStation(owner, title = "KPFT HD1", source = "radio") {
      k.media.setOwner(displayId, owner);
      k.media.play(displayId, [{ upstream: { url: "https://stream.example.invalid/kpft", hop: { kind: "public" } }, title, subtitle: "", source }]);
      const v = k.media.view(displayId);
      return { crow: "media", v: 1, op: "load", id: v.item.id, url: v.item.url, title: v.item.title, subtitle: "", source: v.item.source, live: v.item.live, volume: 0.5, paused: false, has_next: false, has_previous: false };
    },
    /** A gateway restart: the in-memory media store and tickets are gone, open connections are cut. */
    restart() {
      k.stop();
      k = newRuntime();
      kRouter = k.router(auth.dashboardAuth);
      restarts++;
      for (const c of conns) c.destroy();
    },
    close() {
      try { k.stop(); } catch {}
      for (const c of conns) c.destroy();
      srv.close();
      artRuntime._resetForTest();
      try { artDb.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A CDP tab helper: navigate, evaluate (optionally as a user gesture), click for real, screenshot. */
export async function openTab(chrome, { targetId = null, width = 1280, height = 800, mobile = false } = {}) {
  let t;
  if (targetId) t = (await (await fetch(chrome.cdp + "/json/list")).json()).find((x) => x.id === targetId);
  else t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const events = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.method) events.push(m); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expression, { gesture = false } = {}) => {
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
    return o.exceptionDetails ? { threw: o.exceptionDetails.text + " " + JSON.stringify(o.exceptionDetails.exception?.description || "") } : o.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  return {
    id: t.id, send, evalIn, events,
    async go(url) { await send("Page.navigate", { url }); },
    /**
     * Run `expression` that leaves the page (a link click, history.back()) AFTER Runtime.evaluate has answered:
     * evaluated directly, a navigation that commits first (a loaded box) rejects the call with "Inspected target
     * navigated or closed". Follow it with until(...) on the next page.
     */
    async navigate(expression) { await evalIn(`(setTimeout(function () { ${expression}; }, 0), true)`); },
    /** A real mouse click at the centre of `selector` (a user gesture, as on a phone or a desktop). */
    async click(selector) {
      const r = await evalIn(`(function(){ var e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); var b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
    },
    async shot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(evalIn, expr, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await evalIn(expr); } catch { v = null; }
    if (v === true || Date.now() > end) return v;
    await sleep(100);
  }
}

/** The bar as the test sees it. */
export const BAR = `(function(){
  var b = document.getElementById('crow-player-bar'), a = document.getElementById('crow-audio');
  if (!b) return { exists: false };
  var t = document.getElementById('crow-player-toggle');
  return { exists: true, visible: b.style.display !== 'none' && b.getBoundingClientRect().height > 0,
    title: document.getElementById('crow-player-title').textContent, subtitle: document.getElementById('crow-player-subtitle').textContent,
    playing: !!a && !a.paused && a.currentTime > 0, paused: !a || a.paused, pulse: /crow-pulse/.test(t.style.animation || ''), toggleDisabled: t.disabled,
    marker: (function(){ try { return localStorage.getItem('crow-player-state'); } catch (e) { return 'ERR'; } })(),
    ring: window.crowPlayer && window.crowPlayer.debug ? window.crowPlayer.debug() : [] };
})()`;
