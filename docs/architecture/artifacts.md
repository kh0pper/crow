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
- **Diagrams are XHTML.** A diagram's `index.html` is stored and served as `application/xhtml+xml`, so the browser's XML parser reads the SVG, never the HTML tokenizer (no integration points, raw-text elements or tokenizer quirks to differ on). At save the renderer refuses anything an XML parser would refuse, so a saved diagram never shows a parse-error page: characters and references XML forbids, `]]>` in text, mismatched or repeated names, and nesting deeper than 254 (libxml2's limit, less the page's own two levels). It also refuses two things that parse but go wrong: SVG names in a case the XML parser does not fix up (`viewbox`, `lineargradient`: the HTML parser corrected these, XML silently ignores them), and any namespace declaration except the SVG namespace and `xmlns:xlink` on the root (so no `xml:base` alias and no namespace switch). It makes the SVG namespace explicit on the root. The HTML-era checks still run as well. The rules follow XML 1.0 and Namespaces; the live differential test checks them against Chromium only. The diagram row's CSP, the empty sandbox, `nosniff` and byte-for-byte serving are unchanged. Versions saved before this change stay `text/html` until they are saved again; that includes versions from before the bot-SVG checks existed, which the sandbox and CSP alone still seal.
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
| `CROW_ARTIFACT_ORIGIN_PORT` | Port of this instance's origin listener, printed in its Serve Proxy target (`CROW_ARTIFACT_SIDECAR_TARGET`). It is not necessarily a loopback port: `CROW_ARTIFACT_ORIGIN_BIND` decides where it listens. Unset: nothing listens and artifact viewing is off. |
| `CROW_ARTIFACT_ORIGIN_URL` | The origin browsers use, on its **own** hostname, e.g. `https://<instance>-artifacts.<tailnet>.ts.net`. Scheme, host and optional port only. Unset: the loopback fallback below. |
| `CROW_ARTIFACT_ORIGIN_BIND` | Bind address, default `127.0.0.1`. With a sidecar node this is **normally not loopback**: a host-run gateway binds the dedicated bridge's gateway IP (e.g. `172.30.0.1`) and the sidecar reaches it from its own network namespace. A container instance binds `0.0.0.0` inside its namespace, publishes on host loopback, and **must** set `CROW_ARTIFACT_SIDECAR_TARGET` (a wildcard bind alone reads as `host-loopback`). |
| `CROW_ARTIFACT_SIDECAR_TARGET` | The exact Serve Proxy target this instance's sidecar should map `https://<instance>-artifacts.<tailnet>:443` to: `http://<hostname or IPv4>:<port>` only, with no path, userinfo or query (IPv6 brackets optional) — e.g. `http://172.30.0.1:3090` or `http://<container-name>:3090`. Unset: the health check derives it from `CROW_ARTIFACT_ORIGIN_BIND` when that is a specific non-loopback address, and reports `host-loopback` when the bind is loopback (in any spelling) or a wildcard. A target that itself names this machine — loopback, a wildcard, or `localhost` — is reported as `host-loopback` too. |
| `CROW_ARTIFACT_SIDECAR_SOCKET` | The sidecar node's tailscaled socket, for the health check. Unset while `CROW_ARTIFACT_ORIGIN_URL` is set: the node is **not monitored** and the Nest raises a warn (`artifact-node:unmonitored`). |

Registered ports (see [port allocation](../developers/port-allocation.md)): `CROW_ARTIFACT_ORIGIN_PORT=3090` for the main instance, `CROW_ARTIFACT_ORIGIN_PORT=3091` for a second co-hosted instance, `CROW_ARTIFACT_ORIGIN_PORT=3092` for a household container instance. 3093 is reserved for the later public-link listener.

`runtime.js` holds the process-wide token store and content resolver, and starts the listener from these variables. `isolationFor(dashboardHost)` reports `own-host` when the origin's hostname differs from the dashboard's, `shared-host` on the fallback, and `unavailable` when no origin is running. The listener is started by the Artifacts bundle's gateway mount. In this release nothing starts it yet.

