// The bell for a FAILED "Bots can't read Crow's identity file" check
// (servers/gateway/boot/bot-identity-notice.js, item-70 channel 3).
//
// A journal line is not where an operator looks, so a failing boot check raises
// one notification through the same createNotification path the other instance
// security signals use. These tests pin the shape (source, priority, link), the
// words (the invariant, the findings, the restart step), the dedupe (the same
// finding rings once, and rings again after the cooldown), and the two silences:
// no enabled bots rings nothing, and a host-tier finding carries no restart step.
// Everything is stubbed: no database, no notification fan-out, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NOTICE_ACTION_URL, NOTICE_BODY_KEY, NOTICE_CHECK_FAILED_BODY_KEY, NOTICE_CHECK_FAILED_TITLE_KEY,
  NOTICE_COOLDOWN_MS, NOTICE_SOURCE, NOTICE_TITLE_KEY,
  botIdentitySignature, notifyBotIdentityFailure,
} from "../servers/gateway/boot/bot-identity-notice.js";
import { BOT_IDENTITY_TEXT, NO_BOTS_NOTE, RESTART_HOSTS_HINT } from "../scripts/pi-bots/bot-identity-guard.mjs";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const FAIL = {
  ok: false,
  text: BOT_IDENTITY_TEXT,
  findings: ["helper: the default tier would leave /home/u/.crow/data/identity.json readable"],
  notes: [],
};
const OTHER_FAIL = {
  ok: false,
  findings: ["CROW_PI_SANDBOX=off: bot spawns run in no sandbox, so /home/u/.crow/data/identity.json is readable"],
  notes: [],
};
/** A HOST-TIER failure: no bot's plan is involved, so no restart step applies. */
const TIER_FAIL = {
  ok: false,
  findings: ["bubblewrap is unavailable here (not installed), so the setpriv fallback applies no masks and /x/identity.json is readable"],
  tierFindings: ["bubblewrap is unavailable here (not installed), so the setpriv fallback applies no masks and /x/identity.json is readable"],
  notes: [],
};
/**
 * A check that could NOT RUN (the bug this pins): a path option that is not a
 * path, or an internal failure. Nothing was measured, so the bell must say the
 * CHECK failed — never that the file is exposed.
 */
const COULD_NOT_RUN = {
  ok: false,
  couldNotRun: true,
  findings: ["the check could not run: appRoot must be a string (got function)"],
  tierFindings: ["the check could not run: appRoot must be a string (got function)"],
  notes: [],
};

/** A db stub: the newest bot-identity row + the dashboard language. */
function makeDb({ last = null, language = "en" } = {}) {
  const calls = [];
  return {
    calls,
    async execute({ sql, args }) {
      calls.push({ sql, args });
      if (/FROM notifications WHERE source/.test(sql)) return { rows: last ? [last] : [] };
      if (/FROM dashboard_settings/.test(sql)) return { rows: [{ value: language }] };
      if (/INSERT INTO notifications/.test(sql)) return { lastInsertRowid: 1 };
      return { rows: [] };
    },
  };
}

function collector() {
  const sent = [];
  const notify = async (db, opts) => { sent.push(opts); return { id: sent.length, delivery: opts }; };
  return { sent, notify };
}

test("a PASS raises nothing at all", async () => {
  const { sent, notify } = collector();
  const r = await notifyBotIdentityFailure({ db: makeDb(), notify, result: { ok: true } });
  assert.deepEqual(r, { sent: false, reason: "pass" });
  assert.equal(sent.length, 0);
});

test("a FAIL raises one high-priority bell: the invariant, the findings and the restart step", async () => {
  const { sent, notify } = collector();
  const r = await notifyBotIdentityFailure({ db: makeDb(), notify, result: FAIL, lang: "en" });
  assert.deepEqual(r, { sent: true, reason: "sent" });
  assert.equal(sent.length, 1);
  const n = sent[0];
  assert.equal(n.type, "system");
  assert.equal(n.source, NOTICE_SOURCE);
  assert.equal(n.priority, "high");
  assert.equal(n.action_url, NOTICE_ACTION_URL);
  assert.equal(n.title, t(NOTICE_TITLE_KEY, "en"));
  assert.ok(n.body.includes(t(NOTICE_BODY_KEY, "en")), "the approved frame");
  assert.ok(n.body.includes(FAIL.findings[0]), "the finding, verbatim");
  assert.ok(n.body.includes(RESTART_HOSTS_HINT), "and the step a separate bot host must take");
  assert.ok(n.body.includes("pibot-gateways@*"));
  assert.equal(n.metadata.kind, "bot-identity");
  assert.equal(n.metadata.signature, botIdentitySignature(FAIL));
  assert.equal(n.metadata.invariant, BOT_IDENTITY_TEXT);
  // The body never carries an identity file's content.
  assert.ok(!/a{64}/.test(n.body), "no seed-shaped content");
});

test("no enabled bots: nothing rings, not even for a host tier that cannot mask", async () => {
  const { sent, notify } = collector();
  // The guard's own answer for a host with no enabled bots.
  const guardResult = { ok: true, text: BOT_IDENTITY_TEXT, findings: [], tierFindings: [], notes: [NO_BOTS_NOTE], checked: 0, noBots: true };
  assert.deepEqual(await notifyBotIdentityFailure({ db: makeDb(), notify, result: guardResult }), { sent: false, reason: "pass" });
  // And the notice's own rule, so a result that came back not-ok with no bots
  // still cannot ring a high-priority bell (the false alarm this pins).
  const noBotsFail = { ...TIER_FAIL, noBots: true };
  assert.deepEqual(await notifyBotIdentityFailure({ db: makeDb(), notify, result: noBotsFail }), { sent: false, reason: "no-bots" });
  assert.equal(sent.length, 0);
});

