/**
 * Live voice surfaces and the spoken heads-up (voice hand-off PR 5, Task 5.2): presence.js registers the surfaces
 * that can speak right now (a kiosk, the phone overlay, glasses) and `announce` says one short line on the one the
 * operator is still talking to. Pure: fake surfaces, a fake clock and an immediate wait; the panel-load checks run
 * the real panels in a child process against an app root that has no presence.js.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const P = await import("../servers/gateway/voice/presence.js");
const { VOICE_MODE_WINDOW_MS } = await import("../servers/gateway/voice/voice-memory.js");
const { voiceLine, VOICE_LINES } = await import("../servers/gateway/voice/voice-lines.js");
const { notifyRow, announceHandoff } = await import("../servers/gateway/voice/handoff-confirm.js");
const { harness } = await import("./fixtures/voice-turn-harness.mjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = 1_800_000_000_000;
const TASK = "research radio history";

beforeEach(() => P._resetPresenceForTest());

/** A fake live surface. → { spoken, impl, set(fields) } */
function surface(kind, { at = T0 - 1000, connected = true, busy = false, speak = null } = {}) {
  const st = { at, connected, busy };
  const spoken = [];
  const impl = {
    surface: kind,
    speak: speak || (async (t) => { spoken.push(t); return true; }),
    lastTurnAt: () => st.at,
    connected: () => st.connected,
    busy: () => (typeof st.busy === "function" ? st.busy() : st.busy),
  };
  return { spoken, impl, set: (f) => Object.assign(st, f) };
}

const waits = [];
const opts = (over = {}) => ({ now: () => T0, wait: async (ms) => { waits.push(ms); }, log: () => {}, ...over });
const completionLine = (lang = "en") => (s) => voiceLine(s === "kiosk" ? "completion_spoken_kiosk" : "completion_spoken", lang, { bot: "Writer", task: TASK });

test("speaks on the origin when it is active", async () => {
  const phone = surface("phone");
  const glasses = surface("glasses", { at: T0 - 10 });   // newer, but not the origin
  P.registerVoiceSurface("phone-1", phone.impl);
  P.registerVoiceSurface("glasses-1", glasses.impl);
  const r = await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() }));
  assert.deepEqual(r, { spokenOn: "phone-1", surface: "phone" });
  assert.deepEqual(phone.spoken, ["Writer finished research radio history. It's on your phone."]);
  assert.deepEqual(glasses.spoken, [], "it speaks once at most");
});

test("an active kiosk origin hears it too", async () => {
  const kiosk = surface("kiosk");
  P.registerVoiceSurface("kiosk-1", kiosk.impl);
  const r = await P.announce(opts({ originDeviceId: "kiosk-1", lineFor: completionLine() }));
  assert.equal(r.spokenOn, "kiosk-1");
  assert.equal(kiosk.spoken.length, 1);
});

test("falls back to the newest active personal surface", async () => {
  const origin = surface("phone", { at: T0 - VOICE_MODE_WINDOW_MS - 1 });   // out of the window
  const older = surface("phone", { at: T0 - 60_000 });
  const newer = surface("glasses", { at: T0 - 5_000 });
  const kiosk = surface("kiosk", { at: T0 - 1 });                            // newest of all, but a shared display
  P.registerVoiceSurface("phone-1", origin.impl);
  P.registerVoiceSurface("phone-2", older.impl);
  P.registerVoiceSurface("glasses-1", newer.impl);
  P.registerVoiceSurface("kiosk-1", kiosk.impl);
  const r = await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() }));
  assert.deepEqual(r, { spokenOn: "glasses-1", surface: "glasses" });
  assert.equal(newer.spoken.length, 1);
  assert.deepEqual([origin.spoken, older.spoken, kiosk.spoken], [[], [], []]);
  // A disconnected origin falls back the same way; an origin nobody registered too.
  const back = surface("phone", { connected: false });
  P.registerVoiceSurface("phone-1", back.impl);
  assert.equal((await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() }))).spokenOn, "glasses-1");
  assert.equal((await P.announce(opts({ originDeviceId: "nobody", lineFor: completionLine() }))).spokenOn, "glasses-1");
});

test("no surface in the window: nothing is spoken", async () => {
  const stale = surface("phone", { at: T0 - VOICE_MODE_WINDOW_MS - 1 });
  const never = surface("glasses", { at: null });
  const gone = surface("phone", { connected: false });
  const otherKiosk = surface("kiosk");   // active, but not the origin: a shared display is never a fallback
  P.registerVoiceSurface("phone-1", stale.impl);
  P.registerVoiceSurface("glasses-1", never.impl);
  P.registerVoiceSurface("phone-2", gone.impl);
  P.registerVoiceSurface("kiosk-2", otherKiosk.impl);
  const r = await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() }));
  assert.deepEqual(r, { spokenOn: null });
  assert.deepEqual([stale.spoken, never.spoken, gone.spoken, otherKiosk.spoken], [[], [], [], []]);
  assert.deepEqual(await P.announce(opts({ originDeviceId: "phone-1", lineFor: () => "" })), { spokenOn: null }, "an empty line is never spoken");
});

