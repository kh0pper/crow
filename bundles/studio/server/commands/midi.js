/**
 * The Studio 1c MIDI commands: the per-song table that routes a controller's
 * messages to live actions, the operator's accept, and the two factory device
 * profiles that fill it with proposals.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the panel, the MCP tools and the shared history:
 *
 *   midi.map  midi.accept (people only)  midi.remove  midi.propose_profile
 *
 * A mapping is one message — a note, a control change or a program change on
 * one named controller — routed to one action. It is stored in the song's own
 * `midi_maps` container (see doc.js) and it is either live or a proposal:
 *
 *   - `proposed: false` with `accepted_action` equal to its `action` is LIVE.
 *     Only the operator makes a mapping live: `midi.map` run by a person is
 *     live at once, and `midi.accept` is the operator's own command.
 *   - `proposed: true` is a PROPOSAL. It is never routed, and an agent may only
 *     make proposals: its `midi.map` always creates a new mapping and never
 *     edits one that exists, and it can remove only proposals of its own kind.
 *
 * Three rules the rest of the MIDI page leans on:
 *   - a mapping may run ONLY an allow-listed action. `MIDI_ACTIONS` below is
 *     that list, one schema per kind, and it is the one table everything else
 *     reads (the panel's picker, the MCP tool text and this file). A command
 *     that edits the song — `track.remove`, a people-only command, one Studio
 *     issues itself — is not a live action and can never be mapped. There is no
 *     `voice.talk` in 1c (see the plan's "Left open on purpose").
 *   - the ids an action names (a scene, a clip, a track, a bank) must exist in
 *     the song when the mapping is made, so a mapping never points at nothing.
 *   - the message has to be one its action can run: the ONE table in
 *     `panel/midi-route.js` says which types each kind takes (a held effect
 *     needs a note or a CC, a value control needs a CC, a program change has no
 *     release), and a mismatch is refused with that table's own sentence.
 *   - one message has one live action: two LIVE mappings for the same message on
 *     the same controller are refused, so the router never has to choose.
 *
 * `routeFor()` is the pure half of this module: given a song snapshot and an
 * incoming message, it answers which live mapping runs and what it runs. It is a
 * thin call into `panel/midi-route.js`, the ONE copy of the routing rule, which
 * the page inlines and runs too — so the hub and the page can never answer a
 * message differently. The page does the playing; nothing here touches the
 * audio or the browser.
 *
 * Every `apply` validates everything it needs before it writes anything, so a
 * refusal (an unknown action, a missing scene, a full table) leaves the document
 * exactly as it was.
 */

import { z } from "zod";
import {
  acceptsMessageType,
  messageNeedsText,
  routeFor as routeInMidiRoute,
} from "../../panel/midi-route.js";
import { addLimitIssue, defineCommand, StudioError } from "./registry.js";
import {
  LIMITS,
  SAMPLER_DEVICE,
  cloneJson,
  getBank,
  getClip,
  getMidiMapping,
  getScene,
  getTrack,
  midiEntries,
  midiMap,
  objectMap,
  objectRef,
  toPlain,
} from "../doc.js";

/**
 * What an agent is told when it tries to change a mapping the operator has
 * accepted. The hub answers with this same sentence for an agent's command, its
 * undo and its redo (see the MIDI guard in hub.js).
 */
export const MIDI_NEEDS_A_YES = "Only the operator changes an accepted MIDI mapping.";

/** A controller name (as its port names it) is 1-80 characters. */
const MAX_NAME = 80;

/**
 * The value a before/after entry carries when the object or field did not
 * exist. `null`, not `undefined`: a history entry is stored as JSON, which drops
 * `undefined` keys (see doc.js).
 */
const ABSENT = null;

/** An id inside the song: 1-40 letters, digits, dashes or underscores. */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores");

/** A pad of a bank, 0-15. */
const padIndexSchema = z.number().int().min(0).max(LIMITS.padsPerBank - 1).describe("the pad, 0-15");

/** A macro knob, 0-7 (the first one is knob 1 to a person). */
const macroIndexSchema = z.number().int().min(0).max(7).describe("the macro knob, 0-7");

/**
 * The pad fields a `pad.param` mapping may sweep: the pad's own settings that
 * hold a number. A note, a filter type or a switch is not a value a controller
 * can sweep between a minimum and a maximum.
 * @type {readonly string[]}
 */
const PAD_PARAM_FIELDS = Object.freeze([
  "pitch",
  "gain_db",
  "cutoff_hz",
  "resonance",
  "attack_ms",
  "decay_ms",
  "sustain",
  "release_ms",
  "pan",
]);

