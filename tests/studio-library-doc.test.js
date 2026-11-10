/**
 * Studio instrument library, in the document: a song's fonts (plan 1d, Task 1),
 * the soundfont track that plays one, the preset commands, and the parts of the
 * shared history and the invariants they lean on.
 *
 * Every test builds its own song in memory, so nothing here touches a database
 * or a running instance.
 *
 * The hub side of the task — the agent's font guard and the people-only undo of
 * `library.add` — needs the real hub and a scratch database, so those two tests
 * live in `tests/studio-hub.test.js`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// The very module instance `server/doc.js` gets from `import * as Y from "yjs"`:
// the package's ESM build, not the CommonJS one.
import * as Y from "../bundles/studio/node_modules/yjs/dist/yjs.mjs";
import {
  GM_DRUM_BANK,
  LIMITS,
  SOUNDFONT_DEVICE,
  applyBeforeAfter,
  checkInvariants,
  getLibraryEntry,
  isSoundfontTrack,
  libraryInsertUsers,
  libraryUses,
  libraryUsers,
  newSongDoc,
  objectMap,
  readField,
  snapshot,
} from "../bundles/studio/server/doc.js";
import {
  StudioError,
  getCommand,
  runCommand,
} from "../bundles/studio/server/commands/registry.js";
import "../bundles/studio/server/commands/core.js";
import "../bundles/studio/server/commands/takes.js";
import "../bundles/studio/server/commands/arrangement.js";
import "../bundles/studio/server/commands/sampler.js";
import "../bundles/studio/server/commands/midi.js";
import "../bundles/studio/server/commands/library.js";
import "../bundles/studio/server/commands/mixer.js";
import {
  GM_DRUM_KITS,
  GM_PROGRAMS,
  presetLabel,
  presetName,
} from "../bundles/studio/server/commands/instruments.js";

/** A GUI command's author, per the plan's attribution rule. */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** A font's sha256, as the gateway measures it: 64 lowercase hexadecimal characters. */
const HASH_A = "a1b2c3d4".repeat(8);

/** A second font's sha256. */
const HASH_B = "0f1e2d3c".repeat(8);

/** A song document that is destroyed when the test ends. */
function scratchDoc(t) {
  const doc = newSongDoc({ title: "Instrument song" });
  t.after(() => doc.destroy());
  return doc;
}

/** Assert that `fn` throws a StudioError with this code, and return it. */
function refuses(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StudioError, `expected a StudioError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected a refusal with code "${code}", but the call succeeded`);
}

/**
 * One library entry, in the shape the gateway's library routes build it.
 * @param {string} id
 * @param {object} [overrides]
 * @returns {object}
 */
function fontEntry(id, overrides = {}) {
  return {
    id,
    kind: "font",
    name: `Font ${id}`,
    source: "catalog",
    catalog_id: `catalog-${id}`,
    storage_key: `studio/library/${id}.sf3`,
    sha256: HASH_A,
    bytes: 1024,
    licence: "MIT",
    credit: "MuseScore_General by S. Christian Collins and the MuseScore team, from FluidR3 by Frank Wen",
    author_label: "the operator",
    ...overrides,
  };
}

/** Add one library entry and return the command's result. */
function addEntry(doc, entry) {
  return runCommand(doc, "library.add", { entry });
}

/** Add a soundfont track and return its id. */
function addSoundfontTrack(doc, name = "Keys", fontId = "font-a") {
  return runCommand(doc, "track.add", { name, kind: "soundfont", font_id: fontId }).args.id;
}

