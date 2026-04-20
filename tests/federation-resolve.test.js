/**
 * Name-resolver endpoint tests.
 *
 * The companion / AI agents use this to convert a user-typed instance
 * name into a concrete instance_id. Disambiguation rules that matter:
 *   - unique match → 200 with {id, gateway_url, host_tag}
 *   - multiple match → 400 with {matches} — caller MUST ask the user
 *   - no match → 404 with fuzzy {suggestions}
 *   - empty name → 400 missing_name
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "crow-resolve-test-"));
writeFileSync(join(tmp, "peer-tokens.json"), "{}", { mode: 0o600 });
process.env.CROW_PEER_TOKENS_PATH = join(tmp, "peer-tokens.json");

const { default: federationResolveRouterFactory } = await import("../servers/gateway/routes/federation-resolve.js");

function makeServerWithPeers(peers) {
  const app = express();
  app.use(express.json());
  app.use("/dashboard", federationResolveRouterFactory({
    createDbClient: () => ({
      execute: async () => ({ rows: peers }),
      close: () => {},
    }),
  }));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, baseUrl: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("resolve: exact name match → 200 with row", async () => {
  const { srv, baseUrl } = await makeServerWithPeers([
    { id: "aaa1", name: "Crow", hostname: "crow.ts.net", gateway_url: "https://crow.ts.net:8444" },
    { id: "bbb2", name: "Grackle", hostname: "grackle.ts.net", gateway_url: "https://grackle.ts.net" },
  ]);
  try {
    const r = await fetch(`${baseUrl}/dashboard/federation/resolve-instance?name=Crow`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, "aaa1");
    assert.equal(body.host_tag, "crow");
    assert.equal(body.gateway_url, "https://crow.ts.net:8444");
  } finally { await new Promise(r => srv.close(r)); }
});

test("resolve: case-insensitive name match", async () => {
  const { srv, baseUrl } = await makeServerWithPeers([
    { id: "aaa1", name: "Crow", hostname: "crow.ts.net", gateway_url: "https://x" },
  ]);
  try {
    const r = await fetch(`${baseUrl}/dashboard/federation/resolve-instance?name=CROW`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).id, "aaa1");
  } finally { await new Promise(r => srv.close(r)); }
});

test("resolve: ambiguous duplicate names → 400 with matches list", async () => {
  const { srv, baseUrl } = await makeServerWithPeers([
    { id: "aaa1", name: "Crow", hostname: "grackle-a.ts.net", gateway_url: "https://a" },
    { id: "bbb2", name: "Crow", hostname: "node-b.ts.net", gateway_url: "https://b" },
  ]);
  try {
    const r = await fetch(`${baseUrl}/dashboard/federation/resolve-instance?name=Crow`);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, "ambiguous");
    assert.equal(body.matches.length, 2);
    assert.ok(body.matches.every(m => m.name === "Crow"));
  } finally { await new Promise(r => srv.close(r)); }
});

test("resolve: short hostname fallback match", async () => {
  const { srv, baseUrl } = await makeServerWithPeers([
    { id: "aaa1", name: "Corp Primary", hostname: "grackle.dachshund.ts.net", gateway_url: "https://g" },
  ]);
  try {
    const r = await fetch(`${baseUrl}/dashboard/federation/resolve-instance?name=grackle`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).id, "aaa1");
  } finally { await new Promise(r => srv.close(r)); }
});

test("resolve: no match returns 404 with fuzzy suggestions", async () => {
  const { srv, baseUrl } = await makeServerWithPeers([
    { id: "aaa1", name: "Crow", hostname: "crow.ts.net", gateway_url: "https://c" },
    { id: "bbb2", name: "Grackle", hostname: "grackle.ts.net", gateway_url: "https://g" },
  ]);
  try {
    const r = await fetch(`${baseUrl}/dashboard/federation/resolve-instance?name=Craw`);
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.error, "not_found");
    assert.ok(Array.isArray(body.suggestions));
    // Levenshtein-1 match to "Crow"
    assert.ok(body.suggestions.some(s => s.id === "aaa1"), "fuzzy suggestion missing for Craw → Crow");
  } finally { await new Promise(r => srv.close(r)); }
});

test("resolve: empty query → 400 missing_name", async () => {
  const { srv, baseUrl } = await makeServerWithPeers([{ id: "aaa1", name: "Crow" }]);
  try {
    const r = await fetch(`${baseUrl}/dashboard/federation/resolve-instance`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "missing_name");
  } finally { await new Promise(r => srv.close(r)); }
});

test("resolve: id prefix (≥8 hex chars) match", async () => {
  const { srv, baseUrl } = await makeServerWithPeers([
    { id: "0867ac2809dedd885ba7769b21966f8e", name: "Crow", hostname: "crow.ts.net", gateway_url: "https://c" },
  ]);
  try {
    const r = await fetch(`${baseUrl}/dashboard/federation/resolve-instance?name=0867ac28`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).id, "0867ac2809dedd885ba7769b21966f8e");
  } finally { await new Promise(r => srv.close(r)); }
});
