// tests/provider-own-box-mark.test.js — the operator's "This is my other box"
// mark (F28(b), option A: a mark, no migration).
//
// A row on another of the operator's machines (a LAN or tailnet address, or a
// name for one) can be marked "This is my other box" on this box. The mark has
// its OWN dashboard_settings key (instance scope, never synced), lapses when
// the row's hostname changes, and only changes labels and ranks: whereItRuns
// answers "other_box" instead of "cloud". It never ticks "This is local" and
// never relaxes the strict voice/phone check (cloudStatus, isCloudKey,
// isStrictCloud read no such mark).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import { createDbClient } from "../servers/db.js";
import {
  readLocalMarks, markLocal, readOwnBoxMarks, markOwnBox, unmarkOwnBox, isOwnBoxMarkCurrent, isOwnBoxMarkableRow,
  addLocalMarksChangeListener, isStrictCloud, localMarkTokenFor, ownBoxMarkTokenFor, LOCAL_MARKS_KEY, OWN_BOX_MARKS_KEY,
} from "../servers/shared/provider-local-marks.js";
import { isCloudKey, whereItRuns } from "../servers/shared/model-roles.js";
import { loadRoleContext, invalidateRoleContext, setBinding } from "../servers/shared/model-roles-store.js";
import { isInstanceScope, isSyncable } from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import { ensureCloudConsentSalt } from "../servers/shared/cloud-consent.js";
import { providerRowToObject } from "../servers/shared/provider-row.js";
import { privacyRank, sessionSourceRank, summarizeSession } from "../servers/gateway/perch/session-summary.js";
import tab from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

/** This box's addresses, pinned: the operator's second box is not one of them. */
const OWN = new Set(["127.0.0.1", "::1", "10.0.0.5"]);
const ENV = {};

const dbs = [];
after(() => { for (const d of dbs) d.cleanup(); });

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "own-box-marks-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const path = join(dir, "crow.db");
  const db = createDbClient(path);
  dbs.push({
    dir, db,
    cleanup() { try { db.close(); } catch {} rmScratch(dir); },
  });
  return { db, dir };
}

const ins = (db, id, url, host, models) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, lamport_ts, instance_id) VALUES (?,?,?,?,?,0,1,?)",
    args: [id, url, null, host, JSON.stringify(models.map((m) => ({ id: m }))), "a".repeat(32)],
  });
const providersOf = async (db) => (await db.execute("SELECT * FROM providers")).rows.map(providerRowToObject);

/** The operator's second box (a tailnet literal, stored host "cloud": external engine) and a row on this box. */
async function seeded() {
  const d = fresh();
  const { db } = d;
  await ins(db, "second-box", "http://10.0.0.9:8011/v1", "cloud", ["m1"]);
  await ins(db, "here-box", "http://10.0.0.5:8011/v1", "local", ["m2"]);
  await ins(db, "public-box", "https://203.0.113.9/v1", "cloud", ["m3"]);
  await ins(db, "named-box", "http://second.example.internal:8011/v1", "cloud", ["m4"]);
  await ins(db, "zai-x", "https://api.z.ai/api/coding/paas/v4", "local", ["glm-x"]);
  invalidateRoleContext();
  return { db, dir: d.dir };
}

test("instance scope: this mark has its own key, instance scope, never synced", () => {
  assert.equal(OWN_BOX_MARKS_KEY, "provider_own_box_marks");
  assert.notEqual(OWN_BOX_MARKS_KEY, LOCAL_MARKS_KEY, "its own key: it can never tick This is local");
  assert.equal(isInstanceScope(OWN_BOX_MARKS_KEY), true);
  assert.equal(isSyncable(OWN_BOX_MARKS_KEY), false);
});

