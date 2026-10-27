/**
 * One preview render, in a fresh, locked-down browser context (P0′ Task 0′.3).
 *
 * The preview browser has no network (network_mode none). Every request a page makes
 * is paused over CDP Fetch, and the gateway answers it here:
 *   - only this render's token path (`${baseUrl}/v/<token>/`) is allowed, never the
 *     whole origin, another token's path or another host (isAllowed);
 *   - an allowed request is fetched from the artifact origin's own listener by the
 *     bounded loopback fetcher (origin-fetch.js), path and query only, and answered with
 *     the origin's own status and headers (its CSP sandbox, its source lists, ACAO on
 *     fonts), minus the hop-by-hop headers (fulfillHeaders);
 *   - everything else is failed (BlockedByClient). A sub-resource past a cap is simply
 *     missing from the capture.
 * The URL the browser sees stays the origin's public base, so the CSP holds.
 *
 * Scripts are off in every session (Emulation), downloads are denied, the context is a
 * throwaway one (never the default context, so no cookie or storage from anywhere
 * else), auto-attach is recursive (nested out-of-process frames and workers are paused
 * until they are set up the same way), and the browser-level session intercepts too, as
 * a backstop for any target that slips past auto-attach.
 *
 * A navigation away is REFUSED, never captured (R4-C1): a document request outside the
 * token path in any frame, a second main-frame document, or a main-frame commit to any
 * URL but `url` (a blocked navigation commits Chrome's error page) rejects with
 * preview_navigated, so there is nothing to save. Two signals beyond those, both seen
 * live: a sub-frame that commits anything outside the token path (the CSP's frame-src
 * 'none' stops every frame before a request, so no document is paused and the frame
 * commits chrome-error://chromewebdata/ inside the page), and a scheduled or requested
 * navigation of the committed main frame (a meta refresh is scheduled just after the
 * load event, so waiting for its document request would race the capture). The capture
 * waits for the load event; the 15 s render timeout bounds it.
 *
 * Errors (all with nothing to save) carry `code`: preview_timeout, preview_bad_status,
 * preview_navigated, preview_too_large.
 *
 * Renders on one CDP client run one at a time: the browser-level Fetch backstop and
 * auto-attach are browser-wide, and a paused request on the browser session cannot be
 * told apart by context.
 */
import { createCanvas, Image } from "@napi-rs/canvas";
import { PREVIEW_LIMITS } from "./origin-fetch.js";

/** The main document's media type per eligible artifact type (engineering question 3). */
export const MAIN_DOCUMENT_TYPES = Object.freeze({ page: "text/html", document: "text/html", diagram: "application/xhtml+xml" });

/** Origin headers a fulfill never carries (R4-C3). content-encoding: the body is decoded. */
export const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding"];
const HOP = new Set(HOP_BY_HOP);

/** Wait for the browser to tidy up after a render, at most this long. */
const CLEANUP_MS = 5000;

const fail = (code, message) => Object.assign(new Error(message || code), { code });

/**
 * Every origin header except the hop-by-hop ones, values unchanged.
 * @param {[string, string][] | Record<string, string | string[]>} originHeaders
 * @returns {{ name: string, value: string }[]}
 */
export function fulfillHeaders(originHeaders) {
  const pairs = Array.isArray(originHeaders)
    ? originHeaders
    : Object.entries(originHeaders || {}).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
  const out = [];
  for (const [name, value] of pairs) {
    if (value == null || HOP.has(String(name).toLowerCase())) continue;
    out.push({ name: String(name), value: String(value) });
  }
  return out;
}

/**
 * True only for a URL inside this render's token path: it parses, has no credentials,
 * and origin + pathname starts with `allowPrefix` (`${baseUrl}/v/<token>/`).
 */
export function isAllowed(url, allowPrefix) {
  if (typeof allowPrefix !== "string" || !allowPrefix.endsWith("/")) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.username || u.password) return false;
  return (u.origin + u.pathname).startsWith(allowPrefix);
}

function mediaTypeOf(headers) {
  const ct = fulfillHeaders(headers).find((h) => h.name.toLowerCase() === "content-type");
  return ct ? ct.value.split(";")[0].trim().toLowerCase() : "";
}

// One render at a time per CDP client (see the header).
const queues = new WeakMap();

/**
 * @param {{ send(method: string, params?: object, sessionId?: string): Promise<any>, on(e: string, fn: Function): void, off(e: string, fn: Function): void }} cdp
 * @param {{ url: string, allowPrefix: string, mainType: string, fetcher: { session(o: { signal: AbortSignal }): { get(p: string): Promise<any> } }, width?: number, height?: number, timeoutMs?: number }} o
 * @returns {Promise<Buffer>} the PNG
 */
export function renderInContext(cdp, o) {
  const prev = queues.get(cdp) || Promise.resolve();
  const run = prev.then(() => renderOnce(cdp, o));
  queues.set(cdp, run.catch(() => {}));
  return run;
}

