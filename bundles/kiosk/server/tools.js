/**
 * The display tools offered to the model: four small tools, at most three flat arguments each,
 * every enumeration built on the server for this session, so the model cannot name something
 * this display lacks. A tool with nothing to offer is left out. Descriptions are one line with
 * at most one concrete example (a small model copies placeholders onto the screen). The examples
 * are deliberately NOT taken from the evaluation set in scripts/kiosk-eval.
 */
export const SHOW_KINDS = Object.freeze(["text", "list", "steps", "timer"]);
export const WM_VERBS = Object.freeze(["close", "close_all", "next_step", "previous_step", "read_step"]);
export const MEDIA_VERBS = Object.freeze(["pause", "resume", "stop", "next", "previous", "volume_up", "volume_down", "mute", "unmute"]);
export const PLAY_SOURCES = Object.freeze(["music", "radio", "news"]);
/** Launcher items in crow_open.app, before "launcher" itself (24 in all). */
export const MAX_APPS = 23;
/** Every outcome a tool may return. The voice turn logs name:outcome per call, never arguments. */
export const OUTCOMES = Object.freeze({
  crow_play: Object.freeze(["playing", "choices", "audio_instead", "handed_off", "not_found", "unavailable"]),
  crow_open: Object.freeze(["opened", "focused", "handed_off", "needs_login", "host_offline", "not_shared", "unavailable"]),
  crow_show: Object.freeze(["shown", "updated", "invalid"]),
  crow_wm: Object.freeze(["done", "nothing_open", "nothing_playing", "invalid", "unavailable"]),
});
/** The corrective round's note per must-run tool (model-facing, English; rides on the last message, never saved). */
export const MUST_NOTES = Object.freeze({
  crow_show: "[Display] Nothing has been put on the screen in this turn yet. Call crow_show now with the real content, under a title of its own. If you cannot, tell the user plainly that you could not show it; never say that it is on the screen.",
  crow_play: "[Display] Nothing is playing yet. Call crow_play now with what the person asked to hear. If you cannot, tell the user plainly that you could not play it; never say that it is playing.",
  crow_wm: "[Display] The playback has not been changed yet. Call crow_wm now with the playback verb the person asked for. If you cannot, tell the user plainly that you could not change it; never say that it changed.",
  crow_open: "[Display] Nothing has been opened yet. Call crow_open now with the app from its list (launcher if it is not there). If you cannot, tell the user plainly that you could not open it; never say that it is open.",
});
const ITEM_ID = /^[a-z0-9][a-z0-9_:-]{0,39}$/;
const oneLine = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const showKinds = (windows) => SHOW_KINDS.filter((k) => (k === "timer" ? windows.includes("timer") : k === "steps" ? windows.includes("recipe") : windows.includes("content")));
const BODY_HELP = {
  text: "text: paragraphs separated by a blank line.",
  list: "list: one item per line.",
  steps: "steps: ingredients one per line, then a line with three dashes, then the steps one per line.",
  timer: "timer: how long, like 12 minutes.",
};

/** windows: K1 window kinds this display draws; sources: play sources that exist; items: [{ id, title }]; verbs: crow_wm verbs that can act. */
export function buildToolDefinitions({ windows = [], sources = [], items = [], verbs = [] } = {}) {
  const defs = [];
  const src = PLAY_SOURCES.filter((s) => sources.includes(s));
  if (src.length) defs.push({
    name: "crow_play",
    description: "Play music, radio or the news on this display. Example: what \"ocean sounds\", source \"auto\".",
    inputSchema: { type: "object", properties: {
      what: { type: "string", minLength: 1, maxLength: 120, description: "What to play: a name or a few search words. Never a web address." },
      source: { type: "string", enum: ["auto", ...src], description: "Where to look. Use auto unless the person named one." },
    }, required: ["what"] },
  });
  const apps = (Array.isArray(items) ? items : []).filter((i) => i && ITEM_ID.test(String(i.id)) && i.id !== "launcher").slice(0, MAX_APPS);
  if (apps.length) defs.push({
    name: "crow_open",
    description: "Open an app, page or view on this display. Pick app from its list; if what was asked for is not in the list, use launcher.",
    inputSchema: { type: "object", properties: {
      app: { type: "string", enum: [...apps.map((i) => i.id), "launcher"], description: `One of: ${apps.map((i) => `${i.id} = ${oneLine(i.title, 40)}`).join("; ")}; launcher = anything else.` },
    }, required: ["app"] },
  });
  const kinds = showKinds(windows);
  if (kinds.length) defs.push({
    name: "crow_show",
    description: "Put a card on the screen, only when someone asks to see, time or follow something. Example: kind \"list\", title \"Chores\", body \"sweep\\nmop\\ndust\".",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: kinds },
      title: { type: "string", minLength: 1, maxLength: 80, description: "A short title of its own for this card. For a timer, its name." },
      body: { type: "string", maxLength: 4000, description: kinds.map((k) => BODY_HELP[k]).join(" ") },
    }, required: ["kind", "title", "body"] },
  });
  const steps = windows.includes("recipe");
  const dos = [...WM_VERBS, ...MEDIA_VERBS].filter((v) => verbs.includes(v) && (steps || !v.endsWith("_step")));
  if (dos.length) defs.push({
    name: "crow_wm",
    description: "Manage what is already on this display: close windows, move through steps, control playback. Example: do \"close\", name \"weather\".",
    inputSchema: { type: "object", properties: {
      do: { type: "string", enum: dos },
      name: { type: "string", maxLength: 40, description: "Which window, by its name or kind. Leave out for the one in front." },
    }, required: ["do"] },
  });
  return defs;
}
