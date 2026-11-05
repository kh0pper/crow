/**
 * Studio MCP server — the agent's half of the shared session.
 *
 * Every tool here has a GUI twin, and they are the same code path: a tool call
 * becomes one registry command, sent to the session hub through the agent HTTP
 * API, applied to the one live song document the dashboard is showing. That is
 * why the command tools are generated from the registry rather than written out
 * by hand — a command can never exist for the GUI and be missing for the agent,
 * or the other way round (`tests/studio-parity.test.js` holds that rule).
 *
 * ## Attribution
 *
 * An MCP call is NEVER attributed to the person. The author is resolved from
 * the call (`servers/research/actor.js`, injected through `actor`) and then
 * forced to `kind:"agent"`: a Crow bot becomes `{kind:"agent", id:"bot:<id>"}`,
 * anything else — the operator's own session, an unknown client, no actor at
 * all — becomes `{kind:"agent", id:"mcp", label:"Agent (MCP)"}`. The gateway's
 * agent HTTP routes force `kind:"agent"` again on their side, so a compromised
 * MCP process still cannot write as the operator.
 *
 * Every call, reads included, carries that author to the gateway, because the
 * gateway is what scopes a Crow bot to its own project: the tool arguments
 * never pick a project, and a song outside the bot's project answers like a
 * song that does not exist.
 *
 * ## The three kinds of tool
 *
 *   - one per public, non-humanOnly registry command, `studio_` + the id with
 *     dots turned into underscores (`studio_clip_write`), input
 *     `{song_id, ...args}`. A command marked `internal` is Studio's own —
 *     `take.add` is issued by the gateway's upload finish route — so it gets no
 *     tool at all;
 *   - the song and history reads and the history steps that are not commands
 *     (list/create/summary/get_clip/takes/history/undo/redo);
 *   - the two tools that answer questions about the engine instead of editing
 *     (render, module types).
 *
 * `studio_takes` is a read: a take is added by the gateway's upload finish
 * route and discarded by a person, so the agent gets a listing of what is
 * recorded — length, tempo, latency, who recorded it, whether the comp plays it
 * — and the `studio_take_keep` / `studio_clip_set_comp` commands to use it.
 *
 * `studio_samples` is the sampler's read, for the same reason: a sample is a
 * recording or an import and only the operator brings one in, so the agent gets
 * the song's sounds with their slices and the pads that play them, and the
 * chop and pad commands to work with them — never a way to add or drop a sound.
 *
 * `studio_session_summary` exists because a song does not fit in a prompt: it
 * returns the tracks, scenes and a page of clips with note counts, and the
 * agent asks for one clip's notes with `studio_get_clip` when it needs them.
 *
 * A refusal from the hub is a tool error whose text is the hub's own sentence
 * plus its code in parentheses — the sentence names the object (the locked
 * track, the limit), which is what the agent has to tell the operator.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listCommands } from "./commands/registry.js";
// Registering the 1a commands is a side effect of importing them.
import "./commands/core.js";
// The 1b take commands, registered the same way.
import "./commands/takes.js";
// The 1b timeline commands — placements, markers and sections — likewise.
import "./commands/arrangement.js";
// The 1c sampler commands — kits, pads, samples, patterns and steps.
import "./commands/sampler.js";
// The 1c MIDI commands — a mapping table, the operator's accept and the two
// device profiles. An agent gets tools for `midi.map`, `midi.remove` and
// `midi.propose_profile`; `midi.accept` is people-only, so mcp.js builds no tool
// for it (the loop below skips every humanOnly command).
import "./commands/midi.js";
import { GENERATOR_TYPES, moduleCatalogue } from "./catalogue.js";

/** The author every call falls back to: an agent, never the person (spec §5.3). */
export const MCP_AUTHOR = Object.freeze({ kind: "agent", id: "mcp", label: "Agent (MCP)" });

/** Real name of the server, as it appears to an MCP client. */
export const SERVER_NAME = "studio";

/** The one line every command tool carries about how an edit behaves. */
const UNDO_LINE = "Every change shows up live for the operator, tagged as yours, and can be undone.";

/**
 * What a command's tool says about itself beyond its title.
 *
 * The MIDI commands need it: an agent's mapping is never live. `midi.map` run by
 * an agent always creates a PROPOSAL, which the operator accepts on the MIDI page
 * (the panel's Accept button, which is the people-only `midi.accept`). An accepted
 * mapping is the operator's, so an agent cannot edit or remove one — and there is
 * no tool for `midi.accept` at all, because the loop below skips a people-only
 * command.
 *
 * @type {Readonly<Object<string, string>>}
 */