async function renderOnce(cdp, { url, allowPrefix, mainType, fetcher, width = 640, height = 400, timeoutMs = PREVIEW_LIMITS.renderMs }) {
  if (!isAllowed(url, allowPrefix)) throw fail("preview_navigated", "the render URL is outside its own token path");
  const ac = new AbortController();
  const session = fetcher.session({ signal: ac.signal });

  // The first fatal outcome wins; every wait below races it.
  let stopErr = null;
  let stop;
  const stopped = new Promise((_, reject) => { stop = (err) => { if (!stopErr) { stopErr = err; reject(err); } }; });
  stopped.catch(() => {});
  const race = (p) => Promise.race([p, stopped]);
  const timer = setTimeout(() => stop(fail("preview_timeout", `the render took longer than ${timeoutMs} ms`)), timeoutMs);

  const listeners = [];
  const on = (ev, fn) => { cdp.on(ev, fn); listeners.push([ev, fn]); };

  let browserContextId = null;
  let targetId = null;
  let resolveTarget;
  const targetKnown = new Promise((r) => { resolveTarget = r; });
  let resolvePage;
  const pageSession = new Promise((r) => { resolvePage = r; });
  let pageSid = null;
  const ours = new Set();          // sessions in this render's tree
  const answered = new Set();      // requestIds already answered (exactly once each)

  // R4-C1: the navigation record.
  let navigated = false;
  let mainDocs = 0;
  let counting = false;
  let mainCommits = 0;
  let committedUrl = null;
  let resolveLoaded;
  const loaded = new Promise((r) => { resolveLoaded = r; });

  const check = () => {
    if (navigated || mainDocs !== 1 || mainCommits !== 1 || committedUrl !== url) {
      throw fail("preview_navigated", `navigated=${navigated} mainDocs=${mainDocs} mainCommits=${mainCommits} committed=${committedUrl}`);
    }
  };

  async function onPaused(p, msg) {
    const sid = msg?.sessionId;
    if (sid && !ours.has(sid)) return;   // another client's session: not ours to answer
    const { requestId, request = {}, resourceType, frameId } = p;
    if (!requestId || answered.has(requestId)) return;
    answered.add(requestId);
    const reply = (method, params) => cdp.send(method, { requestId, ...params }, sid).catch(() => {});
    const refuse = () => reply("Fetch.failRequest", { errorReason: "BlockedByClient" });

    const isDoc = resourceType === "Document";
    const allowed = isAllowed(request.url, allowPrefix);
    if (isDoc && !allowed) {
      navigated = true;
      await refuse();
      return markNavigated("a frame tried to load a document outside the token path");
    }
    const isMain = isDoc && targetId !== null && frameId === targetId;
    if (isMain && ++mainDocs > 1) {
      await refuse();
      return markNavigated("a second main-frame document");
    }
    if (!allowed || (request.method && request.method !== "GET")) return refuse();

    const u = new URL(request.url);
    const r = await session.get(u.pathname + u.search);
    if (isMain) {
      let err = null;
      if (!r.ok) {
        err = r.reason === "cap_response" || r.reason === "cap_render" ? fail("preview_too_large", `the main document: ${r.reason}`)
          : r.reason === "aborted" ? null
          : fail("preview_bad_status", `the main document: ${r.reason}`);
      } else if (r.status !== 200) err = fail("preview_bad_status", `the main document answered ${r.status}`);
      else if (mediaTypeOf(r.headers) !== mainType) err = fail("preview_bad_status", `the main document is ${mediaTypeOf(r.headers) || "untyped"}, not ${mainType}`);
      if (err || !r.ok) {
        await refuse();
        if (err) stop(err);
        return;
      }
    }
    if (!r.ok) return refuse();
    return reply("Fetch.fulfillRequest", {
      responseCode: r.status,
      responseHeaders: fulfillHeaders(r.headers),
      body: r.body.toString("base64"),
    });
  }

  const FETCH_ALL = { patterns: [{ urlPattern: "*", requestStage: "Request" }] };
  const AUTO = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

  // Steps 6–7 for one attached session, then let it run.
  async function setUp(sid, info) {
    await cdp.send("Target.setAutoAttach", AUTO, sid).catch(() => {});
    // Not every target type has Emulation (a worker); its scripts are blocked anyway
    // (worker-src 'none'), and its requests are still paused below.
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: true }, sid).catch(() => {});
    // A session that can't be intercepted is never resumed.
    await cdp.send("Fetch.enable", FETCH_ALL, sid);
    await targetKnown;
    if (info?.targetId === targetId) {
      await cdp.send("Page.enable", {}, sid);
      pageSid = sid;
      resolvePage(sid);
    }
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
  }

  function onAttached(p, msg) {
    const parent = msg?.sessionId;
    const sid = p.sessionId;
    const info = p.targetInfo || {};
    if (parent ? !ours.has(parent) : info.browserContextId !== browserContextId || !browserContextId) {
      // Another context's target, seen by the browser-wide auto-attach: let it go.
      if (!parent) cdp.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
      return;
    }
    ours.add(sid);
    setUp(sid, info).catch(() => {});
  }

  const markNavigated = (why) => { navigated = true; stop(fail("preview_navigated", why)); };
  function onNavigated(p, msg) {
    if (!counting || !ours.has(msg?.sessionId) || !p.frame) return;
    if (!p.frame.parentId) {
      if (msg.sessionId !== pageSid) return;
      mainCommits++;
      committedUrl = p.frame.url;
    } else if (!isAllowed(p.frame.url, allowPrefix)) {
      // A sub-frame that committed anything but the token path: the CSP's frame-src
      // 'none' blocks every frame before any request, and the frame commits Chrome's
      // error page, which would otherwise be captured inside the preview.
      markNavigated(`a sub-frame committed ${p.frame.url}`);
    }
  }
  // A meta refresh (or any scheduled or requested navigation of the committed main
  // frame) is refused at once: it is scheduled right after the load event, so waiting
  // for its document request would race the capture.
  function onScheduled(p, msg) {
    if (counting && ours.has(msg?.sessionId)) markNavigated(`a ${p.reason || "scheduled"} navigation to ${p.url}`);
  }
  function onRequested(p, msg) {
    if (counting && ours.has(msg?.sessionId) && mainCommits >= 1 && p.frameId === targetId) markNavigated(`a ${p.reason || "requested"} navigation to ${p.url}`);
  }
  function onLoad(p, msg) {
    if (counting && pageSid && msg?.sessionId === pageSid && mainCommits >= 1) resolveLoaded();
  }

  on("Fetch.requestPaused", (p, msg) => { onPaused(p, msg).catch(() => {}); });
  on("Target.attachedToTarget", onAttached);
  on("Page.frameNavigated", onNavigated);
  on("Page.loadEventFired", onLoad);
  on("Page.frameScheduledNavigation", onScheduled);
  on("Page.frameRequestedNavigation", onRequested);

  let backstop = false;
  let autoAttach = false;
  try {
    // 1–2. A throwaway context; downloads denied.
    ({ browserContextId } = await race(cdp.send("Target.createBrowserContext", { disposeOnDetach: true, proxyServer: "direct://" })));
    await race(cdp.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId }));
    // 3. The browser-level backstop.
    backstop = true;
    await race(cdp.send("Fetch.enable", FETCH_ALL));
    // 4. Recursive auto-attach.
    autoAttach = true;
    await race(cdp.send("Target.setAutoAttach", AUTO));
    // 5. The page, in the new context; auto-attach delivers its session, paused.
    ({ targetId } = await race(cdp.send("Target.createTarget", { url: "about:blank", browserContextId })));
    resolveTarget();
    const sid = await race(pageSession);
    // 8. Size, then navigate; commits are counted from here.
    await race(cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sid));
    counting = true;
    const nav = await race(cdp.send("Page.navigate", { url }, sid));
    if (nav?.errorText) {
      // A failed main document already stopped the render with its reason; give it a
      // moment to land, else the navigation itself failed.
      await race(new Promise((r) => setTimeout(r, 50)));
      throw fail("preview_bad_status", `the navigation failed: ${nav.errorText}`);
    }
    // 9. The load event, then the navigation check.
    await race(loaded);
    check();
    // 10. The capture, and the check once more on everything seen up to it.
    const shot = await race(cdp.send("Page.captureScreenshot", { format: "png" }, sid));
    check();
    if (stopErr) throw stopErr;
    return Buffer.from(shot.data, "base64");
  } catch (err) {
    throw stopErr || err;
  } finally {
    // 11. Always: abort the fetch session, then dispose of the context.
    clearTimeout(timer);
    ac.abort();
    const bounded = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, CLEANUP_MS).unref?.())]);
    if (browserContextId) await bounded(cdp.send("Target.disposeBrowserContext", { browserContextId }));
    if (autoAttach) await bounded(cdp.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }));
    if (backstop) await bounded(cdp.send("Fetch.disable", {}));
    for (const [ev, fn] of listeners) cdp.off(ev, fn);
  }
}

