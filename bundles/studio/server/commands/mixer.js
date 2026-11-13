/**
 * The Studio 1d mixer commands: the effects in a track's, a return's or the
 * master's chain, the sends from a track to a return, the returns themselves,
 * and the song's master.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the mixer screen, the MCP tools and the shared history:
 *
 *   insert.add  insert.accept (people only)  insert.remove  insert.move
 *   insert.set  insert.bypass
 *   return.add  return.set  return.remove
 *   send.set
 *   master.set
 *
 * Everything an effect, a send or a return needs lives in its own small object
 * (see doc.js), so one edit is one field of one object, two peers editing two
 * objects keep both, and two parameters of one insert are two fields of its own
 * `params` map.
 *
 * The rules the rest of the mixer leans on:
 *   - an insert's `owner` is the chain it sits in — `"track:<id>"`,
 *     `"return:<id>"` or `"master"` — and the owner has to exist, so an effect
 *     can never be left in a chain nothing plays.
 *   - an insert's `order` is fractional (like a pad's motion points): an effect
 *     placed between two others takes the midpoint of their orders, so a move
 *     rewrites one field and nothing else in the chain changes.
 *     `insert.add` and `insert.move` read `after` the same way: `after: null`
 *     puts the effect FIRST, which is what dragging a strip to the top of the
 *     chain means, and leaving `after` out appends it to the END of the chain,
 *     which is the common case of "one more effect on this track". Both are
 *     documented, and both are tested.
 *   - an insert's parameters are the `EFFECT_PARAMS` table's (and an amp's the
 *     `AMP_PARAMS` one), and every write
 *     is checked against it by name and by range: an unknown parameter lists
 *     the ones the effect has, and an out-of-range one names its own range.
 *   - `insert.add` fills every parameter with its default, so an insert is a
 *     complete object from the moment it exists and the engine never has to
 *     guess a value.
 *   - `amp` is the one insert kind that is not an effect (plan 1d, PR C): its
 *     settings are `AMP_PARAMS` (three numbers) plus the two reference fields
 *     `model_id` — the capture it plays, REQUIRED on add and a library entry of
 *     kind "nam" — and `ir_id`, its cabinet (a library entry of kind "ir", or
 *     null for no cabinet). Both are checked against the song's library here,
 *     because an amp that names a file nothing holds is silent, and `amp` is
 *     not in `EFFECT_KINDS`/`EFFECT_PARAMS` at all: the effects' tables and the
 *     mixer's menu are the effects.
 *   - the FIRST amp on a chain is an ordinary edit for an agent. Any further amp
 *     on a chain that already holds one — live or bypassed — is a PROPOSAL:
 *     `insert.add` run by an agent stores it with `proposed: true` and
 *     `set_by: "agent"`, it plays nothing until the operator accepts it with
 *     `insert.accept`, and an agent may take it away again or retune it — but
 *     not repoint it, because the capture and cabinet it names are what the
 *     operator is being asked about (the hub's sound guard says so). The
 *     same rule covers the back doors: no command turns `proposed` off, nothing
 *     changes an insert's `kind`, a move keeps a proposal a proposal, and the
 *     hub refuses any agent step whose effective writes would leave a chain
 *     holding two amps that are not proposals (see the amp gate there).
 *   - a song holds at most `LIMITS.ampInsertsPerSong` amp inserts, counted over
 *     the whole song rather than over one chain: every amp loads a capture of
 *     its own, so the cap is the song's. A proposal counts against it: it holds
 *     a library reference, and an operator's yes cannot exceed the cap. A
 *     refusal that finds proposals pending says so, and that declining one
 *     frees a slot.
 *   - `limiter` may sit on any owner. On the master the engine gives it its
 *     lookahead; on a track or a return it runs at zero latency as a clipper
 *     (plan 1d, DSP rules). Nothing in the document tells the two apart.
 *   - `return.remove` refuses while any send feeds the return, and takes the
 *     return's own inserts with it in the same step; `track.remove` takes that
 *     track's inserts and sends (see core.js). So one undo puts a chain back
 *     whole.
 *   - returns are NOT tracks: they live in the song's `returns` container, no
 *     track reader sees them, and `LIMITS.tracks` never counts one.
 *
 * Every `apply` validates everything it needs before it writes anything, so a
 * refusal (a limit, an unknown owner, a parameter out of range, a return still
 * in use) leaves the document exactly as it was.
 */

import { z } from "zod";
import { defineCommand, StudioError } from "./registry.js";
import {
  AMP_KIND,
  AMP_PARAMS,
  DEFAULT_MASTER,
  EFFECT_KINDS,
  EFFECT_PARAMS,
  ampParamSpec,
  ampSpec,
  defaultAmpParams,
  effectParamSpec,
  effectSpec,
  isAmpKind,
  LIMITS,
  MASTER_REF,
  MAX_RETURN_NAME,
  MIXER_RANGES,
  cloneJson,
  defaultEffectParams,
  effectLabel,
  getInsert,
  getLibraryEntry,
  getReturn,
  getSend,
  getTrack,
  insertEntries,
  insertMap,
  insertOwnerOf,
  insertParamsMap,
  insertsForOwner,
  masterMap,
  masterSettings,
  objectMap,
  objectRef,
  returnEntries,
  returnMap,
  sendKey,
  sendMap,
  sendsForReturn,
  sendsForTrack,
  snapshot,
  toPlain,
} from "../doc.js";

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

/**
 * What an agent is told when a step would make a chain hold a second live amp.
 *
 * A second amp on a chain is the operator's to accept — the first one it may
 * build itself — so an agent may only propose one. The hub answers with this
 * same sentence for an agent's command, its undo and its redo (see the amp gate
 * in hub.js).
 */
export const AMP_SECOND_NEEDS_A_YES =
  "A second amp on a track is the operator's to accept; an agent can only propose one.";

