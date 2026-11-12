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
 * same effective writes (see `lostSound`): an agent may put a sample on an
 * empty pad, rename a sample, or re-chop one no locked track plays, but it may
 * not delete a sample, drop or repoint a pad that plays one, remove the bank or
 * the sampler track the pad belongs to, replace a sampler track's device, or
 * take a `sample.add` back.
 *
 * The same rule carries the instrument library (plan 1d, "Who can change a
 * sound"): an agent may choose the program a soundfont track plays, but the
 * font it plays, and the library entry that holds it, are the operator's — no
 * agent step may point a track at another font, remove a track that plays one,
 * take a font out of the library while anything plays it, or make a library
 * entry appear or disappear along the history (taking the operator's
 * `library.add` back removes a file from the song, and taking their
 * `library.remove` back puts one into it).
 *
 * A fourth rule guards the mapping table (see `changesLiveMapping`): an agent
 * may propose MIDI mappings — `midi.map` run by an agent always creates a
 * proposal, and `midi.propose_profile` fills a device's rows — but only the
 * operator accepts one, and no agent step may change, delete or make live a
 * mapping the operator accepted. It is decided on the same effective writes, so
 * the agent's undo of its own proposal after the operator took it in is refused
 * just as an edit to the accepted mapping would be.
 *
 * A fifth rule guards a chain's amps (see `ampGateRefusal`): the first amp on a
 * chain is an ordinary agent edit, and every amp after it is a proposal, because
 * a second amp changes what the track is heard through. No agent step — a
 * command, an undo or a redo — may leave a chain holding two amps that are not
 * proposals, which is what closes the bypass-the-first-then-add-a-second route,
 * a whole insert written without its proposal fields, and an agent's undo that
 * would put back an amp beside another live one.
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
  AMP_KIND,
  SAMPLER_DEVICE,
  SOUNDFONT_DEVICE,
  bankKey,
  effectLabel,
  insertMap,
  insertOwnerOf,
  libraryMap,
  libraryUses,
  libraryUsers,
  masterMap,
  motionParts,
  newSongDoc,
  parseObjectRef,
  returnMap,
  sampleUsers,
  sendMap,
  sendParts,
  snapshot,
  songMap,
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
// The 1c MIDI commands — the mapping table, the operator's accept and the
// device profiles — and the sentence an agent meets when it reaches for a
// mapping the operator has accepted.
import { MIDI_NEEDS_A_YES } from "./commands/midi.js";
// The 1d instrument library — a song's fonts, captures and cabinets — and the
// two preset commands a soundfont track is played with. They register here for
// the same reason: a hub started on its own must know every command.
import "./commands/library.js";
import "./commands/instruments.js";
// The 1d mixer commands — effects, sends, returns and the master. Without this
// import a hub started on its own (the gateway's) refuses every mixer command.
// It also holds the sentence an agent meets when it reaches for a second amp on
// a chain, and the people-only command that accepts one.
import { AMP_SECOND_NEEDS_A_YES } from "./commands/mixer.js";
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
 * What an agent is told when a step would change the instrument a track plays.
 *
 * Plan 1d extends the sound rule to the library: a track's font, and an amp
 * insert's capture or cabinet, are the operator's choice, because a different
 * bank is a different sound rather than a different setting of this one.
 */
const FONT_NEEDS_A_YES = "Only the operator changes the instrument a track plays.";

/**
 * What an agent is told when a step would change the capture or the cabinet an
 * amp insert plays.
 *
 * An amp insert is a library file by another route: `model_id` and `ir_id` name
 * a capture and a cabinet the operator chose, so moving either is as much a
 * sound decision as moving a track's font. The insert's own settings — input,
 * output and mix — are its own, and an agent may set those.
 */
const AMP_CAPTURE_NEEDS_A_YES = "Only the operator changes the capture or cabinet an amp plays.";

/**
 * What an agent is told when a step would take an amp insert away.
 *
 * An amp could otherwise be removed and added again with another capture, which
 * is the same choice `AMP_CAPTURE_NEEDS_A_YES` refuses, one step at a time. An
 * agent may still bypass an amp.
 */
const AMP_REMOVE_NEEDS_A_YES = "Only the operator removes an amp.";

/**
 * What an agent is told when a step would take a file out of the song's library
 * or put one into it.
 *
 * A library file is a download or an upload — a sound nothing in the song can
 * make again — so neither end of its life is an agent's to decide: removing one
 * needs the operator's yes, and so does taking back the step that added one.
 */
const LIBRARY_NEEDS_A_YES = "Only the operator adds or removes an instrument in the library.";

/**
 * The people-only command over a sound: a `sample.add` step is the operator's
 * to take back, in either direction, like `take.add`.
 */
const SAMPLE_ADD_COMMAND = "sample.add";

/**
 * The ref kinds a step can lose a recorded or imported sound through.
 *
 * `library` and `insert` are plan 1d's: a library entry is a sound in its own
 * right, and an amp insert carries the capture and the cabinet it plays.
 */
const SOUND_BEARING_KINDS = Object.freeze(["sample", "slice", "pad", "bank", "track", "library", "insert"]);

/**
 * The song containers a song written before plan 1d does not have: the mixer's
 * four and the instrument library's one. The hub makes them, in one step, when
 * it loads such a song (see `buildDoc`).
 */
const MIXER_CONTAINER_KEYS = Object.freeze(["inserts", "sends", "returns", "master", "library"]);

/**
 * The commands that write only a track's own non-sound fields — its name, its
 * mix and its lock — and so cannot lose anything even though they name a track.
 *
 * They are the one case the sound guard skips its preview for: the preview
 * clones the whole song, and an agent renaming or mixing a track in a song that
 * holds a library would pay for that clone and learn nothing. Everything else
 * still previews, so a command written later is judged on its writes until it is
 * proven to belong here.
 */
const SOUNDLESS_TRACK_COMMANDS = Object.freeze([
  "track.rename",
  "track.set_mix",
  "track.lock",
  "track.unlock",
]);

/**
 * The ref kind a step reaches a MIDI mapping through. A mapping carries no
 * track, so the lock check never looks at one; what guards it is whether it is
 * a mapping the operator accepted (see `changesLiveMapping`).
 */
const MIDI_BEARING_KINDS = Object.freeze(["midi"]);

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
  // A mixer object names its track too: an insert says which chain it sits in
  // (`"track:<id>"`), and a send carries the track it leaves from in its own
  // `track_id` (noted just above). Restoring a removed insert or send is how a
  // locked track's mix would come back, so this is where that is caught.
  if (isPlainObject(value)) {
    const owner = insertOwnerOf(value.owner);
    if (owner?.kind === "track") found.trackIds.add(owner.id);
  }
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

/**
 * Whether one track of a snapshot plays a sound: the sounds on a kit's pads, or
 * the font a soundfont track names.
 *
 * A soundfont track holds the instrument its device names, so removing the track
 * takes that font out of the song exactly as removing a sampler track takes the
 * sounds on its pads — and it closes the two-step way round the font rule
 * (remove the track, then point a new one at another font). The font id is asked
 * for its presence, not its spelling: anything but nothing is an instrument the
 * track plays, so a device that names something malformed is held rather than
 * read as a silent track.
 * @param {object} snap - a snapshot
 * @param {string} trackId
 * @returns {boolean}
 */
function trackHoldsSound(snap, trackId) {
  const pads = snap?.pads ?? {};
  if (Object.values(pads).some((pad) => pad?.track_id === trackId && playsSound(pad))) return true;
  if (!isSoundfontIn(snap, trackId)) return false;
  const fontId = trackIn(snap, trackId)?.device?.font_id;
  return fontId !== null && fontId !== undefined;
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

/** @returns {boolean} whether one track of a snapshot plays an instrument. */
function isSoundfontIn(snap, trackId) {
  return (snap?.tracks ?? []).some(
    (track) => track?.id === trackId && track?.device?.engine === SOUNDFONT_DEVICE.engine,
  );
}

/** @returns {object|null} one track of a snapshot, or null. */
function trackIn(snap, trackId) {
  return (snap?.tracks ?? []).find((track) => track?.id === trackId) ?? null;
}

/**
 * Whether one write would change a MIDI mapping that is LIVE — accepted by the
 * operator, or proposed no more — or would make a mapping live.
 *
 * A live mapping is the operator's: only they accept one, so an agent's step may
 * not edit it, delete it or turn a proposal into one. The question is asked of
 * what a write does, never of how its keys are shaped: a whole-object write is
 * live when the song holds a live mapping there or when the value it writes is
 * live, and a `proposed` write is live when it writes `false`.
 * @param {object} snap - the song as it stands before the step
 * @param {string} key - a `"<ref>|<field>"` write
 * @param {any} value - what the step would write
 * @returns {boolean}
 */
function midiWriteTouchesLive(snap, key, value) {
  const split = splitRefField(key);
  const target = split ? parseObjectRef(split.ref) : null;
  if (target?.kind !== "midi") return false;
  const current = snap?.midi_maps?.[target.id];
  if (isPlainObject(current) && current.proposed !== true) return true;
  if (split.field === "proposed") return value === false;
  if (split.field === "*") return isPlainObject(value) && value.proposed === false;
  return false;
}

/**
 * Whether a change set holds a write that would change a live MIDI mapping or
 * make one live.
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes - the
 *   writes the step makes, keyed `"<ref>|<field>"`
 * @param {object} snap - the song as it stands before those writes
 * @returns {boolean}
 */
function changesLiveMapping(changes, snap) {
  for (const [key, value] of changeEntries(changes)) {
    if (midiWriteTouchesLive(snap, key, value)) return true;
  }
  return false;
}

/**
 * The agent MIDI guard: a step that would change an accepted MIDI mapping has to
 * come from the operator.
 *
 * A mapping the operator accepted is theirs alone (plan 1c, Review Focus 4), so
 * neither a fresh command nor a step back along the history may move it on an
 * agent's say-so: an agent may propose as many mappings as it likes and remove
 * its own proposals, but it can neither edit a live mapping, delete one nor make
 * one live.
 * @param {{changes: Map<string, any>|Object<string, any>, snap: object,
 *          author: object}} check - the writes the step makes, and the song as it
 *   stands before them (a mapping already accepted is judged against it)
 * @returns {object|null} the refusal, or null when the step may run
 */
function midiLockRefusal({ changes, snap, author }) {
  if (author.kind === "human") return null;
  return changesLiveMapping(changes, snap) ? refuse("human_only", MIDI_NEEDS_A_YES) : null;
}

/**
 * Whether the MIDI guard has to look at what a command would write.
 *
 * False when nobody can reach a mapping (a person is calling, or the song holds
 * no mapping at all) and when the command names no mapping. When it is true the
 * step is previewed on a clone and `midiLockRefusal` decides on the writes
 * themselves.
 * @param {{touched: string[], snap: object}} prepared
 * @param {object} author
 * @returns {boolean}
 */
function mayTouchMidi(prepared, author) {
  if (author.kind === "human") return false;
  if (Object.keys(prepared.snap.midi_maps ?? {}).length === 0) return false;
  return prepared.touched.some((ref) => MIDI_BEARING_KINDS.includes(parseObjectRef(ref)?.kind));
}

/** @returns {string[]} the object refs a set of writes names. */
function changeRefs(changes) {
  const refs = new Set();
  for (const [key] of changeEntries(changes)) {
    const split = splitRefField(key);
    if (split) refs.add(split.ref);
  }
  return [...refs];
}

/**
 * The amp inserts a step's writes leave behind, as one small record each: the
 * chain an insert sits in, its kind, and whether it is still a proposal.
 *
 * Projected from the song's own inserts and the writes themselves, so a whole
 * object put back, a `kind` field and a `proposed` field are all read the same
 * way — the question is about the chains the step leaves, never about how its
 * keys are shaped.
 * @param {object} snap - the song as it stands before those writes
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes - the
 *   writes the step makes, keyed `"<ref>|<field>"`; none when omitted
 * @returns {Map<string, {owner: string, kind: any, proposed: boolean}>}
 */
function insertsAfter(snap, changes) {
  const state = new Map();
  for (const [id, insert] of Object.entries(snap?.inserts ?? {})) {
    if (!isPlainObject(insert)) continue;
    state.set(id, {
      owner: typeof insert.owner === "string" ? insert.owner : "",
      kind: insert.kind,
      proposed: insert.proposed === true,
    });
  }
  for (const [key, value] of changeEntries(changes)) {
    const split = splitRefField(key);
    const target = split ? parseObjectRef(split.ref) : null;
    if (target?.kind !== "insert") continue;
    if (split.field === "*") {
      if (value === null) {
        state.delete(target.id);
        continue;
      }
      if (!isPlainObject(value)) continue;
      state.set(target.id, {
        owner: typeof value.owner === "string" ? value.owner : "",
        kind: value.kind,
        proposed: value.proposed === true,
      });
      continue;
    }
    const held = state.get(target.id);
    if (!held) continue;
    if (split.field === "kind") held.kind = value;
    else if (split.field === "proposed") held.proposed = value === true;
    else if (split.field === "owner") held.owner = typeof value === "string" ? value : "";
  }
  return state;
}

/**
 * How many amps one chain holds, and how many of them are live.
 * @param {Map<string, {owner: string, kind: any, proposed: boolean}>} state
 * @returns {Map<string, {amps: number, live: number}>}
 */
function ampCountsByOwner(state) {
  const counts = new Map();
  for (const insert of state.values()) {
    if (insert.kind !== AMP_KIND || insert.owner === "") continue;
    const held = counts.get(insert.owner) ?? { amps: 0, live: 0 };
    held.amps += 1;
    if (insert.proposed !== true) held.live += 1;
    counts.set(insert.owner, held);
  }
  return counts;
}

/**
 * Whether a write makes a chain hold a second amp that is not a proposal
 * without the chain having held one before.
 *
 * The two shapes that reach this are the ones a chain count alone cannot see:
 * a whole insert object arriving as a live amp (an `insert.add` with its
 * proposal fields stripped, or a chain an undo puts back whole) where the chain
 * it joins ends up with two, and a raw `proposed: false` write on an insert that
 * was a proposal (undoing the operator's `insert.accept`, which is people-only
 * and caught a step earlier — this is the same answer one layer down).
 * @param {object} snap - the song as it stands before the writes
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes
 * @param {Map<string, {owner: string, kind: any, proposed: boolean}>} state - the
 *   inserts the writes leave behind
 * @param {Map<string, {amps: number, live: number}>} counts - the same, counted
 *   per chain
 * @returns {boolean}
 */
function makesSecondAmpLive(snap, changes, state, counts) {
  for (const [key, value] of changeEntries(changes)) {
    const split = splitRefField(key);
    const target = split ? parseObjectRef(split.ref) : null;
    if (target?.kind !== "insert") continue;
    const held = Object.hasOwn(snap?.inserts ?? {}, target.id) ? snap.inserts[target.id] : null;
    if (split.field === "proposed" && value === false && isPlainObject(held) && held.proposed === true) {
      return true;
    }
    if (split.field !== "*" || !isPlainObject(value) || value.proposed === true) continue;
    // Only an insert the song does not hold yet: one it holds is judged by the
    // chain counts above (a move, a retune, a removal).
    if (held !== null) continue;
    const after = state.get(target.id);
    if (after?.kind !== AMP_KIND) continue;
    if ((counts.get(after.owner)?.amps ?? 0) >= 2) return true;
  }
  return false;
}

/**
 * The agent amp gate: no step may leave a chain holding two amps that are not
 * proposals.
 *
 * The first amp on a chain is an agent's own edit; every amp after it is the
 * operator's to accept, so an agent may only propose one (see `insert.add` and
 * `insert.accept`). The rule is about the CHAIN the step leaves, not about which
 * command ran, so every route to a second live amp meets it: an insert added
 * with the proposal fields stripped, a chain reached by a move, the first amp
 * bypassed and a second one added beside it, and a step back along the history
 * that would put back an amp whose chain has held another one live since.
 * @param {{changes: Map<string, any>|Object<string, any>, snap: object,
 *          author: object}} check - the writes the step makes, and the song as it
 *   stands before them
 * @returns {object|null} the refusal, or null when the step may run
 */
function ampGateRefusal({ changes, snap, author }) {
  if (author.kind === "human") return null;
  const before = ampCountsByOwner(insertsAfter(snap, null));
  const state = insertsAfter(snap, changes);
  const after = ampCountsByOwner(state);
  for (const [owner, count] of after) {
    const held = before.get(owner);
    // A chain with no amp yet is where an agent's first amp lands, live: there is
    // nothing it could add a second one beside.
    if (!held || held.amps === 0) continue;
    if (count.live > held.amps) return refuse("human_only", AMP_SECOND_NEEDS_A_YES);
  }
  if (makesSecondAmpLive(snap, changes, state, after)) {
    return refuse("human_only", AMP_SECOND_NEEDS_A_YES);
  }
  return null;
}

/**
 * Whether the amp gate has to look at what a step would write.
 *
 * False when a person is calling, and false when the step names no insert and
 * no chain that already holds an amp: a track's fader, a scene's name or a
 * sample's key cannot make a chain hold a second amp. When it is true the step
 * is previewed on a clone and `ampGateRefusal` decides on the writes themselves.
 * @param {string[]} refs - the object refs the step names or writes
 * @param {object} snap - the song as it stands before the step
 * @param {object} author
 * @returns {boolean}
 */
function mayTouchAmpInsert(refs, snap, author) {
  if (author.kind === "human") return false;
  const ampOwners = new Set();
  for (const insert of Object.values(snap?.inserts ?? {})) {
    if (!isPlainObject(insert) || insert.kind !== AMP_KIND) continue;
    if (typeof insert.owner === "string" && insert.owner !== "") ampOwners.add(insert.owner);
  }
  return refs.some((ref) => {
    const target = parseObjectRef(ref);
    if (!target) return false;
    if (target.kind === "insert") return true;
    return ampOwners.has(ref);
  });
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
 * Whether one write to a track loses a sound: a kit's pads lose theirs when the
 * track goes or its device (the kit's engine) is replaced, and a soundfont track
 * loses its instrument when the track goes or the font it names moves to another
 * value.
 *
 * A soundfont track's preset is NOT part of this question: bank and program are
 * settings of the instrument, and changing one is an ordinary agent edit (plan
 * 1d, Global Constraints).
 * @param {object} snap - the song as it stands before the step
 * @param {string} trackId
 * @param {string} field - `"*"`, `"device"`, `"device.font_id"` (and its
 *   siblings), or another field of the track
 * @param {any} value - what the step would write
 * @returns {boolean}
 */
function trackWriteLosesSound(snap, trackId, field, value) {
  const track = trackIn(snap, trackId);
  if (field === "device" || field.startsWith("device.")) {
    if (isSamplerIn(snap, trackId)) {
      // A kit's engine is its device: only a whole-device write can swap it.
      return field === "device" && !isDeepStrictEqual(track?.device ?? null, value ?? null);
    }
    if (!isSoundfontIn(snap, trackId)) return false;
    if (field === "device.font_id") return takesAway(track?.device?.font_id ?? null, value ?? null);
    if (field === "device") return takesAway(track?.device?.font_id ?? null, value?.font_id ?? null);
    return false;
  }
  if (field === "font_id") {
    if (!isSoundfontIn(snap, trackId)) return false;
    return takesAway(track?.device?.font_id ?? null, value ?? null);
  }
  if (field !== "*") return false;
  if (value === null) return trackHoldsSound(snap, trackId);
  // A whole track put back is the same instrument it was recorded as; a track
  // that came back as a different or a missing one is a different sound.
  if (!track || !isPlainObject(value)) return false;
  if (isSoundfontIn(snap, trackId)) {
    return takesAway(track.device?.font_id ?? null, value.device?.font_id ?? null);
  }
  if (!isSamplerIn(snap, trackId)) return false;
  return !isDeepStrictEqual(track.device ?? null, value.device ?? null);
}

/**
 * Which of an amp insert's two reference fields a write names, for the guard's
 * own question: `model_id` is the capture, `ir_id` the cabinet.
 * @type {Readonly<string[]>}
 */
const AMP_REFERENCES_IN_PARAMS = Object.freeze(["model_id", "ir_id"]);

/**
 * Whether a write would move an amp insert to another capture or cabinet.
 *
 * Judged on the VALUES, never on the shape of the key: a whole-object write, a
 * `params.model_id` field and an undo's own write all end here, and none of them
 * counts when it puts back the value the insert already holds.
 * @param {object} insert - the insert as the snapshot holds it (before the write)
 * @param {unknown} params - the parameters the write names, whole or one field
 * @returns {boolean}
 */
function ampReferenceMoves(insert, params) {
  if (!isPlainObject(params)) return false;
  const before = isPlainObject(insert?.params) ? insert.params : {};
  for (const name of AMP_REFERENCES_IN_PARAMS) {
    if (!Object.hasOwn(params, name)) continue;
    if (!isDeepStrictEqual(before[name] ?? null, params[name] ?? null)) return true;
  }
  return false;
}

/**
 * Whether one write to an insert loses a sound: an amp insert is gone when it is
 * taken away or turned into something else, and its sound is another one when
 * the capture or the cabinet it names moves.
 *
 * An effect insert has no sound of its own to lose — removing, bypassing,
 * moving or retuning one is an ordinary agent edit — so only an amp reaches
 * these two answers. ADDING an amp is not a loss: an agent may build a guitar
 * chain with a capture the operator put in the song's library (plan 1d, PR C).
 *
 * A PROPOSAL loses nothing: it plays nothing, so an agent may take its own
 * proposal away, retune it or repoint it, and the operator's own inserted amp
 * keeps the capture they chose. The second-amp case the bypass-then-add route
 * used to open is closed by the amp gate (`ampGateRefusal`), which judges the
 * chain rather than one insert's fields.
 * @param {object} snap - the song as it stands before the step
 * @param {string} insertId
 * @param {string} field - `"*"`, `"kind"`, `"params.<name>"`, or another field
 * @param {any} value - what the step would write
 * @returns {string|null} the sentence, or null when nothing is lost
 */
function insertWriteLosesSound(snap, insertId, field, value) {
  const insert = Object.hasOwn(snap.inserts ?? {}, insertId) ? snap.inserts[insertId] : null;
  if (!isPlainObject(insert) || insert.kind !== AMP_KIND) return null;
  // A proposal is not a sound yet: only the operator's yes gives it one.
  if (insert.proposed === true) return null;
  if (field === "*") {
    if (value === null) return AMP_REMOVE_NEEDS_A_YES;
    if (!isPlainObject(value)) return null;
    // A whole insert put back as another kind is the amp taken away.
    if (typeof value.kind === "string" && value.kind !== AMP_KIND) return AMP_REMOVE_NEEDS_A_YES;
    return ampReferenceMoves(insert, value.params) ? AMP_CAPTURE_NEEDS_A_YES : null;
  }
  if (field === "kind") return value === AMP_KIND ? null : AMP_REMOVE_NEEDS_A_YES;
  if (field.startsWith("params.")) {
    const name = field.slice("params.".length);
    if (!AMP_REFERENCES_IN_PARAMS.includes(name)) return null;
    return ampReferenceMoves(insert, { [name]: value }) ? AMP_CAPTURE_NEEDS_A_YES : null;
  }
  return null;
}

/**
 * The sentence an agent meets for the sound a change set would lose, or null
 * when it loses none.
 *
 * Judged on the values a step writes, never on the shape of its keys: a sampler
 * sound is lost through a whole-object delete, through a `sample_id` or
 * `slice_id` that moves off the value it holds, and through the bank, the track
 * or the device that carries it; an instrument is lost through the track that
 * plays it going, through the font that track names moving to another value, and
 * through a library entry that something still plays — and a fresh
 * `library.remove` of an entry nothing plays is an ordinary agent edit, which
 * that command decides itself. (A step back along the history is stricter, and
 * asks the question the command's name cannot: see `changesLibraryEntries`.) A
 * write that fills an empty pad, renames a sample, sets a program, or changes
 * any other field of a pad or a track is not a loss, and neither is putting back
 * something that was taken away.
 *
 * Each kind of loss has its own sentence, because each asks the operator a
 * different question (plan 1d, "Who can change a sound").
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes - the
 *   writes the step makes, keyed `"<ref>|<field>"`
 * @param {object} snap - the song as it stands before those writes
 * @returns {string|null} the refusal's message, or null
 */
function lostSound(changes, snap) {
  for (const [key, value] of changeEntries(changes)) {
    const split = splitRefField(key);
    const target = split ? parseObjectRef(split.ref) : null;
    if (!target) continue;
    if (target.kind === "library") {
      // An entry goes when the whole object is deleted, and it is only a loss
      // while something plays it: an unused file may be tidied away by anyone.
      // (Every step back along the history is refused library writes whole — see
      // `changesLibraryEntries`.)
      if (split.field !== "*" || value !== null) continue;
      if (libraryUses(snap, target.id)) return LIBRARY_NEEDS_A_YES;
      continue;
    }
    if (target.kind === "sample") {
      if (split.field === "*" && value === null) return SOUNDS_NEED_A_YES;
      continue;
    }
    if (target.kind === "slice") {
      if (split.field !== "*" || value !== null) continue;
      const sampleId = keyHead(target.id);
      if (sampleId === null) continue;
      if (sliceInUse(snap, sampleId, target.id.slice(sampleId.length + 1))) return SOUNDS_NEED_A_YES;
      continue;
    }
    if (target.kind === "pad") {
      if (padWriteLosesSound(snap, target.id, split.field, value)) return SOUNDS_NEED_A_YES;
      continue;
    }
    if (target.kind === "bank") {
      if (split.field !== "*" || value !== null) continue;
      const trackId = keyHead(target.id);
      if (trackId === null) continue;
      if (bankHoldsSound(snap, trackId, target.id.slice(trackId.length + 1))) return SOUNDS_NEED_A_YES;
      continue;
    }
    if (target.kind === "insert") {
      // An amp carries the operator's capture and cabinet; an effect carries
      // nothing to lose. Both are judged on the values written (see
      // `insertWriteLosesSound`).
      const sentence = insertWriteLosesSound(snap, target.id, split.field, value);
      if (sentence) return sentence;
      continue;
    }
    if (target.kind === "track" && trackWriteLosesSound(snap, target.id, split.field, value)) {
      return isSoundfontIn(snap, target.id) ? FONT_NEEDS_A_YES : SOUNDS_NEED_A_YES;
    }
  }
  return null;
}

/**
 * Whether a change set would make a library entry appear or take one away.
 *
 * Judged on the whole-object writes themselves, never on the name of the command
 * a step moves: a step back along the history may be any command at all, and a
 * whole-object write with an object where the song holds no entry makes one
 * (undoing the operator's `library.remove`), while a whole-object write with
 * `null` takes one away (undoing their `library.add`). Only one of those two
 * commands is `library.add`, which is why the question cannot be asked of the
 * command.
 *
 * The plan's "upload id" rule has nothing to read here and is gone: by the time
 * an entry is in the document its `upload_id` is one field among many, and a
 * step that writes an entry whole either makes it or removes it — there is no
 * third write that only re-points a library file at an upload.
 *
 * This is the history rule and nothing else: a fresh `library.remove` of an
 * entry nothing plays stays an agent's own edit (that command refuses while
 * something plays the entry), while no step back onto the library is.
 * @param {Map<string, any>|Object<string, any>|null|undefined} changes - the
 *   writes the step makes, keyed `"<ref>|<field>"`
 * @param {object} snap - the song as it stands before those writes
 * @returns {boolean}
 */
function changesLibraryEntries(changes, snap) {
  for (const [key, value] of changeEntries(changes)) {
    const split = splitRefField(key);
    const target = split ? parseObjectRef(split.ref) : null;
    if (target?.kind !== "library" || split.field !== "*") continue;
    // `Object.hasOwn`, because a snapshot's library is an ordinary object and an
    // entry id like "__proto__" is one key of it like any other.
    const held = Object.hasOwn(snap?.library ?? {}, target.id);
    if (value === null ? held : !held) return true;
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
 * The state vector a step's update is encoded from: the document as it was just
 * before the step, so the update is exactly the step and nothing else.
 *
 * The one exception is the first step taken on a song the hub made containers
 * for while loading it (see `buildDoc`). That creation is not in the stored log —
 * it happened after the last update was applied — so the step starts one vector
 * earlier and carries the creation along with itself. A container the log does
 * not mention is one a later load cannot find, and the step's own write into it
 * would be lost with it.
 * @param {{doc: import("yjs").Doc, preloadVector?: Uint8Array|null}} state
 * @returns {Uint8Array}
 */
function stepStateVector(state) {
  return state.preloadVector ?? Y.encodeStateVector(state.doc);
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
 * a pattern, a step and a motion lane belong to the track of their clip, and a
 * sample or a slice touches EVERY track that plays it — re-chopping or renaming
 * a sound is a write to every kit that has it on a pad, so a locked one among
 * them refuses
 * the step (see `sampleUsers`). The mixer's objects name their track too: an
 * insert sits in that track's chain and a send leaves from it (see below).
 * Nothing here walks to a clip's track from a *focused* ref — focus matches the
 * ref exactly.
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
  // A motion lane is one field of one pattern of one clip
  // (`<clip_id>/<pattern_id>/<lane>`), so the clip the ref names is the track
  // whose kit plays it — and a locked track's lane is off-limits on undo and
  // redo exactly as it is on the branch's own write.
  if (target.kind === "motion") {
    const parts = motionParts(target.id);
    return parts ? trackOfClip(snap, parts.clipId) : [];
  }
  if (target.kind === "sample") return sampleUsers(snap, target.id);
  if (target.kind === "slice") {
    return sampleUsers(snap, snap.slices?.[target.id]?.sample_id ?? keyHead(target.id));
  }
  // A library entry is a sound every track that plays it holds, the way a
  // sample is a sound every kit that has it on a pad holds.
  if (target.kind === "library") return libraryUsers(snap, target.id);
  // The mixer's objects belong to the track they mix: an insert sits in that
  // track's chain, and a send leaves from that track. A return's chain, a return
  // and the master belong to no track at all, so nothing but the operator's own
  // lock rules apply to them.
  if (target.kind === "insert") {
    const owner = insertOwnerOf(snap.inserts?.[target.id]?.owner);
    return owner?.kind === "track" ? [owner.id] : [];
  }
  if (target.kind === "send") {
    // The send's own field says which track it leaves from; the key it lives
    // under says it when a restore no longer has the object to read.
    const send = snap.sends?.[target.id];
    return idsOrNone(send?.track_id ?? sendParts(target.id)?.trackId);
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
 * What a sentence calls the chain an insert sits in: the track's or return's
 * name, or "the master".
 * @param {object} snap - a plain snapshot
 * @param {string} owner - `"track:<id>"`, `"return:<id>"` or `"master"`
 * @returns {string}
 */
function chainLabelFor(snap, owner) {
  const target = insertOwnerOf(owner);
  if (!target) return typeof owner === "string" && owner !== "" ? `"${owner}"` : "a chain the song has not got";
  if (target.kind === "master") return "the master";
  if (target.kind === "track") {
    return snap.tracks?.find((track) => track.id === target.id)?.name ?? target.id;
  }
  return snap.returns?.[target.id]?.name ?? target.id;
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
  if (target.kind === "library") return snap.library?.[target.id]?.name ?? target.id;
  // The mixer's objects, so a refusal over one of them names the effect, the
  // send or the return it is about instead of falling back to the song.
  if (target.kind === "insert") {
    const insert = snap.inserts?.[target.id];
    const label = effectLabel(insert?.kind ?? "") || target.id;
    return `the ${label} on ${chainLabelFor(snap, insert?.owner)}`;
  }
  if (target.kind === "send") {
    const send = snap.sends?.[target.id];
    const parts = send ? { trackId: send.track_id, returnId: send.return_id } : sendParts(target.id);
    const track = snap.tracks?.find((item) => item.id === parts?.trackId)?.name ?? parts?.trackId ?? target.id;
    const back = snap.returns?.[parts?.returnId]?.name ?? parts?.returnId ?? "";
    return `the send from ${track} to ${back}`;
  }
  if (target.kind === "return") return snap.returns?.[target.id]?.name ?? target.id;
  if (target.kind === "master") return "the master";
  if (target.kind === "midi") {
    const mapping = snap.midi_maps?.[target.id];
    if (!mapping) return target.id;
    return `the mapping for ${mapping.message?.type} ${mapping.message?.number} on "${mapping.device_name}"`;
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
 *   called with `{update, entry}` after every applied step, `{presence}` after
 *   every presence change, and `{state, history, presence}` when a song's
 *   cached document was dropped and the whole document goes out again (see
 *   `storageRefusal`); whatever it returns is awaited
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
 *   setFocus, clientGone, presence, listSongs, history, libraryHashes
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
   *
   * A song written before the mixer (or before the instrument library) has no
   * container for it: the containers are made here, once, together, as a song
   * created today has them. Two first writes then write two keys of one map
   * instead of each making a map for the same key and losing the other's — and
   * because the creation is not in the stored log yet, the state vector taken
   * just before it is kept (`preloadVector`) so the first step saved after the
   * load carries the creation along with itself (see `stepStateVector`). A song
   * that already has all five is left alone.
   * @param {string} song_id
   * @param {object} row
   * @returns {Promise<{doc: Y.Doc, seq: number, project_id: number,
   *                    preloadVector: Uint8Array|null}>}
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

    let preloadVector = null;
    const song = songMap(doc);
    if (MIXER_CONTAINER_KEYS.some((key) => !(song.get(key) instanceof Y.Map))) {
      preloadVector = Y.encodeStateVector(doc);
      doc.transact(() => {
        insertMap(doc);
        sendMap(doc);
        returnMap(doc);
        masterMap(doc);
        libraryMap(doc);
      }, "studio:old-song");
    }
    return { doc, seq, project_id: Number(row.project_id), preloadVector };
  }

  /**
   * The cached document of a song, loaded at most once even when two requests
   * race for it.
   * @param {string} song_id
   * @param {object} row
   * @returns {Promise<{doc: Y.Doc, seq: number, project_id: number,
   *                    preloadVector: Uint8Array|null}>}
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
   * The agent sound guard: a step that would lose a recorded or imported sound,
   * or the instrument a track plays, has to come from the operator.
   *
   * A sample is a recording or an import, and a library file is a download or an
   * upload, so both get the take-loss rule's treatment: a step whose writes
   * delete a sample, drop or repoint a pad that plays one, remove the bank or
   * the sampler track the pad belongs to, replace a sampler track's device,
   * remove a soundfont track that plays a font, move a soundfont track to another
   * font, delete a library entry something still plays, remove an amp insert or
   * move the capture or cabinet one plays is refused for anyone but the operator
   * (see `lostSound`). A pad that plays nothing may be filled
   * in, a sample may be renamed, a soundfont track's program may be set, an amp
   * insert may be added, bypassed, moved or retuned, and an
   * unused library entry may be tidied away — those write values that are still
   * there afterwards.
   * @param {{changes: Map<string, any>|Object<string, any>, snap: object,
   *          author: object}} check - the writes the step makes, and the song
   *   as it stands before them (a repoint is judged against it)
   * @returns {object|null} the refusal, or null when the step may run
   */
  function soundLossRefusal({ changes, snap, author }) {
    if (author.kind === "human") return null;
    const sentence = lostSound(changes, snap);
    return sentence === null ? null : refuse("human_only", sentence);
  }

  /**
   * Whether the sound guard has to look at what a command would write.
   *
   * False when nobody can lose anything — a person is calling, or the song holds
   * no sound at all: no sample (a pad with a sound on it always comes from one),
   * no library entry and no insert — when the command names none of the objects
   * a sound hangs off, and when it names only tracks and is one of the handful of
   * commands that write nothing but a track's name, its mix or its lock (see
   * `SOUNDLESS_TRACK_COMMANDS`). Otherwise the step is previewed on a clone and
   * `soundLossRefusal` decides on the writes themselves.
   * @param {{command: Readonly<object>, touched: string[], snap: object}} prepared
   * @param {object} author
   * @returns {boolean}
   */
  function mayLoseSounds(prepared, author) {
    if (author.kind === "human") return false;
    const snap = prepared.snap;
    const empty = Object.keys(snap.samples ?? {}).length === 0
      && Object.keys(snap.library ?? {}).length === 0
      && Object.keys(snap.inserts ?? {}).length === 0;
    if (empty) return false;
    const bearing = prepared.touched.filter((ref) =>
      SOUND_BEARING_KINDS.includes(parseObjectRef(ref)?.kind));
    if (bearing.length === 0) return false;
    // A command that names only tracks and writes none of their sound fields has
    // nothing to lose, so it skips the clone `previewChanges` makes; everything
    // else, `track.set_device` and `track.set_font` included, still previews.
    const tracksOnly = bearing.every((ref) => parseObjectRef(ref)?.kind === "track");
    if (tracksOnly && SOUNDLESS_TRACK_COMMANDS.includes(prepared.command.id)) return false;
    return true;
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
   *
   * A song the hub made containers for while loading (`preloadVector`) is the
   * one case where that is not enough on its own. Those containers reached the
   * open pages only through the state frame they joined with — nothing stored
   * the creation yet — and the rebuild makes a fresh set under a new client id.
   * The song's room is therefore sent the rebuilt document whole, so every page
   * rebuilds from it instead of keeping containers the server no longer writes
   * into (see `resyncSong`).
   * @param {string} song_id
   * @param {object} row - the song's row, so the rebuild need not read it again
   * @param {unknown} err
   * @returns {Promise<object>}
   */
  async function storageRefusal(song_id, row, err) {
    const dropped = songs.get(song_id);
    const preloaded = Boolean(dropped?.preloadVector);
    songs.delete(song_id);
    warn(`saving song ${song_id}`, err);
    if (preloaded) await resyncSong(song_id, row);
    return refuse("storage", SAVE_FAILED);
  }

  /**
   * Push a song's document to its room whole, after the cached one was dropped.
   *
   * A full state frame is what the page answers by building its document over
   * from the server's (`onState` in the panel): an incremental update would be
   * merged into the containers the page already holds, which are the ones the
   * dropped document made. The frame says `resync: true`, because it is not the
   * answer to a fresh hello: the socket, and every command on it, is still the
   * page's, so the page keeps its in-flight commands and says nothing about
   * reconnecting. Best effort — the step was refused already, and a page that
   * misses the frame still rebuilds the song the next time it joins.
   * @param {string} song_id
   * @param {object} row
   * @returns {Promise<void>}
   */
  async function resyncSong(song_id, row) {
    try {
      const state = await ensureDoc(song_id, row);
      const entries = await history(song_id);
      await broadcast(song_id, {
        state: Y.encodeStateAsUpdate(state.doc),
        history: entries,
        presence: presence(song_id),
        resync: true,
      });
    } catch (err) {
      warn("resync", err);
    }
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
      prepared = prepareCommand(state.doc, command, args, { author: actor });
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

    // Nor may it reach a MIDI mapping the operator accepted: an agent proposes
    // mappings, and only the operator's yes makes one live (plan 1c, Review
    // Focus 4). Decided on the writes this step would make, so an agent's new
    // proposal passes and an edit to an accepted mapping does not.
    if (mayTouchMidi(prepared, actor)) {
      let preview;
      try {
        preview = previewChanges(state.doc, prepared);
      } catch (err) {
        return toRefusal(err);
      }
      const locked = midiLockRefusal({ changes: preview.after, snap: prepared.snap, author: actor });
      if (locked) return locked;
    }

    // Nor may it leave a chain holding two amps that are not proposals: the
    // first amp on a chain is an agent's to add, and every amp after it is the
    // operator's to accept (see `ampGateRefusal`). Decided on the writes this
    // step would make, so an agent's own proposal passes and a second live amp
    // does not, however it was reached.
    if (mayTouchAmpInsert(prepared.touched, prepared.snap, actor)) {
      let preview;
      try {
        preview = previewChanges(state.doc, prepared);
      } catch (err) {
        return toRefusal(err);
      }
      const refusedAmp = ampGateRefusal({ changes: preview.after, snap: prepared.snap, author: actor });
      if (refusedAmp) return refusedAmp;
    }

    // Capture the diff this one transaction produces: it is exactly the update
    // a client replays and the store keeps. A refusal inside applyCommand
    // leaves the document untouched (every command validates first), so the
    // catch below persists nothing.
    const stateVector = stepStateVector(state);
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
      return storageRefusal(song_id, row, err);
    }
    entry.seq = seq;
    state.seq = seq;
    // The step's update carried any container the hub made while loading the
    // song, so from here on a step is encoded from the document as it is.
    state.preloadVector = null;

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
      // A library file is a download or an upload, and the same answer holds in
      // both directions: neither putting one into the song nor taking one out is
      // an agent's step (plan 1d, "Who can change a sound"). Decided on the
      // writes the step would put back and not on the command it came from: the
      // undo of the operator's `library.remove` makes an entry appear just as the
      // undo of their `library.add` takes one away, and only the second of those
      // names `library.add` (see `changesLibraryEntries`).
      if (changesLibraryEntries(target.inverse?.before, snap)) {
        return refuse("human_only", LIBRARY_NEEDS_A_YES);
      }
    }

    if (planError) return toRefusal(planError);

    // The sound guard on a step back along the history, decided on the values
    // the step would put back (`inverse.before`, which is what an undo and a
    // redo of an undo both write). It answers before the conflict check below,
    // so an agent meets the same sentence for a sound whether or not a later
    // edit has since taken one of those writes out of the plan.
    if (actor.kind !== "human") {
      const refusedSound = soundLossRefusal({ changes: target.inverse?.before, snap, author: actor });
      if (refusedSound) return refusedSound;
    }

    // The MIDI guard on a step back along the history, judged the same way: the
    // writes the plan makes and the values the step would put back. Undoing the
    // agent's own proposal after the operator accepted it, undoing the
    // operator's edit of an accepted mapping, redoing an edit onto one and
    // redoing the operator's `midi.map` all meet this sentence; the operator's
    // `midi.accept` is caught a step earlier, because it is people-only.
    if (actor.kind !== "human") {
      const locked = changesLiveMapping(plan?.apply, snap)
        || changesLiveMapping(target.inverse?.before, snap);
      if (locked) return refuse("human_only", MIDI_NEEDS_A_YES);
    }

    // The amp gate on a step back along the history, judged the same way: the
    // writes the plan makes and the values the step would put back. An agent
    // undoing the operator's removal of an amp into a chain that has held
    // another one live since, or any step that would turn a proposal live, meets
    // the sentence a fresh second amp meets.
    if (actor.kind !== "human") {
      const ampRefs = [...new Set([...changeRefs(plan?.apply), ...changeRefs(target.inverse?.before)])];
      if (mayTouchAmpInsert(ampRefs, snap, actor)) {
        const refusedAmp = ampGateRefusal({ changes: plan?.apply, snap, author: actor })
          || ampGateRefusal({ changes: target.inverse?.before, snap, author: actor });
        if (refusedAmp) return refusedAmp;
      }
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

    const stateVector = stepStateVector(state);
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
      return storageRefusal(song_id, row, err);
    }
    entry.seq = seq;
    target.undone_by = entry.id;
    state.seq = seq;
    // As in a command: the first step of a song loaded with containers made for
    // it carried that creation, and no later step has to.
    state.preloadVector = null;

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
   * Every sha256 any library entry of any song on this instance names.
   *
   * This is the set the instrument housekeeping pass (`libraryGc`,
   * `library-store.js`) takes as "in use", so a stored file a song names is
   * never collected. It is a read on the hub's own store and asks no ACL: the
   * caller is the instance itself, not a person or a bot.
   *
   * A song that is already open answers from its live document; every other
   * song is read the way `openSong` reads it — its snapshot plus its newer
   * updates — and is not kept in memory. A song whose document cannot be read
   * throws, and the caller must then SKIP its pass entirely: a GC that saw only
   * part of the instance could delete a file a song it did not read names.
   * @returns {Promise<Set<string>>} the sha256 of every library entry in use
   */
  async function libraryHashes() {
    await ensureTables();
    const hashes = new Set();
    for (const song of await listSongRows(db, {})) {
      const song_id = String(song.id);
      const cached = songs.get(song_id);
      const doc = cached ? cached.doc : (await buildDoc(song_id, await readRow(song_id))).doc;
      const entries = snapshot(doc)?.library;
      if (!entries || typeof entries !== "object") continue;
      for (const entry of Object.values(entries)) {
        const sha256 = typeof entry?.sha256 === "string" ? entry.sha256.toLowerCase() : "";
        if (/^[0-9a-f]{64}$/.test(sha256)) hashes.add(sha256);
      }
    }
    return hashes;
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
    libraryHashes,
  };
}