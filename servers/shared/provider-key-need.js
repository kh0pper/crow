/**
 * "This provider needs an API key on THIS device" (security audit N1b-7,
 * operator ruling 2026-11-05).
 *
 * Provider rows sync between paired Crow instances; their `api_key` never does
 * (servers/sharing/instance-sync.js's LOCAL_ONLY_COLUMNS). So a provider this
 * operator added on one box arrives on the others with no key at all, and the
 * only honest thing to say about it is: it needs one here, once.
 *
 * Three questions live here, in one place:
 *
 *   1. providerNeedsKey(row) — does this row's type or preset need a key?
 *   2. providerDisplayName(row) — what to call it in the notice.
 *   3. noticeProviderKeyNeeded(db, id) — raise it ONCE per provider id, as an
 *      in-app notification linking to the providers settings; and
 *      clearProviderKeyNeededNotice(db, id) — quiet it again when the operator
 *      enters a key (providers-db.js's local write path calls this), which is
 *      also the only thing that re-arms it for a later loss of that key.
 *
 * Everything is per-DEVICE by construction: the checks read this instance's own
 * `providers` row, and neither the marker nor the notice is ever emitted to a
 * peer (notifications are not a synced table, and the local key is never
 * written by an inbound row).
 *
 * A KEYLESS provider is never nagged: a llama.cpp / Ollama on the LAN or the
 * tailnet reaches a loopback, private, CGNAT/tailnet or bare-host name, and
 * `provider_type` `openai-compat` (the generic OpenAI-compatible adapter a
 * local server also uses) or `ollama` is not a cloud SDK's type. A row on a
 * KNOWN cloud preset hostname always needs one; otherwise only the cloud SDK
 * types (openai, anthropic, google, openrouter) do.
 */
import { isIP } from "node:net";
import { hostnameOf } from "./provider-host.js";
import { isLocalNetworkIp } from "./ip-classify.js";
import { presetHostFor } from "./provider-recommendations.js";

/** The providers settings tab — where a key is entered. */
export const PROVIDERS_SETTINGS_URL = "/dashboard/settings?section=llm&tab=providers";

/**
 * provider_type values that name a hosted service with a mandatory key. NOT
 * `openai-compat` (a locally-run llama.cpp / vLLM / LM Studio serves the same
 * adapter and usually takes no key) and not `ollama` (none by default), and not
 * NULL (a bundle- or models.json-registered local row leaves it empty).
 */
const KEYED_TYPES = Object.freeze(["openai", "anthropic", "google", "openrouter"]);

/** Hostnames that can only resolve on this machine or the operator's own network. */
const LOCAL_NAME_SUFFIXES = Object.freeze([".local", ".localhost", ".internal", ".lan", ".home.arpa", ".localdomain"]);

/** A hostname that names this box or the LAN (never a public service). Pure. */
function isLocalName(host) {
  if (!host) return true;
  if (host === "localhost") return true;
  if (!host.includes(".")) return true; // a bare name is not publicly resolvable
  return LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Does this provider row need an API key to be usable? Pure; accepts either the
 * DB row (`base_url` / `provider_type`) or the parsed panel object
 * (`baseUrl` / `provider_type`, see provider-row.js).
 *
 * @param {object|null} row
 * @returns {boolean}
 */
export function providerNeedsKey(row) {
  if (!row) return false;
  const url = row.baseUrl ?? row.base_url;
  const host = hostnameOf(url);
  if (!host) return false; // no endpoint to dial: nothing to key
  // A local endpoint is keyless by definition (a llama.cpp on the LAN, a
  // tailnet box, a loopback sidecar).
  if (isIP(host) ? isLocalNetworkIp(host) : isLocalName(host)) return false;
  // A known cloud preset's host (any path/port/scheme): every one of them
  // requires a key, whatever the type column says.
  if (presetHostFor({ baseUrl: url }) !== null) return true;
  const type = String(row.provider_type ?? row.providerType ?? "").toLowerCase();
  return KEYED_TYPES.includes(type);
}

/**
 * The name the operator knows this provider by: the preset's label for a known
 * cloud host ("OpenAI"), else its description, else its id. Display text only —
 * the caller escapes/renders it.
 */
export function providerDisplayName(row) {
  const url = row?.baseUrl ?? row?.base_url;
  const presetId = presetHostFor({ baseUrl: url });
  if (presetId) {
    const label = PRESET_LABELS[presetId];
    if (label) return label;
  }
  const description = typeof row?.description === "string" ? row.description.trim() : "";
  if (description) return description.slice(0, 80);
  return String(row?.id ?? "(unknown provider)");
}

/** Preset id → English proper-noun label (a duplicate of provider-presets.js on purpose: no import cycle, and a label is not translatable text). */
const PRESET_LABELS = Object.freeze({
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google AI Studio",
  zai: "Z.AI",
  groq: "Groq",
  together: "Together AI",
  modelstudio: "Alibaba Model Studio (Qwen)",
  other: "Other (OpenAI-compatible)",
});

/** The notification `source` for one provider id — the dedupe key. */
export function providerKeyNoticeSource(id) {
  return `providers:key-needed:${String(id)}`;
}

/**
 * The notice metadata flag that says "the operator entered a key after this
 * notice was raised" — i.e. the question this notice asked has been ANSWERED, so
 * a later loss of that key may ring once more. Any notice without it (an open
 * one, one the operator read, one they dismissed) is still the answer to the
 * only question there is, and keeps the bell quiet (fix round 2: "needs a key"
 * used to ring again after a read or a dismissal).
 */
export const KEY_ENTERED_METADATA_KEY = "keyEnteredAfterNotice";

/** Was this notice's question already answered by the operator entering a key? Pure. */
function noticeWasAnswered(metadataJson) {
  if (!metadataJson) return false;
  try {
    return JSON.parse(metadataJson)?.[KEY_ENTERED_METADATA_KEY] === true;
  } catch {
    return false;
  }
}

async function readLang(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'language'",
      args: [],
    });
    return rows[0]?.value === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