test("a check that could NOT run rings, and says the CHECK failed — never that the file is exposed", async () => {
  const { sent, notify } = collector();
  const r = await notifyBotIdentityFailure({ db: makeDb(), notify, result: COULD_NOT_RUN, lang: "en" });
  assert.deepEqual(r, { sent: true, reason: "sent" }, "a check that cannot answer is not a pass");
  const n = sent[0];
  assert.equal(n.title, t(NOTICE_CHECK_FAILED_TITLE_KEY, "en"));
  assert.notEqual(n.title, t(NOTICE_TITLE_KEY, "en"), "not the 'bots can read it' title");
  assert.ok(n.body.includes(t(NOTICE_CHECK_FAILED_BODY_KEY, "en")), "the check-failed frame");
  assert.ok(!n.body.includes(t(NOTICE_BODY_KEY, "en")), "not the exposure frame: " + n.body);
  assert.ok(n.body.includes("appRoot must be a string (got function)"), "the reason is named: " + n.body);
  assert.ok(!n.body.includes("the check could not run: "), "the prefix is not doubled in the body");
  assert.ok(!/would leave .* readable/.test(n.body), "no exposure claimed by a check that did not run");
  assert.ok(!n.body.includes(RESTART_HOSTS_HINT), "no restart step for a bug in the check");
  assert.equal(n.metadata.couldNotRun, true);
  assert.deepEqual(n.metadata.findings, COULD_NOT_RUN.findings, "the reason travels in metadata, unedited");
});

test("a HOST-TIER failure carries no restart step: restarting the bot hosts does not change the tier", async () => {
  const { sent, notify } = collector();
  const r = await notifyBotIdentityFailure({ db: makeDb(), notify, result: TIER_FAIL, lang: "en" });
  assert.equal(r.sent, true, "it is still a real failure and still rings");
  assert.ok(sent[0].body.includes(TIER_FAIL.findings[0]), "the finding is named");
  assert.ok(!sent[0].body.includes(RESTART_HOSTS_HINT), sent[0].body);
  assert.ok(!sent[0].body.includes("pibot-gateways"), "no stale-bridge step for a host-tier finding");
});

test("the same finding rings once; a different one rings again", async () => {
  const { sent, notify } = collector();
  const recent = { metadata: JSON.stringify({ signature: botIdentitySignature(FAIL) }), created_at: new Date().toISOString().replace("T", " ").slice(0, 19) };
  const same = await notifyBotIdentityFailure({ db: makeDb({ last: recent }), notify, result: FAIL, lang: "en" });
  assert.deepEqual(same, { sent: false, reason: "already" });
  assert.equal(sent.length, 0);

  const changed = await notifyBotIdentityFailure({ db: makeDb({ last: recent }), notify, result: OTHER_FAIL, lang: "en" });
  assert.equal(changed.sent, true);
  assert.equal(sent.length, 1);
});

test("the same finding rings again once the cooldown has passed (a failure that came back after a fix)", async () => {
  const { sent, notify } = collector();
  const old = Date.now() - NOTICE_COOLDOWN_MS - 60_000;
  const stale = { metadata: JSON.stringify({ signature: botIdentitySignature(FAIL) }), created_at: new Date(old).toISOString().replace("T", " ").slice(0, 19) };
  const r = await notifyBotIdentityFailure({ db: makeDb({ last: stale }), notify, result: FAIL, lang: "en" });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
});

test("the notice follows the dashboard language", async () => {
  const { sent, notify } = collector();
  await notifyBotIdentityFailure({ db: makeDb({ language: "es" }), notify, result: FAIL });
  assert.equal(sent[0].title, t(NOTICE_TITLE_KEY, "es"));
  assert.notEqual(t(NOTICE_TITLE_KEY, "es"), t(NOTICE_TITLE_KEY, "en"), "the key is really translated");
});

test("a send failure is reported, never thrown, and nothing is recorded", async () => {
  const db = makeDb();
  const r = await notifyBotIdentityFailure({
    db,
    result: FAIL,
    lang: "en",
    notify: async () => { throw new Error("bell down"); },
    log: { warn() {} },
  });
  assert.deepEqual(r, { sent: false, reason: "error" });
  assert.equal(db.calls.filter((c) => /INSERT INTO notifications/.test(c.sql)).length, 0);
});

test("a db that cannot answer the dedupe query still rings (a security check is not silenced)", async () => {
  const { sent, notify } = collector();
  const db = {
    async execute({ sql }) {
      if (/FROM notifications WHERE source/.test(sql)) throw new Error("no notifications table");
      if (/FROM dashboard_settings/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
  const r = await notifyBotIdentityFailure({ db, notify, result: FAIL, log: { warn() {} } });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
});

test("no db: nothing is sent and nothing throws", async () => {
  const { sent, notify } = collector();
  const r = await notifyBotIdentityFailure({ db: null, notify, result: FAIL });
  assert.deepEqual(r, { sent: false, reason: "no-db" });
  assert.equal(sent.length, 0);
});