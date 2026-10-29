/**
 * "Test the picks" (roles phase 2b, Task 10): one tool call per recommended
 * pick, run only when the operator presses the button. Nothing calls this at
 * add time or on a timer.
 *
 * Every probe goes through `safeRequest` ("cloud" for preset rows, "other"
 * otherwise). The key is read from the row here and used only in a request
 * header: it is never returned, logged or stored in a result. Errors are
 * reduced to a short code.
 */
import { presetById, normalizeBaseUrl, ANTHROPIC_VERSION } from "../../shared/provider-presets.js";
import { candidatePick, presetForRow, entryKind, RECOMMENDATION_ROLES } from "../../shared/provider-recommendations.js";
import { listProvidersAll } from "../../shared/providers-db.js";
import { safeRequest, readJson } from "../models/safe-upstream.js";
import { PICK_CHECKS_KEY, readPickChecks, pickCheckOf, isProbeKind, checkStamp } from "../../shared/pick-checks.js";

// The read side lives in pick-checks.js (no request path); re-exported here for existing callers.
export { PICK_CHECKS_KEY, pickCheckOf };
const PROBE_TOOL = "crow_probe";
const PROMPT = "Call crow_probe with ok set to true.";
const TOOL_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

const discard = (res) => { try { res?.stream?.destroy?.(); } catch {} };

function requestFor(row, modelId, kind) {
  const preset = presetForRow(row) ? presetById(presetForRow(row)) : null;
  const base = normalizeBaseUrl(row.baseUrl || row.base_url);
  const key = typeof (row.apiKey ?? row.api_key) === "string" ? (row.apiKey ?? row.api_key).trim() : "";
  const anthropic = preset?.authStyle === "anthropic";
  const headers = { "content-type": "application/json" };
  if (anthropic) { if (key) headers["x-api-key"] = key; headers["anthropic-version"] = ANTHROPIC_VERSION; }
  else if (key) headers.Authorization = `Bearer ${key}`;
  let url, body;
  if (kind === "embed") {
    url = `${base}/embeddings`;
    body = { model: modelId, input: "ok" };
  } else if (anthropic) {
    url = `${base}/v1/messages`;
    body = {
      model: modelId, max_tokens: 64, messages: [{ role: "user", content: PROMPT }],
      tools: [{ name: PROBE_TOOL, input_schema: TOOL_SCHEMA }], tool_choice: { type: "any" },
    };
  } else {
    url = `${base}/chat/completions`;
    body = {
      model: modelId, messages: [{ role: "user", content: PROMPT }],
      tools: [{ type: "function", function: { name: PROBE_TOOL, parameters: TOOL_SCHEMA } }],
      tool_choice: "required", max_tokens: 64,
    };
  }
  return { url, headers, body: JSON.stringify(body), anthropic, mode: preset ? "cloud" : "other" };
}

function judge(json, kind, anthropic) {
  if (kind === "embed") {
    const e = json?.data?.[0]?.embedding;
    return Array.isArray(e) && e.length > 0 ? "ok" : "bad_embedding";
  }
  if (anthropic) {
    const hit = Array.isArray(json?.content) && json.content.some((b) => b?.type === "tool_use" && b.name === PROBE_TOOL);
    return hit ? "ok" : "no_tool_call";
  }
  const calls = json?.choices?.[0]?.message?.tool_calls;
  const hit = Array.isArray(calls) && calls.some((c) => c?.function?.name === PROBE_TOOL);
  return hit ? "ok" : "no_tool_call";
}

/** One probe. Resolves `{ok, code}`; never throws, never carries the key. */
export async function probePick(row, modelId, { kind = "chat", requestFn = safeRequest, timeoutMs = 20000 } = {}) {
  let req;
  try { req = requestFor(row || {}, modelId, kind); } catch { return { ok: false, code: "unreachable" }; }
  let res;
  try {
    res = await requestFn(req.url, { method: "POST", headers: req.headers, body: req.body, mode: req.mode, timeoutMs });
  } catch (err) {
    if (err?.code === "TIMEOUT") return { ok: false, code: "timeout" };
    console.warn(`[pick-probe] request failed: ${typeof err?.code === "string" && err.code.length <= 40 && !err.code.includes(row?.apiKey || row?.api_key || "\u0000") ? err.code : "error"}`);
    return { ok: false, code: "unreachable" };
  }
  const status = Number(res?.status);
  if (status >= 300 && status < 400) { discard(res); return { ok: false, code: "redirect" }; }
  if (!(status >= 200 && status < 300)) { discard(res); return { ok: false, code: `http_${status}` }; }
  let json;
  try {
    json = await readJson(res, { maxBytes: 1_000_000, deadline: Number.isFinite(res?.deadline) ? res.deadline : Date.now() + timeoutMs });
  } catch (err) {
    // An answer that never finished is retryable; one too big or not JSON is a failure.
    if (err?.code === "TIMEOUT") return { ok: false, code: "timeout" };
    return { ok: false, code: kind === "embed" ? "bad_embedding" : "no_tool_call" };
  }
  const code = judge(json, kind, req.anthropic);
  return { ok: code === "ok", code };
}

/**
 * Probe the candidate pick of each role (a model shared by roles is probed
 * once, sequentially), store the results, and return them per role.
 */
let probeChain = Promise.resolve();
/** One probe run at a time in this process, so concurrent presses cannot drop each other's stored results. */
export function probeRecommended(db, providerId, opts = {}) {
  const run = probeChain.then(() => runProbes(db, providerId, opts));
  probeChain = run.catch(() => {});
  return run;
}

async function runProbes(db, providerId, {
  roles = RECOMMENDATION_ROLES, requestFn = safeRequest, listRowsFn = listProvidersAll, timeoutMs, recOpts,
} = {}) {
  const rows = await listRowsFn(db);
  const row = rows.find((r) => r.id === providerId);
  const presetId = row ? presetForRow(row) : null;
  if (!row || !presetId) return {};
  const listed = (Array.isArray(row.models) ? row.models : []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
  const liveModelIds = listed.length ? listed : null;
  const picks = [];
  for (const roleId of roles) {
    const pick = candidatePick(presetId, roleId, { liveModelIds }, recOpts);
    // Rerank has no probe shape; it stays "not tested".
    if (pick && isProbeKind(pick.kind)) picks.push({ roleId, modelId: pick.model_id, kind: entryKind(pick) });
  }
  const done = new Map(); // `${kind}:${modelId}` -> result
  const out = {};
  const at = new Date().toISOString();
  for (const p of picks) {
    const k = `${p.kind}:${p.modelId}`;
    if (!done.has(k)) done.set(k, await probePick(row, p.modelId, { kind: p.kind, requestFn, ...(timeoutMs ? { timeoutMs } : {}) }));
    const r = done.get(k);
    out[p.roleId] = { modelId: p.modelId, ok: r.ok, code: r.code };
  }
  if (done.size) {
    const all = await readPickChecks(db);
    const mine = { ...(all[providerId] || {}) };
    const { fp, url } = checkStamp(row); // a fingerprint, never the key
    for (const p of picks) {
      const r = done.get(`${p.kind}:${p.modelId}`);
      mine[`${p.modelId}|${p.kind}`] = { ok: r.ok, code: r.code, at, fp, url };
    }
    all[providerId] = mine;
    await db.execute({
      sql: `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [PICK_CHECKS_KEY, JSON.stringify(all)],
    });
  }
  return out;
}
