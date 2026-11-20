// The boot wiring for "Bots can't read Crow's identity file"
// (servers/gateway/boot/bot-identity-boot.js, item-70 channel 3).
//
// The production bug these tests pin: post-listen.js passed
// `const { appRoot } = await import("../auto-update.js")` — a FUNCTION — into
// the check, whose hidden-file builder then threw and reported every identity
// file as readable (a false FAIL and a high-priority bell on every install).
// So:
//   - the wiring hands the check a STRING path (the checkout), never a function;
//   - a non-string appRoot is a "check could not run", with NO exposure finding;
//   - every gateway prints exactly ONE `[containment] …` verdict line, whatever
//     the answer (pass / FAIL / could not run) and whatever its sandbox tier —
//     `CROW_PI_SANDBOX=contain` included, which used to end a boot with no line
//     at all;
//   - a hung check still prints that line instead of going silent.
// Everything host-shaped is stubbed or scratch: no database, no bwrap run, no
// bell sent.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { APP_ROOT, CONTAINMENT_PREFIX, runBotIdentityBootCheck } from "../servers/gateway/boot/bot-identity-boot.js";
import { BOT_IDENTITY_TEXT } from "../scripts/pi-bots/bot-identity-text.mjs";

const T = mkdtempSync(join(tmpdir(), "crow-bot-identity-boot-"));
after(() => rmSync(T, { recursive: true, force: true }));
const CROW_HOME = join(T, ".crow");

/** A console-shaped logger that keeps every line, in order. */
function collector() {
  const lines = [];
  const push = (...args) => lines.push(args.join(" "));
  return { lines, log: { log: push, error: push, warn: push } };
}

/** The verdict lines only: the ones that carry the invariant sentence. */
function verdicts(lines) {
  return lines.filter((l) => l.startsWith(CONTAINMENT_PREFIX + BOT_IDENTITY_TEXT + ":"));
}

/** A db stub with no enabled bots (the check then judges nothing and never probes). */
const emptyDb = () => ({ async execute() { return { rows: [] }; }, close() {} });

test("the boot check is handed a STRING appRoot (the checkout), and exactly one line is printed", async () => {
  let seen = null;
  const { lines, log } = collector();
  const result = await runBotIdentityBootCheck({
    dbFactory: emptyDb,
    crowHome: CROW_HOME,
    appRoot: APP_ROOT,
    log,
    guardImport: async () => ({
      runBotIdentityCheck: async (o) => {
        seen = o;
        return { ok: true, text: BOT_IDENTITY_TEXT, findings: [], tierFindings: [], notes: [], checked: 0 };
      },
      formatBotIdentityLine: () => CONTAINMENT_PREFIX + BOT_IDENTITY_TEXT + ": pass",
      couldNotRunResult: (reason) => ({ ok: false, couldNotRun: true, findings: [reason], tierFindings: [reason], notes: [] }),
    }),
    noticeImport: async () => ({ notifyBotIdentityFailure: async () => ({ sent: false, reason: "pass" }) }),
  });

  assert.equal(typeof seen.appRoot, "string", "a path, not the appRoot() function auto-update exports");
  assert.ok(isAbsolute(seen.appRoot), "an absolute checkout path: " + seen.appRoot);
  assert.equal(seen.appRoot, APP_ROOT);
  assert.equal(seen.crowHome, CROW_HOME);
  assert.equal(typeof seen.db.execute, "function", "the caller's db client really reaches the check");
  assert.equal(result.ok, true);
  assert.deepEqual(verdicts(lines), [CONTAINMENT_PREFIX + BOT_IDENTITY_TEXT + ": pass"]);
});

test("a contain-tier gateway prints its identity-check line (the check is not skipped for contain)", async () => {
  // CROW_PI_SANDBOX=contain is the switch crow's gateway runs with. The wiring
  // is unconditional on the tier, and the guard has no contain skip of its own
  // (tests/bot-identity-guard.test.js pins the check itself under `contain`);
  // what this pins is that the boot still says so out loud, once.
  const { lines, log } = collector();
  const result = await runBotIdentityBootCheck({
    dbFactory: emptyDb,
    crowHome: CROW_HOME,
    env: { CROW_PI_SANDBOX: "contain" },
    log,
    noticeImport: async () => ({ notifyBotIdentityFailure: async () => ({ sent: false, reason: "pass" }) }),
  });

  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.noBots, true, "no enabled bots: nothing to judge, nothing to ring");
  assert.deepEqual(verdicts(lines), [CONTAINMENT_PREFIX + BOT_IDENTITY_TEXT + ": pass"]);
  assert.ok(lines.some((l) => l.startsWith(CONTAINMENT_PREFIX + "no bots")), lines.join("\n"));
});

