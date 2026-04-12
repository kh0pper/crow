/**
 * Crow's Nest Panel — vLLM: live status + endpoint info + config hints
 *
 * vLLM is a backend bundle, not a user-facing UI. This panel is an
 * operator status page: which model is loaded, is the endpoint up,
 * how to wire it into Maker Lab / Companion. It does a single live
 * GET to /v1/models with a short timeout; if that fails we fall back
 * to showing just the configured env state.
 */

export default {
  id: "vllm",
  name: "vLLM",
  icon: "brain",
  route: "/dashboard/vllm",
  navOrder: 42,
  category: "ai",

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const port = process.env.VLLM_HTTP_PORT || "8089";
    const endpointUrl = `http://${req.hostname || "localhost"}:${port}`;
    const configuredModel = process.env.VLLM_MODEL || "(unset — set VLLM_MODEL in .env before starting)";
    const maxSeqs = process.env.VLLM_MAX_NUM_SEQS || "16";
    const gpuUtil = process.env.VLLM_GPU_MEMORY_UTILIZATION || "0.85";

    // Live status probe — tight timeout so the panel stays snappy even
    // when vLLM is still loading the model or the container is down.
    async function probe(url, timeoutMs) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (resp.ok) return await resp.json();
      } catch { /* swallow */ }
      return null;
    }

    const modelsData = await probe(`${endpointUrl}/v1/models`, 2000);
    const live = modelsData
      ? { ok: true, models: (modelsData.data || []).map((m) => m.id) }
      : { ok: false, reason: "no response" };

    // Phase 4b — cross-check: is Maker Lab's hint pipeline currently
    // routed through this vLLM instance? Short-timeout probe of
    // /maker-lab/api/engine; silent if Maker Lab isn't installed.
    const gatewayPort = process.env.CROW_GATEWAY_PORT || "3002";
    const engineData = await probe(`http://127.0.0.1:${gatewayPort}/maker-lab/api/engine`, 1000);
    const wiredIntoMakerLab = !!(engineData && engineData.engine === "vllm"
      && typeof engineData.endpoint === "string" && engineData.endpoint.includes(`:${port}`));

    const statusBadge = live && live.ok
      ? `<span class="vl-badge vl-ok">● live · ${escapeHtml(String(live.models.length))} model${live.models.length === 1 ? "" : "s"} loaded</span>`
      : `<span class="vl-badge vl-off">○ offline · ${escapeHtml(live?.reason || "no response")}</span>`;

    const body = `
      <section class="vl-card">
        <h2>Status</h2>
        <p>${statusBadge}</p>
        <dl class="vl-dl">
          <dt>Endpoint</dt><dd><code>${escapeHtml(endpointUrl)}</code></dd>
          <dt>Configured model</dt><dd><code>${escapeHtml(configuredModel)}</code></dd>
          <dt>Max concurrent seqs</dt><dd><code>${escapeHtml(maxSeqs)}</code></dd>
          <dt>GPU memory utilization</dt><dd><code>${escapeHtml(gpuUtil)}</code></dd>
          ${live && live.ok && live.models.length
            ? `<dt>Loaded</dt><dd><code>${live.models.map(escapeHtml).join("</code>, <code>")}</code></dd>`
            : ""}
        </dl>
      </section>
      <section class="vl-card">
        <h2>Wiring it into Maker Lab</h2>
        ${wiredIntoMakerLab
          ? `<p><span class="vl-badge vl-ok">● auto-wired</span> Maker Lab detected this vLLM instance at startup and routes hints through it. No extra env vars needed.</p>
             <p class="vl-muted">Active model: <code>${escapeHtml(engineData.model || "(unknown)")}</code>. To override, set <code>MAKER_LAB_LLM_ENDPOINT</code> explicitly — the operator override always wins over auto-detection.</p>`
          : engineData
            ? `<p><span class="vl-badge vl-off">○ not wired</span> Maker Lab is routing through <code>${escapeHtml(engineData.engine || "?")}</code> at <code>${escapeHtml(engineData.endpoint || "?")}</code>.</p>
               <p class="vl-muted">This usually means vLLM wasn't ready when Maker Lab started. Restart the maker-lab service after vLLM finishes its first-start model download.</p>`
            : `<p><span class="vl-badge vl-off">○ Maker Lab not installed</span> or the engine-resolution endpoint is unreachable.</p>
               <p>When Maker Lab is installed alongside vLLM, the hint pipeline auto-detects this endpoint at startup. Manual override:</p>
               <pre><code>MAKER_LAB_LLM_ENDPOINT=${escapeHtml(endpointUrl)}/v1
MAKER_LAB_LLM_MODEL=${escapeHtml(configuredModel)}</code></pre>`}
        <p class="vl-muted">vLLM's endpoint is OpenAI-compatible — any client that speaks <code>/v1/chat/completions</code> (including Companion, the gateway's BYOAI chat, and third-party tools) drops in here directly.</p>
      </section>
      <section class="vl-card">
        <h2>Classroom sizing</h2>
        <p>From the Maker Lab Phase 0 benchmark (Spike 5, see <code>bundles/maker-lab/PHASE-0-REPORT.md</code>): on a 16 GB consumer GPU, <strong>Qwen2.5-3B-Instruct at VLLM_MAX_NUM_SEQS=16</strong> is the sweet spot for a 25-learner classroom. Ollama at NUM_PARALLEL=4 hit p95=36s at 25 concurrent — unusable. vLLM's continuous batching + PagedAttention was architecturally the right answer.</p>
        <p>A <strong>24 GB GPU</strong> comfortably runs 7B-class models (Qwen2.5-7B-Instruct, Llama-3.1-8B-Instruct) at the same max-num-seqs.</p>
      </section>
      <section class="vl-card">
        <h2>Caveats</h2>
        <ul>
          <li>Linux x86_64 + NVIDIA GPU only. No ARM, no AMD ROCm in this bundle (vLLM has experimental ROCm but isn't stable enough to ship by default).</li>
          <li>First start downloads the model — tens of GB for 7B-class weights. Watch <code>docker logs -f crow-vllm</code>.</li>
          <li>Gated models (Llama, Mistral instruct) require a HuggingFace token with access granted. Set <code>VLLM_HF_TOKEN</code>.</li>
          <li>Lower <code>VLLM_GPU_MEMORY_UTILIZATION</code> if you also run SDXL / Whisper on the same GPU — otherwise one service ends up swapping weights.</li>
        </ul>
      </section>
    `;

    const content = `
      <style>${styles()}</style>
      <div class="vl-panel">
        <h1>vLLM</h1>
        <p class="vl-sub">Local LLM inference server · OpenAI-compatible endpoint</p>
        <div class="vl-body">${body}</div>
      </div>
    `;
    return layout({ title: "vLLM", content });
  },
};

function styles() {
  return `
    .vl-panel { max-width: 900px; margin: 0 auto; padding: 1.5rem; }
    .vl-sub { color: var(--fg-muted, #888); margin: 0 0 1.5rem; }
    .vl-card { background: var(--card-bg, rgba(255,255,255,0.04)); border: 1px solid var(--border, #333); border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; }
    .vl-card h2 { margin: 0 0 0.75rem; font-size: 1.05rem; color: #a855f7; }
    .vl-card pre { background: rgba(0,0,0,0.35); padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
    .vl-badge { display: inline-block; padding: 0.25rem 0.7rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .vl-ok { background: rgba(34,197,94,0.15); color: #22c55e; }
    .vl-off { background: rgba(239,68,68,0.15); color: #ef4444; }
    .vl-dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; margin: 0.5rem 0 0; }
    .vl-dl dt { color: var(--fg-muted, #888); }
    .vl-dl dd { margin: 0; }
    .vl-muted { color: var(--fg-muted, #888); font-size: 0.9rem; }
  `;
}
