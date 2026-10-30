/**
 * Hosts the bot browser never loads (2026-10-29).
 *
 * A Crow bot on a Qwen model opened made-up links to Alibaba's internal file
 * proxy (routify-file-proxy-*.oss-*.aliyuncs.com), the same host Cohere
 * reported a Qwen model reaching for unprompted. Alibaba Cloud object storage
 * (OSS) is blocked as a whole: a page load there is never a bot's research
 * task. Qwen Cloud's own API hosts (dashscope*.aliyuncs.com) are not storage
 * and are untouched; the bot browser never calls them anyway.
 */

/** Chrome Network.setBlockedURLs patterns: the same rule, enforced in the page. */
export const BLOCKED_URL_PATTERNS = Object.freeze([
  "*://routify-file-proxy*",
  "*://*.oss-*.aliyuncs.com/*",
  "*://*.oss.aliyuncs.com/*",
  "*://oss-*.aliyuncs.com/*",
]);

/** True when `url` is on a blocked host. Unparseable input is not blocked here (the caller's own validation rejects it). */
export function isBlockedUrl(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, ""); } catch { return false; }
  if (host.startsWith("routify-file-proxy")) return true;
  if (!host.endsWith(".aliyuncs.com")) return false;
  const labels = host.slice(0, -".aliyuncs.com".length).split(".");
  return labels.some((l) => l === "oss" || l.startsWith("oss-"));
}

/** The tool error for a refused URL. */
export function blockedResult(url) {
  return {
    content: [{ type: "text", text: `Blocked: Crow's browser doesn't load Alibaba Cloud storage links (${new URL(String(url)).hostname}). If you need this page, say why in the chat.` }],
    isError: true,
  };
}