/** The performance effects a pedal or a knob may hold (plan 1c, Task 11). */
export const FX_HOLD_NAMES = Object.freeze([
  "filter_sweep",
  "lofi",
  "stutter",
  "tape_stop",
  "reverb_throw",
]);

/**
 * THE allow-list of live actions a MIDI message may run, one schema per kind
 * for that action's own arguments (the `kind` is carried beside them).
 *
 * This table is the whole rule: anything not named here cannot be mapped, so a
 * command that edits the song (or a people-only or Studio-only command) has no
 * way in. The panel draws its picker from it, the MCP tool text names it, and
 * `midi.map` refuses an unknown kind by listing it.
 *
 * `panel/midi-route.js` holds the plain-JS twin the router gates on (it cannot
 * import zod: the page inlines it). The two must accept exactly the same
 * arguments, and a test rides them against each other kind by kind — change one
 * and change the other. Which message types each kind takes (and the sentence a
 * mismatch is refused with) is in that same script, because Learn, the router
 * and this table all need the one answer.
 *
 * @type {Readonly<Object<string, import("zod").ZodTypeAny>>}
 */
export const MIDI_ACTIONS = Object.freeze({
  "scene.launch": z
    .object({ scene_id: idSchema.describe("the scene to launch") })
    .strict(),
  "clip.launch": z
    .object({ clip_id: idSchema.describe("the clip to launch") })
    .strict(),
  "transport.play": z.object({}).strict(),
  "transport.stop": z.object({}).strict(),
  "record.toggle": z.object({}).strict(),
  stop_all: z.object({}).strict(),
  "pad.play": z
    .object({
      track_id: idSchema.describe("the sampler track whose pad plays"),
      bank_id: idSchema.describe("the bank the pad sits in"),
      index: padIndexSchema,
    })
    .strict(),
  "pad.param": z
    .object({
      track_id: idSchema.describe("the sampler track whose pad it is"),
      param: z.enum(PAD_PARAM_FIELDS).describe(`the pad field the control sweeps: ${PAD_PARAM_FIELDS.join(", ")}`),
      min: z.number().finite().describe("the value at the bottom of the control"),
      max: z.number().finite().describe("the value at the top of the control"),
    })
    .strict()
    .refine((args) => args.min <= args.max, "min is the bottom of the control and max the top, so min is not above max"),
  "track.macro": z
    .object({
      track_id: idSchema.describe("the track whose macro knob turns"),
      index: macroIndexSchema,
    })
    .strict(),
  "fx.hold": z
    .object({
      name: z.enum(FX_HOLD_NAMES).describe(`the performance effect: ${FX_HOLD_NAMES.join(", ")}`),
    })
    .strict(),
  "looper.cycle": z.object({}).strict(),
  "looper.to_pad": z
    .object({
      track_id: idSchema.describe("the sampler track the loop lands on"),
      bank_id: idSchema.describe("the bank the pad sits in"),
      index: padIndexSchema,
    })
    .strict(),
  "mix.gain": z
    .object({ track_id: idSchema.describe("the track whose level the control rides") })
    .strict(),
  "keys.play": z.object({}).strict(),
  "macro.set": z
    .object({ index: macroIndexSchema.describe("the selected track's macro knob, 0-7") })
    .strict(),
});

/** Every action kind a mapping may run, derived from the one table above. */
export const MIDI_ACTION_KINDS = Object.freeze(Object.keys(MIDI_ACTIONS));

/**
 * The Behringer FCB1010's factory defaults — verify against the unit.
 *
 * Pedal n (1-based, as people count pedals) sends program change n − 1 on
 * channel 1, and the two expression pedals send control changes 27 (A) and 7
 * (B). Every unit can be reprogrammed, so these are the defaults the profile
 * starts from and not a promise about the pedal on the floor.
 */
export const FCB1010_PROFILE = Object.freeze({
  device: "fcb1010",
  device_name: "FCB1010",
  /** Pedal n sends program change `first_number + (n - 1)` on `count` pedals. */
  pedal: Object.freeze({ type: "pc", channel: 1, first_number: 0, count: 10 }),
  /** Expression pedal A sends CC 27, B sends CC 7 — factory defaults, verify against the unit. */
  expression: Object.freeze([
    Object.freeze({ slot: "exp-a", letter: "A", message: Object.freeze({ type: "cc", channel: 1, number: 27 }) }),
    Object.freeze({ slot: "exp-b", letter: "B", message: Object.freeze({ type: "cc", channel: 1, number: 7 }) }),
  ]),
});

