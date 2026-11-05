/**
 * The Studio 1d instrument library commands: the banks, amp captures and
 * cabinet IRs one song may play, and the one entry per file the document keeps
 * for each of them.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the gateway's library routes, the MCP tools, the panel
 * and the shared history:
 *
 *   library.add (internal)  library.remove
 *
 * A song's library is a container of small objects, one per file (see doc.js),
 * so removing one entry is one step and one field, and two peers adding two
 * files keep both.
 *
 * The rules the rest of the library leans on:
 *   - `library.add` is Studio's own: only the gateway's upload finish route and
 *     its catalog download route issue it (plan 1d, Global Constraints). Both
 *     have checked the file's size and its magic bytes, and one of them has
 *     stored it; nobody outside the process decides where a library file lives
 *     or what its sha256 says.
 *   - `library.remove` refuses (code "conflict") while anything in the song
 *     still names the entry: a track's `font_id` now, and an amp insert's
 *     `model_id` or `ir_id` once the mixer exists. The question is asked by
 *     `libraryUses` in doc.js, which is where the later kinds join, so no
 *     command grows a second copy of "is this in use?".
 *   - the caps are the plan's: 32 fonts and 256 entries per song. The per-kind
 *     file sizes (512 MB for a bank, 20 MB for a capture, 10 MB for a cabinet)
 *     are the upload route's to refuse, at begin and at finish, because a file
 *     that is too big must never reach the library in the first place.
 *
 * Every `apply` validates everything it needs before it writes anything, so a
 * refusal (a limit, an unknown entry, an entry still in use) leaves the
 * document exactly as it was.
 */

import { z } from "zod";
import { defineCommand, StudioError } from "./registry.js";
import {
  LIBRARY_KINDS,
  LIBRARY_SOURCES,
  LIMITS,
  cloneJson,
  getLibraryEntry,
  libraryEntries,
  libraryMap,
  libraryUsers,
  objectMap,
  objectRef,
  snapshot,
  toPlain,
} from "../doc.js";

/** Names (entries and their credits) are 1-80 characters. */
const MAX_NAME = 80;

/** A licence or a credit line is at most 200 characters: one line under a name. */
const MAX_LINE = 200;

/**
 * The value a before/after entry carries when the object or field did not
 * exist. `null`, not `undefined`: a history entry is stored as JSON, which
 * drops `undefined` keys (see doc.js).
 */
const ABSENT = null;

/** An id inside the song: 1-40 letters, digits, dashes or underscores. */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores");

const nameSchema = z.string().min(1).max(MAX_NAME);

/** A file's hash is 64 hexadecimal characters, whatever case the caller sent. */
const sha256Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "a sha256 is 64 hexadecimal characters");

/**
 * One library entry, as the gateway builds it once the file is in storage.
 *
 * `sha256` and `bytes` are what the server itself measured, `licence` and
 * `credit` are what the picker shows beside the instrument (every CC-BY item
 * shows its credit, plan 1d Global Constraints), and the three optional keys
 * say where the file came from: `catalog_id` for a catalog row, `upload_id`
 * for an upload, and `storage_key` for the copy on this device.
 */
const libraryEntrySchema = z
  .object({
    id: idSchema.describe("the entry's id; a catalog id, or the upload's uuid"),
    kind: z.enum(LIBRARY_KINDS).describe('what the file is: "font", "nam" or "ir"'),
    name: nameSchema.describe("what the picker calls it"),
    source: z.enum(LIBRARY_SOURCES).describe('where it came from: "catalog", "upload" or "bundled"'),
    catalog_id: z.string().min(1).max(MAX_NAME).optional().describe("the catalog row it is"),
    storage_key: z
      .string()
      .min(1)
      .max(400)
      .optional()
      .describe("where this device keeps the file"),
    upload_id: z.string().min(1).max(MAX_NAME).optional().describe("the upload it arrived in"),
    sha256: sha256Schema.describe("the file's sha256, as the server measured it"),
    bytes: z.number().int().min(1).describe("the file's size in bytes"),
    licence: z.string().max(MAX_LINE).describe('the file\'s licence, e.g. "MIT"'),
    credit: z.string().max(MAX_LINE).describe("who made it, in the words the picker shows"),
    author_label: z.string().max(MAX_NAME).optional().describe("who put it in this song"),
  })
  .strict();

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
}

/** @returns {string} the ref of one library entry. */
function libraryRef(id) {
  return objectRef("library", id);
}

/** @returns {string} the ref of a track. */
function trackRef(id) {
  return objectRef("track", id);
}

/** Refuse with a limit message that names the limit. */
function refuseLimit(message) {
  throw new StudioError("limit", message);
}

/** Refuse with an "invalid" message. */
function refuseInvalid(message) {
  throw new StudioError("invalid", message);
}

