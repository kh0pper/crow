/**
 * The production wiring of the lifecycle core (lifecycle-core.js): real
 * providers, orchestrator, reservation and health reads, and the one shared
 * job store. Used by both lifecycle doors (routes/llm-models.js,
 * routes/models.js) and by panels that render the listing (Extensions'
 * Local models card, the Model Catalog's registered section). Tests build a
 * core from fakes instead.
 */
import { loadProviders } from "../../shared/providers.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { readReservation } from "../box-reservation.js";
import { getProviderHealth } from "../provider-health.js";
import { acquireProvider, stopNativeProvider, nativeSnapshot, mutexSiblingsOf } from "../gpu-orchestrator.js";
import { sharedJobStore } from "./lifecycle.js";
import { createLifecycleCore } from "./lifecycle-core.js";

export function defaultLifecycleDeps() {
  return {
    providersFn: () => (loadProviders() || {}).providers || {},
    ownInstanceIdFn: getOrCreateLocalInstanceId,
    readReservationFn: readReservation,
    snapshotOfFn: nativeSnapshot,
    siblingsOfFn: mutexSiblingsOf,
    externalHealthFn: () => getProviderHealth().external,
    acquireFn: acquireProvider,
    stopFn: stopNativeProvider,
    jobs: sharedJobStore(),
  };
}

export function defaultLifecycleCore() {
  return createLifecycleCore(defaultLifecycleDeps());
}
