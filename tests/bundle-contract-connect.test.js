import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const BASE = { id: "demo", name: "Demo", description: "d", type: "mcp-server", category: "misc" };
function mk(connect, extra = {}) {
  return {
    ...BASE,
    env_vars: [
      { name: "HA_URL", description: "u" },
      { name: "HA_TOKEN", description: "t", secret: true },
      { name: "PLAIN", description: "p" },
    ],
    connect: {
      method: "token",
      group: "network",
      fields: [
        { name: "HA_URL", kind: "address", label_key: "k.url" },
        { name: "HA_TOKEN", kind: "secret", label_key: "k.token", help_key: "k.help" },
      ],
      steps: ["s.one"],
      ...connect,
    },
    ...extra,
  };
}
const v = (m) => validateManifest(m, "/tmp/demo");
const has = (r, s) => assert.ok(r.errors.some((e) => e.includes(s)), `expected "${s}" in: ${r.errors.join("; ")}`);

test("a complete connect block passes", () => {
  const r = v(mk({
    derived_env: { AUTH: { template: "Bearer ${HA_TOKEN}", encoding: "raw" } },
    discover: { kind: "http", url: "http://127.0.0.1:8123/api/", expect: [200, 401] },
    test: { kind: "http", url: "${HA_URL}/api/", headers: { Authorization: "Bearer ${HA_TOKEN}" }, expect: [200] },
    label_from: "address",
    step_links: { "s.one": "https://example.com/${HA_TOKEN}" },
  }));
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("connect fields must name env_vars", () => {
  const m = mk({ fields: [{ name: "HA_X", kind: "text", label_key: "k" }] });
  has(v(m), "connect.fields HA_X");
});

test("secret field needs secret env var", () => {
  const m = mk({ fields: [{ name: "PLAIN", kind: "secret", label_key: "k" }] });
  has(v(m), "connect.fields PLAIN");
});

test("toggle has no fields; legacy_enable_env only on toggles", () => {
  has(v(mk({ method: "toggle", group: "builtin" })), "toggle has no fields");
  const ok = v(mk({ method: "toggle", group: "builtin", fields: [], legacy_enable_env: "ENABLE_X" }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
  has(v(mk({ legacy_enable_env: "ENABLE_X" })), "legacy_enable_env");
});

test("templates use field names only", () => {
  has(v(mk({ derived_env: { AUTH_HEADER: { template: "Bearer ${NOPE}", encoding: "raw" } } })), "NOPE");
  has(v(mk({ test: { kind: "http", url: "https://x.example/${NOPE}", expect: [200] } })), "NOPE");
  has(v(mk({ test: { kind: "http", url: "https://x.example/", headers: { A: "${NOPE}" }, expect: [200] } })), "NOPE");
});

test("oauth only with method oauth", () => {
  has(v(mk({ oauth: { provider: "google", scopes: ["a"] } })), "oauth");
  const ok = v(mk({ method: "oauth", group: "signin", fields: [], oauth: { provider: "google", scopes: ["a"] } }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("shape: group outside the enum fails; requires.bins must be strings", () => {
  const r = v(mk({ group: "elsewhere" }));
  assert.equal(r.ok, false);
  has(r, "shape");
  const b = v({ ...mk({}), requires: { bins: "uvx" } });
  assert.equal(b.ok, false);
  const good = v({ ...mk({}), requires: { bins: ["uvx"] } });
  assert.equal(good.ok, true, good.errors.join("; "));
});

test("test url scheme and discover url rules", () => {
  has(v(mk({ test: { kind: "http", url: "http://x.example/", expect: [200] } })), "connect.test.url");
  has(v(mk({ test: { kind: "http", url: "${HA_TOKEN}/x", expect: [200] } })), "connect.test.url");
  has(v(mk({ discover: { kind: "http", url: "http://example.com/", expect: [200] } })), "connect.discover.url");
});

test("folder test shape", () => {
  const r = v(mk({ method: "folder", group: "paste", fields: [], test: { kind: "folder", expect_entry: ".obsidian" } }));
  assert.equal(r.ok, true, r.errors.join("; "));
});
