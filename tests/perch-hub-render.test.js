// The drawer's defining mobile failure was Send sitting below the viewport at
// every scroll position except the very bottom. Assert reachability with the
// transcript scrolled to the TOP, which is where a reader starts. A screenshot
// did not catch this; getBoundingClientRect did.
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
  const { perchHubDocument } = await import("../servers/gateway/dashboard/perch-hub/html.js");
  const doc = perchHubDocument("en");
  server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(doc); });
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
    await send("Page.navigate", { url: `http://${HOST_FROM_CONTAINER}:${port}/` });
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

const SEED_AND_MEASURE = `
(function(){
  document.body.setAttribute('data-view','chat');
  var tr=document.getElementById('perch-transcript');
  for(var i=0;i<16;i++){ var d=document.createElement('div');
    d.textContent='bot: a transcript line long enough to take a row or two, number '+i;
    tr.appendChild(d); }
  tr.scrollTop=0;                                  // where a reader starts
  var b=document.getElementById('perch-send').getBoundingClientRect();
  return JSON.stringify({viewport:innerHeight,top:Math.round(b.top),
    bottom:Math.round(b.bottom),reachable:b.bottom<=innerHeight&&b.top>=0});
})()`;

test("Send is reachable at 412x730 with the transcript scrolled to the top", async (t) => {
  if (!available) return t.skip("no CDP endpoint at " + CDP);
  const measured = JSON.parse(await evaluate(412, 730, SEED_AND_MEASURE));
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