/**
 * The Akai MPK Mini's factory defaults — verify against the unit.
 *
 * The eight pads send notes 36-43 on channel 10 and the eight knobs send control
 * changes 70-77 on channel 1. The unit's keys send notes on channel 1 as well,
 * but Studio has no live note path for an instrument track yet, so the profile
 * proposes no `keys.play` row: it would claim a channel and play nothing. A
 * unit can be reprogrammed, and these are the defaults the profile starts from.
 */
export const MPK_MINI_PROFILE = Object.freeze({
  device: "mpk_mini",
  device_name: "MPK Mini",
  /** The eight pads: notes 36-43 on channel 10 — factory defaults, verify against the unit. */
  pads: Object.freeze({ type: "note", channel: 10, first_number: 36, count: 8 }),
  /** The eight knobs: control changes 70-77 on channel 1 — factory defaults, verify against the unit. */
  knobs: Object.freeze({ type: "cc", channel: 1, first_number: 70, count: 8 }),
});

/** The message one mapping answers: a note, a control change or a program change. */
const messageSchema = z
  .object({
    type: z.enum(["note", "cc", "pc"]).describe('"note", "cc" or "pc"'),
    channel: z.number().int().min(1).max(16).describe("the MIDI channel, 1-16"),
    number: z
      .number()
      .int()
      .min(0)
      .max(127)
      .describe("the note number, controller number or program number, 0-127"),
  })
  .strict();

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
}

