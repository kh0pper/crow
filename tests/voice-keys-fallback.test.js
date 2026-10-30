/**
 * The voice escalation chain (voice-keys.js): resolveVoiceKeys reads the
 * everyday role binding's optional `fallback` role ids and returns their raw
 * keys as `escalateFallbacks`, in order, de-duplicated, without the
 * fast/escalate keys, empty when COMPANION_ESCALATION_MODEL pins the
 * escalation model or on any failure. The role resolver is stubbed and the
 * db is a plain object, so no model server or scratch database is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVoiceKeys, VOICE_RAW_KEYS } from "../servers/shared/voice-keys.js";
import { bindingKey } from "../servers/shared/model-roles.js";

const EVERYDAY = bindingKey("everyday");

/** A db stand-in: the dashboard_settings rows asked for, empty for everything else. */
function rowsDb(rows, { fail = false } = {}) {
  return {
    async execute(q) {
      if (fail) throw new Error("db down");
      const sql = typeof q === "string" ? q : q?.sql || "";
      return { rows: sql.includes("FROM dashboard_settings") ? rows : [] };
    },
  };
}

const everydayBinding = (fallback) => ({ key: EVERYDAY, value: JSON.stringify({ model: "crow-chat/m", fallback }) });

/** resolveRoleFn(dbc, "role:<id>", opts) from a role id → key map. */
const resolver = (map) => async (_dbc, key) => {
  const id = String(key).replace(/^role:/, "");
  return Object.hasOwn(map, id) ? { key: map[id], role: id, reason: "bound" } : { key: null, role: id, reason: "not_configured" };
};

test("escalateFallbacks: the everyday binding's fallback roles, resolved in order", async () => {
  const db = rowsDb([everydayBinding(["coordinator"])]);
  const k = await resolveVoiceKeys(db, {
    env: {},
    resolveRoleFn: resolver({
      everyday: "crow-chat/m",
      coordinator: "raven/qwen3.8-flash-next",
      voice: VOICE_RAW_KEYS.fast,
    }),
  });
  assert.equal(k.escalate, "crow-chat/m");
  assert.deepEqual(k.escalateFallbacks, ["raven/qwen3.8-flash-next"]);
});

test("escalateFallbacks: duplicates and the fast/escalate keys themselves are excluded", async () => {
  const db = rowsDb([everydayBinding(["voice", "coordinator", "coordinator", "everyday"])]);
  const k = await resolveVoiceKeys(db, {
    env: {},
    resolveRoleFn: resolver({
      everyday: "crow-chat/m",
      voice: VOICE_RAW_KEYS.fast,
      coordinator: "raven/flash",
    }),
  });
  assert.deepEqual(k.escalateFallbacks, ["raven/flash"]);
});

test("escalateFallbacks: [] when COMPANION_ESCALATION_MODEL pins the escalation model", async () => {
  const db = rowsDb([everydayBinding(["coordinator"])]);
  const k = await resolveVoiceKeys(db, {
    env: { COMPANION_ESCALATION_MODEL: "raven/flash" },
    resolveRoleFn: resolver({ everyday: "crow-chat/m", coordinator: "raven/flash", voice: VOICE_RAW_KEYS.fast }),
  });
  assert.equal(k.escalate, "raven/flash");
  assert.deepEqual(k.escalateFallbacks, []);
});

test("escalateFallbacks: [] when nothing is configured, and never throws when the store fails", async () => {
  const empty = await resolveVoiceKeys(rowsDb([]), {
    env: {},
    resolveRoleFn: resolver({ voice: VOICE_RAW_KEYS.fast }),
  });
  assert.deepEqual(empty.escalateFallbacks, []);

  const broken = await resolveVoiceKeys(rowsDb([], { fail: true }), {
    env: {},
    resolveRoleFn: resolver({ everyday: "crow-chat/m", coordinator: "raven/flash", voice: VOICE_RAW_KEYS.fast }),
  });
  assert.deepEqual(broken.escalateFallbacks, []);
});