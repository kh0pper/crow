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
  let addons = { at: -Infinity, byTool: new Map(), lists: new Map() };
  function index() {
    if (now() - addons.at < ttlMs) return addons;
    const byTool = new Map(), lists = new Map();
    try {
      for (const [id, entry] of connected()) for (const t of entry?.tools || []) if (t?.name && !byTool.has(t.name)) byTool.set(t.name, `addon:${id}`);
      for (const ext of listExtensions()) {
        const fam = `addon:${ext.id}`;
        for (const t of ext?.capabilities?.tools || []) if (t?.name && !byTool.has(t.name)) byTool.set(t.name, fam);
        const p = normalizeIntentLists(ext?.capabilities?.voice_intent);
        if (p.length) lists.set(fam, p);
      }
    } catch { /* an unreadable add-on index offers nothing; it is read again after ttlMs */ }
    addons = { at: now(), byTool, lists };
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
  };
}
