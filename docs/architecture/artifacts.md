# Artifacts: the sealed artifact host

Crow Artifacts lets bots make pages, documents and diagrams that you view, comment on and send back for revision. Bot-made content is untrusted, so it is never served from the dashboard. It is served from a separate **artifact origin** and shown in a sealed frame by a **trusted viewer** on the dashboard.

This page covers that host: the origin, view tokens, the viewer, the sidecar network node and its health check, what is enforced, and what remains a known residual. The bundle that stores artifacts and drives feedback rounds builds on it.

## The artifact origin

`servers/gateway/artifact-origin/` is a minimal `node:http` listener. It is deliberately **not** Express and not part of the gateway app: it shares no middleware, session handling or Funnel allow-list with the dashboard.

- **One route:** `GET`/`HEAD` `/v/<token>/<path>`. The token is 43 base64url characters. The path is decoded and must be a plain relative path: no `..`, no encoded separators, no control characters. `/v/<token>/` serves the version's `index.html`, and a missing trailing slash is a 404, never a redirect.
- **Every response, errors included,** carries:
  - a `Content-Security-Policy` that ends in a `sandbox` directive, so even a top-level load runs as an opaque origin;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store, private` and `X-Robots-Tag: noindex`.
  - Node's own parse-error responses are covered too: a `clientError` handler answers a malformed request line with 400 and an oversized header with 431, both with the same base headers. A connection that times out is destroyed **without any response** — nothing is served, so there are no bytes to protect.
- **Never** a `Set-Cookie` and never a 3xx. The `Cookie` request header is removed from every header view (`headers`, the lazily cached `headersDistinct` and `rawHeaders`) before anything reads the request, and nothing logs request paths (they carry tokens).
- **Funnel traffic is refused.** Any request carrying `Tailscale-Funnel-Request` gets 403, and `CROW_DASHBOARD_PUBLIC` does not override that. Peers must be loopback, a private LAN range or the tailnet.
- Range requests are not honoured: the full body comes back with 200.

### Per-type policy

`policy.js` holds one CSP row per artifact type. Every row has `default-src 'none'`, `connect-src 'none'`, `worker-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`, `frame-src 'none'`, `manifest-src 'none'` and `media-src 'none'`. Sources are limited to the version's own token path. `'unsafe-eval'` is never granted.

| Types | Sandbox | Scripts |
|---|---|---|
| `diagram`, `image`, `docx`, and any scripts-off version (the "sealed" row) | `sandbox` (no flags) | none |
| `document` | `sandbox allow-scripts` | the anchor helper only (its exact URL; no inline, no other file) |
| `page`, `slides` | `sandbox allow-scripts` | token path + inline |
| `data`, `map` | `sandbox allow-scripts` | token path only |
| `pdf` | `sandbox allow-scripts` | token path only (a fixed viewer file) |

The sandbox never includes `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`. The iframe's `sandbox` attribute always matches the CSP row.

- Scripted 200 responses also carry `Access-Control-Allow-Origin: *` (never with credentials), because module scripts loaded from an opaque origin are CORS requests.
- **Scripts off.** A version shaped by text from outside your Crow is served script-free until you approve it: the token carries `scriptsOff`, the sealed row is used, and the bytes are served unchanged. Safety comes from the CSP header, never from rewriting markup; the origin does not parse bot markup at all.
- **Documents run only the helper.** A document has no scripts of its own (its HTML is sanitized Markdown), but it runs the anchor helper so you can comment on text you select. Its policy allows exactly one script, the helper's own URL, and that URL never redirects. Unlike a sealed frame, a document could follow a `<meta http-equiv=refresh>`; the renderer never emits one, and the viewer's frame-src and second-load tripwire stand behind it. One function (`frameGrantFor`) decides the sandbox and whether a frame speaks, for the viewer grant, the origin and the load-evidence table alike.
- **The anchor helper.** For scripted HTML and documents, a small helper script (`anchor-helper.js`) is placed at a fixed spot: after an optional byte-order mark, leading whitespace and a `<!doctype …>`, otherwise at byte 0. Placement grants nothing. If the helper does not say hello, the viewer closes the frame and asks the server what happened (see "Couldn't load — retry" below).

### View tokens

`view-tokens.js` keeps tokens in memory, in the gateway process that serves the origin.

- A token grants one artifact version, read-only. It lasts 30 minutes, and the viewer mints a fresh one for every frame load.
- Only a SHA-256 of each token is held.
- `mint()` also returns a `tokenId`: the SHA-256 the store is keyed on. It is not a credential (it cannot be turned back into the token, and the origin never accepts it), so the viewer can use it to ask about a load. `revokeToken(tokenId)` drops one token; `revokeArtifact` drops all of an artifact's.
- **Load evidence (D24).** For each token, the origin records whether it served the token's document (`docServed`), injected the anchor helper into it (`helperInjected`) and served the helper (`helperServed`). Each mark is made only for a GET that answers 2xx, and before the response is written. HEAD requests, errors and other paths mark nothing, and content cannot unmark anything.
- Each token carries a per-load nonce (the tripwire handshake) and the dashboard origin that minted it. That origin becomes the response's `frame-ancestors`, so no per-instance configuration is needed. `mint()` accepts only a bare `scheme://host[:port]` origin (or null) and throws `bad_grant` on anything else: the value is interpolated into the CSP **before** the `sandbox` directive, and CSP keeps the first of duplicate directives, so a smuggled `; sandbox …` suffix must be impossible to store.
- A gateway restart drops every token. Open frames keep their loaded document, and lazy loads fail until the view is reloaded.

