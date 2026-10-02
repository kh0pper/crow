/**
 * perch-model-catalog — the SESSION-FREE model list.
 *
 * `perch-interactive.js`'s `options()` asks the live pi child what models it
 * has (`get_available_models`). That is authoritative for a running session
 * and useless for every other case: a hibernating session has no child (the
 * engine closes one on idle by design, and `adoptRow` brings a restart-
 * orphaned row back hibernating too), and the LAUNCHER has no session at all
 * — it is choosing a model for one that does not exist yet.
 *
 * Both of those need the same answer, so both get it from here. One source,
 * two callers: the hibernating fallback in `options()` and the launcher's
 * `GET /dashboard/perch-api/bots/:id/models`. Two lists that could disagree
 * about what this instance can serve is the defect class this module exists
 * to avoid.
 *
 * WHY `loadProviders()`. It is the DB-first, models.json-fallback registry
 * that already backs `model-availability.js`'s own `defaultDeps()` (:66) —
 * the established session-free path — and the DB read filters `disabled`
 * rows out for us (providers-db.js's `WHERE disabled = 0`).
 *
 * SHAPE. Entries mirror pi's own Model object (its rpc docs' `Model`:
 * `{id, name, provider, baseUrl, …}`), because the drawer, the launcher and
 * `annotateAvailability()` all read them by those names — `baseUrl` in
 * particular is what the availability probe addresses. Every field the
 * provider row carries on the model is preserved; `provider` and `baseUrl`
 * are stamped from the row that owns it.
 *
 * Availability is deliberately NOT decided here: this says what is
 * configured, `annotateAvailability()` says what is reachable, and the two
 * questions stay separable (a probe-free caller can still list).
 *
 * USABILITY, though, IS decided here. `annotateAvailability()` answers
 * "did anything answer at this address", which an embedding endpoint does —
 * on this instance `grackle-embed/qwen3-embedding-0.6b` and
 * `grackle-rerank/qwen3-reranker-0.6b` were listed reading "up" and were one
 * tap from becoming a session's model, which would fail every turn. Provider
 * rows tag those entries (`task: "embed"`, `task: "score"`; the model catalog
 * spells the same vocabulary "embedding"/"rerank" —
 * scripts/validate-model-catalog.js:75), so they are filtered out below.
 * Entries with NO task are kept: that is most of them (every `crow-local`
 * row), and they are chat models. `task: "vision"` is kept too, matching
 * models/manager.js's own `isChatClassRow` — a `-vl-…-instruct` model serves
 * chat completions.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { loadProviders } from "../shared/providers.js";
import { resolvePiCli } from "../../scripts/pi-bots/pi_resolver.mjs";

/**
 * Tasks a Perch session can never be driven by. An entry is EXCLUDED only
 * when it names one of these — absence means "chat" for every provider row
 * this instance has ever carried, and a strict allowlist would silently empty
 * the picker on any row that simply does not tag its models.
 */
const NON_CHAT_TASKS = new Set(["embed", "embedding", "rerank", "score", "classify"]);

/** Can a Perch session actually be served by this entry? */
export function chatCapable(m) {
  const task = m && typeof m.task === "string" ? m.task.toLowerCase() : null;
  return !(task && NON_CHAT_TASKS.has(task));
}

/**
 * Every model every enabled provider row declares, as pi-shaped entries.
 *
 * @param {{load?: () => {providers?: object}}} [deps] test seam — inject a
 *   provider config instead of reading the DB/models.json.
 * @returns {Array<{provider: string, id: string, baseUrl: string|null}>}
 */
export function providerModelList({ load = loadProviders } = {}) {
  let cfg = null;
  try {
    cfg = load();
  } catch {
    return [];                                   // no registry is an empty list, never a throw
  }
  const providers = (cfg && cfg.providers) || {};
  const out = [];
  for (const [provider, row] of Object.entries(providers)) {
    // `$`-prefixed keys are models.json schema meta, not providers.
    if (!row || provider.startsWith("$")) continue;
    const models = Array.isArray(row.models) ? row.models : [];
    for (const m of models) {
      // A provider row's `models` may hold bare id strings (the shape
      // loadModelOptions() in bot-builder tolerates) or full objects.
      const entry = typeof m === "string" ? { id: m } : m;
      const id = entry && entry.id;
      if (!id) continue;
      if (!chatCapable(entry)) continue;          // an embedding endpoint is not a model to talk to
      const e = { ...entry, id: String(id), provider, baseUrl: row.baseUrl || null };
      // Row facts the picker's dedupe and grouping read (pickerModels below).
      // Set only when TRUE, so a plain row's entry keeps exactly its old shape.
      // `managed`: the row is the one this instance orchestrates (a bundle or
      // a native runtime) — the canonical row among aliases of one endpoint.
      // `external`: an external engine (gpuPolicy.engine — raven's gufo),
      // which is on the operator's network whatever its `host` column says.
      if (row.bundleId || row.gpuPolicy) e.managed = true;
      if (row.gpuPolicy && row.gpuPolicy.engine) e.external = true;
      out.push(e);
    }
  }
  return out;
}