/** @returns {string} the ref of one MIDI mapping. */
function midiRef(id) {
  return objectRef("midi", id);
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

/** @returns {boolean} whether the caller of this step is the operator. */
function callerIsOperator(context) {
  return context?.author?.kind === "human";
}

/**
 * One field of a live object as a before/after value: deep-cloned JSON, or
 * `null` when the document does not hold it.
 * @param {Y.Map<any>|null} object
 * @param {string} field
 * @returns {any}
 */
function fieldValue(object, field) {
  const value = object?.get?.(field);
  return value === undefined ? ABSENT : cloneJson(toPlain(value));
}

/** @returns {string} a track's name for a line, or its id when there is none. */
function trackName(snap, id) {
  const name = (snap?.tracks ?? []).find((track) => track.id === id)?.name;
  return typeof name === "string" && name !== "" ? name : id;
}

/** @returns {string} a scene's name for a line, or its id when there is none. */
function sceneName(snap, id) {
  const name = (snap?.scenes ?? []).find((scene) => scene.id === id)?.name;
  return typeof name === "string" && name !== "" ? name : id;
}

/** @returns {string} a clip's name for a line, or its id when there is none. */
function clipName(snap, id) {
  const name = snap?.clips?.[id]?.name;
  return typeof name === "string" && name !== "" ? name : id;
}

/** @returns {string} a bank's name for a line, or its id when there is none. */
function bankName(snap, trackId, bankId) {
  const name = snap?.banks?.[`${trackId}/${bankId}`]?.name;
  return typeof name === "string" && name !== "" ? name : bankId;
}

/** @returns {string} the effect's name as people read it. */
function fxName(name) {
  switch (name) {
    case "filter_sweep":
      return "filter sweep";
    case "lofi":
      return "lo-fi";
    case "stutter":
      return "stutter";
    case "tape_stop":
      return "tape stop";
    case "reverb_throw":
      return "reverb throw";
    default:
      return String(name);
  }
}

/** @returns {string} one incoming message in plain words, controller included. */
function messageText(message) {
  const number = Number(message?.number);
  const device = `"${message?.device_name ?? ""}"`;
  if (message?.type === "note") return `note ${number} on ${device}`;
  if (message?.type === "cc") return `control change ${number} on ${device}`;
  return `program change ${number} on ${device}`;
}

/** @returns {string} a stored message in plain words, without a controller. */
function storedMessageText(message) {
  const number = Number(message?.number);
  if (message?.type === "note") return `note ${number}`;
  if (message?.type === "cc") return `control change ${number}`;
  return `program change ${number}`;
}

/**
 * One action in plain words, 1-based where people count (pad 5, knob 3, the
 * first track). The message travels in because `keys.play` names a channel and
 * no id.
 * @param {object} action
 * @param {object} snap - a snapshot, to name the objects the action drives
 * @param {object|null} [message]
 * @returns {string}
 */
function actionText(action, snap, message = null) {
  const kind = action?.kind;
  switch (kind) {
    case "scene.launch":
      return `launch scene "${sceneName(snap, action.scene_id)}"`;
    case "clip.launch":
      return `launch clip "${clipName(snap, action.clip_id)}"`;
    case "transport.play":
      return "play";
    case "transport.stop":
      return "stop";
    case "record.toggle":
      return "start or stop recording";
    case "stop_all":
      return "stop everything";
    case "pad.play":
      return `play pad ${Number(action.index) + 1} of bank "${bankName(snap, action.track_id, action.bank_id)}" on "${trackName(snap, action.track_id)}"`;
    case "pad.param":
      return `sweep ${action.param} from ${action.min} to ${action.max} on the selected pad of "${trackName(snap, action.track_id)}"`;
    case "track.macro":
      return `turn macro knob ${Number(action.index) + 1} on "${trackName(snap, action.track_id)}"`;
    case "fx.hold":
      return `hold the ${fxName(action.name)} effect`;
    case "looper.cycle":
      return "advance the looper";
    case "looper.to_pad":
      return `capture the looper into pad ${Number(action.index) + 1} of bank "${bankName(snap, action.track_id, action.bank_id)}" on "${trackName(snap, action.track_id)}"`;
    case "mix.gain":
      return `ride the level of "${trackName(snap, action.track_id)}"`;
    case "keys.play":
      return `play the keys on channel ${Number(message?.channel ?? 1)}`;
    case "macro.set":
      return `turn macro knob ${Number(action.index) + 1} on the selected track`;
    default:
      return String(kind ?? "nothing");
  }
}

/** @returns {string} the allow-list as a sentence names it: "a", "b", … */
function kindList() {
  return MIDI_ACTION_KINDS.map((kind) => `"${kind}"`).join(", ");
}

/**
 * What is wrong with one action object's arguments, if anything.
 * @param {any} action - the `{kind, ...args}` a caller sent
 * @returns {string|null} one sentence naming the allowed kinds, or null
 */
function actionRefusal(action) {
  const kind = action?.kind;
  if (typeof kind !== "string" || kind === "") {
    return `A MIDI mapping needs an action kind; the actions a mapping may run are ${kindList()}.`;
  }
  const schema = Object.hasOwn(MIDI_ACTIONS, kind) ? MIDI_ACTIONS[kind] : null;
  if (!schema) {
    return `"${kind}" cannot be mapped to a MIDI control; the actions a mapping may run are ${kindList()}.`;
  }
  const { kind: _kind, ...args } = action;
  const parsed = schema.safeParse(args);
  if (parsed.success) return null;
  const details = parsed.error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  return `A ${kind} mapping was given the wrong arguments: ${details}`;
}

/** @returns {Y.Map<any>} the live mapping, or a refusal. */
function requireMapping(doc, id) {
  const mapping = getMidiMapping(doc, id);
  if (!mapping) refuseMissing(`There is no MIDI mapping "${id}" in this song.`);
  return mapping;
}

/** @returns {Y.Map<any>} the live track, or a refusal. */
function requireTrack(doc, id) {
  const track = getTrack(doc, id);
  if (!track) refuseMissing(`There is no track "${id}" in this song.`);
  return track;
}

/**
 * Refuse a track's action naming a bank the track does not have.
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @param {string} bankId
 * @returns {void}
 */
function requireBank(doc, trackId, bankId) {
  if (getBank(doc, trackId, bankId)) return;
  refuseMissing(`Track "${trackId}" has no bank "${bankId}" in this song.`);
}

/**
 * Refuse an action naming an object the song does not hold. A mapping is made
 * against the song as it is, so it never starts out pointing at nothing: scenes,
 * clips, tracks and banks all have to be there when the mapping is made.
 * @param {Y.Doc} doc
 * @param {object} action
 * @returns {void}
 */
function checkActionTargets(doc, action) {
  switch (action.kind) {
    case "scene.launch":
      if (!getScene(doc, action.scene_id)) {
        refuseMissing(`There is no scene "${action.scene_id}" in this song.`);
      }
      return;
    case "clip.launch":
      if (!getClip(doc, action.clip_id)) {
        refuseMissing(`There is no clip "${action.clip_id}" in this song.`);
      }
      return;
    case "pad.play":
    case "looper.to_pad":
      requireTrack(doc, action.track_id);
      requireBank(doc, action.track_id, action.bank_id);
      return;
    case "pad.param":
    case "track.macro":
    case "mix.gain":
      requireTrack(doc, action.track_id);
      return;
    default:
      return;
  }
}

/** @returns {boolean} whether two messages are the same message. */
function sameMessage(left, right) {
  if (!left || !right) return false;
  return left.type === right.type && left.channel === right.channel && left.number === right.number;
}

/**
 * Refuse a mapping that would leave two LIVE mappings answering one message on
 * one controller: one message has one live action, so the router never has to
 * choose between two.
 * @param {Y.Doc} doc
 * @param {string} deviceName
 * @param {object} message
 * @param {string|null} exceptId - the mapping being written, left out of the search
 * @returns {void}
 */
function checkOneLive(doc, deviceName, message, exceptId = null, keysAction = false) {
  for (const { id, mapping } of midiEntries(doc)) {
    if (id === exceptId) continue;
    if (mapping.get("proposed") === true) continue;
    if (mapping.get("device_name") !== deviceName) continue;
    const stored = toPlain(mapping.get("message"));
    // keys.play claims a whole channel's notes, so two of them on one channel
    // would both answer every note.
    const keysClash =
      keysAction === true &&
      toPlain(mapping.get("action"))?.kind === "keys.play" &&
      stored?.type === "note" &&
      Number(stored?.channel) === Number(message?.channel);
    if (!keysClash && !sameMessage(stored, message)) continue;
    refuseConflict(
      `"${deviceName}" already drives something with ${storedMessageText(message)}; one message has one live action, so remove the mapping "${id}" first.`,
    );
  }
}

/** @returns {number} how many MIDI mappings the song holds right now. */
function mappingCount(doc) {
  return midiEntries(doc).length;
}

// --- The mapping commands ---------------------------------------------------

defineCommand({
  id: "midi.map",
  title: "Route a MIDI message to an action",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("the mapping's id; one is generated when omitted"),
      device_name: z
        .string()
        .min(1)
        .max(MAX_NAME)
        .describe('the controller, as its port names it, e.g. "FCB1010"'),
      message: messageSchema,
      action: z
        .object({ kind: z.string().min(1).describe(`one of: ${MIDI_ACTION_KINDS.join(", ")}`) })
        .passthrough()
        .describe("the live action the message runs: a kind and that kind's arguments"),
    })
    .strict()
    .superRefine((args, ctx) => {
      const refusal = actionRefusal(args.action);
      if (refusal) ctx.addIssue({ code: "custom", message: refusal });
      // The message has to be one this action can run. The rule and the
      // sentence are the router's own (panel/midi-route.js), so the refusal an
      // agent gets here is the one Learn says and the one routing enforces.
      const kind = args.action?.kind;
      if (typeof kind !== "string" || !Object.hasOwn(MIDI_ACTIONS, kind)) return;
      if (!acceptsMessageType(kind, args.message?.type)) {
        ctx.addIssue({ code: "custom", message: messageNeedsText(kind) });
      }
    }),
  summary(args, snap, context) {
    const message = messageText({ ...args.message, device_name: args.device_name });
    const action = actionText(args.action, snap, args.message);
    if (!callerIsOperator(context)) return `Proposed mapping ${message} to ${action}`;
    const editing = Boolean(snap?.midi_maps?.[args.id]);
    return editing ? `Changed the mapping ${message} to ${action}` : `Mapped ${message} to ${action}`;
  },
  touches(args) {
    return [midiRef(args.id)];
  },
  /**
   * The operator's mapping is live at once; an agent's is always a proposal.
   *
   * An agent's `midi.map` never edits a mapping that exists — it proposes a new
   * one, under a new id — so an accepted mapping cannot be changed by an agent
   * at all, and neither can a proposal an agent set earlier (it makes a second
   * proposal instead).
   */
  apply(doc, args, _snap, context) {
    const operator = callerIsOperator(context);
    checkActionTargets(doc, args.action);
    const existing = getMidiMapping(doc, args.id);

    if (!operator && existing) {
      throw new StudioError(
        "human_only",
        `An agent proposes a new mapping; it cannot change mapping ${args.id}.`,
      );
    }
    if (!existing && mappingCount(doc) >= LIMITS.midiMaps) {
      refuseLimit(`A song can hold at most ${LIMITS.midiMaps} MIDI mappings.`);
    }
    if (operator) checkOneLive(doc, args.device_name, args.message, args.id, args.action.kind === "keys.play");

    const ref = midiRef(args.id);
    if (!existing) {
      const mapping = {
        id: args.id,
        device_name: args.device_name,
        message: cloneJson(args.message),
        action: cloneJson(args.action),
        set_by: operator ? "operator" : "agent",
        proposed: !operator,
        accepted_action: operator ? cloneJson(args.action) : ABSENT,
      };
      midiMap(doc).set(args.id, objectMap(mapping));
      return {
        before: { [fieldKey(ref, "*")]: ABSENT },
        after: { [fieldKey(ref, "*")]: cloneJson(mapping) },
      };
    }

    // The operator editing a mapping that is there: one step, one field per
    // value that actually moves, so an edit undoes on its own.
    const next = [
      ["device_name", args.device_name],
      ["message", cloneJson(args.message)],
      ["action", cloneJson(args.action)],
      ["set_by", "operator"],
      ["proposed", false],
      ["accepted_action", cloneJson(args.action)],
    ];
    const before = {};
    const after = {};
    for (const [field, value] of next) {
      const current = fieldValue(existing, field);
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      before[fieldKey(ref, field)] = current;
      after[fieldKey(ref, field)] = value;
      existing.set(field, cloneJson(value));
    }
    return { before, after };
  },
});

