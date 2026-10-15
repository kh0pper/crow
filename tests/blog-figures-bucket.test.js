/**
 * Blog figures: the object-storage bucket, the internal gateway URL used for
 * the geojson proxy, and the hydrate-asset directory are instance settings,
 * never one owner's bucket name or home-directory layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import express from "express";
import { figuresBucket, figureGatewayUrl } from "../servers/blog/figures-bucket.js";
import { gatewayListenPort } from "../servers/gateway/listen-port.js";

const ROOT = new URL("..", import.meta.url).pathname;
const EMBED = readFileSync(join(ROOT, "servers/gateway/routes/blog-embed-api.js"), "utf8");
const DASH = readFileSync(join(ROOT, "bundles/data-dashboard/server/server.js"), "utf8");

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("B1: with no env the bucket is blog-figures", () => {
  withEnv({ CROW_BLOG_FIGURES_BUCKET: undefined }, () => {
    assert.equal(figuresBucket(), "blog-figures");
  });
});

test("B2: the env value wins and is read lazily", () => {
  withEnv({ CROW_BLOG_FIGURES_BUCKET: "example-bucket" }, () => {
    assert.equal(figuresBucket(), "example-bucket");
  });
  withEnv({ CROW_BLOG_FIGURES_BUCKET: "another-bucket" }, () => {
    assert.equal(figuresBucket(), "another-bucket");
  });
});

test("B3: neither consumer hard-codes a bucket name; both use figuresBucket()", () => {
  for (const [name, src] of [["blog-embed-api.js", EMBED], ["data-dashboard server.js", DASH]]) {
    assert.ok(!/FIGURES_BUCKET\s*=\s*["']/.test(src), `${name} defines a bucket literal`);
    assert.ok(!/bucket:\s*["']/.test(src), `${name} passes a bucket literal`);
    assert.ok(src.includes("figuresBucket"), `${name} must use figuresBucket()`);
  }
});

test("B4: the embed API carries no home-directory layout and no fixed :3002", () => {
  assert.ok(!EMBED.includes("research-bundles"));
  assert.ok(!EMBED.includes("homedir("));
  assert.ok(!EMBED.includes(":3002"));
  assert.ok(!DASH.includes(":3002"));
});

test("B5: the figure gateway URL defaults to this gateway's listen port; BLOG_FIGURE_GATEWAY_URL overrides", () => {
  withEnv({ BLOG_FIGURE_GATEWAY_URL: undefined }, () => {
    assert.equal(figureGatewayUrl(), `http://127.0.0.1:${gatewayListenPort()}`);
  });
  withEnv({ BLOG_FIGURE_GATEWAY_URL: "http://127.0.0.1:9" }, () => {
    assert.equal(figureGatewayUrl(), "http://127.0.0.1:9");
  });
});

test("B6: hydrate assets are served from CROW_BLOG_HYDRATE_ASSETS_DIR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydrate-assets-"));
  mkdirSync(join(dir, "shared"));
  writeFileSync(join(dir, "shared", "blog-hydrate.js"), "// hydrate\n");
  const { blogEmbedApiRouter } = await import("../servers/gateway/routes/blog-embed-api.js");
  const router = withEnv({ CROW_BLOG_HYDRATE_ASSETS_DIR: dir }, () => blogEmbedApiRouter());
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/blog/assets/shared/blog-hydrate.js`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "// hydrate\n");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
