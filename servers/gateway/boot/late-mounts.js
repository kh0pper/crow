/**
 * boot/late-mounts.js — calls routes (CROW_CALLS_ENABLED gate), LLM-router,
 * extension web UI proxy.
 *
 * S1: RETURNS BOTH handles { setupCallsSignaling, extensionProxyWsSetup } — each
 * is null-guarded in the listen callback; a missed handle silently never wires
 * WebSocket upgrades and no gate catches it (route-stack diff does not see WS
 * wiring). The AI Companion's proxy (and the third handle it needed) was retired
 * with the bundle; nothing mounts under /companion any more.
 * deps: { dashboardAuth }
 */

export async function mountLateRoutes(app, deps) {
  const { dashboardAuth } = deps;

  // --- Mount Calls Routes (gated behind CROW_CALLS_ENABLED) ---
  let setupCallsSignaling = null;
  if (process.env.CROW_CALLS_ENABLED === "1") {
    try {
      const { default: callsPageRouter } = await import("../routes/calls-page.js");
      app.use(callsPageRouter(dashboardAuth));
      const { default: _setupCallsSignaling } = await import("../routes/calls-signaling.js");
      setupCallsSignaling = _setupCallsSignaling;
    } catch (err) {
      if (err.code !== "ERR_MODULE_NOT_FOUND") {
        console.warn("[calls] Failed to mount:", err.message);
      }
    }
  }

  // --- Mount the models lifecycle API (plan 2 Task 8). Its OWN try/catch: an
  // import failure here must never stop the voice /llm/v1 router below. ---
  try {
    const { default: llmModelsRouter } = await import("../routes/llm-models.js");
    app.use(llmModelsRouter());
    console.log("  [llm-models] mounted: GET /llm/models, POST /llm/models/:provider/start|stop, GET /llm/models/jobs/:id");
  } catch (err) {
    console.warn("[llm-models] Failed to mount:", err.message);
  }

  // --- Mount LLM-router (folds the old standalone voice model-proxy into the
  // gateway). No dashboardAuth: a voice device arrives as loopback, which
  // isAllowedNetwork() rejects; protected instead by rejectFunneledMiddleware
  // (mounted above) + tailnet/loopback-only exposure. See routes/llm-router.js. ---
  try {
    const { default: llmRouterRouter } = await import("../routes/llm-router.js");
    app.use(llmRouterRouter());
    console.log("  [llm-router] mounted: POST /llm/v1/{chat/completions,completions,embeddings,rerank}, POST /llm/p/:provider/v1/{chat/completions,completions,embeddings,rerank}, GET /llm/v1/models, GET /llm/p/:provider/v1/models, POST /llm/c/:provider/v1/{chat/completions,completions,embeddings,messages} (cloud door, loopback + token), POST /llm/acquire");
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[llm-router] Failed to mount:", err.message);
    }
  }

  // --- Mount Extension Web UI Proxy ---
  let extensionProxyWsSetup = null;
  try {
    const { default: extensionProxyRouter } = await import("../routes/extension-proxy.js");
    const { router, setupWebSocket } = extensionProxyRouter(dashboardAuth);
    app.use(router);
    extensionProxyWsSetup = setupWebSocket;
  } catch (err) {
    // The Extensions page must not promise a restart that cannot mount this
    // router (review round 1, N5): record the failure so its app cards say the
    // link is unavailable instead of "restart Crow first".
    try {
      const { recordProxyMountFailure } = await import("../routes/extension-proxy.js");
      recordProxyMountFailure(err);
    } catch { /* the module itself is unavailable: the page has no card to word */ }
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[extension-proxy] Failed to mount:", err.message);
    }
  }

  // S1: return both handles — each consumer is a null-guarded if in the listen
  // callback; a missed handle silently skips WS wiring
  return { setupCallsSignaling, extensionProxyWsSetup };
}
