/**
 * Digest adapter — Box (stub, later phase).
 *
 * Reserved env keys for the future implementation:
 *   BOX_CLIENT_ID / BOX_CLIENT_SECRET — Box Platform app credentials
 *   BOX_FOLDER_IDS                    — comma-separated folder ids to watch
 *
 * Until implemented, this always reports unavailable so the digest can
 * show the section slot without failing.
 */

export async function boxSection(config) {
  const configured = Boolean(config.BOX_CLIENT_ID && config.BOX_CLIENT_SECRET);
  return {
    title: "Box",
    available: false,
    reason: configured
      ? "Box adapter not implemented yet (planned for a later phase)"
      : "not configured (BOX_CLIENT_ID/BOX_CLIENT_SECRET unset)",
  };
}