test("a marked private-literal row with stored host cloud reads other_box; the strict checks do not move", async () => {
  const { db } = await seeded();
  const providers = await providersOf(db);
  // Before the mark: stored host "cloud" is what the chip says (the owner's ruling).
  assert.equal(whereItRuns("second-box/m1", { providers, ownAddrs: OWN }), "cloud");
  assert.equal(isCloudKey("second-box/m1", { providers, ownAddrs: OWN }), false, "the address already says local");
  assert.equal(isStrictCloud("second-box/m1", { providers, ownAddrs: OWN }), true, "the cloud flag still rules the strict check");

  assert.deepEqual(await markOwnBox(db, "second-box", { actor: "operator", ownAddrs: OWN }), { ok: true });
  const ownBoxMarks = await readOwnBoxMarks(db);
  const marks = { ownBoxMarks };
  assert.equal(whereItRuns("second-box/m1", { providers, ownAddrs: OWN, ...marks }), "other_box");
  assert.equal(isCloudKey("second-box/m1", { providers, ownAddrs: OWN, ...marks }), false, "unchanged: marks are not read here");
  assert.equal(isStrictCloud("second-box/m1", { providers, ownAddrs: OWN, ...marks }), true, "unchanged: still not usable for voice");
  assert.equal(privacyRank(whereItRuns("second-box/m1", { providers, ownAddrs: OWN, ...marks })), 1);
  assert.equal(sessionSourceRank("other_box"), 1);
});

test("an unmarked row is unchanged: a host cloud row still reads cloud", async () => {
  const { db } = await seeded();
  const providers = await providersOf(db);
  const ownBoxMarks = {};
  assert.equal(whereItRuns("second-box/m1", { providers, ownAddrs: OWN, ownBoxMarks }), "cloud");
  assert.equal(whereItRuns("named-box/m4", { providers, ownAddrs: OWN, ownBoxMarks }), "cloud");
  assert.equal(whereItRuns("public-box/m3", { providers, ownAddrs: OWN, ownBoxMarks }), "cloud");
  assert.deepEqual(await readOwnBoxMarks(db), {});
});

test("refusals: a public address, a known cloud preset, this box itself", async () => {
  const { db } = await seeded();
  assert.deepEqual(await markOwnBox(db, "public-box", { actor: "t", ownAddrs: OWN }), { ok: false, reason: "public_address" });
  assert.deepEqual(await markOwnBox(db, "zai-x", { actor: "t", ownAddrs: OWN }), { ok: false, reason: "known_cloud" });
  assert.deepEqual(await markOwnBox(db, "here-box", { actor: "t", ownAddrs: OWN }), { ok: false, reason: "here" });
  await ins(db, "loop-box", "http://127.0.0.1:8030/v1", "cloud", ["m5"]);
  assert.deepEqual(await markOwnBox(db, "loop-box", { actor: "t", ownAddrs: OWN }), { ok: false, reason: "here" });
  assert.deepEqual(await markOwnBox(db, "nope", { actor: "t", ownAddrs: OWN }), { ok: false, reason: "not_found" });
  assert.deepEqual(await readOwnBoxMarks(db), {});
});

test("a DNS name is markable, and a lapsed mark stops counting when the hostname changes", async () => {
  const { db } = await seeded();
  assert.deepEqual(await markOwnBox(db, "named-box", { actor: "t", ownAddrs: OWN }), { ok: true });
  let providers = await providersOf(db);
  let ownBoxMarks = await readOwnBoxMarks(db);
  assert.equal(whereItRuns("named-box/m4", { providers, ownAddrs: OWN, ownBoxMarks }), "other_box");
  assert.equal(isOwnBoxMarkCurrent(providers.find((p) => p.id === "named-box"), ownBoxMarks), true);
  // A peer rewrites the base URL through sync: the mark lapses by itself.
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["http://elsewhere.example.internal:8011/v1", "named-box"] });
  providers = await providersOf(db);
  ownBoxMarks = await readOwnBoxMarks(db);
  assert.equal(isOwnBoxMarkCurrent(providers.find((p) => p.id === "named-box"), ownBoxMarks), false);
  assert.equal(whereItRuns("named-box/m4", { providers, ownAddrs: OWN, ownBoxMarks }), "cloud", "back to the stored host rule");
  // Unmarking removes it.
  await unmarkOwnBox(db, "named-box");
  assert.deepEqual(await readOwnBoxMarks(db), {});
});

test("a stale page token is refused as changed", async () => {
  const { db } = await seeded();
  const salt = await ensureCloudConsentSalt(db);
  const row = (await providersOf(db)).find((p) => p.id === "second-box");
  const token = ownBoxMarkTokenFor(row, salt);
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["http://10.0.0.11:8011/v1", "second-box"] });
  assert.deepEqual(await markOwnBox(db, "second-box", { actor: "t", expect: { token }, ownAddrs: OWN }), { ok: false, reason: "changed" });
  assert.deepEqual(await markOwnBox(db, "second-box", { actor: "t", expect: { token: "" }, ownAddrs: OWN }), { ok: false, reason: "changed" });
  assert.deepEqual(await readOwnBoxMarks(db), {});
  const now = (await providersOf(db)).find((p) => p.id === "second-box");
  assert.deepEqual(await markOwnBox(db, "second-box", { actor: "t", expect: { token: ownBoxMarkTokenFor(now, salt) }, ownAddrs: OWN }), { ok: true });
  assert.equal((await readOwnBoxMarks(db))["second-box"].host, "10.0.0.11");
});

