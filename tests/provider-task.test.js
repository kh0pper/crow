import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  pickProviderByTask, resolveProviderForTask, _resetProviderTaskCacheForTest, EMBED_TASKS, RERANK_TASKS,
} from "../servers/shared/provider-task.js";

const withTask = (task, extra = {}) => ({ models: [{ id: "m", task }], ...extra });

beforeEach(() => _resetProviderTaskCacheForTest());

test("task synonym sets", () => {
  assert.deepEqual([...EMBED_TASKS], ["embed", "embedding"]);
  assert.deepEqual([...RERANK_TASKS], ["rerank", "score"]);
  assert.ok(Object.isFrozen(EMBED_TASKS) && Object.isFrozen(RERANK_TASKS));
});

test("pickProviderByTask: lowest enabled id wins (map and array forms); synonyms match", () => {
  const map = { "grackle-embed": withTask("embed"), "crow-embed": withTask("embedding"), "crow-chat": { models: [{ id: "x" }] } };
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "crow-embed");
  const arr = [{ id: "zz-rr", ...withTask("score") }, { id: "aa-rr", ...withTask("rerank") }];
  assert.equal(pickProviderByTask(arr, RERANK_TASKS), "aa-rr");
  assert.equal(pickProviderByTask(arr, "score"), "zz-rr");
});

test("pickProviderByTask: any model in the row counts; JSON-string models parse", () => {
  const map = { multi: { models: [{ id: "chat" }, { id: "e", task: "embed" }] }, str: { models: JSON.stringify([{ id: "e", task: "embed" }]) } };
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "multi");
  delete map.multi;
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "str");
});

test("pickProviderByTask: disabled (1 or true) skipped; missing/empty/garbage models ignored; no match -> null", () => {
  const map = { "crow-embed": withTask("embed", { disabled: true }), "d1": withTask("embed", { disabled: 1 }), "grackle-embed": withTask("embed", { disabled: 0 }), a: { models: [] }, b: {}, c: { models: "not json" } };
  assert.equal(pickProviderByTask(map, EMBED_TASKS), "grackle-embed");
  assert.equal(pickProviderByTask(map, RERANK_TASKS), null);
  assert.equal(pickProviderByTask({}, EMBED_TASKS), null);
  assert.equal(pickProviderByTask(null, EMBED_TASKS), null);
  assert.equal(pickProviderByTask("nope", EMBED_TASKS), null);
});

function fakeDb({ setting = null, rows = [] } = {}) {
  const calls = [];
  const factory = () => ({
    async execute({ sql }) {
      calls.push(sql);
      if (/dashboard_settings/.test(sql)) return { rows: setting === null ? [] : [{ value: setting }] };
      if (/FROM providers/.test(sql)) return { rows };
      throw new Error("unexpected sql " + sql);
    },
    close() {},
  });
  return { factory, calls };
}
const dbRow = (id, task, disabled = 0) => ({ id, models: JSON.stringify([{ id: "m", task }]), disabled });

test("resolveProviderForTask: env wins, and is read before the cache on every call", async () => {
  const prev = process.env.X_TEST_PROVIDER;
  const { factory } = fakeDb({ rows: [dbRow("crow-embed", "embed")] });
  try {
    delete process.env.X_TEST_PROVIDER;
    assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_TEST_PROVIDER", settingKey: "embed_provider", dbFactory: factory }), "crow-embed");
    process.env.X_TEST_PROVIDER = "from-env";
    assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_TEST_PROVIDER", settingKey: "embed_provider", dbFactory: factory }), "from-env");
  } finally {
    if (prev === undefined) delete process.env.X_TEST_PROVIDER; else process.env.X_TEST_PROVIDER = prev;
  }
});

test("resolveProviderForTask: setting wins over the task pick; whitespace setting ignored", async () => {
  let r = fakeDb({ setting: "my-embed", rows: [dbRow("crow-embed", "embed")] });
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_1", settingKey: "embed_provider", dbFactory: r.factory }), "my-embed");
  _resetProviderTaskCacheForTest();
  r = fakeDb({ setting: "   ", rows: [dbRow("crow-embed", "embed")] });
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_1", settingKey: "embed_provider", dbFactory: r.factory }), "crow-embed");
});

test("resolveProviderForTask: task pick; none -> null; DB failure -> null", async () => {
  const r = fakeDb({ rows: [dbRow("grackle-embed", "embed"), dbRow("crow-embed", "embed", 1), dbRow("crow-rerank", "score")] });
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_2", settingKey: "embed_provider", dbFactory: r.factory }), "grackle-embed");
  assert.equal(await resolveProviderForTask({ tasks: RERANK_TASKS, envVar: "X_UNSET_2", settingKey: "rerank_provider", dbFactory: r.factory }), "crow-rerank");
  assert.equal(await resolveProviderForTask({ tasks: ["vision"], envVar: "X_UNSET_2", settingKey: "vision_x", dbFactory: r.factory }), null);
  _resetProviderTaskCacheForTest();
  const broken = () => { throw new Error("no db"); };
  assert.equal(await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_2", settingKey: "embed_provider", dbFactory: broken }), null);
});

test("resolveProviderForTask: cached 30 s per task|settingKey (second call does not hit the DB; another key does)", async () => {
  const r = fakeDb({ rows: [dbRow("crow-embed", "embed")] });
  await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_3", settingKey: "embed_provider", dbFactory: r.factory });
  const n = r.calls.length;
  await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_3", settingKey: "embed_provider", dbFactory: r.factory });
  assert.equal(r.calls.length, n);
  await resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "X_UNSET_3", settingKey: "other_key", dbFactory: r.factory });
  assert.ok(r.calls.length > n);
});
