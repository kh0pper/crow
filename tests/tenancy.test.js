import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { DEFAULT_TENANT_ID, resolveTenantId, ensureTenant } from "../servers/shared/tenancy.js";

test("resolveTenantId returns 'default' when CROW_TENANT_ID is unset", () => {
  const prev = process.env.CROW_TENANT_ID;
  delete process.env.CROW_TENANT_ID;
  try {
    assert.equal(resolveTenantId(), "default");
    assert.equal(resolveTenantId(), DEFAULT_TENANT_ID);
  } finally {
    if (prev !== undefined) process.env.CROW_TENANT_ID = prev;
  }
});

test("resolveTenantId returns the env value when CROW_TENANT_ID is set", () => {
  const prev = process.env.CROW_TENANT_ID;
  process.env.CROW_TENANT_ID = "district-acme";
  try {
    assert.equal(resolveTenantId(), "district-acme");
  } finally {
    if (prev === undefined) delete process.env.CROW_TENANT_ID;
    else process.env.CROW_TENANT_ID = prev;
  }
});

test("resolveTenantId ignores ctx (Phase-3 seam, no-op today)", () => {
  const prev = process.env.CROW_TENANT_ID;
  delete process.env.CROW_TENANT_ID;
  try {
    assert.equal(resolveTenantId({ req: {}, auth: { user: "x" }, device: "y" }), "default");
  } finally {
    if (prev !== undefined) process.env.CROW_TENANT_ID = prev;
  }
});

test("ensureTenant inserts once and is idempotent", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))`);
  await ensureTenant(db, { id: "default", name: "Default (operator)" });
  await ensureTenant(db, { id: "default", name: "Different name" }); // no-op (INSERT OR IGNORE)
  const { rows } = await db.execute("SELECT id, name, status FROM tenants");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "default");
  assert.equal(rows[0].name, "Default (operator)"); // first write wins
  assert.equal(rows[0].status, "active");
});