## Hostname: a sidecar Tailscale node

The origin needs its own hostname so the dashboard's host-only cookies are never sent to it. Crow uses a **sidecar node**: a second `tailscaled` with its own state, MagicDNS name and certificate, running in userspace networking mode (no `NET_ADMIN`, no `/dev/net/tun`).

### Its own network namespace, never `network_mode: host`

tailscaled's userspace netstack forwards an inbound TCP connection on **any** port of the node's tailnet address to `127.0.0.1:<the same port>` and dials it with a plain Go dialer **inside the network namespace the sidecar runs in**. With host networking that `127.0.0.1` is this computer's loopback, so every loopback port here — the dashboard, an admin API, a database — would answer the tailnet. The sidecar must therefore run in its own namespace (`bundles/artifacts/sidecar/compose.sample.yml` does: a dedicated bridge, no `network_mode: host`, no `ports:`), the Serve Proxy target is never loopback (see `host-loopback` below), and the origin is bound where only the sidecar can reach it:

- **Host-run gateway.** Give the sidecar a dedicated docker bridge — an EXTERNAL network created once, so its subnet and gateway survive `compose down`/`up` — and bind the origin to that bridge's **gateway IP** (`CROW_ARTIFACT_ORIGIN_BIND=172.30.0.1`; a bridge IP is normal here, not a mistake). The sidecar then reaches `http://172.30.0.1:<origin port>` from its own namespace. Allow it in exactly one place: a `ufw` rule scoped to that bridge, that sidecar IP and that port (`ufw allow in on <bridge> from <sidecar IP> to <bridge gateway> port <origin port> proto tcp`), so nothing else on the host's networks reaches the origin.
  - **`ufw` has to be doing something.** This rule is a hole in a default-deny wall; ufw's rules are only consulted when the firewall is enabled with a default-deny incoming policy. The whole design relies on that (`ufw status verbose` → `Status: active`, `Default: deny (incoming)`), which is how the dashboard host is set up. On a host whose firewall is off, that one allow rule is decoration and the origin is exposed to every network the host is on — the Nest's Privacy card warns about exactly this when the gateway is bound beyond loopback.
  - **Fence the sidecar subnet by default** (DOCKER-USER, iptables; `nft` hosts use the same chain through the `iptables` shim). The sidecar needs the origin and the tailnet — nothing else on this machine. `ESTABLISHED,RELATED` is accepted FIRST (a drop rule's own return traffic, and Docker's published-port flows, must not be cut mid-stream), and the origin's own bridge subnet is excluded from the `172.16/12` drop because the origin lives on it (`172.30.0.0/24` is inside `172.16.0.0/12`):

    ```bash
    DOCKER_USER_RULES=$(cat <<'EOF'
    -I DOCKER-USER 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    -A DOCKER-USER -s 172.30.0.0/24 -d 10.0.0.0/8 -j DROP
    -A DOCKER-USER -s 172.30.0.0/24 -d 172.16.0.0/12 ! -d 172.30.0.0/24 -j DROP
    -A DOCKER-USER -s 172.30.0.0/24 -d 192.168.0.0/16 -j DROP
    -A DOCKER-USER -s 172.30.0.0/24 -d 100.64.0.0/10 -j DROP
    -A DOCKER-USER -s 172.30.0.0/24 -d 169.254.0.0/16 -j DROP
    EOF
    )
    printf '%s\n' "$DOCKER_USER_RULES" | iptables-restore --noflush
    ```

    Persist them with a small oneshot unit that re-applies the same rules on every boot, like the engine fence's re-apply service (`docs/guide/engine-fence.md` is the pattern: a script in `/usr/local/sbin`, a `.service`, `After=docker.service`, `WantedBy=multi-user.target`):

    ```ini
    # /etc/systemd/system/crow-artifacts-fence.service
    [Unit]
    Description=Crow Artifacts: fence the sidecar bridge subnet (DOCKER-USER)
    After=docker.service
    Requires=docker.service

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    ExecStart=/usr/local/sbin/crow-artifacts-fence apply
    ExecStop=/usr/local/sbin/crow-artifacts-fence remove

    [Install]
    WantedBy=multi-user.target
    ```

    The script is the rule text above with `-C` before each `-A` (apply once, never stack duplicates) and a `remove` that deletes by the same spec. Note the cost, because it is the point: a fenced sidecar can no longer reach this machine's LAN addresses (or any private range) directly, so Tailscale relays those peers over **DERP** instead of a direct path — slower, still end-to-end encrypted, and the reason a direct LAN path never has to be trusted. A deployment that needs direct paths has to narrow the fence to the ranges it really means to forbid, and say so here.
