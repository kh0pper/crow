// tests/onboarding-meet.test.js
//
// C1/C3 Task 8 (PR C-B) — the "Meet your Crow" wizard step + completion flow.
// The meet step seeds the starter agent/conversation (Tasks 2-3) and hands
// the user straight into their first chat (`/dashboard/messages?ai=<id>`,
// Task 6's deep-link). Mirrors tests/onboarding-ai-step.test.js's seam
// pattern (spy modules injected into the exported POST handler) and
// tests/onboarding.test.js's completion-stamp test (first-write-only guard).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";

import onboardingPanel, { STEP_KEYS, handleMeetPost } from "../servers/gateway/dashboard/panels/onboarding.js";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

const MEET_IDX = STEP_KEYS.indexOf("meet");
const AI_IDX = STEP_KEYS.indexOf("ai");

// Same seam as tests/onboarding-steps.test.js: drive the panel handler with a stub layout.
// `resolveStarterProviderFn` mirrors handleMeetPost's seam pattern (Task 8
// review fix round 1) — the meet step's render gate no longer derives from
// providersCount, so these render tests inject the resolve seam directly
// instead of a providers-COUNT db stub.
async function render(query = {}, { db, resolveStarterProviderFn } = {}) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query, headers: {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en", db, resolveStarterProviderFn });
  return typeof out === "string" ? out : captured;
}

// Minimal db stub: answers the providers COUNT query with `n`, everything else empty.
// Still used by the done-step tests (dormant callout still gates on
// providersCount, unaffected by the meet-step fix).
function providersDb(n) {
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      if (/COUNT\(\*\)/i.test(sql) && /providers/i.test(sql)) {
        return { rows: [{ n }] };
      }
      return { rows: [] };
    },
  };
}

// A usable / unusable starterProvider resolution, for the meet step's render
// gate.
const usableProvider = async () => ({ providerId: "p", modelId: "m" });
const noProvider = async () => null;

function makeRes() {
  return {
    headers: {}, redirected: null, body: null, status_: null, contentType: null,
    setHeader(k, v) { this.headers[k] = v; },
    redirectAfterPost(url) { this.redirected = url; },
    status(code) { this.status_ = code; return this; },
    type(t) { this.contentType = t; return this; },
    send(b) { this.body = b; return this; },
  };
}
function makePostReq(body) {
  return { method: "POST", headers: {}, query: {}, body };
}

// ── SSR: meet step render ───────────────────────────────────────────────────

test("meet step with a usable starter provider renders the meet form (csrf + cta), no empty-state callout", async () => {
  const html = await render({ step: String(MEET_IDX) }, { db: {}, resolveStarterProviderFn: usableProvider });
  assert.ok(html.includes('action="/dashboard/onboarding/meet"'), "posts to the meet endpoint");
  assert.ok(html.includes('method="POST"'), "form is a POST");
  assert.ok(html.includes('data-turbo="false"'), "meet form opts out of Turbo for full-page reload (R2-M2)");
  assert.ok(html.includes('name="_csrf"'), "csrf input present");
  assert.ok(html.includes(i18n.t("onboarding.meet.cta", "en")), "cta button label rendered");
  assert.ok(!html.includes(i18n.t("onboarding.meet.noProvider", "en")), "no empty-state note when a usable provider exists");
});

test("meet step with no usable starter provider shows the honest empty-state callout and hides the form", async () => {
  const html = await render({ step: String(MEET_IDX) }, { db: {}, resolveStarterProviderFn: noProvider });
  assert.ok(html.includes(i18n.t("onboarding.meet.noProvider", "en")), "empty-state note present");
  assert.ok(!html.includes('action="/dashboard/onboarding/meet"'), "no form posted when there is no usable provider");
  assert.ok(html.includes(`/dashboard/onboarding?step=${AI_IDX}`), "links back to the ai step");
});

