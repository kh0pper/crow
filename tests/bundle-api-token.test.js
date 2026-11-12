/**
 * `firstAdmin.setup.token` — Crow takes an app's API token from the app itself
 * (servers/gateway/bundle-api-token.js, paperless-ngx is the first bundle).
 *
 * What this file pins down:
 *
 *   1. the declaration's rules (apiTokenPlan / apiTokenProblems): first-party only, a script
 *      that ships in the bundle, an env var that is declared, secret, not generated, not one
 *      of the env var names that change how a program RUNS, not one of Crow's own names, and
 *      a timeout inside 1..600;
 *   2. acceptToken: exactly one line, the manifest's own `pattern` or the default
 *      "looks like a token" rule (20–256 printable ASCII, no whitespace, no $ # ' " \ ` { });
 *   3. scrubAll: every trimmed, non-empty line of the raw answer becomes [hidden];
 *   4. runApiToken over the seams — ok, exit 4, exit 1, a timeout, an oversized fd-3 answer,
 *      an answer that is not a token, a save that was refused (has_value → skipped), the
 *      exact runner/save arguments — and the invariant that the token never appears in a
 *      returned field or a log line, even when the script echoes it to stdout;
 *   4b. the stillInstalled guard fails CLOSED: no install stamp, or a seam that cannot
 *      answer, means nothing is saved (the default seam answers false);
 *   4c. several values (`token.env` as an array): every value accepted before any is saved, a
 *      half-filled extension left alone before the script runs, and a save that does not land
 *      taking back what the run had already written (never "ok" over a mixed set);
 *   4d. `stdin: "admin-password"`: the keychain's password on the script's stdin, nowhere else;
 *      a refused multi-value answer's bare values are scrubbed from the log and the reason;
 *   4e. the block only exists for a `mode: "crow"` admin, in the location its `via` names
 *      (and the bundle contract refuses the other location);
 *   5. spawnGroup's `secretFd`: fd 3 collected apart from stdout/stderr, capped at 4096
 *      bytes (an overflow is refused, never truncated-and-accepted), and a rejection whose
 *      `secret` is non-enumerable (Object.keys(err) does not list it);
 *   6. the manifest schema can express the step at all (registry/manifest.schema.json).
 *
 * No database CONTENTS are needed, no docker, no real app: the seams are injected, and the
 * all-or-nothing pre-check has its own `mcpValue` / `hasKeychainRow` seams (a test that does
 * not inject them gets the real answer for this scratch home: no value, no row). The script
 * cases use small temporary bash files.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { apiTokenPlan, apiTokenProblems, acceptToken, acceptTokenValues, apiTokenEnvNames, scrubAll, runApiToken } =
  await import("../servers/gateway/bundle-api-token.js");
const { spawnGroup, SECRET_FD_MAX_BYTES } = await import("../servers/gateway/bundle-lifecycle.js");
const { API_KEY_SAVE_REFUSALS } = await import("../servers/gateway/bundle-apikey-save.js");

const TMP = mkdtempSync(join(tmpdir(), "crow-api-token-"));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

/** paperless-shaped: a 40-hex token the app's own pattern describes. */
const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const TOKEN2 = "fedcba9876543210fedcba9876543210fedcba98";

/** The installed.json stamp every run under test is gated on (a run without one refuses to save). */
const STAMP = "2026-11-12T09:00:00.000Z";
/** "The extension is still installed" — the seam every run under test injects (the real default fails closed). */
const STILL = async () => true;

const MANIFEST = {
  id: "demo-app",
  name: "Demo App",
  origin: "official",
  env_vars: [
    { name: "APP_URL", default: "http://127.0.0.1:8000" },
    { name: "APP_API_TOKEN", description: "API token", required: true, secret: true, pattern: "^[a-f0-9]{40}$" },
    { name: "APP_BARE_TOKEN", description: "no pattern declared", required: false, secret: true },
    { name: "APP_PLAIN", description: "not a secret", required: false },
    { name: "APP_GENERATED_TOKEN", description: "minted by Crow", required: false, secret: true, generate: "secret" },
    { name: "APP_ADMIN_PASSWORD", description: "set by Crow", required: false, secret: true },
    { name: "APP_ADMIN_USER", description: "the admin account" },
  ],
  firstAdmin: {
    mode: "crow",
    via: "setup",
    setup: {
      script: "scripts/first-admin.sh",
      timeout_s: 240,
      token: { script: "scripts/api-token.sh", env: "APP_API_TOKEN" },
    },
    user: "admin",
    secretEnv: "APP_ADMIN_PASSWORD",
    userEnv: "APP_ADMIN_USER",
  },
};

/** The same manifest with a different `setup.token` block (and/or other firstAdmin fields). */
function withToken(token, { firstAdmin = {}, manifest = {} } = {}) {
  return {
    ...MANIFEST,
    ...manifest,
    firstAdmin: {
      ...MANIFEST.firstAdmin,
      ...firstAdmin,
      setup: { ...MANIFEST.firstAdmin.setup, token },
    },
  };
}
const bareToken = (token = { env: "APP_BARE_TOKEN" }) => withToken({ script: "scripts/api-token.sh", ...token });

// ── 1. the declaration ──────────────────────────────────────────────────────────────

test("no `setup.token` block is no token step: plan null, no problems", () => {
  for (const manifest of [
    {},
    { firstAdmin: { mode: "none" } },
    { firstAdmin: { mode: "crow", via: "env", secretEnv: "X" } },
    { firstAdmin: { mode: "crow", via: "setup", setup: { script: "scripts/first-admin.sh" }, user: "admin", secretEnv: "APP_ADMIN_PASSWORD" } },
  ]) {
    assert.equal(apiTokenPlan(manifest), null, JSON.stringify(manifest.firstAdmin || null));
    assert.deepEqual(apiTokenProblems(manifest), []);
  }
});

test("a valid declaration resolves to script, env, timeout and user", () => {
  assert.deepEqual(apiTokenPlan(MANIFEST), {
    script: "scripts/api-token.sh",
    env: "APP_API_TOKEN",
    timeoutMs: 120_000,
    user: "admin",
  });
  assert.deepEqual(apiTokenProblems(MANIFEST), []);
  const slow = withToken({ script: "scripts/api-token.sh", env: "APP_API_TOKEN", timeout_s: 240 });
  assert.equal(apiTokenPlan(slow).timeoutMs, 240_000);
  const huge = withToken({ script: "scripts/api-token.sh", env: "APP_API_TOKEN", timeout_s: 99_999 });
  assert.match(apiTokenPlan(huge).refused, /setup\.token\.timeout_s must be an integer between 1 and 600/);
  for (const bad of [0, 601, -1, 1.5, "30", null]) {
    const m = withToken({ script: "scripts/api-token.sh", env: "APP_API_TOKEN", timeout_s: bad });
    assert.match(apiTokenPlan(m).refused, /timeout_s/, JSON.stringify(bad));
  }
});

test("the token script must be a relative .sh inside the bundle, and a community bundle is refused", () => {
  for (const script of ["/abs/api-token.sh", "../outside.sh", "scripts/api-token.py", ".", "", undefined, 42]) {
    const m = withToken({ script, env: "APP_API_TOKEN" });
    assert.match(apiTokenPlan(m).refused, /setup\.token\.script .* must be a relative \.sh path inside the bundle/, String(script));
  }
  const community = withToken({ script: "scripts/api-token.sh", env: "APP_API_TOKEN" }, { manifest: { origin: "community" } });
  assert.match(apiTokenPlan(community).refused, /first-party bundles only/);
  // Everything wrong is reported, not just the first thing.
  assert.ok(apiTokenProblems({ ...community, firstAdmin: { ...community.firstAdmin, setup: { ...community.firstAdmin.setup, token: { script: "../x.sh", env: "" } } } }).length >= 2);
});

