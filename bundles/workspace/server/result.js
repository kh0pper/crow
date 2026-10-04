/** Crow Workspace tool result envelope (spec §4.1): {success,data} | {success:false,code,error,data?}. */
export class WsError extends Error {
  constructor(code, message, data) { super(message); this.name = "WsError"; this.code = code; this.data = data; }
}
const block = (obj) => [{ type: "text", text: JSON.stringify(obj) }];
export const ok = (data) => ({ content: block({ success: true, data }) });
export const fail = (code, error, data) => ({ content: block({ success: false, code, error, ...(data !== undefined ? { data } : {}) }), isError: true });

/**
 * Wrap a tool body. No error ever leaks a secret: WsError message + data and unexpected-error messages all
 * pass through redactWith()'s config (plain, URL-encoded and Basic-header forms). If redaction itself is
 * unavailable the details are withheld.
 */
export function handler(fn, { redactWith } = {}) {
  return async (args) => {
    try { return ok(await fn(args ?? {})); }
    catch (e) {
      let cfg = null;
      try { cfg = redactWith ? redactWith() : null; } catch { cfg = null; }
      let R = null;
      try { R = await import("./config.js"); } catch { R = null; }
      if (e instanceof WsError) {
        if (!R) return fail(e.code, "(details withheld)");
        return fail(e.code, R.redact(e.message, cfg), e.data === undefined ? undefined : R.redactDeep(e.data, cfg));
      }
      const msg = R ? R.redact(String(e?.message ?? e), cfg) : "(details withheld)";
      return fail("internal", `Unexpected error: ${e?.name || "Error"}: ${msg}`);
    }
  };
}
