/**
 * Studio session hub — the authority for every open song in one gateway
 * process.
 *
 * The hub is the only writer of a song's document. It owns:
 *
 *   - the live `Y.Doc` of each song, built from the stored snapshot plus the
 *     update log and cached for the life of the process;
 *   - one serial promise queue per song, so an edit, an undo, a redo and a
 *     focus change land in arrival order and a lock or a focus that arrived a
 *     moment ago is seen by the command that follows it;
 *   - the ACL check on every write, the people-only commands, and the
 *     locked-track and focused-object refusals an agent runs into;
 *   - persistence: one Yjs update and one history entry per step, periodic
 *     snapshots, and the compaction of the updates a snapshot covers;
 *   - the broadcast every connected client of the song receives.
 *
 * It imports nothing from the gateway's own tree. The project ACL arrives
 * through `acl` — production injects `servers/shared/project-acl.js`, tests
 * inject a fake — which keeps this module runnable against a scratch database,
 * and keeps the one rule that matters explicit: the hub never decides access
 * by itself.
 *
 * Results are plain objects for the write paths — a command, an undo, a redo
 * and a song creation never throw for something a caller can act on:
 *
 *   {ok: true, entry, snapshot_version}            a command applied
 *   {ok: true, entry, conflicts, snapshot_version} an undo or a redo applied
 *   {ok: false, code, error, conflicts?}           a refusal
 *
 * `code` is one of "acl", "human_only", "studio_only", "locked", "focused",
 * "limit", "invalid", "conflict", "storage" or "not_found".
 *
 * Two of those rules are about recordings, which cannot be made again:
 *   - a command marked `internal` (`take.add` and `sample.add` today) is
 *     refused with "studio_only" unless the call says it comes from Studio, so
 *     the WS path, the agent HTTP API and MCP cannot issue one;
 *   - a step — a command, an undo or a redo — whose writes would delete a take
 *     or discard one is refused for anyone but the operator, with
 *     "human_only" and a sentence asking for the operator's yes.
 *
 * A third rule guards the sampler's sounds the same way, and is decided on the
 * same effective writes (see `losesSound`): an agent may put a sample on an
 * empty pad, rename a sample, or re-chop one no locked track plays, but it may
 * not delete a sample, drop or repoint a pad that plays one, remove the bank or
 * the sampler track the pad belongs to, replace a sampler track's device, or
 * take a `sample.add` back.
 *
 * "storage" is the one refusal that has to undo something: the edit was
 * already applied to the live document when the write failed, so the hub drops
 * its cached document for that song and the next operation rebuilds it from the
 * database. Nothing in memory and nothing on disk keeps the step. A song whose
 * first save fails needs no such repair: its row and its first update are one
 * transaction, so a failed creation writes nothing at all.
 *
 * The two reads (`openSong`, `history`) throw instead, because there is no
 * half-answer to hand back: a StudioError with code "not_found", or the ACL
 * error unchanged.
 */

import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import {
  SAMPLER_DEVICE,
  bankKey,
  newSongDoc,
  parseObjectRef,
  sampleUsers,
  snapshot,
  splitRefField,
} from "./doc.js";
import {
  StudioError,
  applyCommand,
  getCommand,
  hasCommand,
  prepareCommand,
} from "./commands/registry.js";
// The registry is populated by importing the commands for their side effect,
// so a hub started on its own always has every 1a command available.
import "./commands/core.js";
// The 1b take commands, registered the same way.
import "./commands/takes.js";
// The 1b timeline commands — placements, markers and sections — likewise.
import "./commands/arrangement.js";
// The 1c sampler commands — kits, pads, samples, patterns and steps.
import "./commands/sampler.js";
import {
  REDO_COMMAND,
  UNDO_COMMAND,
  applyPlan,
  makeEntry,
  makeUndoEntry,
  planRedo,
  planUndo,
} from "./history.js";
import {
  commitStep,
  createSongWithState,
  getSongRow,
  listHistory,
  listSongs as listSongRows,
  loadUpdates,
  writeSnapshot,
} from "./store.js";
import { initStudioTables } from "./init-tables.js";

/** The error name a project ACL refusal carries; the hub maps it to "acl". */
const ACL_ERROR_NAME = "AclError";

/** Ten minutes of de-duplication, per song, when the caller names no window. */
const DEFAULT_DEDUPE_MS = 600000;

/** A snapshot every 200 applied updates, when the caller names no interval. */
const DEFAULT_SNAPSHOT_EVERY = 200;

/** The history action recorded for every applied step. */
const AUDIT_ACTION = "studio.command";

/** The history action recorded when a song row is created. */
const AUDIT_CREATE_ACTION = "studio.song.create";

/** The registry ids that record a history step rather than an edit. */
const HISTORY_COMMANDS = new Set([UNDO_COMMAND, REDO_COMMAND]);

/**
 * How far an `undo_of` chain is followed before it is treated as broken. A
 * chain alternates undo and redo, so it is never long; the cap only stops a
 * corrupted row from looping.
 */
const MAX_UNDO_HOPS = 64;

/** What a caller is told when the store could not take a step. */
const SAVE_FAILED = "Studio could not save that change; nothing was changed.";

/** What a caller is told when it runs a command only Studio itself may run. */
const STUDIO_ONLY = "This command can only be run by Studio itself.";

/**
 * What an agent is told when a step would drop a recorded take.
 *
 * A take is the one thing in a song that cannot be made again, so losing one
 * needs the operator's own yes (spec §5.10 and §12).
 */
const TAKES_NEED_A_YES = "Removing recorded takes needs a yes from the operator.";

/**
 * The one people-only command an agent may take back, and only in the one safe
 * shape `onlyPutsTakesBack` recognises: the operator's `take.discard` undone.
 */
const TAKE_DISCARD_COMMAND = "take.discard";

/**
 * What an agent is told when it moves a take's `discarded` flag through the
 * history rather than through a command.
 *
 * A command is a fresh decision — `take.restore` is an ordinary agent edit and
 * `take.discard` is the operator's own — while a step back along the history
 * re-writes raw fields, which is the door the take-loss hole was found behind.
 */
const TAKE_FLAG_BY_COMMAND_ONLY =
  "Only a person can take back a step that changes whether a take is discarded.";

/** The ref kinds a step can lose a recorded take through. */
const TAKE_BEARING_KINDS = Object.freeze(["take", "clip", "track", "scene"]);

/**
 * What an agent is told when a step would lose a recorded or imported sound.
 *
 * A sample is a recording or an import, the one thing in a sampler track that
 * cannot be made again from the song: losing one needs the operator's own yes
 * (plan 1c, Global Constraints "Who can change a sound").
 */
const SOUNDS_NEED_A_YES = "Changing recorded or imported sounds needs a yes from the operator.";

/**
 * The people-only command over a sound: a `sample.add` step is the operator's
 * to take back, in either direction, like `take.add`.
 */
const SAMPLE_ADD_COMMAND = "sample.add";

/** The ref kinds a step can lose a recorded or imported sound through. */
const SOUND_BEARING_KINDS = Object.freeze(["sample", "slice", "pad", "bank", "track"]);

/** What a caller is told when a `cmd_id` comes back for a different change. */
const CMD_ID_REUSED = "That command id was already used for a different change.";

/**
 * The prefix the agent transport puts on a bot's author id (see web.js).
 * The MCP layer resolves a Crow bot as `bot:<id>` and the agent routes force
 * `kind:"agent"`, so the author an audit line is written for is `agent:bot:<id>`.
 */
const AGENT_BOT_PREFIX = "agent:bot:";

/** The prefix every author that came through the agent transport carries. */
const AGENT_PREFIX = "agent:";

/** Sweep the de-duplication table once it holds this many entries in total. */
const DEDUPE_PRUNE_AT = 1000;

/** Report a side effect that failed after the step itself was saved. */
function warn(what, err) {
  console.warn(`Studio hub: ${what} failed: ${err?.message ?? err}`);
}

/**
 * A text form of the change a `cmd_id` was first used for.
 *
 * Callers resend the same request, so the same shape stringifies the same way;
 * that is enough to tell a replay from an id being reused for something else.
 * @param {unknown} change
 * @returns {string}
 */
function fingerprintOf(change) {
  try {
    return JSON.stringify(change);
  } catch {
    return "";
  }
}