test("the target env var must be declared, secret, not generated, and not one of Crow's own", () => {
  const refusals = (env) => apiTokenProblems(withToken({ script: "scripts/api-token.sh", env }));
  assert.match(refusals("NOT_DECLARED").join("\n"), /must name a declared env_vars entry/);
  assert.match(refusals("APP_PLAIN").join("\n"), /must be declared with secret: true/);
  assert.match(refusals("APP_GENERATED_TOKEN").join("\n"), /is a value Crow generates/);
  assert.match(refusals("APP_ADMIN_PASSWORD").join("\n"), /must not be the same as firstAdmin\.secretEnv/);
  assert.match(refusals("APP_ADMIN_USER").join("\n"), /must not be the same as firstAdmin\.userEnv/);
  const withUrl = withToken({ script: "scripts/api-token.sh", env: "APP_URL" }, { firstAdmin: { urlEnv: "APP_URL" } });
  assert.match(apiTokenProblems(withUrl).join("\n"), /must not be the same as firstAdmin\.urlEnv/);
  // A url may not take the token even when it IS declared secret.
  const secretUrl = withToken({ script: "scripts/api-token.sh", env: "APP_BARE_TOKEN" }, { firstAdmin: { urlEnv: "APP_BARE_TOKEN" } });
  assert.deepEqual(apiTokenProblems(secretUrl), ["firstAdmin.setup.token.env must not be the same as firstAdmin.urlEnv"]);
  // The NAME itself: a plain uppercase env name, and not a runtime-control name.
  assert.match(refusals("app_token").join("\n"), /plain uppercase env name/);
  assert.match(refusals("CROW_TOKEN").join("\n"), /that prefix is reserved/);
  assert.match(refusals("NODE_OPTIONS").join("\n"), /controls how programs run/);
  assert.match(refusals("").join("\n"), /token\.env is missing/);
  assert.equal(apiTokenProblems(bareToken()).length, 0, "a plain declared secret is fine");
});

// ── 2. acceptToken ─────────────────────────────────────────────────────────────────

test("acceptToken: the manifest's own pattern decides when one is declared", () => {
  assert.equal(acceptToken(`${TOKEN}\n`, MANIFEST, "APP_API_TOKEN"), TOKEN);
  assert.equal(acceptToken(TOKEN, MANIFEST, "APP_API_TOKEN"), TOKEN, "a single trailing newline is optional");
  assert.equal(acceptToken(`${TOKEN}\n\n`, MANIFEST, "APP_API_TOKEN"), null, "two newlines is not one line");
  assert.equal(acceptToken(`${TOKEN2}\nsecond-line\n`, MANIFEST, "APP_API_TOKEN"), null, "two non-empty lines is not a token");
  assert.equal(acceptToken("\n", MANIFEST, "APP_API_TOKEN"), null);
  assert.equal(acceptToken("", MANIFEST, "APP_API_TOKEN"), null);
  assert.equal(acceptToken(null, MANIFEST, "APP_API_TOKEN"), null);
  assert.equal(acceptToken("NOTHEX0123456789abcdef0123456789abcdef\n", MANIFEST, "APP_API_TOKEN"), null);
  // A pattern may allow the characters the default rule refuses (the bundle's grammar wins).
  const dollar = { env_vars: [{ name: "X_TOKEN", secret: true, pattern: "^[A-Za-z0-9_$]{4,20}$" }] };
  assert.equal(acceptToken("ab$d\n", dollar, "X_TOKEN"), "ab$d");
});

test("acceptToken: with no pattern, 20–256 printable ASCII characters and no metacharacters", () => {
  const bare = "a".repeat(20);
  assert.equal(acceptToken(`${bare}\n`, MANIFEST, "APP_BARE_TOKEN"), bare);
  assert.equal(acceptToken("a".repeat(19), MANIFEST, "APP_BARE_TOKEN"), null, "19 is too short");
  assert.equal(acceptToken("a".repeat(256), MANIFEST, "APP_BARE_TOKEN"), "a".repeat(256));
  assert.equal(acceptToken("a".repeat(257), MANIFEST, "APP_BARE_TOKEN"), null, "257 is too long");
  for (const metachar of ["$", "#", "'", '"', "\\", "`", "{", "}"]) {
    const value = `${"a".repeat(10)}${metachar}${"b".repeat(10)}`;
    assert.equal(acceptToken(`${value}\n`, MANIFEST, "APP_BARE_TOKEN"), null, metachar);
  }
  assert.equal(acceptToken(` ${bare}\n`, MANIFEST, "APP_BARE_TOKEN"), null, "leading space");
  assert.equal(acceptToken(`${bare} \n`, MANIFEST, "APP_BARE_TOKEN"), null, "trailing space");
  assert.equal(acceptToken(`aaaa aaaa aaaa aaaa aaaa\n`, MANIFEST, "APP_BARE_TOKEN"), null, "inner space");
  assert.equal(acceptToken(`ääääääääääääääääääää\n`, MANIFEST, "APP_BARE_TOKEN"), null, "not ASCII");
  assert.equal(acceptToken(`${bare}\r\n`, MANIFEST, "APP_BARE_TOKEN"), null, "CRLF is not one clean line");
});

// ── 3. scrubAll ────────────────────────────────────────────────────────────────────

test("scrubAll hides every trimmed non-empty line of the raw answer, and leaves short ones", () => {
  const raw = ` ${TOKEN} \n{\n}\nok\n`;
  assert.equal(scrubAll(`saved ${TOKEN} ok`, raw), "saved [hidden] ok");
  assert.equal(scrubAll(`a\n${TOKEN}\n${TOKEN}\nb`, raw), "a\n[hidden]\n[hidden]\nb");
  assert.equal(scrubAll("nothing to hide here", raw), "nothing to hide here");
  // A line that contains another: longest first, so no fragment survives.
  assert.equal(scrubAll("abcdefgh", "abcdef\nabcdefgh\n"), "[hidden]");
  assert.equal(scrubAll(undefined, raw), "");
});

// ── 4. runApiToken over the seams ──────────────────────────────────────────────────

/** A reviewed script tree (with the token script on disk) and an installed folder. */
function dirs(id = "demo-app") {
  const root = mkdtempSync(join(TMP, "run-"));
  const scriptDir = join(root, "reviewed");
  const destDir = join(root, "installed");
  mkdirSync(join(scriptDir, "scripts"), { recursive: true });
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(scriptDir, "scripts", "api-token.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(scriptDir, "scripts", "first-admin.sh"), "#!/usr/bin/env bash\nexit 0\n");
  return { id, scriptDir, destDir };
}

/** Capture console.warn, so a leak into a log line is caught here. */
function captureWarn() {
  const lines = [];
  const real = console.warn;
  console.warn = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => { console.warn = real; } };
}

test("runApiToken: a token on fd 3 is saved with the generated, first-writer-wins policy", async () => {
  const { scriptDir, destDir } = dirs();
  const calls = { runner: [], save: [] };
  const out = await runApiToken({
    bundleId: "demo-app",
    manifest: MANIFEST,
    scriptDir,
    destDir,
    crowHome: "/tmp/scratch-home",
    installStamp: STAMP,
    deps: {
      runner: async (cmd, args, opts) => {
        calls.runner.push({ cmd, args, opts });
        return { stdout: "step one\nstep two\n", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false };
      },
      save: async (o) => { calls.save.push(o); return { ok: true, needs_restart: true, needs_config: [] }; },
      stillInstalled: STILL,
      warn: () => {},
    },
  });
  assert.deepEqual(Object.keys(out).sort(), ["log", "mcpEnvUpdated", "result"]);
  assert.equal(out.result, "ok");
  assert.equal(out.mcpEnvUpdated, true);
  assert.deepEqual(out.log, ["step one", "step two"]);
  assert.equal(JSON.stringify(out).includes(TOKEN), false, "the token is never a field of the answer");

  // The exact runner call: bash <abs script inside the reviewed tree>, cwd = installed dir,
  // minimal env + the admin username, fd 3 enabled, no stdin.
  assert.equal(calls.runner.length, 1);
  assert.equal(calls.runner[0].cmd, "bash");
  assert.deepEqual(calls.runner[0].args, [join(scriptDir, "scripts", "api-token.sh")]);
  assert.equal(calls.runner[0].opts.cwd, destDir);
  assert.equal(calls.runner[0].opts.timeout, 120_000);
  assert.equal(calls.runner[0].opts.secretFd, true);
  assert.equal("input" in calls.runner[0].opts, false, "nothing goes IN: the token comes BACK on fd 3");
  assert.equal(calls.runner[0].opts.env.CROW_FIRST_ADMIN_USER, "admin");
  assert.equal(calls.runner[0].opts.env.CROW_BUNDLE_DIR, destDir);
  assert.equal(calls.runner[0].opts.env.CROW_HOME, "/tmp/scratch-home");
  assert.equal(calls.runner[0].opts.env.PATH, process.env.PATH);

  // The exact save call.
  assert.equal(calls.save.length, 1);
  assert.deepEqual(
    { ...calls.save[0], manifest: "manifest" },
    {
      bundleId: "demo-app",
      manifest: "manifest",
      envKey: "APP_API_TOKEN",
      value: TOKEN,
      crowHome: "/tmp/scratch-home",
      origin: "generated",
      propagate: false,
      firstWriterWins: true,
    },
  );
});