- **Household container instance.** The sidecar joins the instance's own compose network and proxies by container name (`http://<container-name>:3092`). The sidecar can be part of that compose file, and no host publish is needed. `network_mode: service:<x>` or `container:<x>` is **not** an alternative on any host: those join another container's namespace, so "its own namespace" is gone and a loopback target is reachable again — the same flaw as `network_mode: host`, wearing a different name.

Tailscale Services were not chosen: they require the host to be a tagged node, need admin approval, and cannot carry Funnel.

The sidecar's Serve config is shipped as a template, `bundles/artifacts/sidecar/serve.json.tmpl`. It maps only `https://${TS_CERT_DOMAIN}:443` to `{{ORIGIN_TARGET}}`, with no Funnel. tailscaled fills in `${TS_CERT_DOMAIN}` itself; `renderServeConfig(tmpl, { target })` fills in the target, and accepts only `http://<hostname or IPv4>:<port>`: a path, userinfo, query or another scheme throws.

Operator notes:
- Use a **single-use** auth key, and delete it once the node appears. The node key then lives only in the sidecar's state volume.
- Decide key expiry explicitly. An expired node quietly breaks every artifact frame. Turning expiry off for this node is recommended, and the health check below warns either way.
- Pin the sidecar image by digest, and never publish a port from it. It must also never be given `network_mode: host`, `network_mode: service:<x>` or `network_mode: container:<x>` — the last two join another container's namespace, which is the same exposure under a different name (only `bridge` / a compose network is right).
- **Tag the node and grant it as little as possible.** Give it a tag (`tag:<name>`, from the auth key's ACL) and a grant that allows only `tcp:443` to it. Under an allow-all policy (`"action": "accept"` with no ports) that grant is useless — every device on the tailnet already reaches every port the node's netstack answers — so the tag only pays off once the policy is narrower.
- **Capabilities.** Drop `ALL` and add back only `DAC_OVERRIDE`: the sidecar needs no `NET_ADMIN` and no `/dev/net/tun`, but it runs as root inside the container over bind-mounted state and socket directories the HOST user owns with mode `0700`, and root in a user namespace cannot even traverse (let alone write) a directory it does not own. `DAC_OVERRIDE` is what lets it create and write its state there; nothing is chowned.

### Boot ordering

The origin binds a docker bridge's gateway address, and that address does not exist until `docker.service` has created the bridge. A gateway that starts first fails the bind with `EADDRNOTAVAIL` and would stay off until someone restarted it, so:

- the gateway unit must start **after** docker — `After=docker.service` in a drop-in (`/etc/systemd/system/crow-gateway.service.d/after-docker.conf`), and `Wants=docker.service` if docker is not enabled at boot on this host;
- and, as a backstop, the mount retries the origin's listener every 5 s for 2 minutes (`startArtifactOriginWithBindRetry` in `runtime.js`), in the background so the dashboard's own listen never waits, then warns that the origin is off.

### Health check

`sidecar-health.js` audits the sidecar every 5 minutes (cached), when `CROW_ARTIFACT_SIDECAR_SOCKET` and `CROW_ARTIFACT_ORIGIN_PORT` are both set. It runs `tailscale --socket <socket> status --json` and `serve status -json`, without sudo, and then probes the sidecar's own tailnet address on this gateway's HTTP port (next paragraph). The mapping it expects is `CROW_ARTIFACT_SIDECAR_TARGET`, else `http://<CROW_ARTIFACT_ORIGIN_BIND>:<port>` when that bind is a specific non-loopback address. It reports:

| Problem | Meaning |
|---|---|
| `logged-out` | `BackendState` is not `Running`. |
| `key-expiring` | The node key expires within 14 days (or already has). |
| `funnel-on` | Any `AllowFunnel` entry is true. |
| `host-loopback` | The sidecar is on the host's network (or another container's), so userspace netstack answers **every** port of its tailnet address on this computer's loopback. Three ways in, one finding: a live Serve Proxy target that names this machine in any spelling a dialer accepts (`127.0.0.1`, `127.0.0.2`, `127.1`, `2130706433`, `::1` in any expansion, `::ffff:127.0.0.1`, `localhost`, `localhost.`, `*.localhost`, a wildcard `0.0.0.0` / `::`, or tailscaled's scheme-less `3090` / `localhost:3090`); a `CROW_ARTIFACT_SIDECAR_TARGET` or `CROW_ARTIFACT_ORIGIN_BIND` of that shape, where no non-loopback target exists at all; or the active probe below. Reported instead of `unexpected-mapping`. Move the sidecar to its own network. |
| `unexpected-mapping` | Anything other than the one 443 → `<CROW_ARTIFACT_SIDECAR_TARGET>` (or the `<bind>:<port>` derived from the environment) proxy. |
| `unreachable` | The CLI failed or returned something unreadable. This is never treated as healthy. |