/** Refuse with a "not_found" message. */
function refuseMissing(message) {
  throw new StudioError("not_found", message);
}

/** Refuse with a "conflict" message: the entry is not in the state hoped for. */
function refuseConflict(message) {
  throw new StudioError("conflict", message);
}

/** @returns {string} what one kind of entry is called in a sentence. */
function kindWord(kind) {
  if (kind === "nam") return "capture";
  if (kind === "ir") return "cabinet";
  return "font";
}

/** @returns {string} an entry's id in a sentence, with its name when it has one. */
function nameOrId(entry, id) {
  const name = entry?.name;
  return typeof name === "string" && name !== "" ? name : id;
}

/** @returns {object|null} the entry in a snapshot, by id. */
function entryOf(snap, id) {
  return snap.library?.[id] ?? null;
}

/**
 * An entry as the document stores it: every field present, `null` for the
 * three optional ones it does not have. Building it here means the value a
 * command hands back compares cleanly with what `snapshot()` reads a moment
 * later.
 * @param {object} entry - the arguments' entry
 * @returns {object}
 */
function storedEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    source: entry.source,
    catalog_id: entry.catalog_id ?? ABSENT,
    storage_key: entry.storage_key ?? ABSENT,
    upload_id: entry.upload_id ?? ABSENT,
    sha256: String(entry.sha256).toLowerCase(),
    bytes: entry.bytes,
    licence: entry.licence ?? "",
    credit: entry.credit ?? "",
    author_label: entry.author_label ?? "",
  };
}

defineCommand({
  id: "library.add",
  // Only the gateway's library routes issue this, through the hub with
  // `internal: true`: a library file is a file on disk, and nobody outside
  // Studio decides where that lives or what its hash says.
  internal: true,
  title: "Add a library file to the song",
  schema: z
    .object({ entry: libraryEntrySchema.describe("the file the gateway stored and checked") })
    .strict(),
  summary(args) {
    return `Added the ${kindWord(args.entry.kind)} "${args.entry.name}" to the library`;
  },
  touches(args) {
    return [libraryRef(args.entry.id)];
  },
  apply(doc, args) {
    if (getLibraryEntry(doc, args.entry.id)) {
      refuseInvalid(`The library already holds an entry with id "${args.entry.id}".`);
    }
    const entries = libraryEntries(doc);
    if (entries.length >= LIMITS.libraryEntriesPerSong) {
      refuseLimit(`A song's library can hold at most ${LIMITS.libraryEntriesPerSong} entries.`);
    }
    if (args.entry.kind === "font") {
      const fonts = entries.filter(({ entry }) => entry.get("kind") === "font").length;
      if (fonts >= LIMITS.fontsPerSong) {
        refuseLimit(`A song can hold at most ${LIMITS.fontsPerSong} fonts.`);
      }
    }
    const entry = storedEntry(args.entry);
    libraryMap(doc).set(entry.id, objectMap(entry));
    const ref = libraryRef(entry.id);
    return {
      before: { [fieldKey(ref, "*")]: ABSENT },
      after: { [fieldKey(ref, "*")]: cloneJson(entry) },
    };
  },
});

defineCommand({
  id: "library.remove",
  title: "Remove a file from the song's library",
  schema: z.object({ library_id: idSchema.describe("the library entry to remove") }).strict(),
  summary(args, snap) {
    const entry = entryOf(snap, args.library_id);
    const kind = entry ? kindWord(entry.kind) : "entry";
    return `Removed the ${kind} "${nameOrId(entry, args.library_id)}" from the library`;
  },
  /**
   * The tracks that play the entry, as refs the lock check has to see with it:
   * taking an instrument away is a write to every track that plays it.
   */
  touches(args, snap) {
    return [libraryRef(args.library_id), ...libraryUsers(snap, args.library_id).map(trackRef)];
  },
  apply(doc, args) {
    const entry = getLibraryEntry(doc, args.library_id);
    if (!entry) {
      refuseMissing(`There is no library entry with id "${args.library_id}" in this song.`);
    }
    const users = libraryUsers(doc, args.library_id);
    if (users.length > 0) {
      const snap = snapshot(doc);
      const names = users.map((id) => `"${snap.tracks.find((track) => track.id === id)?.name ?? id}"`);
      const who = users.length === 1 ? `track ${names[0]}` : `the tracks ${names.join(", ")}`;
      refuseConflict(
        `The ${kindWord(entry.get("kind"))} "${nameOrId(toPlain(entry), args.library_id)}" is in use by ${who}; change what ${users.length === 1 ? "that track plays" : "those tracks play"} first.`,
      );
    }
    const ref = libraryRef(args.library_id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(entry)) };
    libraryMap(doc).delete(args.library_id);
    return { before, after: { [fieldKey(ref, "*")]: ABSENT } };
  },
});