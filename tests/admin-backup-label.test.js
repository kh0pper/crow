/**
 * admin-backup getInstanceLabel generalization (Item 4-PR4, B9).
 *
 * The label used to be derived via a personal /^kevin-(.+)$/ regex on
 * NTFY_TOPIC. Now: an optional CROW_NTFY_LABEL_PREFIX is stripped when it
 * matches; otherwise the topic is used verbatim; the CROW_DB_PATH heuristics
 * remain the fallback when no topic is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getInstanceLabel } from "../servers/gateway/routes/admin-backup.js";

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("no prefix configured -> topic verbatim (no kevin special-case)", () => {
  withEnv({ NTFY_TOPIC: "kevin-mpa", CROW_NTFY_LABEL_PREFIX: null }, () => {
    assert.equal(getInstanceLabel(), "kevin-mpa");
  });
});

test("configured prefix is stripped when it matches", () => {
  withEnv({ NTFY_TOPIC: "kevin-mpa", CROW_NTFY_LABEL_PREFIX: "kevin" }, () => {
    assert.equal(getInstanceLabel(), "mpa");
  });
});

test("configured prefix that does not match -> topic verbatim", () => {
  withEnv({ NTFY_TOPIC: "alerts-prod", CROW_NTFY_LABEL_PREFIX: "kevin" }, () => {
    assert.equal(getInstanceLabel(), "alerts-prod");
  });
});

test("no topic -> CROW_DB_PATH heuristics still apply", () => {
  withEnv({ NTFY_TOPIC: null, CROW_NTFY_LABEL_PREFIX: null, CROW_DB_PATH: "/x/.crow-mpa/data/crow.db" }, () => {
    assert.equal(getInstanceLabel(), "mpa");
  });
  withEnv({ NTFY_TOPIC: null, CROW_NTFY_LABEL_PREFIX: null, CROW_DB_PATH: "/x/home-finance/crow.db" }, () => {
    assert.equal(getInstanceLabel(), "finance");
  });
  withEnv({ NTFY_TOPIC: null, CROW_NTFY_LABEL_PREFIX: null, CROW_DB_PATH: null }, () => {
    assert.equal(getInstanceLabel(), "primary");
  });
});
