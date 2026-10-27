/**
 * The preview renderer's escape cases (P0′ Task 0′.3, R4-C1/C2/C3), shared by the two
 * live files: tests/preview-escape-live.test.js drives the fixture's Chrome over its
 * pipe, and tests/preview-escape-container-live.test.js drives the real preview
 * container through renderer.acquire(). Each file supplies `withCdp(fn)`, which runs
 * `fn(cdp)` on a browser and tidies up after it; everything else is the same.
 *
 * The harness is a real artifact origin (startArtifactOrigin, a real view-token store,
 * a stub content resolver), a real createOriginFetcher to it, an "outside" server and a
 * stand-in for a DevTools listener (127.0.0.1:9222's role), each counting hits. Test
 * pages are `document` grants minted with scriptsOff (they speak, so a meta refresh is
 * attempted) and dashboardOrigin null. Every escape must record zero hits, and where
 * the case says so, the render must reject so there is nothing to save.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Image, createCanvas } from "@napi-rs/canvas";
import { startArtifactOrigin } from "../../servers/gateway/artifact-origin/server.js";
import { createViewTokenStore } from "../../servers/gateway/artifact-origin/view-tokens.js";
import { createOriginFetcher } from "../../servers/gateway/preview/origin-fetch.js";
import { renderInContext } from "../../servers/gateway/preview/render.js";

/** The public hostname the browser sees (the container maps every other name to NOTFOUND). */
export const ARTIFACT_HOST = "artifacts.example.test";
const MiB = 1024 * 1024;
const FONT = readFileSync(new URL("../../bundles/design-kit/lib/font/young-serif/young-serif-latin-400-normal.woff2", import.meta.url));

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function counting(name, handler) {
  const hits = [];
  const s = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: { ...req.headers } });
    if (handler) return handler(req, res);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<h1>${name}</h1>`);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { server: s, port: s.address().port, hits };
}
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });

/** Decoded RGBA pixels of a PNG. */
export async function pixels(png) {
  const img = new Image();
  img.src = png;
  await img.decode();
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}
/** The fraction of pixels that differ between two same-size PNGs. */
export async function diffFraction(a, b) {
  const A = await pixels(a), B = await pixels(b);
  assert.equal(A.width, B.width);
  assert.equal(A.height, B.height);
  let n = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2] || A.data[i + 3] !== B.data[i + 3]) n++;
  }
  return n / (A.width * A.height);
}

/** A fetcher whose every get is logged: { path, ok, status?, reason?, ms }. */
function recordingFetcher(fetcher, log) {
  return {
    session(o) {
      const s = fetcher.session(o);
      return {
        async get(path) {
          const t0 = Date.now();
          const r = await s.get(path);
          log.push({ path, ok: r.ok, status: r.status, reason: r.reason, ms: Date.now() - t0 });
          return r;
        },
        stats: () => s.stats(),
      };
    },
  };
}

/**
 * @param {{ withCdp: (fn: (cdp: any) => Promise<any>) => Promise<any> }} o
 */
export async function startEscapeHarness({ withCdp }) {
  const tokens = createViewTokenStore();
  const content = new Map();        // artifactId -> { [path]: { body, contentType } | "hang" }
  const originHits = [];            // { artifactId, path }
  const rawCookies = [];            // the Cookie header as it arrived at the origin's socket
  const hangs = [];
  const resolveContent = async ({ artifactId, path }) => {
    originHits.push({ artifactId, path });
    const c = (content.get(artifactId) || {})[path];
    if (c === "hang") return new Promise((r) => hangs.push(r));
    return c || null;
  };
  const port = await freePort();
  const base = `http://${ARTIFACT_HOST}:${port}`;
  const origin = await startArtifactOrigin({ port, host: "127.0.0.1", tokens, publicBase: base, resolveContent });
  origin.prependListener("request", (req) => { rawCookies.push(req.headers.cookie ?? null); });
  const fetcher = createOriginFetcher({ host: "127.0.0.1", port });
  const outside = await counting("outside");
  const standin = await counting("devtools");
  const stubs = [];
  let n = 0;

  const h = {
    base, port, tokens, originHits, rawCookies, outside, standin, fetcher,
    /** Mint a document grant for these files. */
    page(files, { type = "document" } = {}) {
      const artifactId = `esc-${++n}`;
      content.set(artifactId, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" && v !== "hang" ? { body: v, contentType: "text/html; charset=utf-8" } : v])));
      const { token, tokenId } = tokens.mint({ artifactId, versionN: 1, type, dashboardOrigin: null, scriptsOff: true });
      const allowPrefix = `${base}/v/${token}/`;
      return { artifactId, token, tokenId, url: allowPrefix, allowPrefix };
    },
    /** A stub origin (the real one never sends a 3xx); its own fetcher. */
    async stub(handler) {
      const s = await counting("stub", handler);
      stubs.push(s.server);
      return { ...s, fetcher: createOriginFetcher({ host: "127.0.0.1", port: s.port }) };
    },
    /**
     * One render, never throwing: { png, err, ms, fetchLog, paused, sends, cookies }.
     * `paused` is every Fetch.requestPaused URL; `sends` every CDP call made by the
     * render; `cookies` the context's cookies just before the capture (cookiesAtCapture).
     */
    async render({ pageOf, fetcher: f = fetcher, mainType = "text/html", timeoutMs, cookiesAtCapture = false }) {
      const fetchLog = [];
      const paused = [];
      const sends = [];
      let cookies = null;
      return withCdp(async (cdp) => {
        let ctxId = null;
        const onPaused = (p) => paused.push(p.request?.url);
        cdp.on("Fetch.requestPaused", onPaused);
        const spy = {
          async send(method, params, sid) {
            sends.push({ method, params, sid });
            if (method === "Page.captureScreenshot" && cookiesAtCapture) cookies = (await cdp.send("Storage.getCookies", { browserContextId: ctxId })).cookies;
            const r = await cdp.send(method, params, sid);
            if (method === "Target.createBrowserContext") ctxId = r.browserContextId;
            return r;
          },
          on: (e, fn) => cdp.on(e, fn),
          off: (e, fn) => cdp.off(e, fn),
        };
        const t0 = Date.now();
        let png = null, err = null;
        try {
          png = await renderInContext(spy, { url: pageOf.url, allowPrefix: pageOf.allowPrefix, mainType, fetcher: recordingFetcher(f, fetchLog), ...(timeoutMs ? { timeoutMs } : {}) });
        } catch (e) { err = e; }
        cdp.off("Fetch.requestPaused", onPaused);
        return { png, err, ms: Date.now() - t0, fetchLog, paused, sends, cookies };
      });
    },
    async close() {
      for (const r of hangs) r(null);
      await Promise.all([close(origin), close(outside.server), close(standin.server), ...stubs.map(close)]);
    },
  };
  return h;
}