test("runApiToken: a script answer that is not a usable token fails, and nothing is saved", async () => {
  const { scriptDir, destDir } = dirs();
  let saves = 0;
  const deps = (secret) => ({
    runner: async () => ({ stdout: "", stderr: "", secret, secretOverflow: false }),
    save: async () => { saves++; return { ok: true, needs_restart: false, needs_config: [] }; },
    stillInstalled: STILL,
    warn: () => {},
  });
  for (const secret of ["", "\n", "not a token at all\n", `${TOKEN}\n${TOKEN2}\n`, "short\n"]) {
    const out = await runApiToken({ bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP, deps: deps(secret) });
    assert.equal(out.result, "failed", JSON.stringify(secret));
    assert.equal(out.reason, "the app answered with something that is not an API token");
    assert.equal(JSON.stringify(out).includes(TOKEN), false);
  }
  assert.equal(saves, 0, "a refused shape writes nothing");
});

test("runApiToken: exit 4 is not-running, a timeout and any other exit code are failures", async () => {
  const { scriptDir, destDir } = dirs();
  const runnerThrows = (extra) => ({
    runner: async () => { throw Object.assign(new Error(extra.why || "exit 1"), extra); },
    save: async () => { throw new Error("must not be called"); },
    stillInstalled: STILL,
    warn: () => {},
  });
  const notRunning = await runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: runnerThrows({ exitCode: 4, stdout: "", stderr: "the app is not up yet" }),
  });
  assert.deepEqual(notRunning, { result: "not-running", log: ["the app is not up yet"] });

  const failed = await runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: runnerThrows({ exitCode: 1, stdout: "", stderr: "login refused\nexit 1" }),
  });
  assert.equal(failed.result, "failed");
  assert.match(failed.reason, /login refused/);
  assert.equal(failed.reason.includes("exit 1"), false, "spawnGroup's own line is not part of the reason");

  const timedOut = await runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: runnerThrows({ timedOut: true, exitCode: null, stdout: "", stderr: "" }),
  });
  assert.equal(timedOut.result, "failed");
  assert.match(timedOut.reason, /timed out after 120s/);
});

test("runApiToken: an oversized fd-3 answer is refused, never truncated-and-accepted", async () => {
  const { scriptDir, destDir } = dirs();
  let saves = 0;
  const huge = "x".repeat(SECRET_FD_MAX_BYTES + 1);
  for (const mode of ["resolved", "rejected"]) {
    const out = await runApiToken({
      bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
      deps: {
        runner: async () => {
          if (mode === "resolved") return { stdout: "", stderr: "", secret: "", secretOverflow: true };
          throw Object.assign(new Error("exit 0"), { exitCode: 0, stdout: "", stderr: "", secret: huge, secretOverflow: true });
        },
        save: async () => { saves++; return { ok: true, needs_restart: false, needs_config: [] }; },
        stillInstalled: STILL,
        warn: () => {},
      },
    });
    assert.equal(out.result, "failed", mode);
    assert.match(out.reason, /more than an API token/);
  }
  assert.equal(saves, 0);
});

test("runApiToken: has_value is skipped-has-value, any other refusal is a failure with its own sentence", async () => {
  const { scriptDir, destDir } = dirs();
  const runWith = (saveResult) => runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }),
      save: async () => saveResult,
      stillInstalled: STILL,
      warn: () => {},
    },
  });
  const skipped = await runWith({ ok: false, status: 409, error: API_KEY_SAVE_REFUSALS.has_value });
  assert.deepEqual(skipped, { result: "skipped-has-value", log: [] });

  const refused = await runWith({ ok: false, status: 500, error: API_KEY_SAVE_REFUSALS.keychain });
  assert.equal(refused.result, "failed");
  assert.equal(refused.reason, API_KEY_SAVE_REFUSALS.keychain);
  assert.equal(JSON.stringify(refused).includes(TOKEN), false);

  const threw = await runWith(undefined);
  assert.equal(threw.result, "failed", "a save that returned nothing usable is a failure, never ok");
  const thrown = await runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }),
      save: async () => { throw new Error("boom"); },
      stillInstalled: STILL,
      warn: () => {},
    },
  });
  assert.equal(thrown.result, "failed");
  assert.equal(thrown.reason, "Crow could not save the app's API token");
});

test("runApiToken: a token is only saved while the extension is still installed (the stillInstalled seam)", async () => {
  const { scriptDir, destDir } = dirs();
  const runWith = (still, installStamp = STAMP) => {
    const seen = [];
    let saves = 0;
    return runApiToken({
      bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp,
      deps: {
        runner: async () => ({ stdout: "minted\n", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }),
        save: async () => { saves++; return { ok: true, needs_restart: false, needs_config: [] }; },
        stillInstalled: async (id, at) => { seen.push([id, at]); return still; },
        warn: () => {},
      },
    }).then((out) => ({ out, seen, saves }));
  };

  // Still installed under the stamp the caller gated on: the save happens.
  const kept = await runWith(true);
  assert.equal(kept.out.result, "ok");
  assert.deepEqual(kept.seen, [["demo-app", STAMP]], "asked once, with the stamp the caller gated on");
  assert.equal(kept.saves, 1);
  assert.equal(JSON.stringify(kept.out).includes(TOKEN), false);

  // Removed, or reinstalled (a NEW stamp): nothing is written, and the reason says why.
  const gone = await runWith(false);
  assert.equal(gone.out.result, "failed");
  assert.equal(gone.out.reason, "the extension was removed while Crow was creating its token");
  assert.equal(gone.saves, 0, "no save for an extension that is gone");
  assert.equal(JSON.stringify(gone.out).includes(TOKEN), false);

  // A seam that cannot answer has NOT confirmed the extension: fail closed, save nothing.
  let savesWhenBroken = 0;
  let runnerRan = 0;
  const broken = await runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => { runnerRan++; return { stdout: "", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }; },
      save: async () => { savesWhenBroken++; return { ok: true, needs_restart: false, needs_config: [] }; },
      stillInstalled: async () => { throw new Error("installed.json unreadable"); },
      warn: () => {},
    },
  });
  assert.equal(runnerRan, 1, "the script did run: only the confirmation is missing");
  assert.equal(broken.result, "failed");
  assert.equal(broken.reason, "Crow could not confirm the extension is still installed, so it did not save the token");
  assert.equal(savesWhenBroken, 0, "an unconfirmed install is not saved on a guess");
  assert.equal(JSON.stringify(broken).includes(TOKEN), false);

  // A failed script never asks: there is no token to save.
  const seenOnFailure = [];
  const failed = await runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => { throw Object.assign(new Error("exit 1"), { exitCode: 1, stdout: "", stderr: "refused" }); },
      save: async () => { throw new Error("must not be called"); },
      stillInstalled: async (id, at) => { seenOnFailure.push([id, at]); return true; },
      warn: () => {},
    },
  });
  assert.equal(failed.result, "failed");
  assert.deepEqual(seenOnFailure, [], "the seam is asked only once a token is in hand");
});

