// Board-only shared actor secret (2026-10-20): an operator-provisioned
// CROW_BOARD_ACTOR_SECRET lets an out-of-gateway runner sign board actor
// headers that the gateway verifies, without the gateway's per-boot key.
// Phone and artifacts signing stay per-boot, and no child process env ever
// carries the secret.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
process.env.CROW_PI_SANDBOX = "off";
delete process.env.CROW_BOARD_ACTOR_SECRET;

const {
  initGatewayActorKey, signActor, verifyActorSig, signBoardActor, verifyBoardActorSig,
  signArtifactsActor, verifyArtifactsActorSig, boardSigningMode, initBoardSigning,
  decodeBoardSecret, boardKeyHandoff, readActorKeyFromStdin, _resetActorKeyForTest,
} = await import("../scripts/pi-bots/actor-sig.mjs");
const { buildBotBaseEnv, withoutBoardActorSecret, BOARD_ACTOR_SECRET_ENV } = await import("../servers/shared/bot-env.js");
const { superviseProcess } = await import("../servers/gateway/process-supervisor.js");
const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

const HEX = Buffer.alloc(32, 0x5a).toString("hex");
const B64 = Buffer.alloc(32, 0x5a).toString("base64");
const BOARD = { botId: "bot-1", jobId: "j-77" };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

afterEach(() => {
  delete process.env.CROW_BOARD_ACTOR_SECRET;
  delete process.env.CROW_BOT_ENV_PASSTHROUGH;
  _resetActorKeyForTest();
});

test("with the secret set, a process with no in-memory key signs, and a verifier holding the secret accepts", () => {
  _resetActorKeyForTest();
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  const sig = signBoardActor(BOARD);
  assert.match(sig, /^[0-9a-f]{64}$/, "the runner (no per-boot key) signs");
  // The gateway: its own per-boot key, plus the same secret.
  _resetActorKeyForTest();
  initGatewayActorKey();
  assert.equal(verifyBoardActorSig({ ...BOARD, sig }), true);
  assert.equal(verifyBoardActorSig({ botId: "bot-2", jobId: "j-77", sig }), false, "bound to the bot");
  assert.equal(verifyBoardActorSig({ botId: "bot-1", jobId: null, sig }), false, "bound to the job");
  // The key is HMAC-SHA256(secret, "crow-board-actor-v1"), not the raw secret.
  const derived = createHmac("sha256", Buffer.from(HEX, "hex")).update("crow-board-actor-v1").digest();
  const want = createHmac("sha256", derived).update(JSON.stringify(["crow-actor-v1", "board", "bot-1", "j-77", ""])).digest("hex");
  assert.equal(sig, want);
  // A gateway WITHOUT the secret (per-boot only) rejects the runner's signature.
  delete process.env.CROW_BOARD_ACTOR_SECRET;
  assert.equal(verifyBoardActorSig({ ...BOARD, sig }), false);
});