defineCommand({
  id: "midi.accept",
  // Only the operator accepts a proposal: the agent may propose as much as it
  // likes, and the operator's yes is what makes a mapping live (plan 1c, Review
  // Focus 4).
  humanOnly: true,
  title: "Accept a proposed MIDI mapping (people only)",
  schema: z
    .object({
      id: idSchema.describe("the mapping to accept"),
      // What the operator was shown when they said yes. A proposal can be
      // removed and proposed again under the same id with another action, so
      // the yes is bound to what was reviewed, not to the id alone.
      expect: z
        .object({
          device_name: z.string().min(1).max(MAX_NAME),
          message: messageSchema,
          action: z.object({ kind: z.string().min(1) }).passthrough(),
        })
        .strict()
        .describe("the device, message and action the operator reviewed"),
    })
    .strict(),
  summary(args, snap) {
    // The summary is written from the snapshot the step was prepared on, so the
    // mapping is still a proposal here; its own action is what it will run.
    const mapping = snap?.midi_maps?.[args.id];
    if (!mapping) return `Accepted the mapping "${args.id}"`;
    const message = messageText({ ...mapping.message, device_name: mapping.device_name });
    return `Accepted the mapping ${message}: ${actionText(mapping.action, snap, mapping.message)}`;
  },
  touches(args) {
    return [midiRef(args.id)];
  },
  apply(doc, args, _snap, context) {
    if (!callerIsOperator(context)) throw new StudioError("human_only", MIDI_NEEDS_A_YES);
    const mapping = requireMapping(doc, args.id);
    if (mapping.get("proposed") !== true) {
      refuseConflict(`The mapping "${args.id}" is live already; only a proposal is accepted.`);
    }
    const message = toPlain(mapping.get("message"));
    if (
      mapping.get("device_name") !== args.expect.device_name ||
      !isDeepEqual(message, args.expect.message) ||
      !isDeepEqual(toPlain(mapping.get("action")), args.expect.action)
    ) {
      refuseConflict(
        `The mapping "${args.id}" is not the proposal you were shown any more; look at it again before accepting it.`,
      );
    }
    checkOneLive(doc, mapping.get("device_name"), message, args.id, toPlain(mapping.get("action"))?.kind === "keys.play");
    const ref = midiRef(args.id);
    const action = cloneJson(toPlain(mapping.get("action")));
    const before = {
      [fieldKey(ref, "proposed")]: fieldValue(mapping, "proposed"),
      [fieldKey(ref, "accepted_action")]: fieldValue(mapping, "accepted_action"),
    };
    mapping.set("proposed", false);
    mapping.set("accepted_action", cloneJson(action));
    return {
      before,
      after: { [fieldKey(ref, "proposed")]: false, [fieldKey(ref, "accepted_action")]: cloneJson(action) },
    };
  },
});