test("runApiToken: a run without an install stamp refuses to save — there is nothing to confirm it against", async () => {
  const { scriptDir, destDir } = dirs();
  const reason = "Crow could not confirm the extension is still installed, so it did not save the token";
  for (const installStamp of [undefined, null, "", "   "]) {
    let runnerRan = 0;
    let saves = 0;
    let seamAsked = 0;
    const out = await runApiToken({
      bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp,
      deps: {
        runner: async () => { runnerRan++; return { stdout: "", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }; },
        save: async () => { saves++; return { ok: true, needs_restart: false, needs_config: [] }; },
        stillInstalled: async () => { seamAsked++; return true; },
        warn: () => {},
      },
    });
    assert.equal(out.result, "failed", JSON.stringify(installStamp));
    assert.equal(out.reason, reason, JSON.stringify(installStamp));
    assert.equal(out.log.length, 0, "nothing ran, so there is no log");
    assert.equal(runnerRan, 0, "the script is not run for a save that could never be confirmed");
    assert.equal(seamAsked, 0, "the seam is not asked without a stamp to ask about");
    assert.equal(saves, 0, "no save");
    assert.equal(JSON.stringify(out).includes(TOKEN), false);
  }

  // The fail-closed default: a run that injects every seam but stillInstalled saves nothing.
  let defaultSaves = 0;
  const withDefault = await runApiToken({
    bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }),
      save: async () => { defaultSaves++; return { ok: true, needs_restart: false, needs_config: [] }; },
      warn: () => {},
    },
  });
  assert.equal(withDefault.result, "failed");
  assert.equal(withDefault.reason, "the extension was removed while Crow was creating its token", "the default answers false, so nothing is saved on a guess");
  assert.equal(defaultSaves, 0);
});

test("runApiToken: the token never reaches a log line, a warn or the answer — even when the script prints it", async () => {
  const { scriptDir, destDir } = dirs();
  const captured = captureWarn();
  try {
    // The script echoes the token to stdout and stderr (a debug echo) AND hands it back on fd 3.
    const out = await runApiToken({
      bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
      deps: {
        runner: async () => ({
          stdout: `minted token=${TOKEN}\ndone\n`,
          stderr: `echo: ${TOKEN}\n`,
          secret: `${TOKEN}\n`,
          secretOverflow: false,
        }),
        save: async () => ({ ok: true, needs_restart: false, needs_config: [] }),
        stillInstalled: STILL,
        warn: () => {},
      },
    });
    assert.equal(out.result, "ok");
    assert.deepEqual(out.log, ["minted token=[hidden]", "done", "echo: [hidden]"]);
    assert.equal(JSON.stringify(out).includes(TOKEN), false);

    // The same on a failure path, where the token was never accepted as one.
    const failed = await runApiToken({
      bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
      deps: {
        runner: async () => {
          throw Object.assign(new Error("exit 1"), { exitCode: 1, stderr: `failed while holding ${TOKEN2}` , stdout: "", secret: `${TOKEN2}\n` });
        },
        save: async () => ({ ok: true, needs_restart: false, needs_config: [] }),
        stillInstalled: STILL,
        warn: () => {},
      },
    });
    assert.equal(failed.result, "failed");
    assert.match(failed.reason, /\[hidden\]/, failed.reason);
    assert.equal(JSON.stringify(failed).includes(TOKEN2), false);

    // A run that stops unexpectedly warns with a code and nothing else.
    const broken = await runApiToken({
      bundleId: "demo-app", manifest: MANIFEST, scriptDir, destDir, installStamp: STAMP,
      deps: {
        // The run's own reading of the answer fails: the outer catch is what answers.
        runner: async () => ({
          get stdout() { throw Object.assign(new Error(`the row for ${TOKEN} failed`), { code: "SQLITE_ERROR" }); },
          stderr: "",
          secret: `${TOKEN}\n`,
          secretOverflow: false,
        }),
        save: async () => ({ ok: true, needs_restart: false, needs_config: [] }),
        stillInstalled: STILL,
        warn: (m) => console.warn(m),
      },
    });
    assert.equal(broken.result, "failed");
    assert.equal(broken.reason, "Crow's own token setup stopped unexpectedly");
    assert.equal(JSON.stringify(broken).includes(TOKEN), false);
    assert.equal(captured.lines.join("\n").includes(TOKEN), false, captured.lines.join("\n"));
    assert.match(captured.lines.join("\n"), /demo-app: API-token setup stopped \(SQLITE_ERROR\)/);
  } finally {
    captured.restore();
  }
});

