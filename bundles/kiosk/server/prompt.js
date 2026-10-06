/**
 * What the model is told about the display. The suffix is static for a capability set (the
 * system message stays byte-stable, so the prefix cache holds); live state rides on the turn's
 * own user message. The legacy kioskPromptSuffix / kioskTurnContext in wm.js are unchanged.
 */
const DEFAULT_CAPS = Object.freeze({ screen: { w: 800, h: 480, touch: true }, audio: { out: true }, video: "none" });

/** One sentence from the capability flags. The model is never asked to reason about hardware beyond it. */
export function capsSentence(caps) {
  const c = caps && typeof caps === "object" ? caps : DEFAULT_CAPS;
  const w = Number(c.screen?.w) || 0;
  const screen = c.screen?.touch ? (w > 0 && w < 1024 ? "a small touch screen" : "a touch screen") : "a screen";
  return `This display has ${screen}${c.audio?.out ? " and a speaker" : ""}. It ${c.video && c.video !== "none" ? "can" : "cannot"} play video.`;
}

/** "a, b or c". */
const orList = (w) => (w.length > 1 ? `${w.slice(0, -1).join(", ")} or ${w.at(-1)}` : w[0] || "");
/**
 * tools: the names of the display tools this display really has (createDisplayTools). The sentence names
 * only what they can do: a display with no crow_play is never told it can play (it would claim to).
 * Omitted → the tools every display has (crow_show, crow_wm).
 */
export function displayPromptSuffix(caps, tools = ["crow_show", "crow_wm"]) {
  const has = (n) => Array.isArray(tools) && tools.includes(n);
  const acts = [...(has("crow_show") ? ["see", "time", "follow"] : []), ...(has("crow_open") ? ["open"] : []), ...(has("crow_play") ? ["play"] : [])];
  return [
    "You are speaking through a shared home display to whoever is in the room. Reply in one to three short spoken sentences of plain prose: no markdown, no lists, no emoji.",
    `Use a display tool only when someone asks to ${orList(acts.length ? acts : ["see"])} something; never for ordinary questions, and never to repeat what you say aloud.`,
    capsSentence(caps),
    "A message may begin with lines in square brackets — [Now] is this display's local date and time, [Display] its open windows. Use them to answer; never read them out.",
  ].join("\n");
}

const count = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : "");
/**
 * Live display state for THIS turn's user message. countsOnly: kinds and counts with no titles —
 * used on a turn that asks for new content, so there is no open card's title to copy.
 * media: an optional "Playing: …" sentence (the media session adds it).
 * card: on a turn that asks to CHANGE the open card, its title and what it says now (the model has to
 * send the whole new body; it cannot add to words it was never shown).
 */
export const CARD_TEXT_MAX = 400;
function cardText(w) {
  const parts = [];
  for (const b of Array.isArray(w?.blocks) ? w.blocks : []) {
    if (b?.type === "list" && Array.isArray(b.items)) parts.push(b.items.join("; "));
    else if (b?.type !== "heading" && typeof b?.text === "string") parts.push(b.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, CARD_TEXT_MAX);
}
export function displayTurnContext(store, deviceId, { countsOnly = false, media = "", card = false } = {}) {
  let line = store.describe(deviceId);
  if (countsOnly) {
    const n = { content: 0, recipe: 0, timer: 0 };
    for (const w of store.list(deviceId)) if (w.kind in n) n[w.kind]++;
    const parts = [count(n.content, "card", "cards"), count(n.recipe, "recipe", "recipes"), count(n.timer, "timer", "timers")].filter(Boolean);
    line = parts.length ? `Open windows: ${parts.join(", ")}.` : "Open windows: none.";
  }
  const open = card ? store.list(deviceId).filter((w) => w.kind === "content").at(-1) : null;
  const now = open ? ` The card "${open.title}" now says: ${cardText(open) || "nothing"}. To change it, call crow_show with that same title and the whole new body.` : "";
  return `[Display] ${line}${media ? ` ${media}` : ""}${now}`;
}