const noEscapes = (h) => {
  assert.equal(h.outside.hits.length, 0, `outside hits: ${JSON.stringify(h.outside.hits.map((x) => x.url))}`);
  assert.equal(h.standin.hits.length, 0, `stand-in hits: ${JSON.stringify(h.standin.hits.map((x) => x.url))}`);
};
const rejects = (r, code) => {
  assert.equal(r.png, null, "nothing to save");
  assert.equal(r.err?.code, code, `rejects with ${code}: ${r.err?.code} ${r.err?.message}`);
};
const doc = (body, head = "") => `<!doctype html><html><head>${head}</head><body style="margin:0;background:#fff">${body}</body></html>`;
const BLOCKS = `<div style="width:300px;height:200px;background:#c33"></div><div style="width:300px;height:150px;background:#36c;margin-left:320px"></div>`;

/**
 * The cases, each `{ name, run(h, log) }`. A case resets the hit counters it reads.
 * `log(line)` reports outcomes (hits, timings, RSS) for the task report.
 */
export const ESCAPE_CASES = [
  {
    name: "a meta refresh to a DevTools listener is refused (preview_navigated)",
    async run(h, log) {
      h.standin.hits.length = 0; h.outside.hits.length = 0;
      const pg = h.page({ "index.html": doc("<h1>x</h1>", `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${h.standin.port}/json/version">`) });
      const r = await h.render({ pageOf: pg });
      log(`meta refresh: ${r.err?.code || "captured"} in ${r.ms} ms; stand-in hits ${h.standin.hits.length}`);
      rejects(r, "preview_navigated");
      await new Promise((res) => setTimeout(res, 300));
      noEscapes(h);
    },
  },
  {
    name: "a cross-origin iframe is refused (preview_navigated)",
    async run(h, log) {
      h.outside.hits.length = 0;
      const pg = h.page({ "index.html": doc(`<h1>x</h1><iframe src="http://127.0.0.1:${h.outside.port}/frame"></iframe>`) });
      const r = await h.render({ pageOf: pg });
      log(`iframe: ${r.err?.code || "captured"} in ${r.ms} ms; outside hits ${h.outside.hits.length}`);
      rejects(r, "preview_navigated");
      noEscapes(h);
    },
  },
  {
    name: "the same iframe nested inside an allowed one is refused (preview_navigated)",
    async run(h, log) {
      h.outside.hits.length = 0;
      const pg = h.page({
        "index.html": doc(`<h1>x</h1><iframe src="inner.html"></iframe>`),
        "inner.html": doc(`<iframe src="http://127.0.0.1:${h.outside.port}/frame"></iframe>`),
      });
      const r = await h.render({ pageOf: pg });
      log(`nested iframe: ${r.err?.code || "captured"} in ${r.ms} ms; outside hits ${h.outside.hits.length}; inner.html served ${h.originHits.filter((x) => x.artifactId === pg.artifactId && x.path === "inner.html").length}`);
      rejects(r, "preview_navigated");
      noEscapes(h);
    },
  },
  {
    name: "a 302 for the main document is preview_bad_status, never followed",
    async run(h, log) {
      h.outside.hits.length = 0;
      const stub = await h.stub((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${h.outside.port}/x` }); res.end(); });
      const pg = h.page({});
      const r = await h.render({ pageOf: pg, fetcher: stub.fetcher });
      log(`main 302: ${r.err?.code || "captured"} in ${r.ms} ms; stub hits ${stub.hits.length}; outside hits ${h.outside.hits.length}`);
      rejects(r, "preview_bad_status");
      assert.equal(stub.hits.length, 1);
      noEscapes(h);
    },
  },
  {
    name: "a 302 on an image leaves the render finishing with the image missing",
    async run(h, log) {
      h.outside.hits.length = 0;
      const stub = await h.stub((req, res) => {
        if (req.url.endsWith("/a.png")) { res.writeHead(302, { location: `http://127.0.0.1:${h.outside.port}/x.png` }); return res.end(); }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(doc(`${BLOCKS}<img src="a.png" width="200" height="100">`));
      });
      const pg = h.page({});
      const r = await h.render({ pageOf: pg, fetcher: stub.fetcher });
      const img = r.fetchLog.find((x) => x.path.endsWith("/a.png"));
      log(`image 302: ${r.err?.code || "captured"} in ${r.ms} ms; a.png → ${img?.reason || img?.status}; outside hits ${h.outside.hits.length}`);
      assert.ok(r.png, `rendered: ${r.err?.code} ${r.err?.message}`);
      assert.equal(img?.reason, "redirect");
      noEscapes(h);
    },
  },
  {
    name: "a meta refresh to file:// reads nothing (preview_navigated, or the same capture as without it)",
    async run(h, log) {
      const pg = h.page({ "index.html": doc(BLOCKS, `<meta http-equiv="refresh" content="0;url=file:///etc/hostname">`) });
      const r = await h.render({ pageOf: pg });
      log(`file refresh: ${r.err?.code || "captured"} in ${r.ms} ms`);
      if (r.err) return rejects(r, "preview_navigated");
      const plain = await h.render({ pageOf: h.page({ "index.html": doc(BLOCKS) }) });
      assert.ok(plain.png);
      assert.equal(await diffFraction(r.png, plain.png), 0, "pixel-equal to the same page without the refresh");
    },
  },
  {
    name: "a script beacon does nothing with scripts off",
    async run(h, log) {
      h.outside.hits.length = 0;
      const pg = h.page({ "index.html": doc(`${BLOCKS}<script>navigator.sendBeacon("beacon", "x"); fetch("fetch"); new Image().src = "http://127.0.0.1:${h.outside.port}/b"; location.href = "http://127.0.0.1:${h.outside.port}/nav";</script>`) });
      const r = await h.render({ pageOf: pg });
      await new Promise((res) => setTimeout(res, 300));
      const hits = h.originHits.filter((x) => x.artifactId === pg.artifactId).map((x) => x.path);
      log(`script beacon: ${r.err?.code || "captured"} in ${r.ms} ms; origin paths ${JSON.stringify(hits)}; outside hits ${h.outside.hits.length}`);
      assert.ok(r.png, `rendered: ${r.err?.code} ${r.err?.message}`);
      assert.deepEqual(hits, ["index.html"]);
      noEscapes(h);
    },
  },
  {
    name: "an attachment download writes no file and saves nothing",
    async run(h, log) {
      const dl = join(homedir(), "Downloads");
      const list = () => { try { return readdirSync(dl).sort(); } catch { return []; } };
      const before = list();
      const stub = await h.stub((req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\"crow-preview-escape.bin\"" });
        res.end(Buffer.alloc(1024, 1));
      });
      const r = await h.render({ pageOf: h.page({}), fetcher: stub.fetcher, timeoutMs: 4000 });
      log(`download: ${r.err?.code || "captured"} in ${r.ms} ms; Downloads entries before ${before.length}, after ${list().length}`);
      assert.equal(r.png, null, "nothing to save");
      assert.ok(["preview_bad_status", "preview_navigated", "preview_timeout"].includes(r.err?.code), r.err?.message);
      assert.deepEqual(list(), before, "no file written");
    },
  },
  {
    name: "a cookie in the default context never reaches the render's context or the origin",
    async run(h, log, withCdp) {
      await withCdp(async (cdp) => {
        await cdp.send("Storage.setCookies", { cookies: [{ name: "crow_session", value: "SECRET", domain: ARTIFACT_HOST, path: "/" }] });
        const def = (await cdp.send("Storage.getCookies", {})).cookies;
        assert.ok(def.some((c) => c.name === "crow_session"), "the cookie is set in the default context (positive control)");
      });
      h.rawCookies.length = 0;
      const r = await h.render({ pageOf: h.page({ "index.html": doc(BLOCKS) }), cookiesAtCapture: true });
      await withCdp((cdp) => cdp.send("Storage.clearCookies", {}));
      log(`cookie: ${r.err?.code || "captured"} in ${r.ms} ms; context cookies ${JSON.stringify(r.cookies)}; origin Cookie headers ${JSON.stringify(h.rawCookies)}`);
      assert.ok(r.png, `rendered: ${r.err?.code} ${r.err?.message}`);
      assert.deepEqual(r.cookies, []);
      assert.ok(h.rawCookies.length >= 1 && h.rawCookies.every((c) => c === null), "the origin saw no Cookie header");
    },
  },
  {
    name: "the CSP survives the fulfill: another live token's image is never requested",
    async run(h, log) {
      const other = h.page({ "x.png": { body: Buffer.alloc(64), contentType: "image/png" } });
      const pg = h.page({ "index.html": doc(`${BLOCKS}<img src="${h.base}/v/${other.token}/x.png">`) });
      const r = await h.render({ pageOf: pg });
      const otherHits = h.originHits.filter((x) => x.artifactId === other.artifactId).length;
      const otherPaused = r.paused.filter((u) => String(u).includes(other.token)).length;
      log(`CSP img: ${r.err?.code || "captured"} in ${r.ms} ms; other token origin hits ${otherHits}, requestPaused ${otherPaused}`);
      assert.ok(r.png, `rendered: ${r.err?.code} ${r.err?.message}`);
      assert.equal(otherHits, 0);
      assert.equal(otherPaused, 0, "the browser's CSP stopped it before interception");
    },
  },
  {
    name: "a font from the token path draws, and its fulfill carried ACAO *",
    async run(h, log) {
      const css = `<style>@font-face{font-family:Probe;src:url(f.woff2) format("woff2")} body{font:64px/1.1 Probe, sans-serif}</style>`;
      const text = "<p style='margin:8px'>Quartz glyph WAVE 1234</p>";
      const withFont = await h.render({ pageOf: h.page({ "index.html": doc(text, css), "f.woff2": { body: FONT, contentType: "font/woff2" } }) });
      const without = await h.render({ pageOf: h.page({ "index.html": doc(text, css) }) });
      assert.ok(withFont.png && without.png, `rendered: ${withFont.err?.message} ${without.err?.message}`);
      const frac = await diffFraction(withFont.png, without.png);
      const fulfill = withFont.sends.find((s) => s.method === "Fetch.fulfillRequest" && s.params.responseHeaders.some((x) => x.name === "content-type" && x.value === "font/woff2"));
      log(`font: ${(frac * 100).toFixed(2)}% of pixels differ; font fulfill ACAO ${JSON.stringify(fulfill?.params.responseHeaders.find((x) => x.name === "access-control-allow-origin"))}; f.woff2 without → ${without.fetchLog.find((x) => x.path.endsWith("f.woff2"))?.status}`);
      assert.ok(frac > 0.01, `more than 1% of pixels differ (${frac})`);
      assert.ok(fulfill, "the font was fulfilled");
      assert.deepEqual(fulfill.params.responseHeaders.find((x) => x.name === "access-control-allow-origin"), { name: "access-control-allow-origin", value: "*" });
    },
  },
  {
    name: "a 20 MB image is cut at the cap, the page renders, and the gateway's RSS stays bounded",
    async run(h, log) {
      const big = Buffer.alloc(20 * MiB, 0x42);
      const pg = h.page({ "index.html": doc(`${BLOCKS}<img src="big.png" width="100" height="100">`), "big.png": { body: big, contentType: "image/png" } });
      globalThis.gc?.();
      await new Promise((res) => setTimeout(res, 100));
      const before = process.memoryUsage().rss;
      let peak = before;
      const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
      const r = await h.render({ pageOf: pg });
      peak = Math.max(peak, process.memoryUsage().rss);
      clearInterval(t);
      const img = r.fetchLog.find((x) => x.path.endsWith("/big.png"));
      log(`20 MB image: ${r.err?.code || "captured"} in ${r.ms} ms; big.png → ${img?.reason || img?.status}; RSS before ${before}, peak ${peak}, growth ${peak - before} bytes`);
      assert.ok(r.png, `rendered: ${r.err?.code} ${r.err?.message}`);
      assert.equal(img?.reason, "cap_response");
      assert.ok(peak - before < 41_943_040, `RSS grew ${peak - before} bytes`);
    },
  },
  {
    name: "a streamed 20 MB image (no content-length) is cut at 8 MB, and the gateway's RSS stays bounded",
    async run(h, log) {
      // The real origin always declares its length; a stub that streams without one
      // exercises the byte count instead of the declared-size check.
      const chunk = Buffer.alloc(64 * 1024, 0x42);
      const stub = await h.stub(async (req, res) => {
        if (!req.url.endsWith("/big.png")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(doc(`${BLOCKS}<img src="big.png" width="100" height="100">`));
        }
        res.writeHead(200, { "content-type": "image/png" });
        for (let sent = 0; sent < 20 * MiB && !res.destroyed; sent += chunk.length) {
          if (!res.write(chunk)) await new Promise((r) => { res.once("drain", r); res.once("close", r); });
        }
        if (!res.destroyed) res.end();
      });
      globalThis.gc?.();
      await new Promise((res) => setTimeout(res, 100));
      const before = process.memoryUsage().rss;
      let peak = before;
      const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
      const r = await h.render({ pageOf: h.page({}), fetcher: stub.fetcher });
      peak = Math.max(peak, process.memoryUsage().rss);
      clearInterval(t);
      const img = r.fetchLog.find((x) => x.path.endsWith("/big.png"));
      log(`streamed 20 MB image: ${r.err?.code || "captured"} in ${r.ms} ms; big.png → ${img?.reason || img?.status} after ${img?.ms} ms; RSS before ${before}, peak ${peak}, growth ${peak - before} bytes`);
      assert.ok(r.png, `rendered: ${r.err?.code} ${r.err?.message}`);
      assert.equal(img?.reason, "cap_response");
      assert.ok(peak - before < 41_943_040, `RSS grew ${peak - before} bytes`);
    },
  },
  {
    name: "a slow origin: the stylesheet times out at 5 s and the render still finishes before 15 s",
    async run(h, log) {
      const pg = h.page({ "index.html": doc(BLOCKS, `<link rel="stylesheet" href="slow.css">`), "slow.css": "hang" });
      const r = await h.render({ pageOf: pg });
      const css = r.fetchLog.find((x) => x.path.endsWith("/slow.css"));
      log(`slow origin: ${r.err?.code || "captured"} in ${r.ms} ms; slow.css → ${css?.reason} after ${css?.ms} ms`);
      assert.ok(r.png, `rendered: ${r.err?.code} ${r.err?.message}`);
      assert.equal(css?.reason, "timeout");
      assert.ok(css.ms >= 4500 && css.ms <= 5500, `timed out after ${css.ms} ms`);
      assert.ok(r.ms < 15_000, `finished in ${r.ms} ms`);
    },
  },
];