test("the two marks are independent: an own-box mark never ticks This is local", async () => {
  const { db } = await seeded();
  await ins(db, "dns-local", "http://dns.example.internal:8011/v1", "local", ["m6"]);
  assert.deepEqual(await markOwnBox(db, "dns-local", { actor: "t", ownAddrs: OWN }), { ok: true });
  assert.deepEqual(await readLocalMarks(db), {}, "no local mark was written");
  const providers = await providersOf(db);
  const localMarks = await readLocalMarks(db);
  assert.equal(isStrictCloud("dns-local/m6", { providers, localMarks, ownAddrs: OWN }), true, "voice still refuses it");
  assert.equal(whereItRuns("dns-local/m6", { providers, localMarks, ownAddrs: OWN }), "unproven", "and it stays unproven for the chip");
  // Both boxes can be ticked on one row, and they mean different things.
  assert.deepEqual(await markLocal(db, "dns-local", { actor: "t" }), { ok: true });
  assert.deepEqual(await markOwnBox(db, "dns-local", { actor: "t", ownAddrs: OWN }), { ok: true });
  const both = { localMarks: await readLocalMarks(db), ownBoxMarks: await readOwnBoxMarks(db) };
  assert.equal(Object.keys(both.localMarks).length, 1);
  assert.equal(Object.keys(both.ownBoxMarks).length, 1);
  assert.equal(isStrictCloud("dns-local/m6", { providers, ownAddrs: OWN, ...both }), false, "This is local is what relaxes voice");
  assert.equal(whereItRuns("dns-local/m6", { providers, ownAddrs: OWN, ...both }), "other_box");
  await unmarkOwnBox(db, "dns-local");
  assert.equal(isStrictCloud("dns-local/m6", { providers, ownAddrs: OWN, localMarks: both.localMarks, ownBoxMarks: {} }), false, "the local mark is untouched");
});

test("isOwnBoxMarkableRow: eligible only for a LAN/tailnet literal or a DNS name that is not this box", async () => {
  const { db } = await seeded();
  const byId = Object.fromEntries((await providersOf(db)).map((p) => [p.id, p]));
  assert.equal(isOwnBoxMarkableRow(byId["second-box"], { ownAddrs: OWN }), true, "private literal, stored host cloud");
  assert.equal(isOwnBoxMarkableRow(byId["named-box"], { ownAddrs: OWN }), true, "a DNS name");
  assert.equal(isOwnBoxMarkableRow({ id: "pub-dns", baseUrl: "https://api.example.com/v1" }, { ownAddrs: OWN }), false, "a public DNS name is not offered");
  assert.equal(isOwnBoxMarkableRow({ id: "dotless", baseUrl: "http://otherbox:8011/v1" }, { ownAddrs: OWN }), true, "a dotless LAN name");
  assert.equal(isOwnBoxMarkableRow(byId["here-box"], { ownAddrs: OWN }), false, "this box's own address");
  assert.equal(isOwnBoxMarkableRow(byId["public-box"], { ownAddrs: OWN }), false, "a public address");
  assert.equal(isOwnBoxMarkableRow(byId["zai-x"], { ownAddrs: OWN }), false, "a known cloud preset");
  assert.equal(isOwnBoxMarkableRow({ ...byId["second-box"], disabled: true }, { ownAddrs: OWN }), false, "disabled");
});

test("a mark write invalidates the role context and fires the marks listeners", async () => {
  const { db } = await seeded();
  const before = await loadRoleContext(db);
  assert.deepEqual(before.ownBoxMarks, {});
  const seen = [];
  const off = addLocalMarksChangeListener((id) => seen.push(id));
  try {
    assert.deepEqual(await markOwnBox(db, "second-box", { actor: "t", ownAddrs: OWN }), { ok: true });
    const after = await loadRoleContext(db);
    assert.ok(after.ownBoxMarks["second-box"], "the cached context was dropped and carries the mark");
    assert.deepEqual(after.localMarks, {}, "and no This is local mark appeared");
    await unmarkOwnBox(db, "second-box");
    await unmarkOwnBox(db, "second-box"); // nothing to remove: no event
    assert.deepEqual(seen, ["second-box", "second-box"]);
    assert.deepEqual((await loadRoleContext(db)).ownBoxMarks, {});
  } finally { off(); }
});