test("a soundfont track plays a program of a library font", (t) => {
  const doc = scratchDoc(t);

  // A font arrives in the library (the gateway's route issues this), named the
  // way the plan spells an entry: kind, source, sha256, bytes, licence, credit.
  const added = addEntry(doc, fontEntry("font-a"));
  assert.equal(added.summary, 'Added the font "Font font-a" to the library');
  assert.deepEqual(added.after["library:font-a|*"], {
    id: "font-a",
    kind: "font",
    name: "Font font-a",
    source: "catalog",
    catalog_id: "catalog-font-a",
    storage_key: "studio/library/font-a.sf3",
    upload_id: null,
    sha256: HASH_A,
    bytes: 1024,
    licence: "MIT",
    credit: "MuseScore_General by S. Christian Collins and the MuseScore team, from FluidR3 by Frank Wen",
    author_label: "the operator",
  });
  assert.deepEqual(snapshot(doc).library["font-a"], added.after["library:font-a|*"]);
  assert.ok(getLibraryEntry(doc, "font-a"), "the entry is in the document");

  // A second font, so the track has somewhere to move to.
  addEntry(doc, fontEntry("font-b", { sha256: HASH_B, source: "upload", upload_id: "up-1" }));

  // The track: one font and its first preset, and nothing else in the device.
  const trackId = addSoundfontTrack(doc);
  const track = snapshot(doc).tracks.find((item) => item.id === trackId);
  assert.deepEqual(track.device, { engine: "soundfont", font_id: "font-a", bank: 0, program: 0 });
  assert.ok(isSoundfontTrack({ get: (key) => (key === "device" ? track.device : null) }));
  assert.equal(track.name, "Keys");

  // A program is chosen the way musicians count: program 0 is "program 1".
  const grand = runCommand(doc, "track.set_program", { track_id: trackId, bank: 0, program: 0 }, { author: HUMAN });
  assert.equal(grand.summary, 'Set track "Keys" to program 1 (Acoustic Grand Piano)');
  assert.deepEqual(Object.keys(grand.before).sort(), [`track:${trackId}|device.bank`, `track:${trackId}|device.program`]);
  assert.deepEqual(snapshot(doc).tracks[0].device, { engine: "soundfont", font_id: "font-a", bank: 0, program: 0 });

  // The GM drum bank: bank 128 program 0 is the standard kit.
  const kit = runCommand(doc, "track.set_program", { track_id: trackId, bank: GM_DRUM_BANK, program: 0 });
  assert.equal(kit.summary, 'Set track "Keys" to drum kit 1 (Standard kit)');
  assert.equal(snapshot(doc).tracks[0].device.bank, GM_DRUM_BANK);
  assert.equal(snapshot(doc).tracks[0].device.program, 0);
  assert.equal(readField(doc, `track:${trackId}`, "device.program"), 0);
  assert.equal(readField(doc, `track:${trackId}`, "device.bank"), GM_DRUM_BANK);

  // A named program and a bank beyond GM read the way a musician says them.
  const violin = runCommand(doc, "track.set_program", { track_id: trackId, bank: 0, program: 40 });
  assert.equal(violin.summary, 'Set track "Keys" to program 41 (Violin)');
  const bankTwo = runCommand(doc, "track.set_program", { track_id: trackId, bank: 2, program: 8 });
  assert.equal(bankTwo.summary, 'Set track "Keys" to program 9 (Celesta) of bank 2');
  assert.equal(GM_PROGRAMS.length, 128);
  assert.equal(presetName(0, 0), "Acoustic Grand Piano");
  assert.equal(presetLabel(GM_DRUM_BANK, 0), "drum kit 1 (Standard kit)");
  assert.equal(GM_DRUM_KITS[0], "Standard kit");

  // Setting bank and program is two fields of one device, so the program change
  // undoes on its own and leaves the font where it is.
  const before = snapshot(doc);
  doc.transact(() => applyBeforeAfter(doc, bankTwo.before));
  assert.equal(snapshot(doc).tracks[0].device.bank, 0);
  assert.equal(snapshot(doc).tracks[0].device.program, 40);
  assert.equal(snapshot(doc).tracks[0].device.font_id, "font-a");
  doc.transact(() => applyBeforeAfter(doc, bankTwo.after));
  assert.deepEqual(snapshot(doc).tracks[0].device, before.tracks[0].device);

  // The font is chosen with `track.set_font`, one field of the same device.
  const moved = runCommand(doc, "track.set_font", { track_id: trackId, font_id: "font-b" });
  assert.equal(moved.summary, 'Set track "Keys" to the font "Font font-b"');
  assert.deepEqual(Object.keys(moved.after), [`track:${trackId}|device.font_id`]);
  assert.equal(snapshot(doc).tracks[0].device.font_id, "font-b");
  assert.deepEqual(libraryUsers(snapshot(doc), "font-b"), [trackId]);
  assert.deepEqual(libraryUsers(snapshot(doc), "font-a"), []);
  assert.equal(libraryUses(snapshot(doc), "font-b"), true);
  assert.equal(libraryUses(snapshot(doc), "font-a"), false);

  // The device of a soundfont track is not a SunVox module to swap, and its
  // controllers are not controllers: both send the caller to the two commands.
  const swap = refuses(
    () => runCommand(doc, "track.set_device", { track_id: trackId, type: "SpectraVoice" }),
    "invalid",
  );
  assert.match(swap.message, /track\.set_font \/ track\.set_program/);
  refuses(
    () => runCommand(doc, "track.set_param", { track_id: trackId, name: "Cutoff", value: 40 }),
    "invalid",
  );

  // The preset commands refuse a track that plays no font, a program or bank
  // out of range, and a font the song does not hold.
  const plain = runCommand(doc, "track.add", { name: "Bass" }).args.id;
  refuses(() => runCommand(doc, "track.set_program", { track_id: plain, bank: 0, program: 0 }), "invalid");
  refuses(() => runCommand(doc, "track.set_font", { track_id: plain, font_id: "font-a" }), "invalid");
  refuses(() => runCommand(doc, "track.set_program", { track_id: trackId, bank: 0, program: 128 }), "invalid");
  refuses(() => runCommand(doc, "track.set_program", { track_id: trackId, bank: 129, program: 0 }), "invalid");
  const missing = refuses(
    () => runCommand(doc, "track.set_font", { track_id: trackId, font_id: "nowhere" }),
    "invalid",
  );
  assert.match(missing.message, /no font with id "nowhere"/);
  refuses(() => addSoundfontTrack(doc, "Strings", "nowhere"), "invalid");
  refuses(() => runCommand(doc, "track.add", { name: "Ghost", font_id: "font-a" }), "invalid");

  // The document as the commands left it is consistent...
  assert.deepEqual(checkInvariants(doc), []);

  // ... and the check catches a track left naming a font that is gone, which is
  // the state a bad history plan would try to land on.
  doc.transact(() => {
    doc.getMap("song").get("library").delete("font-b");
  });
  const reasons = checkInvariants(doc);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /would play the font "font-b", which is not in the song's library/);
});