test("runApiToken: a declaration that cannot run is refused, and a script that escapes the reviewed tree fails", async () => {
  const { scriptDir, destDir } = dirs();
  const deps = {
    runner: async () => { throw new Error("must not run"); },
    save: async () => { throw new Error("must not run"); },
    warn: () => {},
  };
  const community = await runApiToken({
    bundleId: "demo-app",
    manifest: withToken({ script: "scripts/api-token.sh", env: "APP_API_TOKEN" }, { manifest: { origin: "community" } }),
    scriptDir, destDir, deps,
  });
  assert.equal(community.result, "refused");
  assert.match(community.reason, /first-party bundles only/);

  const nothing = await runApiToken({ bundleId: "demo-app", manifest: {}, scriptDir, destDir, deps });
  assert.equal(nothing.result, "refused");
  assert.match(nothing.reason, /not minted by a setup script/);

  // A reviewed script that is a symlink out of the reviewed tree is not run.
  const outside = join(TMP, "outside-");
  const escapeRoot = mkdtempSync(outside);
  const escapeScript = join(escapeRoot, "api-token.sh");
  writeFileSync(escapeScript, "#!/usr/bin/env bash\nexit 0\n");
  const escapeDir = mkdtempSync(join(TMP, "escape-"));
  mkdirSync(join(escapeDir, "scripts"), { recursive: true });
  symlinkSync(escapeScript, join(escapeDir, "scripts", "api-token.sh"));
  const escaped = await runApiToken({ bundleId: "demo-app", manifest: MANIFEST, scriptDir: escapeDir, destDir, deps });
  assert.equal(escaped.result, "failed");
  assert.match(escaped.reason, /outside Crow's own copy of the bundle/);
  assert.equal(readFileSync(escapeScript, "utf8").includes("exit 0"), true, "the real file was untouched");
});

// ── 4c. several values: `token.env` as an array ────────────────────────────────

/** Crow-generated admin password shape (base64url). */
const PASSWORD = "gen-Secret_ABC123xy-z45";
const CLIENT_ID = "3pbcwp0qzw0ss8c4k0kskw0ws0w0sw0";
const CLIENT_SECRET = "zyxwvu9876543210zyxwvu9876543210";

/** MANIFEST plus two secret env vars, filled from ONE multi-value answer. */
const MULTI = {
  ...MANIFEST,
  env_vars: [
    ...MANIFEST.env_vars,
    { name: "APP_CLIENT_ID", description: "client id", required: true, secret: true },
    { name: "APP_CLIENT_SECRET", description: "client secret", required: true, secret: true, pattern: "^[A-Za-z0-9]{20,64}$" },
  ],
  firstAdmin: {
    ...MANIFEST.firstAdmin,
    setup: {
      ...MANIFEST.firstAdmin.setup,
      token: { script: "scripts/api-token.sh", env: ["APP_CLIENT_ID", "APP_CLIENT_SECRET"], stdin: "admin-password" },
    },
  },
};
const MULTI_ANSWER = `APP_CLIENT_ID=${CLIENT_ID}\nAPP_CLIENT_SECRET=${CLIENT_SECRET}\n`;

/** The same token block, declared beside `secretEnv` because the admin comes from the env. */
const ENV_ADMIN = {
  ...MANIFEST,
  firstAdmin: {
    mode: "crow",
    via: "env",
    secretEnv: "APP_ADMIN_PASSWORD",
    userEnv: "APP_ADMIN_USER",
    token: { script: "scripts/api-token.sh", env: "APP_API_TOKEN", stdin: "admin-password" },
  },
};

test("an array `env` resolves to every name, and `stdin` says the admin password comes in", () => {
  assert.deepEqual(apiTokenProblems(MULTI), [], "two declared secrets, one line each: allowed");
  const plan = apiTokenPlan(MULTI);
  assert.deepEqual(plan.env, ["APP_CLIENT_ID", "APP_CLIENT_SECRET"]);
  assert.equal(plan.stdin, "admin-password");
  assert.deepEqual(apiTokenEnvNames(plan), ["APP_CLIENT_ID", "APP_CLIENT_SECRET"]);
  // A single string keeps today's plan shape exactly (no `stdin` unless declared).
  assert.deepEqual(apiTokenEnvNames(apiTokenPlan(MANIFEST)), ["APP_API_TOKEN"]);
  assert.equal("stdin" in apiTokenPlan(MANIFEST), false);
});

test("an array `env` is checked name by name: declared, secret, unique, and never Crow's own", () => {
  const withEnv = (env, extra = {}) => apiTokenProblems({
    ...MULTI,
    firstAdmin: {
      ...MULTI.firstAdmin,
      setup: { ...MULTI.firstAdmin.setup, token: { script: "scripts/api-token.sh", env, ...extra } },
    },
  }).join("\n");
  assert.match(withEnv([]), /must name at least one env var/);
  assert.match(withEnv(["APP_CLIENT_ID", "APP_CLIENT_ID"]), /names "APP_CLIENT_ID" twice/);
  assert.match(withEnv(["APP_CLIENT_ID", "NOT_DECLARED"]), /must name a declared env_vars entry/);
  assert.match(withEnv(["APP_CLIENT_ID", "APP_PLAIN"]), /must be declared with secret: true/);
  assert.match(withEnv(["APP_CLIENT_ID", "APP_GENERATED_TOKEN"]), /is a value Crow generates/);
  assert.match(withEnv(["APP_CLIENT_ID", "APP_ADMIN_PASSWORD"]), /must not be the same as firstAdmin\.secretEnv/);
  assert.match(withEnv(["APP_CLIENT_ID", "app_client_secret"]), /must be a plain uppercase env name/);
  assert.match(withEnv(Array.from({ length: 9 }, (_, i) => `APP_X${i}`)), /may name at most 8 env vars/);
  // `stdin` is the one value Crow passes in, and nothing else is accepted.
  assert.match(withEnv(["APP_CLIENT_ID"], { stdin: "password" }), /setup\.token\.stdin must be "admin-password"/);
});

test("a via \"env\" admin declares its token as firstAdmin.token, and nowhere else", () => {
  assert.deepEqual(apiTokenProblems(ENV_ADMIN), []);
  const plan = apiTokenPlan(ENV_ADMIN);
  assert.equal(plan.env, "APP_API_TOKEN");
  assert.equal(plan.user, "", "via \"env\" names no admin user: the app created it from the environment");
  assert.equal(plan.stdin, "admin-password");

  // The setup location is refused for an env admin (there is no setup script to hang it under).
  const inSetup = { ...ENV_ADMIN, firstAdmin: { mode: "crow", via: "env", secretEnv: "APP_ADMIN_PASSWORD", setup: MANIFEST.firstAdmin.setup } };
  assert.equal(apiTokenPlan(inSetup), null, "no block where it belongs, so nothing runs");
  assert.match(apiTokenProblems(inSetup).join("\n"), /setup\.token is only allowed with via "setup"/);

  // ...and the env location is refused for a setup admin.
  const atFirstAdmin = { ...MANIFEST, firstAdmin: { ...MANIFEST.firstAdmin, token: { script: "scripts/api-token.sh", env: "APP_API_TOKEN" } } };
  assert.match(apiTokenProblems(atFirstAdmin).join("\n"), /firstAdmin\.token is only allowed with via "env"/);
  assert.match(apiTokenPlan(atFirstAdmin).refused, /only allowed with via "env"/);

  // A setup.token with NO mechanism at all is not that mechanism's declaration either.
  const noVia = { ...MANIFEST, firstAdmin: { mode: "none", setup: MANIFEST.firstAdmin.setup } };
  assert.match(apiTokenProblems(noVia).join("\n"), /setup\.token is only allowed with via "setup"/);
  assert.equal(apiTokenPlan(noVia), null, "no plan, so nothing runs");
  const otherVia = { ...MANIFEST, firstAdmin: { ...MANIFEST.firstAdmin, via: "postInstall" } };
  assert.match(apiTokenProblems(otherVia).join("\n"), /setup\.token is only allowed with via "setup"/);
});

test("only a `mode: \"crow\"` admin has a token step: another mode's admin is not Crow's", () => {
  // The block sits in the right place, but Crow never made this admin (the install path's own
  // firstAdminVia rule): there is no login to sign in with, so nothing may run.
  for (const firstAdmin of [
    { ...MANIFEST.firstAdmin, mode: "none" },
    { ...MANIFEST.firstAdmin, mode: "finish-setup" },
    { ...MANIFEST.firstAdmin, mode: "default-login" },
  ]) {
    const manifest = { ...MANIFEST, firstAdmin };
    assert.equal(apiTokenPlan(manifest), null, JSON.stringify(firstAdmin.mode));
    assert.deepEqual(apiTokenProblems(manifest), [], "not declared where Crow would look for a run");
  }
});

test("the bundle contract refuses a token block declared for the wrong mechanism", async () => {
  const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
  const repo = join(import.meta.dirname, "..");
  const load = (id) => JSON.parse(readFileSync(join(repo, "bundles", id, "manifest.json"), "utf8"));
  const firstAdminErrors = (manifest, dir) => (validateManifest(manifest, dir).errors || []).filter((e) => e.startsWith("firstAdmin"));
  const paperless = load("paperless");
  const paperlessDir = join(repo, "bundles", "paperless");
  const miniflux = load("miniflux");
  const minifluxDir = join(repo, "bundles", "miniflux");
  // The two real declarations, each where its own mechanism puts it.
  assert.deepEqual(firstAdminErrors(paperless, paperlessDir), [], "paperless: via setup, setup.token");
  assert.deepEqual(firstAdminErrors(miniflux, minifluxDir), [], "miniflux: via env, firstAdmin.token");

  // Moved to the other location, each is refused (Crow would never run it there).
  const { token: setupToken, ...setupWithout } = paperless.firstAdmin.setup;
  const up = { ...paperless, firstAdmin: { ...paperless.firstAdmin, setup: setupWithout, token: setupToken } };
  assert.match(firstAdminErrors(up, paperlessDir).join("\n"), /firstAdmin\.token is only allowed with via "env"/);

  const { token: siblingToken, ...siblingless } = miniflux.firstAdmin;
  const down = { ...miniflux, firstAdmin: { ...siblingless, setup: { script: "scripts/first-admin.sh", token: siblingToken } } };
  assert.match(firstAdminErrors(down, minifluxDir).join("\n"), /firstAdmin\.setup\.token is only allowed with via "setup"/);
});

test("acceptTokenValues: one name keeps today's one-line protocol, unchanged", () => {
  assert.deepEqual(acceptTokenValues(`${TOKEN}\n`, MANIFEST, ["APP_API_TOKEN"]), { values: { APP_API_TOKEN: TOKEN } });
  assert.equal(acceptTokenValues(`APP_API_TOKEN=${TOKEN}\n`, MANIFEST, ["APP_API_TOKEN"]), null, "NAME=value is the array protocol only");
  assert.equal(acceptTokenValues("\n", MANIFEST, ["APP_API_TOKEN"]), null);
  assert.equal(acceptTokenValues(`${TOKEN}\n`, MANIFEST, []), null);
  // An ARRAY declaration of ONE name answers the named way: the declaration's shape, not the count.
  assert.deepEqual(acceptTokenValues(`APP_API_TOKEN=${TOKEN}\n`, MANIFEST, ["APP_API_TOKEN"], { named: true }), { values: { APP_API_TOKEN: TOKEN } });
  assert.equal(acceptTokenValues(`${TOKEN}\n`, MANIFEST, ["APP_API_TOKEN"], { named: true }), null);
});

test("acceptTokenValues: an array answer is one NAME=value line per name, all of them or nothing", () => {
  const names = ["APP_CLIENT_ID", "APP_CLIENT_SECRET"];
  assert.deepEqual(acceptTokenValues(MULTI_ANSWER, MULTI, names), { values: { APP_CLIENT_ID: CLIENT_ID, APP_CLIENT_SECRET: CLIENT_SECRET } });
  assert.deepEqual(
    acceptTokenValues(`APP_CLIENT_SECRET=${CLIENT_SECRET}\nAPP_CLIENT_ID=${CLIENT_ID}\n`, MULTI, names),
    { values: { APP_CLIENT_ID: CLIENT_ID, APP_CLIENT_SECRET: CLIENT_SECRET } },
    "the order of the lines is the script's business",
  );
  for (const bad of [
    `APP_CLIENT_ID=${CLIENT_ID}\n`,                                              // a missing line
    `APP_CLIENT_ID=${CLIENT_ID}\nAPP_CLIENT_SECRET=${CLIENT_SECRET}\nEXTRA=x\n`,  // one line too many
    `APP_CLIENT_ID=${CLIENT_ID}\nAPP_CLIENT_ID=${CLIENT_ID}\n`,                 // a repeated name
    `APP_CLIENT_ID=${CLIENT_ID}\nNOPE=${CLIENT_SECRET}\n`,                      // an undeclared name
    `${CLIENT_ID}\n${CLIENT_SECRET}\n`,                                          // no names at all
    `APP_CLIENT_ID=${CLIENT_ID}\nAPP_CLIENT_SECRET=short\n`,                    // fails its own pattern
    `APP_CLIENT_ID=${CLIENT_ID}\nAPP_CLIENT_SECRET=${CLIENT_SECRET}\n\n`,       // a blank extra line
    `APP_CLIENT_ID=${CLIENT_ID}\r\nAPP_CLIENT_SECRET=${CLIENT_SECRET}\r\n`,     // CRLF
    "",
    "\n",
  ]) {
    assert.equal(acceptTokenValues(bad, MULTI, names), null, JSON.stringify(bad));
  }
});

test("runApiToken: an array answer saves every value, each with its own generated policy", async () => {
  const { scriptDir, destDir } = dirs();
  const saves = [];
  const out = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "minted two\n", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }),
      save: async (o) => { saves.push(o); return { ok: true, needs_restart: o.envKey === "APP_CLIENT_SECRET" }; },
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal(out.result, "ok");
  assert.equal(out.mcpEnvUpdated, true, "a save that wrote the MCP entry asks for the restart");
  assert.deepEqual(saves.map((s) => [s.envKey, s.value]), [
    ["APP_CLIENT_ID", CLIENT_ID],
    ["APP_CLIENT_SECRET", CLIENT_SECRET],
  ]);
  for (const s of saves) {
    assert.equal(s.origin, "generated");
    assert.equal(s.propagate, false);
    assert.equal(s.firstWriterWins, true);
  }
  assert.equal(JSON.stringify(out).includes(CLIENT_SECRET), false, "no value is ever a field of the answer");
});