/** "provider/id" — the key `definition.models.default`, `control()`'s model
 *  body and the drawer's `<option value>` all speak. */
export function modelKey(m) {
  return m && m.provider && m.id ? m.provider + "/" + m.id : null;
}

/**
 * The same list, but never the EMPTY-because-cold one.
 *
 * `loadProviders()` is synchronous by contract (providers.js: hot-path callers
 * that cannot be made async), so on a cold process it returns
 * `_cache || loadFromModelsJson()` and fires an UNAWAITED DB refresh. This
 * instance ships no models.json, so the first call after a gateway start
 * answers 0 models and the second, ~1.5 s later, answers all of them.
 *
 * Both of this module's callers are in the async path already and both are
 * harmed by that window: the launcher route would serve `{models: []}`, and a
 * hibernating session's `options()` would answer `[]` — which the drawer
 * renders as the empty, disabled dropdown this whole task exists to remove,
 * and `loadOptions` runs once per `openSession` and never retries.
 *
 * So: when the sync answer is empty, await ONE real refresh and ask again.
 * Discarding the cache is free in exactly that case, because the cache being
 * discarded is the empty one.
 */
export async function providerModelListWarm(deps) {
  const first = providerModelList(deps);
  if (first.length || (deps && deps.load)) return first;   // injected loader: no cache to warm
  try {
    const providers = await import("../shared/providers.js");
    await providers.invalidateAndRefreshProvidersCache();
  } catch {
    return first;                                          // no registry reachable; [] is the honest answer
  }
  return providerModelList(deps);
}

// ---------------------------------------------------------------------------
// The PICKER view of the list (launcher + drawer model selects).
//
// The raw catalogue answers "what does every enabled provider row declare",
// and on a long-lived instance that is a lot of rows that are aliases of one
// another: four rows serve the same 35B on :8003, three are Z.AI, two pairs
// share a cloud endpoint. Listed flat, in provider order, the operator could
// not find the one model that matters (Kevin, 2026-10-02: raven's
// flash-next was buried under stale cloud catalogues). pickerModels() turns
// that into something choosable WITHOUT dropping anything:
//
//   - `group`: "network" (loopback, LAN, tailnet, external engines) or
//     "cloud", read from the entry's baseUrl — never from the row's `host`
//     column, which says "cloud" for raven-flash-next on 10.0.0.126.
//   - `runnable`: can pi actually spawn on this provider? pi resolves
//     `--provider` against its own models.json plus its built-in providers
//     (core/model-resolver.js: an unknown provider is a hard spawn error, an
//     unknown model id under a known provider is a soft "custom model id"
//     fallback), so the check is at PROVIDER level. A row that pi cannot
//     resolve is a session that dies at spawn — #393 made that failure
//     visible after the fact; this keeps it out of the default list before.
//   - dedupe: entries that resolve to the same baseUrl + model id are ONE
//     model; the canonical row is kept and the others ride along as
//     `aliases`.
//   - `label`: the model's name, with the provider appended only when two
//     surviving entries would otherwise read the same.
//
// Deciding what is SHOWN by default (available AND runnable) is the client's
// job — it owns the "Show unavailable (N)" toggle — so nothing here filters.
// ---------------------------------------------------------------------------

/**
 * pi's built-in provider names as of pi 0.85.1 (pi-ai models.generated.js).
 * Only the FALLBACK: loadPiProviderNames() reads the installed pi's own list
 * when it can find it, so a newer pi is not judged against this snapshot.
 */