test("a font in use cannot be removed", (t) => {
  const doc = scratchDoc(t);
  addEntry(doc, fontEntry("font-a"));
  addEntry(doc, fontEntry("font-b", { sha256: HASH_B }));
  const trackId = addSoundfontTrack(doc);

  // The track plays font-a, so neither an agent nor the operator may take it
  // out of the library: the entry would be gone while the track still names it.
  const inUse = refuses(() => runCommand(doc, "library.remove", { library_id: "font-a" }), "conflict");
  assert.match(inUse.message, /in use by track "Keys"/);
  assert.match(inUse.message, /change what that track plays first/);
  assert.ok(getLibraryEntry(doc, "font-a"), "the refused removal wrote nothing");
  assert.equal(getLibraryEntry(doc, "font-a").get("name"), "Font font-a");

  // The unused font may go, and one undo brings it back whole.
  const removed = runCommand(doc, "library.remove", { library_id: "font-b" });
  assert.equal(removed.summary, 'Removed the font "Font font-b" from the library');
  assert.deepEqual(removed.touched, ["library:font-b"]);
  assert.equal(snapshot(doc).library["font-b"], undefined);
  doc.transact(() => applyBeforeAfter(doc, removed.before));
  assert.equal(snapshot(doc).library["font-b"].name, "Font font-b");

  // Once the track plays another font, the first one is free to go.
  runCommand(doc, "track.set_font", { track_id: trackId, font_id: "font-b" });
  const freed = runCommand(doc, "library.remove", { library_id: "font-a" });
  assert.equal(freed.summary, 'Removed the font "Font font-a" from the library');
  assert.deepEqual(snapshot(doc).library["font-a"], undefined);
  assert.equal(snapshot(doc).tracks[0].device.font_id, "font-b");

  // A track that is removed frees its font the same way.
  runCommand(doc, "track.remove", { track_id: trackId });
  runCommand(doc, "library.remove", { library_id: "font-b" });
  assert.deepEqual(snapshot(doc).library, {});

  // An entry that is not there is not_found, and the plan's own refusals hold:
  // a library file is Studio's own to add, and an id is one id.
  refuses(() => runCommand(doc, "library.remove", { library_id: "nothing" }), "not_found");
  assert.equal(getCommand("library.add").internal, true);
  addEntry(doc, fontEntry("font-c"));
  refuses(() => addEntry(doc, fontEntry("font-c")), "invalid");
});

