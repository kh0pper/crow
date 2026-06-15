/**
 * v1 Fix-it detector: a peer instance was denied a tool call because the owning
 * capability isn't in this instance's remote-exposure allowlist. Hooks the
 * `peer-exposure:denied` event emitted at the enforcePeerExposure chokepoint.
 *
 * DB-free: it only composes strings from the (already name-enriched) payload
 * and the pure friendly-name map, then calls the db-bound store it's handed.
 */
import { resolveFriendlyName } from "../friendly-names.js";

export default {
  source: "remote-exposure",
  events: ["peer-exposure:denied"],
  async onEvent(_eventName, payload, store) {
    const { capability, requestingInstance, requestingInstanceName, toolName } = payload || {};
    if (!capability) return; // only real, resolvable capabilities become cards
    const friendly = resolveFriendlyName(capability);
    const peer = requestingInstanceName || "another device";
    await store.upsertItem({
      source: "remote-exposure",
      dedupKey: `expose:${capability}:${requestingInstance}`,
      title: `Your ${peer} tried to use ${friendly}, but it isn't shared with this device yet`,
      why: "Share it so your other Crow devices can use it.",
      severity: "warn",
      remedies: [{ label: "Allow", actionId: "expose-capability", args: { capability }, kind: "instant" }],
      context: { capability, requestingInstance, toolName: toolName || null },
    });
  },
};
