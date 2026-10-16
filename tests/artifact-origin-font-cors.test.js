// Artifact origin (design kit review M4): font responses are readable from an
// opaque-origin frame of ANY type (CORS-mode font loads); nothing else changes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startArtifactOrigin } from "../servers/gateway/artifact-origin/server.js";
import { createViewTokenStore } from "../servers/gateway/artifact-origin/view-tokens.js";

const tokens = createViewTokenStore();
const FILES = {
  "index.html": { body: Buffer.from("<!doctype html><svg></svg>"), contentType: "text/html; charset=utf-8" },
  "__lib/font/demo/demo-latin-400-normal.woff2": { body: Buffer.from("wOF2"), contentType: "font/woff2" },
  "__lib/css/demo/demo.css": { body: Buffer.from("a{}"), contentType: "text/css" },
};
const server = await startArtifactOrigin({ port: 0, tokens, resolveContent: async ({ path }) => FILES[path] || null, fallbackBase: "http://localhost:1" });
const port = server.address().port;
after(() => server.close());

test("diagram and document frames: fonts get ACAO *, HTML and CSS do not", async () => {
  for (const type of ["diagram", "document"]) {
    const { token } = tokens.mint({ artifactId: "art-font", versionN: 1, type, dashboardOrigin: "http://dash.test" });
    const font = await fetch(`http://127.0.0.1:${port}/v/${token}/__lib/font/demo/demo-latin-400-normal.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("access-control-allow-origin"), "*", `${type}: font readable cross-origin`);
    assert.equal(font.headers.get("access-control-allow-credentials"), null);
    if (type === "diagram") {
      const html = await fetch(`http://127.0.0.1:${port}/v/${token}/`);
      assert.equal(html.headers.get("access-control-allow-origin"), null, "non-speaking frame: HTML unchanged");
      const css = await fetch(`http://127.0.0.1:${port}/v/${token}/__lib/css/demo/demo.css`);
      assert.equal(css.headers.get("access-control-allow-origin"), null, "CSS unchanged");
    }
  }
});