### Configuration

| Variable | Meaning |
|---|---|
| `CROW_ARTIFACT_ORIGIN_PORT` | Loopback port of this instance's origin. Unset: nothing listens and artifact viewing is off. |
| `CROW_ARTIFACT_ORIGIN_URL` | The origin browsers use, on its **own** hostname, e.g. `https://<instance>-artifacts.<tailnet>.ts.net`. Scheme, host and optional port only. Unset: the loopback fallback below. |
| `CROW_ARTIFACT_ORIGIN_BIND` | Bind address, default `127.0.0.1`. A container instance binds inside its namespace and publishes on host loopback. |
| `CROW_ARTIFACT_SIDECAR_SOCKET` | The sidecar node's tailscaled socket, for the health check. Unset while `CROW_ARTIFACT_ORIGIN_URL` is set: the node is **not monitored** and the Nest raises a warn (`artifact-node:unmonitored`). |

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

Each problem becomes its own warn issue in the Nest health panel (`artifact-node:<problem>`), so the health monitor pushes a notification for each new one. A problem code the panel does not know fails closed as `unreachable`. When `CROW_ARTIFACT_ORIGIN_URL` is set but `CROW_ARTIFACT_SIDECAR_SOCKET` is not, nothing can be checked at all — that raises `artifact-node:unmonitored` (warn) instead of passing silently.

## The fallback: no second hostname

Without `CROW_ARTIFACT_ORIGIN_URL`, the origin is `http://localhost:<port>`, and `isolationFor()` reports `shared-host`.

- The browser does send the dashboard's cookies to a second port on the same host. The listener deletes them before anything reads them.
- The sandbox still holds: top-level loads run opaque, and `document.cookie` throws.
- The CSP source base is pinned to `http://localhost:<port>` — it is **never** derived from the request's `Host` header, so a forged or rebinding `Host` cannot widen `script-src`.
- `http://localhost:<port>` is reachable only from the machine Crow runs on, so a dashboard opened from another device cannot show artifacts on a fallback install.

## The trusted viewer

`bundles/artifacts/panel/static/viewer.js` runs on the dashboard origin and frames artifact content (`window.CrowArtifactViewer.mount(...)`).