/**
 * The chain an effect belongs to: a track's, a return's, or the song's master.
 * Spelled as the ref of the object that owns it, because that is what the
 * document stores and what a lock or a focus is asked about.
 */
const ownerSchema = z
  .string()
  .regex(
    /^(track:[A-Za-z0-9_-]{1,40}|return:[A-Za-z0-9_-]{1,40}|master)$/,
    'an owner is "track:<id>", "return:<id>" or "master"',
  );

/**
 * One insert's parameters to write, by name; the ranges are checked in `apply`.
 *
 * `null` is allowed because an amp's `ir_id` is a library entry's id or null for
 * "no cabinet"; an effect parameter set to null is refused by name in `apply`
 * like any other value of the wrong type.
 */
const paramsSchema = z
  .record(z.union([z.number(), z.string(), z.null()]))
  .describe(
    "the parameters to set, by name; each one is inside its own range (see EFFECT_PARAMS, and AMP_PARAMS for an amp)",
  );

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
}

/** @returns {string} the ref of one insert. */
function insertRef(id) {
  return objectRef("insert", id);
}

/** @returns {string} the ref of the send between one track and one return. */
function sendRef(trackId, returnId) {
  return objectRef("send", sendKey(trackId, returnId));
}

/** @returns {string} the ref of one return. */
function returnRef(id) {
  return objectRef("return", id);
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

/** Refuse with a "conflict" message: the object is not in the state hoped for. */
function refuseConflict(message) {
  throw new StudioError("conflict", message);
}

/** @returns {string} a track's name for a summary, or its id when unknown. */
function labelOfTrack(snap, id) {
  return snap.tracks.find((track) => track.id === id)?.name ?? id;
}

/** @returns {boolean} whether the caller of this step is the operator. */
function callerIsOperator(context) {
  return context?.author?.kind === "human";
}

/**
 * Whether an agent's `insert.add` is a PROPOSAL rather than an ordinary edit:
 * a further amp on a chain that already holds one.
 *
 * The first amp an agent adds to a chain that has none is live, as it always
 * was. Beyond that the chain has a sound the operator chose, and a second amp
 * would change what the track is heard through — so the agent proposes one and
 * the operator's `insert.accept` is the yes. A bypassed amp still counts: it is
 * in the chain, and un-bypassing it is one field away.
 * @param {object} snap - the song as the step was prepared on
 * @param {{owner: string, kind: string}} args
 * @param {{author?: object}|undefined} context
 * @returns {boolean}
 */
function isAmpProposal(snap, args, context) {
  if (callerIsOperator(context)) return false;
  if (!isAmpKind(args.kind)) return false;
  return Object.values(snap?.inserts ?? {}).some(
    (insert) => insert?.owner === args.owner && isAmpKind(insert?.kind),
  );
}

/** @returns {string} a return's name for a summary, or its id when unknown. */
function labelOfReturn(snap, id) {
  return snap.returns?.[id]?.name ?? id;
}

/**
 * What a sentence calls the owner of one chain: the track's name, the return's
 * name, or "the master".
 * @param {object} snap - a snapshot
 * @param {string} owner - `"track:<id>"`, `"return:<id>"` or `"master"`
 * @returns {string}
 */
function ownerLabel(snap, owner) {
  const target = insertOwnerOf(owner);
  if (!target) return String(owner ?? "");
  if (target.kind === "master") return "the master";
  if (target.kind === "track") return labelOfTrack(snap, target.id);
  return labelOfReturn(snap, target.id);
}

/** @returns {string} an effect kind's word with "a" or "an" in front: "a compressor". */
function withArticle(word) {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** @returns {string} a parameter's value with its unit when it has one. */
function valueText(kind, name, value) {
  const unit = isAmpKind(kind) ? ampParamSpec(name)?.unit : effectParamSpec(kind, name)?.unit;
  return unit ? `${value} ${unit}` : String(value);
}

/** @returns {string} a range with its unit, for a message: "20 to 20000 Hz". */
function rangeText(field) {
  return `${field.min} to ${field.max}${field.unit ? ` ${field.unit}` : ""}`;
}

/** @returns {string} a value in a sentence: a string quoted, a number as it is. */
function describeValue(value) {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/**
 * Refuse a value outside the range the mixer allows, naming the range.
 * @param {string} what - the thing itself, e.g. "the master's gain"
 * @param {number} value
 * @param {number[]} range - `[min, max]`
 * @param {string} [unit] - "dB", "LUFS" or "dBTP"
 * @returns {void}
 */
function checkRange(what, value, range, unit = "") {
  if (value >= range[0] && value <= range[1]) return;
  const withUnit = unit ? ` ${unit}` : "";
  refuseInvalid(
    `${what} is ${value}${withUnit}; it runs from ${range[0]} to ${range[1]}${withUnit}.`,
  );
}

/**
 * Check one effect's parameters against the `EFFECT_PARAMS` table: every name
 * has to be one the effect has, and every value has to be inside that
 * parameter's own range (or one of its choices).
 *
 * The messages name the parameter and, for a number, its range, so a caller
 * learns what the effect accepts rather than only that it was refused.
 * @param {string} kind - one of `EFFECT_KINDS`
 * @param {Object<string, number|string>} params - the parameters to check
 * @returns {Object<string, number|string>} a plain copy of the checked values
 * @throws {StudioError} code "invalid" on an unknown parameter or a value out of range
 */
function checkParams(kind, params) {
  const spec = effectSpec(kind);
  const checked = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    const field = effectParamSpec(kind, name);
    if (!field) {
      refuseInvalid(
        `The ${spec.label} has no parameter "${name}"; it has ${Object.keys(spec.params).join(", ")}.`,
      );
    }
    if (field.values) {
      if (!field.values.includes(value)) {
        refuseInvalid(
          `The ${spec.label}'s "${name}" is ${describeValue(value)}; it is one of ${field.values.join(", ")}.`,
        );
      }
      checked[name] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      refuseInvalid(`The ${spec.label}'s "${name}" is ${describeValue(value)}; it runs from ${rangeText(field)}.`);
    }
    if (value < field.min || value > field.max) {
      refuseInvalid(`The ${spec.label}'s "${name}" is ${value}; it runs from ${rangeText(field)}.`);
    }
    checked[name] = value;
  }
  return checked;
}

/**
 * Check one amp insert's settings: the three numbers against `AMP_PARAMS`, and
 * the two reference fields against the SONG'S LIBRARY — `model_id` a capture, and
 * `ir_id` a cabinet or null for none.
 *
 * The messages name the setting and, for a number, its range, the way
 * `checkParams` does for an effect, so a caller learns what an amp accepts rather
 * than only that it was refused.
 * @param {Y.Doc} doc - the live document, whose library the ids must name
 * @param {Object<string, any>} params - the settings to check
 * @returns {Object<string, any>} a plain copy of the checked values
 * @throws {StudioError} code "invalid" on an unknown setting, a value out of
 *   range, or an id the library does not hold (or holds as another kind)
 */
function checkAmpParams(doc, params) {
  const checked = {};
  const names = Object.keys(ampSpec()?.params ?? {});
  for (const [name, value] of Object.entries(params ?? {})) {
    if (name === "model_id") {
      checked.model_id = requireLibraryFile(doc, value, "nam");
      continue;
    }
    if (name === "ir_id") {
      checked.ir_id = value === null ? ABSENT : requireLibraryFile(doc, value, "ir");
      continue;
    }
    const field = ampParamSpec(name);
    if (!field) {
      refuseInvalid(
        `The amp has no parameter "${name}"; it has model_id, ir_id, ${names.join(", ")}.`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      refuseInvalid(`The amp's "${name}" is ${describeValue(value)}; it runs from ${rangeText(field)}.`);
    }
    if (value < field.min || value > field.max) {
      refuseInvalid(`The amp's "${name}" is ${value}; it runs from ${rangeText(field)}.`);
    }
    checked[name] = value;
  }
  return checked;
}

/**
 * An id that has to name a library entry of one kind, refused in the words that
 * kind goes by: an amp plays a capture (kind "nam") through a cabinet (kind
 * "ir").
 * @param {Y.Doc} doc
 * @param {unknown} value - the id the caller sent
 * @param {"nam"|"ir"} kind - the kind the entry must be
 * @returns {string} the id
 * @throws {StudioError} code "invalid"
 */
function requireLibraryFile(doc, value, kind) {
  const word = kind === "nam" ? "capture" : "cabinet";
  if (typeof value !== "string" || value === "") {
    refuseInvalid(
      kind === "nam"
        ? 'An amp insert needs a capture to play: pass the library entry\'s id as "model_id".'
        : 'An amp\'s cabinet is a library entry\'s id, or left out for no cabinet.',
    );
  }
  const entry = getLibraryEntry(doc, value);
  if (!entry) {
    refuseInvalid(
      `The song's library has no ${word} with id "${value}"; add it to the library before an amp plays it.`,
    );
  }
  const held = entry.get("kind");
  if (held !== kind) {
    refuseInvalid(
      `The library entry "${value}" is a ${kindWordOf(held)}, not a ${word}; an amp plays a ${kind === "nam" ? "capture" : "cabinet"} here.`,
    );
  }
  return value;
}

/** @returns {string} what one library kind is called: "font", "capture", "cabinet". */
function kindWordOf(kind) {
  if (kind === "nam") return "capture";
  if (kind === "ir") return "cabinet";
  return "font";
}

/**
 * How many amp inserts the song holds, over every chain: the cap is the song's,
 * not one chain's, because every amp loads a capture of its own.
 * @param {Y.Doc} doc
 * @returns {number}
 */
function ampInsertCount(doc) {
  let count = 0;
  for (const { insert } of insertEntries(doc)) {
    if (insert.get("kind") === AMP_KIND) count += 1;
  }
  return count;
}

/**
 * How many of the song's amp inserts are still PROPOSALS: an amp an agent
 * suggested and the operator has not answered yet.
 *
 * They count against the song's amp cap like any other amp, because each one
 * holds a library reference of its own; declining one is `insert.remove`, and
 * that is what frees the slot (see the cap's message in `insert.add`).
 * @param {Y.Doc} doc
 * @returns {number}
 */
function ampProposalCount(doc) {
  let count = 0;
  for (const { insert } of insertEntries(doc)) {
    if (insert.get("kind") === AMP_KIND && insert.get("proposed") === true) count += 1;
  }
  return count;
}

/** @returns {Y.Map<any>} the live insert, or a "not_found" refusal naming the id. */
function requireInsert(doc, id) {
  const insert = getInsert(doc, id);
  if (!insert) refuseMissing(`There is no insert "${id}" in this song.`);
  return insert;
}

/** @returns {Y.Map<any>} the live return, or a "not_found" refusal naming the id. */
function requireReturn(doc, id) {
  const item = getReturn(doc, id);
  if (!item) refuseMissing(`There is no return "${id}" in this song.`);
  return item;
}

/** @returns {Y.Map<any>} the live track, or a "not_found" refusal naming the id. */
function requireTrack(doc, id) {
  const track = getTrack(doc, id);
  if (!track) refuseMissing(`There is no track "${id}" in this song.`);
  return track;
}

/**
 * The chain an effect is being put in, refused when the owner is not there: an
 * effect in a chain nothing plays would be a sound nobody hears.
 * @param {Y.Doc} doc
 * @param {string} owner - `"track:<id>"`, `"return:<id>"` or `"master"`
 * @returns {{kind: string, id: string}}
 * @throws {StudioError} code "invalid" for an owner ref of another kind, code
 *   "not_found" when the track or return it names is gone
 */
function requireOwner(doc, owner) {
  const target = insertOwnerOf(owner);
  if (!target) {
    refuseInvalid(`"${owner}" is not a chain; an effect sits on a track, on a return, or on the master.`);
  }
  if (target.kind === "track" && !getTrack(doc, target.id)) {
    refuseMissing(`There is no track "${target.id}" in this song.`);
  }
  if (target.kind === "return" && !getReturn(doc, target.id)) {
    refuseMissing(`There is no return "${target.id}" in this song.`);
  }
  return target;
}

/** @returns {number} one insert's `order` as a finite number. */
function orderOf(insert) {
  const value = insert.get("order");
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The order an effect appended to the end of a chain takes: one past the last
 * effect's order, or 0 for an empty chain.
 * @param {Array<{id: string, insert: Y.Map<any>}>} chain - in chain order
 * @returns {number}
 */
function appendOrder(chain) {
  if (chain.length === 0) return 0;
  return orderOf(chain[chain.length - 1].insert) + 1;
}

/**
 * The order an effect placed at the front of a chain takes: one before the
 * first effect's order, or 0 for an empty chain.
 * @param {Array<{id: string, insert: Y.Map<any>}>} chain - in chain order
 * @returns {number}
 */
function frontOrder(chain) {
  if (chain.length === 0) return 0;
  return orderOf(chain[0].insert) - 1;
}

/**
 * The order an effect placed after `afterId` takes: the midpoint between that
 * effect's order and the next one's, or one past it when it is the last.
 * @param {Array<{id: string, insert: Y.Map<any>}>} chain - in chain order
 * @param {string} afterId
 * @returns {number|null} null when the chain holds no such effect
 */
function orderBehind(chain, afterId) {
  const at = chain.findIndex((entry) => entry.id === afterId);
  if (at < 0) return null;
  const behind = orderOf(chain[at].insert);
  const next = chain[at + 1];
  return next ? (behind + orderOf(next.insert)) / 2 : behind + 1;
}

/**
 * The first free return name: "Return A", "Return B", and so on in alphabet
 * order, skipping the names the song already uses.
 * @param {object[]} returns - the song's returns, as the snapshot holds them
 * @returns {string}
 */
function firstFreeReturnName(returns) {
  const used = new Set(returns.map((item) => item.name));
  for (let index = 0; index < 26; index += 1) {
    const name = `Return ${String.fromCharCode(65 + index)}`;
    if (!used.has(name)) return name;
  }
  return `Return ${returns.length + 1}`;
}

defineCommand({
  id: "insert.add",
  title: "Add an effect to a chain",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("the insert's id; Studio makes one when it is left out"),
      owner: ownerSchema.describe('the chain: "track:<id>", "return:<id>" or "master"'),
      kind: z
        .string()
        .min(1)
        .max(40)
        .describe(
          `the effect, one of ${EFFECT_KINDS.join(", ")}, or "${AMP_KIND}" for an amp that plays a capture; a second amp on a chain that already has one is a proposal when an agent adds it, and the operator accepts it`,
        ),
      // Its own copy of the id schema: reusing `idSchema` twice in one object
      // publishes a JSON-Schema $ref, which tool-schemas-grammar-safe refuses.
      after: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores")
        .nullable()
        .optional()
        .describe(
          "the effect it goes after; null puts it first in the chain, and with none it goes to the end",
        ),
      params: paramsSchema.optional().describe("the parameters that differ from their defaults"),
    })
    .strict(),
  summary(args, snap, context) {
    if (isAmpProposal(snap, args, context)) {
      return `Proposed a second amp on ${ownerLabel(snap, args.owner)}`;
    }
    return `Added ${withArticle(effectLabel(args.kind))} to ${ownerLabel(snap, args.owner)}`;
  },
  touches(args) {
    // The new effect and the chain it joins. The effect named by `after` is not
    // written at all — only the new effect's own `order` is — so it is not
    // touched: a chain edit never rolls anything else back.
    return [insertRef(args.id), args.owner];
  },
  /**
   * A live insert for the operator and for an agent's first amp on a chain; a
   * PROPOSAL for an agent's further amp on a chain that already holds one (see
   * `isAmpProposal`). The whole object carries `proposed` and `set_by`, so what
   * the step made is one object in the history and reads the same after a load.
   */
  apply(doc, args, _snap, context) {
    const amp = isAmpKind(args.kind);
    if (!amp && !effectSpec(args.kind)) {
      refuseInvalid(
        `"${args.kind}" is not an effect a chain holds; the effects are ${EFFECT_KINDS.join(", ")}, and an amp is "${AMP_KIND}".`,
      );
    }
    requireOwner(doc, args.owner);
    if (getInsert(doc, args.id)) {
      refuseInvalid(`An insert with id "${args.id}" already exists in this song.`);
    }
    const chain = insertsForOwner(doc, args.owner);
    if (chain.length >= LIMITS.insertsPerChain) {
      refuseLimit(`A chain holds at most ${LIMITS.insertsPerChain} effects.`);
    }
    // The amp cap is the song's: an amp insert is the one kind that loads a file
    // of its own, so sixteen is a whole song's worth, whichever chains they sit
    // in. An amp with no capture is refused here rather than stored silent.
    if (amp) {
      if (args.params?.model_id === undefined) {
        refuseInvalid('An amp insert needs a capture to play: pass the library entry\'s id as "model_id".');
      }
      if (ampInsertCount(doc) >= LIMITS.ampInsertsPerSong) {
        // A full song says which way out there is: a proposal nobody has
        // answered is a slot the next amp could take once it is declined.
        const pending = ampProposalCount(doc);
        refuseLimit(
          pending === 0
            ? `A song holds at most ${LIMITS.ampInsertsPerSong} amp inserts.`
            : `A song holds at most ${LIMITS.ampInsertsPerSong} amp inserts, and ${pending} of them are proposals waiting for an answer; declining a proposal frees a slot.`,
        );
      }
    }
    const snap = snapshot(doc);
    const proposed = isAmpProposal(snap, args, context);
    let order = appendOrder(chain);
    // `after: null` and no `after` mean different things, the same way they do
    // in `insert.move`: null puts the effect first, and leaving it out appends
    // it to the end of the chain.
    if (args.after === null) {
      order = frontOrder(chain);
    } else if (args.after !== undefined) {
      const placed = orderBehind(chain, args.after);
      if (placed === null) {
        refuseInvalid(
          `There is no insert "${args.after}" in the chain on ${ownerLabel(snap, args.owner)} to place the effect after.`,
        );
      }
      order = placed;
    }
    // Every setting at its default, so an insert is a complete object from the
    // moment it exists: an amp starts at 0 dB in, 0 dB out and a cabinet at full
    // mix, with the capture the caller named and no cabinet until one is chosen.
    const params = amp
      ? { ...defaultAmpParams(), model_id: "", ir_id: ABSENT, ...checkAmpParams(doc, args.params) }
      : { ...defaultEffectParams(args.kind), ...checkParams(args.kind, args.params) };
    const insert = {
      id: args.id,
      owner: args.owner,
      order,
      kind: args.kind,
      bypass: false,
      proposed,
      set_by: callerIsOperator(context) ? "operator" : "agent",
      params,
    };
    const stored = objectMap({
      id: insert.id,
      owner: insert.owner,
      order: insert.order,
      kind: insert.kind,
      bypass: insert.bypass,
      proposed: insert.proposed,
      set_by: insert.set_by,
    });
    stored.set("params", objectMap(params));
    insertMap(doc).set(insert.id, stored);
    const ref = insertRef(insert.id);
    return {
      before: { [fieldKey(ref, "*")]: ABSENT },
      after: { [fieldKey(ref, "*")]: cloneJson(insert) },
    };
  },
});

defineCommand({
  id: "insert.accept",
  // Only the operator accepts a second amp: an agent may propose as many as the
  // cap allows, and the operator's yes is what makes one live.
  humanOnly: true,
  title: "Accept a proposed second amp (people only)",
  schema: z
    .object({
      id: idSchema.describe("the proposed insert to accept"),
      // What the operator was shown when they said yes. A proposal can be
      // removed and proposed again under the same id with another capture, so
      // the yes is bound to what was reviewed, not to the id alone.
      expect: z
        .object({
          owner: ownerSchema.describe('the chain it was proposed for: "track:<id>", "return:<id>" or "master"'),
          model_id: z.string().describe("the capture the proposal names"),
          ir_id: z.string().nullable().describe("the cabinet the proposal names, or null for none"),
        })
        .strict()
        .describe("the chain, capture and cabinet the operator reviewed"),
    })
    .strict(),
  summary(args, snap) {
    // The summary is written from the snapshot the step was prepared on, so the
    // insert is still a proposal here and still names the chain it was made for.
    const insert = snap?.inserts?.[args.id];
    return `Accepted the second amp on ${ownerLabel(snap, insert?.owner ?? args.expect.owner)}`;
  },
  touches(args) {
    return [insertRef(args.id), args.expect.owner];
  },
  /**
   * The operator's yes, and one field: the proposal becomes live where it stands,
   * with the capture and the cabinet it was reviewed with. It is the twin of
   * `midi.accept`, down to the sentence an agent meets.
   *
   * The library reference is checked once more on the way in: a proposal does not
   * count as playing its capture (see `libraryUses`), so the file can have been
   * removed since, and an amp accepted without one would be silent for no reason
   * a reader could see.
   */
  apply(doc, args, _snap, context) {
    if (!callerIsOperator(context)) throw new StudioError("human_only", AMP_SECOND_NEEDS_A_YES);
    const insert = requireInsert(doc, args.id);
    if (insert.get("proposed") !== true) {
      refuseConflict(`The insert "${args.id}" is live already; only a proposal is accepted.`);
    }
    const params = insertParamsMap(insert);
    const modelId = typeof params.get("model_id") === "string" ? params.get("model_id") : "";
    const irId = params.get("ir_id") ?? ABSENT;
    if (
      insert.get("owner") !== args.expect.owner ||
      modelId !== args.expect.model_id ||
      (irId ?? ABSENT) !== (args.expect.ir_id ?? ABSENT)
    ) {
      refuseConflict(
        `The insert "${args.id}" is not the proposal you were shown any more; look at it again before accepting it.`,
      );
    }
    checkAmpParams(doc, { model_id: modelId, ir_id: irId });
    const ref = insertRef(args.id);
    const before = insert.get("proposed");
    insert.set("proposed", false);
    return {
      before: { [fieldKey(ref, "proposed")]: before === undefined ? ABSENT : cloneJson(before) },
      after: { [fieldKey(ref, "proposed")]: false },
    };
  },
});

defineCommand({
  id: "insert.remove",
  title: "Remove an effect from a chain",
  schema: z.object({ id: idSchema.describe("the insert to remove") }).strict(),
  summary(args, snap) {
    const insert = snap.inserts?.[args.id];
    return `Removed the ${effectLabel(insert?.kind ?? args.id)} from ${ownerLabel(snap, insert?.owner)}`;
  },
  touches(args, snap) {
    const insert = snap.inserts?.[args.id];
    return insert ? [insertRef(args.id), insert.owner] : [insertRef(args.id)];
  },
  /**
   * Declining a proposal is exactly this: the agent takes its own proposal away,
   * which is an ordinary edit because a proposal plays nothing (the sound guard
   * has nothing to lose on it). Removing a LIVE amp stays the operator's.
   */
  apply(doc, args) {
    const insert = requireInsert(doc, args.id);
    const ref = insertRef(args.id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(insert)) };
    insertMap(doc).delete(args.id);
    return { before, after: { [fieldKey(ref, "*")]: ABSENT } };
  },
});

defineCommand({
  id: "insert.move",
  title: "Move an effect within its chain",
  schema: z
    .object({
      id: idSchema.describe("the insert to move"),
      after: idSchema
        .nullable()
        .optional()
        .describe(
          "the effect it goes after; null puts it first in the chain, and with none it goes to the end",
        ),
    })
    .strict(),
  summary(args, snap) {
    const insert = snap.inserts?.[args.id];
    const label = effectLabel(insert?.kind ?? args.id);
    const owner = ownerLabel(snap, insert?.owner);
    if (args.after === null) return `Moved the ${label} to the front of the chain on ${owner}`;
    if (args.after === undefined) return `Moved the ${label} to the end of the chain on ${owner}`;
    return `Moved the ${label} after the ${effectLabel(snap.inserts?.[args.after]?.kind ?? args.after)} on ${owner}`;
  },
  touches(args, snap) {
    // The moved effect and its chain: `order` is the only field written, so the
    // effect it moves behind is left exactly as it is. A proposal moved within
    // its chain stays a proposal: nothing here writes `proposed`, and the owner a
    // proposal belongs to never changes without a new proposal.
    const insert = snap.inserts?.[args.id];
    return insert ? [insertRef(args.id), insert.owner] : [insertRef(args.id)];
  },
  apply(doc, args) {
    const insert = requireInsert(doc, args.id);
    if (args.after === args.id) refuseInvalid("An effect cannot be moved after itself.");
    const owner = String(insert.get("owner") ?? "");
    // The chain the effect is joining: every other effect of the same owner, in
    // chain order. The moved effect is left out, so moving it never counts it
    // twice (and never places it relative to itself).
    const chain = insertsForOwner(doc, owner).filter((entry) => entry.id !== args.id);
    let order;
    // `after: null` is the front, an `after` left out is the end: the same rule
    // `insert.add` follows, so one argument means one place in both commands.
    if (args.after === null) {
      order = frontOrder(chain);
    } else if (args.after === undefined) {
      order = appendOrder(chain);
    } else {
      const placed = orderBehind(chain, args.after);
      if (placed === null) {
        refuseInvalid(
          `There is no insert "${args.after}" in the chain on ${ownerLabel(snapshot(doc), owner)} to move the effect after.`,
        );
      }
      order = placed;
    }
    const ref = insertRef(args.id);
    const before = orderOf(insert);
    if (before === order) return { before: {}, after: {} };
    insert.set("order", order);
    return {
      before: { [fieldKey(ref, "order")]: before },
      after: { [fieldKey(ref, "order")]: order },
    };
  },
});

defineCommand({
  id: "insert.set",
  title: "Set one or more of an effect's parameters",
  schema: z
    .object({
      id: idSchema.describe("the insert"),
      params: paramsSchema.describe("the parameters to set, by name; at least one"),
    })
    .strict()
    .refine((args) => Object.keys(args.params).length > 0, "insert.set needs at least one parameter"),
  summary(args, snap) {
    const insert = snap.inserts?.[args.id];
    const kind = insert?.kind ?? "";
    const label = effectLabel(kind);
    const owner = ownerLabel(snap, insert?.owner);
    const names = Object.keys(args.params);
    if (names.length === 1) {
      const [name] = names;
      return `Set the ${label}'s ${name} on ${owner} to ${valueText(kind, name, args.params[name])}`;
    }
    return `Set the ${label}'s ${names.join(", ")} on ${owner}`;
  },
  touches(args, snap) {
    const insert = snap.inserts?.[args.id];
    return insert ? [insertRef(args.id), insert.owner] : [insertRef(args.id)];
  },
  /**
   * One parameter is one key of the insert's `params` map, so nothing here writes
   * `kind` or `proposed`: a proposal an agent retunes is still the proposal the
   * operator has not accepted yet, and no parameter turns an effect into an amp.
   */
  apply(doc, args) {
    const insert = requireInsert(doc, args.id);
    const kind = String(insert.get("kind") ?? "");
    let params;
    if (isAmpKind(kind)) {
      params = checkAmpParams(doc, args.params);
    } else if (!effectSpec(kind)) {
      refuseInvalid(
        `The insert "${args.id}" holds a "${kind}", which is not one of the effects a chain holds (${EFFECT_KINDS.join(", ")}, ${AMP_KIND}).`,
      );
    } else {
      params = checkParams(kind, args.params);
    }
    const map = insertParamsMap(insert);
    const ref = insertRef(args.id);
    const before = {};
    const after = {};
    // One parameter is one key of the insert's params map: it is written on its
    // own, it undoes on its own, and a parameter another peer is moving at the
    // same moment keeps its own key.
    for (const [name, value] of Object.entries(params)) {
      const current = map.get(name);
      const currentValue = current === undefined ? ABSENT : cloneJson(toPlain(current));
      if (JSON.stringify(currentValue) === JSON.stringify(value)) continue;
      before[fieldKey(ref, `params.${name}`)] = currentValue;
      after[fieldKey(ref, `params.${name}`)] = value;
      map.set(name, value);
    }
    return { before, after };
  },
});

defineCommand({
  id: "insert.bypass",
  title: "Switch one effect in or out without removing it",
  schema: z
    .object({
      id: idSchema.describe("the insert"),
      bypass: z.boolean().describe("true: the chain skips it; false: it plays"),
    })
    .strict(),
  summary(args, snap) {
    const insert = snap.inserts?.[args.id];
    const label = effectLabel(insert?.kind ?? args.id);
    const owner = ownerLabel(snap, insert?.owner);
    return args.bypass ? `Bypassed the ${label} on ${owner}` : `Switched the ${label} on ${owner} back in`;
  },
  touches(args, snap) {
    const insert = snap.inserts?.[args.id];
    return insert ? [insertRef(args.id), insert.owner] : [insertRef(args.id)];
  },
  /**
   * Bypassing is an ordinary agent edit, first amp included: a bypassed amp is
   * still in the chain, still the sound the operator chose, and still an amp the
   * amp gate counts — a second amp beside it is a proposal, not a way around the
   * operator's choice.
   */
  apply(doc, args) {
    const insert = requireInsert(doc, args.id);
    const ref = insertRef(args.id);
    const before = insert.get("bypass") === undefined ? ABSENT : cloneJson(insert.get("bypass"));
    insert.set("bypass", args.bypass);
    return {
      before: { [fieldKey(ref, "bypass")]: before },
      after: { [fieldKey(ref, "bypass")]: args.bypass },
    };
  },
});

defineCommand({
  id: "return.add",
  title: "Add a return to the mix",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("the return's id; Studio makes one when it is left out"),
      name: z
        .string()
        .min(1)
        .max(MAX_RETURN_NAME)
        .optional()
        .describe(`what the mixer calls it; the first free "Return A", "Return B"… when left out`),
    })
    .strict(),
  summary(args, snap) {
    const name = args.name ?? firstFreeReturnName(Object.values(snap.returns ?? {}));
    return `Added the return "${name}"`;
  },
  touches(args) {
    return [returnRef(args.id)];
  },
  apply(doc, args) {
    const existing = returnEntries(doc);
    if (existing.length >= LIMITS.returnsPerSong) {
      refuseLimit(`A song can hold at most ${LIMITS.returnsPerSong} returns.`);
    }
    if (getReturn(doc, args.id)) {
      refuseInvalid(`A return with id "${args.id}" already exists in this song.`);
    }
    const item = {
      id: args.id,
      name: args.name ?? firstFreeReturnName(existing.map((entry) => toPlain(entry.return))),
      gain_db: 0,
      pan: 0,
      mute: false,
    };
    returnMap(doc).set(item.id, objectMap(item));
    const ref = returnRef(item.id);
    return {
      before: { [fieldKey(ref, "*")]: ABSENT },
      after: { [fieldKey(ref, "*")]: cloneJson(item) },
    };
  },
});

