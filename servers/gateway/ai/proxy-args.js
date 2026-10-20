/**
 * The proxy tools and the arguments they really run with, in one place: the tool executor runs
 * them through these helpers and the voice confirm gate (voice/turn-helpers.js) describes and
 * checks a call with the same ones, so the two can never drift apart. Pure, no imports.
 *
 *   category proxy  crow_(memory|projects|blog|sharing|storage|media) { action, params }
 *                   → the tool runs with args.params alone (every other top-level field is dropped)
 *   crow_tools      the add-on proxy { action, params } → normalizeExternalParams (below); its remote
 *                   route (tool-executor executeTool) runs args.params as given, with no unwrap or fallback
 */
export const CATEGORY_PROXY_RE = /^crow_(memory|projects|blog|sharing|storage|media)$/;
export const ADDON_PROXY = "crow_tools";

/** A call through a proxy (a category proxy or crow_tools) whose effective tool came from `action`. */
export function isProxyCall(tc) {
  const name = String(tc?.name || "");
  return (CATEGORY_PROXY_RE.test(name) || name === ADDON_PROXY) && typeof tc?.arguments?.action === "string" && tc.arguments.action !== "";
}

/**
 * crow_tools' forgiving parameter handling (the local handleExternalTool path), accepting the formats
 * weaker models produce:
 *   { action, params: { key: val } }            correct format
 *   { action, params: { arguments: { ... } } }  nested arguments (unwrapped when params has at most 2 keys)
 *   { action, key: val, ... }                   flat params (used only when params is empty)
 * → { params, flat }: flat is true when the flat top-level fields are what runs.
 */
export function normalizeExternalParams(args) {
  let params = args?.params;
  if (!params || typeof params !== "object") params = {};
  if (params.arguments && typeof params.arguments === "object" && Object.keys(params).length <= 2) params = params.arguments;
  if (Object.keys(params).length === 0) {
    const flat = { ...(args || {}) };
    delete flat.action;
    delete flat.params;
    if (Object.keys(flat).length > 0) return { params: flat, flat: true };
  }
  return { params, flat: false };
}

/** The arguments object a call really runs with (locally): params for a proxy (normalized for crow_tools), else the args. */
export function executedProxyArgs(tc) {
  const name = String(tc?.name || "");
  const args = tc?.arguments || {};
  if (name === ADDON_PROXY && isProxyCall(tc)) return normalizeExternalParams(args).params;
  if (CATEGORY_PROXY_RE.test(name) && isProxyCall(tc)) return args.params || {};
  return args;
}
