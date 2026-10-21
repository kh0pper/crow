/**
 * Tool families and their intent tests. A family is one core category (core:<category>) or one
 * add-on (addon:<id>); "addons" is the crow_tools wrapper. A family's intent test is a PHRASE
 * LIST, in English and Spanish — plain words compared word by word, never a pattern built from
 * data: the lists come from tool-manifests.js and from bundle manifests (capabilities.voice_intent),
 * and a manifest-supplied pattern would be a way to make every voice turn slow.
 *
 * A family is offered to the quick voice model only on a turn whose plain transcript contains one
 * of its phrases (the voice turn adds: or the previous turn used it). A family with no list is
 * never offered to the quick model.
 */
export const INTENT_MAX_CHARS = 400;
export const MAX_PHRASES = 40;
export const MAX_PHRASE_WORDS = 4;
export const MAX_PHRASE_CHARS = 40;

/** Capped BEFORE anything else reads it; lower case; accents and apostrophes dropped; everything but letters and digits is a space. */
export function phraseWords(text) {
  if (typeof text !== "string") return [];
  const s = text.slice(0, INTENT_MAX_CHARS).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9 ]+/g, " ").trim();
  return s ? s.split(/ +/) : [];
}

/** { en: [...], es: [...] } → [[word, …], …]. Anything that is not a short plain phrase is dropped. */
export function normalizeIntentLists(raw) {
  const out = [];
  for (const lang of ["en", "es"]) {
    const list = Array.isArray(raw?.[lang]) ? raw[lang].slice(0, MAX_PHRASES) : [];
    for (const p of list) {
      if (typeof p !== "string" || p.length > MAX_PHRASE_CHARS) continue;
      const w = phraseWords(p);
      if (w.length >= 1 && w.length <= MAX_PHRASE_WORDS) out.push(w);
    }
  }
  return out;
}

/** Does any phrase appear in `words` as whole words, in order, adjacent? At most words × phrases × 4 comparisons. */
export function listMatches(words, phrases) {
  for (const p of phrases) {
    for (let i = 0; i + p.length <= words.length; i++) {
      let k = 0;
      while (k < p.length && words[i + k] === p[k]) k++;
      if (k === p.length) return true;
    }
  }
  return false;
}

const CATEGORY = /^crow_([a-z_]{1,40})$/;

/**
 * manifests: TOOL_MANIFESTS (a category may carry voiceIntent). listExtensions(): installed add-ons
 * as [{ id, capabilities }]. connected(): Map<id, { tools: [{ name }] }> of connected add-on servers.
 */
export function createToolFamilies({ manifests = {}, listExtensions = () => [], connected = () => new Map(), now = Date.now, ttlMs = 60_000 } = {}) {
  const core = new Map();
  for (const [category, m] of Object.entries(manifests)) {
    const p = normalizeIntentLists(m?.voiceIntent);
    if (p.length) core.set(`core:${category}`, p);
  }
  let addons = { at: -Infinity, byTool: new Map(), lists: new Map(), names: new Map() };
  function index() {
    if (now() - addons.at < ttlMs) return addons;
    const byTool = new Map(), lists = new Map(), names = new Map();
    try {
      for (const [id, entry] of connected()) for (const t of entry?.tools || []) if (t?.name && !byTool.has(t.name)) byTool.set(t.name, `addon:${id}`);
      for (const ext of listExtensions()) {
        const fam = `addon:${ext.id}`;
        for (const t of ext?.capabilities?.tools || []) if (t?.name && !byTool.has(t.name)) byTool.set(t.name, fam);
        const p = normalizeIntentLists(ext?.capabilities?.voice_intent);
        if (p.length) lists.set(fam, p);
        if (typeof ext?.name === "string" && ext.name && ext.name !== ext.id) names.set(fam, ext.name.slice(0, 60));
      }
    } catch { /* an unreadable add-on index offers nothing; it is read again after ttlMs */ }
    addons = { at: now(), byTool, lists, names };
    return addons;
  }
  return {
    familyOf(name) {
      const n = String(name ?? "");
      if (n === "crow_tools") return "addons";
      const m = CATEGORY.exec(n);
      if (m && Object.hasOwn(manifests, m[1])) return `core:${m[1]}`;
      return index().byTool.get(n) || null;
    },
    hasList: (family) => core.has(family) || index().lists.has(family),
    wants(family, transcript) {
      const p = core.get(family) || index().lists.get(family);
      return !!p && listMatches(phraseWords(transcript), p);
    },
    /** A core family's action names (its manifest's tools); [] for anything else. */
    categoryTools(family) {
      const m = /^core:(.+)$/.exec(String(family ?? ""));
      return m && Object.hasOwn(manifests, m[1]) ? Object.keys(manifests[m[1]]?.tools || {}) : [];
    },
    /** An add-on family's manifest name (data: callers escape it), or null. */
    nameOf: (family) => index().names.get(family) || null,
  };
}

const NO_FAMILIES = new Set();
/**
 * The voice turn's family classification (runVoiceTurn calls it once per turn; the Bot Builder's
 * "By voice on displays" line calls it with a fixed request, so both read one decision). Pure.
 * baseTools: the turn's tools after its own gates. fam: createToolFamilies() or null (families off:
 * every tool goes to the quick model). prevFam: the families the previous turn used.
 * isExtraTool / isMemoryTool: those tools keep their own gates and are never a family tool.
 * → { famOf, famWanted, quickTools, famIds, unlisted, wrapperWithheld, actionWithheld(actionAsked, displayBacks, counts?) }
 */
export function classifyTools({ baseTools, fam, transcript, prevFam = NO_FAMILIES, isExtraTool = () => false, isMemoryTool = () => false }) {
  const famWanted = (id) => prevFam.has(id) || fam.wants(id, transcript);
  // undefined = not a family tool (display tools and memory keep their own gates); "other" = a tool no family claims.
  const famOf = (t) => (fam && !isExtraTool(t.name) && !isMemoryTool(t.name) ? (fam.familyOf(t.name) || "other") : undefined);
  const quickTools = !fam ? baseTools : baseTools.filter((t) => {
    const id = famOf(t);
    if (id === undefined) return true;
    if (id === "addons") return baseTools.some((x) => { const f = famOf(x); return typeof f === "string" && f.startsWith("addon:") && famWanted(f); });
    return id !== "other" && famWanted(id);
  });
  // Families with no intent list never reach the quick model; they keep the router's view of
  // "this assistant has tools", so a turn the router escalates can still use them.
  const famIds = !fam ? [] : [...new Set(baseTools.map(famOf).filter((id) => typeof id === "string" && id !== "addons"))];
  const unlisted = famIds.filter((id) => !fam.hasList(id));
  const wrapperWithheld = !!fam && baseTools.some((t) => famOf(t) === "addons") && !quickTools.some((t) => famOf(t) === "addons");
  const isFamTool = (t) => famOf(t) !== undefined;
  // Escalate an action request when the quick model got no family tool but the assistant has some — and no
  // display tool is on offer (a display command such as "add two minutes" stays on the quick model).
  // counts(tool) (optional): whether a withheld tool counts toward this (the voice turn leaves out Crow's own tools
  // when the request names no routine object and follows no own-tool turn).
  const actionWithheld = (actionAsked, displayBacks, counts = () => true) => !!fam && actionAsked && !displayBacks && !quickTools.some(isFamTool) && baseTools.some((t) => isFamTool(t) && counts(t));
  return { famOf, famWanted, quickTools, famIds, unlisted, wrapperWithheld, isFamTool, actionWithheld };
}