test("session summary: a marked row's session ranks as another box (1), not the cloud (2)", async () => {
  const { db, dir } = await seeded();
  await setBinding(db, "quick", { model: "here-box/m2" }, { actor: "t" });
  invalidateRoleContext();
  const providers = await providersOf(db);
  assert.equal(whereItRuns("second-box/m1", { providers, ownAddrs: OWN }), "cloud", "unmarked: the cloud");
  await markOwnBox(db, "second-box", { actor: "t", ownAddrs: OWN });

  const transcripts = join(dir, "transcripts");
  mkdirSync(transcripts, { recursive: true });
  const file = join(transcripts, "session.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "pisess-own-box" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Please rename the report files." }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Renamed four report files." }] } }),
  ].join("\n") + "\n");
  const threadId = "perch-own-box";
  await db.execute({
    sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind, status, pi_session_id, pi_session_dir, model) VALUES (?,?,?,?,?,?,?,?)",
    args: ["botty", "perch", threadId, "perch-live", "waiting-user", "pisess-own-box", transcripts, "second-box/m1"],
  });
  // No `where` dep: the job's own defaultWhere reads the role context (and its marks).
  const r = await summarizeSession(db, { threadId, sessionModelKey: "second-box/m1", transcriptPath: file, tainted: false }, {
    env: { CROW_SESSION_SUMMARIES: "1" },
    now: () => Date.parse("2026-10-29T12:00:00Z"),
    complete: async () => "SUMMARY: The operator asked the bot to rename the report files.\nTITLE: Renaming files",
    instanceId: "0123456789abcdef0123456789abcdef",
    syncManager: null,
    log: () => {},
  });
  assert.equal(r.written, true, JSON.stringify(r));
  const row = (await db.execute({ sql: "SELECT summary_flags FROM bot_sessions WHERE gateway_thread_id = ?", args: [threadId] })).rows[0];
  assert.equal(JSON.parse(row.summary_flags).source_rank, 1, "ranked as another of the operator's boxes");
  const tags = (await db.execute({ sql: "SELECT tags FROM memories WHERE source LIKE 'session-summary:%'", args: [] })).rows[0];
  assert.match(String(tags.tags), /source-rank-1/);
});

test("providers tab: the switch shows for an eligible row only, and the action round-trips", async () => {
  const { db } = await seeded();
  await ins(db, "both-box", "http://both.example.internal:8011/v1", "local", ["m6"]);
  await ins(db, "loop-box", "http://127.0.0.1:8030/v1", "local", ["m7"]);
  invalidateRoleContext();
  const render = (query = {}, lang = "en") => tab.render({ req: { query }, db, lang, piAgentDir: null, tasksDbPaths: [] });
  const html = await render();
  const label = t("providers.isOwnBox", "en");
  assert.notEqual(t("providers.isOwnBox", "es"), label);
  const formFor = (id) => {
    const re = new RegExp(`<form[^>]*class="[^"]*llm-own-box[^"]*"[^>]*>(?:(?!</form>)[\\s\\S])*name="id" value="${id}"(?:(?!</form>)[\\s\\S])*</form>`);
    return html.match(re)?.[0] || null;
  };
  const f = formFor("named-box");
  assert.ok(f, "a checkbox form for the DNS-named row on the other box");
  assert.match(f, /value="llm_provider_mark_own_box"/);
  assert.match(f, /role="checkbox" aria-checked="false"/);
  assert.ok(f.includes(label));
  assert.match(f, /name="own_box_token" value="[0-9a-f]{32}"/);
  // The private-literal row is eligible wherever this box's addresses are
  // pinned by a caller; the render path probes THIS machine, so only names and
  // literals that are never ours are asserted here.
  // Not eligible: a public address, a known cloud preset, this box's loopback.
  assert.equal(formFor("public-box"), null, "no switch on a public address");
  assert.equal(formFor("zai-x"), null, "no switch on a known cloud preset");
  assert.equal(formFor("loop-box"), null, "no switch on this box");
  // One row can carry both checkboxes.
  const both = html.split("<tr").find((r) => r.includes(">both-box<"));
  assert.match(both, /llm_provider_mark_local/);
  assert.match(both, /llm_provider_mark_own_box/);
  assert.ok((await render({}, "es")).includes(t("providers.isOwnBox", "es")));

  const token = f.match(/name="own_box_token" value="([0-9a-f]{32})"/)[1];
  let redirected = null;
  const res = { redirectAfterPost: (u) => { redirected = u; }, status() { return this; }, type() { return this; }, send() {} };
  const handled = await tab.handleAction({
    req: { body: { action: "llm_provider_mark_own_box", id: "named-box", own_box_token: token } },
    res, db, action: "llm_provider_mark_own_box",
  });
  assert.equal(handled, true);
  assert.match(redirected, /section=llm&tab=providers/);
  assert.equal((await readOwnBoxMarks(db))["named-box"].host, "second.example.internal");
  assert.deepEqual(await readLocalMarks(db), {}, "the other checkbox was not ticked");

  const html2 = await render();
  assert.match(html2, /value="llm_provider_unmark_own_box"[\s\S]*?name="id" value="named-box"[\s\S]*?aria-checked="true"/);
  await tab.handleAction({ req: { body: { action: "llm_provider_unmark_own_box", id: "named-box" } }, res, db, action: "llm_provider_unmark_own_box" });
  assert.deepEqual(await readOwnBoxMarks(db), {});

  // A stale token: refused, redirected with the "changed" note, nothing marked.
  await tab.handleAction({
    req: { body: { action: "llm_provider_mark_own_box", id: "named-box", own_box_token: "0".repeat(32) } },
    res, db, action: "llm_provider_mark_own_box",
  });
  assert.match(redirected, /ownbox=changed/);
  assert.deepEqual(await readOwnBoxMarks(db), {});
});