test("a kiosk never hears the task text", async () => {
  for (const lang of ["en", "es"]) {
    P._resetPresenceForTest();
    const kiosk = surface("kiosk");
    P.registerVoiceSurface("kiosk-1", kiosk.impl);
    await P.announce(opts({ originDeviceId: "kiosk-1", lineFor: completionLine(lang) }));
    assert.equal(kiosk.spoken.length, 1);
    assert.ok(!kiosk.spoken[0].includes(TASK), kiosk.spoken[0]);
    assert.ok(kiosk.spoken[0].startsWith("Writer"));
  }
  // The kiosk forms of every spoken heads-up drop {task}, in both languages (P34).
  for (const lang of ["en", "es"]) {
    for (const key of ["completion_spoken_kiosk", "completion_failed_spoken_kiosk", "start_failed_spoken_kiosk", "ended_no_result_spoken_kiosk"]) {
      assert.ok(Object.hasOwn(VOICE_LINES[lang], key), `${lang} ${key}`);
      assert.ok(!VOICE_LINES[lang][key].includes("{task}"), `${lang} ${key}`);
    }
  }
  assert.equal(voiceLine("start_failed_spoken_kiosk", "en", { bot: "Writer" }), "Writer couldn't start a task. The details are on your phone.");
  assert.equal(voiceLine("start_failed_spoken_kiosk", "es", { bot: "Writer" }), "Writer no pudo empezar una tarea. Los detalles están en tu teléfono.");
});

test("an unregistered surface is never spoken to", async () => {
  const phone = surface("phone");
  const off = P.registerVoiceSurface("phone-1", phone.impl);
  off();
  assert.deepEqual(await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() })), { spokenOn: null });
  assert.deepEqual(phone.spoken, []);
  // A superseded socket that unregisters late never drops the newer registration.
  const oldOne = surface("phone");
  const newOne = surface("phone");
  const offOld = P.registerVoiceSurface("phone-1", oldOne.impl);
  P.registerVoiceSurface("phone-1", newOne.impl);
  offOld();
  assert.equal((await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() }))).spokenOn, "phone-1");
  assert.deepEqual([oldOne.spoken.length, newOne.spoken.length], [0, 1]);
  // Unregistered while the busy retry waits: nothing is spoken after the wait.
  const busy = surface("phone", { busy: true });
  const offBusy = P.registerVoiceSurface("phone-3", busy.impl);
  const r = await P.announce(opts({ originDeviceId: "phone-3", lineFor: completionLine(), wait: async () => { offBusy(); busy.set({ busy: false }); } }));
  assert.equal(r.spokenOn, null);
  assert.deepEqual(busy.spoken, []);
});

test("a surface must say when it is busy (P27): busy() is required", () => {
  const { impl } = surface("phone");
  const { busy, ...noBusy } = impl;
  assert.throws(() => P.registerVoiceSurface("phone-1", noBusy), /busy/);
  assert.throws(() => P.registerVoiceSurface("phone-1", { ...impl, surface: "tv" }), /surface/);
  assert.throws(() => P.registerVoiceSurface("", impl), /device id/);
  assert.equal(typeof busy, "function");
});

test("a busy target is retried once", async () => {
  waits.length = 0;
  // Busy, then idle after the wait: spoken once, after one 5 s wait.
  let calls = 0;
  const later = surface("phone", { busy: () => ++calls === 1 });
  P.registerVoiceSurface("phone-1", later.impl);
  assert.equal((await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() }))).spokenOn, "phone-1");
  assert.deepEqual(waits, [P.ANNOUNCE_RETRY_MS]);
  assert.equal(P.ANNOUNCE_RETRY_MS, 5000);
  assert.equal(later.spoken.length, 1);
  // Still busy after the one retry: nothing is spoken, and there is no second retry.
  waits.length = 0;
  const stuck = surface("glasses", { busy: true });
  P.registerVoiceSurface("glasses-1", stuck.impl);
  assert.deepEqual(await P.announce(opts({ originDeviceId: "glasses-1", lineFor: completionLine() })), { spokenOn: null });
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(stuck.spoken, []);
  // A busy() that throws counts as busy.
  const odd = surface("phone", { busy: () => { throw new Error("hub gone"); } });
  P.registerVoiceSurface("phone-2", odd.impl);
  assert.deepEqual(await P.announce(opts({ originDeviceId: "phone-2", lineFor: completionLine() })), { spokenOn: null });
  // The default wait really waits (unref'd), and is what a caller without one gets.
  assert.equal(typeof P.announce, "function");
});