test("a capture in use cannot be removed", (t) => {
  const doc = scratchDoc(t);
  addEntry(doc, fontEntry("cap-a", { kind: "nam", name: "Capture", upload_id: "up-cap" }));
  addEntry(doc, fontEntry("cab-a", { kind: "ir", name: "Cabinet", upload_id: "up-cab" }));
  addEntry(doc, fontEntry("cab-b", { kind: "ir", name: "Spare cabinet", upload_id: "up-cab-b" }));

  // An amp insert carries the sound the operator chose: its `model_id` is a
  // capture and its `ir_id` a cabinet, and both are library entries the register
  // has to count as in use.
  const trackId = runCommand(doc, "track.add", { name: "Guitar", kind: "audio" }).args.id;
  runCommand(doc, "insert.add", {
    id: "amp-1",
    owner: `track:${trackId}`,
    kind: "amp",
    params: { model_id: "cap-a", ir_id: "cab-a" },
  });
  assert.deepEqual(libraryInsertUsers(doc, "cap-a"), ["amp-1"]);
  assert.deepEqual(libraryInsertUsers(doc, "cab-a"), ["amp-1"]);
  assert.deepEqual(libraryInsertUsers(doc, "cab-b"), []);
  assert.equal(libraryUses(doc, "cap-a"), true);
  assert.equal(libraryUses(doc, "cab-b"), false);

  // Neither the capture nor the cabinet may leave the library while an amp
  // plays it — whoever asks, and with the sentence that names the amp.
  const capture = refuses(() => runCommand(doc, "library.remove", { library_id: "cap-a" }), "conflict");
  assert.match(capture.message, /The capture "Capture" is in use by an amp on track "Guitar"/);
  assert.match(capture.message, /change what that amp plays first/);
  const cabinet = refuses(() => runCommand(doc, "library.remove", { library_id: "cab-a" }), "conflict");
  assert.match(cabinet.message, /The cabinet "Cabinet" is in use by an amp on track "Guitar"/);
  assert.ok(getLibraryEntry(doc, "cap-a"), "the refused removal wrote nothing");
  assert.ok(getLibraryEntry(doc, "cab-a"));

  // The spare cabinet is nobody's and may go.
  runCommand(doc, "library.remove", { library_id: "cab-b" });
  assert.equal(snapshot(doc).library["cab-b"], undefined);

  // The removal is a write to the amp too, which is what `touches` is for:
  // taking the capture away would leave that amp silent.
  const touched = getCommand("library.remove").touches({ library_id: "cab-a" }, snapshot(doc));
  assert.deepEqual(touched, ["library:cab-a", "insert:amp-1"]);
  // Letting the amp go frees both of its files.
  runCommand(doc, "insert.remove", { id: "amp-1" });
  runCommand(doc, "library.remove", { library_id: "cap-a" });
  runCommand(doc, "library.remove", { library_id: "cab-a" });
  assert.deepEqual(snapshot(doc).library, {});
  assert.equal(libraryUses(doc, "cap-a"), false);
});

test("33rd font refused", (t) => {
  const doc = scratchDoc(t);
  for (let index = 0; index < LIMITS.fontsPerSong; index += 1) {
    addEntry(doc, fontEntry(`font-${index}`, { sha256: HASH_A }));
  }
  assert.equal(Object.values(snapshot(doc).library).length, LIMITS.fontsPerSong);

  const before = snapshot(doc);
  const over = refuses(() => addEntry(doc, fontEntry("font-33")), "limit");
  assert.equal(over.message, "A song can hold at most 32 fonts.");
  assert.deepEqual(snapshot(doc), before, "the refused font wrote nothing");

  // The library cap is its own limit: captures and cabinets fill it up, and the
  // entries past it are refused by name.
  let index = LIMITS.fontsPerSong;
  for (; index < LIMITS.libraryEntriesPerSong; index += 1) {
    addEntry(doc, fontEntry(`nam-${index}`, { kind: "nam", name: `Capture ${index}`, sha256: HASH_B }));
  }
  assert.equal(Object.values(snapshot(doc).library).length, LIMITS.libraryEntriesPerSong);
  const full = refuses(
    () => addEntry(doc, fontEntry("nam-extra", { kind: "ir", name: "Cabinet", sha256: HASH_B })),
    "limit",
  );
  assert.equal(full.message, "A song's library can hold at most 256 entries.");
  assert.equal(Object.values(snapshot(doc).library).length, LIMITS.libraryEntriesPerSong);
});

