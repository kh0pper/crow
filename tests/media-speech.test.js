/**
 * bundles/media/server/speech.js: local-only voice policy, MP3 frame scan, and the file contract.
 * synthesizeToFile runs against the gateway's REAL Kokoro adapter and a local HTTP server that
 * stands in for the engine; nothing is injected between the function and the network.
 */
import "./helpers/media-isolate.js";   // first: this file's own home, data dir and database
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshMediaDb, fakeMp3, startFakeVoice, setVoiceProfiles, CLOUD_DEFAULT, localVoice, FRAME_SECONDS, FRAME_BYTES } from "./helpers/media-fixtures.js";
import { scanMp3, splitForSpeech, pickLocalProfile, hostIsLocal, isLocalAddress, insideAudioDir, resolveAudioDir, synthesizeToFile, MAX_REQUEST_CHARS } from "../bundles/media/server/speech.js";
import { writeLocalSetting, TTS_PROFILE_KEY } from "../bundles/media/server/settings.js";

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const quiet = { log: () => {} };
const near = (a, b) => Math.abs(a - b) < 0.06;

test("scanMp3: tag blocks and a header frame are dropped, frames are counted, duration is exact", () => {
  const plain = scanMp3(fakeMp3(250));
  assert.equal(plain.frames, 250);
  assert.ok(near(plain.duration_sec, 250 * FRAME_SECONDS));
  assert.equal(plain.audio.length, 250 * FRAME_BYTES, "the ID3 block is not part of the audio");
  assert.equal(plain.audio[0], 0xff);
  assert.equal(scanMp3(fakeMp3(10, { id3: false })).frames, 10);
  assert.equal(scanMp3(fakeMp3(10, { tag: true })).frames, 10, "a trailing ID3v1 block is fine");
  const withHeader = scanMp3(fakeMp3(10, { xing: true }));
  assert.equal(withHeader.frames, 10, "an Info/Xing frame is dropped, so a joined file never reports the first piece's length");
  const cut = fakeMp3(10).subarray(0, 44 + 9 * FRAME_BYTES + 100);
  assert.equal(scanMp3(cut).frames, 9, "a partial last frame is dropped");
});

test("scanMp3: bytes that are not MP3 are refused", () => {
  assert.equal(scanMp3(Buffer.from("RIFF....WAVEfmt " + "x".repeat(2000), "latin1")), null);
  assert.equal(scanMp3(Buffer.alloc(0)), null);
  assert.equal(scanMp3(Buffer.from("<html>Service Unavailable</html>")), null);
  assert.equal(scanMp3(Buffer.concat([fakeMp3(2), Buffer.alloc(8000, 7)])), null, "two frames and then garbage is not a recording");
  assert.equal(scanMp3(undefined), null);
});

test("splitForSpeech: pieces end at sentence ends, never exceed the limit, and lose nothing", () => {
  const sentence = "The council voted seven to two on Sunday to fund twelve miles of bus lanes.";
  const text = Array.from({ length: 40 }, (_, i) => `${i + 1}. ${sentence}`).join(" ");
  const pieces = splitForSpeech(text);
  assert.ok(pieces.length >= 3);
  for (const p of pieces) { assert.ok(p.length <= MAX_REQUEST_CHARS, `piece of ${p.length}`); assert.match(p, /[.!?]$/); }
  assert.equal(pieces.join(" "), text);
  const long = splitForSpeech("a".repeat(3000) + " tail.", 1200);
  assert.deepEqual(long.map((p) => p.length), [1200, 1200, 600 + " tail.".length]);
  assert.deepEqual(splitForSpeech(""), []);
  assert.deepEqual(splitForSpeech(null), []);
  const t0 = Date.now();
  splitForSpeech(". ".repeat(200_000));
  assert.ok(Date.now() - t0 < 2000);
});

test("address rule: loopback, private and tailnet ranges are local; public addresses and odd schemes are not", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.5", "100.64.20.5", "100.127.0.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:10.0.0.4"]) assert.equal(isLocalAddress(ip), true, ip);
  for (const ip of ["203.0.113.9", "172.32.0.1", "100.128.0.1", "8.8.8.8", "2001:db8::1", "", "localhost"]) assert.equal(isLocalAddress(ip), false, ip);
  const to = (addr) => async () => addr.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  assert.equal(await hostIsLocal("http://localhost:8880/v1"), true);
  assert.equal(await hostIsLocal("http://127.0.0.1:8880"), true);
  assert.equal(await hostIsLocal("http://[::1]:8880"), true);
  assert.equal(await hostIsLocal("http://voice.example.invalid:8880", to(["100.64.20.5"])), true);
  assert.equal(await hostIsLocal("https://voice.example.invalid", to(["203.0.113.9"])), false);
  assert.equal(await hostIsLocal("https://voice.example.invalid", to(["10.0.0.5", "203.0.113.9"])), false, "every address must be local");
  assert.equal(await hostIsLocal("https://voice.example.invalid", async () => { throw new Error("ENOTFOUND"); }), false);
  assert.equal(await hostIsLocal("https://203.0.113.9/v1"), false);
  assert.equal(await hostIsLocal("file:///etc/passwd"), false);
  assert.equal(await hostIsLocal("not a url"), false);
});