test("a turn running on the surface counts as busy, a relay turn included (P27)", async () => {
  const kiosk = surface("kiosk");   // its own busy() says idle: the turn runs outside its hub
  P.registerVoiceSurface("kiosk-a", kiosk.impl);
  const done = P.trackTurn("kiosk-a");
  assert.deepEqual(await P.announce(opts({ originDeviceId: "kiosk-a", lineFor: completionLine() })), { spokenOn: null });
  done();
  done();   // idempotent
  assert.equal((await P.announce(opts({ originDeviceId: "kiosk-a", lineFor: completionLine() }))).spokenOn, "kiosk-a");

  // The real runner marks a relay turn (the R1.2 session's answer) running on its device for its whole length.
  P._resetPresenceForTest();
  const h = harness({ rounds: [[{ type: "hang" }]] });
  const quiet = surface("kiosk");
  P.registerVoiceSurface(h.device.id, quiet.impl);
  const ac = new AbortController();
  const turn = h.runner.runVoiceTurn({ db: null, device: h.device, sink: h.sink, signal: ac.signal, transcript: "the bot's answer", relayThreadId: "thread-1", relayKind: "answer" });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(await P.announce(opts({ originDeviceId: h.device.id, lineFor: completionLine() })), { spokenOn: null }, "never spoken into a relay turn");
  ac.abort();
  await turn;
  assert.equal((await P.announce(opts({ originDeviceId: h.device.id, lineFor: completionLine() }))).spokenOn, h.device.id, "spoken once the turn is over");
});

test("a speak that throws is caught", async () => {
  const logs = [];
  const bad = surface("phone", { speak: async () => { throw new Error("socket closed"); } });
  P.registerVoiceSurface("phone-1", bad.impl);
  assert.deepEqual(await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine(), log: (m) => logs.push(m) })), { spokenOn: null });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /speak failed/);
  // A speak that says it did not deliver, a lineFor that throws, a connected/lastTurnAt that throws: all null.
  P._resetPresenceForTest();
  const refused = surface("glasses", { speak: async () => false });
  P.registerVoiceSurface("glasses-1", refused.impl);
  assert.deepEqual(await P.announce(opts({ originDeviceId: "glasses-1", lineFor: completionLine() })), { spokenOn: null });
  const fine = surface("phone");
  P.registerVoiceSurface("phone-2", fine.impl);
  assert.deepEqual(await P.announce(opts({ originDeviceId: "phone-2", lineFor: () => { throw new Error("x"); } })), { spokenOn: null });
  P.registerVoiceSurface("phone-3", { ...fine.impl, connected: () => { throw new Error("x"); }, lastTurnAt: () => { throw new Error("y"); } });
  assert.deepEqual(await P.announce(opts({ originDeviceId: "phone-3", lineFor: () => "" })), { spokenOn: null });
  assert.deepEqual(await P.announce({ originDeviceId: "phone-2" }), { spokenOn: null }, "no lineFor");
});

test("two module instances share one registry", async () => {
  const P2 = await import("../servers/gateway/voice/presence.js?second-instance");
  assert.notEqual(P2.registerVoiceSurface, P.registerVoiceSurface, "a second module instance");
  const phone = surface("phone");
  P2.registerVoiceSurface("phone-1", phone.impl);   // the bundle's copy registers…
  assert.equal((await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() }))).spokenOn, "phone-1");   // …the gateway's announces
  assert.deepEqual(P.voiceSurfaces(), [{ deviceId: "phone-1", surface: "phone" }]);
  const done = P2.trackTurn("phone-1");
  assert.deepEqual(await P.announce(opts({ originDeviceId: "phone-1", lineFor: completionLine() })), { spokenOn: null }, "a turn marked by either instance");
  done();
});