defineCommand({
  id: "return.set",
  title: "Set a return's name, level, pan or mute",
  schema: z
    .object({
      id: idSchema.describe("the return"),
      name: z.string().min(1).max(MAX_RETURN_NAME).optional(),
      gain_db: z
        .number()
        .finite()
        .min(MIXER_RANGES.return.gain_db[0])
        .max(MIXER_RANGES.return.gain_db[1])
        .optional()
        .describe(`level in dB, ${MIXER_RANGES.return.gain_db[0]} to ${MIXER_RANGES.return.gain_db[1]}`),
      pan: z
        .number()
        .finite()
        .min(MIXER_RANGES.return.pan[0])
        .max(MIXER_RANGES.return.pan[1])
        .optional()
        .describe("pan, -1 left to +1 right"),
      mute: z.boolean().optional(),
    })
    .strict()
    .refine(
      (args) => args.name !== undefined || args.gain_db !== undefined || args.pan !== undefined || args.mute !== undefined,
      "return.set needs at least one of name, gain_db, pan or mute",
    ),
  summary(args, snap) {
    const name = labelOfReturn(snap, args.id);
    const parts = [];
    if (args.name !== undefined) parts.push(`name "${args.name}"`);
    if (args.gain_db !== undefined) parts.push(`gain ${args.gain_db} dB`);
    if (args.pan !== undefined) parts.push(`pan ${args.pan}`);
    if (args.mute !== undefined) parts.push(args.mute ? "muted" : "unmuted");
    return `Set the return "${name}": ${parts.join(", ")}`;
  },
  touches(args) {
    return [returnRef(args.id)];
  },
  apply(doc, args) {
    const item = requireReturn(doc, args.id);
    const ref = returnRef(args.id);
    const before = {};
    const after = {};
    // One field per write, so a level change and a rename undo independently.
    for (const field of ["name", "gain_db", "pan", "mute"]) {
      if (args[field] === undefined) continue;
      const current = item.get(field);
      before[fieldKey(ref, field)] = current === undefined ? ABSENT : cloneJson(current);
      after[fieldKey(ref, field)] = args[field];
      item.set(field, args[field]);
    }
    return { before, after };
  },
});

