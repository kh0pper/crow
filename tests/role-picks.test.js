import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listRolePicks } from "../servers/shared/role-picks.js";
import { checkStamp } from "../servers/shared/pick-checks.js";

const origWarn = console.warn;
before(() => { console.warn = () => {}; });
after(() => { console.warn = origWarn; });

const row = (id, baseUrl, models, extra = {}) => ({ id, baseUrl, host: "local", disabled: false, models, ...extra });
const PROVIDERS = [
  row("local-chat", "http://127.0.0.1:8003/v1", [{ id: "m1" }]),
  row("local-emb", "http://127.0.0.1:8020/v1", [{ id: "e1", task: "embedding" }, { id: "e2", task: "embedding" }], { description: "Local embeddings (bundle)" }),
  row("big", "http://127.0.0.1:8030/v1", [{ id: "b1" }], { gpuPolicy: { catalogId: "cat-big" } }),
  // A public literal: reserved literals are "unproven", never cloud.
  row("cloud-a", "https://8.8.8.8/v1", [{ id: "c1" }]),
  row("off", "http://127.0.0.1:8040/v1", [{ id: "x1" }], { disabled: true }),
];
const modelsOf = (ps) => ({ providers: Object.fromEntries(ps.filter((p) => !p.disabled).map((p) => [p.id, { models: p.models }])) });

const makeCtx = (over = {}) => ({
  bindings: {},
  customDefs: {},
  providers: PROVIDERS,
  models: modelsOf(PROVIDERS),
  catalog: [{ id: "cat-big", serving: { class: "windowed" } }],
  ownInstanceId: () => "i-test",
  ...over,
});
const OWN = new Set();
const picks = (roleId, opts = {}) => listRolePicks(roleId, { ctx: makeCtx(), ownAddrs: OWN, ...opts });
const keys = (ps) => ps.map((p) => p.key);

test("capability: one embed pick per provider; chat roles never offer an embedding model", () => {
  const emb = picks("embed");
  assert.deepEqual(keys(emb), ["local-emb/e1"]);
  assert.equal(emb[0].label, "Local embeddings");
  assert.equal(emb[0].provider, "local-emb");
  assert.equal(emb[0].where, "here");
  assert.equal(emb[0].allowed, true);
  const every = keys(picks("everyday"));
  assert.ok(every.includes("local-chat/m1"));
  assert.ok(!every.includes("local-emb/e1"));
  assert.ok(!every.includes("local-emb/e2"));
});

test("rerank: no scoring model, no pick", () => assert.deepEqual(picks("rerank"), []));

test("disabled providers offer nothing", () => assert.ok(!keys(picks("everyday")).includes("off/x1")));

test("class rule: an automatic role never offers a windowed model; deep does", () => {
  assert.ok(!keys(picks("everyday")).includes("big/b1"));
  assert.ok(keys(picks("deep")).includes("big/b1"));
});

test("safety refuses cloud but still lists it", () => {
  const s = picks("safety");
  const c = s.find((p) => p.key === "cloud-a/c1");
  assert.ok(c);
  assert.equal(c.allowed, false);
  assert.equal(c.why, "cloud_refused");
  assert.equal(c.where, "cloud");
  const local = s.find((p) => p.key === "local-chat/m1");
  assert.equal(local.allowed, true);
  assert.equal(local.why, undefined);
});

test("the classifier is never chained, in either direction", () => {
  const ctx = makeCtx({ bindings: {
    safety: { model: "local-chat/m1", fallback: [] },
    quick: { model: "local-chat/m1", fallback: [] },
    voice: { model: "local-chat/m1", fallback: [] },
  } });
  const toSafety = keys(listRolePicks("safety", { ctx, ownAddrs: OWN }));
  assert.ok(toSafety.includes("local-chat/m1"));
  assert.ok(!toSafety.some((k) => k.startsWith("role:")));
  const everyday = keys(listRolePicks("everyday", { ctx, ownAddrs: OWN }));
  assert.ok(!everyday.includes("role:safety"));
  assert.ok(everyday.includes("role:quick"));
  assert.ok(everyday.includes("role:voice")); // "Same as Voice" stays allowed
});

test("other roles allow cloud", () => {
  const c = picks("everyday").find((p) => p.key === "cloud-a/c1");
  assert.equal(c.allowed, true);
  assert.equal(c.why, undefined);
});

test("role refs: other chat roles that resolve, never the role itself", () => {
  const ctx = makeCtx({ bindings: { quick: { model: "local-chat/m1", fallback: [] } } });
  const ps = listRolePicks("everyday", { ctx, lang: "es", ownAddrs: OWN });
  const q = ps.find((p) => p.key === "role:quick");
  assert.ok(q);
  assert.equal(q.label, "Igual que Explorador");
  assert.equal(q.where, "here");
  assert.equal(q.provider, "local-chat");
  assert.ok(!keys(ps).includes("role:everyday"));
  // A role whose chain resolves nothing is not offered.
  assert.ok(!keys(ps).includes("role:expert"));
  // Embed and rerank never take role refs.
  assert.ok(!keys(listRolePicks("embed", { ctx, ownAddrs: OWN })).some((k) => k.startsWith("role:")));
});

