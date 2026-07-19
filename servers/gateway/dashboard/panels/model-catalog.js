/**
 * Model Catalog Panel — Item G Task 13 (+ fix round 1: Browse-HF downloads,
 * the "reloading after update" runtime state, typed gated-retry detection)
 *
 * Browse the curated catalog (registry/model-catalog.json), download +
 * register GGUF models as local providers, start/stop/remove them, and
 * search Hugging Face directly for GGUF repos — including downloading an
 * arbitrary (un-vetted, HF-sha-verified) file straight from a search result
 * via `POST /api/models/hf-download` (fix round 1, finding 1).
 *
 * Architecture: server-side render (SSR) for the initial page — this panel
 * imports the SAME read-only model-management functions Task 12's
 * `routes/models.js` uses (`probe.js`, `state.js`, `runtime.js`,
 * `gpu-orchestrator.js`'s `getNativeHandle`) directly, rather than doing a
 * self-referential HTTP fetch of its own API on first paint. All later
 * interaction (download, start/stop, delete, HF search, HF token,
 * Browse-HF download) is driven client-side against the real
 * `/api/models/*` routes, consumed verbatim — this file never modifies
 * `routes/models.js` (that file's own fix-round-1 changes, incl.
 * `POST /hf-download`, were made directly, not through this panel).
 *
 * Security note: all server-rendered dynamic content is escaped via
 * escapeHtml(). Client-side DOM built from API responses (HF search results,
 * profile/bot names in the delete-confirmation dialog) uses textContent, not
 * innerHTML — those values are either external (Hugging Face) or
 * user-authored (profile/bot names) and must never be parsed as markup.
 *
 * ABSOLUTE RULE: the client-side <script> block below is built inside a
 * template literal and must never contain a literal backtick character.
 * Every string inside the browser JS uses single quotes and `+`
 * concatenation — see docs on this rule at the top of extensions/client.js,
 * the established sibling pattern this file follows.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { t, tJs, fill } from "../shared/i18n.js";
import { escapeHtml, button, callout, tabs } from "../shared/components.js";
import { resolveDataDir } from "../../../db.js";
import { getCachedProbe, reprobe, fitBadge } from "../../models/probe.js";
import { loadState, registryEntryRuntimeState } from "../../models/state.js";
import { getStatusSnapshot } from "../../models/runtime.js";
import { getNativeHandle } from "../../gpu-orchestrator.js";
import { listProvidersAll } from "../../../shared/providers-db.js";
import { HF_TOKEN_PROVIDER_ID } from "../../routes/models.js";

const __filename = fileURLToPath(import.meta.url);
// dashboard/panels/model-catalog.js -> dashboard -> gateway -> servers -> repo root
const MODEL_CATALOG_PATH = resolvePath(dirname(__filename), "..", "..", "..", "..", "registry", "model-catalog.json");

function defaultLoadCatalog() {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_CATALOG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { runtime: {}, models: [] };
  } catch {
    return { runtime: {}, models: [] };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const SIZE_CLASSES = ["small", "mid", "large"];

/** "small" | "mid" | "large" | "other" — from the catalog's curation-policy
 * tags (spec §3), not a dedicated schema field. */
export function sizeClassOf(model) {
  const tags = model?.tags || [];
  for (const c of SIZE_CLASSES) {
    if (tags.includes(c)) return c;
  }
  return "other";
}

export function groupBySizeClass(models) {
  const groups = { small: [], mid: [], large: [], other: [] };
  for (const m of models || []) {
    groups[sizeClassOf(m)].push(m);
  }
  return groups;
}

/** MB -> a human string, GB above 1024 MB. Never throws on null/NaN. */
export function formatMb(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n >= 1024) return (n / 1024).toFixed(1) + " GB";
  return Math.round(n) + " MB";
}

const FIT_ORDER = ["fits", "tight", "wont_fit", "unknown"];

export function fitLabelKey(badgeName) {
  switch (badgeName) {
    case "fits": return "models.fitFits";
    case "tight": return "models.fitTight";
    case "wont_fit": return "models.fitWontFit";
    default: return "models.fitUnknown";
  }
}

export function fitHintKey(badgeName) {
  switch (badgeName) {
    case "fits": return "models.fitFitsHint";
    case "tight": return "models.fitTightHint";
    case "wont_fit": return "models.fitWontFitHint";
    default: return "models.fitUnknownHint";
  }
}

// ---------------------------------------------------------------------------
// Data assembly (injectable for tests — mirrors routes/models.js's opts seam)
// ---------------------------------------------------------------------------

