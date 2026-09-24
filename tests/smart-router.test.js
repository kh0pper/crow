/**
 * smart-router — tier defaults + env override.
 *
 * The Path C auto-router maps a route id (code / vision / fast / deep /
 * default) to a provider id. Since 2026-09 the baked-in defaults point at
 * the resident Strix Halo providers (crow-chat / crow-voice) rather than
 * the retired on-demand swap bundles, and each of code/fast/deep can be
 * overridden by CROW_SMART_ROUTER_<TIER>, read ONCE at module load.
 *
 * chooseProvider() is driven here through a stub db: readSetting() gets
 * feature_flags={smart_chat:true} from the global table, and
 * hasActiveToolCalls() sees no tool_calls rows. CROW_DATA_DIR is pointed
 * at a scratch dir before import so the instance-id lookup never touches
 * a real ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "smart-router-test-"));
process.env.CROW_DATA_DIR = dataDir;
for (const tier of ["CODE", "FAST", "DEEP", "VISION"]) delete process.env[`CROW_SMART_ROUTER_${tier}`];
process.on("exit", () => { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} });

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "servers", "gateway", "ai", "smart-router.js");
const router = await import(pathToFileURL(MODULE_PATH).href);
const { chooseProvider, DEFAULT_ROUTES } = router;

const db = {
  async execute({ sql }) {
    if (sql.includes("dashboard_settings_overrides")) return { rows: [] };
    if (sql.includes("dashboard_settings")) return { rows: [{ value: JSON.stringify({ smart_chat: true }) }] };
    if (sql.includes("chat_messages")) return { rows: [] };
    throw new Error(`unexpected sql in stub db: ${sql}`);
  },
};

const providers = [
  { id: "crow-chat", models: [{ id: "qwen3.6-35b-a3b" }] },
  { id: "crow-voice", models: [{ id: "qwen3.5-4b" }] },
  { id: "some-vl", models: [{ id: "qwen3-vl-4b", input: ["text", "image"] }] },
  { id: "my-coder", models: [{ id: "coder-model" }] },
];

function pick(mod, content, extra = {}) {
  return mod.chooseProvider({
    db, convId: 1, content,
    currentProvider: "crow-chat", currentModel: "qwen3.6-35b-a3b",
    providers, autoRules: null, ...extra,
  });
}

test("DEFAULT_ROUTES: code/deep -> crow-chat, fast -> crow-voice, vision -> null (capability pick), default -> crow-chat", () => {
  assert.deepEqual({ ...DEFAULT_ROUTES }, {
    code: "crow-chat",
    vision: null,
    fast: "crow-voice",
    deep: "crow-chat",
    default: "crow-chat",
  });
  assert.ok(Object.isFrozen(DEFAULT_ROUTES), "DEFAULT_ROUTES must be frozen");
});

test("/code routes to crow-chat with the slash reason", async () => {
  const r = await pick(router, "/code write me a function");
  assert.equal(r.provider_id, "crow-chat");
  assert.equal(r.model_id, "qwen3.6-35b-a3b");
  assert.match(r.reason, /matched \/code/);
});

test("/fast routes to crow-voice", async () => {
  const r = await pick(router, "/fast what time is it");
  assert.equal(r.provider_id, "crow-voice");
  assert.equal(r.model_id, "qwen3.5-4b");
});

test("deep keyword on a long message routes to crow-chat", async () => {
  const r = await pick(router, "summarize the following passage: " + "x".repeat(220));
  assert.equal(r.provider_id, "crow-chat");
  assert.match(r.reason, /keyword: deep/);
});

test("code keyword routes to crow-chat", async () => {
  const r = await pick(router, "please debug this:\n```js\nfoo()\n```");
  assert.equal(r.provider_id, "crow-chat");
  assert.match(r.reason, /keyword: code/);
});

test("profile auto_rules.overrides still beat the baked-in default", async () => {
  const r = await pick(router, "/code foo", { autoRules: { overrides: { code: "my-coder" } } });
  assert.equal(r.provider_id, "my-coder");
});

test("CROW_SMART_ROUTER_CODE env override wins for a fresh module load, and is read once at load", async () => {
  process.env.CROW_SMART_ROUTER_CODE = "my-coder";
  try {
    const fresh = await import(pathToFileURL(MODULE_PATH).href + "?env-override=code");
    assert.equal(fresh.DEFAULT_ROUTES.code, "my-coder");
    assert.equal(fresh.DEFAULT_ROUTES.fast, "crow-voice", "unrelated tiers keep their defaults");
    const r = await pick(fresh, "/code write a parser");
    assert.equal(r.provider_id, "my-coder");
    assert.equal(r.model_id, "coder-model");
    assert.match(r.reason, /^my-coder · matched \/code/);

    // The instance loaded before the env was set is unaffected: read once at load.
    assert.equal(router.DEFAULT_ROUTES.code, "crow-chat");
    const old = await pick(router, "/code write a parser");
    assert.equal(old.provider_id, "crow-chat");
  } finally {
    delete process.env.CROW_SMART_ROUTER_CODE;
  }
});

test("CROW_SMART_ROUTER_FAST / _DEEP env overrides apply; blank values fall back to the default", async () => {
  process.env.CROW_SMART_ROUTER_FAST = "my-coder";
  process.env.CROW_SMART_ROUTER_DEEP = "   ";
  try {
    const fresh = await import(pathToFileURL(MODULE_PATH).href + "?env-override=fast-deep");
    assert.equal(fresh.DEFAULT_ROUTES.fast, "my-coder");
    assert.equal(fresh.DEFAULT_ROUTES.deep, "crow-chat", "blank env value is ignored");
    const r = await pick(fresh, "/fast ping");
    assert.equal(r.provider_id, "my-coder");
  } finally {
    delete process.env.CROW_SMART_ROUTER_FAST;
    delete process.env.CROW_SMART_ROUTER_DEEP;
  }
});

test("env override naming a provider that is absent falls through to crow-chat", async () => {
  process.env.CROW_SMART_ROUTER_CODE = "not-installed";
  try {
    const fresh = await import(pathToFileURL(MODULE_PATH).href + "?env-override=absent");
    const r = await pick(fresh, "/code hello");
    assert.equal(r.provider_id, "crow-chat");
  } finally {
    delete process.env.CROW_SMART_ROUTER_CODE;
  }
});

test("pickVisionProvider: lowest enabled image-capable id; disabled skipped; none -> null", () => {
  const { pickVisionProvider } = router;
  const list = [
    { id: "zz-vl", disabled: 0, models: [{ id: "a", input: ["text", "image"] }] },
    { id: "aa-vl", disabled: true, models: [{ id: "b", input: ["image"] }] },
    { id: "mm-vl", disabled: 0, models: [{ id: "c", task: "vision" }] },
    { id: "crow-chat", disabled: 0, models: [{ id: "d", input: ["text"] }] },
  ];
  assert.equal(pickVisionProvider(list)?.id, "mm-vl");
  assert.equal(pickVisionProvider([{ id: "x", disabled: 1, models: [{ input: ["image"] }] }]), null);
  assert.equal(pickVisionProvider([]), null);
  assert.equal(pickVisionProvider(null), null);
});

test("image attachment routes to the image-capable provider", async () => {
  const r = await pick(router, "what is this?", { attachments: [{ mime_type: "image/png" }] });
  assert.equal(r.provider_id, "some-vl");
});

test("/vision slash routes to the image-capable provider", async () => {
  const r = await pick(router, "/vision describe it");
  assert.equal(r.provider_id, "some-vl");
});

test("image attachment with no enabled vision-capable provider falls back as before", async () => {
  const noVision = providers.filter((p) => p.id !== "some-vl").concat([{ id: "off-vl", disabled: 1, models: [{ input: ["image"] }] }]);
  const r = await pick(router, "what is this?", { attachments: [{ mime_type: "image/png" }], providers: noVision });
  assert.notEqual(r.provider_id, "off-vl");
  assert.equal(r.provider_id, "crow-chat");
});

test("image attachment: capability-picked vision provider uses its image-capable model, not models[0]", async () => {
  const mixedProviders = providers.concat([
    { id: "aa-vl-mixed", models: [{ id: "text-only" }, { id: "vl-model", input: ["text", "image"] }] },
  ]);
  const r = await pick(router, "what is this?", { attachments: [{ mime_type: "image/png" }], providers: mixedProviders });
  assert.equal(r.provider_id, "aa-vl-mixed");
  assert.equal(r.model_id, "vl-model");
});

test("smart-router.js contains no named-host literal", async () => {
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(readFileSync(MODULE_PATH, "utf8"), /grackle-(embed|rerank|vision)/);
});

test("CROW_SMART_ROUTER_VISION env override wins for a fresh module load", async () => {
  process.env.CROW_SMART_ROUTER_VISION = "my-coder";
  try {
    const fresh = await import(pathToFileURL(MODULE_PATH).href + "?env-override=vision");
    assert.equal(fresh.DEFAULT_ROUTES.vision, "my-coder");
    const r = await pick(fresh, "what is this?", { attachments: [{ mime_type: "image/png" }] });
    assert.equal(r.provider_id, "my-coder");
  } finally {
    delete process.env.CROW_SMART_ROUTER_VISION;
  }
});