test("custom chat roles are offered by their label", () => {
  const ctx = makeCtx({
    customDefs: { "c-notes": { capability: "chat", label: "Note taker" } },
    bindings: { "c-notes": { model: "local-chat/m1", fallback: [] } },
  });
  const q = listRolePicks("everyday", { ctx, ownAddrs: OWN }).find((p) => p.key === "role:c-notes");
  assert.equal(q.label, "Same as Note taker");
});

test("order: recommended first, then here, other box, cloud, unproven; ties by label", () => {
  const ps = picks("everyday", { recommendedFn: () => ["cloud-a/c1"] });
  assert.equal(ps[0].key, "cloud-a/c1");
  assert.equal(ps[0].recommended, true);
  assert.ok(ps.slice(1).every((p) => p.recommended === false));

  const extra = [
    ...PROVIDERS,
    row("peer", "http://192.168.1.40:8011/v1", [{ id: "p1" }]),
    row("named", "https://api.example.com/v1", [{ id: "n1" }]),
    row("local-b", "http://127.0.0.1:8050/v1", [{ id: "a1" }]),
  ];
  const ctx = makeCtx({ providers: extra, models: modelsOf(extra) });
  const ordered = listRolePicks("everyday", { ctx, ownAddrs: OWN });
  assert.deepEqual(ordered.map((p) => p.where), ["here", "here", "other_box", "cloud", "unproven"]);
  assert.deepEqual(keys(ordered), ["local-b/a1", "local-chat/m1", "peer/p1", "cloud-a/c1", "named/n1"]);
});

test("media and unknown roles return []", () => {
  for (const id of ["stt", "tts", "image", "video", "nope"]) assert.deepEqual(picks(id), []);
});

// --- Task 11: the default recommendedFn ---------------------------------------
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const recFile = (() => {
  const f = join(mkdtempSync(join(tmpdir(), "picks-recs-")), "recs.json");
  const e = (id, kind = "chat") => ({ model_id: id, id_verified: true, kind, status: "stable", retires: null });
  writeFileSync(f, JSON.stringify({
    schema_version: 1, accessed: "2026-10-01", review_by: "2027-01-28", source_notes: "",
    providers: { openai: { roles: { everyday: [e("gpt-6.1-sol"), e("gpt-6-luna")], embed: [e("text-embedding-3-large", "embed")] } } },
  }));
  return f;
})();
const REC = { recOpts: { file: recFile }, now: new Date("2026-10-28T12:00:00Z") };
const OPENAI = row("cloud-o", "https://api.openai.com/v1", [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }, { id: "text-embedding-3-large", task: "embedding" }]);
const recCtx = () => {
  const ps = [...PROVIDERS, OPENAI];
  return makeCtx({ providers: ps, models: modelsOf(ps) });
};
// Stored checks carry the stamp of the row they ran against (F3).
const stamp = (byProvider, rowOf = () => OPENAI) => Object.fromEntries(Object.entries(byProvider).map(([pid, m]) =>
  [pid, Object.fromEntries(Object.entries(m).map(([k, c]) => [k, { ...checkStamp(rowOf(pid)), ...c }]))]));
const starred = (roleId, opts) => listRolePicks(roleId, { ctx: recCtx(), ownAddrs: OWN, ...REC, ...opts }).filter((p) => p.recommended).map((p) => p.key);

test("default recommendedFn: only listed picks that passed their check", () => {
  // No checks stored: nothing is recommended.
  assert.deepEqual(starred("everyday"), []);
  const pickChecks = stamp({ "cloud-o": {
    "gpt-6.1-sol|chat": { ok: false, code: "no_tool_call" },
    "gpt-6-luna|chat": { ok: true, code: "ok" },
    "text-embedding-3-large|chat": { ok: true, code: "ok" },
  } });
  assert.deepEqual(starred("everyday", { pickChecks }), ["cloud-o/gpt-6-luna"]);
  // Embed picks read the embed check only.
  assert.deepEqual(starred("embed", { pickChecks }), []);
  const withEmbed = stamp({ "cloud-o": { ...pickChecks["cloud-o"], "text-embedding-3-large|embed": { ok: true, code: "ok" } } });
  // A check made with another key gives no star.
  const otherKey = stamp({ "cloud-o": { "gpt-6-luna|chat": { ok: true, code: "ok" } } }, () => ({ ...OPENAI, apiKey: "fixture-key-old" }));
  assert.deepEqual(starred("everyday", { pickChecks: otherKey }), []);
  assert.deepEqual(starred("embed", { pickChecks: withEmbed }), ["cloud-o/text-embedding-3-large"]);
  // Past review_by every check reads "not tested".
  assert.deepEqual(starred("everyday", { pickChecks, now: new Date("2027-02-01T00:00:00Z") }), []);
  // Rows with no preset recommend nothing, whatever is stored.
  assert.deepEqual(starred("everyday", { pickChecks: stamp({ "local-chat": { "m1|chat": { ok: true, code: "ok" } } }, () => PROVIDERS[0]) }), []);
});

test("an injected recommendedFn still wins over the default", () => {
  const pickChecks = stamp({ "cloud-o": { "gpt-6-luna|chat": { ok: true, code: "ok" } } });
  assert.deepEqual(starred("everyday", { pickChecks, recommendedFn: () => ["local-chat/m1"] }), ["local-chat/m1"]);
});