export async function loadPanelData({
  db,
  dir,
  loadCatalogFn = defaultLoadCatalog,
  getCachedProbeFn = getCachedProbe,
  reprobeFn = reprobe,
  fitBadgeFn = fitBadge,
  loadStateFn = loadState,
  getStatusSnapshotFn = getStatusSnapshot,
  getNativeHandleFn = getNativeHandle,
  listProvidersAllFn = listProvidersAll,
  registryEntryRuntimeStateFn = registryEntryRuntimeState,
} = {}) {
  const resolvedDir = dir || resolveDataDir();
  const catalog = loadCatalogFn();

  // The probe cache is null until something calls reprobe() — today only a
  // native acquire warms it (gpu-orchestrator.js's resolveNativeBinPath).
  // A fresh install's first Model Catalog view would otherwise show every
  // fit badge as "unknown" with no explanation. Warm it here too, once, on
  // a cache miss — same fix shape as the orchestrator's own, cheap because
  // probe.js caches the result for every other reader.
  let probe = getCachedProbeFn();
  if (!probe) {
    try {
      probe = await reprobeFn({ modelsDir: resolvedDir });
    } catch {
      probe = null; // honest "couldn't detect" state; every fit badge below falls back to "unknown"
    }
  }

  const state = loadStateFn(resolvedDir);

  const models = (catalog.models || []).map((model) => {
    const regEntry = state.registry[model.id] || null;
    const handle = getNativeHandleFn(model.id);
    const quants = (model.quants || []).map((q) => ({
      quant: q.quant,
      size_mb: q.size_mb,
      min_ram_mb: q.min_ram_mb,
      min_vram_mb: q.min_vram_mb,
      fitBadge: fitBadgeFn(probe, q),
    }));
    return {
      id: model.id,
      family: model.family,
      lab: model.lab,
      license: model.license,
      gated: !!model.gated,
      task: model.task,
      context_len: model.context_len,
      tags: model.tags || [],
      notes: model.notes || null,
      default_quant: model.default_quant,
      first_run_default: !!model.first_run_default,
      registered: !!regEntry,
      registeredQuant: regEntry ? regEntry.quant : null,
      running: !!(handle && handle.live),
      quants,
    };
  });

  const snapshot = getStatusSnapshotFn();
  const byAlias = new Map(snapshot.map((s) => [s.alias, s]));
  const runtimeModels = Object.keys(state.registry).map((modelId) => {
    const status = byAlias.get(modelId);
    if (status) return { modelId, ...status };
    // Task 13 fix round 1, finding c: distinguish "never started" from
    // "was resident when the gateway restarted, hasn't re-warmed yet" via
    // the persisted wasLive marker — same classification GET /api/models/
    // runtime uses, mirrored here for SSR (see state.js's
    // registryEntryRuntimeState doc for the exact contract).
    const entry = state.registry[modelId];
    return {
      modelId,
      state: registryEntryRuntimeStateFn(entry, false),
      live: false, port: null, restartCount: 0, lastError: null, startedAt: null, pid: null,
    };
  });

  // Estimated RAM/VRAM in use — derived from catalog quant costs for models
  // currently live, since nothing tracks true live usage. Labeled
  // "estimated" everywhere it's rendered.
  let estimatedRamMb = 0;
  let estimatedVramMb = 0;
  const quantLookup = new Map(); // modelId -> quant -> {min_ram_mb, min_vram_mb}
  for (const m of models) {
    const byQuant = new Map(m.quants.map((q) => [q.quant, q]));
    quantLookup.set(m.id, byQuant);
  }
  for (const rm of runtimeModels) {
    if (!rm.live) continue;
    const regEntry = state.registry[rm.modelId];
    const quant = regEntry ? regEntry.quant : null;
    const q = quant && quantLookup.get(rm.modelId)?.get(quant);
    if (q) {
      estimatedRamMb += q.min_ram_mb || 0;
      estimatedVramMb += q.min_vram_mb || 0;
    }
  }

  let hfTokenConfigured = false;
  if (db) {
    try {
      const providers = await listProvidersAllFn(db);
      hfTokenConfigured = providers.some((p) => p.id === HF_TOKEN_PROVIDER_ID && !!p.apiKey);
    } catch {
      hfTokenConfigured = false; // best-effort; the client-side GET /api/models/hf-token is authoritative
    }
  }

  return {
    runtime: { name: catalog.runtime?.name ?? null, release: catalog.runtime?.release ?? null },
    probe,
    models,
    runtimeModels,
    estimatedRamMb,
    estimatedVramMb,
    hfTokenConfigured,
  };
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function panelStyles() {
  return `<style>
.mcat-intro { font-size:0.85rem; color:var(--crow-text-secondary); line-height:1.5; max-width:64ch; margin-bottom:1.25rem; }

/* Runtime status strip */
.mcat-strip {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-left:3px solid var(--crow-accent);
  border-radius:var(--crow-radius-card, 12px);
  padding:1rem 1.25rem;
  margin-bottom:1.5rem;
}
.mcat-strip__title {
  font-family:'Fraunces',serif; font-weight:600; font-size:1rem;
  color:var(--crow-text-primary); margin-bottom:0.5rem;
}
.mcat-strip__line { font-size:0.82rem; color:var(--crow-text-secondary); margin-bottom:0.35rem; line-height:1.5; }
.mcat-strip__line strong { color:var(--crow-text-primary); font-weight:600; }
.mcat-strip__notice {
  font-size:0.78rem; color:var(--crow-text-muted);
  background:var(--crow-bg-deep); border-radius:8px;
  padding:0.5rem 0.75rem; margin:0.5rem 0;
}
.mcat-strip__actions { margin-top:0.6rem; display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; }
.mcat-strip__status { font-size:0.8rem; color:var(--crow-text-muted); }

/* Model groups + grid */
.mcat-group { margin-bottom:2rem; }
.mcat-group__title {
  font-family:'Fraunces',serif; font-weight:600; font-size:1.05rem;
  color:var(--crow-text-primary); margin-bottom:0.75rem;
}
.mcat-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));
  gap:1rem;
}

/* Model card */
.mcat-card {
  background:var(--crow-bg-surface);
  border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px);
  padding:1.1rem 1.15rem;
  display:flex; flex-direction:column; gap:0.5rem;
  transition:border-color 0.15s, box-shadow 0.15s;
}
.mcat-card:hover { border-color:var(--crow-accent); box-shadow:0 8px 24px rgba(0,0,0,0.18); }
.mcat-card__head { display:flex; align-items:baseline; gap:0.5rem; flex-wrap:wrap; }
.mcat-card__title { font-family:'Fraunces',serif; font-weight:600; font-size:1.02rem; color:var(--crow-text-primary); }
.mcat-card__badge {
  font-size:0.62rem; font-weight:600; text-transform:uppercase; letter-spacing:0.04em;
  padding:0.1rem 0.4rem; border-radius:4px;
}
.mcat-card__badge--recommended { color:var(--crow-accent); background:var(--crow-accent-muted); }
.mcat-card__badge--gated { color:var(--crow-warning); background:rgba(245,158,11,0.14); }
.mcat-card__badge--running { color:var(--crow-success); background:rgba(34,197,94,0.14); }
.mcat-card__meta { font-size:0.75rem; color:var(--crow-text-muted); font-family:'JetBrains Mono',monospace; }
.mcat-card__tags { display:flex; flex-wrap:wrap; gap:0.3rem; }
.mcat-card__tag {
  font-size:0.68rem; padding:0.1rem 0.45rem; border-radius:4px;
  background:var(--crow-bg-elevated); color:var(--crow-text-secondary);
}
.mcat-card__notes { font-size:0.8rem; color:var(--crow-text-secondary); line-height:1.45; }

.mcat-card__quant-row { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
.mcat-quant-select {
  flex:1 1 auto; min-width:0;
  padding:0.35rem 0.5rem;
  border:1px solid var(--crow-border); border-radius:6px;
  background:var(--crow-bg-deep); color:var(--crow-text-primary);
  font-size:0.78rem; font-family:'JetBrains Mono',monospace;
}
.mcat-fit-pill {
  display:inline-flex; align-items:center; gap:0.3rem;
  font-size:0.68rem; font-weight:600; text-transform:uppercase; letter-spacing:0.03em;
  padding:0.15rem 0.5rem; border-radius:999px; white-space:nowrap;
}
.mcat-fit-pill--fits { color:var(--crow-success); background:rgba(34,197,94,0.14); }
.mcat-fit-pill--tight { color:var(--crow-warning); background:rgba(245,158,11,0.14); }
.mcat-fit-pill--wont_fit { color:var(--crow-error); background:rgba(239,68,68,0.14); }
.mcat-fit-pill--unknown { color:var(--crow-text-muted); background:var(--crow-bg-elevated); }
.mcat-card__fit-hint { font-size:0.72rem; color:var(--crow-text-muted); line-height:1.4; }

.mcat-card__notice {
  font-size:0.75rem; line-height:1.45; color:var(--crow-text-muted);
  background:var(--crow-bg-deep); border-radius:8px; padding:0.5rem 0.65rem;
}
.mcat-card__notice--warning { color:var(--crow-warning); }

.mcat-card__actions { display:flex; gap:0.4rem; flex-wrap:wrap; margin-top:auto; padding-top:0.35rem; }
.mcat-card__status-text { font-size:0.75rem; color:var(--crow-text-muted); min-height:1.1em; }
.mcat-card__progress-track {
  height:6px; border-radius:3px; background:var(--crow-bg-deep); overflow:hidden;
}
.mcat-card__progress-bar { height:100%; width:0%; background:var(--crow-accent); transition:width 0.2s linear; }

/* Browse Hugging Face tab */
.mcat-hf__search-row { display:flex; gap:0.5rem; margin:0.75rem 0 1.25rem; flex-wrap:wrap; }
.mcat-hf__search-input {
  flex:1 1 260px; min-width:0;
  padding:0.55rem 0.75rem;
  border:1px solid var(--crow-border); border-radius:var(--crow-radius-card, 12px);
  background:var(--crow-bg-surface); color:var(--crow-text-primary);
  font-size:0.88rem; font-family:'DM Sans',sans-serif;
}
.mcat-hf__results { display:flex; flex-direction:column; gap:0.6rem; }
.mcat-hf-result {
  background:var(--crow-bg-surface); border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px); padding:0.85rem 1rem;
}
.mcat-hf-result__title { font-family:'JetBrains Mono',monospace; font-weight:600; font-size:0.88rem; color:var(--crow-text-primary); }
.mcat-hf-result__meta { font-size:0.75rem; color:var(--crow-text-muted); margin-top:0.2rem; }
.mcat-hf-result__notice { font-size:0.75rem; color:var(--crow-text-muted); margin-top:0.35rem; }

/* Per-file download rows (Task 13 fix round 1, finding 1) */
.mcat-hf-result__files-list {
  margin-top:0.6rem; padding-top:0.5rem; border-top:1px solid var(--crow-border);
  display:flex; flex-direction:column; gap:0.4rem;
}
.mcat-hf-result__file-row { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
.mcat-hf-result__file-name { font-size:0.78rem; color:var(--crow-text-secondary); flex:1 1 auto; min-width:0; word-break:break-all; }
.mcat-hf-result__file-actions { flex-shrink:0; }

.mcat-hf-token { margin-top:1.5rem; padding-top:1.25rem; border-top:1px solid var(--crow-border); }
.mcat-hf-token__heading { font-family:'Fraunces',serif; font-weight:600; font-size:0.95rem; margin-bottom:0.4rem; }
.mcat-hf-token__row { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin:0.5rem 0; }
.mcat-hf-token__input {
  flex:1 1 240px; min-width:0;
  padding:0.5rem 0.65rem;
  border:1px solid var(--crow-border); border-radius:8px;
  background:var(--crow-bg-deep); color:var(--crow-text-primary);
  font-size:0.85rem; font-family:'JetBrains Mono',monospace;
}
.mcat-hf-token__status { font-size:0.78rem; color:var(--crow-text-muted); }
.mcat-hf-token__hint { font-size:0.72rem; color:var(--crow-text-muted); margin-top:0.35rem; line-height:1.4; }

/* Delete-confirmation modal */
#mcat-modal-overlay {
  display:none; position:fixed; top:0; left:0; width:100%; height:100%;
  background:rgba(0,0,0,0.6); z-index:1000; align-items:center; justify-content:center;
  backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px);
}
#mcat-modal-content {
  background:var(--crow-bg-surface); border:1px solid var(--crow-border);
  border-radius:var(--crow-radius-card, 12px); padding:1.5rem;
  max-width:460px; width:90%; max-height:80vh; overflow-y:auto;
  box-sizing:border-box; word-wrap:break-word; box-shadow:0 20px 60px rgba(0,0,0,0.5);
}
.mcat-modal__title { font-family:'Fraunces',serif; font-size:1.1rem; font-weight:600; margin-bottom:0.6rem; color:var(--crow-text-primary); }
.mcat-modal__list { list-style:none; margin:0.5rem 0 1rem; padding:0; font-size:0.85rem; color:var(--crow-text-secondary); }
.mcat-modal__list li { padding:0.25rem 0; border-bottom:1px solid var(--crow-border); }
.mcat-modal__list li:last-child { border-bottom:none; }
.mcat-modal__actions { display:flex; gap:0.5rem; justify-content:flex-end; margin-top:1rem; }

@media (max-width:600px) {
  .mcat-grid { grid-template-columns:1fr; }
}
</style>`;
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

function renderFitPill(badgeName, lang) {
  const cls = FIT_ORDER.includes(badgeName) ? badgeName : "unknown";
  return `<span class="mcat-fit-pill mcat-fit-pill--${cls}">${escapeHtml(t(fitLabelKey(badgeName), lang))}</span>`;
}

function renderRuntimeStrip(data, lang) {
  const { runtime, probe, runtimeModels, estimatedRamMb, estimatedVramMb } = data;

  const binaryLine = runtime.name
    ? escapeHtml(fill(t("models.runtimeBinary", lang), { name: runtime.name, release: runtime.release || "" }))
    : escapeHtml(t("models.runtimeNoBinary", lang));

  let hardwareLine;
  const notices = [];
  if (!probe) {
    hardwareLine = escapeHtml(t("models.runtimeNoBinary", lang));
  } else {
    const ram = formatMb(probe.ramAvailableMb) || "?";
    const disk = formatMb(probe.diskFreeMb) || "?";
    hardwareLine = escapeHtml(fill(t("models.runtimeHardware", lang), { accel: probe.accel, ram, disk }));
    if (probe.gpuName) {
      hardwareLine += " · " + escapeHtml(fill(t("models.runtimeGpu", lang), { gpu: probe.gpuName, vram: formatMb(probe.vramMb) || "?" }));
    }
    if (probe.wsl2) notices.push(t("models.runtimeWsl2", lang));
    else if (probe.accel === "cpu" && !probe.gpuName) notices.push(t("models.runtimeNoGpu", lang));
    if (Array.isArray(probe.unknown) && probe.unknown.length > 0) {
      notices.push(fill(t("models.runtimeUnknownFields", lang), { fields: probe.unknown.join(", ") }));
    }
  }

  const runningRows = runtimeModels.filter((m) => m.live);
  const usageLine = runningRows.length
    ? escapeHtml(fill(t("models.runtimeEstimatedRam", lang), {
        ram: (formatMb(estimatedRamMb) || "0 MB") + (estimatedVramMb > 0 ? " + " + (formatMb(estimatedVramMb) || "0 MB") + " VRAM" : ""),
      }))
    : escapeHtml(t("models.runtimeNoModelsRunning", lang));

  const rowsHtml = runtimeModels.map((m) => {
    // Task 13 fix round 1, finding c: "stopped_after_restart" is its own
    // distinct, honest state — a model that was resident when the gateway
    // last went down, not yet re-warmed — never conflated with a plain
    // never-started "Not running".
    const stateKey = m.live
      ? "models.runtimeStateRunning"
      : m.state === "unhealthy" ? "models.runtimeStateUnhealthy"
      : m.state === "stopped_after_restart" ? "models.runtimeStateReloading"
      : "models.runtimeStateStopped";
    const stateCell = m.state === "stopped_after_restart"
      ? escapeHtml(t(stateKey, lang)) + `<div class="mcat-strip__status">${escapeHtml(t("models.runtimeStateReloadingHint", lang))}</div>`
      : escapeHtml(t(stateKey, lang));
    const actionBtn = m.live
      ? button(t("models.actionStop", lang), { variant: "secondary", size: "sm", attrs: `data-action="stop" data-model-id="${escapeHtml(m.modelId)}"` })
      : button(t("models.actionStart", lang), { variant: "secondary", size: "sm", attrs: `data-action="start" data-model-id="${escapeHtml(m.modelId)}"` });
    return `<tr>
      <td class="mono">${escapeHtml(m.modelId)}</td>
      <td>${stateCell}</td>
      <td class="mono">${m.port != null ? escapeHtml(String(m.port)) : "—"}</td>
      <td class="mono">${m.pid != null ? escapeHtml(String(m.pid)) : "—"}</td>
      <td class="mono">${escapeHtml(String(m.restartCount || 0))}</td>
      <td>${m.lastError ? escapeHtml(String(m.lastError)) : "—"}</td>
      <td>${actionBtn}</td>
    </tr>`;
  }).join("");

  const table = runtimeModels.length
    ? `<table class="data-table" style="margin-top:0.75rem"><thead><tr>
        <th>${escapeHtml(t("models.runtimeColModel", lang))}</th>
        <th>${escapeHtml(t("models.runtimeColState", lang))}</th>
        <th>${escapeHtml(t("models.runtimeColPort", lang))}</th>
        <th>${escapeHtml(t("models.runtimeColPid", lang))}</th>
        <th>${escapeHtml(t("models.runtimeColRestarts", lang))}</th>
        <th>${escapeHtml(t("models.runtimeColLastError", lang))}</th>
        <th>${escapeHtml(t("models.runtimeColActions", lang))}</th>
      </tr></thead><tbody>${rowsHtml}</tbody></table>`
    : "";

  const noticesHtml = notices.map((n) => `<div class="mcat-strip__notice">${escapeHtml(n)}</div>`).join("");

  return `<div class="mcat-strip" id="mcat-runtime-strip">
    <div class="mcat-strip__title">${escapeHtml(t("models.runtimeHeading", lang))}</div>
    <div class="mcat-strip__line"><strong>${binaryLine}</strong></div>
    <div class="mcat-strip__line">${hardwareLine}</div>
    ${noticesHtml}
    <div class="mcat-strip__line">${usageLine}</div>
    <div id="mcat-active-downloads" class="mcat-strip__status"></div>
    ${table}
    <div class="mcat-strip__actions">
      ${button(t("models.runtimeReprobe", lang), { variant: "secondary", size: "sm", attrs: 'data-action="reprobe"' })}
      <span id="mcat-reprobe-status" class="mcat-strip__status"></span>
    </div>
  </div>`;
}

function renderModelCard(model, lang, hfTokenConfigured) {
  const defaultQuant = model.quants.find((q) => q.quant === model.default_quant) || model.quants[0] || null;

  const options = model.quants.map((q) => {
    const sel = q.quant === (defaultQuant && defaultQuant.quant) ? " selected" : "";
    const label = q.quant + " — " + (formatMb(q.size_mb) || "?") + " — " + t(fitLabelKey(q.fitBadge), lang);
    return `<option value="${escapeHtml(q.quant)}" data-fit="${escapeHtml(q.fitBadge)}" data-size-mb="${q.size_mb ?? ""}" data-min-ram-mb="${q.min_ram_mb ?? ""}"${sel}>${escapeHtml(label)}</option>`;
  }).join("");

  const quantSelect = model.quants.length > 1
    ? `<select class="mcat-quant-select" data-model-id="${escapeHtml(model.id)}" aria-label="${escapeHtml(t("models.quantLabel", lang))}">${options}</select>`
    : "";

  const initialFit = defaultQuant ? defaultQuant.fitBadge : "unknown";
  const fitPillHtml = `<span class="mcat-fit-hint" data-model-id="${escapeHtml(model.id)}">${renderFitPill(initialFit, lang)}</span>`;
  const fitHintHtml = `<div class="mcat-card__fit-hint" data-model-id="${escapeHtml(model.id)}">${escapeHtml(t(fitHintKey(initialFit), lang))}</div>`;

  const badges = [];
  if (model.first_run_default) badges.push(`<span class="mcat-card__badge mcat-card__badge--recommended">${escapeHtml(t("models.recommendedBadge", lang))}</span>`);
  if (model.gated) badges.push(`<span class="mcat-card__badge mcat-card__badge--gated">${escapeHtml(t("models.gatedBadge", lang))}</span>`);
  if (model.running) badges.push(`<span class="mcat-card__badge mcat-card__badge--running">${escapeHtml(t("models.statusRunning", lang))}</span>`);

  const otherTags = (model.tags || []).filter((tag) => !SIZE_CLASSES.includes(tag));
  const tagsHtml = otherTags.length
    ? `<div class="mcat-card__tags">${otherTags.map((tag) => `<span class="mcat-card__tag">${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";

  let gatedNotice = "";
  if (model.gated) {
    const key = hfTokenConfigured ? "models.gatedTokenConfigured" : "models.gatedNoToken";
    gatedNotice = `<div class="mcat-card__notice mcat-card__notice--warning">${escapeHtml(t(key, lang))}</div>`;
  }

  // Won't-fit: the Download action is not offered at all (per spec — no
  // override affordance in the curated UI); the reason is shown as text
  // instead. Tight/unknown: Download stays enabled, with the fit hint above
  // already showing the honest warning copy.
  let actionHtml;
  if (model.running) {
    actionHtml = `${button(t("models.actionStop", lang), { variant: "secondary", size: "sm", attrs: `data-action="stop" data-model-id="${escapeHtml(model.id)}"` })}` +
      `${button(t("models.actionRemove", lang), { variant: "danger", size: "sm", attrs: `data-action="remove" data-model-id="${escapeHtml(model.id)}"` })}`;
  } else if (model.registered) {
    actionHtml = `${button(t("models.actionStart", lang), { variant: "primary", size: "sm", attrs: `data-action="start" data-model-id="${escapeHtml(model.id)}"` })}` +
      `${button(t("models.actionRemove", lang), { variant: "danger", size: "sm", attrs: `data-action="remove" data-model-id="${escapeHtml(model.id)}"` })}`;
  } else if (initialFit === "wont_fit") {
    actionHtml = `<div class="mcat-card__notice">${escapeHtml(t("models.fitWontFitHint", lang))}</div>`;
  } else {
    actionHtml = button(t("models.actionDownload", lang), {
      variant: "primary", size: "sm",
      attrs: `data-action="download" data-model-id="${escapeHtml(model.id)}"`,
    });
  }

  return `<div class="mcat-card" data-model-id="${escapeHtml(model.id)}">
    <div class="mcat-card__head">
      <span class="mcat-card__title">${escapeHtml(model.id)}</span>
      ${badges.join("")}
    </div>
    <div class="mcat-card__meta">${escapeHtml(fill(t("models.cardLab", lang), { lab: model.lab || "?" }))} · ${escapeHtml(fill(t("models.cardLicense", lang), { license: model.license || "?" }))} · ${escapeHtml(fill(t("models.cardContext", lang), { n: model.context_len ?? "?" }))}</div>
    ${tagsHtml}
    ${model.notes ? `<p class="mcat-card__notes">${escapeHtml(model.notes)}</p>` : ""}
    <div class="mcat-card__quant-row">${quantSelect}${fitPillHtml}</div>
    ${fitHintHtml}
    ${gatedNotice}
    <div class="mcat-card__actions" data-model-id="${escapeHtml(model.id)}">${actionHtml}</div>
    <div class="mcat-card__status-text" data-model-id="${escapeHtml(model.id)}"></div>
    <div class="mcat-card__progress-track" data-model-id="${escapeHtml(model.id)}" hidden><div class="mcat-card__progress-bar"></div></div>
  </div>`;
}

function renderCuratedTab(data, lang) {
  const groups = groupBySizeClass(data.models);
  const order = [
    ["small", "models.groupSmall"],
    ["mid", "models.groupMid"],
    ["large", "models.groupLarge"],
    ["other", "models.groupOther"],
  ];
  const sections = order
    .filter(([key]) => groups[key].length > 0)
    .map(([key, titleKey]) => {
      const cards = groups[key].map((m) => renderModelCard(m, lang, data.hfTokenConfigured)).join("");
      return `<div class="mcat-group">
        <div class="mcat-group__title">${escapeHtml(t(titleKey, lang))}</div>
        <div class="mcat-grid">${cards}</div>
      </div>`;
    })
    .join("");

  if (!data.models.length) {
    return `<div class="mcat-empty">${escapeHtml(t("models.emptyCatalog", lang))}</div>`;
  }
  return sections;
}

function renderHfTab(data, lang) {
  const tokenStatus = data.hfTokenConfigured ? t("models.hfTokenConfigured", lang) : t("models.hfTokenNotConfigured", lang);
  return `
    ${callout(escapeHtml(t("models.hfIntro", lang)), "warning")}
    <div class="mcat-hf__search-row">
      <input type="text" id="mcat-hf-search-input" class="mcat-hf__search-input" placeholder="${escapeHtml(t("models.hfSearchPlaceholder", lang))}" aria-label="${escapeHtml(t("models.hfSearchLabel", lang))}">
      ${button(t("models.hfSearchButton", lang), { variant: "primary", size: "md", attrs: 'id="mcat-hf-search-btn"' })}
    </div>
    <div id="mcat-hf-status" class="mcat-strip__status"></div>
    <div id="mcat-hf-results" class="mcat-hf__results"></div>

    <div class="mcat-hf-token">
      <div class="mcat-hf-token__heading">${escapeHtml(t("models.hfTokenLabel", lang))}</div>
      <div id="mcat-hf-token-status" class="mcat-hf-token__status">${escapeHtml(tokenStatus)}</div>
      <div class="mcat-hf-token__row">
        <input type="password" id="mcat-hf-token-input" class="mcat-hf-token__input" autocomplete="off" placeholder="${escapeHtml(t("models.hfTokenPlaceholder", lang))}">
        ${button(t("models.hfTokenSave", lang), { variant: "primary", size: "sm", attrs: 'id="mcat-hf-token-save"' })}
        ${button(t("models.hfTokenClear", lang), { variant: "secondary", size: "sm", attrs: 'id="mcat-hf-token-clear"' })}
      </div>
      <div class="mcat-hf-token__hint">${escapeHtml(t("models.hfTokenHint", lang))}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Client-side JavaScript
// ---------------------------------------------------------------------------
//
// ABSOLUTE RULE: no backtick character below this line, inside the returned
// template literal's <script> content. Every browser-side string is single
// or double quoted; concatenation only.

function modelCatalogClientJS(lang) {
  return `
    <div id="mcat-modal-overlay">
      <div id="mcat-modal-content"></div>
    </div>

    <script>
      (function () {
        var API = "/api/models";

        function hideModal() { document.getElementById("mcat-modal-overlay").style.display = "none"; }
        function showModal() { document.getElementById("mcat-modal-overlay").style.display = "flex"; }
        document.getElementById("mcat-modal-overlay").addEventListener("click", function (e) {
          if (e.target === this) hideModal();
        });

        function apiFetch(path, opts) {
          var init = opts || {};
          init.headers = init.headers || { "Content-Type": "application/json" };
          return fetch(API + path, init).then(function (r) {
            return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }).catch(function () {
              return { ok: r.ok, status: r.status, data: {} };
            });
          });
        }

        function fmtBytes(n) {
          if (n === null || n === undefined || isNaN(n)) return "?";
          if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
          if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
          if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
          return n + " B";
        }

        var ERROR_MESSAGES = {
          NETWORK_DENIED: '${tJs("models.errNetworkDenied", lang)}',
          UNAUTHENTICATED: '${tJs("models.errUnauthenticated", lang)}',
          UNKNOWN_MODEL: '${tJs("models.errUnknownModel", lang)}',
          UNKNOWN_QUANT: '${tJs("models.errUnknownQuant", lang)}',
          NOT_INSTALLED: '${tJs("models.errNotInstalled", lang)}',
          START_FAILED: '${tJs("models.errStartFailed", lang)}',
          NOT_NATIVE: '${tJs("models.errNotNative", lang)}',
          MISSING_QUERY: '${tJs("models.errMissingQuery", lang)}',
          HF_UPSTREAM_ERROR: '${tJs("models.errHfUpstream", lang)}',
          BAD_TOKEN: '${tJs("models.errBadToken", lang)}',
          INTERNAL: '${tJs("models.errInternal", lang)}',
          WONT_FIT: '${tJs("models.errWontFit", lang)}',
          INVALID_HF_REPO: '${tJs("models.errInvalidHf", lang)}',
          INVALID_HF_FILE: '${tJs("models.errInvalidHf", lang)}',
          NO_VERIFIABLE_CHECKSUM: '${tJs("models.errNoVerifiableChecksum", lang)}',
          HF_FILE_NOT_FOUND: '${tJs("models.errHfUpstream", lang)}'
        };

        function messageFor(code, fallback) {
          return ERROR_MESSAGES[code] || fallback || '${tJs("models.errInternal", lang)}';
        }

        // --- Card status helpers ---
        function statusEl(modelId) { return document.querySelector('.mcat-card__status-text[data-model-id="' + modelId + '"]'); }
        function progressTrack(modelId) { return document.querySelector('.mcat-card__progress-track[data-model-id="' + modelId + '"]'); }
        function setStatus(modelId, text) {
          var el = statusEl(modelId);
          if (el) el.textContent = text;
        }
        function setProgress(modelId, pct, visible) {
          var track = progressTrack(modelId);
          if (!track) return;
          track.hidden = !visible;
          var bar = track.querySelector(".mcat-card__progress-bar");
          if (bar) bar.style.width = (pct || 0) + "%";
        }

        // --- Quant select -> fit pill/hint live update ---
        document.querySelectorAll(".mcat-quant-select").forEach(function (sel) {
          sel.addEventListener("change", function () {
            var modelId = sel.dataset.modelId;
            var opt = sel.options[sel.selectedIndex];
            var fit = opt.getAttribute("data-fit") || "unknown";
            var pillWrap = document.querySelector('.mcat-fit-hint[data-model-id="' + modelId + '"]');
            if (pillWrap) {
              pillWrap.replaceChildren();
              var span = document.createElement("span");
              span.className = "mcat-fit-pill mcat-fit-pill--" + fit;
              span.textContent = FIT_LABELS[fit] || FIT_LABELS.unknown;
              pillWrap.appendChild(span);
            }
            var hint = document.querySelector('.mcat-card__fit-hint[data-model-id="' + modelId + '"]');
            if (hint) hint.textContent = FIT_HINTS[fit] || FIT_HINTS.unknown;
          });
        });

        var FIT_LABELS = {
          fits: '${tJs("models.fitFits", lang)}',
          tight: '${tJs("models.fitTight", lang)}',
          wont_fit: '${tJs("models.fitWontFit", lang)}',
          unknown: '${tJs("models.fitUnknown", lang)}'
        };
        var FIT_HINTS = {
          fits: '${tJs("models.fitFitsHint", lang)}',
          tight: '${tJs("models.fitTightHint", lang)}',
          wont_fit: '${tJs("models.fitWontFitHint", lang)}',
          unknown: '${tJs("models.fitUnknownHint", lang)}'
        };

        // --- Download flow ---
        function pollDownload(jobId, modelId) {
          apiFetch("/downloads").then(function (res) {
            if (!res.ok) { setStatus(modelId, messageFor("INTERNAL")); return; }
            var job = (res.data.downloads || []).filter(function (j) { return j.id === jobId; })[0];
            if (!job) { setTimeout(function () { pollDownload(jobId, modelId); }, 1500); return; }
            if (job.status === "downloading" || job.status === "registering") {
              var pct = job.totalBytes ? Math.round((job.bytesDone / job.totalBytes) * 100) : 0;
              setProgress(modelId, pct, true);
              var label = job.status === "registering"
                ? '${tJs("models.actionRegistering", lang)}'
                : '${tJs("models.actionDownloading", lang)}' + " " + fmtBytes(job.bytesDone) + (job.totalBytes ? " / " + fmtBytes(job.totalBytes) : "");
              setStatus(modelId, label);
              setTimeout(function () { pollDownload(jobId, modelId); }, 1500);
            } else if (job.status === "done") {
              setProgress(modelId, 100, false);
              var card = document.querySelector('.mcat-card[data-model-id="' + modelId + '"]');
              var actions = card ? card.querySelector(".mcat-card__actions") : null;
              if (actions) {
                actions.replaceChildren();
                var link = document.createElement("a");
                link.className = "btn btn-primary btn-sm";
                link.href = "/dashboard/messages";
                link.textContent = '${tJs("models.actionTryInChat", lang)}';
                actions.appendChild(link);
              }
              setStatus(modelId, '${tJs("models.downloadSuccess", lang)}');
            } else if (job.status === "error") {
              setProgress(modelId, 0, false);
              var raw = job.error || "";
              // Task 13 fix round 1, finding d: keys off the TYPED error
              // code manager.js's HttpStatusError now attaches to the job
              // (errorCode === "HTTP_403"), never string-matching the raw
              // message — a message-format change can no longer silently
              // break this detection.
              var gated = card_isGated(modelId);
              var looksLicense = gated && job.errorCode === "HTTP_403";
              var msg = looksLicense
                ? '${tJs("models.downloadErrorGated", lang)}'
                : messageFor(job.errorCode, raw);
              setStatus(modelId, msg);
              var card2 = document.querySelector('.mcat-card[data-model-id="' + modelId + '"]');
              var actions2 = card2 ? card2.querySelector(".mcat-card__actions") : null;
              if (actions2) {
                actions2.replaceChildren();
                var retryBtn = document.createElement("button");
                retryBtn.type = "button";
                retryBtn.className = "btn btn-primary btn-sm";
                retryBtn.setAttribute("data-action", "download");
                retryBtn.setAttribute("data-model-id", modelId);
                retryBtn.textContent = '${tJs("models.actionRetry", lang)}';
                actions2.appendChild(retryBtn);
              }
            }
          }).catch(function () {
            setTimeout(function () { pollDownload(jobId, modelId); }, 3000);
          });
        }

        function card_isGated(modelId) {
          var card = document.querySelector('.mcat-card[data-model-id="' + modelId + '"]');
          return !!(card && card.querySelector(".mcat-card__badge--gated"));
        }

        function startDownload(modelId) {
          var sel = document.querySelector('.mcat-quant-select[data-model-id="' + modelId + '"]');
          var quant = sel ? sel.value : null;
          var fit = "fits";
          if (sel) {
            var opt = sel.options[sel.selectedIndex];
            fit = opt.getAttribute("data-fit") || "fits";
          } else {
            var pill = document.querySelector('.mcat-fit-hint[data-model-id="' + modelId + '"] .mcat-fit-pill');
            if (pill) {
              var m = pill.className.match(/mcat-fit-pill--(\\S+)/);
              if (m) fit = m[1];
            }
          }
          setStatus(modelId, '${tJs("models.actionDownloading", lang)}');
          apiFetch("/download", {
            method: "POST",
            body: JSON.stringify({ modelId: modelId, quant: quant, force: fit !== "fits" })
          }).then(function (res) {
            if (res.ok || res.status === 202) {
              pollDownload(res.data.jobId, modelId);
            } else {
              setStatus(modelId, messageFor(res.data.code, res.data.error));
            }
          }).catch(function () {
            setStatus(modelId, messageFor("INTERNAL"));
          });
        }

        // --- Start / stop ---
        function startModel(modelId) {
          setStatus(modelId, '${tJs("models.actionStarting", lang)}');
          apiFetch("/" + encodeURIComponent(modelId) + "/start", { method: "POST" }).then(function (res) {
            if (res.ok) {
              setTimeout(function () { location.reload(); }, 1200);
            } else {
              setStatus(modelId, messageFor(res.data.code, res.data.error));
            }
          }).catch(function () { setStatus(modelId, messageFor("INTERNAL")); });
        }

        function stopModel(modelId) {
          setStatus(modelId, '${tJs("models.actionStopping", lang)}');
          apiFetch("/" + encodeURIComponent(modelId) + "/stop", { method: "POST" }).then(function (res) {
            if (res.ok) {
              setTimeout(function () { location.reload(); }, 1000);
            } else {
              setStatus(modelId, messageFor(res.data.code, res.data.error));
            }
          }).catch(function () { setStatus(modelId, messageFor("INTERNAL")); });
        }

        // --- Delete (confirm-then-delete) ---
        function showDeleteConfirm(modelId, bindings) {
          var frag = document.createElement("div");

          var title = document.createElement("div");
          title.className = "mcat-modal__title";
          title.textContent = '${tJs("models.deleteConfirmTitle", lang)}'.replace("{model}", modelId);
          frag.appendChild(title);

          var intro = document.createElement("p");
          intro.textContent = '${tJs("models.deleteConfirmIntro", lang)}';
          frag.appendChild(intro);

          var profiles = (bindings && bindings.profiles) || [];
          var bots = (bindings && bindings.bots) || [];
          if (profiles.length === 0 && bots.length === 0) {
            var none = document.createElement("p");
            none.textContent = '${tJs("models.deleteNoBindings", lang)}';
            frag.appendChild(none);
          } else {
            var bindIntro = document.createElement("p");
            bindIntro.textContent = '${tJs("models.deleteBindingsIntro", lang)}';
            frag.appendChild(bindIntro);
            var list = document.createElement("ul");
            list.className = "mcat-modal__list";
            profiles.forEach(function (p) {
              var li = document.createElement("li");
              li.textContent = (p && p.name) ? p.name : (p && p.id) || "?";
              list.appendChild(li);
            });
            bots.forEach(function (b) {
              var li = document.createElement("li");
              li.textContent = (b && b.display_name) ? b.display_name : (b && b.bot_id) || "?";
              list.appendChild(li);
            });
            frag.appendChild(list);
          }

          var actions = document.createElement("div");
          actions.className = "mcat-modal__actions";

          var cancelBtn = document.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.className = "btn btn-secondary btn-sm";
          cancelBtn.textContent = '${tJs("models.deleteCancelButton", lang)}';
          cancelBtn.addEventListener("click", hideModal);
          actions.appendChild(cancelBtn);

          var confirmBtn = document.createElement("button");
          confirmBtn.type = "button";
          confirmBtn.className = "btn btn-danger btn-sm";
          confirmBtn.textContent = '${tJs("models.deleteConfirmButton", lang)}';
          confirmBtn.addEventListener("click", function () {
            confirmBtn.disabled = true;
            apiFetch("/" + encodeURIComponent(modelId) + "?confirm=true", { method: "DELETE" }).then(function (res) {
              hideModal();
              if (res.ok) {
                setStatus(modelId, '${tJs("models.deleteSuccess", lang)}');
                setTimeout(function () { location.reload(); }, 800);
              } else {
                setStatus(modelId, messageFor(res.data.code, res.data.error));
              }
            }).catch(function () {
              hideModal();
              setStatus(modelId, messageFor("INTERNAL"));
            });
          });
          actions.appendChild(confirmBtn);
          frag.appendChild(actions);

          var mc = document.getElementById("mcat-modal-content");
          mc.replaceChildren();
          mc.appendChild(frag);
          showModal();
        }

        function requestDelete(modelId) {
          apiFetch("/" + encodeURIComponent(modelId), { method: "DELETE" }).then(function (res) {
            if (res.ok && res.data && res.data.requiresConfirm) {
              showDeleteConfirm(modelId, res.data.bindings);
            } else if (!res.ok) {
              setStatus(modelId, messageFor(res.data.code, res.data.error));
            }
          }).catch(function () { setStatus(modelId, messageFor("INTERNAL")); });
        }

        // --- Delegated action clicks ---
        document.addEventListener("click", function (e) {
          var el = e.target.closest("[data-action]");
          if (!el) return;
          var action = el.getAttribute("data-action");
          var modelId = el.getAttribute("data-model-id");
          if (action === "download" && modelId) startDownload(modelId);
          else if (action === "start" && modelId) startModel(modelId);
          else if (action === "stop" && modelId) stopModel(modelId);
          else if (action === "remove" && modelId) requestDelete(modelId);
          else if (action === "reprobe") {
            var statusSpan = document.getElementById("mcat-reprobe-status");
            if (statusSpan) statusSpan.textContent = '${tJs("models.runtimeReprobing", lang)}';
            apiFetch("/reprobe", { method: "POST" }).then(function () {
              location.reload();
            }).catch(function () {
              if (statusSpan) statusSpan.textContent = messageFor("INTERNAL");
            });
          }
        });

        // --- Runtime strip: active downloads count (refreshed independently) ---
        function refreshActiveDownloads() {
          apiFetch("/downloads").then(function (res) {
            if (!res.ok) return;
            var active = (res.data.downloads || []).filter(function (j) {
              return j.status === "downloading" || j.status === "registering";
            });
            var el = document.getElementById("mcat-active-downloads");
            if (!el) return;
            el.textContent = active.length > 0
              ? '${tJs("models.runtimeActiveDownloads", lang)}'.replace("{n}", String(active.length))
              : "";
          }).catch(function () {});
        }
        refreshActiveDownloads();
        setInterval(refreshActiveDownloads, 5000);

        // --- Browse Hugging Face downloads (Task 13 fix round 1, finding 1) ---
        //
        // Each search result can list several GGUF files; a download
        // targets ONE specific (repo, file) pair, so each file gets its
        // own row with its own status/progress/actions — captured via
        // closures (not the delegated data-action pattern the curated
        // cards use), since a repo/file string can contain characters that
        // are awkward to round-trip through a CSS attribute selector.

        function pollHfDownload(jobId, statusSpan, progressTrack, actions, repoId, file) {
          apiFetch("/downloads").then(function (res) {
            if (!res.ok) { statusSpan.textContent = messageFor("INTERNAL"); return; }
            var job = (res.data.downloads || []).filter(function (j) { return j.id === jobId; })[0];
            if (!job) {
              setTimeout(function () { pollHfDownload(jobId, statusSpan, progressTrack, actions, repoId, file); }, 1500);
              return;
            }
            if (job.status === "downloading" || job.status === "registering") {
              var pct = job.totalBytes ? Math.round((job.bytesDone / job.totalBytes) * 100) : 0;
              progressTrack.hidden = false;
              var bar = progressTrack.querySelector(".mcat-card__progress-bar");
              if (bar) bar.style.width = pct + "%";
              statusSpan.textContent = job.status === "registering"
                ? '${tJs("models.actionRegistering", lang)}'
                : '${tJs("models.actionDownloading", lang)}' + " " + fmtBytes(job.bytesDone) + (job.totalBytes ? " / " + fmtBytes(job.totalBytes) : "");
              setTimeout(function () { pollHfDownload(jobId, statusSpan, progressTrack, actions, repoId, file); }, 1500);
            } else if (job.status === "done") {
              progressTrack.hidden = true;
              statusSpan.textContent = '${tJs("models.downloadSuccess", lang)}';
              actions.replaceChildren();
              var link = document.createElement("a");
              link.className = "btn btn-primary btn-sm";
              link.href = "/dashboard/messages";
              link.textContent = '${tJs("models.actionTryInChat", lang)}';
              actions.appendChild(link);
            } else if (job.status === "error") {
              progressTrack.hidden = true;
              // Finding d: keys off the typed HTTP_403 code, not string-matching.
              var looksLicense = job.errorCode === "HTTP_403";
              statusSpan.textContent = looksLicense
                ? '${tJs("models.downloadErrorGated", lang)}'
                : messageFor(job.errorCode, job.error);
              actions.replaceChildren();
              var retryBtn = document.createElement("button");
              retryBtn.type = "button";
              retryBtn.className = "btn btn-primary btn-sm";
              retryBtn.textContent = '${tJs("models.actionRetry", lang)}';
              retryBtn.addEventListener("click", function () {
                showHfDownloadConfirm(repoId, file, false, statusSpan, progressTrack, actions);
              });
              actions.appendChild(retryBtn);
            }
          }).catch(function () {
            setTimeout(function () { pollHfDownload(jobId, statusSpan, progressTrack, actions, repoId, file); }, 3000);
          });
        }

        function startHfDownload(repoId, file, statusSpan, progressTrack, actions, force) {
          actions.replaceChildren();
          statusSpan.textContent = '${tJs("models.actionDownloading", lang)}';
          apiFetch("/hf-download", {
            method: "POST",
            body: JSON.stringify({ hfRepo: repoId, file: file, force: !!force })
          }).then(function (res) {
            if (res.ok || res.status === 202) {
              pollHfDownload(res.data.jobId, statusSpan, progressTrack, actions, repoId, file);
              return;
            }
            if (res.data && res.data.code === "WONT_FIT") {
              statusSpan.textContent = messageFor("WONT_FIT", res.data.error);
              var forceBtn = document.createElement("button");
              forceBtn.type = "button";
              forceBtn.className = "btn btn-danger btn-sm";
              forceBtn.textContent = '${tJs("models.actionForceDownload", lang)}';
              forceBtn.addEventListener("click", function () {
                startHfDownload(repoId, file, statusSpan, progressTrack, actions, true);
              });
              actions.appendChild(forceBtn);
              return;
            }
            statusSpan.textContent = messageFor(res.data && res.data.code, res.data && res.data.error);
            var retryBtn = document.createElement("button");
            retryBtn.type = "button";
            retryBtn.className = "btn btn-primary btn-sm";
            retryBtn.textContent = '${tJs("models.actionRetry", lang)}';
            retryBtn.addEventListener("click", function () {
              showHfDownloadConfirm(repoId, file, false, statusSpan, progressTrack, actions);
            });
            actions.appendChild(retryBtn);
          }).catch(function () {
            statusSpan.textContent = messageFor("INTERNAL");
          });
        }

        function showHfDownloadConfirm(repoId, file, gated, statusSpan, progressTrack, actions) {
          var frag = document.createElement("div");

          var title = document.createElement("div");
          title.className = "mcat-modal__title";
          title.textContent = '${tJs("models.hfDownloadConfirmTitle", lang)}'.replace("{file}", file);
          frag.appendChild(title);

          var warn = document.createElement("p");
          warn.textContent = '${tJs("models.hfDownloadConfirmWarning", lang)}';
          frag.appendChild(warn);

          if (gated) {
            var gatedP = document.createElement("p");
            gatedP.textContent = mcat_hfTokenConfigured
              ? '${tJs("models.hfGatedWithToken", lang)}'
              : '${tJs("models.hfGatedNoToken", lang)}';
            frag.appendChild(gatedP);
          }

          var modalActions = document.createElement("div");
          modalActions.className = "mcat-modal__actions";

          var cancelBtn = document.createElement("button");
          cancelBtn.type = "button";
          cancelBtn.className = "btn btn-secondary btn-sm";
          cancelBtn.textContent = '${tJs("models.deleteCancelButton", lang)}';
          cancelBtn.addEventListener("click", hideModal);
          modalActions.appendChild(cancelBtn);

          var confirmBtn = document.createElement("button");
          confirmBtn.type = "button";
          confirmBtn.className = "btn btn-primary btn-sm";
          confirmBtn.textContent = '${tJs("models.hfDownloadConfirmButton", lang)}';
          confirmBtn.addEventListener("click", function () {
            hideModal();
            startHfDownload(repoId, file, statusSpan, progressTrack, actions, false);
          });
          modalActions.appendChild(confirmBtn);
          frag.appendChild(modalActions);

          var mc = document.getElementById("mcat-modal-content");
          mc.replaceChildren();
          mc.appendChild(frag);
          showModal();
        }

        function buildHfFileRow(repoId, file, gated) {
          var row = document.createElement("div");
          row.className = "mcat-hf-result__file-row";

          var nameSpan = document.createElement("span");
          nameSpan.className = "mcat-hf-result__file-name mono";
          nameSpan.textContent = file;
          row.appendChild(nameSpan);

          var statusSpan = document.createElement("span");
          statusSpan.className = "mcat-card__status-text";
          row.appendChild(statusSpan);

          var actions = document.createElement("span");
          actions.className = "mcat-hf-result__file-actions";
          var downloadBtn = document.createElement("button");
          downloadBtn.type = "button";
          downloadBtn.className = "btn btn-primary btn-sm";
          downloadBtn.textContent = '${tJs("models.actionDownload", lang)}';
          downloadBtn.addEventListener("click", function () {
            showHfDownloadConfirm(repoId, file, gated, statusSpan, progressTrack, actions);
          });
          actions.appendChild(downloadBtn);
          row.appendChild(actions);

          var progressTrack = document.createElement("div");
          progressTrack.className = "mcat-card__progress-track";
          progressTrack.hidden = true;
          var progressBar = document.createElement("div");
          progressBar.className = "mcat-card__progress-bar";
          progressTrack.appendChild(progressBar);
          row.appendChild(progressTrack);

          return row;
        }

        // --- Browse Hugging Face search ---
        function renderHfResults(results) {
          var wrap = document.getElementById("mcat-hf-results");
          wrap.replaceChildren();
          if (!results || results.length === 0) {
            var empty = document.createElement("div");
            empty.className = "mcat-strip__status";
            empty.textContent = '${tJs("models.hfSearchEmpty", lang)}';
            wrap.appendChild(empty);
            return;
          }
          results.forEach(function (r) {
            var card = document.createElement("div");
            card.className = "mcat-hf-result";

            var title = document.createElement("div");
            title.className = "mcat-hf-result__title";
            title.textContent = r.id;
            card.appendChild(title);

            var meta = document.createElement("div");
            meta.className = "mcat-hf-result__meta";
            var parts = [];
            if (typeof r.downloads === "number") parts.push('${tJs("models.hfResultDownloads", lang)}'.replace("{n}", String(r.downloads)));
            if (typeof r.likes === "number") parts.push('${tJs("models.hfResultLikes", lang)}'.replace("{n}", String(r.likes)));
            parts.push(r.license ? r.license : '${tJs("models.hfResultLicenseUnknown", lang)}');
            parts.push('${tJs("models.hfResultFiles", lang)}'.replace("{n}", String((r.ggufFiles || []).length)));
            meta.textContent = parts.join(" · ");
            card.appendChild(meta);

            var pillWrap = document.createElement("div");
            pillWrap.style.marginTop = "0.3rem";
            var pill = document.createElement("span");
            pill.className = "mcat-fit-pill mcat-fit-pill--unknown";
            pill.textContent = FIT_LABELS.unknown;
            pillWrap.appendChild(pill);
            card.appendChild(pillWrap);

            var fitNotice = document.createElement("div");
            fitNotice.className = "mcat-hf-result__notice";
            fitNotice.textContent = '${tJs("models.hfFitUnknownHint", lang)}';
            card.appendChild(fitNotice);

            if (r.gated) {
              var gatedNotice = document.createElement("div");
              gatedNotice.className = "mcat-hf-result__notice";
              gatedNotice.textContent = mcat_hfTokenConfigured
                ? '${tJs("models.hfGatedWithToken", lang)}'
                : '${tJs("models.hfGatedNoToken", lang)}';
              card.appendChild(gatedNotice);
            }

            var link = document.createElement("a");
            link.href = "https://huggingface.co/" + r.id;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.className = "mcat-hf-result__notice";
            link.style.display = "inline-block";
            link.style.marginTop = "0.35rem";
            link.textContent = '${tJs("models.hfViewOnHf", lang)}';
            card.appendChild(link);

            var files = r.ggufFiles || [];
            if (files.length > 0) {
              var filesWrap = document.createElement("div");
              filesWrap.className = "mcat-hf-result__files-list";
              files.forEach(function (f) {
                filesWrap.appendChild(buildHfFileRow(r.id, f, !!r.gated));
              });
              card.appendChild(filesWrap);
            }

            wrap.appendChild(card);
          });
        }

        function runHfSearch() {
          var input = document.getElementById("mcat-hf-search-input");
          var q = input ? input.value.trim() : "";
          var statusEl2 = document.getElementById("mcat-hf-status");
          if (!q) { if (statusEl2) statusEl2.textContent = messageFor("MISSING_QUERY"); return; }
          if (statusEl2) statusEl2.textContent = '${tJs("models.hfSearching", lang)}';
          apiFetch("/hf-search?q=" + encodeURIComponent(q)).then(function (res) {
            if (statusEl2) statusEl2.textContent = "";
            if (res.ok) {
              renderHfResults(res.data.results);
            } else {
              if (statusEl2) statusEl2.textContent = messageFor(res.data.code, res.data.error);
            }
          }).catch(function () {
            if (statusEl2) statusEl2.textContent = messageFor("HF_UPSTREAM_ERROR");
          });
        }

        var hfSearchBtn = document.getElementById("mcat-hf-search-btn");
        if (hfSearchBtn) hfSearchBtn.addEventListener("click", runHfSearch);
        var hfSearchInput = document.getElementById("mcat-hf-search-input");
        if (hfSearchInput) hfSearchInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); runHfSearch(); }
        });

        // --- HF token save/clear ---
        var mcat_hfTokenConfigured = ${JSON.stringify(false)};
        apiFetch("/hf-token").then(function (res) {
          if (res.ok) {
            mcat_hfTokenConfigured = !!res.data.configured;
            var statusDiv = document.getElementById("mcat-hf-token-status");
            if (statusDiv) statusDiv.textContent = mcat_hfTokenConfigured
              ? '${tJs("models.hfTokenConfigured", lang)}'
              : '${tJs("models.hfTokenNotConfigured", lang)}';
          }
        }).catch(function () {});

        function saveOrClearToken(value) {
          var statusDiv = document.getElementById("mcat-hf-token-status");
          apiFetch("/hf-token", { method: "POST", body: JSON.stringify({ token: value }) }).then(function (res) {
            var input = document.getElementById("mcat-hf-token-input");
            if (input) input.value = "";
            if (res.ok) {
              mcat_hfTokenConfigured = !!res.data.configured;
              if (statusDiv) statusDiv.textContent = mcat_hfTokenConfigured
                ? '${tJs("models.hfTokenSaved", lang)}'
                : '${tJs("models.hfTokenCleared", lang)}';
            } else if (statusDiv) {
              statusDiv.textContent = '${tJs("models.hfTokenSaveFailed", lang)}'.replace("{error}", messageFor(res.data.code, res.data.error));
            }
          }).catch(function () {
            if (statusDiv) statusDiv.textContent = '${tJs("models.hfTokenSaveFailed", lang)}'.replace("{error}", messageFor("INTERNAL"));
          });
        }

        var saveBtn = document.getElementById("mcat-hf-token-save");
        if (saveBtn) saveBtn.addEventListener("click", function () {
          var input = document.getElementById("mcat-hf-token-input");
          saveOrClearToken(input ? input.value.trim() : "");
        });
        var clearBtn = document.getElementById("mcat-hf-token-clear");
        if (clearBtn) clearBtn.addEventListener("click", function () { saveOrClearToken(""); });
      })();
    </script>`;
}

// ---------------------------------------------------------------------------
// Panel export
// ---------------------------------------------------------------------------

export default {
  id: "model-catalog",
  name: "Model Catalog",
  icon: "models",
  route: "/dashboard/model-catalog",
  navOrder: 16,
  category: "ai",

  async handler(req, res, { db, layout, lang }) {
    let data;
    try {
      data = await loadPanelData({ db });
    } catch (err) {
      const content = `<div class="mcat-empty">${escapeHtml(t("models.emptyCatalog", lang))} (${escapeHtml(err.message)})</div>`;
      return layout({ title: t("models.pageTitle", lang), content });
    }

    const tabsHtml = tabs([
      { id: "curated", label: t("models.tabCurated", lang), content: renderCuratedTab(data, lang) },
      { id: "browse-hf", label: t("models.tabBrowseHf", lang), content: renderHfTab(data, lang) },
    ]);

    const content = `
      ${panelStyles()}
      <p class="mcat-intro">${escapeHtml(t("models.pageIntro", lang))}</p>
      ${renderRuntimeStrip(data, lang)}
      ${tabsHtml}
      ${modelCatalogClientJS(lang)}
    `;

    return layout({ title: t("models.pageTitle", lang), content });
  },
};