const COMMAND_NOTES = Object.freeze({
  "midi.map":
    "You propose; the operator accepts. A mapping you make is always a proposal — it plays nothing until the operator accepts it on the MIDI page — and an accepted mapping is theirs, so your next midi.map makes a new proposal instead of editing one. There is no tool for accepting: that yes is the operator's own click.",
  "midi.remove":
    "An agent may remove only a proposal; an accepted mapping is the operator's, and removing it needs their own click.",
  "midi.propose_profile":
    "Every row the profile lays out arrives as a proposal, which the operator accepts one by one or all at once. Read studio_midi first, so you can say which rows you proposed.",
});

/** Clips per page of `studio_session_summary` (the plan's Task 9 interface). */
const SUMMARY_PAGE_SIZE = 50;

/** The most history entries one call returns. */
const HISTORY_LIMIT_MAX = 50;

/** What the agent is told when Studio itself broke; the detail stays in the log. */
const INTERNAL_TEXT = "Studio hit an internal error.";

/**
 * The agent author for one resolved call actor.
 *
 * A bot keeps its identity (`bot:<id>`), so the operator can tell which bot
 * made an edit; everyone else — the operator's own MCP session, an unknown
 * caller, no actor — is the generic MCP agent. The kind is always "agent".
 *
 * @param {{kind?: string, id?: string}|null} actor
 * @returns {{kind: "agent", id: string, label: string}}
 */
/** The author for a forwarded caller that is neither the operator nor a known bot: it sees no songs. */
const OTHER_AUTHOR = Object.freeze({ kind: "agent", id: "other", label: "Unknown caller" });

export function toAgentAuthor(actor) {
  if (actor && actor.kind === "bot" && typeof actor.id === "string" && actor.id !== "") {
    return { kind: "agent", id: `bot:${actor.id}`, label: `Bot ${actor.id}` };
  }
  return { ...MCP_AUTHOR };
}

/**
 * The field shape of a command's zod schema.
 *
 * A command schema may be wrapped in a refinement (`z.object(...).strict()
 * .refine(...)`), and a ZodEffects has no `.shape` of its own; the wrapped
 * object does, so unwrap until it is found. Refinements are not carried into
 * the MCP input schema — the hub runs the full schema on every call anyway —
 * but the command's fields, their types and their own strictness are.
 *
 * @param {object} schema - a zod schema
 * @returns {object} a zod raw shape
 */
export function commandShape(schema) {
  let current = schema;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if (current.shape && typeof current.shape === "object") return current.shape;
    current = current._def?.schema ?? null;
  }
  return {};
}

/** @returns {object} a one-text-block tool result. */
function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: "text", text }] };
}

/** @returns {object} a tool error carrying one sentence. */
function errorResult(text) {
  return { isError: true, content: [{ type: "text", text: String(text) }] };
}

/** @returns {string} a thrown error's message, never an empty string. */
function errorText(err) {
  const message = err && typeof err.message === "string" ? err.message.trim() : "";
  return message === "" ? INTERNAL_TEXT : message;
}

/**
 * Whether a read route answered with the hub's refusal shape instead of its
 * data (an ACL refusal, a missing song, the gateway reporting itself down).
 * @param {unknown} value
 * @returns {boolean}
 */
function isRefusal(value) {
  return !!value && typeof value === "object" && value.ok === false && typeof value.code === "string";
}

/**
 * The text a hub refusal becomes: its own sentence, then its code.
 *
 * Code `internal` is the one refusal whose sentence is NOT for the agent: the
 * gateway has already told the agent nothing it could act on, and the detail
 * — a query, a path, a stack — could name this instance's own files. That
 * detail is logged here, where the operator can read it, and the agent gets one
 * fixed sentence instead.
 *
 * @param {{ok?: boolean, code?: string, error?: string}|null} result
 * @returns {string}
 */
export function refusalText(result) {
  const code = result && typeof result.code === "string" ? result.code : "";
  if (code === "internal") {
    console.warn("[studio]", result.error ?? "internal error");
    return INTERNAL_TEXT;
  }
  const text = result && typeof result.error === "string" && result.error !== ""
    ? result.error
    : "Studio refused the call.";
  return code !== "" ? `${text} (${code})` : text;
}

/**
 * The compact view of a song `studio_session_summary` returns: no notes, a note
 * count per clip, one page of clips at a time.
 * @param {string} songId
 * @param {object} snapshot - the hub's `snapshot()` shape
 * @param {number} page - 1-based page of clips
 * @returns {object}
 */