**The active probe.** A non-loopback target does not prove anything by itself — a sidecar with host networking answers a bridge-IP Proxy happily. So each audit also takes the sidecar's own tailnet IPv4 (`status --json` → `Self.TailscaleIPs`) and connects to it on **this gateway's HTTP port** (`PORT` / `CROW_GATEWAY_PORT`, the same expression the listener uses), 2 seconds at most. Netstack completes that connect only after its backend dial to `127.0.0.1:<port>` succeeded, so a completed connect **is** a shared namespace (`host-loopback`); a refusal or a timeout is a namespace of its own. It runs only while the sidecar is `Running`, never throws, and is cached with the rest of the result (one probe per 5-minute read). Its false-negative is a host whose gateway answers on no loopback address; its false-positive would need something else listening on the sidecar's tailnet address at the gateway's port.

**A container instance must name its target.** Inside a container the origin binds `0.0.0.0` (the instance's own namespace, published on host loopback) — but from inside that namespace a wildcard bind says nothing about what the sidecar can reach, so the audit reports `host-loopback`. Set `CROW_ARTIFACT_SIDECAR_TARGET=http://<container-name>:<port>` on a container instance; that is the documented default for the household layout.

Each problem becomes its own warn issue in the Nest health panel (`artifact-node:<problem>`), so the health monitor pushes a notification for each new one. A problem code the panel does not know fails closed as `unreachable`. When `CROW_ARTIFACT_ORIGIN_URL` is set but `CROW_ARTIFACT_SIDECAR_SOCKET` is not, nothing can be checked at all — that raises `artifact-node:unmonitored` (warn) instead of passing silently.

## The fallback: no second hostname

Without `CROW_ARTIFACT_ORIGIN_URL`, the origin is `http://localhost:<port>`, and `isolationFor()` reports `shared-host`.

- The browser does send the dashboard's cookies to a second port on the same host. The listener deletes them before anything reads them.
- The sandbox still holds: top-level loads run opaque, and `document.cookie` throws.
- The CSP source base is pinned to `http://localhost:<port>` — it is **never** derived from the request's `Host` header, so a forged or rebinding `Host` cannot widen `script-src`.
- `http://localhost:<port>` is reachable only from the machine Crow runs on, so a dashboard opened from another device cannot show artifacts on a fallback install.
- A bind that is **not** loopback or a wildcard (a sidecar bridge gateway IP, say) makes the fallback that address instead — `http://172.30.0.1:<port>` — because `localhost` does not answer there. `isolationFor()` then reports `own-host`, and the fallback is reachable from the bridge only.

## The trusted viewer

`bundles/artifacts/panel/static/viewer.js` runs on the dashboard origin and frames artifact content (`window.CrowArtifactViewer.mount(...)`).

**The viewer page.** `/dashboard/artifacts/view/:id[?v=n&thread=t]` is the only page that frames the artifact origin. It is a standalone document (no dashboard navigation) with the core `viewerCsp` header, which also sends `frame-ancestors 'self'`. It shows:
- the artifact, with a version switcher and the "Run scripts" button for tainted versions;
- numbered pins for comments;
- a threads column on wide screens, or a bottom sheet on phones and in narrow panes;
- one primary action, "Send N comments to chat";
- when it has the whole tab, links back to the Library and the Crow's Nest (in the hub pane, the pane's own close does that).

