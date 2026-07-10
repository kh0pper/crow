// Host-rewriting reverse proxy for the OpenScience front door.
//
// Vendored from rookery `scripts/openscience-host-proxy.mjs`, adapted for
// the Docker container role: OpenScience hard-allowlists the Host header to
// localhost/127.0.0.1/[::1] (a DNS-rebinding guard, ALLOWED_HOSTS in its
// host-guard module) with no config or env override, AND pins its own HTTP
// listener to 127.0.0.1 in-container — so a plain Docker port mapping to the
// app's own listener never becomes reachable from the host. This shim listens
// on SHIM_LISTEN_HOST (0.0.0.0 in the container, so Docker's port mapping
// works) and rewrites the Host header to the backend's loopback value before
// forwarding — it is structurally required here, not a fallback for a
// Tailscale-only edge case.
//
// Origin-strip security posture (adapted from upstream, which warns that
// stripping Origin "would disable its CSRF protection"): here that trade is
// acceptable because (1) every request arrives through the session-gated
// Crow gateway whose cookie is `SameSite=Lax` (dashboard/auth.js:476 —
// cross-site POSTs don't carry it), and (2) the port binds 127.0.0.1 only.
// Residual exposure: any local process can hit 127.0.0.1:3061
// unauthenticated (consistent with other crow bundles). When
// ROOKERY_CORS_ORIGINS IS configured, Origin is passed through unmodified
// and the app's own --cors whitelist enforces it, exactly as upstream does.
//
// Usage: node host-shim.mjs [listenPort] [backendPort]
// Defaults: listen 127.0.0.1:4097 -> backend 127.0.0.1:4096
// Container wiring: SHIM_LISTEN_HOST=0.0.0.0 node host-shim.mjs 3061 4096

import http from "node:http";
import net from "node:net";

const LISTEN = { host: process.env.SHIM_LISTEN_HOST || "127.0.0.1", port: Number(process.argv[2] ?? 4097) };
const BACKEND = { host: "127.0.0.1", port: Number(process.argv[3] ?? 4096) };
const BACKEND_HOST_HEADER = `${BACKEND.host}:${BACKEND.port}`;
// When no CORS origins are configured for the app (ROOKERY_CORS_ORIGINS empty),
// strip Origin too: the Crow gateway session-gates every request, so the app's
// own origin whitelist adds friction without adding a boundary. When origins
// ARE configured, pass Origin through and let the app enforce them.
const STRIP_ORIGIN = !(process.env.ROOKERY_CORS_ORIGINS || "").trim();

// Besides Host, we also strip Sec-Fetch-Site: link-click navigations arrive
// with no Origin header but Sec-Fetch-Site: cross-site, which the app's
// isCrossOrigin() rejects. Requests that DO carry Origin (fetch/WS/POST) are
// still validated against the app's --cors whitelist — that check is untouched.
const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: BACKEND_HOST_HEADER };
  delete headers["sec-fetch-site"];
  if (STRIP_ORIGIN) delete headers["origin"];
  const up = http.request(
    { host: BACKEND.host, port: BACKEND.port, path: req.url, method: req.method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      upRes.on("error", () => res.destroy());
    },
  );
  up.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy: backend unavailable");
    } else {
      res.destroy();
    }
  });
  req.on("error", () => up.destroy());
  res.on("error", () => up.destroy());
  req.pipe(up);
});

// WebSocket/SSE upgrade pass-through with the same single-header rewrite.
server.on("upgrade", (req, socket, head) => {
  const backend = net.connect(BACKEND.port, BACKEND.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const key = raw[i].toLowerCase();
      if (key === "sec-fetch-site" || (STRIP_ORIGIN && key === "origin")) continue;
      const value = key === "host" ? BACKEND_HOST_HEADER : raw[i + 1];
      lines.push(`${raw[i]}: ${value}`);
    }
    backend.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) backend.write(head);
    backend.pipe(socket);
    socket.pipe(backend);
  });
  backend.on("error", () => socket.destroy());
  socket.on("error", () => backend.destroy());
});

server.listen(LISTEN.port, LISTEN.host, () => {
  console.log(
    `openscience-host-proxy: ${LISTEN.host}:${LISTEN.port} -> ${BACKEND.host}:${BACKEND.port} (Host rewritten to "${BACKEND_HOST_HEADER}")`,
  );
});
