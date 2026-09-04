/** Who asked for a model? /llm/v1 is unauthenticated by design (companion is
 * loopback), so attribution is whatever the request carries: peer ip, a
 * bounded user-agent, and the optional X-Crow-Client tag first-party clients set.
 * Pure and never throws — `req` may be `{}`, null, or headerless. The result is
 * a log token only (model-start attribution); it gates nothing. */
export function requesterTag(req) {
  const h = (req && req.headers) || {};
  const ip = String((req && req.ip) || "").replace(/^::ffff:/, "") || "-";
  const ua = String(h["user-agent"] || "").replace(/\s+/g, " ").trim().slice(0, 40) || "-";
  const client = String(h["x-crow-client"] || "").replace(/[^A-Za-z0-9._/-]+/g, "_").slice(0, 40) || "-";
  return `${ip} ua=${ua} client=${client}`;
}
