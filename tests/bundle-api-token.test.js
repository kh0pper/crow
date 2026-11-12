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
 *   5. spawnGroup's `secretFd`: fd 3 collected apart from stdout/stderr, capped at 4096
 *      bytes (an overflow is refused, never truncated-and-accepted), and a rejection whose
 *      `secret` is non-enumerable (Object.keys(err) does not list it);
 *   6. the manifest schema can express the step at all (registry/manifest.schema.json).
 *
 * No database, no docker, no real app: every seam is injected, and the script cases use
 * small temporary bash files.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { apiTokenPlan, apiTokenProblems, acceptToken, scrubAll, runApiToken } =
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

// ── 5. the contract can express a token step ───────────────────────────────────────

test("the manifest schema carries firstAdmin.setup.token, so a bundle can declare one", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "registry", "manifest.schema.json"), "utf8"));
  const setup = schema.properties.firstAdmin.properties.setup;
  assert.ok(setup.properties.token, "firstAdmin.setup.token is declared");
  assert.deepEqual(setup.properties.token.required, ["script", "env"]);
  assert.deepEqual(Object.keys(setup.properties.token.properties).sort(), ["env", "script", "timeout_s"]);
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