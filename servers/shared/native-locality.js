/**
 * Owner-gated locality for native model rows (spec §3/§4).
 *
 * A native model's provider row advertises the DOOR — the gateway's own
 * `/llm/v1` on the tailnet — as its `base_url`, so a PEER instance can call
 * it over the tailnet without knowing the llama-server port. The owning
 * instance must NOT call itself through that door (it would recurse into
 * its own router), so every read path that turns a providers row into a
 * request target rewrites an OWNED native row back to the loopback
 * `127.0.0.1:<gpu_policy.port>` (`localizeNativeRow`).
 *
 * "Owned" is decided by `gpu_policy.owner` (an instance id), NOT by the
 * baseUrl hostname. The hostname rule cannot work on a co-hosted box: the
 * primary and r4 gateways share crow's tailnet IP and loopback, so every
 * instance's door URL looks "local" to every other instance, and the
 * hostname rule would have each of them starting and stopping the others'
 * models. The instance id is the only thing that distinguishes them.
 * Rows that declare no owner (pre-arc rows, Docker bundles, cloud
 * providers) keep the original hostname rule — see `isOrchestratableHere`.
 */
import { isLocallyOrchestratable } from "./locality.js";
import { nativeLoopbackUrl } from "../gateway/models/door.js";

export function isOwnedHere(provider, ownInstanceId) {
  const owner = provider?.gpuPolicy?.owner;
  if (typeof owner !== "string" || !owner) return null;
  return owner === ownInstanceId;
}
export function isOrchestratableHere(provider, { ownAddrs, ownInstanceId }) {
  const owned = isOwnedHere(provider, ownInstanceId);
  if (owned !== null) return owned;
  return isLocallyOrchestratable(provider, ownAddrs);
}
/** Localize just a raw DB row's `base_url`, for the two resolvers that map
 * `SELECT ... FROM providers` straight into a request config
 * (`ai/resolve-profile.js`'s `resolveFromDb`, `memory/embeddings.js`'s
 * `loadProviderFromDb`) rather than going through `loadProvidersFromDb`.
 * `ownInstanceIdFn` is only invoked for a native row that actually declares
 * an owner, so a cloud/Docker/pre-arc row never reads the instance-id file. */
export function localizeDbBaseUrl(baseUrl, gpuPolicy, ownInstanceIdFn) {
  if (!gpuPolicy || gpuPolicy.runtime !== "native" || typeof gpuPolicy.owner !== "string" || !gpuPolicy.owner) {
    return baseUrl;
  }
  return localizeNativeRow({ baseUrl, gpuPolicy }, ownInstanceIdFn()).baseUrl;
}

export function localizeNativeRow(provider, ownInstanceId) {
  const gp = provider?.gpuPolicy;
  if (!gp || gp.runtime !== "native" || isOwnedHere(provider, ownInstanceId) !== true) return provider;
  const port = Number(gp.port);
  if (!Number.isInteger(port) || port <= 0) return provider;
  const loop = nativeLoopbackUrl(port);
  if (provider.baseUrl === loop) return provider;
  return { ...provider, doorUrl: provider.baseUrl, baseUrl: loop };
}
