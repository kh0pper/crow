/**
 * Dashboard text size — ONE per-device preference for the whole dashboard
 * (A11Y-TEXTSIZE, 2026-10-03). Kevin, 2026-10-02: "Text size should apply to
 * chat, though maybe we should consider a system wide text size adjuster for
 * accessibility." #407 had shipped a Perch-only A−/A/A+; this module is now
 * the single source of truth and Perch's control is a consumer of it.
 *
 * How it works
 *   - Stored per DEVICE in localStorage under TEXT_SIZE_KEY (a phone and a
 *     desktop want different sizes; same pattern as crow-sidebar-collapsed).
 *     Theme is OS-driven and has no stored state, so there was no theme
 *     pattern to follow beyond that.
 *   - textSizeHeadScript() runs as the FIRST thing in <head>, before any CSS
 *     is parsed and long before first paint, and writes
 *     <html data-text-size="small|default|large|xlarge">. No flash.
 *   - textSizeCss() maps that attribute to --crow-text-scale on :root and sets
 *     html{font-size:calc(100% * var(--crow-text-scale))}. 100% is the
 *     BROWSER's own font-size setting, so a user who already raised it in the
 *     browser gets their size times ours, and browser zoom is untouched — we
 *     never fight either. The dashboard is rem-based, so it all follows.
 *   - Perch's chat tab uses px sizes multiplied by --pts; css.js points --pts
 *     at the same --crow-text-scale, and perch-hub/client.js's A−/A/A+ calls
 *     the SAME runtime (window.crowTextSize) to step through these four sizes.
 *   - Turbo Drive replaces <body> only; <html> and window survive a visit, so
 *     the attribute and the runtime persist. The head script is byte-identical
 *     on every page, so Turbo never re-runs it.
 *   - Perch's old per-chat key (LEGACY_PERCH_TEXT_KEY, five steps) migrates
 *     once: read when the new key is absent, mapped onto the four sizes,
 *     written to the new key, and removed.
 */

export const TEXT_SIZE_KEY = "crow-text-size";
export const LEGACY_PERCH_TEXT_KEY = "crow.perch.textSize";
export const TEXT_SIZE_DEFAULT = "default";

/** The four steps, smallest first. labelKey is the i18n key of the step name. */
export const TEXT_SIZES = [
  { id: "small", scale: 0.875, labelKey: "settings.textSize.small" },
  { id: "default", scale: 1, labelKey: "settings.textSize.default" },
  { id: "large", scale: 1.2, labelKey: "settings.textSize.large" },
  { id: "xlarge", scale: 1.4, labelKey: "settings.textSize.xlarge" },
];

/** #407's five Perch steps were [0.875, 1, 1.125, 1.25, 1.4]; each old step
 *  index maps to the nearest new size. */
export const LEGACY_PERCH_STEP_MAP = ["small", "default", "large", "large", "xlarge"];

/** CSS: the attribute → scale map, and the rem root that the dashboard
 *  inherits. :root carries the default so a page without the attribute (or
 *  with scripts blocked) renders at exactly the browser's own size. */
export function textSizeCss() {
  const rules = TEXT_SIZES.map((s) => `:root[data-text-size="${s.id}"]{--crow-text-scale:${s.scale}}`).join("\n  ");
  return `:root{--crow-text-scale:1}
  ${rules}
  html{font-size:calc(100% * var(--crow-text-scale,1))}`;
}

/** The client runtime, as ES5 source. Evaluates to the API object
 *  { get, set, apply, ids, scale, key }. Shared verbatim by the head script
 *  and by Perch's client (which prefers window.crowTextSize when the head
 *  script already made one), so the two can never drift. Plain string — no
 *  backticks — so it can be interpolated into a client template literal.
 *  Storage can be blocked outright (the ACCESSOR throws), so every touch is
 *  in try/catch and the value is also kept in memory for this page view. */
export function textSizeRuntimeJs() {
  const ids = JSON.stringify(TEXT_SIZES.map((s) => s.id));
  const scales = JSON.stringify(Object.fromEntries(TEXT_SIZES.map((s) => [s.id, s.scale])));
  const legacy = JSON.stringify(LEGACY_PERCH_STEP_MAP);
  return "(function(){" +
    "var KEY=" + JSON.stringify(TEXT_SIZE_KEY) + ",OLD=" + JSON.stringify(LEGACY_PERCH_TEXT_KEY) +
    ",DEF=" + JSON.stringify(TEXT_SIZE_DEFAULT) + ",IDS=" + ids + ",SCALE=" + scales + ",MAP=" + legacy + ",mem=null;" +
    "function store(){try{return window.localStorage||null;}catch(e){return null;}}" +
    "function ok(v){return IDS.indexOf(v)>=0;}" +
    "function read(){var s=store();if(!s)return null;try{" +
      "var v=s.getItem(KEY),o=s.getItem(OLD);" +
      "if(o!=null){" +
        "var n=parseInt(o,10),id=(String(n)===String(o)&&n>=0&&n<MAP.length)?MAP[n]:null;" +
        "if(id&&!ok(v)){v=id;try{s.setItem(KEY,id);}catch(e){}}" +
        "try{s.removeItem(OLD);}catch(e){}}" +
      "if(ok(v))return v;" +
    "}catch(e){}return null;}" +
    "function get(){if(mem)return mem;var v=read();mem=v||DEF;return mem;}" +
    "function apply(id){var d=document.documentElement;if(d&&d.setAttribute)d.setAttribute('data-text-size',id||get());}" +
    "function set(id){if(!ok(id))return false;mem=id;var s=store();if(s){try{s.setItem(KEY,id);}catch(e){}}apply(id);" +
      "try{window.dispatchEvent(new CustomEvent('crow:text-size',{detail:{size:id}}));}catch(e){}return true;}" +
    "function sync(){mem=null;apply(get());try{window.dispatchEvent(new CustomEvent('crow:text-size',{detail:{size:mem}}));}catch(e){}}" +
    "return {get:get,set:set,apply:apply,sync:sync,ids:IDS.slice(),scale:function(id){return SCALE[id||get()];},key:KEY};" +
  "})()";
}

/** The pre-paint <head> script. Must be emitted BEFORE the stylesheet so the
 *  attribute exists when the first style is computed. Also follows a change
 *  made in another tab (the storage event). */
export function textSizeHeadScript() {
  return "<script>(function(){try{" +
    "if(!window.crowTextSize){window.crowTextSize=" + textSizeRuntimeJs() + ";" +
    "window.addEventListener('storage',function(e){if(!e||e.key===null||e.key===window.crowTextSize.key)window.crowTextSize.sync();});}" +
    "window.crowTextSize.apply();" +
  "}catch(e){}})();</script>";
}
