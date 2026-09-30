import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDbClient } from "../servers/db.js";
import { isLocalDashboardSession, stepUpOk } from "../bundles/phone/server/authority.js";
import { readRunnerSecret } from "../bundles/phone/server/secrets.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("local session yes, SSO session no, expired no", async () => {
  const db = createDbClient(join(mkdtempSync(join(tmpdir(), "phone-auth-")), "crow.db"));
  await db.execute({ sql: "CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, client_id TEXT, scopes TEXT, expires_at TEXT)", args: [] });
  const ins = (raw, scopes, exp) => db.execute({ sql: "INSERT INTO oauth_tokens VALUES (?,?,?,datetime('now', ?))", args: [sha(raw), "dashboard", scopes, exp] });
  await ins("local", "dashboard", "+1 day");
  await ins("sso", "dashboard sso", "+1 day");
  await ins("old", "dashboard", "-1 day");
  assert.equal(await isLocalDashboardSession(db, "local"), true);
  assert.equal(await isLocalDashboardSession(db, "sso"), false);
  assert.equal(await isLocalDashboardSession(db, "old"), false);
  assert.equal(await isLocalDashboardSession(db, ""), false);
});

test("stepUpOk: passes when 2FA off, requires a valid code when on", async () => {
  const off = { is2faEnabled: async () => false, getTotpSecret: async () => "S", verifyTotp: () => false };
  const on = (ok) => ({ is2faEnabled: async () => true, getTotpSecret: async () => "S", verifyTotp: (c, s) => ok && c === "123456" && s === "S" });
  assert.equal(await stepUpOk("", off), true);
  assert.equal(await stepUpOk("123456", on(true)), true);
  assert.equal(await stepUpOk("000000", on(true)), false);
  assert.equal(await stepUpOk("", on(true)), false);
});

test("runner secret comes from PHONE_RUNNER_SECRET and must be >= 32 chars", () => {
  assert.equal(readRunnerSecret({}), null);
  assert.equal(readRunnerSecret({ PHONE_RUNNER_SECRET: "short" }), null);
  const good = "a".repeat(48);
  assert.equal(readRunnerSecret({ PHONE_RUNNER_SECRET: good }), good);
});
