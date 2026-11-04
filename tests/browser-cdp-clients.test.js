/**
 * Browser CDP gate, PR 1 (the clients): the token is sent as a bearer header by the browser
 * MCP server and the readiness poll, and it never travels in a URL or on a command line.
 *
 * Dark on purpose: today's Chromium ignores the header, so sending it changes nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "c0ffee".repeat(10) + "abcd"; // 64 hex chars, the shape hex32 mints

// playwright lives in the bundle's own node_modules, which CI and a fresh worktree don't
// install: stub it, and record exactly what connectOverCDP is given.
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "playwright") return { url: "crow-test-stub:playwright", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== "crow-test-stub:playwright") return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `export const chromium = {
        connectOverCDP: async (url, options) => {
          (globalThis.__cdpConnects ||= []).push({ url, options });
          throw new Error("no browser in tests");
        },
      };`,
    };
  },
});

const { createBrowserServer, waitForCdp } = await import("../bundles/browser/server/server.js");

/** A scratch CROW_HOME whose browser bundle .env holds `lines`; runs `fn` with it active. */
async function withHome(lines, fn) {
  const home = mkdtempSync(join(tmpdir(), "crow-cdp-clients-"));
  mkdirSync(join(home, "bundles", "browser"), { recursive: true });
  writeFileSync(join(home, "bundles", "browser", ".env"), lines.join("\n") + "\n");
  const prev = { CROW_HOME: process.env.CROW_HOME, CROW_BROWSER_CDP_PORT: process.env.CROW_BROWSER_CDP_PORT, CROW_BROWSER_CDP_TOKEN: process.env.CROW_BROWSER_CDP_TOKEN };
  process.env.CROW_HOME = home;
  delete process.env.CROW_BROWSER_CDP_PORT;
  delete process.env.CROW_BROWSER_CDP_TOKEN;
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("waitForCdp: the readiness poll carries the bearer when the instance has a token", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push({ url: String(url), headers: opts?.headers || {} }); return { ok: true, status: 200 }; };
  try {
    assert.equal(await waitForCdp("http://127.0.0.1:9222", { headers: { Authorization: `Bearer ${TOKEN}` }, delayMs: 0 }), true);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:9222/json/version");
  assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!seen[0].url.includes(TOKEN), "the token is not in the URL");
});

test("waitForCdp: no token → no Authorization header, exactly today's request", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push({ url: String(url), headers: opts?.headers || {} }); return { ok: true, status: 200 }; };
  try {
    await waitForCdp("http://127.0.0.1:9222", { attempts: 1, delayMs: 0 });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.Authorization, undefined);
});

/** Run one MCP tool call against a real in-memory server (the same seam the other bundle tests use). */
async function callTool(home, name, args = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createBrowserServer({ sessionDir: join(home, "sessions") });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join(""), isError: !!r.isError };
  } finally { await client.close(); }
}

test("crow_browser_launch: connectOverCDP gets the bearer header when a token is configured", async () => {
  await withHome([`CROW_BROWSER_CDP_PORT=9222`, `CROW_BROWSER_CDP_TOKEN=${TOKEN}`], async (home) => {
    globalThis.__cdpConnects = [];
    const r = await callTool(home, "crow_browser_launch", {});
    assert.equal(r.isError, true, "the stub throws: no browser in tests");
    assert.equal(globalThis.__cdpConnects.length, 1);
    const { url, options } = globalThis.__cdpConnects[0];
    assert.equal(url, "http://127.0.0.1:9222");
    assert.deepEqual(options, { headers: { Authorization: `Bearer ${TOKEN}` } });
  });
});

test("crow_browser_launch: no token → connectOverCDP gets no options at all", async () => {
  await withHome([`CROW_BROWSER_CDP_PORT=9222`], async (home) => {
    globalThis.__cdpConnects = [];
    const r = await callTool(home, "crow_browser_launch", {});
    assert.equal(r.isError, true);
    assert.equal(globalThis.__cdpConnects.length, 1);
    assert.equal(globalThis.__cdpConnects[0].options, undefined);
  });
});

test("crow_browser_launch: the token is re-read every connect (minted after this process started)", async () => {
  await withHome([`CROW_BROWSER_CDP_PORT=9222`], async (home) => {
    globalThis.__cdpConnects = [];
    await callTool(home, "crow_browser_launch", {});
    assert.equal(globalThis.__cdpConnects[0].options, undefined, "no token at boot");
    writeFileSync(join(home, "bundles", "browser", ".env"), `CROW_BROWSER_CDP_PORT=9222\nCROW_BROWSER_CDP_TOKEN=${TOKEN}\n`);
    await callTool(home, "crow_browser_launch", {});
    assert.deepEqual(globalThis.__cdpConnects[1].options, { headers: { Authorization: `Bearer ${TOKEN}` } }, "the minted token is used without a restart");
  });
});

