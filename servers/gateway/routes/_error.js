/**
 * Canonical JSON error helper for gateway routes (W2-1).
 *
 * One shape for every JSON API error: { error: string, ...optionalExtra }.
 * Success shapes are deliberately NOT standardized here — only errors.
 *
 * Usage:
 *   jsonError(res, 404, "card not found")
 *   jsonError(res, 500, err.message, { code: err.code || "unknown" })
 */
export function jsonError(res, status, error, extra = undefined) {
  return res.status(status).json(extra ? { error, ...extra } : { error });
}
