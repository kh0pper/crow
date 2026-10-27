/**
 * Tailscale Serve, as a test sees it.
 *
 * The gateway honours Serve's headers only on a loopback socket opened by
 * tailscaled's uid (servers/shared/peer-uid.js, CROW_SERVE_PEER_UIDS, default
 * 0). A test's own HTTP client runs as the test's uid, so a test that stands in
 * for Serve declares that uid (this process only: node --test runs each file in
 * its own process) and sends the headers Serve always writes.
 */
export function actAsServe() {
  process.env.CROW_SERVE_PEER_UIDS = String(typeof process.getuid === "function" ? process.getuid() : 0);
}

/** The headers Serve sets for a tailnet client (login omitted for a tagged node). */
export function serveHeaders(login = "tester@example.invalid", client = "100.64.20.5") {
  const h = { "x-forwarded-for": client, "x-forwarded-host": "crow.example.ts.net:8444" };
  if (login) h["tailscale-user-login"] = login;
  return h;
}