export function sessionSummary(songId, snapshot, page = 1) {
  const meta = snapshot?.meta ?? {};
  const allClips = Object.values(snapshot?.clips ?? {}).map((clip) => ({
    id: clip.id,
    track_id: clip.track_id,
    scene_id: clip.scene_id,
    name: clip.name,
    length_bars: clip.length_bars,
    note_count: Array.isArray(clip.notes) ? clip.notes.length : 0,
  }));
  const pages = Math.max(1, Math.ceil(allClips.length / SUMMARY_PAGE_SIZE));
  const wanted = Number.isFinite(page) ? Math.trunc(page) : 1;
  const current = Math.min(Math.max(1, wanted), pages);
  const from = (current - 1) * SUMMARY_PAGE_SIZE;

  return {
    song_id: songId,
    title: typeof meta.title === "string" ? meta.title : "Untitled song",
    bpm: Number.isFinite(meta.bpm) ? meta.bpm : 120,
    key: typeof meta.key === "string" ? meta.key : "C major",
    tracks: (snapshot?.tracks ?? []).map((track) => ({
      id: track.id,
      name: track.name,
      device: { type: track.device?.type ?? null },
      mute: track.mute === true,
      solo: track.solo === true,
      locked: track.locked === true,
    })),
    scenes: (snapshot?.scenes ?? []).map((scene) => ({ id: scene.id, name: scene.name })),
    clips: allClips.slice(from, from + SUMMARY_PAGE_SIZE),
    page: current,
    pages,
  };
}

/**
 * The takes of a song, newest first, the way `studio_takes` reports them.
 *
 * A take's stored shape is what the document needs (frames, an offset in the
 * host's frames, a storage key); its readers want seconds and milliseconds,
 * because that is what a musician compares. `in_comp` says whether the clip's
 * comp plays any of it right now, so the agent can tell a kept take from one
 * that is only sitting in the clip.
 *
 * @param {object} snapshot - the hub's `snapshot()` shape
 * @param {string|null} [clipId] - only takes of this clip, when given
 * @returns {object[]} one row per take, newest `recorded_at` first
 */
export function takeList(snapshot, clipId = null) {
  const takes = snapshot?.takes && typeof snapshot.takes === "object" ? snapshot.takes : {};
  const clips = snapshot?.clips && typeof snapshot.clips === "object" ? snapshot.clips : {};

  const comped = new Set();
  for (const clip of Object.values(clips)) {
    const segments = Array.isArray(clip?.comp) ? clip.comp : [];
    for (const segment of segments) {
      if (segment && typeof segment.take_id === "string") comped.add(segment.take_id);
    }
  }

  const rows = [];
  for (const take of Object.values(takes)) {
    if (!take || typeof take !== "object") continue;
    if (clipId !== null && take.clip_id !== clipId) continue;
    const rate = Number(take.rate) > 0 ? Number(take.rate) : 48000;
    const frames = Number(take.frames) || 0;
    const offsetFrames = Number(take.offset_frames) || 0;
    rows.push({
      id: take.id,
      clip_id: take.clip_id,
      // Two decimals of seconds and one of milliseconds: enough to see a take's
      // length and its latency at a glance, and stable in a JSON answer.
      seconds: Math.round((frames / rate) * 100) / 100,
      channels: Number(take.channels) || 1,
      rate: rate,
      bpm: Number(take.bpm) || 0,
      compensated: take.compensated === true,
      offset_ms: Math.round((offsetFrames / rate) * 1000 * 10) / 10,
      author_label: typeof take.author_label === "string" ? take.author_label : "",
      recorded_at: typeof take.recorded_at === "string" ? take.recorded_at : "",
      discarded: take.discarded === true,
      in_comp: comped.has(take.id),
    });
  }

  // Newest first: `recorded_at` is ISO 8601, so its text order is its time
  // order. Ties keep the document's own order (the sort is stable).
  rows.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0));
  return rows;
}

/**
 * The samples of a song, the way `studio_samples` reports them.
 *
 * A sample's stored shape is what the document and the engine need (frames, a
 * rate, a storage key); its readers want seconds and the things a musician
 * counts — how long it is, where it came from, which pads play it, and the
 * slices its chop left, in the order they play. A pad that plays a slice says
 * so; a pad that plays the whole sample has `slice_id: null`.
 *
 * @param {object} snapshot - the hub's `snapshot()` shape
 * @param {string|null} [sampleId] - only this sample, when given
 * @returns {object[]} one row per sample, in the song's own order
 */