/**
 * True when a capture is nearly one color (operator ruling): decoded into a 64×40
 * downscale, at least 98% of the pixels are within ±6 per channel of the most common
 * color. A page that needs scripts renders near-blank with scripts off, and is shown as
 * its type tile instead.
 *
 * Async: @napi-rs/canvas decodes off the main thread (an Image's pixels read as zero
 * until decode() resolves), and it has no synchronous decode.
 * @param {Buffer} png
 * @returns {Promise<boolean>}
 */
export async function isNearBlank(png) {
  const img = new Image();
  img.src = png;
  await img.decode();
  const W = 64, H = 40;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const counts = new Map();
  let best = 0, mode = 0;
  for (let i = 0; i < px.length; i += 4) {
    const key = ((px[i] << 24) | (px[i + 1] << 16) | (px[i + 2] << 8) | px[i + 3]) >>> 0;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > best) { best = n; mode = key; }
  }
  const m = [mode >>> 24, (mode >>> 16) & 255, (mode >>> 8) & 255, mode & 255];
  let near = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - m[0]) <= 6 && Math.abs(px[i + 1] - m[1]) <= 6 && Math.abs(px[i + 2] - m[2]) <= 6 && Math.abs(px[i + 3] - m[3]) <= 6) near++;
  }
  return near >= 0.98 * (W * H);
}
