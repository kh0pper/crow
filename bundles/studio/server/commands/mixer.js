/**
 * The Studio 1d mixer commands: the effects in a track's, a return's or the
 * master's chain, the sends from a track to a return, the returns themselves,
 * and the song's master.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the mixer screen, the MCP tools and the shared history:
 *
 *   insert.add  insert.remove  insert.move  insert.set  insert.bypass
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
 *     `insert.add` with no `after` appends to the END of the chain — the common
 *     case is "one more effect on this track" — and `insert.move` with
 *     `after: null` puts the effect FIRST, which is what dragging a strip to
 *     the top of the chain means. Both are documented, and both are tested.
 *   - an insert's parameters are the `EFFECT_PARAMS` table's, and every write
 *     is checked against it by name and by range: an unknown parameter lists
 *     the ones the effect has, and an out-of-range one names its own range.
 *   - `insert.add` fills every parameter with its default, so an insert is a
 *     complete object from the moment it exists and the engine never has to
 *     guess a value.
 *   - `EFFECT_PARAMS` has no `amp` yet: amp inserts arrive with PR C, and
 *     `insert.add` refuses that kind with its own sentence until then.
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
  DEFAULT_MASTER,
  EFFECT_KINDS,
  EFFECT_PARAMS,
  LIMITS,
  MASTER_REF,
  MAX_RETURN_NAME,
  MIXER_RANGES,
  cloneJson,
  defaultEffectParams,
  effectLabel,
  getInsert,
  getReturn,
  getSend,
  getTrack,
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

/** One effect's parameters to write, by name; the ranges are checked in `apply`. */
const paramsSchema = z
  .record(z.union([z.number(), z.string()]))
  .describe("the parameters to set, by name; each one is inside its own range (see EFFECT_PARAMS)");

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
  const unit = EFFECT_PARAMS[kind]?.params?.[name]?.unit;
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
  const spec = EFFECT_PARAMS[kind];
  const checked = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    const field = spec.params[name];
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
        .describe(`the effect, one of ${EFFECT_KINDS.join(", ")}`),
      after: idSchema
        .nullable()
        .optional()
        .describe("the effect it goes after; with none, it goes to the end of the chain"),
      params: paramsSchema.optional().describe("the parameters that differ from their defaults"),
    })
    .strict(),
  summary(args, snap) {
    return `Added ${withArticle(effectLabel(args.kind))} to ${ownerLabel(snap, args.owner)}`;
  },
  touches(args) {
    // The new effect and the chain it joins. The effect named by `after` is not
    // written at all — only the new effect's own `order` is — so it is not
    // touched: a chain edit never rolls anything else back.
    return [insertRef(args.id), args.owner];
  },
  apply(doc, args) {
    // An amp insert is PR C's: refusing it here, in its own words, keeps the
    // table honest instead of letting the kind in with no parameters.
    if (args.kind === "amp") refuseInvalid("Amp inserts arrive in a later Studio version.");
    if (!EFFECT_PARAMS[args.kind]) {
      refuseInvalid(
        `"${args.kind}" is not an effect a chain holds; the effects are ${EFFECT_KINDS.join(", ")}.`,
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
    const snap = snapshot(doc);
    let order = appendOrder(chain);
    if (args.after !== null && args.after !== undefined) {
      const placed = orderBehind(chain, args.after);
      if (placed === null) {
        refuseInvalid(
          `There is no insert "${args.after}" in the chain on ${ownerLabel(snap, args.owner)} to place the effect after.`,
        );
      }
      order = placed;
    }
    const params = { ...defaultEffectParams(args.kind), ...checkParams(args.kind, args.params) };
    const insert = { id: args.id, owner: args.owner, order, kind: args.kind, bypass: false, params };
    const stored = objectMap({
      id: insert.id,
      owner: insert.owner,
      order: insert.order,
      kind: insert.kind,
      bypass: insert.bypass,
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
        .describe("the effect it goes after; null puts it first in the chain"),
    })
    .strict(),
  summary(args, snap) {
    const insert = snap.inserts?.[args.id];
    const label = effectLabel(insert?.kind ?? args.id);
    const owner = ownerLabel(snap, insert?.owner);
    if (args.after === null || args.after === undefined) return `Moved the ${label} to the front of the chain on ${owner}`;
    return `Moved the ${label} after the ${effectLabel(snap.inserts?.[args.after]?.kind ?? args.after)} on ${owner}`;
  },
  touches(args, snap) {
    // The moved effect and its chain: `order` is the only field written, so the
    // effect it moves behind is left exactly as it is.
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
    if (args.after === null || args.after === undefined) {
      order = frontOrder(chain);
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
  apply(doc, args) {
    const insert = requireInsert(doc, args.id);
    const kind = String(insert.get("kind") ?? "");
    if (!EFFECT_PARAMS[kind]) {
      refuseInvalid(
        `The insert "${args.id}" holds a "${kind}", which is not one of the effects a chain holds (${EFFECT_KINDS.join(", ")}).`,
      );
    }
    const params = checkParams(kind, args.params);
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
      pre: z.boolean().default(false).describe("true: before the track's fader; false: after it"),
    })
    .strict(),
  summary(args, snap) {
    const track = labelOfTrack(snap, args.track_id);
    const item = labelOfReturn(snap, args.return_id);
    if (args.level_db === null) return `Took ${track} off ${item}`;
    return `Sent ${track} to ${item} at ${args.level_db} dB, ${args.pre ? "before" : "after"} the fader`;
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

    // A send is set whole (its level and its place relative to the fader), so a
    // call that names only a level makes it a post-fader send, which is the
    // schema's default and the mixer's usual case.
    const before = {};
    const after = {};
    for (const field of ["level_db", "pre"]) {
      const value = field === "level_db" ? args.level_db : args.pre === true;
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