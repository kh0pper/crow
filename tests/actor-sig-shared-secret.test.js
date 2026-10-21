// Board-only shared actor secret (2026-10-20, fix round 1): an
// operator-provisioned secret FILE (CROW_BOARD_ACTOR_SECRET_FILE, or the
// systemd credential $CREDENTIALS_DIRECTORY/board-actor-secret) lets an
// out-of-gateway runner sign board actor headers that the gateway verifies,
// without the gateway's per-boot key. Only the derived key is held, in
// memory; the env never carries the secret; shared-secret mode needs an
// active pi sandbox; phone and artifacts signing stay per-boot.
import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, chmodSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
process.env.CROW_PI_SANDBOX = "off";
for (const k of ["CROW_BOARD_ACTOR_SECRET", "CROW_BOARD_ACTOR_SECRET_FILE", "CREDENTIALS_DIRECTORY"]) delete process.env[k];

const {
  initGatewayActorKey, signActor, verifyActorSig, signBoardActor, verifyBoardActorSig,
  signArtifactsActor, verifyArtifactsActorSig, boardSigningMode, initBoardSigning, setBoardKey,
  decodeBoardSecret, boardKeyHandoff, readActorKeyFromStdin, _resetActorKeyForTest,
} = await import("../scripts/pi-bots/actor-sig.mjs");
const { buildBotBaseEnv, withoutBoardActorSecret, BOARD_ACTOR_SECRET_ENV } = await import("../servers/shared/bot-env.js");
const { superviseProcess } = await import("../servers/gateway/process-supervisor.js");
const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { resolveActor, rejectedBoardSigCount, _resetRejectedBoardSigsForTest } = await import("../servers/gateway/board-mcp.js");

const HEX = Buffer.alloc(32, 0x5a).toString("hex");
const HEX2 = Buffer.alloc(32, 0x3c).toString("hex");
const B64 = Buffer.alloc(32, 0x5a).toString("base64");
const BOARD = { botId: "bot-1", jobId: "j-77" };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const active = () => "active";
const dirs = [];

// Stand-in for /run/credentials: the accepted-roots test seam points here.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "actor-cred-root-")));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const init = (o = {}) => initBoardSigning({ sandboxStatus: active, _credentialRoots: [ROOT], ...o });

/** A unit's credentials dir holding board-actor-secret; returns { dir, file, env }. */
function secretFile(content = HEX + "\n", { mode = 0o600 } = {}) {
  const dir = mkdtempSync(join(ROOT, "unit-"));
  const file = join(dir, "board-actor-secret");
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return { dir, file, env: { CREDENTIALS_DIRECTORY: dir } };
}
function captureWarn() {
  const msgs = [];
  return { msgs, warn: (m) => msgs.push(String(m)) };
}

afterEach(() => {
  for (const k of ["CROW_BOARD_ACTOR_SECRET", "CROW_BOARD_ACTOR_SECRET_FILE", "CREDENTIALS_DIRECTORY", "CROW_BOT_ENV_PASSTHROUGH"]) delete process.env[k];
  _resetActorKeyForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a runner with no per-boot key signs from the file; a gateway holding the same file verifies", () => {
  const { env } = secretFile();
  assert.equal(init({ env, sandboxStatus: active }), "shared-secret");
  const sig = signBoardActor(BOARD);
  assert.match(sig, /^[0-9a-f]{64}$/);
  // The gateway: its own per-boot key, plus the same secret file.
  _resetActorKeyForTest();
  initGatewayActorKey();
  assert.equal(init({ env, sandboxStatus: active }), "shared-secret");
  assert.equal(verifyBoardActorSig({ ...BOARD, sig }), true);
  assert.equal(verifyBoardActorSig({ botId: "bot-2", jobId: "j-77", sig }), false, "bound to the bot");
  assert.equal(verifyBoardActorSig({ botId: "bot-1", jobId: null, sig }), false, "bound to the job");
  const derived = createHmac("sha256", Buffer.from(HEX, "hex")).update("crow-board-actor-v1").digest();
  assert.equal(sig, createHmac("sha256", derived).update(JSON.stringify(["crow-actor-v1", "board", "bot-1", "j-77", ""])).digest("hex"));
  // A gateway WITHOUT the secret (per-boot only) rejects it.
  _resetActorKeyForTest();
  initGatewayActorKey();
  assert.equal(verifyBoardActorSig({ ...BOARD, sig }), false);
});