test("crow_browser_launch: CROW_BROWSER_CDP_URL override still wins and still gets the header", async () => {
  await withHome([`CROW_BROWSER_CDP_PORT=9222`, `CROW_BROWSER_CDP_TOKEN=${TOKEN}`], async (home) => {
    globalThis.__cdpConnects = [];
    const prev = process.env.CROW_BROWSER_CDP_URL;
    process.env.CROW_BROWSER_CDP_URL = "http://127.0.0.1:9444";
    try { await callTool(home, "crow_browser_launch", {}); } finally {
      if (prev === undefined) delete process.env.CROW_BROWSER_CDP_URL; else process.env.CROW_BROWSER_CDP_URL = prev;
    }
    assert.equal(globalThis.__cdpConnects[0].url, "http://127.0.0.1:9444");
    assert.deepEqual(globalThis.__cdpConnects[0].options, { headers: { Authorization: `Bearer ${TOKEN}` } });
  });
});

// ---------------------------------------------------------------------------
// static: the token travels in a header, never in argv or a URL
// ---------------------------------------------------------------------------

test("manifest: the token is generated and minted, required by the bundle, never handed to the MCP server", () => {
  const mf = JSON.parse(readFileSync(join(ROOT, "bundles/browser/manifest.json"), "utf8"));
  const v = mf.env_vars.find((e) => e.name === "CROW_BROWSER_CDP_TOKEN");
  assert.ok(v, "the manifest declares CROW_BROWSER_CDP_TOKEN");
  assert.deepEqual(
    { required: v.required, secret: v.secret, generate: v.generate, propagate: v.propagate, mint_if_missing: v.mint_if_missing },
    { required: false, secret: true, generate: "hex32", propagate: false, mint_if_missing: true },
  );
  assert.match(JSON.stringify(mf.requires.env), /CDP_TOKEN/, "the bundle requires it: 1.5.0's container refuses to start without it");
  assert.ok(!mf.server.envKeys.includes("CROW_BROWSER_CDP_TOKEN"), "the server reads the bundle .env, so its own env never holds the token");
  assert.match(v.description, /settings file/, "says where it lives");
  assert.match(v.description, /bearer token/, "says how the container uses it");
  assert.doesNotMatch(v.description, /next browser update/, "the gate has shipped: no 'not yet' wording left");
});

const CODE_EXT = /\.(js|mjs|cjs|sh|py)$/;
const SKIP = new Set(["node_modules", ".git", "data", "__pycache__", ".venv"]);

function walkCode(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkCode(p, out);
    else if (CODE_EXT.test(e)) out.push(p);
  }
  return out;
}

test("no token-bearing argv or URL anywhere in the browser bundle", () => {
  const files = walkCode(join(ROOT, "bundles", "browser"));
  // The plan's bot driver: absent from this tree, but checked the moment it lands.
  const botDriver = join(ROOT, "scripts", "bots", "govqa_drive.py");
  if (existsSync(botDriver)) files.push(botDriver);
  assert.ok(files.length > 10, `expected the bundle's sources, found ${files.length}`);

  for (const file of files) {
    const rel = relative(ROOT, file);
    for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
      const where = `${rel}:${i + 1}`;
      if (line.includes("Bearer")) {
        assert.doesNotMatch(line, /\bcurl\b|\bexecFile(Sync)?\s*\(|\bspawn(Sync)?\s*\(|\bfork\s*\(/, `${where}: a bearer next to a process/argv sink`);
      }
      assert.doesNotMatch(line, /[?&](cdp_)?token=/i, `${where}: the token is in a URL`);
      assert.doesNotMatch(line, /searchParams\.(set|append)\([^)]*[Tt]oken/, `${where}: the token is in a URL query`);
      assert.doesNotMatch(line, /execFile(Sync)?\([^)]*Bearer/, `${where}: the token is in an argv`);
    }
  }
});

test("the panel probes are Node fetches, not curl: nothing to leak through /proc", () => {
  for (const f of ["panel/browser.js", "panel/routes.js"]) {
    const src = readFileSync(join(ROOT, "bundles", "browser", f), "utf8");
    assert.doesNotMatch(src, /execFileSync\(\s*"curl"/, f);
    assert.doesNotMatch(src, /["']curl["']/, f);
  }
  // …and the header really is the carrier the probes and clients use.
  for (const [f, re] of [
    ["server/cdp-probe.js", /Authorization: `Bearer \$\{token\}`/],
    ["server/watcher.js", /Authorization: `Bearer \$\{token\}`/],
  ]) {
    const p = f.startsWith("server/watcher") ? join(ROOT, "servers/gateway/browser-tile/watcher.js") : join(ROOT, "bundles/browser", f);
    assert.match(readFileSync(p, "utf8"), re, f);
  }
});