test("hex and base64 encodings of the same secret derive the same key", () => {
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  const a = signBoardActor(BOARD);
  process.env.CROW_BOARD_ACTOR_SECRET = B64;
  assert.equal(signBoardActor(BOARD), a);
  process.env.CROW_BOARD_ACTOR_SECRET = "  " + HEX + "\n";
  assert.equal(signBoardActor(BOARD), a, "edge whitespace is trimmed");
  assert.equal(decodeBoardSecret(B64.replace(/\+/g, "-").replace(/\//g, "_")).length, 32, "base64url accepted");
});

test("phone and artifacts signatures still need the in-memory key; the secret cannot mint them", () => {
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  const A = { botId: "bot-1", threadId: "perch-1", gatewayType: "perch" };
  assert.equal(signActor(A), null, "no per-boot key: no phone signature");
  assert.equal(signArtifactsActor(A), null, "no per-boot key: no artifacts signature");
  const boardSig = signBoardActor({ botId: "bot-1" });
  initGatewayActorKey();
  const phoneSig = signActor(A);
  assert.equal(verifyActorSig({ ...A, sig: phoneSig }), true);
  // A phone signature made in a process with only the secret would be null; one
  // forged with the derived board key does not verify as phone or artifacts.
  const derived = createHmac("sha256", Buffer.from(HEX, "hex")).update("crow-board-actor-v1").digest();
  const forged = createHmac("sha256", derived).update(JSON.stringify(["crow-actor-v1", "bot", "bot-1", "perch-1", "perch"])).digest("hex");
  assert.equal(verifyActorSig({ ...A, sig: forged }), false);
  const forgedArt = createHmac("sha256", derived).update(JSON.stringify(["crow-actor-v1", "artifacts", "bot-1", "perch-1", "perch"])).digest("hex");
  assert.equal(verifyArtifactsActorSig({ ...A, sig: forgedArt }), false);
  assert.equal(verifyActorSig({ botId: "bot-1", kind: "bot", sig: boardSig }), false, "a board sig is not a phone sig");
  // ...and a phone sig from the per-boot key is not a board sig in shared-secret mode.
  assert.equal(verifyBoardActorSig({ botId: "bot-1", sig: signActor({ kind: "board", botId: "bot-1" }) }), false);
});

test("a secret that is too short or not hex/base64 is ignored with ONE warning that never shows the value", () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const short = Buffer.alloc(16, 1).toString("hex");
    process.env.CROW_BOARD_ACTOR_SECRET = short;
    assert.equal(boardSigningMode(), "none");
    assert.equal(signBoardActor(BOARD), null, "no key at all: nothing signed");
    initGatewayActorKey();
    assert.equal(boardSigningMode(), "per-boot");
    const sig = signBoardActor(BOARD);
    delete process.env.CROW_BOARD_ACTOR_SECRET;
    assert.equal(verifyBoardActorSig({ ...BOARD, sig }), true, "fell back to the per-boot key");
    process.env.CROW_BOARD_ACTOR_SECRET = "not a secret!";
    assert.equal(boardSigningMode(), "per-boot");
    assert.equal(warns.length, 1, "exactly one warning: " + JSON.stringify(warns));
    assert.match(warns[0], /CROW_BOARD_ACTOR_SECRET/);
    assert.equal(warns[0].includes(short), false);
    assert.equal(decodeBoardSecret(""), null);
    assert.equal(decodeBoardSecret(Buffer.alloc(31, 2).toString("base64")), null);
  } finally { console.warn = orig; }
});

test("boardSigningMode reports none / per-boot / shared-secret; initBoardSigning captures and leaves env", () => {
  assert.equal(boardSigningMode(), "none");
  initGatewayActorKey();
  assert.equal(boardSigningMode(), "per-boot");
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  assert.equal(boardSigningMode(), "shared-secret");
  const before = signBoardActor(BOARD);
  assert.equal(initBoardSigning(), "shared-secret");
  assert.equal(BOARD_ACTOR_SECRET_ENV in process.env, false, "the variable left process.env");
  assert.equal(boardSigningMode(), "shared-secret", "the derived key stays in memory");
  assert.equal(signBoardActor(BOARD), before);
  assert.equal(verifyBoardActorSig({ ...BOARD, sig: before }), true);
  _resetActorKeyForTest();
  assert.equal(initBoardSigning(), "none");
});

test("child env builders: the base env drops the secret in both modes, and the helper copies", () => {
  const src = { CROW_BOARD_ACTOR_SECRET: HEX, PATH: "/bin", HOME: "/h", LANG: "C" };
  assert.equal(BOARD_ACTOR_SECRET_ENV in buildBotBaseEnv(src), false, "scrubbed");
  assert.equal(BOARD_ACTOR_SECRET_ENV in buildBotBaseEnv(src, { extraAllow: BOARD_ACTOR_SECRET_ENV }), false, "even if extra-allowed");
  const pass = buildBotBaseEnv({ ...src, CROW_BOT_ENV_PASSTHROUGH: "1" });
  assert.equal(BOARD_ACTOR_SECRET_ENV in pass, false, "passthrough");
  assert.equal(pass.LANG, "C");
  const copy = withoutBoardActorSecret(src);
  assert.equal(BOARD_ACTOR_SECRET_ENV in copy, false);
  assert.equal(src.CROW_BOARD_ACTOR_SECRET, HEX, "input not mutated");
});

async function piChildEnv({ def, extraEnv }) {
  const dir = mkdtempSync(join(tmpdir(), "actor-secret-pi-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(dir, "environ"))}, readFileSync("/proc/self/environ", "utf8"));`,
    "setTimeout(() => process.exit(0), 30);",
  ].join("\n"));
  const pi = new PiRpc({ def, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath, cliPath: stub, diagLog: () => {}, extraEnv });
  await new Promise((r) => pi.proc.on("exit", r));
  const environ = readFileSync(join(dir, "environ"), "utf8");
  rmSync(dir, { recursive: true, force: true });
  return environ;
}

test("pi children (the one PiRpc spawn behind the bridge, job, Perch and skill-review paths) never get the secret", async () => {
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  const def = { permission_policy: { bash: "deny", write_paths: [] }, spawn_env: { CROW_BOARD_ACTOR_SECRET: B64, OTHER_SETTING: "kept" } };
  const scrubbed = await piChildEnv({ def, extraEnv: { CROW_BOARD_ACTOR_SECRET: HEX } });
  assert.equal(scrubbed.includes("CROW_BOARD_ACTOR_SECRET"), false);
  assert.equal(scrubbed.includes(HEX), false);
  assert.match(scrubbed, /OTHER_SETTING=kept/, "other spawn_env keys still pass");
  process.env.CROW_BOT_ENV_PASSTHROUGH = "1";
  const passthrough = await piChildEnv({ def, extraEnv: { CROW_BOARD_ACTOR_SECRET: HEX } });
  assert.equal(passthrough.includes("CROW_BOARD_ACTOR_SECRET"), false, "passthrough mode too");
  // Every pi spawn path goes through PiRpc (no second env builder).
  assert.match(read("../scripts/pi-bots/job_runner.mjs"), /new bridge\.PiRpc\(/);
  assert.match(read("../servers/gateway/perch-interactive.js"), /new S\.PiRpc\(/);
  assert.match(read("../scripts/pi-bots/skill_review.mjs"), /new PiRpc\(/);
  assert.match(read("../scripts/pi-bots/bridge.mjs"), /new PiRpc\(/);
  const bridgeSpawns = read("../scripts/pi-bots/bridge.mjs").match(/\bspawn\(/g) || [];
  assert.equal(bridgeSpawns.length, 1, "bridge.mjs has exactly one spawn site (PiRpc)");
});

test("supervised children: the secret is stripped from an explicit env and from an inherited one", () => {
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  const seen = [];
  const fakeSpawn = (c, a, o) => { seen.push(o); return new EventEmitter(); };
  superviseProcess({ key: "a", command: "node", spawn: fakeSpawn, env: { ...process.env, X: "1" } });
  superviseProcess({ key: "b", command: "node", spawn: fakeSpawn });
  assert.equal(BOARD_ACTOR_SECRET_ENV in seen[0].env, false);
  assert.equal(seen[0].env.X, "1");
  assert.ok(seen[1].env, "inherited env replaced by a stripped copy");
  assert.equal(BOARD_ACTOR_SECRET_ENV in seen[1].env, false);
});

test("Discord child: gets the DERIVED board key on stdin (never the secret, never in env) and its board signatures verify", async () => {
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  const perBoot = initGatewayActorKey();
  const handoff = boardKeyHandoff();
  assert.match(handoff, /^ [0-9a-f]{64}$/);
  assert.equal(handoff.includes(HEX), false, "the handoff is the derived key, not the secret");
  const dir = mkdtempSync(join(tmpdir(), "actor-secret-child-"));
  const script = join(dir, "child.mjs");
  const mod = pathToFileURL(new URL("../scripts/pi-bots/actor-sig.mjs", import.meta.url).pathname).href;
  writeFileSync(script, `
    import { readFileSync } from "node:fs";
    import { readActorKeyFromStdin, signBoardActor, boardSigningMode } from ${JSON.stringify(mod)};
    const ok = process.env.CROW_ACTOR_KEY_STDIN === "1" && await readActorKeyFromStdin();
    const environ = readFileSync("/proc/self/environ", "utf8");
    process.stdout.write(JSON.stringify({ ok, environ, mode: boardSigningMode(), sig: signBoardActor(${JSON.stringify(BOARD)}) }) + "\\n");
    process.exit(0);
  `);
  let out = "", err = "";
  await new Promise((resolve) => {
    // Exactly what bot-runtime.js builds for the Discord child.
    const h = superviseProcess({ key: "discord-test", command: process.execPath, args: [script],
      env: { ...withoutBoardActorSecret(process.env), CROW_ACTOR_KEY_STDIN: "1" },
      stdinPayload: () => initGatewayActorKey().toString("hex") + boardKeyHandoff() + "\n", maxRestarts: 0 });
    h.child.stdout.on("data", (d) => { out += d; });
    h.child.stderr.on("data", (d) => { err += d; });
    h.child.once("close", () => resolve());
  });
  rmSync(dir, { recursive: true, force: true });
  assert.ok(out.trim(), "child printed nothing; stderr: " + err);
  const r = JSON.parse(out.trim().split("\n").pop());
  assert.equal(r.ok, true);
  assert.equal(r.mode, "shared-secret");
  assert.equal(r.environ.includes("CROW_BOARD_ACTOR_SECRET"), false);
  assert.equal(r.environ.includes(HEX), false);
  assert.equal(r.environ.includes(handoff.trim()), false);
  assert.equal(r.environ.includes(perBoot.toString("hex")), false);
  assert.equal(verifyBoardActorSig({ ...BOARD, sig: r.sig }), true);
  const src = read("../servers/gateway/bot-runtime.js");
  assert.match(src, /env: \{ \.\.\.withoutBoardActorSecret\(process\.env\), CROW_ACTOR_KEY_STDIN: "1" \}/);
  assert.match(src, /stdinPayload: \(\) => initGatewayActorKey\(\)\.toString\("hex"\) \+ boardKeyHandoff\(\) \+ "\\n"/);
});

test("stdin handoff stays compatible: a bare per-boot key line still installs, with no board override", async () => {
  const { PassThrough } = await import("node:stream");
  const s = new PassThrough(); s.end(HEX + "\n");
  assert.equal(await readActorKeyFromStdin(s, 1000), true);
  assert.equal(boardSigningMode(), "per-boot");
});

test("every other child spawn on the bot paths strips the secret", () => {
  assert.match(read("../scripts/pi-bots/mcp_writer.mjs"), /env: withoutBoardActorSecret\(Object\.assign\(\{\}, process\.env, block\.env \|\| \{\}\)\)/);
  assert.match(read("../scripts/pi-bots/gmail_io.mjs"), /env: withoutBoardActorSecret\(Object\.assign\(\{\}, process\.env, ENV\)\)/);
  assert.match(read("../scripts/pi-bots/gateways/deliver.mjs"), /env: withoutBoardActorSecret\(process\.env\)/);
  assert.match(read("../servers/gateway/routes/bot-board-api.js"), /\[BRIDGE, "--inject", payload\], \{[\s\S]{0,200}env: withoutBoardActorSecret\(process\.env\)/);
});

test("startup logs the mode once and never the secret; the runner warns on none", () => {
  const mounts = read("../servers/gateway/boot/mcp-mounts.js");
  assert.match(mounts, /board actor signing: \$\{initBoardSigning\(\)\}/);
  const runner = read("../scripts/pi-bots/gateways/gateway_runner.mjs");
  assert.match(runner, /const boardMode = initBoardSigning\(\);/);
  assert.match(runner, /boardMode === "none"\) log\("WARNING: board actor signing: none/);
  for (const src of [mounts, runner, read("../scripts/pi-bots/actor-sig.mjs")]) {
    assert.doesNotMatch(src, /(log|console\.\w+)\([^)]*process\.env\.CROW_BOARD_ACTOR_SECRET/);
  }
});
