/**
 * API-key cards — the manifest half that tells the operator where a third-party key
 * comes from, as a PURE module: manifest data in, plain data out. No fs, no db, no
 * express.
 *
 * A bundle whose secret env var is a key the operator buys or creates elsewhere (a
 * Tailscale auth key, a Hugging Face token) may explain it in the manifest:
 *
 *   "env_vars": [{ "name": "TS_AUTHKEY", "secret": true, "required": true,
 *                  "explain": { "en": "...what it is for...", "es": "..." },
 *                  "signup_url": "https://console.tailscale.com/admin/settings/keys",
 *                  "signup_label": { "en": "Create an auth key" } }]
 *
 * The Install form and Configure show `explain` (and the link) under the field; the
 * Extensions page adds a card for an INSTALLED add-on whose REQUIRED key is still
 * empty (pendingApiKeyCards, driven by the same needsConfigKeys map the page already
 * computes). Optional keys get only the field's help — never a card.
 *
 * `explain`/`signup_label` come from third-party or community manifests, so every one
 * of them is escaped where it is rendered (html.js, and the Extensions page's own
 * script sets textContent), and `signup_url` is re-checked here at render time even
 * though the manifest contract already refused a bad one: a link sitting next to a
 * field that asks for a secret is exactly the place a phishing URL would want to be.
 *
 * `localizedText` and `safeSignupUrl` are copied into the Extensions page's script by
 * Function.toString(), so both are plain ES5 with no outer references and no `${`.
 */
import { isDeniedApiKeyEnvName } from "../../bundle-apikey-save.js";

/**
 * A signup URL longer than this is not a link to a key page. The manifest contract
 * enforces the same number.
 */
export const SIGNUP_URL_MAX_LENGTH = 512;

/**
 * The link a manifest's `signup_url` may become, or null. https only, no user name or
 * password (`https://user:pw@host`), no whitespace or control characters, no `${`
 * (Compose interpolation), at most 512 characters, and it has to parse.
 *
 * @param {unknown} raw
 * @returns {{href: string, host: string}|null} `host` is what the card shows next to
 *   the button, so the operator sees where the link goes before pressing it.
 */
export function safeSignupUrl(raw) {
  if (typeof raw !== "string") return null;
  // 512 is repeated as a literal (not the exported constant) so this function's own
  // source can be copied into the Extensions page's script.
  if (raw === "" || raw.length > 512) return null;
  if (raw !== raw.trim()) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  // The two characters are assembled rather than written: this function's source is
  // embedded in a template literal, where a bare interpolation would be read as one.
  if (raw.indexOf("$" + "{") !== -1) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.host) return null;
  return { href: raw, host: parsed.host };
}

/**
 * A manifest text field (`explain`, `signup_label`) in `lang`, falling back to `en`
 * and then to null: a string, or `{ en, es }` like `pattern_hint`.
 *
 * @param {unknown} v
 * @param {string} [lang]
 * @returns {string|null}
 */
export function localizedText(v, lang) {
  const l = typeof lang === "string" && lang ? lang : "en";
  let picked = null;
  if (typeof v === "string") picked = v;
  else if (v && typeof v === "object") picked = typeof v[l] === "string" && v[l].trim() !== "" ? v[l] : v.en;
  return typeof picked === "string" && picked.trim() !== "" ? picked : null;
}

/**
 * PURE: the cards to show, one per installed add-on whose REQUIRED, typed (not
 * generated) secret env var is still empty AND whose manifest explains it.
 *
 * `manifests` must be the REVIEWED repo manifests (bundles-config `getManifest`): the
 * installed copy can be rewritten from inside the bundle's container. `needsConfig` is
 * the page's own map (id → still-missing key NAMES), so a card can only appear for a
 * key the rest of the page already calls missing, and it disappears by itself once the
 * key is set.
 *
 * Skipped: a satellite-hosted install (its own box's config), a bundle with no
 * manifest, an optional key, a generated key, and an env name that controls how
 * programs run (isDeniedApiKeyEnvName).
 *
 * @param {object} o
 * @param {Record<string, {mode?: string}>} o.installed
 * @param {Record<string, object|null>} o.manifests
 * @param {Record<string, string[]>} [o.needsConfig]
 * @returns {Array<{id:string,name:string,envKey:string,explain:unknown,signup_url:string|null,signup_label:unknown}>}
 */
export function pendingApiKeyCards({ installed = {}, manifests = {}, needsConfig = {} } = {}) {
  const out = [];
  for (const id of Object.keys(installed || {})) {
    const entry = installed[id] || {};
    if (entry.mode === "satellite") continue;
    const manifest = manifests ? manifests[id] : null;
    if (!manifest || typeof manifest !== "object") continue;
    const missing = needsConfig && Array.isArray(needsConfig[id]) ? needsConfig[id] : [];
    if (missing.length === 0) continue;
    for (const ev of Array.isArray(manifest.env_vars) ? manifest.env_vars : []) {
      if (!ev || typeof ev.name !== "string" || ev.name === "") continue;
      if (ev.required !== true || ev.secret !== true || ev.generate) continue;
      if (!missing.includes(ev.name)) continue;
      if (isDeniedApiKeyEnvName(ev.name)) continue;
      if (!localizedText(ev.explain)) continue;
      out.push({
        id,
        name: typeof manifest.name === "string" && manifest.name ? manifest.name : id,
        envKey: ev.name,
        explain: ev.explain,
        signup_url: typeof ev.signup_url === "string" ? ev.signup_url : null,
        signup_label: ev.signup_label === undefined ? null : ev.signup_label,
      });
    }
  }
  return out;
}