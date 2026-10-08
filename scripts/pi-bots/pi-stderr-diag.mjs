/**
 * Forward a bot pi child's diagnostic stderr lines to the gateway log.
 *
 * pi-lab writes one-line diagnostics prefixed "[pi-lab/<area>]" — an MCP
 * server that failed to start ("[pi-lab/mcp-client] google-workspace: spawn
 * uvx ENOENT"), the start summary, and the bot `auto` bash decisions
 * (counts only, never the command). PiRpc used to keep stderr in memory and
 * show it only when a turn failed, so a dropped server was invisible. Only
 * those prefixed lines are forwarded: everything else pi prints stays where
 * it was. Lines are capped and rate-limited per child.
 */
export const DIAG_PREFIX = /^\[pi-lab\/[a-z0-9-]+\]/;
export const MAX_DIAG_LINE = 400;
export const MAX_DIAG_LINES_PER_CHILD = 200;

export function createStderrDiag({ label, emit, maxLines = MAX_DIAG_LINES_PER_CHILD }) {
  let buf = "";
  let sent = 0;
  let suppressedNoted = false;
  const tag = String(label || "bot").replace(/[^\w.:-]/g, "_").slice(0, 64);
  return function onChunk(chunk) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buf.length > 64 * 1024) buf = buf.slice(-64 * 1024);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!DIAG_PREFIX.test(line)) continue;
      if (sent >= maxLines) {
        if (!suppressedNoted) { suppressedNoted = true; emit(`[pi-bots ${tag}] further pi-lab diagnostics suppressed for this child`); }
        continue;
      }
      sent++;
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/[\u0000-\u001f\u007f]/g, " ");
      emit(`[pi-bots ${tag}] ${clean.length > MAX_DIAG_LINE ? clean.slice(0, MAX_DIAG_LINE) + "…" : clean}`);
    }
  };
}