test("policy matrix: only a local engine on a local address may speak; the default profile is never consulted", async () => {
  const pub = async () => [{ address: "203.0.113.9", family: 4 }];
  const k = localVoice("http://localhost:8880/v1");
  const pick = async (profiles, opts = {}) => { const r = await pickLocalProfile(profiles, opts); return r.profile ? r.profile.id : r.error; };
  assert.equal(await pick([CLOUD_DEFAULT, k]), "local1", "the cloud default is skipped");
  assert.equal(await pick([CLOUD_DEFAULT]), "no_local_voice");
  assert.equal(await pick([]), "no_local_voice");
  assert.equal(await pick(null), "no_local_voice");
  assert.equal(await pick([{ ...CLOUD_DEFAULT, provider: "openai", baseUrl: "http://localhost:9/v1" }]), "no_local_voice", "a cloud provider type is refused even on a local address");
  assert.equal(await pick([localVoice("https://voice.example.invalid/v1")], { lookup: pub }), "no_local_voice", "a local engine type on a public address is refused");
  assert.equal(await pick([localVoice("")]), "local1", "an empty address is the engine's own localhost default");
  assert.equal(await pick([{ ...k, id: "p1", provider: "piper", baseUrl: "http://10.0.0.7:5000" }]), "p1");
  assert.equal(await pick([CLOUD_DEFAULT, k, { ...k, id: "local2" }], { profileId: "local2" }), "local2", "the setting chooses among local profiles");
  assert.equal(await pick([CLOUD_DEFAULT, k], { profileId: "cloud1" }), "no_local_voice", "the setting cannot select a cloud profile");
  assert.equal(await pick([CLOUD_DEFAULT, k], { profileId: "gone" }), "no_local_voice", "a missing chosen profile does not fall back to another");
});

test("synthesizeToFile: real adapter, one request per piece, MP3 asked for, one complete file, exact duration, no temp file", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const voice = await startFakeVoice(); cleanups.push(() => voice.close());
  await setVoiceProfiles(f.db, [CLOUD_DEFAULT, localVoice(voice.url)]);
  const story = "Seven of the largest exporters agreed on Sunday to hold production steady. ".repeat(30).trim();   // about 2,200 characters: two requests
  const outPath = join(resolveAudioDir(), "speech-test-1.mp3");
  const lines = [];
  const r = await synthesizeToFile(f.db, { segments: ["Good morning.", story, "That's your briefing."], outPath }, { log: (l) => lines.push(l) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(voice.requests.length, 4, "intro, two story pieces, outro");
  for (const q of voice.requests) { assert.equal(q.response_format, "mp3"); assert.equal(q.voice, "af_heart"); assert.ok(q.input.length <= MAX_REQUEST_CHARS); }
  assert.equal(voice.requests.map((q) => q.input).join(" "), ["Good morning.", story, "That's your briefing."].join(" "));
  const onDisk = scanMp3(readFileSync(outPath));
  const expectFrames = voice.requests.reduce((n, q) => n + Math.ceil(q.input.length / 5), 0);
  assert.equal(onDisk.frames, expectFrames);
  assert.equal(readFileSync(outPath).length, expectFrames * FRAME_BYTES, "frames only: no tag block between the joined pieces");
  assert.ok(near(r.duration_sec, expectFrames * FRAME_SECONDS), `duration ${r.duration_sec}`);
  assert.equal(r.file_size, expectFrames * FRAME_BYTES);
  assert.equal(r.offsets.length, 3);
  assert.equal(r.offsets[0], 0);
  assert.ok(near(r.offsets[1], Math.ceil("Good morning.".length / 5) * FRAME_SECONDS));
  assert.ok(r.offsets[2] > r.offsets[1]);
  assert.equal(r.provider, "kokoro");
  assert.equal(existsSync(`${outPath}.part`), false);
  assert.ok(lines.some((l) => l.includes("[media] voice profile=Local voice provider=kokoro voice=af_heart")), lines.join("|"));
});

test("with only a cloud profile there is no audio, no file and no request anywhere", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const voice = await startFakeVoice(); cleanups.push(() => voice.close());
  await setVoiceProfiles(f.db, [CLOUD_DEFAULT, { ...CLOUD_DEFAULT, id: "c2", provider: "openai", apiKey: "k", baseUrl: voice.url, isDefault: false }]);
  const outPath = join(resolveAudioDir(), "speech-test-2.mp3");
  const r = await synthesizeToFile(f.db, { segments: ["Hello."], outPath }, quiet);
  assert.deepEqual([r.ok, r.error], [false, "no_local_voice"]);
  assert.equal(voice.requests.length, 0);
  assert.equal(existsSync(outPath), false);
  // The setting cannot widen the policy either.
  await setVoiceProfiles(f.db, [CLOUD_DEFAULT, localVoice(voice.url)]);
  await writeLocalSetting(f.db, TTS_PROFILE_KEY, "cloud1");
  const r2 = await synthesizeToFile(f.db, { segments: ["Hello."], outPath }, quiet);
  assert.deepEqual([r2.ok, r2.error, voice.requests.length], [false, "no_local_voice", 0]);
});

