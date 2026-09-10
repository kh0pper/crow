// The drawer's defining mobile failure was Send sitting below the viewport at
// every scroll position except the very bottom. Assert reachability with the
// transcript scrolled to the TOP, which is where a reader starts. A screenshot
// did not catch this; getBoundingClientRect did.
//
// This renders through the REAL dashboard shell now (the panel handler +
// renderLayout), not perchHubDocument() in isolation — Perch no longer owns
// its own document, so testing it standalone would miss the exact CSS chain
// (layout.js's "body:has(#perch-chat)" rules -> perch-hub/css.js's
// #perch-hub-root/.hub-split/#perch-chat flex chain) that reachability now
// depends on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// The repo's convention is CROW_BROWSER_CDP_PORT (tests/pibot-crow-server-catalog.test.js:38).
const CDP = process.env.CROW_CDP_URL ||
  ("http://127.0.0.1:" + (process.env.CROW_BROWSER_CDP_PORT || "9223"));
// The CDP browser runs in Docker: it cannot reach 127.0.0.1 on the host, and
// file:// is unreachable entirely. Bind 0.0.0.0 and navigate to the bridge.
const HOST_FROM_CONTAINER = process.env.CROW_CDP_HOST_IP || "172.17.0.1";

let available = false, server = null, port = 0;

before(async () => {
  try {
    const r = await fetch(CDP + "/json/version", { signal: AbortSignal.timeout(2000) });
    available = r.ok;
  } catch { available = false; }
  if (!available) return;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  server = http.createServer(async (req, res) => {
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  port = server.address().port;
});

after(() => { if (server) server.close(); });

/** Open a tab, run one expression, return its value, close the tab. */
async function evaluate(width, height, expression) {
  const tab = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== mine) return;
      ws.off("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {});
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  try {
    await send("Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 2, mobile: width < 900 });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://${HOST_FROM_CONTAINER}:${port}/dashboard/perch` });
    await new Promise((r) => setTimeout(r, 1500));
    const out = await send("Runtime.evaluate", { expression, returnByValue: true });
    // Without this, an expression that threw returns undefined and the caller's
    // JSON.parse fails with "undefined is not valid JSON" — a confusing error
    // instead of the real one.
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    if (out.result.value === undefined) throw new Error("expression produced no value");
    return out.result.value;
  } finally {
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

// 60 lines, not 16: enough that the transcript's OWN content height clearly
// exceeds both tested viewports (730px and 900px) on its own — verified by
// mutation (removing #perch-chat's flex:1/min-height:0, or #perch-transcript's
// min-height:0, left this GREEN at 16 lines; only a transcript tall enough to
// actually overflow makes those rules provable here instead of only in the
// static check in perch-hub-page.test.js).
const SEED_AND_MEASURE = `
(function(){
  document.body.setAttribute('data-view','chat');
  var tr=document.getElementById('perch-transcript');
  for(var i=0;i<60;i++){ var d=document.createElement('div');
    d.textContent='bot: a transcript line long enough to take a row or two, number '+i;
    tr.appendChild(d); }
  tr.scrollTop=0;                                  // where a reader starts
  var b=document.getElementById('perch-send').getBoundingClientRect();
  return JSON.stringify({viewport:innerHeight,top:Math.round(b.top),
    bottom:Math.round(b.bottom),reachable:b.bottom<=innerHeight&&b.top>=0});
})()`;

test("the crow sidebar is present on /dashboard/perch", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const present = JSON.parse(await evaluate(1280, 900, `
    JSON.stringify({ sidebar: !!document.querySelector('.sidebar'),
      perch: !!document.getElementById('perch-hub-root') })`));
  assert.equal(present.sidebar, true, "the regression this feature fixes: the nav must not vanish on this page");
  assert.equal(present.perch, true);
});

test("Send is reachable at 412x730 with the transcript scrolled to the top", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const measured = JSON.parse(await evaluate(412, 730, SEED_AND_MEASURE));
  assert.equal(measured.reachable, true,
    `Send at ${measured.top}-${measured.bottom} in a ${measured.viewport}px viewport`);
});

test("Send is reachable at 1280x900 with the transcript scrolled to the top", async (t) => {
  // The shell's app-shell height-clamp (layout.js's "body:has(#perch-chat)"
  // rules) is NOT width-scoped — unlike the pre-existing ≤768px-only mobile
  // behaviour it mirrors, it applies at every width, so this must hold on
  // desktop too, not just on a phone.
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const measured = JSON.parse(await evaluate(1280, 900, SEED_AND_MEASURE));
  assert.equal(measured.reachable, true,
    `Send at ${measured.top}-${measured.bottom} in a ${measured.viewport}px viewport`);
});

test("both views are visible side by side at desktop width", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const visible = JSON.parse(await evaluate(1280, 900, `
    (function(){
      document.body.setAttribute('data-view','chat');
      var vis=function(id){ var e=document.getElementById(id);
        return getComputedStyle(e).display !== 'none'; };
      return JSON.stringify({list:vis('perch-list'),chat:vis('perch-chat')});
    })()`));
  assert.equal(visible.list, true, "the min-width:900px split keeps the list up");
  assert.equal(visible.chat, true);
});
