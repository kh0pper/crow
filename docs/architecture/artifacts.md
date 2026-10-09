# Artifacts: the sealed artifact host

Crow Artifacts lets bots make pages, documents and diagrams that you view, comment on and send back for revision. Bot-made content is untrusted, so it is never served from the dashboard. It is served from a separate **artifact origin** and shown in a sealed frame by a **trusted viewer** on the dashboard.

This page covers that host: the origin, view tokens, the viewer, the sidecar network node and its health check, what is enforced, and what remains a known residual. The bundle that stores artifacts and drives feedback rounds builds on it.

## The artifact origin

`servers/gateway/artifact-origin/` is a minimal `node:http` listener. It is deliberately **not** Express and not part of the gateway app: it shares no middleware, session handling or Funnel allow-list with the dashboard.

- **One route:** `GET`/`HEAD` `/v/<token>/<path>`. The token is 43 base64url characters. The path is decoded and must be a plain relative path: no `..`, no encoded separators, no control characters. `/v/<token>/` serves the version's `index.html`, and a missing trailing slash is a 404, never a redirect.
- **Every response, errors included,** carries:
  - a `Content-Security-Policy` that ends in a `sandbox` directive, so even a top-level load runs as an opaque origin;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store, private` and `X-Robots-Tag: noindex`.
- **Never** a `Set-Cookie` and never a 3xx. The `Cookie` request header is deleted before anything reads the request, and nothing logs request paths (they carry tokens).
- **Funnel traffic is refused.** Any request carrying `Tailscale-Funnel-Request` gets 403, and `CROW_DASHBOARD_PUBLIC` does not override that. Peers must be loopback, a private LAN range or the tailnet.
- Range requests are not honoured: the full body comes back with 200.

### Per-type policy

`policy.js` holds one CSP row per artifact type. Every row has `default-src 'none'`, `connect-src 'none'`, `worker-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`, `frame-src 'none'`, `manifest-src 'none'` and `media-src 'none'`. Sources are limited to the version's own token path. `'unsafe-eval'` is never granted.

| Types | Sandbox | Scripts |
|---|---|---|
| `document`, `diagram`, `image`, `docx` | `sandbox` (no flags) | none |
| `page`, `slides` | `sandbox allow-scripts` | token path + inline |
| `data`, `map` | `sandbox allow-scripts` | token path only |
| `pdf` | `sandbox allow-scripts` | token path only (a fixed viewer file) |

The sandbox never includes `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`. The iframe's `sandbox` attribute always matches the CSP row.

- Scripted 200 responses also carry `Access-Control-Allow-Origin: *` (never with credentials), because module scripts loaded from an opaque origin are CORS requests.
- **Scripts off.** A version shaped by text from outside your Crow is served script-free until you approve it: the token carries `scriptsOff`, the script-free row is used, and the bytes are served unchanged. Safety comes from the CSP header, never from rewriting markup; the origin does not parse bot markup at all.
- **The anchor helper.** For scripted HTML, a small helper script (`anchor-helper.js`) is placed at a fixed spot: after an optional byte-order mark, leading whitespace and a `<!doctype …>`, otherwise at byte 0. Placement grants nothing. If bot markup stops the helper from running, the viewer gets no hello and closes the frame.

### View tokens

`view-tokens.js` keeps tokens in memory, in the gateway process that serves the origin.

- A token grants one artifact version, read-only. It lasts 30 minutes, and the viewer mints a fresh one for every frame load.
- Only a SHA-256 of each token is held.
- Each token carries a per-load nonce (the tripwire handshake) and the dashboard origin that minted it. That origin becomes the response's `frame-ancestors`, so no per-instance configuration is needed.
- A gateway restart drops every token. Open frames keep their loaded document, and lazy loads fail until the view is reloaded.

### Configuration

| Variable | Meaning |
|---|---|
| `CROW_ARTIFACT_ORIGIN_PORT` | Loopback port of this instance's origin. Unset: nothing listens and artifact viewing is off. |
| `CROW_ARTIFACT_ORIGIN_URL` | The origin browsers use, on its **own** hostname, e.g. `https://<instance>-artifacts.<tailnet>.ts.net`. Scheme, host and optional port only. Unset: the loopback fallback below. |
| `CROW_ARTIFACT_ORIGIN_BIND` | Bind address, default `127.0.0.1`. A container instance binds inside its namespace and publishes on host loopback. |
| `CROW_ARTIFACT_SIDECAR_SOCKET` | The sidecar node's tailscaled socket, for the health check. Unset: no health card. |

Registered ports (see [port allocation](../developers/port-allocation.md)): `CROW_ARTIFACT_ORIGIN_PORT=3090` for the main instance, `CROW_ARTIFACT_ORIGIN_PORT=3091` for a second co-hosted instance, `CROW_ARTIFACT_ORIGIN_PORT=3092` for a household container instance. 3093 is reserved for the later public-link listener.

`runtime.js` holds the process-wide token store and content resolver, and starts the listener from these variables. `isolationFor(dashboardHost)` reports `own-host` when the origin's hostname differs from the dashboard's, `shared-host` on the fallback, and `unavailable` when no origin is running. The listener is started by the Artifacts bundle's gateway mount. In this release nothing starts it yet.

## Hostname: a sidecar Tailscale node

The origin needs its own hostname so the dashboard's host-only cookies are never sent to it. Crow uses a **sidecar node**: a second `tailscaled` with its own state, MagicDNS name and certificate, running in userspace networking mode (no `NET_ADMIN`, no `/dev/net/tun`) with host networking so its Serve proxy can reach host loopback.

