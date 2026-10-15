/**
 * Open one page in a private headless Chrome (tests/fixtures/headless-chrome.mjs)
 * at a given viewport, wait until `readyExpr` is true, and hand back an
 * evaluator. Shared by the plan 3a panel layout tests; the CDP plumbing is
 * the same one tests/nest-grid.test.js uses inline.
 */
import assert from "node:assert/strict";

export async function withLivePage(chrome, url, { width, height, readyExpr = "document.readyState==='complete'" }, fn) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
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
  const evalIn = async (expr) => {
    const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 900 });
    await send("Page.enable");
    await send("Page.navigate", { url });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { ok = await evalIn(readyExpr); } catch { ok = false; }
    }
    assert.ok(ok, `the page never became ready (${readyExpr})`);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    return await fn(evalIn);
  } finally {
    ws.close();
    await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {});
  }
}
