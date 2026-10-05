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

export function displayPromptSuffix(caps) {
  return [
    "You are speaking through a shared home display to whoever is in the room. Reply in one to three short spoken sentences of plain prose: no markdown, no lists, no emoji.",
    "Use a display tool only when someone asks to see, time, follow, open or play something; never for ordinary questions, and never to repeat what you say aloud.",
    capsSentence(caps),
    "A message may begin with lines in square brackets — [Now] is this display's local date and time, [Display] its open windows. Use them to answer; never read them out.",
  ].join("\n");
}

const count = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : "");
/**
 * Live display state for THIS turn's user message. countsOnly: kinds and counts with no titles —
 * used on a turn that asks for new content, so there is no open card's title to copy.
 * media: an optional "Playing: …" sentence (the media session adds it).
 */
export function displayTurnContext(store, deviceId, { countsOnly = false, media = "" } = {}) {
  let line = store.describe(deviceId);
  if (countsOnly) {
    const n = { content: 0, recipe: 0, timer: 0 };
    for (const w of store.list(deviceId)) if (w.kind in n) n[w.kind]++;
    const parts = [count(n.content, "card", "cards"), count(n.recipe, "recipe", "recipes"), count(n.timer, "timer", "timers")].filter(Boolean);
    line = parts.length ? `Open windows: ${parts.join(", ")}.` : "Open windows: none.";
  }
  return `[Display] ${line}${media ? ` ${media}` : ""}`;
}
