/**
 * Model catalog panel API routes (Item G, Task 12).
 *
 * Dashboard-session-gated JSON routes the models panel (Task 13) drives:
 * catalog browsing (with per-quant fit badges), hardware probe, GGUF
 * downloads (with journaled progress), install/uninstall, start/stop of a
 * native llama.cpp process, and a Hugging Face search proxy + token store.
 *
 * Auth: every route under `/api/models` is gated by
 * `requireDashboardSessionJson` below, NOT the redirect-based
 * `dashboardAuth` middleware every other panel router uses. This is a
 * deliberate choice, not an oversight: `dashboardAuth` 302-redirects an
 * unauthenticated request to `/dashboard/login`, which is correct for a
 * browser navigation but wrong for a JSON API a client-side panel polls
 * (download progress, runtime status) — a redirect response to a `fetch()`
 * caller is not obviously distinguishable from success without extra
 * client-side plumbing every other panel API in this codebase also skips.
 * `requireDashboardSessionJson` runs the SAME two checks `dashboardAuth`
 * does (`isAllowedNetwork`, then the `crow_session` cookie via
 * `verifySession`) but answers with `401`/`403` JSON instead — the same
 * pattern `routes/admin-backup.js`'s `requireLocalhost`/`requireToken` and
 * `routes/audio-proxy.js`'s `peer_auth_required` already use for JSON-only
 * routes in this codebase. `dashboardAuth` is still accepted as this
 * factory's first argument (unused) purely so the call site in
 * `boot/feature-mounts.js` matches every sibling router's
 * `xRouter(dashboardAuth)` shape.
 *
 * NEVER add `/api/models` to `PUBLIC_FUNNEL_PREFIXES` — see CLAUDE.md's
 * "Network exposure invariant".
 *
 * No CSRF middleware here: matching `routes/push.js`/`routes/notifications.js`
 * (state-changing JSON routes mounted at the app root, outside the
 * `/dashboard` router `csrfMiddleware` is scoped to) — the session cookie
 * itself (HttpOnly, SameSite=Lax) is this route family's only defense
 * against cross-origin calls, identical to its siblings.
 *
 * HF token storage: `POST /api/models/hf-token` reuses the EXACT storage
 * path Settings -> Providers uses for cloud-provider API keys —
 * `servers/shared/providers-db.js`'s `upsertProvider`/`listProvidersAll`,
 * i.e. the `providers.api_key` column — under a reserved id
 * (`HF_TOKEN_PROVIDER_ID`) that is always `disabled: true` with an empty
 * `models: []` array, so it is never a candidate for chat routing, mutex
 * arbitration, or the Providers-tab's enabled-row rendering paths (all of
 * which either skip disabled rows or key off `models[].task === "chat"`).
 * UNLIKE a real cloud-provider key, this row is never broadcast to paired
 * instances: it carries `gpu_policy: { local_only: true }`, a marker
 * `shouldSyncRow`'s providers branch (`servers/sharing/instance-sync.js`)
 * checks and excludes on BOTH emit and apply — see that function's doc for
 * why this is a general convention (any providers row can opt out this
 * way), not a hardcoded check against this one reserved id.
 */

import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { createDbClient, resolveDataDir } from "../../db.js";
import { isAllowedNetwork, verifySession, parseCookies } from "../dashboard/auth.js";
import { listProvidersAll, upsertProvider } from "../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../shared/providers.js";
import { getCachedProbe, reprobe, fitBadge } from "../models/probe.js";
import { loadState } from "../models/state.js";
import { enqueueDownload, registerModel, unregisterModel, providerBindings } from "../models/manager.js";
import { getStatusSnapshot } from "../models/runtime.js";
import { getNativeHandle, maybeAcquireLocalProvider } from "../gpu-orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
// routes/models.js -> gateway -> servers -> repo root -> registry/model-catalog.json
const MODEL_CATALOG_PATH = resolvePath(dirname(__filename), "..", "..", "..", "registry", "model-catalog.json");