defineCommand({
  id: "midi.remove",
  title: "Remove a MIDI mapping",
  schema: z.object({ id: idSchema.describe("the mapping to remove") }).strict(),
  summary(args, snap) {
    const mapping = snap?.midi_maps?.[args.id];
    if (!mapping) return `Removed the mapping "${args.id}"`;
    const message = messageText({ ...mapping.message, device_name: mapping.device_name });
    const state = mapping.proposed === true ? "proposed " : "";
    return `Removed the ${state}mapping ${message}`;
  },
  touches(args) {
    return [midiRef(args.id)];
  },
  /**
   * The operator removes any mapping; an agent only its own kind of thing — a
   * proposal. An accepted mapping is the operator's, so taking it away would be
   * the same yes that accepting it needed.
   */
  apply(doc, args, _snap, context) {
    const mapping = requireMapping(doc, args.id);
    if (!callerIsOperator(context) && mapping.get("proposed") !== true) {
      throw new StudioError("human_only", MIDI_NEEDS_A_YES);
    }
    const ref = midiRef(args.id);
    const before = cloneJson(toPlain(mapping));
    midiMap(doc).delete(args.id);
    return { before: { [fieldKey(ref, "*")]: before }, after: { [fieldKey(ref, "*")]: ABSENT } };
  },
});

