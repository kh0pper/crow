// Every noVNC page Crow builds names its own websockify path. The bundled noVNC
// (1.0.0) defaults the WebSocket `path` to "websockify" at the page's ORIGIN
// root, and the gateway upgrades only /proxy/<id>/…, so an unnamed page never
// connects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { novncSocketPath, novncUrl } from "../servers/shared/novnc-url.js";

test("the websockify path is the page's own directory", () => {
  assert.equal(novncSocketPath("/proxy/browser/vnc.html"), "proxy/browser/websockify");
  assert.equal(novncSocketPath("/proxy/browser/vnc_lite.html"), "proxy/browser/websockify");
  assert.equal(novncSocketPath("/proxy/nested/app/novnc/vnc.html"), "proxy/nested/app/novnc/websockify");
  assert.equal(novncSocketPath("proxy/browser/vnc.html"), "proxy/browser/websockify", "no leading slash");
  assert.equal(novncSocketPath("/proxy/browser/vnc.html?autoconnect=true"), "proxy/browser/websockify", "a query is not part of the page");
});

test("a full-page link keeps its params and pins the path", () => {
  assert.equal(
    novncUrl("/proxy/browser/vnc.html", { autoconnect: "true", resize: "scale", view_only: "false" }),
    "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false&path=proxy/browser/websockify",
    "slashes stay literal in the path value");
});

test("a nested base and vnc_lite.html: the path follows the page", () => {
  assert.equal(novncUrl("/proxy/nested/app/novnc/vnc_lite.html", { autoconnect: "true" }),
    "/proxy/nested/app/novnc/vnc_lite.html?autoconnect=true&path=proxy/nested/app/novnc/websockify");
  const q = new URL(novncUrl("/proxy/browser/vnc_lite.html", { view_only: "true" }), "http://dash.example.test").searchParams;
  assert.equal(q.get("path"), "proxy/browser/websockify");
  assert.equal(q.get("view_only"), "true");
});

test("an existing path is kept, never doubled", () => {
  assert.equal(novncUrl("/proxy/browser/vnc.html?path=proxy/browser/websockify"),
    "/proxy/browser/vnc.html?path=proxy/browser/websockify", "the page's own path, untouched");
  const once = novncUrl("/proxy/browser/vnc.html?path=p&autoconnect=true");
  assert.equal((once.match(/path=/g) || []).length, 1, once);
  assert.equal(once, "/proxy/browser/vnc.html?path=p&autoconnect=true", "and no second one is added");
  assert.equal(novncUrl("/proxy/browser/vnc.html", { path: "x/websockify" }),
    "/proxy/browser/vnc.html?path=x/websockify", "a given path wins over the derived one");
});

test("values are URL-encoded; a null or undefined value is skipped", () => {
  assert.equal(novncUrl("/proxy/browser/vnc.html", { resize: "scale&q=6", lang: null, mode: undefined }),
    "/proxy/browser/vnc.html?resize=scale%26q%3D6&path=proxy/browser/websockify");
  assert.equal(novncUrl("/proxy/browser/vnc.html?view_only=true", { view_only: "false" }),
    "/proxy/browser/vnc.html?view_only=false&path=proxy/browser/websockify", "a param the page carries is replaced, not repeated");
});

// The two bundle copies (a bundle is installed under <CROW_HOME>/bundles/<id>/,
// so neither can import servers/shared) build the same URL as this helper.
test("the bundle's copies name the same websockify path", async () => {
  // playwright lives in the bundle's own node_modules (absent in a worktree): stub it.
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context); } catch (err) {
        if (specifier !== "playwright" || err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
        return { url: "crow-test-stub:playwright", shortCircuit: true };
      }
    },
    load(url, context, next) {
      if (url !== "crow-test-stub:playwright") return next(url, context);
      return { format: "module", source: "export const chromium = { connectOverCDP: async () => { throw new Error('no browser in tests'); } };", shortCircuit: true };
    },
  });
  const server = await import("../bundles/browser/server/server.js");
  assert.equal(server.novncUrl("/proxy/browser/vnc.html"),
    "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false&path=proxy/browser/websockify",
    "the MCP server's vnc_url");
  const panel = await import("../bundles/browser/panel/browser.js");
  assert.equal(panel.VNC_VIEW_ONLY,
    "/proxy/browser/vnc.html?view_only=true&autoconnect=true&resize=scale&path=proxy/browser/websockify");
  assert.equal(panel.VNC_INTERACTIVE,
    "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false&path=proxy/browser/websockify");
});