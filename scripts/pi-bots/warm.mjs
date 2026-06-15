/**
 * Model warming for the pi-bots host — shared by the interactive bridge
 * (handleInbound, Discord/Gmail/etc.) and the background job runner (runJob).
 *
 * The pi-bots host is a SEPARATE process from the gateway (which owns the
 * gpu-orchestrator), so it warms over HTTP via the gateway's POST /llm/acquire
 * instead of running a second orchestrator. The gateway maps a bundle-less
 * local alias (e.g. "crow-local" :8003) to its bundled same-baseUrl sibling
 * ("crow-chat") via resolveWarmableProviderName, then warms that bundle.
 *
 * Target = the GPU-owning gateway on loopback (PIBOT_WARM_GATEWAY_URL, else
 * CROW_GATEWAY_PORT, else :3001). Without this, an on-demand model (:8003) is
 * cold when pi connects and pi returns "Connection error" → "(no reply)".
 * See memory pibot-bridge-no-model-warming.
 */

const WARM_BASE = (process.env.PIBOT_WARM_GATEWAY_URL
  || `http://127.0.0.1:${process.env.CROW_GATEWAY_PORT || 3001}`).replace(/\/$/, "");
const WARM_TIMEOUT_MS = Number(process.env.PIBOT_WARM_TIMEOUT_MS || 250000); // ~ gpu readiness cap

/**
 * Best-effort warm of a resolved provider's model bundle before spawning pi.
 * No-op for a falsy provider; never throws (a failed warm is non-fatal — pi
 * surfaces the real connection error if the model is genuinely unavailable).
 * @param {string} provider  resolved.provider from model_resolver.resolveModel()
 * @param {(msg: string) => void} [log]
 */
export async function warmModel(provider, log = () => {}) {
  if (!provider) return;
  try {
    const r = await fetch(`${WARM_BASE}/llm/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
      signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
    });
    let body = null; try { body = await r.json(); } catch {}
    log(`warm ${provider} → ${r.status}${body && body.warmed != null ? " warmed=" + body.warmed : ""}`);
  } catch (e) {
    log(`warm ${provider} skipped (non-fatal): ${(e && e.message) || e}`);
  }
}