/**
 * The mappings one device profile proposes, from the song as a snapshot holds
 * it. Pure: the same snapshot always proposes the same ids, messages and
 * actions, which is what lets `touches` name the refs before `apply` writes
 * them.
 *
 * Ids are fixed per slot (`fcb1010-pedal-3`, `mpk_mini-knob-2`, …), so a profile
 * is the same table every time and re-proposing it over a song that still holds
 * one of its rows is refused rather than silently rewritten.
 * @param {object} snap - a snapshot
 * @param {{device: string, scene_order?: string[]}} args
 * @returns {Array<{id: string, message: object, action: object}>}
 */
function planProfile(snap, args) {
  /** @type {Array<{id: string, message: object, action: object}>} */
  const planned = [];

  if (args.device === FCB1010_PROFILE.device) {
    const pedal = FCB1010_PROFILE.pedal;
    const scenes = Array.isArray(args.scene_order)
      ? args.scene_order
      : (snap.scenes ?? []).map((scene) => scene.id);
    const pedals = Math.min(scenes.length, pedal.count);
    for (let index = 0; index < pedals; index += 1) {
      const n = index + 1;
      planned.push({
        id: `fcb1010-pedal-${n}`,
        message: { type: pedal.type, channel: pedal.channel, number: pedal.first_number + index },
        action: { kind: "scene.launch", scene_id: scenes[index] },
      });
    }
    const tracks = (snap.tracks ?? []).map((track) => track.id);
    for (const [position, expression] of FCB1010_PROFILE.expression.entries()) {
      const trackId = tracks[position];
      if (trackId === undefined) break;
      planned.push({
        id: `fcb1010-${expression.slot}`,
        message: { ...expression.message },
        action: { kind: "mix.gain", track_id: trackId },
      });
    }
    return planned;
  }

  // The MPK Mini: its pads play the first sampler track's bank A pads 1-8 and
  // its knobs turn the selected track's macro knobs. Its keys propose nothing:
  // the page does not play keys yet, so a `keys.play` row would claim a channel
  // and play silence. (`keys.play` stays on the allow-list for when it does.)
  const pads = MPK_MINI_PROFILE.pads;
  const sampler = (snap.tracks ?? []).find((track) => track?.device?.engine === SAMPLER_DEVICE.engine);
  const bank = sampler
    ? Object.values(snap.banks ?? {})
        .filter((item) => item.track_id === sampler.id)
        .sort((left, right) => left.order - right.order)[0] ?? null
    : null;
  if (sampler && bank) {
    for (let index = 0; index < pads.count; index += 1) {
      planned.push({
        id: `mpk_mini-pad-${index + 1}`,
        message: { type: pads.type, channel: pads.channel, number: pads.first_number + index },
        action: { kind: "pad.play", track_id: sampler.id, bank_id: bank.id, index },
      });
    }
  }
  const knobs = MPK_MINI_PROFILE.knobs;
  for (let index = 0; index < knobs.count; index += 1) {
    planned.push({
      id: `mpk_mini-knob-${index + 1}`,
      message: { type: knobs.type, channel: knobs.channel, number: knobs.first_number + index },
      action: { kind: "macro.set", index },
    });
  }
  return planned;
}

/** @returns {string} the line a profile proposal writes, in plain words. */
function profileSummary(args, planned) {
  const device = `"${args.device_name}"`;
  if (args.device === FCB1010_PROFILE.device) {
    const pedals = planned.filter((mapping) => mapping.id.startsWith("fcb1010-pedal-")).length;
    const expression = planned.length - pedals;
    const pedalLine = pedals === 1 ? "1 pedal mapping" : `${pedals} pedal mappings`;
    if (expression === 0) return `Proposed ${pedalLine} (one per scene) for ${device}`;
    return `Proposed ${pedalLine} (one per scene) and ${expression} expression pedal mappings for ${device}`;
  }
  const keys = planned.filter((mapping) => mapping.action.kind === "keys.play").length;
  const padMappings = planned.filter((mapping) => mapping.action.kind === "pad.play").length;
  const knobs = planned.length - keys - padMappings;
  const parts = [];
  if (padMappings > 0) parts.push(`${padMappings} pad mappings`);
  parts.push(`${knobs} knob mappings`);
  if (keys > 0) parts.push(keys === 1 ? "the keys mapping" : `${keys} keys mappings`);
  return `Proposed ${parts.join(", ")} for ${device}`;
}