/** @returns {object} a refusal a caller can relay. */
function refuse(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/**
 * The `project_audit_log` actor for one Studio author.
 *
 * The timeline stores actors the app's own way (`servers/research/actor.js`
 * auditActor): a person is "local", a bot is "bot" with its BARE bot id, and an
 * agent with no bot to name is "bot" with no id. The transport's prefix
 * (`agent:`) is therefore stripped here, so the timeline never records a
 * transport detail: `agent:bot:<botId>` files under `<botId>`, and the
 * operator's own MCP session (`agent:mcp`) files under no id at all. An author
 * that reached the hub without that prefix is a caller naming itself directly,
 * and keeps its id exactly as it always has.
 *
 * @param {{kind?: string, id?: string|null}} author
 * @returns {{actor_type: "local"|"bot", actor_id: string|null}}
 */
function auditActor(author) {
  if (author?.kind === "human") return { actor_type: "local", actor_id: author.id ?? null };
  const id = String(author?.id ?? "");
  if (id.startsWith(AGENT_BOT_PREFIX) && id.length > AGENT_BOT_PREFIX.length) {
    return { actor_type: "bot", actor_id: id.slice(AGENT_BOT_PREFIX.length) };
  }
  // The operator's own MCP session (no bot to name) is filed the way the rest
  // of Crow files an unattributed local caller.
  if (id.startsWith(AGENT_PREFIX)) return { actor_type: "local", actor_id: "unknown" };
  return { actor_type: "bot", actor_id: id === "" ? null : id };
}

/** @returns {object|null} the parsed JSON value, or null when the column is empty. */
function parseJson(text) {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @returns {boolean} whether a value is a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Note the track an object value belongs to, when it names one.
 * @param {Set<string>} ids
 * @param {any} value
 * @returns {void}
 */
function addTrackId(ids, value) {
  if (!isPlainObject(value)) return;
  if (typeof value.track_id === "string" && value.track_id !== "") ids.add(value.track_id);
}

/**
 * Note the track one before/after entry names.
 *
 * A clip value carries the track it sits on in `track_id`, and so does a pad
 * and a bank. A pattern, a step and a take carry the clip they belong to in
 * `clip_id`, and that clip says which track they hang off. A whole-track value
 * (`track:<id>|*`) is the track itself, and it is the one place a restore says
 * whether that track is locked: a track that was removed is not in the song
 * any more, so a lock check against the live document would find nothing to
 * refuse.
 * @param {{trackIds: Set<string>, lockedTracks: Map<string, string>}} found
 * @param {object} snap - the current snapshot, to find a clip's track
 * @param {string} key - a `"<ref>|<field>"` history key
 * @param {any} value - the value the entry writes
 * @returns {void}
 */
function noteTrackEntry(found, snap, key, value) {
  const split = splitRefField(key);
  const target = split ? parseObjectRef(split.ref) : null;
  if (target?.kind === "track" && split.field === "*" && isPlainObject(value)) {
    found.trackIds.add(target.id);
    if (value.locked === true) {
      const name = typeof value.name === "string" && value.name !== "" ? value.name : target.id;
      found.lockedTracks.set(target.id, name);
    }
    return;
  }
  addTrackId(found.trackIds, value);
  // A pattern or a step says which clip it belongs to, and the clip says which
  // track's kit plays it.
  const clipId = isPlainObject(value) && typeof value.clip_id === "string" ? value.clip_id : null;
  const clip = clipId === null ? null : snap?.clips?.[clipId];
  if (typeof clip?.track_id === "string" && clip.track_id !== "") {
    found.trackIds.add(clip.track_id);
  }
}

/**
 * Every track a history step writes to, and which of those it would put back
 * locked.
 *
 * The refs alone are not enough. A restore puts back an object the song does
 * not hold any more, so `trackIdsForRef` finds nothing for it — the clip's own
 * `track_id` inside the value being written is then the only thing that says
 * which track it lands on. The values a plan writes are read for it, and so
 * are the recorded step's own before/after values, because those are what a
 * redo of a redo eventually writes. A whole-track value that says
 * `locked: true` marks that track locked, so undoing the operator's removal of
 * a locked track is refused for an agent the way every other locked-track
 * write is.
 * @param {object} snap - the current snapshot
 * @param {string[]} refs - the refs the plan's keys name
 * @param {{apply?: Map<string, any>}|Map<string, any>} plan
 * @param {object|null} target - the history entry being undone or redone
 * @returns {{trackIds: Set<string>, lockedTracks: Map<string, string>}}
 *   `lockedTracks` maps a track id to the name to print for it
 */
function planTrackIds(snap, refs, plan, target) {
  const found = { trackIds: new Set(), lockedTracks: new Map() };
  for (const ref of refs) {
    for (const trackId of trackIdsForRef(snap, ref)) found.trackIds.add(trackId);
  }

  const applied = plan?.apply instanceof Map ? plan.apply : plan instanceof Map ? plan : null;
  for (const [key, value] of applied ?? []) noteTrackEntry(found, snap, key, value);
  for (const map of [target?.inverse?.before, target?.inverse?.after]) {
    if (!map || typeof map !== "object") continue;
    for (const [key, value] of Object.entries(map)) noteTrackEntry(found, snap, key, value);
  }
  return found;
}

/**
 * The `"<ref>|<field>"` writes of one change set, as pairs.
 *
 * A command hands its changes back as a plain object, a history plan keeps its
 * writes in a Map in the order `applyPlan` takes them; both are read the same
 * way here, and an empty or missing change set is no writes at all.
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes
 * @returns {Array<[string, any]>}
 */
function changeEntries(changes) {
  if (changes instanceof Map) return [...changes.entries()];
  if (changes && typeof changes === "object") return Object.entries(changes);
  return [];
}

/**
 * The first recorded take a set of writes would lose, or null.
 *
 * A take is lost through exactly two kinds of write: its whole object
 * (`"take:<id>|*"`) set to `null`, which is how doc.js spells "it does not
 * exist", and its `discarded` flag set to `true`, which is how a take stops
 * being a recording that plays. Both lose the recording for anyone who is not
 * the operator: a discarded take is still on disk and still comes back with
 * `take.restore`.
 * @param {Map<string, any>|Object<string, any>} changes - the writes the step makes
 * @returns {string|null} the id of the take the step would lose
 */
function lostTake(changes) {
  for (const [key, value] of changeEntries(changes)) {
    const split = splitRefField(key);
    if (!split) continue;
    const target = parseObjectRef(split.ref);
    if (target?.kind !== "take") continue;
    if (split.field === "*" && value === null) return target.id;
    if (split.field === "discarded" && value === true) return target.id;
  }
  return null;
}

/**
 * Whether a step's writes would move a take's `discarded` flag without losing
 * the take: the flag being cleared, in practice.
 *
 * Setting it (`discarded` → `true`) is already a loss (see `lostTake`); what is
 * left is a step that puts a discarded take back.
 * @param {Map<string, any>|Object<string, any>} changes - the writes the step makes
 * @returns {boolean}
 */
function movesTakeFlag(changes) {
  for (const [key] of changeEntries(changes)) {
    const split = splitRefField(key);
    if (!split || split.field !== "discarded") continue;
    if (parseObjectRef(split.ref)?.kind === "take") return true;
  }
  return false;
}

/**
 * Whether a step's writes are exactly a recorded take coming back: the one
 * people-only step an agent may take back, in its one harmless shape.
 *
 * Restoring a take is an ordinary agent edit (`take.restore`), so undoing the
 * operator's `take.discard` puts back exactly what an agent could have done
 * itself — the take's flag, and the comp the discard took its segments out of.
 * Every other write is somebody else's business: a discard, a deletion, a
 * second take, a take of another clip, any other field. So redoing a discard,
 * or taking back the undo that restored it, stays people-only, and so does the
 * undo of every other people-only command.
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes
 * @param {object} snap - the song as it is right now, to find the take's clip
 * @returns {boolean}
 */
function onlyPutsTakesBack(changes, snap) {
  let takeId = null;
  let clipId = null;
  for (const [key, value] of changeEntries(changes)) {
    const split = splitRefField(key);
    const target = split ? parseObjectRef(split.ref) : null;
    if (target?.kind === "take") {
      if (split.field !== "discarded" || value !== false) return false;
      if (takeId !== null && takeId !== target.id) return false;
      takeId = target.id;
      continue;
    }
    // The comp the discard removed the take's segments from comes back with
    // it, and that is the only other object this shape writes.
    if (target?.kind === "clip") {
      if (split.field !== "comp") return false;
      if (clipId !== null && clipId !== target.id) return false;
      clipId = target.id;
      continue;
    }
    return false;
  }
  if (takeId === null) return false;
  if (clipId === null) return true;
  return snap?.takes?.[takeId]?.clip_id === clipId;
}

/**
 * The id in front of the first "/" of a sampler container key.
 *
 * A slice lives under "<sample_id>/<slice_id>", a bank under
 * "<track_id>/<bank_id>" and a pad under "<track_id>/<bank_id>/<index>", and
 * none of those ids holds a "/" of its own (see the id rules in sampler.js), so
 * the first part is always the object the key hangs off. Only a fallback: the
 * snapshot's own object is asked first, so a key nothing holds any more can
 * still name its track.
 * @param {string} key
 * @returns {string|null}
 */
function keyHead(key) {
  const text = String(key ?? "");
  const at = text.indexOf("/");
  return at > 0 ? text.slice(0, at) : null;
}

/** @returns {boolean} whether a pad plays a recorded or imported sound. */
function playsSound(pad) {
  return typeof pad?.sample_id === "string" && pad.sample_id !== "";
}

/**
 * Whether one write takes a field away from a value it holds: cleared, or moved
 * to a different value. A field that held nothing may be filled in.
 * @param {any} current - what the song holds now
 * @param {any} next - what the step would write
 * @returns {boolean}
 */
function takesAway(current, next) {
  return current !== null && current !== undefined && current !== next;
}

/** @returns {object|null} one pad of a snapshot, or null. */
function padIn(snap, key) {
  const pad = snap?.pads?.[key];
  return isPlainObject(pad) ? pad : null;
}

/** @returns {boolean} whether any pad of one bank plays a sound. */
function bankHoldsSound(snap, trackId, bankId) {
  return Object.values(snap?.pads ?? {}).some(
    (pad) => pad?.track_id === trackId && pad?.bank_id === bankId && playsSound(pad),
  );
}

/** @returns {boolean} whether any pad of one track plays a sound. */
function trackHoldsSound(snap, trackId) {
  return Object.values(snap?.pads ?? {}).some((pad) => pad?.track_id === trackId && playsSound(pad));
}

/** @returns {boolean} whether any pad plays one slice of one sample. */
function sliceInUse(snap, sampleId, sliceId) {
  return Object.values(snap?.pads ?? {}).some(
    (pad) => pad?.sample_id === sampleId && pad?.slice_id === sliceId,
  );
}

/** @returns {boolean} whether one track of a snapshot plays a kit of pads. */
function isSamplerIn(snap, trackId) {
  return (snap?.tracks ?? []).some(
    (track) => track?.id === trackId && track?.device?.engine === SAMPLER_DEVICE.engine,
  );
}

/** @returns {object|null} one track of a snapshot, or null. */
function trackIn(snap, trackId) {
  return (snap?.tracks ?? []).find((track) => track?.id === trackId) ?? null;
}

/**
 * Whether one write to a pad loses the sound it plays: the pad is deleted while
 * it plays one, or its sample or its slice moves away from the value it held.
 * @param {object} snap - the song as it stands before the step
 * @param {string} key - the pad's container key (`<track>/<bank>/<index>`)
 * @param {string} field - `"*"`, `"sample_id"` or `"slice_id"`
 * @param {any} value - what the step would write
 * @returns {boolean}
 */
function padWriteLosesSound(snap, key, field, value) {
  // A pad this step makes was not playing anything a moment ago.
  const pad = padIn(snap, key);
  if (!pad) return false;
  if (field === "*") {
    if (value === null) return playsSound(pad);
    if (!isPlainObject(value)) return false;
    if (takesAway(pad.sample_id ?? null, value.sample_id ?? null)) return true;
    // On a pad that plays a sample, no slice means the WHOLE sample: narrowing
    // it to a slice changes the sound as much as clearing it, so any change of
    // slice counts.
    return playsSound(pad) && (pad.slice_id ?? null) !== (value.slice_id ?? null);
  }
  if (field === "sample_id") return takesAway(pad.sample_id ?? null, value ?? null);
  if (field === "slice_id") return playsSound(pad) && (pad.slice_id ?? null) !== (value ?? null);
  return false;
}

/**
 * Whether one write to a track loses a kit's sound: the track is deleted while
 * its pads play a sample, or its device (its kit's engine) is replaced.
 * @param {object} snap - the song as it stands before the step
 * @param {string} trackId
 * @param {string} field - `"*"`, `"device"`, or another field of the track
 * @param {any} value - what the step would write
 * @returns {boolean}
 */
function trackWriteLosesSound(snap, trackId, field, value) {
  const track = trackIn(snap, trackId);
  if (field === "device") {
    if (!isSamplerIn(snap, trackId)) return false;
    return !isDeepStrictEqual(track?.device ?? null, value ?? null);
  }
  if (field !== "*") return false;
  if (value === null) return trackHoldsSound(snap, trackId);
  // A whole track put back is the same instrument it was recorded as; a track
  // that came back as a different or a missing one is a different sound.
  if (!track || !isPlainObject(value)) return false;
  if (!isSamplerIn(snap, trackId)) return false;
  return !isDeepStrictEqual(track.device ?? null, value.device ?? null);
}

/**
 * Whether a change set holds a write that would lose a recorded or imported
 * sound.
 *
 * Judged on the values a step writes, never on the shape of its keys: a pad is
 * lost through a whole-object delete, through a `sample_id` or `slice_id` that
 * moves off the value it holds, and through the bank, the track or the device
 * that carries it. A write that fills an empty pad, renames a sample or changes
 * any other field of a pad is not a loss, and neither is putting back something
 * that was taken away.
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes - the
 *   writes the step makes, keyed `"<ref>|<field>"`
 * @param {object} snap - the song as it stands before those writes
 * @returns {boolean}
 */
function losesSound(changes, snap) {
  for (const [key, value] of changeEntries(changes)) {
    const split = splitRefField(key);
    const target = split ? parseObjectRef(split.ref) : null;
    if (!target) continue;
    if (target.kind === "sample") {
      if (split.field === "*" && value === null) return true;
      continue;
    }
    if (target.kind === "slice") {
      if (split.field !== "*" || value !== null) continue;
      const sampleId = keyHead(target.id);
      if (sampleId === null) continue;
      if (sliceInUse(snap, sampleId, target.id.slice(sampleId.length + 1))) return true;
      continue;
    }
    if (target.kind === "pad") {
      if (padWriteLosesSound(snap, target.id, split.field, value)) return true;
      continue;
    }
    if (target.kind === "bank") {
      if (split.field !== "*" || value !== null) continue;
      const trackId = keyHead(target.id);
      if (trackId === null) continue;
      if (bankHoldsSound(snap, trackId, target.id.slice(trackId.length + 1))) return true;
      continue;
    }
    if (target.kind === "track" && trackWriteLosesSound(snap, target.id, split.field, value)) {
      return true;
    }
  }
  return false;
}

/**
 * What one prepared command would change, worked out on a throwaway copy of the
 * song so a rule can be checked before anything is written.
 *
 * The clone is the same dry run `history.js` makes of an undo, and a command
 * is deterministic on the same content, so the before/after it returns here is
 * exactly what `applyCommand` returns for the real document a moment later.
 * @param {import("yjs").Doc} doc
 * @param {{command: Readonly<object>, args: object, snap: object}} prepared
 * @returns {{summary: string, before: Object<string, any>, after: Object<string, any>}}
 * @throws {StudioError} the refusal the command itself would raise
 */
function previewChanges(doc, prepared) {
  const clone = new Y.Doc();
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    return applyCommand(clone, prepared);
  } finally {
    clone.destroy();
  }
}

/**
 * Normalise a caller's author to the three fields the history stores.
 *
 * A call without an author is treated as an agent: the strictest reading, so a
 * caller that forgets to say who it is never gets the operator's privileges.
 * @param {{kind?: string, id?: string, label?: string}|null} author
 * @returns {{kind: string, id: string|null, label: string|null}}
 */
function normalizeAuthor(author) {
  if (!author || typeof author !== "object" || typeof author.kind !== "string") {
    return { kind: "agent", id: author?.id ?? "unknown", label: author?.label ?? "Unknown agent" };
  }
  return { kind: author.kind, id: author.id ?? null, label: author.label ?? null };
}

/**
 * Every track a lock check has to look at for one touched ref.
 *
 * A clip belongs to the track it sits on; a track is itself; a scene or the
 * song's meta belong to no track. The sampler's objects name their track the
 * same way the rest do: a bank and a pad say which track's kit they belong to,
 * a pattern and a step belong to the track of their clip, and a sample or a
 * slice touches EVERY track that plays it — re-chopping or renaming a sound is
 * a write to every kit that has it on a pad, so a locked one among them refuses
 * the step (see `sampleUsers`). Nothing here walks to a clip's track from a
 * *focused* ref — focus matches the ref exactly.
 * @param {object} snap - a plain snapshot
 * @param {string} ref
 * @returns {string[]} the track ids, each once; empty when the ref names none
 */
function trackIdsForRef(snap, ref) {
  const target = parseObjectRef(ref);
  if (!target) return [];
  if (target.kind === "track") return [target.id];
  if (target.kind === "clip") return idsOrNone(snap.clips?.[target.id]?.track_id);
  // A placement is a block on a track's lane, so a locked track's placements
  // are off-limits the way its clips are. A marker or a section names no track.
  if (target.kind === "placement") {
    return idsOrNone(snap.arrangement?.placements?.[target.id]?.track_id);
  }
  if (target.kind === "pad") return idsOrNone(snap.pads?.[target.id]?.track_id ?? keyHead(target.id));
  if (target.kind === "bank") return idsOrNone(snap.banks?.[target.id]?.track_id ?? keyHead(target.id));
  // A pattern and a step carry the clip they belong to; the clip carries the
  // track. A whole object is named by its own key when the song no longer holds
  // it, and then the key's first part is still the clip it belonged to.
  if (target.kind === "pattern") {
    return trackOfClip(snap, snap.patterns?.[target.id]?.clip_id ?? keyHead(target.id));
  }
  if (target.kind === "step") {
    return trackOfClip(snap, snap.steps?.[target.id]?.clip_id ?? keyHead(target.id));
  }
  if (target.kind === "sample") return sampleUsers(snap, target.id);
  if (target.kind === "slice") {
    return sampleUsers(snap, snap.slices?.[target.id]?.sample_id ?? keyHead(target.id));
  }
  return [];
}

/** @returns {string[]} one id as a list of one, or nothing when it names none. */
function idsOrNone(id) {
  return typeof id === "string" && id !== "" ? [id] : [];
}

/** @returns {string[]} the track one clip sits on, when the song still holds it. */
function trackOfClip(snap, clipId) {
  return idsOrNone(snap.clips?.[clipId]?.track_id);
}

/**
 * The name to print for a ref in a refusal message.
 * @param {object} snap - a plain snapshot
 * @param {string} ref
 * @returns {string}
 */
function labelForRef(snap, ref) {
  const target = parseObjectRef(ref);
  if (!target) return ref;
  if (target.kind === "clip") return snap.clips?.[target.id]?.name ?? target.id;
  if (target.kind === "track") {
    return snap.tracks?.find((track) => track.id === target.id)?.name ?? target.id;
  }
  if (target.kind === "scene") {
    return snap.scenes?.find((scene) => scene.id === target.id)?.name ?? target.id;
  }
  if (target.kind === "placement") {
    const placement = snap.arrangement?.placements?.[target.id];
    return placement ? `placement at bar ${placement.start_bar}` : target.id;
  }
  if (target.kind === "marker") return snap.arrangement?.markers?.[target.id]?.name ?? target.id;
  if (target.kind === "section") return snap.arrangement?.sections?.[target.id]?.name ?? target.id;
  // The sampler's objects, so a focus on one of them names it the way a focus on
  // a clip does.
  if (target.kind === "sample") return snap.samples?.[target.id]?.name ?? target.id;
  if (target.kind === "bank") return snap.banks?.[target.id]?.name ?? target.id;
  if (target.kind === "pad") {
    const pad = snap.pads?.[target.id];
    if (!pad) return target.id;
    const bankName = snap.banks?.[bankKey(pad.track_id, pad.bank_id)]?.name ?? pad.bank_id;
    return `pad ${Number(pad.index) + 1} of bank ${bankName}`;
  }
  if (target.kind === "pattern") return snap.patterns?.[target.id]?.name ?? target.id;
  if (target.kind === "step") {
    const step = snap.steps?.[target.id];
    return step ? `the step at position ${step.at}` : target.id;
  }
  if (target.kind === "slice") {
    const slice = snap.slices?.[target.id];
    const sampleId = slice?.sample_id ?? keyHead(target.id);
    return slice ? `slice ${slice.id} of sample ${snap.samples?.[sampleId]?.name ?? sampleId}` : target.id;
  }
  return "the song";
}

/**
 * Map one row of `studio_history` to the entry `planUndo` and `planRedo` read.
 *
 * The store lists history by page but has no single-entry read, and the hub
 * needs one to undo an arbitrary step. Only the columns those planners use are
 * carried over.
 * @param {object} row
 * @returns {object}
 */
function entryFromRow(row) {
  const inverse = parseJson(row.inverse_json);
  return {
    id: String(row.id),
    song_id: String(row.song_id),
    seq: Number(row.seq),
    command: row.command,
    args: parseJson(row.args_json),
    summary: row.summary ?? "",
    inverse: inverse ?? { before: {}, after: {} },
    undo_of: row.undo_of ?? null,
    undone_by: row.undone_by ?? null,
  };
}

/**
 * Create the session hub for one gateway process.
 *
 * @param {object} options
 * @param {object} options.db - a database client with `execute` and `batch`
 *   (the gateway's own client and a scratch @libsql/client both qualify)
 * @param {{assertProjectExists: Function, assertCapability: Function,
 *          appendAudit: Function}} options.acl - the project ACL module
 * @param {() => Date} [options.now] - clock, injectable so de-duplication windows are testable
 * @param {(song_id: string, payload: object) => any} [options.onBroadcast]
 *   called with `{update, entry}` after every applied step and `{presence}`
 *   after every presence change; whatever it returns is awaited
 * @param {number} [options.snapshotEvery] - write a snapshot every N updates
 * @param {number} [options.dedupeMs] - how long a `cmd_id` stays remembered
 *
 * Every write call carries an `author`, and this is the contract for it: the
 * hub trusts the author exactly as given, because only the transport knows who
 * is on the other end of the call. A dashboard route sets
 * `{kind:"human", id:"local", label:"You"}` after it has verified the
 * session; the agent HTTP API forces `kind:"agent"` on whatever the MCP side
 * resolved. The hub itself never upgrades an author, never learns who a caller
 * is from anywhere but this field, and treats a missing author as an agent
 * (see `normalizeAuthor`) — so the one place that has to get this right is the
 * transport in front of it.
 *
 * @returns {object} the hub: openSong, createSong, runCommand, undo, redo,
 *   setFocus, clientGone, presence, listSongs, history
 */
export function createHub({
  db,
  acl,
  now = () => new Date(),
  onBroadcast = () => {},
  snapshotEvery = DEFAULT_SNAPSHOT_EVERY,
  dedupeMs = DEFAULT_DEDUPE_MS,
} = {}) {
  if (!db || typeof db.execute !== "function") {
    throw new TypeError("Studio hub: a database client is required");
  }
  if (typeof db.batch !== "function") {
    throw new TypeError("Studio hub: a database client with batch() is required");
  }
  if (!acl || typeof acl !== "object") {
    throw new TypeError("Studio hub: an acl module is required");
  }
  for (const name of ["assertProjectExists", "assertCapability", "appendAudit"]) {
    if (typeof acl[name] !== "function") {
      throw new TypeError(`Studio hub: acl.${name} is required`);
    }
  }

  /** The bundle's tables, created once before the first use of the hub. */
  let tablesReady = null;

  /** @type {Map<string, {doc: Y.Doc, seq: number, project_id: number}>} */
  const songs = new Map();

  /** @type {Map<string, Promise<object>>} documents being loaded right now. */
  const loading = new Map();

  /** @type {Map<string, Promise<void>>} the tail of each song's serial queue, dropped once it settles. */
  const queues = new Map();

  /** @type {Map<string, Map<string, {result: object, fingerprint: string, at: number}>>} recent steps by de-duplication key. */
  const dedupe = new Map();

  /** @type {Map<string, Map<string, {author: object, ref: string|null}>>} who has what open. */
  const focus = new Map();

  /** @returns {string} the injected clock as an ISO 8601 string. */
  function nowIso() {
    return now().toISOString();
  }

  /** @returns {Promise<void>} when the song, update and history tables exist. */
  function ensureTables() {
    if (!tablesReady) {
      tablesReady = initStudioTables(db).catch((err) => {
        tablesReady = null;
        throw err;
      });
    }
    return tablesReady;
  }

  /**
   * Run one operation behind every earlier operation for the same song.
   *
   * The tail advances on failure as well as success (`then(op, op)`), so one
   * refused or broken step never blocks the next. The caller always receives
   * its own operation's promise, rejection included.
   * @param {string} song_id
   * @param {() => Promise<any>} op
   * @returns {Promise<any>}
   */
  function enqueue(song_id, op) {
    const previous = queues.get(song_id) ?? Promise.resolve();
    const current = previous.then(op, op);
    // The tail is what the next operation waits on. When it is still the last
    // one by the time it settles, the song's slot goes away with it, so a
    // gateway that touched a thousand songs keeps no queue rows for them.
    const tail = current.then(() => {}, () => {});
    queues.set(song_id, tail);
    tail.then(() => {
      if (queues.get(song_id) === tail) queues.delete(song_id);
    });
    return current;
  }

  /**
   * Broadcast one payload to every client of a song.
   *
   * A broadcast that fails must never undo a step that is already persisted, so
   * the failure is reported and swallowed here.
   * @param {string} song_id
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async function broadcast(song_id, payload) {
    try {
      await onBroadcast(song_id, payload);
    } catch (err) {
      // The step is already stored, and every client that reconnects rebuilds
      // the song from the log, so a failed push is reported and ignored.
      warn("broadcast", err);
    }
  }

  /**
   * Record one step on the project's timeline. Audit failures never break an
   * edit, matching the ACL helper's own contract.
   * @param {number} project_id
   * @param {object} author
   * @param {string} action
   * @param {string} song_id
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async function audit(project_id, author, action, song_id, payload) {
    try {
      const actor = auditActor(author);
      await acl.appendAudit(db, {
        project_id,
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        action,
        target: "song:" + song_id,
        payload,
      });
    } catch (err) {
      // The edit itself is already saved; a missing audit line is reported and
      // never rolled back.
      warn("audit", err);
    }
  }

  /** @returns {object} the song row, or a "not_found" refusal. */
  async function readRow(song_id) {
    const row = await getSongRow(db, song_id);
    if (!row) {
      throw new StudioError("not_found", `There is no song "${song_id}".`);
    }
    return row;
  }

  /**
   * Build a song's document from its snapshot and its newer updates.
   * @param {string} song_id
   * @param {object} row
   * @returns {Promise<{doc: Y.Doc, seq: number, project_id: number}>}
   */
  async function buildDoc(song_id, row) {
    const doc = new Y.Doc();
    if (row.snapshot) Y.applyUpdate(doc, row.snapshot);
    for (const update of await loadUpdates(db, song_id)) Y.applyUpdate(doc, update);

    const { rows } = await db.execute({
      sql: "SELECT COALESCE(MAX(seq), 0) AS seq FROM studio_updates WHERE song_id = ?",
      args: [song_id],
    });
    const seq = Math.max(Number(rows[0]?.seq ?? 0), Number(row.snapshot_seq ?? 0));
    return { doc, seq, project_id: Number(row.project_id) };
  }

  /**
   * The cached document of a song, loaded at most once even when two requests
   * race for it.
   * @param {string} song_id
   * @param {object} row
   * @returns {Promise<{doc: Y.Doc, seq: number, project_id: number}>}
   */
  async function ensureDoc(song_id, row) {
    const cached = songs.get(song_id);
    if (cached) return cached;

    let pending = loading.get(song_id);
    if (!pending) {
      pending = buildDoc(song_id, row).then(
        (state) => {
          songs.set(song_id, state);
          loading.delete(song_id);
          return state;
        },
        (err) => {
          loading.delete(song_id);
          throw err;
        },
      );
      loading.set(song_id, pending);
    }
    return pending;
  }

  /**
   * Write a full-state snapshot once a song's update count reaches the
   * interval, then drop the updates it covers.
   *
   * The snapshot is written first: a process that stops between the two writes
   * leaves updates `loadUpdates` already ignores.
   * @param {string} song_id
   * @param {{doc: Y.Doc}} state
   * @param {number} seq
   * @returns {Promise<void>}
   */
  async function compactIfDue(song_id, state, seq) {
    if (!Number.isFinite(snapshotEvery) || snapshotEvery <= 0) return;
    if (seq % snapshotEvery !== 0) return;

    await writeSnapshot(db, song_id, Y.encodeStateAsUpdate(state.doc), seq);
    await deleteUpdatesUpTo(db, song_id, seq);
  }

  /**
   * Drop the update rows a snapshot has made redundant. It lives here rather
   * than in the store because the store is append-only by contract and the hub
   * is the one writer that knows a snapshot now covers them.
   *
   * Everything older than the snapshot's own `seq` goes; the row at `seq`
   * stays, because the store derives the next sequence number from the highest
   * row still in the table. Emptying the table would restart the log at 1
   * while the snapshot site still says `seq`, and the update written next would
   * then be skipped on load. `loadUpdates` already ignores everything at or
   * below `snapshot_seq`, so the one row left behind is invisible to every
   * reader and costs one blob per interval.
   * @param {object} client
   * @param {string} song_id
   * @param {number} seq - the seq the snapshot covers
   * @returns {Promise<void>}
   */
  async function deleteUpdatesUpTo(client, song_id, seq) {
    await client.execute({
      sql: "DELETE FROM studio_updates WHERE song_id = ? AND seq < ?",
      args: [song_id, seq],
    });
  }

  /**
   * The key one operation is de-duplicated by: what it is, who sent it and the
   * client's own id for it.
   *
   * The kind is part of the key because a client that reuses the id of a
   * command for an undo of that command is asking for two different things;
   * the kind and the id of the author, because a person and an agent may each
   * happen to pick the same id. The same key with a different change is
   * refused rather than answered with somebody else's result.
   * @param {"command"|"undo"|"redo"} kind
   * @param {{kind: string, id: string|null}} author
   * @param {string|null} cmd_id
   * @returns {string|null} null when the caller sent no id
   */
  function dedupeKey(kind, author, cmd_id) {
    if (cmd_id == null || cmd_id === "") return null;
    return `${kind}:${author.kind}:${author.id ?? "unknown"}:${cmd_id}`;
  }

  /**
   * Drop every song's expired de-duplication entries, once there are enough of
   * them to be worth the sweep.
   *
   * The table is bounded by the window, not by traffic, but walking it on every
   * command would be wasteful when it holds a handful of entries: the sweep
   * runs only once the total is past `DEDUPE_PRUNE_AT`, and then over every
   * song at once.
   * @returns {void}
   */
  function pruneDedupe() {
    let total = 0;
    for (const perSong of dedupe.values()) total += perSong.size;
    if (total <= DEDUPE_PRUNE_AT) return;

    const cutoff = now().getTime() - dedupeMs;
    for (const [song_id, perSong] of dedupe) {
      for (const [key, record] of perSong) {
        if (record.at <= cutoff) perSong.delete(key);
      }
      if (perSong.size === 0) dedupe.delete(song_id);
    }
  }

  /**
   * What a `cmd_id` seen recently means for this call.
   *
   * A client that resends a step after a reconnect gets its first answer back
   * and the step is not applied twice. The same key naming a different change
   * is a caller bug that would otherwise be swallowed: it comes back as
   * "mismatch" and the caller is told, rather than being handed the earlier
   * step's result.
   * @param {string} song_id
   * @param {string|null} key - as `dedupeKey` builds it
   * @param {string} fingerprint - the change the key is being used for now
   * @returns {{status: "none"}|{status: "replay", result: object}|{status: "mismatch"}}
   */
  function recall(song_id, key, fingerprint) {
    if (!key) return { status: "none" };
    pruneDedupe();

    const perSong = dedupe.get(song_id);
    const record = perSong?.get(key);
    if (!record) return { status: "none" };

    if (record.at <= now().getTime() - dedupeMs) {
      perSong.delete(key);
      if (perSong.size === 0) dedupe.delete(song_id);
      return { status: "none" };
    }
    if (record.fingerprint !== fingerprint) return { status: "mismatch" };
    return { status: "replay", result: record.result };
  }

  /**
   * Remember a saved step against its de-duplication key.
   * @param {string} song_id
   * @param {string|null} key
   * @param {string} fingerprint
   * @param {object} result - the result the first call returned
   * @returns {void}
   */
  function remember(song_id, key, fingerprint, result) {
    if (!key) return;
    let perSong = dedupe.get(song_id);
    if (!perSong) {
      perSong = new Map();
      dedupe.set(song_id, perSong);
    }
    perSong.set(key, { result, fingerprint, at: now().getTime() });
  }

  /** @returns {Map<string, {author: object, ref: string|null}>} a song's focus table. */
  function focusTable(song_id) {
    let clients = focus.get(song_id);
    if (!clients) {
      clients = new Map();
      focus.set(song_id, clients);
    }
    return clients;
  }

  /**
   * The refs a human client currently has open. Only people hold focus: an
   * agent's own focus (if it ever sets one) never blocks another agent.
   * @param {string} song_id
   * @returns {Set<string>}
   */
  function humanFocusRefs(song_id) {
    const refs = new Set();
    for (const { author, ref } of focus.get(song_id)?.values() ?? []) {
      if (!ref || author?.kind !== "human") continue;
      refs.add(ref);
    }
    return refs;
  }

  /**
   * The tracks a command's touched refs resolve to right now.
   * @param {object} snap
   * @param {string[]} refs
   * @returns {Set<string>}
   */
  function tracksOfRefs(snap, refs) {
    const ids = new Set();
    for (const ref of refs) {
      for (const trackId of trackIdsForRef(snap, ref)) ids.add(trackId);
    }
    return ids;
  }

  /**
   * Refuse a command only Studio itself may run when the call did not say it
   * comes from Studio.
   *
   * The definition is read straight from the registry: no ACL check, no
   * document load and no history touch comes before this, so a caller that may
   * not issue a take learns nothing about the song from trying.
   * @param {string} command
   * @param {boolean} internal - the call's own word on where it came from
   * @returns {object|null} the refusal, or null when the command may run
   */
  function internalOnlyRefusal(command, internal) {
    if (internal === true || !hasCommand(command)) return null;
    return getCommand(command).internal === true ? refuse("studio_only", STUDIO_ONLY) : null;
  }

  /**
   * The agent take-loss guard: a step that would delete a take or discard one
   * has to come from the operator.
   *
   * A recording cannot be made again, so neither a command nor an undo or a
   * redo may drop one on an agent's say-so — `clip.remove`, `track.remove` and
   * `scene.remove` of a clip holding any take (discarded or not), the undo of
   * `take.add`, and any step that sets a take's `discarded` flag all end here.
   * Only `take.discard` sets it for a step of its own, and that command is
   * people-only already (see `lostTake`).
   * @param {{changes: Map<string, any>|Object<string, any>, author: object}}
   *   check - the writes the step makes
   * @returns {object|null} the refusal, or null when the step may run
   */
  function takeLossRefusal({ changes, author }) {
    if (author.kind === "human") return null;
    return lostTake(changes) === null ? null : refuse("human_only", TAKES_NEED_A_YES);
  }

  /**
   * Whether the take-loss guard has to look at what a command would write.
   *
   * False when nobody can lose anything (a person is calling, or the song holds
   * no take at all) and when the command names none of the objects a take hangs
   * off. When it is true the step is previewed on a clone and
   * `takeLossRefusal` decides on the writes themselves.
   * @param {{touched: string[], snap: object}} prepared
   * @param {object} author
   * @returns {boolean}
   */
  function mayLoseTakes(prepared, author) {
    if (author.kind === "human") return false;
    if (Object.keys(prepared.snap.takes ?? {}).length === 0) return false;
    return prepared.touched.some((ref) => TAKE_BEARING_KINDS.includes(parseObjectRef(ref)?.kind));
  }

  /**
   * The agent sound guard: a step that would lose a recorded or imported sound
   * has to come from the operator.
   *
   * A sample is a recording or an import, so the sampler's sounds get the
   * take-loss rule's treatment: a step whose writes delete a sample, drop or
   * repoint a pad that plays one, remove the bank or the sampler track the pad
   * belongs to, or replace a sampler track's device is refused for anyone but
   * the operator (see `losesSound`). A pad that plays nothing may be filled in,
   * a sample may be renamed, and a sound no locked track plays may be re-chopped
   * — those write values that are still there afterwards.
   * @param {{changes: Map<string, any>|Object<string, any>, snap: object,
   *          author: object}} check - the writes the step makes, and the song
   *   as it stands before them (a repoint is judged against it)
   * @returns {object|null} the refusal, or null when the step may run
   */
  function soundLossRefusal({ changes, snap, author }) {
    if (author.kind === "human") return null;
    return losesSound(changes, snap) ? refuse("human_only", SOUNDS_NEED_A_YES) : null;
  }

  /**
   * Whether the sound guard has to look at what a command would write.
   *
   * False when nobody can lose anything (a person is calling, or the song holds
   * no sample at all — a pad with a sound on it always comes from one) and when
   * the command names none of the objects a sound hangs off. When it is true the
   * step is previewed on a clone and `soundLossRefusal` decides on the writes
   * themselves.
   * @param {{touched: string[], snap: object}} prepared
   * @param {object} author
   * @returns {boolean}
   */
  function mayLoseSounds(prepared, author) {
    if (author.kind === "human") return false;
    if (Object.keys(prepared.snap.samples ?? {}).length === 0) return false;
    return prepared.touched.some((ref) => SOUND_BEARING_KINDS.includes(parseObjectRef(ref)?.kind));
  }

  /**
   * Apply the agent rules to one step: people-only commands, locked tracks, and
   * objects a human has open.
   * @param {{refs: string[], trackIds?: Set<string>|null, snap: object,
   *          song_id: string, author: object, humanOnly?: boolean,
   *          commandId?: string}} request
   *   `refs` are the object refs the step names; `trackIds` overrides the
   *   tracks they resolve to, for a step whose refs do not say (an undo puts a
   *   clip back, and the track comes from the value it writes); `lockedTracks`
   *   names tracks the step would put back locked, which the document no
   *   longer holds to be checked
   * @returns {object|null} a refusal, or null when the step may run
   */
  function checkAgentRules({
    refs,
    trackIds = null,
    lockedTracks = null,
    snap,
    song_id,
    author,
    humanOnly = false,
    commandId = "",
  }) {
    if (author.kind === "human") return null;

    if (humanOnly) {
      return refuse("human_only", `Only a person can run "${commandId}".`);
    }

    const tracks = trackIds ?? tracksOfRefs(snap, refs);
    for (const trackId of tracks) {
      const track = snap.tracks?.find((item) => item.id === trackId);
      if (track?.locked === true) {
        return refuse("locked", `Track "${track.name}" is locked by the operator.`);
      }
      // A track the step would put back is not in the song to be looked up,
      // so the value it writes is what says the track is locked.
      const restored = lockedTracks?.get(trackId);
      if (restored !== undefined) {
        return refuse("locked", `Track "${restored}" is locked by the operator.`);
      }
    }

    const focused = humanFocusRefs(song_id);
    if (focused.size === 0) return null;
    for (const ref of refs) {
      if (!focused.has(ref)) continue;
      return refuse("focused", `The operator has "${labelForRef(snap, ref)}" open right now.`);
    }
    return null;
  }

  /** @returns {string[]} the refs a before/after plan touches. */
  function planRefs(plan) {
    const refs = new Set();
    for (const key of plan.apply.keys()) {
      const split = splitRefField(key);
      if (split) refs.add(split.ref);
    }
    return [...refs];
  }

  /**
   * Load one history entry by id.
   * @param {string} song_id
   * @param {string} entry_id
   * @returns {Promise<object|null>}
   */
  async function readEntry(song_id, entry_id) {
    if (typeof entry_id !== "string" || entry_id === "") return null;
    const { rows } = await db.execute({
      sql: "SELECT * FROM studio_history WHERE id = ? AND song_id = ? LIMIT 1",
      args: [entry_id, song_id],
    });
    return rows.length ? entryFromRow(rows[0]) : null;
  }

  /**
   * Open one song: the live document plus its plain snapshot.
   *
   * A read, so an archived project still opens — its songs stay readable and
   * renderable. Throws a StudioError (code "not_found") for an unknown song
   * and lets an ACL refusal through unchanged.
   * @param {string} song_id
   * @returns {Promise<{doc: Y.Doc, snapshot: object, snapshot_version: number}>}
   */
  async function openSong(song_id) {
    await ensureTables();
    const row = await readRow(song_id);
    await acl.assertProjectExists(db, row.project_id, { allowArchived: true });
    const state = await ensureDoc(song_id, row);
    return {
      doc: state.doc,
      snapshot: snapshot(state.doc),
      snapshot_version: state.seq,
    };
  }

  /**
   * Create a song in a project.
   *
   * Needs `write_files`; an archived project is refused by the ACL module. The
   * new song's empty document is stored as its update seq 1 in the same
   * transaction as the song's own row, so opening it later reproduces exactly
   * what its author saw and a save that fails leaves no empty song behind.
   * @param {{project_id: number, title: string, author: object}} request
   * @returns {Promise<{ok: true, song_id: string, snapshot_version: number}|{ok: false, code: string, error: string}>}
   */
  async function createSong(request) {
    await ensureTables();
    const { project_id, title, author } = request ?? {};
    const actor = normalizeAuthor(author);

    const projectId = Number(project_id);
    let songTitle;
    try {
      if (!Number.isInteger(projectId)) {
        throw new StudioError("invalid", "A new song needs the project it belongs to.");
      }
      if (typeof title !== "string" || title.trim() === "") {
        throw new StudioError("invalid", "A new song needs a title.");
      }
      songTitle = title.trim();
      await acl.assertCapability(db, projectId, null, "write_files");
    } catch (err) {
      return toRefusal(err);
    }

    const doc = newSongDoc({ title: songTitle });
    const update = Y.encodeStateAsUpdate(doc);

    let created;
    try {
      // The row and the empty document it starts from land together, or not at
      // all: a song row whose first update is missing is a song nobody can
      // open, and there is nothing to delete it with afterwards.
      created = await createSongWithState(db, {
        project_id: projectId,
        title: songTitle,
        update,
      });
    } catch (err) {
      if (err instanceof StudioError || err?.name === ACL_ERROR_NAME) return toRefusal(err);
      if (/500 songs/.test(String(err?.message ?? ""))) return refuse("limit", err.message);
      // Nothing was written, and a song that was never created has no cached
      // document to drop.
      warn("creating a song", err);
      return refuse("storage", SAVE_FAILED);
    }

    const song_id = created.id;
    const seq = created.seq;
    songs.set(song_id, { doc, seq, project_id: projectId });

    await audit(projectId, actor, AUDIT_CREATE_ACTION, song_id, { title: songTitle });
    await broadcast(song_id, { update, entry: null });

    return { ok: true, song_id, snapshot_version: seq };
  }

  /**
   * The result shape for a step the store could not take.
   *
   * The edit is already on the live document by the time the write fails, so
   * the cached document goes with it: whatever reads the song next rebuilds it
   * from the database, which never saw this step.
   * @param {string} song_id
   * @param {unknown} err
   * @returns {object}
   */
  function storageRefusal(song_id, err) {
    songs.delete(song_id);
    warn(`saving song ${song_id}`, err);
    return refuse("storage", SAVE_FAILED);
  }

  /**
   * Everything that happens after a step is saved: the periodic snapshot, the
   * project's timeline and the push to the open clients.
   *
   * None of it may fail the step — the step is in the database and undoable —
   * so each part reports its own failure and the result stands.
   * @param {{song_id: string, state: object, seq: number, project_id: number,
   *          author: object, entry: object, update: Uint8Array}} done
   * @returns {Promise<void>}
   */
  async function afterStep({ song_id, state, seq, project_id, author, entry, update }) {
    try {
      await compactIfDue(song_id, state, seq);
    } catch (err) {
      warn("compaction", err);
    }
    await audit(project_id, author, AUDIT_ACTION, song_id, { command: entry.command });
    await broadcast(song_id, { update, entry });
  }

  /**
   * Apply one registry command to a song.
   *
   * Everything happens on the song's serial queue: the de-duplication check,
   * the ACL check, the lock and focus check against the document as it is
   * right now, the edit itself, and the persistence of its update and history
   * entry. A refusal writes nothing and broadcasts nothing.
   *
   * `internal` is the caller's word on where it came from, and only the gateway
   * process itself says it: the WS handler, the agent HTTP API and the MCP
   * command tool all call this function without it, so none of them can run a
   * command only Studio may run (see `internalOnlyRefusal`).
   * @param {{song_id: string, cmd_id?: string, command: string, args?: object,
   *          author: object, internal?: boolean}} request
   * @returns {Promise<object>} see the module header for the shape
   */
  function runCommand(request) {
    const { song_id, cmd_id = null, command, args, author, internal = false } = request ?? {};
    if (typeof song_id !== "string" || song_id === "") {
      return Promise.resolve(refuse("invalid", "A command needs the song it applies to."));
    }
    return enqueue(song_id, () => runCommandNow({ song_id, cmd_id, command, args, author, internal }));
  }

  /** The body of `runCommand`, run inside the song's queue. */
  async function runCommandNow({ song_id, cmd_id, command, args, author, internal = false }) {
    // Before the ACL, the document and the de-duplication table: a caller that
    // may not run this command gets the same answer whatever is in the song.
    const internalRefused = internalOnlyRefusal(command, internal);
    if (internalRefused) return internalRefused;

    await ensureTables();
    const actor = normalizeAuthor(author);
    const key = dedupeKey("command", actor, cmd_id);
    const fingerprint = fingerprintOf({ command, args: args ?? null });
    const replayed = recall(song_id, key, fingerprint);
    if (replayed.status === "mismatch") return refuse("invalid", CMD_ID_REUSED);
    if (replayed.status === "replay") return replayed.result;

    let row;
    let state;
    try {
      row = await readRow(song_id);
      await acl.assertCapability(db, row.project_id, null, "write_files");
      state = await ensureDoc(song_id, row);
    } catch (err) {
      return toRefusal(err);
    }

    let prepared;
    try {
      prepared = prepareCommand(state.doc, command, args);
    } catch (err) {
      return toRefusal(err);
    }

    const refused = checkAgentRules({
      refs: prepared.touched,
      snap: prepared.snap,
      song_id,
      author: actor,
      humanOnly: prepared.command.humanOnly,
      commandId: prepared.command.id,
    });
    if (refused) return refused;

    // A recorded take only goes if the operator says so. The step is previewed
    // on a clone (nothing is written) and refused before the transaction below
    // opens, so a refused step leaves both the song and its history untouched.
    if (mayLoseTakes(prepared, actor)) {
      let preview;
      try {
        preview = previewChanges(state.doc, prepared);
      } catch (err) {
        return toRefusal(err);
      }
      const lost = takeLossRefusal({ changes: preview.after, author: actor });
      if (lost) return lost;
    }

    // Nor does a recorded or imported sound: dropping a pad's sample, repointing
    // it, removing the bank or the sampler track that holds it, swapping a
    // sampler track's device and deleting a sample all end here for an agent,
    // decided on the writes this step would make.
    if (mayLoseSounds(prepared, actor)) {
      let preview;
      try {
        preview = previewChanges(state.doc, prepared);
      } catch (err) {
        return toRefusal(err);
      }
      const lost = soundLossRefusal({ changes: preview.after, snap: prepared.snap, author: actor });
      if (lost) return lost;
    }

    // Capture the diff this one transaction produces: it is exactly the update
    // a client replays and the store keeps. A refusal inside applyCommand
    // leaves the document untouched (every command validates first), so the
    // catch below persists nothing.
    const stateVector = Y.encodeStateVector(state.doc);
    let applied;
    try {
      state.doc.transact(() => {
        applied = applyCommand(state.doc, prepared);
      }, { cmd_id, author: actor });
    } catch (err) {
      return toRefusal(err);
    }
    const update = Y.encodeStateAsUpdate(state.doc, stateVector);

    const entry = makeEntry({
      song_id,
      // Provisional: the store owns the sequence number, hands the real one
      // back, and the entry is corrected from it below.
      seq: state.seq + 1,
      command: prepared.command.id,
      args: prepared.args,
      author: actor,
      summary: applied.summary,
      touched: prepared.touched,
      before: applied.before,
      after: applied.after,
      created_at: nowIso(),
    });

    let seq;
    try {
      // The update, its history entry and the song's `updated_at` land in one
      // transaction or not at all: a step nobody can undo is worse than no
      // step.
      seq = await commitStep(db, { song_id, update, entry });
    } catch (err) {
      return storageRefusal(song_id, err);
    }
    entry.seq = seq;
    state.seq = seq;

    const result = { ok: true, entry, snapshot_version: seq };
    // Remembered before the side effects finish, so a resend that arrives while
    // the broadcast is still running replays instead of applying twice.
    remember(song_id, key, fingerprint, result);
    await afterStep({
      song_id,
      state,
      seq,
      project_id: row.project_id,
      author: actor,
      entry,
      update,
    });
    return result;
  }

  /**
   * Take one history step back.
   * @param {{song_id: string, cmd_id?: string, entry_id: string, author: object}} request
   * @returns {Promise<object>} see the module header for the shape
   */
  function undo(request) {
    return historyStep("undo", request);
  }

  /**
   * Re-apply one undone step.
   * @param {{song_id: string, cmd_id?: string, entry_id: string, author: object}} request
   * @returns {Promise<object>} see the module header for the shape
   */
  function redo(request) {
    return historyStep("redo", request);
  }

  /** @param {"undo"|"redo"} kind */
  function historyStep(kind, request) {
    const { song_id, cmd_id = null, entry_id, author } = request ?? {};
    if (typeof song_id !== "string" || song_id === "") {
      return Promise.resolve(refuse("invalid", `A ${kind} needs the song it applies to.`));
    }
    return enqueue(song_id, () => historyStepNow(kind, { song_id, cmd_id, entry_id, author }));
  }

  /**
   * The body of `undo` and `redo`, run inside the song's queue.
   *
   * A step whose every field has been edited again since cannot go back: the
   * caller gets code "conflict" with the conflicting fields and nothing is
   * written. A partial undo applies what it still can and reports the rest. A
   * step the history itself refuses to apply — one that would leave a clip
   * without its track, say — comes back with the same code and the reasons in
   * `blocked`.
   *
   * A step also carries the command it moves, however far back that is: an
   * agent meets the rules of the original command, not just of "undo".
   */
  async function historyStepNow(kind, { song_id, cmd_id, entry_id, author }) {
    await ensureTables();
    const actor = normalizeAuthor(author);
    const key = dedupeKey(kind, actor, cmd_id);
    const fingerprint = fingerprintOf({ entry_id });
    const replayed = recall(song_id, key, fingerprint);
    if (replayed.status === "mismatch") return refuse("invalid", CMD_ID_REUSED);
    if (replayed.status === "replay") return replayed.result;

    let row;
    let state;
    let target;
    try {
      row = await readRow(song_id);
      await acl.assertCapability(db, row.project_id, null, "write_files");
      state = await ensureDoc(song_id, row);
      target = await readEntry(song_id, entry_id);
    } catch (err) {
      return toRefusal(err);
    }
    if (!target) {
      return refuse("not_found", `There is no history step "${entry_id}" in this song.`);
    }

    // The plan is worked out first, because the people-only rule below is
    // decided by what the step writes (see `onlyPutsTakesBack`). Planning only
    // reads the song — it dry-runs on a clone — so nothing is written by
    // working it out, and a plan that could not be worked out is reported
    // after the rule below has had its say.
    let plan;
    let planError = null;
    try {
      plan = kind === "undo" ? planUndo(state.doc, target) : planRedo(state.doc, target);
    } catch (err) {
      planError = err;
    }
    const snap = snapshot(state.doc);

    // A people-only command stays people-only when it is taken back: undoing
    // the operator's unlock would let an agent lock the track it may not lock.
    // The rule follows the `undo_of` chain, so redoing a redo is refused just
    // as the first undo of it would be. A chain that cannot be followed to an
    // ordinary command — a missing `undo_of` row, or one that never ends —
    // could be hiding anything, so it is people-only too.
    //
    // The one exception is a step that puts a recorded take back: undoing the
    // operator's `take.discard` is exactly what `take.restore` — an ordinary
    // agent edit — does, and it is the only people-only step an agent may take
    // back. The writes have to be that take's flag and its clip's comp and
    // nothing else, so redoing the discard, or taking back the undo that
    // restored it, stays people-only.
    let original = null;
    if (actor.kind !== "human") {
      original = await originalCommandId(song_id, target);
      if (original === null) {
        return refuse(
          "human_only",
          "Only a person can take that step back: the command it came from is not in this song's history.",
        );
      }
      if (hasCommand(original) && getCommand(original).humanOnly) {
        const putsTakesBack = kind === "undo"
          && original === TAKE_DISCARD_COMMAND
          && onlyPutsTakesBack(plan?.apply, snap);
        if (!putsTakesBack) {
          return refuse(
            "human_only",
            `Only a person can take back "${original}": it is a people-only command.`,
          );
        }
      }
      // A sample is a recording or an import: like `take.add`, its step is the
      // operator's to take back. Unlike a take, a sample is refused in both
      // directions — an agent neither drops one nor puts one into the song.
      if (original === SAMPLE_ADD_COMMAND) return refuse("human_only", SOUNDS_NEED_A_YES);
    }

    if (planError) return toRefusal(planError);

    // The sound guard on a step back along the history, decided on the values
    // the step would put back (`inverse.before`, which is what an undo and a
    // redo of an undo both write). It answers before the conflict check below,
    // so an agent meets the same sentence for a sound whether or not a later
    // edit has since taken one of those writes out of the plan.
    if (actor.kind !== "human") {
      const lostSound = soundLossRefusal({ changes: target.inverse?.before, snap, author: actor });
      if (lostSound) return lostSound;
    }

    // The history declines a plan it could not apply safely and says why: those
    // reasons are the answer, not "every change was edited again since".
    if (plan.blocked.length > 0) {
      return refuse("conflict", plan.blocked.join(" "), {
        blocked: plan.blocked,
        conflicts: plan.conflicts,
      });
    }

    if (plan.apply.size === 0) {
      return refuse(
        "conflict",
        kind === "undo"
          ? "Nothing to undo: every change in that step was edited again since."
          : "Nothing to redo: every change in that step was edited again since.",
        { conflicts: plan.conflicts },
      );
    }

    // A history step moves the same fields a command does, so an agent meets
    // the same locks and the same objects the operator has open. A restore puts
    // back an object the song no longer holds, so its track comes from the
    // value the plan writes rather than from the ref.
    const refs = planRefs(plan);
    const { trackIds, lockedTracks } = planTrackIds(snap, refs, plan, target);
    const refused = checkAgentRules({
      refs,
      trackIds,
      lockedTracks,
      snap,
      song_id,
      author: actor,
    });
    if (refused) return refused;

    // The guard a command meets, applied to what the plan writes: an undo or a
    // redo may not drop a recorded take on an agent's say-so — undoing a
    // `take.add`, redoing a `clip.remove` and redoing a discard all end here. A
    // plan only writes what its step changed, so a step that leaves the takes
    // alone is untouched.
    const takeLoss = takeLossRefusal({ changes: plan.apply, author: actor });
    if (takeLoss) return takeLoss;

    // Nor may a step back along the history move a take's `discarded` flag the
    // other way: a command is a fresh decision (`take.restore` is an agent's,
    // `take.discard` is the operator's), while a redo or an undo re-writes raw
    // fields. The one exception is taking the operator's `take.discard` back,
    // which is the shape `onlyPutsTakesBack` recognises.
    if (
      actor.kind !== "human"
      && movesTakeFlag(plan.apply)
      && !(kind === "undo" && original === TAKE_DISCARD_COMMAND && onlyPutsTakesBack(plan.apply, snap))
    ) {
      return refuse("human_only", TAKE_FLAG_BY_COMMAND_ONLY);
    }

    const stateVector = Y.encodeStateVector(state.doc);
    try {
      state.doc.transact(() => {
        applyPlan(state.doc, plan);
      }, { cmd_id, author: actor });
    } catch (err) {
      return toRefusal(err);
    }
    const update = Y.encodeStateAsUpdate(state.doc, stateVector);

    const entry = makeUndoEntry({
      entry: target,
      plan,
      song_id,
      // Provisional, corrected from the store below, like a command's entry.
      seq: state.seq + 1,
      author: actor,
      command: kind === "redo" ? REDO_COMMAND : UNDO_COMMAND,
    });

    let seq;
    try {
      seq = await commitStep(db, {
        song_id,
        update,
        entry,
        // The mark rides in the same transaction: the step that was taken back
        // and the step that says so can never disagree about it.
        undone: { entry_id: target.id, by_entry_id: entry.id },
      });
    } catch (err) {
      return storageRefusal(song_id, err);
    }
    entry.seq = seq;
    target.undone_by = entry.id;
    state.seq = seq;

    const result = { ok: true, entry, conflicts: plan.conflicts, snapshot_version: seq };
    remember(song_id, key, fingerprint, result);
    await afterStep({
      song_id,
      state,
      seq,
      project_id: row.project_id,
      author: actor,
      entry,
      update,
    });
    return result;
  }

  /**
   * The ordinary command a history step ultimately moves.
   *
   * An undo of an undo is still an undo of one real command at the bottom of
   * its `undo_of` chain, and that is the command whose rules apply.
   * @param {string} song_id
   * @param {object} target - the entry being undone or redone
   * @returns {Promise<string|null>} the command id, or null when the chain runs
   *   out (a step whose original is not in the song any more, or one that
   *   never reaches an ordinary command)
   */
  async function originalCommandId(song_id, target) {
    let current = target;
    for (let hop = 0; hop < MAX_UNDO_HOPS; hop += 1) {
      if (!HISTORY_COMMANDS.has(current.command)) return current.command;
      if (!current.undo_of) return null;
      const next = await readEntry(song_id, current.undo_of);
      if (!next) return null;
      current = next;
    }
    return null;
  }

  /**
   * Say which object one client has open, or that it has closed it.
   *
   * Queued with the edits, so a command that arrived after a focus always sees
   * it. Only a human client's focus blocks agents, and it blocks the exact ref
   * — not the clip's track, not its other clips.
   * @param {string} song_id
   * @param {string} client_id
   * @param {string|null} ref - e.g. "clip:abc", or null to clear it
   * @param {object} [author] - who the client is; kept from its last focus when omitted
   * @returns {Promise<{ok: true, presence: object[]}>}
   */
  function setFocus(song_id, client_id, ref = null, author = null) {
    if (typeof song_id !== "string" || song_id === "") {
      return Promise.resolve({ ok: true, presence: [] });
    }
    return enqueue(song_id, async () => {
      await ensureTables();
      // A socket can outlive the song it was opened on: there is no one to
      // place, so nothing is remembered for it and nobody is told about it.
      if (!(await getSongRow(db, song_id))) return { ok: true, presence: [] };

      const clients = focusTable(song_id);
      const previous = clients.get(client_id);
      clients.set(client_id, {
        author: normalizeAuthor(author ?? previous?.author),
        ref: typeof ref === "string" && ref !== "" ? ref : null,
      });
      const presence = presenceIn(song_id);
      await broadcast(song_id, { presence });
      return { ok: true, presence };
    });
  }

  /**
   * Drop a client's presence — its socket closed.
   *
   * A no-op for a song that never had one: presence is only ever created by a
   * focus, so an unknown song has no table here to begin with.
   * @param {string} song_id
   * @param {string} client_id
   * @returns {Promise<{ok: true, presence: object[]}>}
   */
  function clientGone(song_id, client_id) {
    if (typeof song_id !== "string" || song_id === "") {
      return Promise.resolve({ ok: true, presence: [] });
    }
    return enqueue(song_id, async () => {
      const clients = focus.get(song_id);
      const had = clients?.delete(client_id) ?? false;
      if (clients && clients.size === 0) focus.delete(song_id);
      const presence = presenceIn(song_id);
      if (had) await broadcast(song_id, { presence });
      return { ok: true, presence };
    });
  }

  /** @returns {object[]} who is on a song and what each of them has open. */
  function presenceIn(song_id) {
    const clients = focus.get(song_id);
    if (!clients) return [];
    return [...clients.entries()].map(([client_id, held]) => ({
      client_id,
      author: held.author,
      focus: held.ref,
    }));
  }

  /**
   * The presence list of one song.
   * @param {string} song_id
   * @returns {Array<{client_id: string, author: object|null, focus: string|null}>}
   */
  function presence(song_id) {
    return presenceIn(song_id);
  }

  /**
   * List songs, newest edit first.
   * @param {{project_ids?: number[]}} [filter] - restrict to these projects
   * @returns {Promise<Array<{id: string, project_id: number, title: string, updated_at: string}>>}
   */
  async function listSongs(options) {
    await ensureTables();
    const { project_ids } = options ?? {};
    return listSongRows(db, { project_ids });
  }

  /**
   * A song's shared history, newest first.
   *
   * A read: an archived project still lists what happened in its songs.
   * @param {string} song_id
   * @param {{limit?: number}} [options]
   * @returns {Promise<object[]>}
   */
  async function history(song_id, options) {
    await ensureTables();
    const { limit } = options ?? {};
    const row = await readRow(song_id);
    await acl.assertProjectExists(db, row.project_id, { allowArchived: true });
    return listHistory(db, song_id, { limit });
  }

  /**
   * Turn a refusal the hub knows into its result shape.
   *
   * A StudioError keeps its own code; an ACL refusal becomes "acl". Anything
   * else is a bug in the hub or a command, and is thrown rather than dressed
   * up as a refusal.
   * @param {Error} err
   * @returns {object}
   */
  function toRefusal(err) {
    if (err instanceof StudioError) return refuse(err.code, err.message);
    if (err?.name === ACL_ERROR_NAME) return refuse("acl", err.message);
    throw err;
  }

  return {
    openSong,
    createSong,
    runCommand,
    undo,
    redo,
    setFocus,
    clientGone,
    presence,
    listSongs,
    history,
  };
}