test("runApiToken: a partial array answer saves NOTHING — all values are accepted first", async () => {
  const { scriptDir, destDir } = dirs();
  let saves = 0;
  for (const secret of [
    `APP_CLIENT_ID=${CLIENT_ID}\n`,
    `APP_CLIENT_ID=${CLIENT_ID}\nAPP_CLIENT_SECRET=short\n`,
    `APP_CLIENT_ID=${CLIENT_ID}\nNOPE=x\n`,
  ]) {
    const out = await runApiToken({
      bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
      deps: {
        runner: async () => ({ stdout: "", stderr: "", secret, secretOverflow: false }),
        save: async () => { saves += 1; return { ok: true, needs_restart: false }; },
        stillInstalled: STILL,
        adminPassword: async () => PASSWORD,
        warn: () => {},
      },
    });
    assert.equal(out.result, "failed", JSON.stringify(secret));
    assert.equal(out.reason, "the app answered with something that is not an API token");
  }
  assert.equal(saves, 0, "a half-read answer writes nothing at all");
});

test("runApiToken: every key already valued is skipped; a half-old half-new set is never ok", async () => {
  const { scriptDir, destDir } = dirs();
  const removed = [];
  const runWith = (refusals, { removable = true } = {}) => runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }),
      save: async (o) => (refusals.includes(o.envKey)
        ? { ok: false, status: 409, error: API_KEY_SAVE_REFUSALS.has_value }
        : { ok: true, needs_restart: false }),
      removeValue: async (o) => { removed.push(o.envKey); return removable; },
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal((await runWith(["APP_CLIENT_ID", "APP_CLIENT_SECRET"])).result, "skipped-has-value");
  assert.deepEqual(removed, [], "nothing of this run's was saved, so there is nothing to take back");
  // One name already had a value while the other was saved by this run: a mixed set is not a
  // connection Crow made, so the value it wrote comes back out and the run says failed.
  const mixed = await runWith(["APP_CLIENT_ID"]);
  assert.equal(mixed.result, "failed");
  assert.equal(
    mixed.reason,
    "Some of this extension's API settings already had a value while others did not, so Crow took back the values it had just saved",
  );
  assert.deepEqual(removed, ["APP_CLIENT_SECRET"], "exactly the value this run saved");
  assert.equal(JSON.stringify(mixed).includes(CLIENT_SECRET), false, "no value in the answer");
  // The same mixed set when the value cannot be taken back: still failed, and it says so.
  removed.length = 0;
  const stuck = await runWith(["APP_CLIENT_ID"], { removable: false });
  assert.equal(stuck.result, "failed");
  assert.equal(
    stuck.reason,
    "Crow saved some of this extension's API settings but could not take them back, so some of them are filled in and others are not",
  );
  assert.deepEqual(removed, ["APP_CLIENT_SECRET"]);
  // Any OTHER refusal is a failure, with the save's own fixed sentence (and any earlier value
  // this run had written is taken back too).
  const failed = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }),
      save: async (o) => (o.envKey === "APP_CLIENT_SECRET"
        ? { ok: false, status: 500, error: API_KEY_SAVE_REFUSALS.keychain }
        : { ok: true, needs_restart: false }),
      removeValue: async () => true,
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal(failed.result, "failed");
  assert.equal(failed.reason, API_KEY_SAVE_REFUSALS.keychain);
  assert.equal(JSON.stringify(failed).includes(CLIENT_SECRET), false);
});

// ── 4e. a two-value save is all or nothing, from both ends ───────────────────

/** `deps` for a pre-check test: which names already hold a value, and what the run does. */
function prefillDeps({ inEntry = [], inKeychain = [] } = {}) {
  const calls = { ran: 0, saved: [] };
  return {
    calls,
    deps: {
      runner: async () => { calls.ran += 1; return { stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }; },
      save: async (o) => { calls.saved.push(o.envKey); return { ok: true, needs_restart: false }; },
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      mcpValue: (id, envKey) => (inEntry.includes(envKey) ? CLIENT_ID : ""),
      hasKeychainRow: async (id, envKey) => inKeychain.includes(envKey),
      warn: () => {},
    },
  };
}

const PREFILLED_SENTENCE = "Some of this extension's API settings are already filled in and others are not, so Crow left them alone.";

test("runApiToken: a half-filled two-value extension is left alone BEFORE the script runs", async () => {
  const { scriptDir, destDir } = dirs();
  // Either source counts as "it already holds a value": its own MCP entry, or an active row.
  for (const sources of [{ inEntry: ["APP_CLIENT_ID"] }, { inKeychain: ["APP_CLIENT_SECRET"] }]) {
    const { calls, deps } = prefillDeps(sources);
    const out = await runApiToken({ bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP, deps });
    assert.equal(out.result, "failed", JSON.stringify(sources));
    assert.equal(out.reason, PREFILLED_SENTENCE, JSON.stringify(sources));
    assert.deepEqual(out.log, []);
    assert.equal(calls.ran, 0, "the script never runs: there is nothing it could do that is safe");
    assert.deepEqual(calls.saved, [], "and nothing is saved");
    assert.equal(JSON.stringify(out).includes(CLIENT_ID), false);
  }
});