On a document, Comment does not open a list: you select the words you mean, a "Comment on '…'" button appears, and the comment is tied to that block and quote. The block's text comes from the version's stored block map and the quote must be in that block, or the comment is kept as a plain text quote. "Comment on a section" in the ⋯ menu is the keyboard and screen-reader way in. A document saved before selection comments existed has no rendered block text stored; once per gateway process, on the first Artifacts request, Crow recomputes that text from the version's own Markdown (only if the result matches both the stored blocks and the stored page exactly) and places its existing block comments on their words. A version whose stored page does not match is marked and left alone (if the store can't be read, nothing is marked and the next start tries again): it checks a selection against the block's Markdown instead, capped at 400 characters, and a longer selection is kept as a text quote. The viewer receives every kept version's block text (up to 4,000 characters per block) with the artifact.

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
- **Writing needs a link (ask first).** From a Perch chat, `artifact_update` and `artifact_round_done` work only when the chat is linked to the artifact (the link must name the same bot), or the chat holds a round bound to it: delivered to it, targeted at it and not yet bound, or the board card its session is running. A session running a card the owner made also counts. Anything else gets one static `needs_link` answer (the same for a missing, foreign or unbound round, so rounds cannot be probed), audited with the reason kept server-side; the bot is told to call `artifact_attach` and wait. The gate applies only to the `perch` gateway, the one place the card can be shown. Every other gateway is exempt (Discord, Gmail, jobs, crow-messages rooms, glasses, the companion, Telegram, Slack). That is an accepted residual: a bot that reaches an artifact from any of them, including through a job it made for itself with board tools, can update it without a link, so ask-first is advisory for such bots. What those turns write is saved as untrusted when the turn has no clean session record. A bot granted `artifact_update` also gets `artifact_find`, `artifact_attach` and the two-step upload tools (`artifact_upload_begin`, `artifact_upload_commit`) in its stored tools (once at boot and on every Bot Builder save), unless that would pass its model's tool limit.
- **Who may work on an artifact.** The bot that made it, plus any bot the owner picks with "Let a bot work on this" in the viewer's menu (`artifact_bot_access`). Only the owner can grant or revoke, from the dashboard; no bot tool does it. Revoking also unlinks that bot's chats.
- **Finding one.** `artifact_find` takes an id, a viewer link or words from the title, and only searches what that bot may already see. For a bot, a title that came from outside the owner's Crow is never matched, so substring guesses cannot read it.
- **Sending comments.** Send opens a sheet: which comments to include, then where. The choices are the linked chats (most recent first, with any that cannot take it shown disabled), a new chat with the bot, or a board card when there is a board. The chat the viewer was opened from is preselected. The server checks the chosen chat again: it must be actively linked, its bot must have access, the chat must be that bot's own, and the bot must still have the Artifacts tools. The chat is then saved on the round (`target_thread`), and it is the **only** place the round can go, from the Send and from any retry. There is no "any live chat" or "the chat that made it" fallback. A sleeping chat is woken. If the chat was stopped, unlinked or locked, the round fails with that reason, its comments become sendable again, and the owner is told.
- **Trust (D23).** A chat that has read outside text (tainted) can still receive the owner's own comments. Anything it writes is saved as shaped from outside, and the scripts-off rule then applies. A *locked* chat, one holding a round with outside text, never receives a trusted round. A round that includes outside text, or turns untrusted when it is delivered, always goes to a new locked chat, never to the chosen one. `isLocked` is checked to be at least as strict as the MCP tools' own scope check.
- **Feedback cards.** A chat shows one card for each round delivered to it: "Feedback on &lt;title&gt; vN · k comments". Expanding it shows the comments that were sent, not ones added later. The card routes refuse untrusted rounds outright, so text from contacts never appears on one.