// Review fix round 1 (Task 8): a providers row that is enabled but has an
// empty models[] (e.g. a no_auto_provider placeholder) used to make
// providersCount positive and render the live CTA even though
// resolveStarterProvider() would find nothing usable — the POST would then
// bounce err=no_provider after a wasted seed write. Gating on
// ctx.starterProvider instead means this exact shape now renders the empty
// state, not the form.
test("meet step with an enabled-but-unusable provider (empty models[]) shows the empty state, not a doomed form", async () => {
  const html = await render({ step: String(MEET_IDX) }, { db: {}, resolveStarterProviderFn: noProvider });
  assert.ok(!html.includes('action="/dashboard/onboarding/meet"'), "no form when providers exist but none are usable");
  assert.ok(html.includes(i18n.t("onboarding.meet.noProvider", "en")), "honest empty-state callout instead");
});

// Review fix round 1 (Task 8): resolveStarterProvider() throwing must render
// the SAME honest empty state, not crash the wizard.
test("meet step renders the empty state (not a crash) when resolveStarterProvider throws", async () => {
  const html = await render({ step: String(MEET_IDX) }, {
    db: {},
    resolveStarterProviderFn: async () => { throw new Error("db exploded"); },
  });
  assert.ok(html.includes(i18n.t("onboarding.meet.noProvider", "en")), "empty-state note present on a resolve throw");
  assert.ok(!html.includes('action="/dashboard/onboarding/meet"'), "no form posted when resolve threw");
});

test("meet step form disables its submit button on submit (double-submit guard, no separate script)", async () => {
  const html = await render({ step: String(MEET_IDX) }, { db: {}, resolveStarterProviderFn: usableProvider });
  assert.match(html, /<form method="POST" action="\/dashboard\/onboarding\/meet"[^>]*onsubmit="[^"]*disabled[^"]*"/);
});

test("meet step with ?err=no_provider shows the error callout", async () => {
  const html = await render({ step: String(MEET_IDX), err: "no_provider" }, { db: {}, resolveStarterProviderFn: usableProvider });
  assert.ok(html.includes(i18n.t("onboarding.meet.err", "en")), "error callout rendered");
});

// Review fix round 1 (Task 8): the new setup_failed code (catch-all in
// handleMeetPost) gets its own generic, honest callout — distinct from the
// no_provider-specific message.
test("meet step with ?err=setup_failed shows the generic error callout", async () => {
  const html = await render({ step: String(MEET_IDX), err: "setup_failed" }, { db: {}, resolveStarterProviderFn: usableProvider });
  assert.ok(html.includes(i18n.t("onboarding.meet.errGeneric", "en")), "generic error callout rendered");
  assert.ok(!html.includes(i18n.t("onboarding.meet.err", "en")), "does not render the no_provider-specific message");
});

test("meet step with an unrecognized ?err code renders no error callout (closed enum)", async () => {
  const html = await render({ step: String(MEET_IDX), err: "totally-made-up" }, { db: {}, resolveStarterProviderFn: usableProvider });
  assert.ok(!html.includes(i18n.t("onboarding.meet.err", "en")), "no no_provider callout for an unknown code");
  assert.ok(!html.includes(i18n.t("onboarding.meet.errGeneric", "en")), "no generic callout for an unknown code");
});

test("meet step without ?err shows no error callout", async () => {
  const html = await render({ step: String(MEET_IDX) }, { db: {}, resolveStarterProviderFn: usableProvider });
  assert.ok(!html.includes(i18n.t("onboarding.meet.err", "en")), "no error callout by default");
  assert.ok(!html.includes(i18n.t("onboarding.meet.errGeneric", "en")), "no generic error callout by default");
});

// ── done step: dormant-features callout ─────────────────────────────────────

test("done step shows the dormant-features callout when providersCount is 0", async () => {
  const html = await render({ step: String(STEP_KEYS.indexOf("done")) }, { db: providersDb(0) });
  assert.ok(html.includes(i18n.t("onboarding.doneDormant", "en")), "dormant callout rendered");
});

test("done step omits the dormant-features callout when a provider is configured", async () => {
  const html = await render({ step: String(STEP_KEYS.indexOf("done")) }, { db: providersDb(3) });
  assert.ok(!html.includes(i18n.t("onboarding.doneDormant", "en")), "no dormant callout when providers exist");
});

// ── i18n ─────────────────────────────────────────────────────────────────────