test("a malformed soundfont device is reported", (t) => {
  const doc = scratchDoc(t);
  addEntry(doc, fontEntry("font-a"));
  addSoundfontTrack(doc);
  assert.deepEqual(checkInvariants(doc), []);

  // A device written by hand, the way a bad migration or an edited history entry
  // could leave one. A snapshot reads every field of it as a usable value —
  // `font_id` as nothing, the bank as 0 — which is exactly why the check reads
  // the document: a stored value that is not what the document promises is
  // reported rather than tidied into one that passes.
  const track = doc.getMap("song").get("tracks").get(0);
  doc.transact(() => {
    track.set("device", { engine: "soundfont", font_id: 7, bank: "grand", program: 200 });
  });
  const reasons = checkInvariants(doc);
  assert.equal(reasons.length, 3, `unexpected reasons: ${reasons.join(" | ")}`);
  assert.ok(
    reasons.some((reason) => /would name the font 7; a font id is a string, or nothing at all/.test(reason)),
    `the malformed font id was not reported: ${reasons.join(" | ")}`,
  );
  assert.ok(
    reasons.some((reason) => /would play bank "grand"; a soundfont track plays banks 0 to 127, or 128 for the drums/.test(reason)),
    `the malformed bank was not reported: ${reasons.join(" | ")}`,
  );
  assert.ok(
    reasons.some((reason) => /would play program 200; a soundfont track plays programs 0 to 127/.test(reason)),
    `the program out of range was not reported: ${reasons.join(" | ")}`,
  );

  // The snapshot still hands a reader a usable device, which is the point of the
  // normalising: only an integer survives as itself.
  assert.deepEqual(snapshot(doc).tracks[0].device, {
    engine: SOUNDFONT_DEVICE.engine,
    font_id: null,
    bank: 0,
    program: 200,
  });

  // A library entry whose kind is not one of the three is reported as it is
  // stored, instead of being read as a font and counted against the font cap.
  doc.transact(() => {
    doc.getMap("song").get("library").set("odd", objectMap({ ...fontEntry("odd"), kind: "wav" }));
  });
  const kinds = checkInvariants(doc).filter((reason) => /would have the kind "wav"/.test(reason));
  assert.equal(kinds.length, 1, "the malformed kind was not reported");
  assert.match(kinds[0], /The library entry "Font odd" would have the kind "wav"/);
  assert.match(kinds[0], /a library entry is a font, a capture or a cabinet/);
});

test("an old song opens with an empty library", (t) => {
  // A song written before the library existed: the containers 1a to 1c created
  // and nothing else. It reads exactly like a song with an empty library.
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const song = doc.getMap("song");
  doc.transact(() => {
    song.set("meta", { title: "An old song", bpm: 110, meter: [4, 4], key: "A minor" });
    const tracks = new Y.Array();
    tracks.push([
      objectMap({
        id: "bass",
        name: "Bass",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
      }),
    ]);
    song.set("tracks", tracks);
    const scenes = new Y.Array();
    scenes.push([objectMap({ id: "verse", name: "Verse" })]);
    song.set("scenes", scenes);
    song.set("clips", new Y.Map());
    song.set("takes", new Y.Map());
  }, "test:old-song");

  assert.deepEqual(snapshot(doc).library, {});
  assert.deepEqual(snapshot(doc).tracks[0].device, { engine: "sunvox", type: "Analog generator", params: {} });
  assert.deepEqual(checkInvariants(doc), []);

  // There is nothing to remove, and nothing to play: a soundfont track needs a
  // font the song already holds.
  refuses(() => runCommand(doc, "library.remove", { library_id: "font-a" }), "not_found");
  refuses(() => addSoundfontTrack(doc, "Keys", "font-a"), "invalid");

  // The first library.add makes the container, and the song plays a font.
  addEntry(doc, fontEntry("font-a"));
  assert.ok(getLibraryEntry(doc, "font-a"));
  const trackId = addSoundfontTrack(doc);
  assert.deepEqual(snapshot(doc).tracks.find((track) => track.id === trackId).device, {
    engine: SOUNDFONT_DEVICE.engine,
    font_id: "font-a",
    bank: 0,
    program: 0,
  });
  assert.deepEqual(checkInvariants(doc), []);

  // And the song's own steps undo cleanly: the track and the entry go, and the
  // song reads exactly the way it did before the library existed.
  const removedTrack = runCommand(doc, "track.remove", { track_id: trackId });
  const removedEntry = runCommand(doc, "library.remove", { library_id: "font-a" });
  doc.transact(() => applyBeforeAfter(doc, removedTrack.before));
  doc.transact(() => applyBeforeAfter(doc, removedEntry.before));
  assert.equal(snapshot(doc).tracks.length, 2);
  assert.equal(snapshot(doc).library["font-a"].sha256, HASH_A);
  assert.deepEqual(checkInvariants(doc), []);

  doc.transact(() => applyBeforeAfter(doc, removedEntry.after));
  doc.transact(() => applyBeforeAfter(doc, removedTrack.after));
  assert.deepEqual(snapshot(doc).library, {});
  assert.deepEqual(snapshot(doc).tracks.map((track) => track.id), ["bass"]);
  assert.deepEqual(checkInvariants(doc), []);
});