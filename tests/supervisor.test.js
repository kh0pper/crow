import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupervised } from "../servers/shared/supervisor.js";

// Run fn with a temporary process.env, restoring it afterwards.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("unsupervised by default (no INVOCATION_ID / CROW_SUPERVISED)", () => {
  withEnv({ INVOCATION_ID: undefined, CROW_SUPERVISED: undefined }, () => {
    assert.equal(isSupervised(), false);
  });
});

test("systemd INVOCATION_ID is treated as supervised", () => {
  withEnv({ INVOCATION_ID: "deadbeef", CROW_SUPERVISED: undefined }, () => {
    assert.equal(isSupervised(), true);
  });
});

test("CROW_SUPERVISED=1 opts in (launchd / Docker / pm2)", () => {
  withEnv({ INVOCATION_ID: undefined, CROW_SUPERVISED: "1" }, () => {
    assert.equal(isSupervised(), true);
  });
});

test("CROW_SUPERVISED=true opts in", () => {
  withEnv({ INVOCATION_ID: undefined, CROW_SUPERVISED: "true" }, () => {
    assert.equal(isSupervised(), true);
  });
});

test("CROW_SUPERVISED=0 does not opt in", () => {
  withEnv({ INVOCATION_ID: undefined, CROW_SUPERVISED: "0" }, () => {
    assert.equal(isSupervised(), false);
  });
});