/**
 * Raise the notice for provider `id`, if it is owed. ONCE per provider id: ANY
 * existing notice for that id — open, read or dismissed — means it was already
 * raised, so neither a re-delivered sync entry nor a dismissal can ring it
 * again. It re-arms only through `clearProviderKeyNeededNotice` (the operator
 * entered a key), so a later removal of that key may ring once more
 * (fix round 2).
 *
 * Only fires for a row this instance HOLDS, that is enabled, that needs a key
 * (providerNeedsKey) and that has none here.
 *
 * @param {object} db
 * @param {string} id provider id
 * @returns {Promise<"raised"|"already"|"has-key"|"keyless"|"disabled"|"no-row"|"no-id"|"filtered">}
 *   `filtered` = the operator switched this notification type off.
 */
export async function noticeProviderKeyNeeded(db, id) {
  if (typeof id !== "string" || id === "") return "no-id";
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  const row = rows[0];
  if (!row) return "no-row";
  if (Number(row.disabled)) return "disabled";
  if (!providerNeedsKey(row)) return "keyless";
  const key = typeof row.api_key === "string" ? row.api_key.trim() : "";
  if (key !== "") return "has-key";

  const source = providerKeyNoticeSource(id);
  // Any notice for this id counts, whatever the operator did with it: re-raising
  // on a read or a dismissal is exactly the nag fix round 2 removed. Only a
  // notice the operator ANSWERED with a key is spent (see clearProviderKeyNeededNotice).
  const { rows: prior } = await db.execute({
    sql: "SELECT id, metadata FROM notifications WHERE source = ?",
    args: [source],
  });
  if (prior.some((n) => !noticeWasAnswered(n.metadata))) return "already";

  // Loaded lazily: notifications.js and the i18n table are gateway-facing, and
  // this runs from the sync manager (which the stdio memory server also hosts).
  const [{ createNotification }, { t, fill }] = await Promise.all([
    import("./notifications.js"),
    import("../gateway/dashboard/shared/i18n.js"),
  ]);
  const lang = await readLang(db);
  const created = await createNotification(db, {
    type: "system",
    source,
    priority: "normal",
    title: fill(t("providers.needsKeyTitle", lang), { name: providerDisplayName(row) }),
    body: t("providers.needsKeyBody", lang),
    action_url: PROVIDERS_SETTINGS_URL,
  });
  return created ? "raised" : "filtered";
}

/**
 * Quiet the notice for provider `id` because a key is now set here. Called by
 * the local write path (providers-db.js) whenever it stores a non-empty key.
 * Marks it read rather than deleting it, so it stays in the bell's history, and
 * stamps it as ANSWERED (KEY_ENTERED_METADATA_KEY): if the operator later removes
 * that key, the next sync entry that leaves this row keyless may ring once more.
 * @returns {Promise<number>} rows touched
 */
export async function clearProviderKeyNeededNotice(db, id) {
  if (typeof id !== "string" || id === "") return 0;
  const r = await db.execute({
    sql: `UPDATE notifications SET is_read = 1, updated_at = datetime('now'), metadata = ?
          WHERE source = ?`,
    args: [JSON.stringify({ [KEY_ENTERED_METADATA_KEY]: true }), providerKeyNoticeSource(id)],
  });
  return Number(r.rowsAffected ?? 0);
}