test("runApiToken: a two-value extension that already holds every value is skipped, script not run", async () => {
  const { scriptDir, destDir } = dirs();
  const { calls, deps } = prefillDeps({ inEntry: ["APP_CLIENT_ID"], inKeychain: ["APP_CLIENT_SECRET"] });
  const out = await runApiToken({ bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP, deps });
  assert.deepEqual(out, { result: "skipped-has-value", log: [] });
  assert.equal(calls.ran, 0);
  assert.deepEqual(calls.saved, []);
});

test("runApiToken: a PLACEHOLDER is not a value, so a two-value run still goes ahead", async () => {
  const { scriptDir, destDir } = dirs();
  let runnerRan = 0;
  const out = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => { runnerRan += 1; return { stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }; },
      save: async () => ({ ok: true, needs_restart: false }),
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      mcpValue: () => "change-me",
      hasKeychainRow: () => false,
      warn: () => {},
    },
  });
  assert.equal(runnerRan, 1, "a placeholder is what Crow itself wrote as a default, not the owner's value");
  assert.equal(out.result, "ok");
});

test("runApiToken: a later save that answers has_value takes the earlier value back", async () => {
  const { scriptDir, destDir } = dirs();
  const removed = [];
  const out = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "minted two\n", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }),
      save: async (o) => (o.envKey === "APP_CLIENT_SECRET"
        ? { ok: false, status: 409, error: API_KEY_SAVE_REFUSALS.has_value }
        : { ok: true, needs_restart: true }),
      removeValue: async (o) => { removed.push(o); return true; },
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal(out.result, "failed", "never ok: the extension would hold a new id beside an old secret");
  assert.equal(
    out.reason,
    "Some of this extension's API settings already had a value while others did not, so Crow took back the values it had just saved",
  );
  assert.deepEqual(removed.map((r) => [r.bundleId, r.envKey]), [["demo-app", "APP_CLIENT_ID"]], "the value this run saved, and only that one");
  assert.equal("mcpEnvUpdated" in out, false, "nothing was left written, so nothing needs a restart");
  assert.equal(JSON.stringify(out).includes(CLIENT_ID), false);
  assert.equal(JSON.stringify(out).includes(CLIENT_SECRET), false);
});

test("runApiToken: a later save that THROWS takes the earlier value back too", async () => {
  const { scriptDir, destDir } = dirs();
  for (const removal of [{ seam: async () => true, reason: "Crow could not save the app's API token" }, { seam: async () => false, reason: null }]) {
    const removed = [];
    const out = await runApiToken({
      bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
      deps: {
        runner: async () => ({ stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }),
        save: async (o) => {
          if (o.envKey === "APP_CLIENT_SECRET") throw new Error("boom");
          return { ok: true, needs_restart: false };
        },
        removeValue: async (o) => { removed.push(o.envKey); return removal.seam(); },
        stillInstalled: STILL,
        adminPassword: async () => PASSWORD,
        warn: () => {},
      },
    });
    assert.equal(out.result, "failed");
    assert.deepEqual(removed, ["APP_CLIENT_ID"], "the id this run had already saved is removed");
    assert.equal(
      out.reason,
      removal.reason ?? "Crow saved some of this extension's API settings but could not take them back, so some of them are filled in and others are not",
    );
  }
  // A removal seam that itself throws is the same answer, never a half-reported ok.
  const out = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }),
      save: async (o) => (o.envKey === "APP_CLIENT_SECRET" ? { ok: false, status: 500, error: API_KEY_SAVE_REFUSALS.keychain } : { ok: true }),
      removeValue: async () => { throw new Error("keychain closed"); },
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal(out.result, "failed");
  assert.match(out.reason, /could not take them back/);
});

test("runApiToken: a refused multi-value answer hides each bare value, not only whole lines", async () => {
  const { scriptDir, destDir } = dirs();
  // The answer is unusable (a line too many), so `values` stays null: nothing but the fd-3
  // text knows the values, while the script's own stdout and stderr quote one of them.
  const out = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => {
        throw Object.assign(new Error("exit 1"), {
          exitCode: 1,
          stdout: `minted ${CLIENT_SECRET}\n`,
          stderr: `could not use ${CLIENT_SECRET}\n`,
          secret: `APP_CLIENT_ID=${CLIENT_ID}\nAPP_CLIENT_SECRET=${CLIENT_SECRET}\nEXTRA=x\n`,
        });
      },
      save: async () => ({ ok: true, needs_restart: false }),
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal(out.result, "failed");
  assert.equal(out.log.join("\n").includes(CLIENT_SECRET), false, out.log.join("\n"));
  assert.equal(String(out.reason).includes(CLIENT_SECRET), false, out.reason);
  assert.match(out.reason, /\[hidden\]/, "the value's place in the reason is kept, the value is not");
  assert.equal(JSON.stringify(out).includes(CLIENT_SECRET), false);
});

// ── 4d. `stdin: "admin-password"`: the keychain's admin password, one line ─────

test("runApiToken: the keychain's admin password is written to stdin, and nowhere else", async () => {
  const { scriptDir, destDir } = dirs();
  const calls = { runner: [], asked: [] };
  const captured = captureWarn();
  let out;
  try {
    out = await runApiToken({
      bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, crowHome: "/tmp/scratch-home", installStamp: STAMP,
      deps: {
        runner: async (cmd, args, opts) => {
          calls.runner.push({ cmd, args, opts });
          return { stdout: "signed in\n", stderr: "", secret: MULTI_ANSWER, secretOverflow: false };
        },
        save: async () => ({ ok: true, needs_restart: false }),
        stillInstalled: STILL,
        adminPassword: async (o) => { calls.asked.push(o); return PASSWORD; },
        warn: (m) => console.warn(m),
      },
    });
  } finally {
    captured.restore();
  }
  assert.equal(out.result, "ok");
  assert.equal(calls.runner.length, 1);
  assert.equal(calls.runner[0].opts.input, `${PASSWORD}\n`, "ONE line on stdin, exactly like the first-admin protocol");
  assert.deepEqual(calls.asked, [{ bundleId: "demo-app", envKey: "APP_ADMIN_PASSWORD", crowHome: "/tmp/scratch-home" }]);
  // Nowhere near an environment variable, an argument, a log line or the answer.
  assert.equal(Object.values(calls.runner[0].opts.env).includes(PASSWORD), false);
  assert.equal(calls.runner[0].args.join(" ").includes(PASSWORD), false);
  assert.equal(JSON.stringify(out).includes(PASSWORD), false);
  assert.equal(captured.lines.join("\n").includes(PASSWORD), false, "the password never reaches a log line");
});

test("runApiToken: a password the script prints is scrubbed out of the log and the reason", async () => {
  const { scriptDir, destDir } = dirs();
  const out = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => ({ stdout: `signing in as admin with ${PASSWORD}\n`, stderr: `debug: ${PASSWORD}\n`, secret: MULTI_ANSWER, secretOverflow: false }),
      save: async () => ({ ok: true, needs_restart: false }),
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal(out.result, "ok");
  assert.deepEqual(out.log, ["signing in as admin with [hidden]", "debug: [hidden]"]);
  assert.equal(JSON.stringify(out).includes(PASSWORD), false);
  // ...and on a failure path too, where the script names it in the reason.
  const failed = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => { throw Object.assign(new Error("exit 1"), { exitCode: 1, stdout: "", stderr: `login refused for ${PASSWORD}` }); },
      save: async () => ({ ok: true, needs_restart: false }),
      stillInstalled: STILL,
      adminPassword: async () => PASSWORD,
      warn: () => {},
    },
  });
  assert.equal(failed.result, "failed");
  assert.equal(failed.reason.includes(PASSWORD), false, failed.reason);
  assert.match(failed.reason, /\[hidden\]/);
});