Tailscale Services were not chosen: they require the host to be a tagged node, need admin approval, and cannot carry Funnel.

The sidecar's Serve config is shipped as a template, `bundles/artifacts/sidecar/serve.json.tmpl`. It maps only `https://${TS_CERT_DOMAIN}:443` to `http://127.0.0.1:{{ORIGIN_PORT}}`, with no Funnel. tailscaled fills in `${TS_CERT_DOMAIN}` itself; `renderServeConfig()` fills in the port.

Operator notes:
- Use a **single-use** auth key, and delete it once the node appears. The node key then lives only in the sidecar's state volume.
- Decide key expiry explicitly. An expired node quietly breaks every artifact frame. Turning expiry off for this node is recommended, and the health check below warns either way.
- Pin the sidecar image by digest.

### Health check

`sidecar-health.js` audits the sidecar every 5 minutes (cached), when `CROW_ARTIFACT_SIDECAR_SOCKET` and `CROW_ARTIFACT_ORIGIN_PORT` are both set. It runs `tailscale --socket <socket> status --json` and `serve status -json`, without sudo. It reports:

| Problem | Meaning |
|---|---|
| `logged-out` | `BackendState` is not `Running`. |
| `key-expiring` | The node key expires within 14 days (or already has). |
| `funnel-on` | Any `AllowFunnel` entry is true. |
| `unexpected-mapping` | Anything other than the one 443 → `http://127.0.0.1:<origin port>` proxy. |
| `unreachable` | The CLI failed or returned something unreadable. This is never treated as healthy. |

Each problem becomes its own warn issue in the Nest health panel (`artifact-node:<problem>`), so the health monitor pushes a notification for each new one.

## The fallback: no second hostname

Without `CROW_ARTIFACT_ORIGIN_URL`, the origin is `http://localhost:<port>`, and `isolationFor()` reports `shared-host`.

- The browser does send the dashboard's cookies to a second port on the same host. The listener deletes them before anything reads them.
- The sandbox still holds: top-level loads run opaque, and `document.cookie` throws.
- `http://localhost:<port>` is reachable only from the machine Crow runs on, so a dashboard opened from another device cannot show artifacts on a fallback install.

## The trusted viewer

`bundles/artifacts/panel/static/viewer.js` runs on the dashboard origin and frames artifact content (`window.CrowArtifactViewer.mount(...)`).

- **Viewer page CSP.** `viewerCsp(origin)` in `policy.js` narrows the viewer page's `frame-src` to `<artifact origin>/v/`, with no `'self'` and no scheme source. A value that is not a bare `scheme://host[:port]` gives `frame-src 'none'`. Chromium checks the parent's `frame-src` on every navigation of a child frame, including ones the child starts itself, before the request is sent. So a link click or a script navigation inside an artifact cannot reach another site.
- **CSP canary, fail closed.** Before minting a token, the viewer frames `https://csp-canary.invalid/` in a hidden frame. That must raise a `securitypolicyviolation`. If it does not, the narrowed CSP is not in force (for example, the page arrived by a Turbo body swap and kept another page's policy), and nothing is minted or shown.
- **Grant validation.** The sandbox must be exactly `""` or `allow-scripts` and agree with the type. The URL must be `http(s)://host[:port]/v/<token>/` and never the dashboard's own origin. Scripted grants need a nonce of at least 16 characters.
- **Navigation tripwire.** A second `load`, a missing hello, a wrong nonce, a message from a non-opaque origin, an oversized message, a flood, a malformed message or a script-free frame that speaks all close the frame and report the trip. A trip is terminal for that mount: `load()` and `reload()` refuse afterwards.
- **Messages are proposals.** Every message from the frame is validated for source, origin, shape, size, rate and nonce. Comment anchors are acted on only through the trusted rail. The viewer posts only `{kind: "comment-mode"}` into the frame.
- Jumping to a section of a script-free document mounts a fresh frame (a new token and a first load), so a later real navigation can never hide behind an "expected" load.

## Verified, and what remains

`tests/artifact-isolation-live.test.js` runs the real origin handler and the real viewer in headless Chromium, against fake hostnames mapped to loopback. Inside a sealed frame:

- No request reaches another host through fetch, XHR, WebSocket, EventSource, `sendBeacon`, images, prefetch, preload, stylesheets, `@import`, fonts, media, nested frames, `embed`/`object`, form posts, `<a ping>` or popups.
- Storage and cookies are unreachable, and `self.origin` is `"null"`.
- Workers do not run, and `eval`, `new Function` and string timers are refused.
- With the viewer's narrowed CSP, self-navigation by link (`<a>`, `<area>`, SVG `<a>`, `<a download>`) and by script (a 200, a 204, or a response that never finishes) sends **nothing**. A permissive positive control shows each of those channels is live.
- Tricky documents (unclosed comments, CDATA, `<template>`, raw-text elements, foreign content, `<plaintext>` and others) run no script and send nothing when served scripts-off, top-level or framed. Each counts only when an unprotected control shows that document is live.

Known residuals:
- **WebRTC.** ICE candidate gathering still works under `connect-src 'none'` in scripted types. This is why versions shaped by outside text are served script-free until approved.
- **Firefox and Safari** have not been verified for the narrowed `frame-src`. There, the tripwire (after the fact) and scripts-off are the defence. A navigation answered with 204, or one that never finishes, fires no `load` event, so the tripwire alone cannot catch it.
- View tokens live in memory per gateway process. A restart means reloading open views.
