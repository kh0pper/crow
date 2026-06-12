/**
 * boot/late-mounts.js — calls routes (CROW_CALLS_ENABLED gate), LLM-router,
 * companion proxy, extension web UI proxy.
 *
 * S1: RETURNS ALL THREE handles { setupCallsSignaling, setupCompanionProxy,
 * extensionProxyWsSetup } — the latter two are null-guarded in the listen
 * callback; a missed handle silently never wires WebSocket upgrades and no
 * gate catches it (route-stack diff does not see WS wiring).
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

  // --- Mount LLM-router (folds the standalone companion model-proxy into the
  // gateway). No dashboardAuth: the host-networked companion arrives as loopback,
  // which isAllowedNetwork() rejects; protected instead by rejectFunneledMiddleware
  // (mounted above) + tailnet/loopback-only exposure. See routes/llm-router.js. ---
  try {
    const { default: llmRouterRouter } = await import("../routes/llm-router.js");
    app.use(llmRouterRouter());
    console.log("  [llm-router] mounted: POST /llm/v1/chat/completions, GET /llm/v1/models");
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[llm-router] Failed to mount:", err.message);
    }
  }

  // --- Mount Companion Proxy ---
  let setupCompanionProxy = null;
  try {
    const { default: _setupCompanionProxy } = await import("../routes/companion-proxy.js");
    setupCompanionProxy = _setupCompanionProxy;
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[companion-proxy] Failed to load:", err.message);
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
    if (err.code !== "ERR_MODULE_NOT_FOUND") {
      console.warn("[extension-proxy] Failed to mount:", err.message);
    }
  }

  // S1: return all three handles — companion and extension consumers are null-guarded
  // ifs in the listen callback; a missed handle silently skips WS wiring
  return { setupCallsSignaling, setupCompanionProxy, extensionProxyWsSetup };
}
