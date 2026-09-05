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
export function localizeNativeRow(provider, ownInstanceId) {
  const gp = provider?.gpuPolicy;
  if (!gp || gp.runtime !== "native" || isOwnedHere(provider, ownInstanceId) !== true) return provider;
  const port = Number(gp.port);
  if (!Number.isInteger(port) || port <= 0) return provider;
  const loop = nativeLoopbackUrl(port);
  if (provider.baseUrl === loop) return provider;
  return { ...provider, doorUrl: provider.baseUrl, baseUrl: loop };
}