const PI_BUILTIN_PROVIDERS_SNAPSHOT = [
  "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "baseten",
  "cerebras", "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek",
  "fireworks", "github-copilot", "google", "google-vertex", "groq", "huggingface",
  "kimi-coding", "minimax", "minimax-cn", "mistral", "moonshotai", "moonshotai-cn",
  "nvidia", "openai", "openai-codex", "opencode", "opencode-go", "openrouter",
  "qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "together",
  "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
];

/** The installed pi's built-in providers: pi-ai ships one
 *  `dist/providers/<name>.models.js` per provider. Searched next to the CLI
 *  the bot engine actually spawns (pi_resolver.mjs), nested or hoisted. */
function builtinProvidersNear(cliPath, list) {
  let dir = dirname(cliPath);
  for (let up = 0; up < 5; up++) {
    for (const rel of [["node_modules", "@earendil-works", "pi-ai"], ["..", "pi-ai"]]) {
      try {
        const names = list(join(dir, ...rel, "dist", "providers"))
          .filter((f) => f.endsWith(".models.js"))
          .map((f) => f.slice(0, -".models.js".length));
        if (names.length) return names;
      } catch { /* not here */ }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * What pi can resolve as `--provider`, lower-cased (pi's own lookup is
 * case-insensitive). `custom` is pi's models.json (the file a bot's pi reads:
 * PI_CODING_AGENT_DIR or ~/.pi/agent; PI_MODELS_JSON wins, as in
 * model_resolver.mjs); `builtin` is pi's own provider set.
 *
 * Returns null when the answer is UNKNOWN (a models.json that exists but does
 * not parse) — callers then mark nothing unrunnable rather than guess. A
 * missing models.json is not unknown: pi then has its built-ins only.
 *
 * @param {object} [deps] test seams
 * @returns {{custom: Set<string>, builtin: Set<string>} | null}
 */
export function loadPiProviderNames({ env = process.env, read = readFileSync, list = readdirSync, cli = resolvePiCli } = {}) {
  const agentDir = env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
  const file = env.PI_MODELS_JSON || join(agentDir, "models.json");
  const custom = new Set();
  let raw = null;
  try { raw = read(file, "utf8"); } catch { raw = null; }
  if (raw != null) {
    try {
      const j = JSON.parse(raw);
      for (const k of Object.keys((j && j.providers) || {})) {
        if (!k.startsWith("$")) custom.add(k.toLowerCase());
      }
    } catch {
      return null;
    }
  }
  let names = null;
  try {
    const r = cli({ env });
    if (r && r.cliPath) names = builtinProvidersNear(r.cliPath, list);
  } catch { names = null; }
  const builtin = new Set((names || PI_BUILTIN_PROVIDERS_SNAPSHOT).map((n) => n.toLowerCase()));
  return { custom, builtin };
}

function ipv4InNetwork(h) {
  const p = h.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 127 || p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127);          // CGNAT — the tailnet's range
}

/**
 * "network" for an address on the operator's own machines — loopback, LAN,
 * link-local, tailnet (100.64/10, fd7a:… ULA, *.ts.net) and bare single-label
 * host names — else "cloud". No baseUrl (a pi built-in provider) is cloud.
 */
export function scopeOf(baseUrl) {
  let host = "";
  try { host = new URL(String(baseUrl)).hostname.toLowerCase(); } catch { return "cloud"; }
  host = host.replace(/^\[|\]$/g, "");
  if (!host) return "cloud";
  if (host === "localhost" || host.endsWith(".localhost")) return "network";
  if (/\.(ts\.net|local|lan|home\.arpa|internal)$/.test(host)) return "network";
  const v = isIP(host);
  if (v === 4) return ipv4InNetwork(host) ? "network" : "cloud";
  if (v === 6) {
    if (host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return "network";
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped && ipv4InNetwork(mapped[1]) ? "network" : "cloud";
  }
  return host.includes(".") ? "cloud" : "network";
}

const AVAIL_RANK = { up: 2, on_demand: 1 };

/** Normalized endpoint identity for dedupe: scheme+host+port+path, no
 *  trailing slash, case-folded host. */
function endpointKey(baseUrl) {
  try {
    const u = new URL(String(baseUrl));
    return (u.protocol + "//" + u.host.toLowerCase() + u.pathname.replace(/\/+$/, ""));
  } catch {
    return String(baseUrl).replace(/\/+$/, "");
  }
}

/**
 * The picker's list: grouped, de-duplicated, ordered and labelled (see the
 * block comment above). Never throws; never drops a model except as an alias
 * of a kept one with the same endpoint and id.
 *
 * Canonical row among aliases, in order: the bot's default; a key something
 * references (another bot's default/escalation, the session's current
 * model); a row pi resolves through models.json, then through a built-in, then
 * not at all (a choice that cannot spawn never wins over one that can); a
 * managed row (bundle / native runtime); the better availability; a row that
 * names the model; first seen.
 *
 * Order: the default first, then network, then cloud; inside a group usable
 * entries before unusable ones, then by label.
 *
 * @param {Array<object>} models annotated entries ({provider,id,baseUrl,availability,…})
 * @param {{defaultKey?: string|null, referenced?: Iterable<string>,
 *          pi?: {custom:Set<string>, builtin:Set<string>}|null,
 *          runnableAll?: boolean}} [opts]
 *   `runnableAll`: the list came from a live pi child, so every entry is one
 *   pi already resolved.
 */
export function pickerModels(models, { defaultKey = null, referenced = [], pi = null, runnableAll = false } = {}) {
  const list = Array.isArray(models) ? models : [];
  const refs = new Set(Array.from(referenced || []).filter(Boolean));
  const piRank = (provider) => {
    if (runnableAll) return 2;
    if (!pi) return null;
    const p = String(provider || "").toLowerCase();
    if (pi.custom.has(p)) return 2;
    if (pi.builtin.has(p)) return 1;
    return 0;
  };

  const groups = new Map();
  list.forEach((m, i) => {
    const key = modelKey(m);
    if (!key) return;
    const rank = piRank(m.provider);
    const cand = {
      m, i, key, rank,
      score: [
        key === defaultKey ? 1 : 0,
        refs.has(key) ? 1 : 0,
        rank == null ? 1 : rank,
        m.managed ? 1 : 0,
        AVAIL_RANK[m.availability] || 0,
        m.name ? 1 : 0,                           // a row that names its model reads better
        -i,
      ],
    };
    const dk = m.baseUrl ? endpointKey(m.baseUrl) + "\n" + m.id : "key:" + key;
    const g = groups.get(dk);
    if (!g) { groups.set(dk, { best: cand, all: [cand] }); return; }
    g.all.push(cand);
    const a = cand.score, b = g.best.score;
    for (let k = 0; k < a.length; k++) {
      if (a[k] !== b[k]) { if (a[k] > b[k]) g.best = cand; break; }
    }
  });

  const out = [];
  for (const g of groups.values()) {
    const { m, key, rank } = g.best;
    const e = { ...m, group: m.external ? "network" : scopeOf(m.baseUrl) };
    if (rank != null) e.runnable = rank > 0;
    const aliases = g.all.filter((c) => c !== g.best).map((c) => c.key);
    if (aliases.length) e.aliases = aliases;
    e._key = key;
    out.push(e);
  }

  const baseLabel = (e) => String(e.name || e.id);
  const seen = new Map();
  for (const e of out) {
    const l = baseLabel(e).toLowerCase();
    seen.set(l, (seen.get(l) || 0) + 1);
  }
  for (const e of out) {
    const b = baseLabel(e);
    e.label = seen.get(b.toLowerCase()) > 1 ? b + " (" + e.provider + ")" : b;
  }

  const usable = (e) => (e.runnable !== false && e.availability !== "unavailable" ? 1 : 0);
  out.sort((x, y) =>
    ((y._key === defaultKey) - (x._key === defaultKey)) ||
    ((x.group === "network" ? 0 : 1) - (y.group === "network" ? 0 : 1)) ||
    (usable(y) - usable(x)) ||
    x.label.localeCompare(y.label) ||
    String(x.provider).localeCompare(String(y.provider)));
  for (const e of out) delete e._key;
  return out;
}

/**
 * Every model key an enabled bot def names (models.default / escalation) —
 * the "referenced by bots" half of pickerModels' canonical-row rule.
 * @param {Array<{definition?: string}>} rows pi_bot_defs rows
 */
export function referencedModelKeys(rows) {
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    let def = null;
    try { def = JSON.parse((r && r.definition) || "{}"); } catch { def = null; }
    const models = def && def.models;
    if (!models || typeof models !== "object") continue;
    for (const k of [models.default, models.escalation]) {
      if (typeof k === "string" && k) out.add(k);
    }
  }
  return out;
}
