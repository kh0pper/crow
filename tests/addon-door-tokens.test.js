/**
 * Door tokens and the per-add-on wall choice in `addon-walls.json`.
 *
 * The token is a capability minted in the gateway's memory for one spawn: only
 * its sha256 is held, it is replaced on each mint, and a spawn's close clears
 * only the token it still holds. Validation also asks the door table, so a
 * live token for kiosk says nothing about a studio path.
 *
 * The wall choice is a per-computer owner decision read from and written to the
 * one wall file. Nothing planted anywhere else can make it read "unwalled".
 *
 * Real scratch homes under mkdtemp; nothing here touches a live instance.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearAddonDoorToken,
  doorPredicateFor,
  mintAddonDoorToken,
  validateAddonDoorToken,
} from "../servers/shared/addon-doors.js";
import {
  addonWallsPath,
  keptDataRecord,
  readAddonWalls,
  recordKeptData,
  setWallMode,
  wallModeOverride,
} from "../servers/shared/addon-walls-file.js";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-door-tokens-")));
after(() => rmSync(T, { recursive: true, force: true }));

let homeSeq = 0;
/** A fresh Crow home for one case. */
const freshHome = () => {
  const home = join(T, "home-" + ++homeSeq);
  mkdirSync(home, { recursive: true });
  return home;
};

const sha256hex = (text) => createHash("sha256").update(String(text)).digest("hex");

test("a kiosk token opens its own door and no other path or door", () => {
  const token = mintAddonDoorToken("kiosk");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(validateAddonDoorToken(token, "kiosk", "POST", "/api/kiosk/internal/announce"), true);
  // The method is part of the door.
  assert.equal(validateAddonDoorToken(token, "kiosk", "GET", "/api/kiosk/internal/announce"), false);
  // A path kiosk does not have.
  assert.equal(validateAddonDoorToken(token, "kiosk", "POST", "/api/kiosk/internal/turn-check"), false);
  // Another add-on's door.
  assert.equal(validateAddonDoorToken(token, "kiosk", "GET", "/api/studio/agent/songs"), false);
  // The same token under another id is worth nothing.
  assert.equal(validateAddonDoorToken(token, "studio", "POST", "/api/kiosk/internal/announce"), false);
});

test("a studio token is a prefix grant, on whole path segments only", () => {
  const token = mintAddonDoorToken("studio");
  assert.equal(validateAddonDoorToken(token, "studio", "GET", "/api/studio/agent/songs/abc"), true);
  assert.equal(validateAddonDoorToken(token, "studio", "GET", "/api/studio/agent/songs"), true);
  assert.equal(validateAddonDoorToken(token, "studio", "POST", "/api/studio/agent/songs/abc"), true);
  assert.equal(validateAddonDoorToken(token, "studio", "GET", "/api/studio/agent/songsX"), false);
  assert.equal(validateAddonDoorToken(token, "studio", "GET", "/api/studio/agent/songs/../x"), false);
  assert.equal(validateAddonDoorToken(token, "studio", "GET", "/api/studio/agent/songs/%2e%2e/x"), false);
  assert.equal(validateAddonDoorToken(token, "studio", "GET", "/api/studio/agent/other"), false);
});

test("a re-mint retires the old token, and a close clears only the token it holds", () => {
  const oldToken = mintAddonDoorToken("kiosk");
  const newToken = mintAddonDoorToken("kiosk");
  assert.notEqual(oldToken, newToken);
  assert.equal(validateAddonDoorToken(oldToken, "kiosk", "POST", "/api/kiosk/internal/announce"), false);
  assert.equal(validateAddonDoorToken(newToken, "kiosk", "POST", "/api/kiosk/internal/announce"), true);

  // An older spawn ending must not clear the newer spawn's token.
  clearAddonDoorToken("kiosk", oldToken);
  assert.equal(validateAddonDoorToken(newToken, "kiosk", "POST", "/api/kiosk/internal/announce"), true);

  clearAddonDoorToken("kiosk", newToken);
  assert.equal(validateAddonDoorToken(newToken, "kiosk", "POST", "/api/kiosk/internal/announce"), false);
});