defineCommand({
  id: "return.remove",
  title: "Remove a return and its effects",
  schema: z.object({ id: idSchema.describe("the return to remove") }).strict(),
  summary(args, snap) {
    return `Removed the return "${labelOfReturn(snap, args.id)}"`;
  },
  touches(args, snap) {
    const refs = [returnRef(args.id)];
    for (const insert of Object.values(snap.inserts ?? {})) {
      if (insert.owner === returnRef(args.id)) refs.push(insertRef(insert.id));
    }
    for (const send of Object.values(snap.sends ?? {})) {
      if (send.return_id === args.id) refs.push(sendRef(send.track_id, send.return_id));
    }
    return refs;
  },
  apply(doc, args) {
    const item = requireReturn(doc, args.id);
    const name = String(item.get("name") ?? args.id);
    const feeds = sendsForReturn(doc, args.id);
    if (feeds.length > 0) {
      refuseConflict(
        `${name} is still fed by ${feeds.length} ${feeds.length === 1 ? "send" : "sends"}; remove ${feeds.length === 1 ? "it" : "them"} first.`,
      );
    }
    const ref = returnRef(args.id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(item)) };
    const after = { [fieldKey(ref, "*")]: ABSENT };
    // The return's own effects go with it, in the same step: one undo puts the
    // return and its chain back together.
    const doomed = insertsForOwner(doc, ref);
    for (const { id, insert } of doomed) {
      const field = fieldKey(insertRef(id), "*");
      before[field] = cloneJson(toPlain(insert));
      after[field] = ABSENT;
      insertMap(doc).delete(id);
    }
    returnMap(doc).delete(args.id);
    return { before, after };
  },
});