/** Reserved provider id the Hugging Face API token is stashed under — see
 * the module doc's "HF token storage" section. Namespaced well outside any
 * real catalog model id shape (those are bare family slugs like
 * "qwen3-4b") so a future catalog entry can never collide with it. */
export const HF_TOKEN_PROVIDER_ID = "crow-hf-token";

const SESSION_COOKIE = "crow_session";
const HF_SEARCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Auth (JSON-answering — see module doc)
// ---------------------------------------------------------------------------

/** Exported for direct unit testing without booting a whole express app. */
export function requireDashboardSessionJson(req, res, next) {
  if (!isAllowedNetwork(req)) {
    return res.status(403).json({ error: "Not reachable from this network", code: "NETWORK_DENIED" });
  }
  const token = parseCookies(req)[SESSION_COOKIE];
  verifySession(token)
    .then((valid) => {
      if (!valid) return res.status(401).json({ error: "Not authenticated", code: "UNAUTHENTICATED" });
      req.dashboardSession = token;
      next();
    })
    .catch(() => res.status(401).json({ error: "Not authenticated", code: "UNAUTHENTICATED" }));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function defaultLoadCatalog() {
  return JSON.parse(readFileSync(MODEL_CATALOG_PATH, "utf8"));
}

function findModel(catalog, modelId) {
  if (typeof modelId !== "string" || !modelId) return null;
  return (catalog?.models || []).find((m) => m.id === modelId) || null;
}

function findQuant(model, quant) {
  const quantId = quant || model.default_quant;
  const entry = (model?.quants || []).find((q) => q.quant === quantId);
  return entry ? { quantId, entry } : null;
}

function jobIdFor(modelId, quant) {
  return `${modelId}::${quant}`;
}

function publicJob(job) {
  return {
    id: job.id,
    modelId: job.modelId,
    quant: job.quant,
    status: job.status,
    bytesDone: job.bytesDone,
    totalBytes: job.totalBytes,
    startedAt: job.startedAt,
    error: job.error,
    errorCode: job.errorCode,
    providerId: job.providerId,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * @param {Function} dashboardAuth - accepted for call-site parity with every
 *   sibling router (`xRouter(dashboardAuth)`); NOT used — see module doc.
 * @param {object} [opts] - injectable seams (tests only; production omits
 *   all of these, using the real implementations imported above).
 */
export default function modelsRouter(dashboardAuth, opts = {}) {
  const {
    dir: staticDir,
    dbFactory = createDbClient,
    loadCatalogFn = defaultLoadCatalog,
    getCachedProbeFn = getCachedProbe,
    reprobeFn = reprobe,
    fitBadgeFn = fitBadge,
    loadStateFn = loadState,
    enqueueDownloadFn = enqueueDownload,
    registerModelFn = registerModel,
    unregisterModelFn = unregisterModel,
    providerBindingsFn = providerBindings,
    listProvidersAllFn = listProvidersAll,
    upsertProviderFn = upsertProvider,
    invalidateCacheFn = invalidateProvidersCache,
    getStatusSnapshotFn = getStatusSnapshot,
    getNativeHandleFn = getNativeHandle,
    maybeAcquireLocalProviderFn = maybeAcquireLocalProvider,
    hfApiBase = "https://huggingface.co",
    fetchImplFn = fetch,
    hfSearchTimeoutMs = HF_SEARCH_TIMEOUT_MS,
  } = opts;

  const router = Router();

  function resolveDir() {
    return typeof staticDir === "string" && staticDir ? staticDir : resolveDataDir();
  }

  async function getHfToken(db) {
    const providers = await listProvidersAllFn(db);
    const row = providers.find((p) => p.id === HF_TOKEN_PROVIDER_ID);
    return row?.apiKey || null;
  }

  // Every /api/models/* route requires a valid dashboard session — see
  // module doc for why this is a bespoke JSON-answering gate, not the
  // redirect-based `dashboardAuth` param above.
  router.use("/api/models", requireDashboardSessionJson);

  // In-memory download-job tracker (module-scope map keyed by
  // "<modelId>::<quant>", one gateway process, matches `manager.js`'s
  // `enqueueDownload` idempotency key). Lost on restart by design — a
  // restarted gateway resumes an interrupted download from `state.js`'s
  // on-disk journal (see `manager.js`'s `downloadModel` doc), it just
  // shows up here as a fresh job the next time it's (re-)triggered.
  const downloadJobs = new Map();

  // --- Catalog -------------------------------------------------------------

  router.get("/api/models/catalog", (req, res) => {
    try {
      const catalog = loadCatalogFn();
      const probe = getCachedProbeFn();
      const state = loadStateFn(resolveDir());
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
      res.json({
        runtime: { name: catalog.runtime?.name ?? null, release: catalog.runtime?.release ?? null },
        probe,
        models,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    }
  });

  // --- Hardware probe --------------------------------------------------------

  router.get("/api/models/probe", (req, res) => {
    res.json({ probe: getCachedProbeFn() });
  });

  router.post("/api/models/reprobe", async (req, res) => {
    try {
      const probe = await reprobeFn({ modelsDir: resolveDir() });
      res.json({ probe });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    }
  });

  // --- Downloads -------------------------------------------------------------

  router.post("/api/models/download", async (req, res) => {
    try {
      const { modelId, quant, force } = req.body || {};
      const catalog = loadCatalogFn();
      const model = findModel(catalog, modelId);
      if (!model) {
        return res.status(400).json({ error: `Unknown model id: ${modelId}`, code: "UNKNOWN_MODEL" });
      }
      const resolved = findQuant(model, quant);
      if (!resolved) {
        return res.status(400).json({ error: `Unknown quant for ${modelId}: ${quant}`, code: "UNKNOWN_QUANT" });
      }

      const probe = getCachedProbeFn();
      const badge = fitBadgeFn(probe, resolved.entry);
      // Gate: only a definitive "won't fit" is blocked, and only without an
      // explicit override. "tight" and "unknown" are always allowed —
      // fail-closed already happened at badge-computation time (an
      // "unknown" badge is itself the honest signal; it doesn't ALSO block
      // the download), so `force` is accepted-but-irrelevant for those two.
      if (badge === "wont_fit" && force !== true) {
        return res.status(409).json({
          error: `This quant is unlikely to fit on this hardware (fitBadge: ${badge}). Pass force:true to download anyway.`,
          code: "WONT_FIT",
          fitBadge: badge,
        });
      }

      const jobId = jobIdFor(modelId, resolved.quantId);
      const existing = downloadJobs.get(jobId);
      if (existing && (existing.status === "downloading" || existing.status === "registering")) {
        return res.status(202).json({ jobId, status: existing.status });
      }

      const dir = resolveDir();
      const job = {
        id: jobId,
        modelId,
        quant: resolved.quantId,
        status: "downloading",
        bytesDone: 0,
        totalBytes: null,
        startedAt: new Date().toISOString(),
        error: null,
        errorCode: null,
        providerId: null,
      };
      downloadJobs.set(jobId, job);

      // Fire-and-forget: the HTTP response returns the job id immediately;
      // progress/completion is polled via GET /api/models/downloads.
      (async () => {
        try {
          await enqueueDownloadFn({
            modelId,
            quant: resolved.quantId,
            dir,
            catalog,
            onProgress: ({ bytesDone, totalBytes }) => {
              job.bytesDone = bytesDone;
              if (totalBytes != null) job.totalBytes = totalBytes;
            },
          });
        } catch (err) {
          job.status = "error";
          job.error = err.message;
          job.errorCode = err.code || "DOWNLOAD_FAILED";
          return;
        }

        const db = dbFactory();
        try {
          job.status = "registering";
          const provider = await registerModelFn({ modelId, quant: resolved.quantId, catalog, db, dir });
          job.status = "done";
          job.providerId = provider.id;
        } catch (err) {
          job.status = "error";
          job.error = err.message;
          job.errorCode = err.code || "REGISTER_FAILED";
        } finally {
          try { db.close(); } catch { /* best effort */ }
        }
      })();

      res.status(202).json({ jobId, status: job.status });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    }
  });

  router.get("/api/models/downloads", (req, res) => {
    res.json({ downloads: Array.from(downloadJobs.values()).map(publicJob) });
  });

  // --- Install / uninstall -----------------------------------------------

  router.delete("/api/models/:id", async (req, res) => {
    const modelId = req.params.id;
    const catalog = loadCatalogFn();
    const model = findModel(catalog, modelId);
    if (!model) {
      return res.status(400).json({ error: `Unknown model id: ${modelId}`, code: "UNKNOWN_MODEL" });
    }
    const dir = resolveDir();
    const state = loadStateFn(dir);
    if (!state.registry[modelId]) {
      return res.status(404).json({ error: `${modelId} is not installed`, code: "NOT_INSTALLED" });
    }

    const db = dbFactory();
    try {
      const bindings = await providerBindingsFn(db, modelId);

      // Guard: without ?confirm=true (or a JSON body { confirm: true }),
      // report what deleting this model would break and stop — the
      // client re-issues the same DELETE with confirm once the operator
      // has seen the bindings. Two calls, one endpoint (documented here
      // for Task 13, since the brief left the exact confirm mechanism to
      // this task's judgment).
      const confirmed = req.query.confirm === "true" || req.body?.confirm === true;
      if (!confirmed) {
        return res.status(200).json({ requiresConfirm: true, modelId, bindings });
      }

      const handle = getNativeHandleFn(modelId);
      const result = await unregisterModelFn({ modelId, db, dir, runtimeHandle: handle });
      res.json({ deleted: true, modelId, disabled: result.disabled, fileDeleted: result.deleted, bindings });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    } finally {
      try { db.close(); } catch { /* best effort */ }
    }
  });

  // --- Start / stop ----------------------------------------------------------

  router.post("/api/models/:id/start", async (req, res) => {
    const modelId = req.params.id;
    const catalog = loadCatalogFn();
    const model = findModel(catalog, modelId);
    if (!model) {
      return res.status(400).json({ error: `Unknown model id: ${modelId}`, code: "UNKNOWN_MODEL" });
    }
    const state = loadStateFn(resolveDir());
    if (!state.registry[modelId]) {
      return res.status(404).json({ error: `${modelId} is not installed`, code: "NOT_INSTALLED" });
    }
    try {
      const result = await maybeAcquireLocalProviderFn(modelId);
      if (result === true) return res.json({ running: true });
      if (result === false) {
        return res.status(502).json({ error: "Model failed to become ready in time", code: "START_FAILED" });
      }
      return res.status(409).json({
        error: `${modelId} is not a locally-orchestratable native provider`,
        code: "NOT_NATIVE",
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    }
  });

  router.post("/api/models/:id/stop", async (req, res) => {
    const modelId = req.params.id;
    const catalog = loadCatalogFn();
    const model = findModel(catalog, modelId);
    if (!model) {
      return res.status(400).json({ error: `Unknown model id: ${modelId}`, code: "UNKNOWN_MODEL" });
    }
    const state = loadStateFn(resolveDir());
    if (!state.registry[modelId]) {
      return res.status(404).json({ error: `${modelId} is not installed`, code: "NOT_INSTALLED" });
    }
    try {
      const handle = getNativeHandleFn(modelId);
      if (handle && handle.live) await handle.stop();
      res.json({ running: false });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    }
  });

  // --- Runtime status strip ------------------------------------------------

  router.get("/api/models/runtime", (req, res) => {
    try {
      const state = loadStateFn(resolveDir());
      const snapshot = getStatusSnapshotFn();
      const byAlias = new Map(snapshot.map((s) => [s.alias, s]));
      const models = Object.keys(state.registry).map((modelId) => {
        const status = byAlias.get(modelId);
        return status
          ? { modelId, ...status }
          : { modelId, state: "stopped", live: false, port: null, restartCount: 0, lastError: null, startedAt: null, pid: null };
      });
      const activeDownloads = Array.from(downloadJobs.values())
        .filter((j) => j.status === "downloading" || j.status === "registering").length;
      res.json({ probe: getCachedProbeFn(), models, activeDownloads });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    }
  });

  // --- Hugging Face search proxy + token store --------------------------

  router.get("/api/models/hf-search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "q query param required", code: "MISSING_QUERY" });

    let token = null;
    const db = dbFactory();
    try {
      token = await getHfToken(db);
    } catch { /* search still works unauthenticated */ }
    finally { try { db.close(); } catch { /* best effort */ } }

    const url = `${hfApiBase}/api/models?search=${encodeURIComponent(q)}&filter=gguf&limit=20&full=true`;
    try {
      const upstream = await fetchImplFn(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(hfSearchTimeoutMs),
      });
      if (!upstream.ok) {
        return res.status(502).json({
          error: `Hugging Face API returned ${upstream.status}`,
          code: "HF_UPSTREAM_ERROR",
          status: upstream.status,
        });
      }
      const body = await upstream.json();
      const results = (Array.isArray(body) ? body : [])
        .map((repo) => {
          const ggufFiles = (repo.siblings || [])
            .map((s) => s?.rfilename)
            .filter((name) => typeof name === "string" && /\.gguf$/i.test(name));
          const licenseTag = (repo.tags || []).find((t) => typeof t === "string" && t.startsWith("license:"));
          return {
            id: repo.id || repo.modelId,
            gated: repo.gated === true || repo.gated === "auto" || repo.gated === "manual",
            downloads: repo.downloads ?? null,
            likes: repo.likes ?? null,
            license: licenseTag ? licenseTag.slice("license:".length) : (repo.license || null),
            ggufFiles,
          };
        })
        .filter((r) => r.ggufFiles.length > 0);
      res.json({ query: q, results });
    } catch (err) {
      // Covers network errors AND AbortSignal.timeout() firing — either
      // way, the caller gets an honest 502, never an unbounded hang.
      res.status(502).json({ error: `Hugging Face API request failed: ${err.message || err}`, code: "HF_UPSTREAM_ERROR" });
    }
  });

  router.get("/api/models/hf-token", async (req, res) => {
    const db = dbFactory();
    try {
      const token = await getHfToken(db);
      res.json({ configured: !!token });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    } finally {
      try { db.close(); } catch { /* best effort */ }
    }
  });

  router.post("/api/models/hf-token", async (req, res) => {
    const { token } = req.body || {};
    if (token !== undefined && token !== null && typeof token !== "string") {
      return res.status(400).json({ error: "token must be a string", code: "BAD_TOKEN" });
    }
    // Never logged: no console.* call anywhere in this handler touches
    // `token`/`cleaned`, and errors below carry only DB error text.
    const cleaned = typeof token === "string" ? token.trim() : "";
    const db = dbFactory();
    try {
      await upsertProviderFn(db, {
        id: HF_TOKEN_PROVIDER_ID,
        baseUrl: "https://huggingface.co",
        apiKey: cleaned || null,
        host: "external",
        bundleId: null,
        description: "Hugging Face API token (models catalog downloads — not an LLM provider)",
        models: [],
        disabled: true,
        providerType: null,
        // local_only: true is the general convention `shouldSyncRow`'s
        // providers branch (servers/sharing/instance-sync.js) checks to
        // exclude a row from fleet instance-sync entirely — this row's
        // base_url is a real (non-loopback) host, so without this marker
        // it would otherwise sync in plaintext to every paired instance.
        // Deliberately non-null (not `null`) even on a re-POST: upsertProvider's
        // SQL COALESCEs a null gpu_policy into "keep existing" on UPDATE, so a
        // null write here would silently fail to (re-)establish the marker.
        gpuPolicy: { local_only: true },
      });
      await invalidateCacheFn();
      res.json({ configured: !!cleaned });
    } catch (err) {
      res.status(500).json({ error: err.message, code: "INTERNAL" });
    } finally {
      try { db.close(); } catch { /* best effort */ }
    }
  });

  return router;
}
