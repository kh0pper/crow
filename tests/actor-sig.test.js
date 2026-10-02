// S2 (2026-10-02): the actor-signing key and its handoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  initGatewayActorKey, setActorKey, hasActorKey, signActor, verifyActorSig,
  readActorKeyFromStdin, _resetActorKeyForTest,
} from "../scripts/pi-bots/actor-sig.mjs";
import { crowServerCatalog } from "../scripts/pi-bots/crow-server-catalog.mjs";
import { superviseProcess } from "../servers/gateway/process-supervisor.js";

const A = { kind: "bot", botId: "bobby", threadId: "discord:42", gatewayType: "discord" };

test("no key: nothing is signed and nothing verifies; the catalog writes no signature", () => {
  _resetActorKeyForTest();
  assert.equal(hasActorKey(), false);
  assert.equal(signActor(A), null);
  assert.equal(verifyActorSig({ ...A, sig: "a".repeat(64) }), false);
  const home = mkdtempSync(join(tmpdir(), "actor-sig-cat-"));
  writeFileSync(join(home, "phone-token"), "tok", { mode: 0o600 });
  const { servers } = crowServerCatalog(home, { botId: "bobby", threadId: "perch-7", gatewayType: "perch" });
  assert.equal(servers.phone.headers["X-Crow-Actor-Sig"], undefined);
  assert.equal(servers.phone.headers["X-Crow-Actor-Id"], "bobby");
  rmSync(home, { recursive: true, force: true });
});

test("a signature binds bot, thread AND gateway; a fresh boot key invalidates old signatures", () => {
  _resetActorKeyForTest();
  initGatewayActorKey();
  const sig = signActor(A);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyActorSig({ ...A, sig }), true);
  assert.equal(verifyActorSig({ ...A, botId: "mallory", sig }), false);
  assert.equal(verifyActorSig({ ...A, threadId: "discord:43", sig }), false);
  assert.equal(verifyActorSig({ ...A, gatewayType: "perch", sig }), false);
  assert.equal(verifyActorSig({ ...A, sig: sig.toUpperCase() }), true, "hex case is not significant");
  // Field boundaries are unambiguous: moving text between fields changes the MAC.
  assert.notEqual(signActor({ botId: "a", threadId: "b\nc" }), signActor({ botId: "a\nb", threadId: "c" }));
  _resetActorKeyForTest();
  initGatewayActorKey();
  assert.equal(verifyActorSig({ ...A, sig }), false);
});

test("initGatewayActorKey is idempotent within a boot; setActorKey accepts only 32-byte keys", () => {
  _resetActorKeyForTest();
  const k1 = initGatewayActorKey();
  assert.equal(initGatewayActorKey(), k1);
  _resetActorKeyForTest();
  assert.equal(setActorKey("abc"), false);
  assert.equal(setActorKey(Buffer.alloc(16)), false);
  assert.equal(setActorKey(k1.toString("hex")), true);
  assert.equal(signActor(A).length, 64);
});

test("the key is never written to the environment or to CROW_HOME", () => {
  _resetActorKeyForTest();
  const hex = initGatewayActorKey().toString("hex");
  for (const v of Object.values(process.env)) assert.equal(String(v).includes(hex), false);
  const src = readFileSync(new URL("../scripts/pi-bots/actor-sig.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /writeFileSync|process\.env\[|process\.env\.[A-Z_]+\s*=/);
});

test("child side: the key arrives on stdin; an empty stdin leaves no key", async () => {
  _resetActorKeyForTest();
  const hex = Buffer.alloc(32, 7).toString("hex");
  const s1 = new PassThrough(); s1.end(hex + "\n");
  assert.equal(await readActorKeyFromStdin(s1, 1000), true);
  const sig = signActor(A);
  _resetActorKeyForTest();
  setActorKey(hex);
  assert.equal(verifyActorSig({ ...A, sig }), true, "child and gateway derive the same signature");
  _resetActorKeyForTest();
  const s2 = new PassThrough(); s2.end();
  assert.equal(await readActorKeyFromStdin(s2, 1000), false);
});

test("supervisor: stdinPayload is piped to EVERY spawn (respawns included), and stdin stays ignored without it", () => {
  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = opts.stdio[0] === "pipe" ? new PassThrough() : null;
    child.written = "";
    if (child.stdin) child.stdin.on("data", (d) => { child.written += d; });
    spawned.push({ opts, child });
    return child;
  };
  const timers = [];
  const h = superviseProcess({ key: "t", command: "node", args: [], spawn: fakeSpawn, maxRestarts: 2,
    stdinPayload: () => "deadbeef\n", setTimeoutFn: (fn) => { timers.push(fn); return 1; }, clearTimeoutFn: () => {} });
  assert.equal(h.key, "t");
  assert.equal(spawned[0].opts.stdio[0], "pipe");
  assert.equal(spawned[0].opts.env, undefined, "the payload does not ride in env");
  spawned[0].child.emit("exit", 1, null);
  timers.shift()();
  assert.equal(spawned.length, 2);
  for (const { child } of spawned) assert.equal(child.written, "deadbeef\n");
  const plain = [];
  superviseProcess({ key: "u", command: "node", spawn: (c, a, o) => { plain.push(o); return new EventEmitter(); } });
  assert.equal(plain[0].stdio[0], "ignore");
});

test("bot runtime hands the key to the Discord child over stdin, never env", () => {
  const src = readFileSync(new URL("../servers/gateway/bot-runtime.js", import.meta.url), "utf8");
  assert.match(src, /stdinPayload: \(\) => initGatewayActorKey\(\)\.toString\("hex"\)/);
  assert.match(src, /CROW_ACTOR_KEY_STDIN: "1"/);
  const dg = readFileSync(new URL("../scripts/pi-bots/discord_gateway.mjs", import.meta.url), "utf8");
  assert.match(dg, /await readActorKeyFromStdin\(\)/);
});