**The viewer page.** `/dashboard/artifacts/view/:id[?v=n&thread=t]` is the only page that frames the artifact origin. It is a standalone document (no dashboard navigation) with the core `viewerCsp` header, which also sends `frame-ancestors 'self'`. It shows:
- the artifact, with a version switcher and the "Run scripts" button for tainted versions;
- numbered pins for comments;
- a threads column on wide screens, or a bottom sheet on phones and in narrow panes;
- one primary action, "Send N comments to chat";
- when it has the whole tab, links back to the Library and the Crow's Nest (in the hub pane, the pane's own close does that).

On a document, Comment does not open a list: you select the words you mean, a "Comment on '…'" button appears, and the comment is tied to that block and quote. The block's text comes from the version's stored block map and the quote must be in that block, or the comment is kept as a plain text quote. "Comment on a section" in the ⋯ menu is the keyboard and screen-reader way in.

The owner can edit or delete their own comments from the threads column (`PATCH`/`DELETE /api/artifacts/:id/comments/:cid`). Never while a round or ask holds the thread: what the bot was sent must match what the owner sees, so the server answers `comment_locked` and the viewer hides the buttons (`GET /api/artifacts/:id` lists `lockedThreads`). A contact's or a bot's words are never edited; a contact's comment stays deletable at any time. Edits are stamped (`edited_at`) and audited.

The Perch hub's artifact card opens this page beside the chat (a same-origin iframe docked at the right from 1024 px, a full-screen sheet below that) or in a new window (`target=_blank`, `rel=noopener`). The hub itself never frames the artifact origin. The Artifacts page in the dashboard (the Library) lists artifacts with their badges (type, version, scripts off, contact comments, linked chats), search and filters, and a detail drawer: Versions (approve), Linked chats (open, Unlink), Projects and Sharing (not built yet, and they say so) and the last 50 audit rows. It frames nothing and sends no policy of its own, because Turbo would carry a narrowed one into the next panel. Its old `?id=` links redirect to the viewer page.