test("a non-string appRoot prints ONE could-not-run line, claims no exposure, and rings the check-failed bell", async () => {
  const { lines, log } = collector();
  const noticed = [];
  const result = await runBotIdentityBootCheck({
    dbFactory: emptyDb,
    crowHome: CROW_HOME,
    // The production bug, verbatim: a function where a path belongs.
    appRoot: () => "/somewhere/crow",
    log,
    noticeImport: async () => ({
      notifyBotIdentityFailure: async ({ result: r }) => { noticed.push(r); return { sent: true, reason: "sent" }; },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.couldNotRun, true);
  const all = verdicts(lines);
  assert.equal(all.length, 1, "exactly one verdict line: " + lines.join("\n"));
  assert.match(all[0], /^\[containment\] Bots can't read Crow's identity file: check could not run \(appRoot must be a string \(got function\)\)$/);
  assert.ok(!lines.some((l) => /would leave .* identity\.json readable/.test(l)),
    "a list that was never built cannot produce exposure findings: " + lines.join("\n"));
  assert.equal(noticed.length, 1, "the bell still rings — a check that cannot answer is not a pass");
  assert.equal(noticed[0].couldNotRun, true, "with the check-failed wording the notice keys on");
});

test("a guard that rejects still prints exactly one could-not-run line", async () => {
  const { lines, log } = collector();
  const result = await runBotIdentityBootCheck({
    dbFactory: emptyDb,
    crowHome: CROW_HOME,
    appRoot: APP_ROOT,
    log,
    guardImport: async () => ({
      runBotIdentityCheck: async () => { throw new Error("boom"); },
      // A formatter that cannot format must not cost the boot its line either.
      formatBotIdentityLine: () => { throw new Error("no line"); },
    }),
    noticeImport: async () => ({ notifyBotIdentityFailure: async () => ({ sent: false, reason: "error" }) }),
  });

  assert.equal(result.couldNotRun, true);
  const all = verdicts(lines);
  assert.equal(all.length, 1, "exactly one verdict line: " + lines.join("\n"));
  assert.match(all[0], /: check could not run \(boom\)$/);
  assert.ok(!all[0].includes("pibot-gateways"), "no bot-host restart step for a bug in the check: " + all[0]);
});

test("a db client that cannot be created says the check could not run, in one line", async () => {
  const { lines, log } = collector();
  const result = await runBotIdentityBootCheck({
    dbFactory: () => { throw new Error("crow.db is not there"); },
    crowHome: CROW_HOME,
    appRoot: APP_ROOT,
    log,
    noticeImport: async () => ({ notifyBotIdentityFailure: async () => ({ sent: false, reason: "no-db" }) }),
  });

  assert.equal(result.couldNotRun, true);
  assert.equal(verdicts(lines).length, 1, lines.join("\n"));
  assert.match(verdicts(lines)[0], /: check could not run \(crow\.db is not there\)$/);
});

test("a guard that never answers prints the could-not-run line instead of going silent", async () => {
  const { lines, log } = collector();
  const result = await runBotIdentityBootCheck({
    dbFactory: emptyDb,
    crowHome: CROW_HOME,
    appRoot: APP_ROOT,
    log,
    timeoutMs: 20,
    guardImport: async () => ({
      runBotIdentityCheck: () => new Promise(() => {}),
      formatBotIdentityLine: (r) => CONTAINMENT_PREFIX + BOT_IDENTITY_TEXT +
        (r.couldNotRun ? ": check could not run (" + r.findings[0].replace("the check could not run: ", "") + ")" : ": pass"),
    }),
    noticeImport: async () => ({ notifyBotIdentityFailure: async () => ({ sent: false, reason: "error" }) }),
  });

  assert.equal(result.couldNotRun, true);
  assert.equal(verdicts(lines).length, 1, lines.join("\n"));
  assert.match(verdicts(lines)[0], /: check could not run \(the check did not answer within .*\)$/);
});