test("new onboarding.meet.* + onboarding.doneDormant keys resolve in en AND es", () => {
  const KEYS = [
    "onboarding.meet.title", "onboarding.meet.body", "onboarding.meet.cta",
    "onboarding.meet.noProvider", "onboarding.meet.err", "onboarding.meet.errGeneric",
    "onboarding.doneDormant",
  ];
  for (const k of KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});

// ── POST handler (handleMeetPost) — spy-module seams ────────────────────────

test("meet POST: seeds starter memories + artifacts once, redirects to /dashboard/messages?ai=<id>", async () => {
  const seedCalls = [];
  const artifactCalls = [];
  const res = makeRes();
  await handleMeetPost(makePostReq({}), res, {
    db: {},
    seedStarterMemoriesFn: async (db, lang) => { seedCalls.push(lang); return { inserted: 5, skipped: false }; },
    createStarterArtifactsFn: async (db, opts) => {
      artifactCalls.push(opts);
      return { conversationId: 42, botId: "crow-starter", providerId: "p", modelId: "m" };
    },
  });
  assert.equal(seedCalls.length, 1, "seedStarterMemories called exactly once");
  assert.equal(artifactCalls.length, 1, "createStarterArtifacts called exactly once");
  assert.ok(res.redirected, "redirects (no raw send)");
  assert.match(res.redirected, /^\/dashboard\/messages\?ai=\d+$/, "redirects to the new AI conversation");
  assert.equal(res.redirected, "/dashboard/messages?ai=42");
});

test("meet POST: no_provider result redirects back to the meet step with err=no_provider, never touches the completion flag", async () => {
  const res = makeRes();
  const dbCalls = [];
  const db = {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      dbCalls.push(sql);
      return { rows: [] };
    },
  };
  await handleMeetPost(makePostReq({}), res, {
    db,
    seedStarterMemoriesFn: async () => ({ inserted: 0, skipped: true }),
    createStarterArtifactsFn: async () => ({ error: "no_provider" }),
  });
  assert.equal(res.status_, null, "no bare status set — a redirect, not a page-replacing error response");
  assert.ok(res.redirected, "redirects back to the wizard instead of dead-ending");
  assert.ok(res.redirected.includes(`step=${MEET_IDX}`), "redirects to the meet step");
  assert.ok(res.redirected.includes("err=no_provider"), "carries the no_provider error code");
  assert.ok(!dbCalls.some((s) => /INSERT|UPDATE|REPLACE/i.test(s)), "no completion stamp written on failure");
});

