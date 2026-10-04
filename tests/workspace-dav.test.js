import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";

let fake, dav, cfg;
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  cfg = Object.freeze({ user: "crow-bot", appPassword: "pw", jwtSecret: "jwt", ncUrl: fake.ncUrl, ooUrl: fake.ooUrl, host: "h", webBase: "https://h:8456", secrets: ["pw", "jwt"] });
  dav = await import("../bundles/workspace/server/nc/dav.js");
  fake.addFolder("Shared with Crow/Casa", { owner: "admin" });
  fake.addFile("Shared with Crow/Casa/a.txt", Buffer.from("hola"), { owner: "admin" });
});
after(() => fake.close());

test("stat returns a typed entry", async () => {
  const e = await dav.stat(cfg, { path: "Shared with Crow/Casa/a.txt" });
  assert.equal(e.isFolder, false);
  assert.equal(e.size, 4);
  assert.equal(e.ownerId, "admin");
  assert.match(e.permissions, /W/);
  assert.equal(e.lock, false);
  assert.ok(Number.isInteger(e.fileId) && Number.isInteger(e.mtime));
});

test("an empty 207 (Nextcloud's answer for paths you can't see) is not_found, never success", async () => {
  fake.state.emptyMultistatusFor.add("Shared with Crow/Casa/hidden.txt");
  await assert.rejects(dav.stat(cfg, { path: "Shared with Crow/Casa/hidden.txt" }), (e) => e.code === "not_found");
});

test("getFile caps size before buffering", async () => {
  fake.addFile("Shared with Crow/Casa/big.bin", Buffer.alloc(2048));
  await assert.rejects(dav.getFile(cfg, ["Shared with Crow", "Casa", "big.bin"], { maxBytes: 1024 }), (e) => e.code === "too_large");
});

test("putFile with a stale If-Match returns 412 without throwing", async () => {
  const r = await dav.putFile(cfg, ["Shared with Crow", "Casa", "a.txt"], Buffer.from("x"), { ifMatch: '"stale"' });
  assert.equal(r.status, 412);
});

test("resolveRef by file_id goes through SEARCH", async () => {
  const e = await dav.stat(cfg, { path: "Shared with Crow/Casa/a.txt" });
  assert.deepEqual(await dav.resolveRef(cfg, { file_id: e.fileId }), ["Shared with Crow", "Casa", "a.txt"]);
});

test("the basic-auth header carries crow-bot; no request URL contains the password", () => {
  assert.ok(fake.calls.length > 0);
  for (const c of fake.calls) { assert.equal(c.user, "crow-bot"); assert.doesNotMatch(c.url, /pw/); }
});