test("no planted hash and no malformed token passes validation", () => {
  const home = freshHome();
  const chosen = "a-value-planted-somewhere";
  // A crow.db-like setting holding the sha256 of a chosen value: the validator
  // compares the sha256 of what it is GIVEN, so a hash is just a wrong token.
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "crow.db"), JSON.stringify({ dashboard_settings: { kiosk_announce_token_hash: sha256hex(chosen) } }));
  mintAddonDoorToken("kiosk");
  assert.equal(validateAddonDoorToken(sha256hex(chosen), "kiosk", "POST", "/api/kiosk/internal/announce"), false);
  assert.equal(validateAddonDoorToken("z".repeat(64), "kiosk", "POST", "/api/kiosk/internal/announce"), false);
  assert.equal(validateAddonDoorToken(chosen, "kiosk", "POST", "/api/kiosk/internal/announce"), false);
  assert.equal(validateAddonDoorToken(null, "kiosk", "POST", "/api/kiosk/internal/announce"), false);
  // An id with no door set cannot be minted for at all.
  assert.throws(() => mintAddonDoorToken("no-such-addon"));
  assert.throws(() => mintAddonDoorToken(""));
  assert.throws(() => mintAddonDoorToken(undefined));
});

test("the relay predicate drops the query and refuses a rewriteable path", () => {
  const kiosk = doorPredicateFor("kiosk");
  assert.equal(kiosk("/api/kiosk/internal/announce?x=1", "POST"), true);
  assert.equal(kiosk("/api/kiosk/internal/announce", "POST"), true);
  assert.equal(kiosk("//api/kiosk/internal/announce", "POST"), false);
  assert.equal(kiosk("/api/kiosk//internal/announce", "POST"), false);
  assert.equal(kiosk("/api/kiosk/internal/ann%6funce", "POST"), false);
  assert.equal(kiosk("/api/kiosk/internal/../internal/announce", "POST"), false);
  assert.equal(kiosk("/api/kiosk/internal/announce", "GET"), false);

  const unknown = doorPredicateFor("nope");
  assert.equal(unknown("/api/kiosk/internal/announce", "POST"), false);
  assert.equal(unknown("/", "GET"), false);
});

test("the wall choice round-trips and keeps every other key byte for byte", () => {
  const home = freshHome();
  const dataDir = join(home, "data");
  mkdirSync(join(dataDir, "kept"), { recursive: true });
  const st = lstatSync(join(dataDir, "kept"), { bigint: true });
  assert.equal(recordKeptData(home, "kept", st), true);
  const keptBytes = JSON.stringify(readAddonWalls(home).keptData);
  assert.ok(keptDataRecord(home, "kept"));

  assert.equal(wallModeOverride(home, "kiosk"), null);
  assert.equal(setWallMode(home, "kiosk", "unwalled"), true);
  assert.equal(wallModeOverride(home, "kiosk"), "unwalled");
  assert.equal(setWallMode(home, "kiosk", "walled"), true);
  assert.equal(wallModeOverride(home, "kiosk"), "walled");

  // The kept-data record is still exactly what it was.
  assert.equal(JSON.stringify(readAddonWalls(home).keptData), keptBytes);
  assert.equal(keptDataRecord(home, "kept").ino, String(st.ino));
  // The file is the owner's alone.
  assert.equal(statSync(addonWallsPath(home)).mode & 0o777, 0o600);
});

test("an invalid id or mode writes nothing", () => {
  const home = freshHome();
  assert.equal(setWallMode(home, "kiosk", "walled"), true);
  const before = readFileSync(addonWallsPath(home));
  for (const [id, mode] of [["../x", "unwalled"], ["Kiosk", "unwalled"], ["kiosk", "sometimes"], ["kiosk", ""], ["kiosk", true]]) {
    assert.equal(setWallMode(home, id, mode), false);
  }
  assert.deepEqual(readFileSync(addonWallsPath(home)), before);
  // And an id the file may not hold reads as no choice.
  assert.equal(wallModeOverride(home, "../x"), null);
  assert.equal(wallModeOverride(home, "__proto__"), null);
});

test("a corrupt wall file reads as no choice", () => {
  const home = freshHome();
  writeFileSync(addonWallsPath(home), "{not json", { mode: 0o600 });
  assert.equal(wallModeOverride(home, "kiosk"), null);
  // A modes value that is not exactly one of the two words is no choice either.
  writeFileSync(addonWallsPath(home), JSON.stringify({ modes: { kiosk: "sometimes", other: ["unwalled"] } }), { mode: 0o600 });
  assert.equal(wallModeOverride(home, "kiosk"), null);
  assert.equal(wallModeOverride(home, "other"), null);
  writeFileSync(addonWallsPath(home), JSON.stringify({ modes: "unwalled" }), { mode: 0o600 });
  assert.equal(wallModeOverride(home, "kiosk"), null);
});