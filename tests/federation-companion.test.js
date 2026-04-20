import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// Stage peer-tokens + a test ~/.crow/installed.json pointing at a fake
// companion entry. The federation-companion handler reads
// ~/.crow/installed.json directly — no env var — so we isolate the test
// by pre-seeding the real path under a tmp HOME before importing the
// module. The prior-state is restored in the after() hook.

const origHome = process.env.HOME;
const origPeerTokens = process.env.CROW_PEER_TOKENS_PATH;

const tmpHome = mkdtempSync(join(tmpdir(), "crow-fc-test-"));
mkdirSync(join(tmpHome, ".crow"), { recursive: true });

const peerTokensPath = join(tmpHome, ".crow", "peer-tokens.json");
writeFileSync(peerTokensPath, "{}", { mode: 0o600 });
process.env.CROW_PEER_TOKENS_PATH = peerTokensPath;
process.env.HOME = tmpHome;

function setInstalled(contents) {
  writeFileSync(join(tmpHome, ".crow", "installed.json"), JSON.stringify(contents));
}

// Start with companion installed
setInstalled({
  companion: { id: "companion", type: "bundle", installedAt: "2026-04-01" },
});

const { default: federationCompanionRouterFactory } = await import("../servers/gateway/routes/federation-companion.js");
const overviewCache = await import("../servers/gateway/dashboard/overview-cache.js");
const nestData = await import("../servers/gateway/dashboard/panels/nest/data-queries.js");

// ----- Test harness -----

let server;
let baseUrl;

function makeDb(rows = []) {
  return {
    execute: async () => ({ rows }),
    close: () => {},
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/dashboard", federationCompanionRouterFactory({ createDbClient: () => makeDb([]) }));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  if (origPeerTokens !== undefined) process.env.CROW_PEER_TOKENS_PATH = origPeerTokens;
  else delete process.env.CROW_PEER_TOKENS_PATH;
});

beforeEach(() => {
  overviewCache._resetCache();
  overviewCache._setFetchImpl(null);
});

// ----- Tests -----

test("companion-overview: 503 when companion bundle not installed", async () => {
  setInstalled({}); // nothing installed
  const r = await fetch(`${baseUrl}/dashboard/federation/companion-overview`);
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.error, "companion_not_installed");
  // Restore for subsequent tests.
  setInstalled({
    companion: { id: "companion", type: "bundle", installedAt: "2026-04-01" },
  });
});

test("companion-overview: no trusted peers → empty peers map + local static apps", async () => {
  // Default createDbClient returns empty rows → getTrustedInstances returns [].
  const r = await fetch(`${baseUrl}/dashboard/federation/companion-overview`);
  assert.equal(r.status, 200);
  const body = await r.json();

  assert.ok(body.local, "local missing");
  assert.ok(Array.isArray(body.local.static), "local.static not array");
  const ids = body.local.static.map(a => a.id);
  assert.ok(ids.includes("youtube"), "youtube missing");
  assert.ok(ids.includes("browser"), "browser missing");
  assert.ok(ids.includes("videocall"), "videocall missing");

  assert.ok(Array.isArray(body.local.bundles), "local.bundles not array");
  assert.deepEqual(body.peers, {});
});

test("companion-overview: merges peer tiles from overview-cache", async () => {
  // Stub getTrustedInstances by swapping the db execute path. Easier: use a
  // replacement factory that returns pre-seeded trusted instances.
  const app2 = express();
  app2.use(express.json());
  app2.use("/dashboard", federationCompanionRouterFactory({
    createDbClient: () => makeDb([
      { id: "peer-a", name: "crow", hostname: "crow.ts.net", trusted: 1, status: "active" },
    ]),
  }));
  const s2 = await new Promise((resolve) => {
    const srv = app2.listen(0, () => resolve(srv));
  });
  const b2 = `http://127.0.0.1:${s2.address().port}`;

  overviewCache._resetCache();
  overviewCache._setFetchImpl(async () => ({
    ok: true,
    status: 200,
    body: {
      instance: { id: "peer-a", name: "crow", hostname: "crow.ts.net", is_home: false },
      tiles: [
        { id: "jellyfin", name: "Jellyfin", icon: "media", pathname: "/proxy/jellyfin/", port: null, category: "bundle" },
      ],
      health: { status: "ok", checkedAt: "now" },
    },
    raw: "stub",
  }));

  try {
    const r = await fetch(`${b2}/dashboard/federation/companion-overview`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.peers["peer-a"], "peer-a missing");
    assert.equal(body.peers["peer-a"].status, "ok");
    assert.equal(body.peers["peer-a"].hostname, "crow.ts.net");
    assert.equal(body.peers["peer-a"].tiles.length, 1);
    assert.equal(body.peers["peer-a"].tiles[0].id, "jellyfin");
  } finally {
    await new Promise((r) => s2.close(r));
  }
});

test("companion-overview: peer returning sentinel surfaces as status=unavailable", async () => {
  const app2 = express();
  app2.use(express.json());
  app2.use("/dashboard", federationCompanionRouterFactory({
    createDbClient: () => makeDb([
      { id: "peer-b", name: "black-swan", hostname: "bs.ts.net", trusted: 1, status: "offline" },
    ]),
  }));
  const s2 = await new Promise((resolve) => {
    const srv = app2.listen(0, () => resolve(srv));
  });
  const b2 = `http://127.0.0.1:${s2.address().port}`;

  overviewCache._resetCache();
  overviewCache._setFetchImpl(async () => ({ ok: false, status: 0, error: "timeout" }));

  try {
    const r = await fetch(`${b2}/dashboard/federation/companion-overview`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.peers["peer-b"].status, "unavailable");
    assert.equal(body.peers["peer-b"].reason, "timeout");
    assert.deepEqual(body.peers["peer-b"].tiles, []);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
