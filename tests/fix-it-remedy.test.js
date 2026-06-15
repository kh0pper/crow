import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { getExposedCapabilities } from "../servers/gateway/peer-exposure.js";

let dir, db, remedy;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fixit-remedy-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  remedy = (await import("../servers/gateway/fix-it/remedies/expose-capability.js")).default;
});

after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("expose-capability adds the capability (idempotent), marks resolved", async () => {
  const r1 = await remedy({ capability: "funkwhale" }, { db });
  assert.equal(r1.resolved, true);
  let exposed = await getExposedCapabilities(db);
  assert.ok(exposed.has("funkwhale"));
  const r2 = await remedy({ capability: "funkwhale" }, { db }); // idempotent
  assert.equal(r2.resolved, true);
  exposed = await getExposedCapabilities(db);
  assert.equal([...exposed].filter((x) => x === "funkwhale").length, 1);
});

test("blank capability → not resolved", async () => {
  const r = await remedy({ capability: "" }, { db });
  assert.equal(r.resolved, false);
});