- **Viewer page CSP.** `viewerCsp(origin)` in `policy.js` narrows the viewer page's `frame-src` to `<artifact origin>/v/`, with no `'self'` and no scheme source. A value that is not a bare `scheme://host[:port]` gives `frame-src 'none'`. Chromium checks the parent's `frame-src` on every navigation of a child frame, including ones the child starts itself, before the request is sent. So a link click or a script navigation inside an artifact cannot reach another site.
- **CSP canary, fail closed.** Before minting a token, the viewer frames `https://csp-canary.invalid/` in a hidden frame. That must raise a `securitypolicyviolation`. If it does not, the narrowed CSP is not in force (for example, the page arrived by a Turbo body swap and kept another page's policy), and nothing is minted or shown.
- **Grant validation.** The sandbox must be exactly `""` or `allow-scripts` and agree with the type. The URL must be `http(s)://host[:port]/v/<token>/` and never the dashboard's own origin. Scripted grants need a nonce of at least 16 characters.
- **Navigation tripwire.** A second `load`, a wrong nonce, a message from a non-opaque origin, an oversized message, a flood, a malformed message or a script-free frame that speaks all close the frame and report the trip. A trip is terminal for that mount: `load()` and `reload()` refuse afterwards. A missing hello is decided by the server's evidence (next item).
- **Couldn't load — retry (D24).** When a scripted frame says no hello in time (or fires no `load` at all within 20 seconds), the viewer removes the frame first. Then it asks the owner-only route `GET /api/artifacts/:id/versions/:n/load-evidence?tokenId=…`:

  | What the origin recorded for that token | Result |
  |---|---|
  | the helper was served | flag (the content was parsed and stayed silent) |
  | the document was served without the helper (not HTML) | flag |
  | the document was served, the helper never requested | retry (the bytes never reached the parser) |
  | the document was never served | retry |
  | nothing known (restart, expiry, revocation, another artifact's token) or the route failed | retry |

  The helper is a parser-blocking script placed before any bot byte, so content cannot stop it from being requested; content can only add evidence, and adding it only moves the answer toward a flag. While the answer is pending, the mount refuses to load anything, and a late answer for an older load is ignored. A retry is offered as a button (never automatically); it mints a fresh token and revokes the old one.
- **Messages are proposals.** Every message from the frame is validated for source, origin, shape, size, rate and nonce. Comment anchors are acted on only through the trusted threads column. The viewer posts two things into the frame: `{kind: "comment-mode"}` and `{kind: "pins"}`. Pins are the numbered anchors of the owner's own threads: element selectors and text quotes the content itself proposed. Comment text, authors and contacts' anchors are never posted. The helper answers with rectangles (at most four times a second), which the viewer validates, clamps to the frame and uses only to draw pins. A pin only focuses its thread.
- Jumping to a section of a script-free document mounts a fresh frame (a new token and a first load), so a later real navigation can never hide behind an "expected" load.

## Chats, links and feedback rounds

Artifacts live in chats. Each one is linked to one or more Perch chats (`artifact_links`); its cards appear in every chat it is linked to, and comments go back to one of them.

- **Links.** The chat that made an artifact is its first link, written in the same database batch as the artifact itself, and only for a Perch chat (a channel or job turn has nowhere to show a card). Older artifacts got their first link once, from `origin_session`. No bot can link an artifact by itself: `artifact_attach` only *asks*, and the owner answers a "Link it to this chat?" card in that chat. Only Yes writes a link (audited). Requests are capped per chat per day. Sending your comments to "New chat with &lt;bot&gt;" also links that new chat, except for a round with outside text, whose locked chat is never linked. The owner can Unlink a chat in the Library.
- **Who may work on an artifact.** The bot that made it, plus any bot the owner picks with "Let a bot work on this" in the viewer's menu (`artifact_bot_access`). Only the owner can grant or revoke, from the dashboard; no bot tool does it. Revoking also unlinks that bot's chats.
- **Finding one.** `artifact_find` takes an id, a viewer link or words from the title, and only searches what that bot may already see. For a bot, a title that came from outside the owner's Crow is never matched, so substring guesses cannot read it.
- **Sending comments.** Send opens a sheet: which comments to include, then where. The choices are the linked chats (most recent first, with any that cannot take it shown disabled), a new chat with the bot, or a board card when there is a board. The chat the viewer was opened from is preselected. The server checks the chosen chat again: it must be actively linked, its bot must have access, the chat must be that bot's own, and the bot must still have the Artifacts tools. The chat is then saved on the round (`target_thread`), and it is the **only** place the round can go, from the Send and from any retry. There is no "any live chat" or "the chat that made it" fallback. A sleeping chat is woken. If the chat was stopped, unlinked or locked, the round fails with that reason, its comments become sendable again, and the owner is told.
- **Trust (D23).** A chat that has read outside text (tainted) can still receive the owner's own comments. Anything it writes is saved as shaped from outside, and the scripts-off rule then applies. A *locked* chat, one holding a round with outside text, never receives a trusted round. A round that includes outside text, or turns untrusted when it is delivered, always goes to a new locked chat, never to the chosen one. `isLocked` is checked to be at least as strict as the MCP tools' own scope check.
- **Feedback cards.** A chat shows one card for each round delivered to it: "Feedback on &lt;title&gt; vN · k comments". Expanding it shows the comments that were sent, not ones added later. The card routes refuse untrusted rounds outright, so text from contacts never appears on one.

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
- View tokens live in memory per gateway process. A restart means reloading open views (an open view whose load was in flight is offered a retry, never flagged).
- **A token revoked mid-load.** If a view token is revoked between the document and the helper request (a gateway restart, the 30-minute expiry or the 5000-token eviction — none of which content can cause), the helper is refused and that load is offered a retry rather than flagged.
- **Content can read the owner's pins.** The `pins` message reaches the frame's realm, so the content can see the owner's element selectors and text quotes for that version. They are taken from the content itself, and the frame has no network to send them anywhere.
- **The retry costs one round trip.** A frame whose document was never served or never parsed is offered "couldn't load — retry". A retried load is decided again on fresh evidence, so a page that really stays silent is still flagged on that load.