test("providers tab: a refused mark redirects with its reason and shows its line", async () => {
  const { db } = await seeded();
  let redirected = null;
  const res = { redirectAfterPost: (u) => { redirected = u; } };
  await tab.handleAction({
    req: { body: { action: "llm_provider_mark_own_box", id: "public-box", own_box_token: "0".repeat(32) } },
    res, db, action: "llm_provider_mark_own_box",
  });
  assert.match(redirected, /ownbox=public_address$/);
  for (const reason of ["public_address", "known_cloud", "here"]) {
    const html = await tab.render({ req: { query: { ownbox: reason } }, db, lang: "es", piAgentDir: null, tasksDbPaths: [] });
    assert.ok(html.includes(t(`providers.ownBoxRefused.${reason}`, "es")), reason);
    assert.notEqual(t(`providers.ownBoxRefused.${reason}`, "es"), t(`providers.ownBoxRefused.${reason}`, "en"));
  }
  const plain = await tab.render({ req: { query: { ownbox: "<script>" } }, db, lang: "en", piAgentDir: null, tasksDbPaths: [] });
  assert.equal(plain.includes("<script>"), false);
});

test("a cloud relay in front of a marked row keeps the key on the cloud", () => {
  const OWN2 = new Set(["10.0.0.5"]);
  const providers = [
    { id: "relay", baseUrl: "https://relay.example.com/v1", host: "cloud", models: [{ id: "m" }] },
    { id: "box", baseUrl: "http://10.0.0.9:8011/v1", host: "cloud", models: [{ id: "m" }] },
  ];
  const marks = { box: { host: "10.0.0.9" } };
  // A door walk relay -> box: the relay is a public-name hop that still carries the traffic.
  const resolveDoor = (row, rows) => (row.id === "relay" ? rows.find((r) => r.id === "box") : row);
  assert.equal(whereItRuns("relay/m", { providers, ownAddrs: OWN2, resolveDoor, ownBoxMarks: marks }), "cloud");
  // Asked directly, the marked box itself is the other box.
  assert.equal(whereItRuns("box/m", { providers, ownAddrs: OWN2, resolveDoor, ownBoxMarks: marks }), "other_box");
});

test("host.docker.internal is this box, never the other box", () => {
  assert.equal(isOwnBoxMarkableRow({ id: "dock", baseUrl: "http://host.docker.internal:8011/v1" }, { ownAddrs: OWN }), false);
});

test("a This-is-local token never marks the other box", async () => {
  assert.notEqual(localMarkTokenFor({ id: "x", baseUrl: "http://10.0.0.9/v1" }, "ab".repeat(16)), ownBoxMarkTokenFor({ id: "x", baseUrl: "http://10.0.0.9/v1" }, "ab".repeat(16)));
});