test("runApiToken: no admin password in the keychain means nothing runs, and no value is guessed", async () => {
  const { scriptDir, destDir } = dirs();
  for (const answer of [null, "", undefined]) {
    let runnerRan = 0;
    const out = await runApiToken({
      bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
      deps: {
        runner: async () => { runnerRan += 1; return { stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }; },
        save: async () => { throw new Error("must not be called"); },
        stillInstalled: STILL,
        adminPassword: async () => answer,
        warn: () => {},
      },
    });
    assert.equal(out.result, "failed", String(answer));
    assert.match(out.reason, /no admin password saved for this app/);
    assert.equal(out.log.length, 0);
    assert.equal(runnerRan, 0, "the script is not run without a password to sign in with");
  }
  // A keychain reader that cannot answer is the same answer, never a throw.
  const broken = await runApiToken({
    bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async () => { throw new Error("must not run"); },
      save: async () => ({}),
      stillInstalled: STILL,
      adminPassword: async () => { throw new Error("keychain closed"); },
      warn: () => {},
    },
  });
  assert.equal(broken.result, "failed");
  assert.match(broken.reason, /no admin password saved for this app/);
});

test("runApiToken: an env-admin manifest without a user names none, and stdin stays closed without `stdin`", async () => {
  const { scriptDir, destDir } = dirs();
  const calls = [];
  const manifest = {
    ...ENV_ADMIN,
    firstAdmin: { ...ENV_ADMIN.firstAdmin, token: { script: "scripts/api-token.sh", env: "APP_API_TOKEN" } },
  };
  const out = await runApiToken({
    bundleId: "demo-app", manifest, scriptDir, destDir, installStamp: STAMP,
    deps: {
      runner: async (cmd, args, opts) => { calls.push(opts); return { stdout: "", stderr: "", secret: `${TOKEN}\n`, secretOverflow: false }; },
      save: async () => ({ ok: true, needs_restart: false }),
      stillInstalled: STILL,
      warn: () => {},
    },
  });
  assert.equal(out.result, "ok");
  assert.equal("input" in calls[0], false, "no stdin without the declaration");
  assert.equal("CROW_FIRST_ADMIN_USER" in calls[0].env, false, "an empty username is not passed as a default to fall back from");
});

test("runApiToken: the real keychain reader hands the admin password to the script on stdin", async () => {
  // No injected reader: the default one opens this instance's crow.db, loads the keychain key
  // from CROW_HOME and opens the bundle's `firstAdmin.secretEnv` row — the same reader the
  // first-admin path keeps its password with.
  const Database = (await import("better-sqlite3")).default;
  const { KEYCHAIN_DDL } = await import("../servers/gateway/keychain/schema.js");
  const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
  const { saveExtensionSecret } = await import("../servers/gateway/keychain/store.js");

  const home = mkdtempSync(join(TMP, "home-"));
  const dbDir = mkdtempSync(join(TMP, "db-"));
  const dbPath = join(dbDir, "crow.db");
  const raw = new Database(dbPath);
  try {
    raw.exec(KEYCHAIN_DDL);
    const wrapper = {
      async execute(q) {
        const { sql, args = [] } = typeof q === "string" ? { sql: q } : q;
        const st = raw.prepare(sql);
        if (st.reader) return { rows: st.all(...args) };
        const r = st.run(...args);
        return { rows: [], lastInsertRowid: r.lastInsertRowid, rowsAffected: r.changes };
      },
      async executeMultiple(sql) { raw.exec(sql); },
    };
    const key = createKeychainKey({ crowHome: home });
    await saveExtensionSecret(wrapper, key, {
      bundleId: "demo-app",
      envKey: "APP_ADMIN_PASSWORD",
      label: "Demo App — admin login",
      secret: PASSWORD,
      origin: "generated",
    });

    const previous = process.env.CROW_DB_PATH;
    process.env.CROW_DB_PATH = dbPath;
    try {
      const { scriptDir, destDir } = dirs();
      const seen = [];
      const out = await runApiToken({
        bundleId: "demo-app", manifest: MULTI, scriptDir, destDir, crowHome: home, installStamp: STAMP,
        deps: {
          runner: async (cmd, args, opts) => { seen.push(opts); return { stdout: "", stderr: "", secret: MULTI_ANSWER, secretOverflow: false }; },
          save: async () => ({ ok: true, needs_restart: false }),
          stillInstalled: STILL,
          warn: () => {},
        },
      });
      assert.equal(out.result, "ok");
      assert.equal(seen[0].input, `${PASSWORD}\n`, "the keychain row really is what the script gets");
      assert.equal(JSON.stringify(out).includes(PASSWORD), false);
    } finally {
      if (previous === undefined) delete process.env.CROW_DB_PATH;
      else process.env.CROW_DB_PATH = previous;
    }
  } finally {
    try { raw.close(); } catch { /* already closed */ }
  }
});

// ── 5. the contract can express a token step ───────────────────────────────────────

test("the manifest schema carries firstAdmin.setup.token, so a bundle can declare one", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "registry", "manifest.schema.json"), "utf8"));
  const setup = schema.properties.firstAdmin.properties.setup;
  assert.ok(setup.properties.token, "firstAdmin.setup.token is declared");
  assert.deepEqual(setup.properties.token.required, ["script", "env"]);
  assert.deepEqual(Object.keys(setup.properties.token.properties).sort(), ["env", "script", "stdin", "timeout_s"]);
  // ...and so is the via "env" location, beside secretEnv.
  const fa = schema.properties.firstAdmin.properties;
  assert.ok(fa.token, "firstAdmin.token is declared for a via \"env\" admin");
  assert.deepEqual(fa.token.required, ["script", "env"]);
  assert.deepEqual(Object.keys(fa.token.properties).sort(), ["env", "script", "stdin", "timeout_s"]);
});

// ── 6. spawnGroup's secretFd ───────────────────────────────────────────────────────

test("spawnGroup secretFd: fd 3 is collected apart from stdout and stderr", async () => {
  const env = { PATH: process.env.PATH };
  const out = await spawnGroup("bash", ["-c", "echo to-stdout; echo to-stderr >&2; printf 'abc\\n' >&3"], { env, timeout: 10_000, secretFd: true });
  assert.deepEqual(out, { stdout: "to-stdout\n", stderr: "to-stderr\n", secret: "abc\n", secretOverflow: false });
  // The shapes are exactly today's when the option is not asked for.
  const plain = await spawnGroup("bash", ["-c", "echo to-stdout"], { env, timeout: 10_000 });
  assert.deepEqual(plain, { stdout: "to-stdout\n", stderr: "" });
  assert.deepEqual(Object.keys(plain), ["stdout", "stderr"]);
});

test("spawnGroup secretFd: the cap is a refusal, not a truncation", async () => {
  const env = { PATH: process.env.PATH };
  const write = (n) => ["-c", `head -c ${n} /dev/zero | tr '\\0' 'x' >&3`];
  const exact = await spawnGroup("bash", write(SECRET_FD_MAX_BYTES), { env, timeout: 20_000, secretFd: true });
  assert.equal(exact.secretOverflow, false);
  assert.equal(exact.secret.length, SECRET_FD_MAX_BYTES);
  const over = await spawnGroup("bash", write(SECRET_FD_MAX_BYTES + 1), { env, timeout: 20_000, secretFd: true });
  assert.equal(over.secretOverflow, true);
  assert.equal(over.secret, "", "an oversized answer is dropped, never handed on truncated");
});

test("spawnGroup secretFd: a rejection carries secret and secretOverflow, but not enumerably", async () => {
  const env = { PATH: process.env.PATH };
  let caught = null;
  try {
    await spawnGroup("bash", ["-c", "printf 'supersecret-token\\n' >&3; echo bad >&2; exit 3"], { env, timeout: 10_000, secretFd: true });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "a non-zero exit rejects");
  assert.equal(caught.exitCode, 3);
  assert.equal(caught.secret, "supersecret-token\n", "the caller can still read it deliberately");
  assert.equal(caught.secretOverflow, false);
  assert.equal(Object.keys(caught).includes("secret"), false);
  assert.equal(Object.keys(caught).includes("secretOverflow"), false);
  assert.equal(Object.keys(caught).includes("exitCode"), true, "the rest of the error is unchanged");
  assert.equal(JSON.stringify(caught).includes("supersecret-token"), false);
  assert.deepEqual(Object.keys({ ...caught }).filter((k) => k === "secret"), []);
});