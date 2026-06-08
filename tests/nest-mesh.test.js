/**
 * F5 — full-mesh visibility tests.
 *
 * Covers the three layers of the gossip path:
 *   1. overview-cache sanitizes the `peers` roster a peer advertises
 *   2. mergeDiscoveredPeers folds roster entries into the carousel set
 *   3. buildNestHTML renders a discovered instance as a link-only section
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// peer-credentials is pulled in transitively; point it at an empty file.
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const tmp = mkdtempSync(join(tmpdir(), "crow-nest-mesh-test-"));
writeFileSync(join(tmp, "peer-tokens.json"), "{}", { mode: 0o600 });
process.env.CROW_PEER_TOKENS_PATH = join(tmp, "peer-tokens.json");

const { getPeerOverview, _resetCache, _setFetchImpl } = await import(
  "../servers/gateway/dashboard/overview-cache.js"
);
const { mergeDiscoveredPeers } = await import(
  "../servers/gateway/dashboard/panels/nest/data-queries.js"
);
const { buildNestHTML } = await import(
  "../servers/gateway/dashboard/panels/nest/html.js"
);

const fakeDb = { execute: async () => ({ rows: [] }), close: () => {} };

beforeEach(() => { _resetCache(); _setFetchImpl(null); });

test("overview-cache sanitizes the gossip peers roster", async () => {
  _setFetchImpl(async () => ({
    ok: true,
    body: {
      instance: { id: "49cf71ca", name: "Grackle", is_home: true },
      tiles: [],
      peers: [
        { id: "77ac9c01", name: "black-swan", gateway_url: "https://bs.ts.net:8444", status: "active", is_home: false },
        { id: "BADID!!", name: "x", gateway_url: "https://x.ts.net" },        // bad id
        { id: "abcdef12", name: "noUrl" },                                     // no url
        { id: "abcdef34", name: "evil", gateway_url: "javascript:alert(1)" },  // bad scheme
        { id: "abcdef56", name: "ok2", gateway_url: "https://ok2.ts.net" },
      ],
      health: { status: "ok", checkedAt: "2026-06-07T00:00:00Z" },
    },
  }));
  const ov = await getPeerOverview(fakeDb, "49cf71ca");
  assert.equal(ov.status, "ok");
  assert.equal(ov.peers.length, 2, "drops bad-id / no-url / bad-scheme entries");
  assert.ok(ov.peers.every((p) => p.gateway_url.startsWith("https://")));
  assert.ok(!ov.peers.some((p) => p.gateway_url.includes("javascript")));
});

test("overview-cache caps the roster at 50", async () => {
  const peers = Array.from({ length: 80 }, (_, i) => ({
    id: "ab" + String(i).padStart(6, "0"),
    name: "p" + i,
    gateway_url: "https://p" + i + ".ts.net",
  }));
  _setFetchImpl(async () => ({
    ok: true,
    body: { instance: { id: "aaa111" }, tiles: [], peers, health: { status: "ok" } },
  }));
  const ov = await getPeerOverview(fakeDb, "aaa111");
  assert.equal(ov.peers.length, 50);
});

test("mergeDiscoveredPeers excludes self, known, dups, and no-url entries", () => {
  const trusted = [{ id: "49cf71ca", name: "Grackle" }];
  const overviews = [{
    instanceId: "49cf71ca", status: "ok", peers: [
      { id: "77ac9c01", name: "black-swan", gateway_url: "https://bs", is_home: false, status: "active" },
      { id: "0867ac28", name: "me", gateway_url: "https://me" },     // == localId
      { id: "49cf71ca", name: "already", gateway_url: "https://g" }, // already trusted
      { id: "77ac9c01", name: "dup", gateway_url: "https://bs2" },   // duplicate
    ],
  }];
  const { discoveredInstances, discoveredOverviews } = mergeDiscoveredPeers(trusted, overviews, "0867ac28");
  assert.equal(discoveredInstances.length, 1);
  assert.equal(discoveredInstances[0].id, "77ac9c01");
  assert.equal(discoveredInstances[0].discovered, true);
  assert.equal(discoveredOverviews.length, 1);
  assert.equal(discoveredOverviews[0].status, "discovered");
});

test("mergeDiscoveredPeers ignores non-ok overviews", () => {
  const { discoveredInstances } = mergeDiscoveredPeers(
    [], [{ status: "unavailable", peers: [{ id: "z", gateway_url: "https://z" }] }], "me"
  );
  assert.equal(discoveredInstances.length, 0);
});

test("buildNestHTML renders a discovered instance as a link-only section", () => {
  const data = {
    pinnedItems: [], bundles: [], dockerInfo: { available: false }, dbStats: {},
    recentChats: [], recentSessions: [], instances: [],
    trustedInstances: [
      { id: "49cf71ca", name: "Grackle", paired: true, gateway_url: "https://g" },
      { id: "77ac9c01", name: "black-swan", discovered: true, paired: false, gateway_url: "https://bs.ts.net:8444" },
    ],
    peerOverviews: [
      { instanceId: "49cf71ca", status: "ok", tiles: [] },
      { instanceId: "77ac9c01", status: "discovered", tiles: [] },
    ],
    ssoEnabled: false,
  };
  const html = buildNestHTML(data, "en");
  assert.ok(html.includes("nest-instance-section--discovered"), "renders discovered section");
  assert.ok(html.includes("https://bs.ts.net:8444"), "open link points at gateway_url");
  assert.ok(html.includes("black-swan"), "shows the discovered instance name");
});

test("buildNestHTML escapes a malicious discovered gateway label", () => {
  // gateway_url is sanitized upstream, but the renderer must still escape it.
  const data = {
    pinnedItems: [], bundles: [], dockerInfo: { available: false }, dbStats: {},
    recentChats: [], recentSessions: [], instances: [],
    trustedInstances: [
      { id: "49cf71ca", name: "Grackle", paired: true, gateway_url: "https://g" },
      { id: "ab000001", name: '<img src=x onerror=alert(1)>', discovered: true, paired: false, gateway_url: "https://ok.ts.net" },
    ],
    peerOverviews: [
      { instanceId: "49cf71ca", status: "ok", tiles: [] },
      { instanceId: "ab000001", status: "discovered", tiles: [] },
    ],
    ssoEnabled: false,
  };
  const html = buildNestHTML(data, "en");
  assert.ok(!html.includes("<img src=x onerror=alert(1)>"), "name is HTML-escaped");
});