test("a 0400 base64 credential works and derives the same key as the hex one", () => {
  assert.equal(init({ env: secretFile(B64, { mode: 0o400 }).env }), "shared-secret");
  const a = signBoardActor(BOARD);
  _resetActorKeyForTest();
  assert.equal(init({ env: secretFile(HEX).env }), "shared-secret");
  assert.equal(signBoardActor(BOARD), a);
});

test("a custom CROW_BOARD_ACTOR_SECRET_FILE is ignored with a warning (systemd credentials only)", () => {
  const s = secretFile();
  const w = captureWarn();
  assert.equal(init({ env: { CROW_BOARD_ACTOR_SECRET_FILE: s.file }, warn: w.warn }), "none");
  assert.equal(w.msgs.length, 1);
  assert.match(w.msgs[0], /CROW_BOARD_ACTOR_SECRET_FILE is ignored/);
  assert.equal(w.msgs[0].includes(HEX), false);
});

test("without the test seam, a CREDENTIALS_DIRECTORY outside /run/credentials and $XDG_RUNTIME_DIR/credentials is refused", () => {
  const s = secretFile();
  const w = captureWarn();
  assert.equal(initBoardSigning({ env: s.env, sandboxStatus: active, warn: w.warn }), "none");
  assert.equal(w.msgs.length, 1);
  assert.match(w.msgs[0], /not under \/run\/credentials\//);
});

test("a FIFO in place of the credential does not hang startup", () => {
  const dir = mkdtempSync(join(ROOT, "unit-"));
  const r = spawnSync("mkfifo", ["-m", "600", join(dir, "board-actor-secret")]);
  if (r.status !== 0) return; // no mkfifo here
  const w = captureWarn();
  assert.equal(init({ env: { CREDENTIALS_DIRECTORY: dir }, warn: w.warn }), "none");
  assert.match(w.msgs[0], /is not a regular file/);
});

test("decoding: hex, base64, base64url; odd-length hex is refused, not read as base64", () => {
  assert.equal(decodeBoardSecret(HEX).length, 32);
  assert.equal(decodeBoardSecret("  " + B64 + "\n").length, 32);
  assert.equal(decodeBoardSecret(B64.replace(/\+/g, "-").replace(/\//g, "_")).length, 32);
  const oddHex = "a".repeat(65);
  assert.equal(decodeBoardSecret(oddHex), null);
  assert.equal(decodeBoardSecret(""), null);
  assert.equal(decodeBoardSecret(Buffer.alloc(31, 2).toString("base64")), null);
});

test("phone and artifacts signatures still need the per-boot key; the secret cannot mint them", () => {
  assert.equal(init({ env: secretFile().env, sandboxStatus: active }), "shared-secret");
  const A = { botId: "bot-1", threadId: "perch-1", gatewayType: "perch" };
  assert.equal(signActor(A), null);
  assert.equal(signArtifactsActor(A), null);
  const boardSig = signBoardActor({ botId: "bot-1" });
  initGatewayActorKey();
  assert.equal(verifyActorSig({ ...A, sig: signActor(A) }), true);
  const derived = createHmac("sha256", Buffer.from(HEX, "hex")).update("crow-board-actor-v1").digest();
  const forge = (kind) => createHmac("sha256", derived).update(JSON.stringify(["crow-actor-v1", kind, "bot-1", "perch-1", "perch"])).digest("hex");
  assert.equal(verifyActorSig({ ...A, sig: forge("bot") }), false);
  assert.equal(verifyArtifactsActorSig({ ...A, sig: forge("artifacts") }), false);
  assert.equal(verifyActorSig({ botId: "bot-1", kind: "bot", sig: boardSig }), false);
  assert.equal(verifyBoardActorSig({ botId: "bot-1", sig: signActor({ kind: "board", botId: "bot-1" }) }), false,
    "a per-boot board-kind MAC is not accepted in shared-secret mode");
});

test("refused unless the pi sandbox is active", () => {
  const { env } = secretFile();
  for (const status of ["off", "active-no-pidns", "nnp-only: no bwrap", "fallback: x"]) {
    _resetActorKeyForTest();
    const w = captureWarn();
    assert.equal(init({ env, sandboxStatus: () => status, warn: w.warn }), "none");
    assert.equal(w.msgs.length, 1);
    assert.match(w.msgs[0], /board shared secret ignored: pi sandbox not active, bots could read it/);
    initGatewayActorKey();
    assert.equal(init({ env, sandboxStatus: () => status, warn: () => {} }), "per-boot");
  }
});

test("refused: symlink, group/world-readable, too short, not a file; warnings never show the value", () => {
  const cases = [];
  { const s = secretFile(); const d = mkdtempSync(join(ROOT, "unit-")); symlinkSync(s.file, join(d, "board-actor-secret")); cases.push([{ CREDENTIALS_DIRECTORY: d }, /is a symlink/]); }
  cases.push([secretFile(HEX, { mode: 0o640 }).env, /group- or world-accessible/]);
  cases.push([secretFile(HEX, { mode: 0o604 }).env, /group- or world-accessible/]);
  const short = Buffer.alloc(16, 1).toString("hex");
  cases.push([secretFile(short).env, /does not decode/]);
  { const d = mkdtempSync(join(ROOT, "unit-")); mkdirSync(join(d, "board-actor-secret")); cases.push([{ CREDENTIALS_DIRECTORY: d }, /is not a regular file/]); }
  for (const [env, re] of cases) {
    _resetActorKeyForTest();
    const w = captureWarn();
    assert.equal(init({ env, sandboxStatus: active, warn: w.warn }), "none", String(re));
    assert.equal(w.msgs.length, 1, String(re));
    assert.match(w.msgs[0], re);
    for (const v of [HEX, short]) assert.equal(w.msgs[0].includes(v), false);
  }
});

test("a unit without the board credential stays quiet", () => {
  const w = captureWarn();
  assert.equal(init({ env: { CREDENTIALS_DIRECTORY: mkdtempSync(join(ROOT, "unit-")) }, warn: w.warn }), "none");
  assert.deepEqual(w.msgs, []);
});

test("a leftover CROW_BOARD_ACTOR_SECRET in the environment is ignored, with a warning", () => {
  const w = captureWarn();
  assert.equal(init({ env: { CROW_BOARD_ACTOR_SECRET: HEX }, sandboxStatus: active, warn: w.warn }), "none");
  assert.equal(w.msgs.length, 1);
  assert.match(w.msgs[0], /CROW_BOARD_ACTOR_SECRET is ignored/);
  assert.equal(w.msgs[0].includes(HEX), false);
  assert.equal(signBoardActor(BOARD), null);
});

test("rotation: new file content (a restart) invalidates signatures made with the old secret", () => {
  const s = secretFile(HEX);
  init({ env: s.env, sandboxStatus: active });
  const oldSig = signBoardActor(BOARD);
  // restart with rotated content
  _resetActorKeyForTest();
  writeFileSync(s.file, HEX2, { mode: 0o600 });
  assert.equal(init({ env: s.env, sandboxStatus: active }), "shared-secret");
  assert.equal(verifyBoardActorSig({ ...BOARD, sig: oldSig }), false);
  assert.equal(verifyBoardActorSig({ ...BOARD, sig: signBoardActor(BOARD) }), true);
});

test("the file is read ONCE: later file changes do nothing until restart; a key from stdin is kept", () => {
  const s = secretFile(HEX);
  init({ env: s.env, sandboxStatus: active });
  const sig = signBoardActor(BOARD);
  writeFileSync(s.file, HEX2, { mode: 0o600 });
  assert.equal(init({ env: s.env, sandboxStatus: active }), "shared-secret");
  assert.equal(signBoardActor(BOARD), sig);
  _resetActorKeyForTest();
  const handed = Buffer.alloc(32, 9).toString("hex");
  setBoardKey(handed);
  init({ env: s.env, sandboxStatus: active });
  assert.equal(boardKeyHandoff(), " " + handed);
});

test("boardSigningMode: none / per-boot / shared-secret, and the secret never enters process.env", () => {
  assert.equal(boardSigningMode(), "none");
  initGatewayActorKey();
  assert.equal(boardSigningMode(), "per-boot");
  const before = { ...process.env };
  init({ env: secretFile().env, sandboxStatus: active });
  assert.equal(boardSigningMode(), "shared-secret");
  assert.deepEqual({ ...process.env }, before);
  for (const v of Object.values(process.env)) {
    assert.equal(String(v).includes(HEX), false);
    assert.equal(String(v).includes(boardKeyHandoff().trim()), false);
  }
});

test("child env builders: the base env drops a stale secret in both modes; the helper copies", () => {
  const src = { CROW_BOARD_ACTOR_SECRET: HEX, PATH: "/bin", HOME: "/h", LANG: "C" };
  assert.equal(BOARD_ACTOR_SECRET_ENV in buildBotBaseEnv(src), false);
  assert.equal(BOARD_ACTOR_SECRET_ENV in buildBotBaseEnv(src, { extraAllow: BOARD_ACTOR_SECRET_ENV }), false);
  const pass = buildBotBaseEnv({ ...src, CROW_BOT_ENV_PASSTHROUGH: "1" });
  assert.equal(BOARD_ACTOR_SECRET_ENV in pass, false);
  assert.equal(pass.LANG, "C");
  assert.equal(BOARD_ACTOR_SECRET_ENV in withoutBoardActorSecret(src), false);
  assert.equal(src.CROW_BOARD_ACTOR_SECRET, HEX, "input not mutated");
});

async function piChildEnviron({ def, extraEnv }) {
  const dir = mkdtempSync(join(tmpdir(), "actor-secret-pi-"));
  dirs.push(dir);
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
  return readFileSync(join(dir, "environ"), "utf8");
}

test("a real pi child (the PiRpc spawn behind bridge, job, Perch, skill review) has no secret, no key, no pointer in its environ", async () => {
  const s = secretFile();
  const perBoot = initGatewayActorKey().toString("hex");
  init({ env: s.env, sandboxStatus: active });
  const derived = boardKeyHandoff().trim();
  Object.assign(process.env, { CROW_BOARD_ACTOR_SECRET: HEX, CROW_BOARD_ACTOR_SECRET_FILE: s.file, CREDENTIALS_DIRECTORY: s.dir });
  const def = { permission_policy: { bash: "deny", write_paths: [] },
    spawn_env: { CROW_BOARD_ACTOR_SECRET: B64, CROW_BOARD_ACTOR_SECRET_FILE: "/x", CREDENTIALS_DIRECTORY: "/y", OTHER_SETTING: "kept" } };
  for (const passthrough of [false, true]) {
    if (passthrough) process.env.CROW_BOT_ENV_PASSTHROUGH = "1";
    const environ = await piChildEnviron({ def, extraEnv: { CROW_BOARD_ACTOR_SECRET: HEX } });
    for (const v of ["CROW_BOARD_ACTOR_SECRET", "CREDENTIALS_DIRECTORY", HEX, B64, derived, perBoot]) {
      assert.equal(environ.includes(v), false, (passthrough ? "passthrough: " : "scrubbed: ") + v.slice(0, 24));
    }
    assert.match(environ, /OTHER_SETTING=kept/);
  }
  assert.match(read("../scripts/pi-bots/job_runner.mjs"), /new bridge\.PiRpc\(/);
  assert.match(read("../servers/gateway/perch-interactive.js"), /new S\.PiRpc\(/);
  assert.match(read("../scripts/pi-bots/skill_review.mjs"), /new PiRpc\(/);
  assert.equal((read("../scripts/pi-bots/bridge.mjs").match(/\bspawn\(/g) || []).length, 1, "bridge.mjs has one spawn site (PiRpc)");
});

test("supervised children: a stale secret is stripped from an explicit env and from an inherited one", () => {
  process.env.CROW_BOARD_ACTOR_SECRET = HEX;
  const seen = [];
  const fakeSpawn = (c, a, o) => { seen.push(o); return new EventEmitter(); };
  superviseProcess({ key: "a", command: "node", spawn: fakeSpawn, env: { ...process.env, X: "1" } });
  superviseProcess({ key: "b", command: "node", spawn: fakeSpawn });
  assert.equal(BOARD_ACTOR_SECRET_ENV in seen[0].env, false);
  assert.equal(seen[0].env.X, "1");
  assert.equal(BOARD_ACTOR_SECRET_ENV in seen[1].env, false);
});

test("Discord child: gets the DERIVED board key on stdin (never in env) and its board signatures verify", async () => {
  const perBoot = initGatewayActorKey();
  init({ env: secretFile().env, sandboxStatus: active });
  const handoff = boardKeyHandoff();
  assert.match(handoff, /^ [0-9a-f]{64}$/);
  assert.equal(handoff.includes(HEX), false, "the derived key, not the secret");
  const dir = mkdtempSync(join(tmpdir(), "actor-secret-child-"));
  dirs.push(dir);
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
    const h = superviseProcess({ key: "discord-test", command: process.execPath, args: [script],
      env: { ...withoutBoardActorSecret(process.env), CROW_ACTOR_KEY_STDIN: "1" },
      stdinPayload: () => initGatewayActorKey().toString("hex") + boardKeyHandoff() + "\n", maxRestarts: 0 });
    h.child.stdout.on("data", (d) => { out += d; });
    h.child.stderr.on("data", (d) => { err += d; });
    h.child.once("close", () => resolve());
  });
  assert.ok(out.trim(), "child printed nothing; stderr: " + err);
  const r = JSON.parse(out.trim().split("\n").pop());
  assert.equal(r.ok, true);
  assert.equal(r.mode, "shared-secret");
  for (const v of ["CROW_BOARD_ACTOR_SECRET", HEX, handoff.trim(), perBoot.toString("hex")]) assert.equal(r.environ.includes(v), false);
  assert.equal(verifyBoardActorSig({ ...BOARD, sig: r.sig }), true);
  const src = read("../servers/gateway/bot-runtime.js");
  assert.match(src, /env: \{ \.\.\.withoutBoardActorSecret\(process\.env\), CROW_ACTOR_KEY_STDIN: "1" \}/);
  assert.match(src, /stdinPayload: \(\) => initGatewayActorKey\(\)\.toString\("hex"\) \+ boardKeyHandoff\(\) \+ "\\n"/);
});

test("stdin handoff stays compatible: a bare per-boot key line installs, with no board override", async () => {
  const s = new PassThrough(); s.end(HEX + "\n");
  assert.equal(await readActorKeyFromStdin(s, 1000), true);
  assert.equal(boardSigningMode(), "per-boot");
});

test("every other child spawn on the bot paths strips a stale secret", () => {
  assert.match(read("../scripts/pi-bots/mcp_writer.mjs"), /env: withoutBoardActorSecret\(Object\.assign\(\{\}, process\.env, block\.env \|\| \{\}\)\)/);
  assert.match(read("../scripts/pi-bots/gmail_io.mjs"), /env: withoutBoardActorSecret\(Object\.assign\(\{\}, process\.env, ENV\)\)/);
  assert.match(read("../scripts/pi-bots/gateways/deliver.mjs"), /env: withoutBoardActorSecret\(process\.env\)/);
  assert.match(read("../scripts/pi-bots/bridge_tick_lib.mjs"), /execFile\(NODE, \[GIO, \.\.\.args\], \{ timeout: ms, maxBuffer: 8e6, env: withoutBoardActorSecret\(process\.env\) \}/);
  assert.match(read("../servers/gateway/routes/bot-board-api.js"), /\[BRIDGE, "--inject", payload\], \{[\s\S]{0,200}env: withoutBoardActorSecret\(process\.env\)/);
});

test("startup: every process that signs board calls initBoardSigning once; the runner does it first and warns on none", () => {
  const mounts = read("../servers/gateway/boot/mcp-mounts.js");
  assert.match(mounts, /board actor signing: \$\{initBoardSigning\(\)\}/);
  const runner = read("../scripts/pi-bots/gateways/gateway_runner.mjs");
  const iInit = runner.indexOf("const boardMode = initBoardSigning();");
  assert.ok(iInit > 0 && iInit < runner.indexOf("warnIfPiLabIncompatible((m)"), "before the pi-lab check");
  assert.match(runner, /boardMode === "none"\) log\("WARNING: board actor signing: none/);
  const dg = read("../scripts/pi-bots/discord_gateway.mjs");
  assert.ok(dg.indexOf("initBoardSigning()") > dg.indexOf("await readActorKeyFromStdin()"), "Discord: after the stdin key");
  assert.match(read("../scripts/pi-bots/bridge.mjs"), /if \(import\.meta\.url === "file:\/\/" \+ process\.argv\[1\]\) \{\n  initBoardSigning\(\);/);
  assert.match(read("../scripts/pi-bots/bridge_tick.mjs"), /initBoardSigning\(\);/);
  const sig = read("../scripts/pi-bots/actor-sig.mjs");
  assert.doesNotMatch(sig, /process\.env\.CROW_BOARD_ACTOR_SECRET/, "actor-sig never reads the secret from env");
});

test("board-mcp: the first rejected board signature logs ONE warning without values; later ones are counted", () => {
  _resetRejectedBoardSigsForTest();
  const msgs = [];
  const orig = console.warn;
  console.warn = (...a) => msgs.push(a.join(" "));
  try {
    const badSig = "b".repeat(64);
    const extra = { authInfo: { clientId: "local-mcp" }, requestInfo: { headers: { "x-crow-actor-kind": "bot", "x-crow-actor-id": "bot-1", "x-crow-actor-sig": badSig } } };
    assert.deepEqual(resolveActor(extra, () => false), { kind: "bot", id: null, jobId: null });
    resolveActor(extra, () => false);
    assert.equal(rejectedBoardSigCount(), 2);
    const mine = msgs.filter((m) => m.includes("[board-mcp]"));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].includes(badSig) || mine[0].includes("bot-1"), false);
    // an absent signature is not a rejection
    const noSig = { authInfo: { clientId: "local-mcp" }, requestInfo: { headers: { "x-crow-actor-kind": "bot", "x-crow-actor-id": "bot-1" } } };
    resolveActor(noSig, () => false);
    assert.equal(rejectedBoardSigCount(), 2);
  } finally { console.warn = orig; _resetRejectedBoardSigsForTest(); }
});