## Big sources: the two-step upload

Everything a bot saves normally travels in ONE tool argument, so a big source is bounded by the model's output limit rather than by storage: a 31 KB page was truncated twice and silently lost characters. So there are two ways in, and the inline one now fails fast.

- **The inline cap.** `artifact_create` and `artifact_update` refuse any of `source.html` / `markdown` / `svg` / `source` longer than `LIMITS.inlineSourceChars` (24000 characters) with `too_big_inline`, before any store call: nothing is written, no version is numbered, no round is touched. The cap is a signpost to the upload, so it applies only to a caller that can act on it (operator ruling 2026-11-16, option A): the operator session, or a verified bot that holds the upload pair (`artifact_upload_begin` + `artifact_upload_commit`, or the whole `artifacts` server entry), has `bash` in `tools.pi_builtin`, whose effective shell policy is not `deny` (`effectiveShellMode`; an allowlist must allow `curl`), and that is not in a locked/untrusted round scope. Everyone else — no shell tool, a def that cannot be read, a scoped round — keeps the old inline behaviour: no 24k cap, bounded by the per-type caps and the 1 MB JSON parser. (`canUploadSource` in `mcp.js`; `canUpload` is the test seam.) Assets (base64 files) are not affected.
- **A bot reaches the upload route through a door.** A contained bot has no network, so `PUT /artifacts/upload/` is a bot door (`servers/shared/bot-doors.js`, operator ruling 2026-11-16). The door list is paths only, so the door admits every method on that prefix; the route itself is a PUT route and refuses an unknown token with a static 404, so the token remains the only capability.
- **The upload.** `artifact_upload_begin` (`field`, `bytes` declared, optional `sha256` and `artifact_id`) returns `upload_id`, `put_url`, `expires_at` and `max_bytes`. The bot PUTs the raw file to `put_url` — a plain `PUT /artifacts/upload/<token>` on the gateway, Caddy or loopback — and then `artifact_upload_commit` runs the SAME `doCreate`/`doUpdate` body the inline tools run, so validation, versioning, dedup, ask-first/link, round and taint gates are identical.
- **Staging is in memory** (`bundles/artifacts/server/uploads.js`): no table, no schema change, no disk copy. An entry holds the claiming actor (kind, id, thread), the field, the optional target artifact, the declared size, an optional sha256, the expiry (10 minutes) and, once uploaded, the text. At most 8 pending per actor and 32 in total.
- **The path token is the capability.** Only its sha256 is stored, and the lookup compares digests in constant time. There is no cookie, token or CSRF check (a bot has none), which is why the route must never be reachable from outside: it is not in `PUBLIC_FUNNEL_PREFIXES`, so the funnel middleware refuses it. The handler caps the body itself: it streams with a running counter, stops reading at the cap (413) and never buffers more than it; non-UTF-8 text and a declared sha256 that does not match are refused with 400; a second PUT to the same token is 409; unknown, expired and already-committed tokens are one static 404.
- **One use.** The commit marks the entry used before the store is called and drops it afterwards, success or failure — a failed commit needs a fresh upload, never a retry of the same token.
- **The owner's import.** The viewer's "Import file" (`POST /api/artifacts/:id/import`, dashboard session + CSRF, no bot tool writes it) is saved as trusted: it is the owner's own gesture, so the version it makes is not tainted.

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