// Review fix round 1 (Task 8): a catch-all exception must NOT be labeled
// no_provider (a specific-but-possibly-false claim) — it gets the distinct
// setup_failed code instead.
test("meet POST: unexpected exception (seedStarterMemories throws) redirects with err=setup_failed, never no_provider, never throws, never logs secrets", async () => {
  const res = makeRes();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    await handleMeetPost(makePostReq({}), res, {
      db: {},
      seedStarterMemoriesFn: async () => { throw new Error("db exploded"); },
      createStarterArtifactsFn: async () => { throw new Error("unreached"); },
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(res.redirected, "redirects back to the wizard instead of dead-ending / throwing");
  assert.ok(res.redirected.includes(`step=${MEET_IDX}`), "redirects to the meet step");
  assert.ok(res.redirected.includes("err=setup_failed"), "carries the generic setup_failed code");
  assert.ok(!res.redirected.includes("err=no_provider"), "does NOT mislabel an arbitrary exception as no_provider");
});

test("meet POST: unexpected exception (createStarterArtifacts throws) redirects with err=setup_failed", async () => {
  const res = makeRes();
  const originalError = console.error;
  console.error = () => {};
  try {
    await handleMeetPost(makePostReq({}), res, {
      db: {},
      seedStarterMemoriesFn: async () => ({ inserted: 5, skipped: false }),
      createStarterArtifactsFn: async () => { throw new Error("something else entirely"); },
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(res.redirected, "redirects back to the wizard instead of dead-ending / throwing");
  assert.ok(res.redirected.includes(`step=${MEET_IDX}`), "redirects to the meet step");
  assert.ok(res.redirected.includes("err=setup_failed"), "carries the generic setup_failed code");
  assert.ok(!res.redirected.includes("err=no_provider"), "does NOT mislabel an arbitrary exception as no_provider");
});

test("meet POST: stamps onboarding_completed_at on success, first-write-only", async () => {
  const calls = [];
  const mkDb = (existingValue) => ({
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      calls.push(sql);
      if (/SELECT/i.test(sql) && /onboarding_completed_at|dashboard_settings/i.test(sql)) {
        return { rows: existingValue ? [{ value: existingValue }] : [] };
      }
      return { rows: [] };
    },
  });

  calls.length = 0;
  await handleMeetPost(makePostReq({}), makeRes(), {
    db: mkDb(null),
    seedStarterMemoriesFn: async () => ({ inserted: 5, skipped: false }),
    createStarterArtifactsFn: async () => ({ conversationId: 7, botId: "crow-starter", providerId: "p", modelId: "m" }),
  });
  assert.ok(calls.some((s) => /INSERT|UPDATE|REPLACE/i.test(s)), "first successful meet POST stamps completion");

  calls.length = 0;
  await handleMeetPost(makePostReq({}), makeRes(), {
    db: mkDb("2026-07-19T00:00:00Z"),
    seedStarterMemoriesFn: async () => ({ inserted: 0, skipped: true }),
    createStarterArtifactsFn: async () => ({ conversationId: 7, botId: "crow-starter", providerId: "p", modelId: "m" }),
  });
  assert.ok(!calls.some((s) => /INSERT|UPDATE|REPLACE/i.test(s)), "second successful meet POST does not rewrite the flag");
});

// ── POST handler — real db, real starter-content module (Task 3 idempotency) ─

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeScratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-onboarding-meet-test-"));
  dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  return createDbClient(join(dir, "crow.db"));
}

async function insertProvider(db, { id, models }) {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: [id, "http://127.0.0.1:9/v1", JSON.stringify(models)],
  });
}

test("meet POST is idempotent end-to-end: a second POST does not create a duplicate bot/conversation/memories", async () => {
  const db = makeScratchDb();
  await insertProvider(db, { id: "test-provider", models: [{ id: "test-model" }] });

  const res1 = makeRes();
  await handleMeetPost(makePostReq({}), res1, { db });
  assert.ok(res1.redirected, "first POST redirects");
  const firstConvId = res1.redirected.match(/ai=(\d+)/)[1];

  const { rows: memRows1 } = await db.execute({ sql: "SELECT COUNT(*) n FROM memories WHERE source='starter'", args: [] });
  const { rows: botRows1 } = await db.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs WHERE bot_id='crow-starter'", args: [] });
  const { rows: convRows1 } = await db.execute({ sql: "SELECT COUNT(*) n FROM chat_conversations", args: [] });

  const res2 = makeRes();
  await handleMeetPost(makePostReq({}), res2, { db });
  assert.equal(res2.redirected, `/dashboard/messages?ai=${firstConvId}`, "second POST redirects to the SAME conversation");

  const { rows: memRows2 } = await db.execute({ sql: "SELECT COUNT(*) n FROM memories WHERE source='starter'", args: [] });
  const { rows: botRows2 } = await db.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs WHERE bot_id='crow-starter'", args: [] });
  const { rows: convRows2 } = await db.execute({ sql: "SELECT COUNT(*) n FROM chat_conversations", args: [] });

  assert.equal(Number(memRows2[0].n), Number(memRows1[0].n), "no duplicate starter memories");
  assert.equal(Number(botRows2[0].n), Number(botRows1[0].n), "no duplicate starter bot");
  assert.equal(Number(convRows2[0].n), Number(convRows1[0].n), "no duplicate starter conversation");
});

test("meet POST end-to-end with no provider registered: redirects back with err=no_provider, seeds nothing lasting", async () => {
  const db = makeScratchDb();
  const res = makeRes();
  await handleMeetPost(makePostReq({}), res, { db });
  assert.ok(res.redirected.includes(`step=${MEET_IDX}`));
  assert.ok(res.redirected.includes("err=no_provider"));
  const { rows: botRows } = await db.execute({ sql: "SELECT COUNT(*) n FROM pi_bot_defs WHERE bot_id='crow-starter'", args: [] });
  assert.equal(Number(botRows[0].n), 0, "no starter bot created when there's no provider");
});