export function sampleList(snapshot, sampleId = null) {
  const samples = snapshot?.samples && typeof snapshot.samples === "object" ? snapshot.samples : {};
  const slices = snapshot?.slices && typeof snapshot.slices === "object" ? snapshot.slices : {};
  const pads = snapshot?.pads && typeof snapshot.pads === "object" ? snapshot.pads : {};
  const banks = snapshot?.banks && typeof snapshot.banks === "object" ? snapshot.banks : {};
  const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];

  /** @returns {string} a track's name, or its id when the song no longer holds it. */
  const trackName = (id) => tracks.find((track) => track?.id === id)?.name ?? id;
  /** @returns {object|null} the bank a pad sits in, or null. */
  const bankOf = (pad) =>
    Object.values(banks).find((bank) => bank?.track_id === pad.track_id && bank?.id === pad.bank_id) ?? null;

  /** @type {Map<string, object[]>} */
  const slicesOf = new Map();
  for (const slice of Object.values(slices)) {
    if (!slice || typeof slice !== "object") continue;
    const list = slicesOf.get(slice.sample_id) ?? [];
    list.push(slice);
    slicesOf.set(slice.sample_id, list);
  }

  /** @type {Map<string, object[]>} */
  const padsOf = new Map();
  for (const pad of Object.values(pads)) {
    if (!pad || typeof pad !== "object") continue;
    if (typeof pad.sample_id !== "string" || pad.sample_id === "") continue;
    const list = padsOf.get(pad.sample_id) ?? [];
    list.push(pad);
    padsOf.set(pad.sample_id, list);
  }

  const rows = [];
  // In a fixed order (name, then id), whatever order the document's map holds
  // them in after a reload or a merge.
  const ordered = Object.values(samples)
    .filter((sample) => sample && typeof sample === "object")
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || String(a.id).localeCompare(String(b.id)));
  for (const sample of ordered) {
    if (sampleId !== null && sample.id !== sampleId) continue;
    const rate = Number(sample.rate) > 0 ? Number(sample.rate) : 48000;
    const frames = Number(sample.frames) || 0;
    /** @returns {number} one frame position in seconds, to the millisecond. */
    const seconds = (value) => Math.round((value / rate) * 1000) / 1000;

    rows.push({
      id: sample.id,
      name: typeof sample.name === "string" ? sample.name : "",
      // Two decimals, like a take's length: enough to see a sound's size at a
      // glance, and stable in a JSON answer.
      seconds: Math.round((frames / rate) * 100) / 100,
      channels: Number(sample.channels) || 1,
      rate,
      origin: typeof sample.origin === "string" ? sample.origin : "",
      author_label: typeof sample.author_label === "string" ? sample.author_label : "",
      slices: (slicesOf.get(sample.id) ?? [])
        .map((slice) => ({
          id: slice.id,
          start_frame: Number(slice.start_frame) || 0,
          end_frame: Number(slice.end_frame) || 0,
          start_seconds: seconds(Number(slice.start_frame) || 0),
          end_seconds: seconds(Number(slice.end_frame) || 0),
        }))
        // A slice id names one slice, so the order is total: start first, then id.
        .sort((a, b) => a.start_frame - b.start_frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      pads: (padsOf.get(sample.id) ?? [])
        .map((pad) => {
          const bank = bankOf(pad);
          const index = Number(pad.index) || 0;
          return {
            track_id: pad.track_id,
            track: trackName(pad.track_id),
            bank_id: pad.bank_id,
            bank: typeof bank?.name === "string" ? bank.name : pad.bank_id,
            index,
            // Numbered the way the operator counts them, like every refusal does.
            pad: index + 1,
            slice_id: typeof pad.slice_id === "string" ? pad.slice_id : null,
          };
        })
        .sort(
          (a, b) =>
            a.track_id.localeCompare(b.track_id) ||
            a.bank_id.localeCompare(b.bank_id) ||
            a.index - b.index,
        ),
    });
  }
  return rows;
}

/**
 * The sample listing's neighbours: the plain words a MIDI mapping is reported
 * in, and the listing `studio_midi` answers with.
 *
 * A stored message is numbers (`{type, channel, number}`); a person reads a
 * program change, a note or a control change on a channel. An action is a
 * `{kind, ...}`; a person reads a sentence, with the scene, clip, track, bank or
 * pad it names filled in from the song. Both are given, plus the action as JSON,
 * because an agent edits with the ids and reports with the words.
 */

/** @returns {string} one stored message in plain words. */
function messageWords(message) {
  const number = Number(message?.number) || 0;
  const channel = Number(message?.channel) || 1;
  const words = message?.type === "note" ? `note ${number}`
    : message?.type === "cc" ? `control change ${number}`
      : `program change ${number}`;
  return `${words} on channel ${channel}`;
}

/** @returns {string} a named id from one of the song's lists, or the id itself. */
function nameFrom(list, id) {
  const found = Array.isArray(list) ? list.find((item) => item && item.id === id) : null;
  return typeof found?.name === "string" && found.name !== "" ? found.name : String(id);
}

/** @returns {string} one clip's name, or its id. */
function clipNameFrom(snapshot, id) {
  const clip = snapshot?.clips?.[id];
  return typeof clip?.name === "string" && clip.name !== "" ? clip.name : String(id);
}

/** @returns {string} one bank's name, or its id. */
function bankNameFrom(snapshot, trackId, bankId) {
  const bank = snapshot?.banks?.[`${trackId}/${bankId}`];
  return typeof bank?.name === "string" && bank.name !== "" ? bank.name : String(bankId);
}

/**
 * One allow-listed action in plain words, with the objects it names read from
 * the song. The effect and pad-field names are the ones a person uses.
 * @param {object} action
 * @param {object} snapshot
 * @returns {string}
 */
