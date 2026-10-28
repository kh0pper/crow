/**
 * Pieces every eval runner shares (scripts/kiosk-eval/run.mjs, scripts/research-eval/run.mjs).
 * Built-ins only, so a runner can import it without pulling in another runner's stack.
 */
import { existsSync, readFileSync } from "node:fs";

/** A failed request (or transport) is retried at most this many times before the row or run stops. */
export const MAX_ATTEMPTS = 3;

/** A run writes into a NEW file: an existing non-empty --out is refused unless --resume. → null | the reason. */
export function outGuard(out, resume, { exists = existsSync, read = (f) => readFileSync(f, "utf8") } = {}) {
  if (resume) return null;
  if (exists(out) && read(out).trim()) return `${out} exists and is not empty: a rerun writes into a new directory (or pass --resume to continue this one)`;
  return null;
}
