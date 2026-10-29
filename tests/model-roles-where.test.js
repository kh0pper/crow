import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_ROLES, whereItRuns, ROLE_JOB_KEYS } from "../servers/shared/model-roles.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const row = (id, baseUrl, extra = {}) => ({ id, baseUrl, host: "local", disabled: false, models: [{ id: "m1" }], ...extra });
const providers = [
  row("local-chat", "http://127.0.0.1:8003/v1"),
  row("own-ip", "http://100.64.20.5:8011/v1"),
  row("peer-door", "http://100.64.20.7:3001/llm/p/m/v1"),
  row("cloud-a", "https://8.8.8.8/v1"),
  row("doc-net", "https://203.0.113.9/v1"),
  row("named", "https://api.example.com/v1"),
  row("any4", "http://0.0.0.0:8080/v1"),
  row("any6", "http://[::]:8080/v1"),
  row("nat64", "http://[64:ff9b::808:808]/v1"),
];
const opts = { providers, ownAddrs: new Set(["100.64.20.5"]) };
const where = (k) => whereItRuns(k, opts);

test("here", () => {
  assert.equal(where("local-chat/m1"), "here");
  assert.equal(where("own-ip/m1"), "here");
});
test("other box", () => assert.equal(where("peer-door/m1"), "other_box"));
test("cloud, unproven, missing", () => {
  assert.equal(where("cloud-a/m1"), "cloud");
  assert.equal(where("cloud-a/m1"), "cloud");
  assert.equal(where("named/m1"), "unproven");
  assert.equal(where("nope/m1"), "missing");
  assert.equal(where("local-chat"), "missing");
  assert.equal(where("role:voice"), "missing");
});
test("a reserved literal is unproven, not cloud", () => assert.equal(where("doc-net/m1"), "unproven"));
test("unspecified and embedded literals are never cloud (N2)", () => {
  assert.equal(where("any4/m1"), "unproven");
  assert.equal(where("any6/m1"), "unproven");
  assert.equal(where("nat64/m1"), "unproven");
});
test("jobs", () => {
  assert.deepEqual(Object.keys(ROLE_JOB_KEYS), CORE_ROLES.map((r) => r.id));
  assert.ok(Object.isFrozen(ROLE_JOB_KEYS));
  assert.equal(t(ROLE_JOB_KEYS.voice, "es"), "Responde cuando hablas con Crow");
  for (const k of Object.values(ROLE_JOB_KEYS)) assert.notEqual(t(k, "en"), k);
});