export function actionWords(action, snapshot) {
  const kind = action && typeof action.kind === "string" ? action.kind : "";
  switch (kind) {
    case "scene.launch":
      return `launch scene "${nameFrom(snapshot?.scenes, action.scene_id)}"`;
    case "clip.launch":
      return `launch clip "${clipNameFrom(snapshot, action.clip_id)}"`;
    case "transport.play":
      return "play";
    case "transport.stop":
      return "stop";
    case "record.toggle":
      return "start or stop recording";
    case "stop_all":
      return "stop everything";
    case "pad.play":
      return `play pad ${(Number(action.index) || 0) + 1} of bank "${bankNameFrom(snapshot, action.track_id, action.bank_id)}" on "${nameFrom(snapshot?.tracks, action.track_id)}"`;
    case "pad.param":
      return `sweep ${String(action.param)} from ${Number(action.min)} to ${Number(action.max)} on the selected pad of "${nameFrom(snapshot?.tracks, action.track_id)}"`;
    case "track.macro":
      return `turn macro knob ${(Number(action.index) || 0) + 1} on "${nameFrom(snapshot?.tracks, action.track_id)}"`;
    case "fx.hold":
      return `hold the ${String(action.name).split("_").join(" ")} effect`;
    case "looper.cycle":
      return "advance the looper";
    case "looper.to_pad":
      return `capture the looper into pad ${(Number(action.index) || 0) + 1} of bank "${bankNameFrom(snapshot, action.track_id, action.bank_id)}" on "${nameFrom(snapshot?.tracks, action.track_id)}"`;
    case "mix.gain":
      return `ride the level of "${nameFrom(snapshot?.tracks, action.track_id)}"`;
    case "keys.play":
      return "play the keys";
    case "macro.set":
      return `turn macro knob ${(Number(action.index) || 0) + 1} on the selected track`;
    default:
      return kind || "nothing";
  }
}

/** @returns {boolean} whether two JSON values are the same value. */
function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The song's MIDI mappings, the way `studio_midi` reports them.
 *
 * A mapping is either LIVE (`proposed` false, and its `action` still the action
 * the operator accepted) or a PROPOSAL, which routes nothing until the operator
 * accepts it. `set_by` says who made it: `operator` or `agent`. The agent reads
 * this to know what the controller already does before it proposes anything.
 *
 * @param {object} snapshot - the hub's `snapshot()` shape
 * @returns {object[]} one row per mapping, in a fixed order
 */
export function midiList(snapshot) {
  const maps = snapshot?.midi_maps && typeof snapshot.midi_maps === "object" ? snapshot.midi_maps : {};
  const rows = [];
  for (const mapping of Object.values(maps)) {
    if (!mapping || typeof mapping !== "object") continue;
    const message = mapping.message && typeof mapping.message === "object" ? mapping.message : {};
    const action = mapping.action ?? null;
    const proposed = mapping.proposed === true;
    rows.push({
      id: mapping.id,
      device_name: String(mapping.device_name ?? ""),
      message: {
        type: message.type ?? null,
        channel: Number(message.channel) || 0,
        number: Number(message.number) || 0,
      },
      sends: messageWords(message),
      action,
      action_text: actionWords(action, snapshot),
      set_by: mapping.set_by === "agent" ? "agent" : "operator",
      proposed,
      // Live means both: not a proposal, and still the action the operator said
      // yes to (the router refuses anything else, so the listing says it too).
      accepted: !proposed && sameJson(action, mapping.accepted_action),
    });
  }
  rows.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return rows;
}

/**
 * The project a song belongs to, for a render (which is filed under it).
 *
 * The project comes from the hub and only from the hub: the song's snapshot
 * route answers with it (scoped to the caller there), and the song listing is
 * the fallback for a song the snapshot route does not name one for. The tool's
 * own arguments are never consulted — a render cannot be filed into a project
 * the caller asked for instead of the one the song is in.
 *
 * @param {object} hub - the hub client
 * @param {string} songId
 * @param {object} opened - the snapshot route's answer
 * @param {{kind: string, id: string, label: string}} author - the call's author,
 *   so the listing is scoped exactly like every other read
 * @returns {Promise<number>}
 */
async function projectIdFor(hub, songId, opened, author) {
  const direct = Number(opened?.project_id ?? opened?.snapshot?.project_id);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const songs = await hub.listSongs({}, author);
  if (isRefusal(songs)) throw new Error(refusalText(songs));
  const row = Array.isArray(songs) ? songs.find((song) => song && song.id === songId) : null;
  const projectId = Number(row?.project_id);
  if (!Number.isInteger(projectId)) {
    throw new Error(`There is no song "${songId}".`);
  }
  return projectId;
}

/**
 * Build the Studio MCP server.
 *
 * Everything external is injected: the hub client (the gateway's agent API),
 * the renderer (offline audio), the catalogue generator and the actor helpers.
 * Tests pass fakes for all four; `server/index.js` passes the real ones.
 *
 * @param {object} options
 * @param {object} options.hub - the hub client (`createHubClient`)
 * @param {{render: Function}} options.renderer - the offline renderer
 * @param {() => Promise<{modules: object}>} [options.catalogue] - the module catalogue generator
 * @param {NodeJS.ProcessEnv|object} [options.env] - the env the base actor comes from
 * @param {{actorFromEnv: Function, resolveCallActor: Function}|null} [options.actor]
 *   the app's actor helpers; without them every call is the generic MCP agent
 * @returns {McpServer} the server, ready to `connect()` to a transport
 */