test("a voice that is down, slow, broken or not MP3 gives a reason and leaves nothing on disk", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const voice = await startFakeVoice(); cleanups.push(() => voice.close());
  await setVoiceProfiles(f.db, [CLOUD_DEFAULT, localVoice(voice.url)]);
  const dir = resolveAudioDir();
  const run = (name, deps = {}) => synthesizeToFile(f.db, { segments: ["One sentence here.", "And a second one."], outPath: join(dir, name) }, { ...quiet, ...deps });
  const leftovers = () => readdirSync(dir).filter((n) => n.startsWith("speech-fail"));

  voice.state.mode = "wav";
  assert.equal((await run("speech-fail-wav.mp3")).error, "voice_format");
  voice.state.mode = "error";
  assert.equal((await run("speech-fail-500.mp3")).error, "voice_failed");
  voice.state.mode = "cut";
  assert.equal((await run("speech-fail-cut.mp3")).error, "voice_failed", "a response that ends early is a failure, not a short file");
  voice.state.mode = "stall";
  const t0 = Date.now();
  assert.equal((await run("speech-fail-slow.mp3", { requestTimeoutMs: 300 })).error, "voice_timeout");
  assert.ok(Date.now() - t0 < 5000, "the request timeout is honoured");
  voice.state.mode = "ok";
  assert.equal((await run("speech-fail-total.mp3", { totalTimeoutMs: 0 })).error, "voice_timeout", "the whole-briefing cap");
  await voice.close();
  assert.equal((await run("speech-fail-down.mp3")).error, "voice_failed");
  assert.deepEqual(leftovers(), [], "no file and no .part after any failure");
  assert.equal((await synthesizeToFile(f.db, { segments: ["", "  "], outPath: join(dir, "speech-fail-empty.mp3") }, quiet)).error, "empty");
});

test("voice choice: Spanish uses the Spanish voice; a requested voice is used only when the engine lists it", async () => {
  const f = await freshMediaDb(); cleanups.push(() => f.cleanup());
  const voice = await startFakeVoice(); cleanups.push(() => voice.close());
  await setVoiceProfiles(f.db, [localVoice(voice.url)]);
  const dir = resolveAudioDir();
  const said = async (opts) => { voice.requests.length = 0; const r = await synthesizeToFile(f.db, { segments: ["Hola."], outPath: join(dir, "speech-voice.mp3"), ...opts }, quiet); assert.equal(r.ok, true); return [voice.requests[0].voice, r.voice]; };
  assert.deepEqual(await said({ lang: "es" }), ["ef_dora", "ef_dora"]);
  assert.deepEqual(await said({ voice: "female" }), ["af_heart", "af_heart"]);
  assert.deepEqual(await said({ voice: "af_bella" }), ["af_bella", "af_bella"]);
});

test("insideAudioDir: only a real, non-empty .mp3 inside the audio directory", () => {
  const dir = resolveAudioDir();
  const good = join(dir, "inside-ok.mp3");
  writeFileSync(good, fakeMp3(3));
  writeFileSync(join(dir, "inside-empty.mp3"), "");
  writeFileSync(join(dir, "inside-notes.txt"), "x");
  mkdirSync(join(dir, "inside-dir.mp3"), { recursive: true });
  const outside = join(dir, "..", "outside.mp3");
  writeFileSync(outside, fakeMp3(3));
  try { symlinkSync(outside, join(dir, "inside-link.mp3")); } catch {}
  assert.equal(insideAudioDir(good), true);
  assert.equal(insideAudioDir(join(dir, "inside-empty.mp3")), false);
  assert.equal(insideAudioDir(join(dir, "inside-notes.txt")), false);
  assert.equal(insideAudioDir(join(dir, "inside-dir.mp3")), false);
  assert.equal(insideAudioDir(outside), false);
  assert.equal(insideAudioDir(join(dir, "..", "audio", "..", "outside.mp3")), false);
  assert.equal(insideAudioDir(join(dir, "inside-link.mp3")), false, "a link that leaves the directory is refused");
  assert.equal(insideAudioDir(join(dir, "missing.mp3")), false);
  assert.equal(insideAudioDir("/etc/passwd"), false);
  assert.equal(insideAudioDir(null), false);
});