/** A fake hand-off core for notifyRow: notify answers `send` ("ok" | "off" | "throw"). */
function fakeCore(send) {
  const announced = [], logs = [], pushed = [];
  return {
    announced, logs, pushed,
    notify: async (_db, n) => { if (send === "throw") throw new Error("db locked"); pushed.push(n); return send === "off" ? null : { id: 1 }; },
    announce: async (a) => { announced.push({ ...a, pushedBefore: pushed.length }); return { spokenOn: "phone-1", surface: "phone" }; },
    log: (m) => logs.push(m), now: () => T0, lastHandoffTopic: new Map(),
  };
}
const H = { id: 7, name: "Writer", task: TASK, lang: "en", cardId: null, deviceId: "phone-1" };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test("a start-failed heads-up is spoken only after its notification was sent", async () => {
  const ok = fakeCore("ok");
  await notifyRow(ok, null, H, { titleKey: "handoff_start_failed", kioskSpokenKey: "start_failed_spoken_kiosk" });
  await flush();
  assert.equal(ok.announced.length, 1);
  assert.equal(ok.announced[0].pushedBefore, 1, "the notification went first");
  assert.equal(ok.announced[0].lineFor("kiosk"), "Writer couldn't start a task. The details are on your phone.");
  assert.equal(ok.announced[0].handoffId, 7);
  for (const send of ["off", "throw"]) {
    const c = fakeCore(send);
    await notifyRow(c, null, H, { titleKey: "handoff_start_failed", kioskSpokenKey: "start_failed_spoken_kiosk" });
    await flush();
    assert.equal(c.announced.length, 0, `nothing is spoken when the send was ${send}`);
  }
  // Perch's own push already went out (skipNotify): the phone has the details, so it is spoken.
  const skip = fakeCore("throw");
  await notifyRow(skip, null, H, { titleKey: "handoff_start_failed", skipNotify: true });
  await flush();
  assert.equal(skip.announced.length, 1);
});

test("a heads-up that was spoken records the hand-off as that device's last topic (P31)", async () => {
  const c = fakeCore("ok");
  await announceHandoff(c, 7, { originDeviceId: "kiosk-1", lineFor: () => "x" });
  // Said between turns: exchange 0 is the last completed one there (handoff-topic.js), so the next turn is the first after it.
  assert.deepEqual(c.lastHandoffTopic.get("phone-1"), { id: 7, exchange: 0, at: T0 }, "keyed by the device it was spoken on");
  const silent = { ...fakeCore("ok"), announce: async () => ({ spokenOn: null }) };
  await announceHandoff(silent, 8, { originDeviceId: "phone-1", lineFor: () => "x" });
  assert.equal(silent.lastHandoffTopic.size, 0, "nothing recorded when nothing was spoken");
});

/* ---------- The panels load without presence (guarded import) ---------- */

// An app root that is the repo in every file except servers/gateway/voice/presence.js.
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
function farmWithoutPresence() {
  const base = mkdtempSync(join(process.env.CROW_HOME || tmpdir(), "presence-farm-"));
  made.push(base);
  const farm = join(base, "app");
  const mirror = (src, dest, skip, inner) => {
    mkdirSync(dest, { recursive: true });
    for (const e of readdirSync(src)) {
      if (e === ".git" || e === skip) continue;
      symlinkSync(join(src, e), join(dest, e));
    }
    if (inner) inner();
  };
  mirror(ROOT, farm, "servers", () =>
    mirror(join(ROOT, "servers"), join(farm, "servers"), "gateway", () =>
      mirror(join(ROOT, "servers", "gateway"), join(farm, "servers", "gateway"), "voice", () =>
        mirror(join(ROOT, "servers", "gateway", "voice"), join(farm, "servers", "gateway", "voice"), "presence.js"))));
  const home = join(base, "home");
  mkdirSync(join(home, "data"), { recursive: true });
  return { farm, home };
}

function loadPanel(file, appRoot, home) {
  const code = `import(${JSON.stringify(pathToFileURL(file).href)}).then((m) => { console.log(JSON.stringify({ router: typeof m.default, ws: typeof m.setupWebSocket })); process.exit(0); }, (e) => { console.log(JSON.stringify({ error: String(e && (e.code || e.message)) })); process.exit(0); });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_APP_ROOT: appRoot, HOME: home },
    timeout: 90_000, encoding: "utf8",
  });
  return { out: JSON.parse(String(r.stdout).trim().split("\n").pop()), stderr: String(r.stderr) };
}

test("a panel whose presence import fails still loads", () => {
  const { farm, home } = farmWithoutPresence();
  for (const [bundle, tag] of [["kiosk", "[kiosk]"], ["meta-glasses", "[meta-glasses]"]]) {
    const { out, stderr } = loadPanel(join(ROOT, "bundles", bundle, "panel", "routes.js"), farm, home);
    assert.deepEqual(out, { router: "function", ws: "function" }, `${bundle}: ${stderr.slice(-400)}`);
    assert.ok(stderr.includes(`${tag} voice presence unavailable`), `${bundle} took the guarded path`);
  }
  // Both panels import presence only through the guard.
  for (const bundle of ["kiosk", "meta-glasses"]) {
    const src = readFileSync(join(ROOT, "bundles", bundle, "panel", "routes.js"), "utf8");
    assert.match(src, /appImport\("servers\/gateway\/voice\/presence\.js"\)\.catch\(/, bundle);
  }
});