defineCommand({
  id: "send.set",
  title: "Send a track to a return, or take the send away",
  schema: z
    .object({
      track_id: idSchema.describe("the track that sends"),
      return_id: idSchema.describe("the return it feeds"),
      level_db: z
        .number()
        .finite()
        .min(MIXER_RANGES.send.level_db[0])
        .max(MIXER_RANGES.send.level_db[1])
        .nullable()
        .describe(
          `level in dB, ${MIXER_RANGES.send.level_db[0]} to ${MIXER_RANGES.send.level_db[1]}; null removes the send`,
        ),
      pre: z
        .boolean()
        .optional()
        .describe(
          "true: before the track's fader; false: after it; left out, an update keeps the send's own setting and a new send is after the fader",
        ),
    })
    .strict(),
  summary(args, snap) {
    const track = labelOfTrack(snap, args.track_id);
    const item = labelOfReturn(snap, args.return_id);
    if (args.level_db === null) return `Took ${track} off ${item}`;
    // A level-only call leaves `pre` where it is, so the sentence says what the
    // send is set to rather than what the call did not name.
    const pre = args.pre ?? snap.sends?.[sendKey(args.track_id, args.return_id)]?.pre ?? false;
    return `Sent ${track} to ${item} at ${args.level_db} dB, ${pre ? "before" : "after"} the fader`;
  },
  touches(args) {
    return [sendRef(args.track_id, args.return_id), trackRef(args.track_id), returnRef(args.return_id)];
  },
  apply(doc, args) {
    requireTrack(doc, args.track_id);
    requireReturn(doc, args.return_id);
    const key = sendKey(args.track_id, args.return_id);
    const ref = sendRef(args.track_id, args.return_id);
    const existing = getSend(doc, args.track_id, args.return_id);

    if (args.level_db === null) {
      if (!existing) return { before: {}, after: {} };
      const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(existing)) };
      sendMap(doc).delete(key);
      return { before, after: { [fieldKey(ref, "*")]: ABSENT } };
    }

    if (!existing) {
      const feeds = sendsForTrack(doc, args.track_id);
      if (feeds.length >= LIMITS.sendsPerTrack) {
        refuseLimit(`A track sends to at most ${LIMITS.sendsPerTrack} returns.`);
      }
      const send = {
        track_id: args.track_id,
        return_id: args.return_id,
        level_db: args.level_db,
        pre: args.pre === true,
      };
      sendMap(doc).set(key, objectMap(send));
      return {
        before: { [fieldKey(ref, "*")]: ABSENT },
        after: { [fieldKey(ref, "*")]: cloneJson(send) },
      };
    }

    // Each field of a send is written on its own, so a call that names only a
    // level keeps the send's `pre` where it is and undoes as one field. A new
    // send is post-fader unless the call says otherwise, which is the mixer's
    // usual case.
    const before = {};
    const after = {};
    const writes = [["level_db", args.level_db]];
    if (args.pre !== undefined) writes.push(["pre", args.pre === true]);
    for (const [field, value] of writes) {
      const current = existing.get(field);
      const currentValue = current === undefined ? ABSENT : cloneJson(current);
      if (currentValue === value) continue;
      before[fieldKey(ref, field)] = currentValue;
      after[fieldKey(ref, field)] = value;
      existing.set(field, value);
    }
    return { before, after };
  },
});

