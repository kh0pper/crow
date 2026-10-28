/**
 * One `providers` DB row -> the provider object the settings panel and the
 * role resolver use. Pure (no imports), so readers that must not load
 * providers-db.js's graph can map rows themselves.
 */
export function providerRowToObject(r) {
  let models = [];
  try { models = JSON.parse(r.models || "[]"); } catch {}
  let gpuPolicy = null;
  try { gpuPolicy = r.gpu_policy ? JSON.parse(r.gpu_policy) : null; } catch {}
  return {
    id: r.id,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    host: r.host,
    bundleId: r.bundle_id,
    provider_type: r.provider_type || null,
    description: r.description,
    models,
    gpuPolicy,
    disabled: !!r.disabled,
    lamport_ts: r.lamport_ts,
    instance_id: r.instance_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
