/**
 * Markdown File Viewer — read-only, tailnet-only, auth-gated.
 *
 * GET /dashboard/fileview?path=<absolute path to a .md file>
 *
 * Renders a local Markdown file as sanitized HTML so it can be reviewed in a
 * browser over Tailscale. Security model:
 *   - Behind dashboardAuth (cookie session) — same login as the rest of the
 *     dashboard. Because the path is under /dashboard/, the gateway's
 *     rejectFunneledMiddleware() already blocks it from Tailscale Funnel, so it
 *     is tailnet-only. It is NOT in PUBLIC_FUNNEL_PREFIXES (must never be).
 *   - Path is canonicalized with realpathSync (resolves .. and symlinks) and
 *     must land UNDER the allowlist root (default: the user's home dir) and end in .md
 *     and be a regular file — otherwise 404. This defeats path traversal and
 *     symlink-escape.
 *   - renderMarkdown() (servers/blog/renderer.js) sanitizes the HTML.
 *
 * Override the allowlist root with CROW_FILEVIEW_ROOT (used by tests).
 */
import { Router } from "express";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { renderMarkdown } from "../../blog/renderer.js";
import { escapeHtml } from "../dashboard/shared/components.js";

const DEFAULT_ROOT = process.env.CROW_FILEVIEW_ROOT || homedir();
if (process.env.CROW_FILEVIEW_ROOT && !DEFAULT_ROOT.startsWith("/home/")) {
  // CROW_FILEVIEW_ROOT is intended for tests. A production root outside /home
  // (e.g. "/") would let any authenticated dashboard user read any .md on disk.
  console.warn("[fileview] CROW_FILEVIEW_ROOT is set outside /home — intended for tests only");
}

/**
 * Canonicalize rawPath and return its real path iff it is a readable regular
 * .md file resolving under allowRoot; otherwise null. Pure + synchronous so it
 * can be unit-tested directly.
 */
export function resolveSafeMarkdownPath(rawPath, allowRoot = DEFAULT_ROOT) {
  if (!rawPath || typeof rawPath !== "string") return null;
  if (!rawPath.toLowerCase().endsWith(".md")) return null;
  let real, rootReal;
  try {
    real = realpathSync(rawPath);
    rootReal = realpathSync(allowRoot);
  } catch {
    return null; // path (or root) does not exist
  }
  // Must resolve strictly under the allowlist root.
  const rel = relative(rootReal, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  // Re-check the REAL path is a .md regular file (a symlink could point .md -> something else).
  if (!real.toLowerCase().endsWith(".md")) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>` +
    `:root{color-scheme:light dark}` +
    `body{margin:0;background:#0d1117;color:#c9d1d9;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}` +
    `.wrap{max-width:820px;margin:0 auto;padding:2.5rem 1.25rem 5rem}` +
    `.crumb{font-size:.8rem;color:#8b949e;margin:0 0 1.5rem;word-break:break-all}` +
    `article{}` +
    `article h1,article h2,article h3{line-height:1.25;margin:1.6em 0 .6em}` +
    `article h1{font-size:1.9rem;border-bottom:1px solid #21262d;padding-bottom:.3em}` +
    `article h2{font-size:1.45rem;border-bottom:1px solid #21262d;padding-bottom:.3em}` +
    `article code{background:#161b22;padding:.15em .4em;border-radius:4px;font-size:.88em}` +
    `article pre{background:#161b22;padding:1rem;border-radius:8px;overflow:auto}` +
    `article pre code{background:none;padding:0}` +
    `article a{color:#58a6ff}` +
    `article table{border-collapse:collapse}article th,article td{border:1px solid #30363d;padding:.4em .7em}` +
    `article blockquote{border-left:3px solid #30363d;margin:0;padding:.1em 1em;color:#8b949e}` +
    `</style></head><body><div class="wrap">${bodyHtml}</div></body></html>`;
}

export default function fileviewRouter(dashboardAuth) {
  const router = Router();
  router.use("/dashboard/fileview", dashboardAuth);

  router.get("/dashboard/fileview", (req, res) => {
    const raw = typeof req.query.path === "string" ? req.query.path : "";
    const safe = resolveSafeMarkdownPath(raw);
    if (!safe) {
      return res.status(404).type("html").send(
        page("Not found", `<p>File not found, not a <code>.md</code> file, or outside the allowed root.</p>`)
      );
    }
    let md;
    try {
      md = readFileSync(safe, "utf8");
    } catch {
      return res.status(404).type("html").send(page("Not found", `<p>File could not be read.</p>`));
    }
    const body = `<p class="crumb">${escapeHtml(safe)}</p><article>${renderMarkdown(md)}</article>`;
    res.type("html").send(page(basename(safe), body));
  });

  return router;
}