defineCommand({
  id: "master.set",
  title: "Set the master's gain or its loudness target",
  schema: z
    .object({
      gain_db: z
        .number()
        .finite()
        .optional()
        .describe(`the master gain in dB, ${MIXER_RANGES.master.gain_db[0]} to ${MIXER_RANGES.master.gain_db[1]}`),
      target: z
        .object({
          lufs: z.number().finite().optional().describe("the loudness target in LUFS"),
          true_peak_db: z.number().finite().optional().describe("the true-peak ceiling in dBTP"),
        })
        .strict()
        .optional()
        .describe("the loudness the song is mixed to; a field left out keeps its value"),
    })
    .strict()
    .refine(
      (args) => args.gain_db !== undefined || args.target !== undefined,
      "master.set needs gain_db, target or both",
    )
    .refine(
      (args) =>
        args.target === undefined ||
        args.target.lufs !== undefined ||
        args.target.true_peak_db !== undefined,
      "master.set's target needs lufs, true_peak_db or both",
    ),
  summary(args, snap) {
    const parts = [];
    if (args.gain_db !== undefined) parts.push(`gain to ${args.gain_db} dB`);
    if (args.target !== undefined) {
      const target = args.target;
      const lufs = target.lufs ?? snap.master?.target?.lufs ?? DEFAULT_MASTER.target.lufs;
      const peak = target.true_peak_db ?? snap.master?.target?.true_peak_db ?? DEFAULT_MASTER.target.true_peak_db;
      parts.push(`target to ${lufs} LUFS at ${peak} dBTP`);
    }
    return `Set the master ${parts.join(" and ")}`;
  },
  touches() {
    return [MASTER_REF];
  },
  apply(doc, args) {
    const current = masterSettings(doc);
    const before = {};
    const after = {};
    if (args.gain_db !== undefined) {
      checkRange("The master's gain", args.gain_db, MIXER_RANGES.master.gain_db, "dB");
      before[fieldKey(MASTER_REF, "gain_db")] = current.gain_db;
      after[fieldKey(MASTER_REF, "gain_db")] = args.gain_db;
      masterMap(doc).set("gain_db", args.gain_db);
    }
    if (args.target !== undefined) {
      const target = { ...current.target };
      if (args.target.lufs !== undefined) {
        checkRange("The master's target", args.target.lufs, MIXER_RANGES.master.lufs, "LUFS");
        target.lufs = args.target.lufs;
      }
      if (args.target.true_peak_db !== undefined) {
        checkRange(
          "The master's true-peak ceiling",
          args.target.true_peak_db,
          MIXER_RANGES.master.true_peak_db,
          "dBTP",
        );
        target.true_peak_db = args.target.true_peak_db;
      }
      // The target is one field, written whole: a target is the pair (loudness,
      // ceiling), and the mixer screen picks both in one step.
      before[fieldKey(MASTER_REF, "target")] = cloneJson(current.target);
      after[fieldKey(MASTER_REF, "target")] = cloneJson(target);
      masterMap(doc).set("target", target);
    }
    return { before, after };
  },
});