/**
 * Digest adapter — Outlook / Microsoft 365 (stub, later phase).
 *
 * Reserved env keys for the future implementation:
 *   MSGRAPH_CLIENT_ID / MSGRAPH_CLIENT_SECRET / MSGRAPH_TENANT_ID
 *   MSGRAPH_TOKEN_FILE — cached token path
 *
 * Until implemented, this always reports unavailable so the digest can
 * show the section slot without failing.
 */

export async function outlookSection(config) {
  const configured = Boolean(config.MSGRAPH_CLIENT_ID && config.MSGRAPH_CLIENT_SECRET);
  return {
    title: "Outlook",
    available: false,
    reason: configured
      ? "Outlook adapter not implemented yet (planned for a later phase)"
      : "not configured (MSGRAPH_CLIENT_ID/MSGRAPH_CLIENT_SECRET unset)",
  };
}