defineCommand({
  id: "midi.propose_profile",
  title: "Propose a device profile's mappings for this song",
  schema: z
    .object({
      device: z.enum(["fcb1010", "mpk_mini"]).describe("the device profile to lay out"),
      device_name: z
        .string()
        .min(1)
        .max(MAX_NAME)
        .describe('the controller, as its port names it, e.g. "FCB1010"'),
      scene_order: z
        .array(idSchema)
        .optional()
        .describe("FCB1010 only: the scenes the pedals launch, in pedal order; the song's own order when omitted"),
    })
    .strict()
    .superRefine((args, ctx) => {
      if (args.scene_order === undefined) return;
      if (args.scene_order.length > FCB1010_PROFILE.pedal.count) {
        addLimitIssue(
          ctx,
          `An FCB1010 has ${FCB1010_PROFILE.pedal.count} pedals; this scene order names ${args.scene_order.length} scenes.`,
        );
      }
    }),
  summary(args, snap) {
    return profileSummary(args, planProfile(snap ?? {}, args));
  },
  touches(args, snap) {
    return planProfile(snap ?? {}, args).map((mapping) => midiRef(mapping.id));
  },
  /**
   * A profile is always a set of PROPOSALS, whoever runs it: the operator's yes
   * to each one is `midi.accept`, which is what makes a pedal live. That keeps
   * a profile's twenty rows from routing anything the operator did not look at.
   */
  apply(doc, args, snap, context) {
    const planned = planProfile(snap ?? {}, args);
    if (planned.length === 0) {
      refuseInvalid(
        "There is nothing to map: this song has no scene or track that profile can drive.",
      );
    }
    if (Array.isArray(args.scene_order)) {
      for (const sceneId of args.scene_order) {
        if (!getScene(doc, sceneId)) refuseMissing(`There is no scene "${sceneId}" in this song.`);
      }
    }
    for (const mapping of planned) {
      if (getMidiMapping(doc, mapping.id)) {
        refuseConflict(
          `The song already has a mapping "${mapping.id}"; remove it before proposing this profile again.`,
        );
      }
    }
    if (mappingCount(doc) + planned.length > LIMITS.midiMaps) {
      refuseLimit(
        `A song can hold at most ${LIMITS.midiMaps} MIDI mappings; this profile would need ${mappingCount(doc) + planned.length}.`,
      );
    }

    const map = midiMap(doc);
    const before = {};
    const after = {};
    const setBy = callerIsOperator(context) ? "operator" : "agent";
    for (const entry of planned) {
      const mapping = {
        id: entry.id,
        device_name: args.device_name,
        message: cloneJson(entry.message),
        action: cloneJson(entry.action),
        set_by: setBy,
        proposed: true,
        accepted_action: ABSENT,
      };
      map.set(mapping.id, objectMap(mapping));
      const ref = midiRef(mapping.id);
      before[fieldKey(ref, "*")] = ABSENT;
      after[fieldKey(ref, "*")] = cloneJson(mapping);
    }
    return { before, after };
  },
});

// --- Routing ----------------------------------------------------------------

/**
 * Which live mapping an incoming MIDI message runs, and what it runs.
 *
 * The rule itself — the allow-list with each kind's arguments, the live-only
 * check (`proposed` false AND `action` still equal to `accepted_action`), the
 * `keys.play` channel claim and its precedence under `pad.play` — lives in
 * `panel/midi-route.js`, because the page runs the very same text. This is the
 * server's way in.
 * @param {object} snap - a song snapshot
 * @param {{device_name: string, type: string, channel: number, number: number}} message
 * @returns {{id: string, action: object}|null} the mapping and a copy of its
 *   action, or null when nothing live answers
 */
export function routeFor(snap, message) {
  return routeInMidiRoute(snap, message);
}

/** @returns {boolean} whether two JSON values are the same value. */
function isDeepEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!isDeepEqual(left[key], right[key])) return false;
  }
  return true;
}