export function createStudioServer({
  hub,
  renderer,
  catalogue = moduleCatalogue,
  env = process.env,
  actor = null,
} = {}) {
  if (!hub || typeof hub.command !== "function" || typeof hub.snapshot !== "function") {
    throw new TypeError("Studio MCP: a hub client is required");
  }
  const server = new McpServer({ name: SERVER_NAME, version: "0.1.0" });

  /**
   * Who this call is, forced to an agent.
   * @param {object} [extra] - the MCP request context (carries `_meta` / headers)
   * @returns {{kind: "agent", id: string, label: string}}
   */
  function authorFor(extra) {
    // A call that arrives carrying an actor the gateway forwarded (a peer
    // instance, an unknown caller) is never the operator: it gets an author the
    // agent API scopes to nothing. Only a call with no forwarded actor, from a
    // process with no bot identity, is the operator's own MCP session.
    const forwarded = extra && extra._meta && typeof extra._meta === "object" ? extra._meta["crow/actor"] : undefined;
    const forwardedBot = forwarded && typeof forwarded === "object" && forwarded.kind === "bot";
    if (!actor || typeof actor.actorFromEnv !== "function" || typeof actor.resolveCallActor !== "function") {
      return forwarded !== undefined && forwarded !== null && !forwardedBot ? { ...OTHER_AUTHOR } : { ...MCP_AUTHOR };
    }
    let resolved = null;
    try {
      resolved = actor.resolveCallActor(actor.actorFromEnv(env), extra);
    } catch {
      resolved = null;
    }
    if (resolved && resolved.kind === "bot") return toAgentAuthor(resolved);
    if (forwarded !== undefined && forwarded !== null) return { ...OTHER_AUTHOR };
    return toAgentAuthor(resolved);
  }

  // ---- one tool per registry command the agent may run --------------------

  for (const command of listCommands({ public: true })) {
    if (command.humanOnly) continue;
    const name = `studio_${command.id.replace(/\./g, "_")}`;
    server.registerTool(
      name,
      {
        title: command.title,
        description: (COMMAND_NOTES[command.id]
          ? `${command.title}. ${COMMAND_NOTES[command.id]}`
          : command.title) + ` ${UNDO_LINE}`,
        // The command's own fields plus the song they apply to; strict, so a
        // typo in an argument is refused instead of silently ignored.
        inputSchema: z
          .object({
            song_id: z.string().min(1).describe("the song to edit"),
            ...commandShape(command.schema),
          })
          .strict(),
      },
      async (args, extra) => {
        const { song_id: songId, ...commandArgs } = args;
        try {
          const result = await hub.command(songId, {
            cmd_id: randomUUID(),
            command: command.id,
            args: commandArgs,
            author: authorFor(extra),
          });
          if (result && result.ok === true) {
            const summary = result.entry && typeof result.entry.summary === "string"
              ? result.entry.summary
              : command.title;
            return textResult(summary);
          }
          return errorResult(refusalText(result));
        } catch (err) {
          return errorResult(errorText(err));
        }
      },
    );
  }

  // ---- songs -------------------------------------------------------------

  server.registerTool(
    "studio_list_songs",
    {
      title: "List songs",
      description: "List the Studio songs this caller can see, newest edit first. Pass project_id to narrow to one project.",
      inputSchema: {
        project_id: z.number().int().positive().optional().describe("only songs in this project"),
      },
    },
    async (args, extra) => {
      try {
        const filter = args.project_id == null ? {} : { project_id: args.project_id };
        const songs = await hub.listSongs(filter, authorFor(extra));
        if (isRefusal(songs)) return errorResult(refusalText(songs));
        return textResult(songs);
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  server.registerTool(
    "studio_create_song",
    {
      title: "Create a song",
      description:
        "Create an empty song in a project and return its id. The project ACL decides whether you may write there; a song starts with no tracks or scenes.",
      inputSchema: {
        project_id: z.number().int().positive().describe("the project the song lives in"),
        title: z.string().min(1).max(80).describe("the song title"),
      },
    },
    async (args, extra) => {
      try {
        const result = await hub.createSong({
          project_id: args.project_id,
          title: args.title,
          author: authorFor(extra),
        });
        if (result && result.ok === true) return textResult({ song_id: result.song_id });
        return errorResult(refusalText(result));
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  server.registerTool(
    "studio_session_summary",
    {
      title: "Summarise the session",
      description:
        "The song's tracks (with their device type and lock state), scenes and clips — no note data, one note count per clip. Call this first: it is how you see what the operator has. Clips are paged 50 per page; read one clip's notes with studio_get_clip.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song to summarise"),
        page: z.number().int().min(1).optional().describe("clip page, 50 clips each; default 1"),
      },
    },
    async (args, extra) => {
      try {
        const opened = await hub.snapshot(args.song_id, authorFor(extra));
        if (isRefusal(opened)) return errorResult(refusalText(opened));
        if (!opened || !opened.snapshot) throw new Error(`There is no song "${args.song_id}".`);
        return textResult(sessionSummary(args.song_id, opened.snapshot, args.page ?? 1));
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  server.registerTool(
    "studio_get_clip",
    {
      title: "Read one clip",
      description:
        "One clip in full, notes included: each note is {t, d, p, v} — start and length in beats, MIDI pitch 0-127, velocity 1-127.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song the clip is in"),
        clip_id: z.string().min(1).describe("the clip to read"),
      },
    },
    async (args, extra) => {
      try {
        const opened = await hub.snapshot(args.song_id, authorFor(extra));
        if (isRefusal(opened)) return errorResult(refusalText(opened));
        const clip = opened?.snapshot?.clips?.[args.clip_id] ?? null;
        if (!clip) return errorResult(`There is no clip "${args.clip_id}" in this song.`);
        return textResult(clip);
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  server.registerTool(
    "studio_takes",
    {
      title: "List recorded takes",
      description:
        "The song's recorded takes, newest first: id, clip, length in seconds, channels, sample rate, the tempo it was recorded at, whether its latency was compensated (with the offset in ms), who recorded it, when, whether it is discarded, and whether the clip's comp plays it. Read-only; pass clip_id to narrow it to one clip. You can keep or comp a take (studio_take_keep, studio_clip_set_comp) and re-offset it, but only the operator adds or discards one.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song whose takes to list"),
        clip_id: z.string().min(1).optional().describe("only takes of this clip"),
      },
    },
    async (args, extra) => {
      try {
        const opened = await hub.snapshot(args.song_id, authorFor(extra));
        if (isRefusal(opened)) return errorResult(refusalText(opened));
        if (!opened || !opened.snapshot) throw new Error(`There is no song "${args.song_id}".`);
        return textResult(takeList(opened.snapshot, args.clip_id ?? null));
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  // ---- the sampler -------------------------------------------------------

  server.registerTool(
    "studio_samples",
    {
      title: "List the song's samples and slices",
      description:
        "The song's samples: id, name, length in seconds, channels, sample rate, where each came from (import, record or resample), who brought it in, which pads play it, and its slices in order (id, start and end in frames and seconds). Read-only; pass sample_id to narrow it to one. You can chop a sample (studio_slice_set), put a slice or a whole sample on an empty pad (studio_pad_assign) and set that pad's fields (studio_pad_set), but only the operator brings a sound in — importing a file, recording into a pad or resampling — and no step of yours may drop the sound a pad plays.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song whose samples to list"),
        sample_id: z.string().min(1).optional().describe("only this sample"),
      },
    },
    async (args, extra) => {
      try {
        const opened = await hub.snapshot(args.song_id, authorFor(extra));
        if (isRefusal(opened)) return errorResult(refusalText(opened));
        if (!opened || !opened.snapshot) throw new Error(`There is no song "${args.song_id}".`);
        return textResult(sampleList(opened.snapshot, args.sample_id ?? null));
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  // ---- the controllers ----------------------------------------------------

  server.registerTool(
    "studio_midi",
    {
      title: "List the song's MIDI mappings",
      description:
        "Every MIDI mapping of the song: id, the controller's name, the message it answers (type, channel, number) and the same message in plain words, the action it runs as JSON and as a sentence naming the scene, clip, track, bank or pad, who set it (operator or agent), and whether it is still a proposal. A live mapping routes; a proposal does nothing until the operator accepts it. Read-only. Propose mappings with studio_midi_map or a whole device profile with studio_midi_propose_profile; only the operator accepts one, and once accepted it is theirs.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song whose mappings to list"),
      },
    },
    async (args, extra) => {
      try {
        const opened = await hub.snapshot(args.song_id, authorFor(extra));
        if (isRefusal(opened)) return errorResult(refusalText(opened));
        if (!opened || !opened.snapshot) throw new Error(`There is no song "${args.song_id}".`);
        return textResult(midiList(opened.snapshot));
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  // ---- history -----------------------------------------------------------

  server.registerTool(
    "studio_history",
    {
      title: "Read the shared history",
      description:
        "The song's history, newest first: one entry per applied step, with its author, summary, command and id. Pass an id to studio_undo to take that step back.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song whose history to read"),
        limit: z.number().int().min(1).max(HISTORY_LIMIT_MAX).optional().describe("how many entries, at most 50; default 50"),
      },
    },
    async (args, extra) => {
      try {
        const limit = args.limit ?? HISTORY_LIMIT_MAX;
        const entries = await hub.history(args.song_id, { limit }, authorFor(extra));
        if (isRefusal(entries)) return errorResult(refusalText(entries));
        return textResult(entries);
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  /**
   * Run one undo or redo and shape the answer for the agent.
   * @param {Function} run - `hub.undo` or `hub.redo`
   * @param {object} args - `{song_id, entry_id}`
   * @param {object} extra - the MCP request context
   * @param {string} label - "undo" or "redo", for the error fallback
   * @returns {Promise<object>} a tool result
   */
  async function historyStep(run, args, extra, label) {
    try {
      const result = await run(args.song_id, {
        cmd_id: randomUUID(),
        entry_id: args.entry_id,
        author: authorFor(extra),
      });
      if (result && result.ok === true) {
        const entry = result.entry ?? {};
        return textResult({
          ok: true,
          summary: typeof entry.summary === "string" ? entry.summary : "",
          entry_id: entry.id ?? null,
          command: entry.command ?? null,
          conflicts: Array.isArray(result.conflicts) ? result.conflicts : [],
        });
      }
      return errorResult(refusalText(result));
    } catch (err) {
      return errorResult(`${label} failed: ${errorText(err)}`);
    }
  }

  server.registerTool(
    "studio_undo",
    {
      title: "Undo a step",
      description:
        "Take back one history step by id. Only fields that still hold what that step wrote are restored: anything edited since is reported as a conflict and left alone, never clobbered.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song the step is in"),
        entry_id: z.string().min(1).describe("the history step to take back"),
      },
    },
    async (args, extra) => historyStep(hub.undo, args, extra, "Undo"),
  );

  server.registerTool(
    "studio_redo",
    {
      title: "Redo a step",
      description: "Put back a step that was undone, by that step's id. It meets the same conflicts rule as undo.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song the step is in"),
        entry_id: z.string().min(1).describe("the undone step to re-apply"),
      },
    },
    async (args, extra) => historyStep(hub.redo, args, extra, "Redo"),
  );

  // ---- listening and reference -------------------------------------------

  server.registerTool(
    "studio_render",
    {
      title: "Render the song to audio",
      description:
        "Render the song — one scene, one clip, or the arrangement (the timeline) from a bar — offline through the same engine the operator hears, store a 24-bit WAV and return its download url with the integrated loudness (LUFS) and the true peak (dB). The operator's render length limit applies; listen before and after a change and report the numbers.",
      inputSchema: {
        song_id: z.string().min(1).describe("the song to render"),
        scene_id: z.string().min(1).optional().describe("render this scene (every clip it holds)"),
        clip_id: z.string().min(1).optional().describe("render just this clip"),
        seconds: z.number().positive().describe("how many seconds to render"),
        mode: z.enum(["session", "arrangement"]).optional().describe("session (default: a scene or clip) or arrangement (the timeline)"),
        from_bar: z.number().int().min(0).max(998).optional().describe("arrangement only: the bar to start from (0 = the first bar)"),
      },
    },
    async (args, extra) => {
      try {
        const author = authorFor(extra);
        const opened = await hub.snapshot(args.song_id, author);
        if (isRefusal(opened)) return errorResult(refusalText(opened));
        if (!opened || !opened.snapshot) throw new Error(`There is no song "${args.song_id}".`);
        if (opened.read_only === true) {
          return errorResult("Crow's voice can listen to songs but not file renders; ask the project's bot. (read_only)");
        }
        const projectId = await projectIdFor(hub, args.song_id, opened, author);
        const out = await renderer.render({
          song_id: args.song_id,
          project_id: projectId,
          snapshot: opened.snapshot,
          scene_id: args.scene_id ?? null,
          clip_id: args.clip_id ?? null,
          seconds: args.seconds,
          mode: args.mode ?? "session",
          from_bar: args.from_bar ?? 0,
          author,
        });
        // A pad whose sample could not be loaded plays silence; the render
        // still happened, so the agent is told which sound it did not hear.
        const missing = Array.isArray(out.missing_samples) ? out.missing_samples : [];
        return textResult({
          url: out.url,
          lufs: out.lufs,
          true_peak_db: out.true_peak_db,
          seconds: out.seconds,
          ...(missing.length > 0 ? { missing_samples: missing } : {}),
        });
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  server.registerTool(
    "studio_module_types",
    {
      title: "SunVox module catalogue",
      description:
        "Every SunVox module type with its controllers (name, min, max, kind, default), generated from the engine the songs play through. A track device must be one of the generators. Output exists automatically at module 0 and is never created.",
      inputSchema: {},
    },
    async () => {
      try {
        const built = await catalogue();
        const modules = built && built.modules && typeof built.modules === "object" ? built.modules : {};
        const generators = Object.keys(modules).filter((type) => modules[type]?.kind === "generator");
        return textResult({
          generators: generators.length > 0 ? generators.sort() : [...GENERATOR_TYPES],
          modules,
        });
      } catch (err) {
        return errorResult(errorText(err));
      }
    },
  );

  return server;
}