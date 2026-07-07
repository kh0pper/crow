/**
 * OAuth issuer URL resolution (F-INSTALL-8).
 *
 * The MCP SDK's mcpAuthRouter/createOAuthMetadata THROW at mount time on any
 * issuer that is not HTTPS (localhost/127.0.0.1 exempt) or that carries a
 * query/fragment — which killed the gateway on every fresh install (no
 * CROW_GATEWAY_URL → http://0.0.0.0:3001). Resolve the issuer here instead:
 * a valid configured URL passes through byte-identical; anything the SDK
 * would reject degrades to http://localhost:<port> (SDK-exempt) with a
 * reason, so the gateway ALWAYS boots. A degraded issuer only breaks the
 * remote OAuth dance — dashboard, local-token MCP, and peer auth are
 * unaffected.
 */
export function resolveIssuerUrl({ publicUrl, port }) {
  const fallback = new URL(`http://localhost:${port}`);
  if (!publicUrl) {
    return { url: fallback, degraded: false, configured: false, reason: null };
  }
  let url;
  try {
    url = new URL(publicUrl);
  } catch {
    return {
      url: fallback, degraded: true, configured: true,
      reason: `CROW_GATEWAY_URL is not a valid URL: ${JSON.stringify(publicUrl)}`,
    };
  }
  url.hash = "";
  url.search = "";
  const localhostExempt = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localhostExempt) {
    return {
      url: fallback, degraded: true, configured: true,
      reason: `issuer ${url.href} is not HTTPS (the MCP SDK requires HTTPS for non-localhost issuers)`,
    };
  }
  return { url, degraded: false, configured: true, reason: null };
}
