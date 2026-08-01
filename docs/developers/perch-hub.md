---
title: Perch Hub
---

# Perch Hub

**Perch** is Crow's session observatory. It is a small web app from the `pi-lab` project, vendored into Crow as the `perch-hub` bundle, run as a gateway-supervised child process on loopback ports, and reached only through the dashboard's own session-gated proxy. Installing it adds a **Perch** entry to the Crow's Nest nav and a new `perch` gateway type in Bot Builder.

Two things ship together and are easy to confuse, so they are named separately throughout this page:

- the **bots lens** — Crow-specific, added upstream behind a flag, showing every bot on the instance and every session it has run on any channel;
- the **dev lens** — Perch exactly as it exists in `pi-lab`: the on-disk pi session browser, plus spawn and resume of long-lived tmux sessions.

Observation is free for every bot. *Conversation* requires attaching the `perch` gateway to a bot in Bot Builder.

## The two lenses

### Bots lens

Served by the hub at `/bots`, reached at `<gateway>/proxy/perch-hub/bots`, and rendered only when `PERCH_CROW_MODE=1`. Without that flag the route 404s, which is what keeps a standalone `pi-hub` byte-identical to what it was before.

The page is served by the hub, but every piece of data on it belongs to Crow. The hub knows nothing about bots, definitions or sessions, so the client fetches all of it from the gateway API described below. Every one of those fetches is a **root-absolute** `/dashboard/perch-api/…` URL: the page lives under `/proxy/perch-hub/`, so a relative fetch would resolve inside the proxy prefix and be forwarded back into the hub, which has no such route. Mutating calls echo the `crow_csrf` cookie in the `X-Crow-Csrf` header, which is Crow's ordinary double-submit rail.

Per bot the lens renders a card with the engine state and whether the bot runtime is armed, then its sessions across every channel. Each session row carries:

| Badge | Source | Behavior |
|---|---|---|
| channel | `bot_sessions.gateway_type` | Always present. Keyed off `gateway_type`, not `kind` — `kind` is only reliable for perch rows. |
| board card | `bot_sessions.card_id` | Present when the session came from a bot-board dispatch; links to `/dashboard/bot-board?card=<card_id>`. |
| live | in-flight turn, or a fresh `active` claim on the row | A turn running in this gateway process, or any channel's claim younger than one turn budget. A Gmail turn runs in a different process, so reporting only this process's turns would lie. |

Two panes open per session. **Transcript** renders the on-disk pi session file (see [Transcripts](#transcripts)). **Controls** renders the bot's envelope with a checkbox per granted tool and a locked, non-interactive row per known-but-denied tool that deep-links to Bot Builder.

Bots with the `perch` gateway attached also get a chat card: a textarea, a send button, and the reply streamed back over SSE. A bot without the attach shows "observing" and says where to go and attach it.

### Dev lens

The hub's own home page, unchanged from upstream: recent and archived on-disk pi sessions, a spawn form, resume buttons, and the archive toggle. This is the surface the [security note](#security-explicitly-accepted) is about.

Bot workspaces stay **excluded** from this lens (`DEFAULT_EXCLUDE_CWD_PATTERNS = ["/.crow-mpa/"]` in `lib/sessions.mjs`), exactly as upstream. Bot transcripts are not surfaced by relaxing that filter: they reach the bots lens through the gateway's own transcript endpoint, which resolves the file from the `bot_sessions` row. The design spec's earlier "unfilter crow workspaces in crow mode" line was superseded by that decision during review.

### What is not in Phase 1

Two upstream features are deliberately **hidden in crow mode**, and both are Phase 2 shaped:

- **The per-session live pane (`/s/<pid>/…`).** The hub's session pass-through is a raw proxy: it copies the upstream status and headers verbatim and rewrites no URLs. The pi session web UI is a separate program serving its own root-absolute assets, so it cannot work behind a subpath proxy no matter what the hub emits. The "Open chat" button is therefore not rendered in crow mode. Restoring it needs real session attach, which is Phase 2 work.
- **Cross-machine peer navigation.** Perch's peer-hub links are a `pi-lab` lab feature and stay one; they are not rendered in crow mode.

Both remain fully available to a standalone `pi-hub` on its own port. Nothing about the vendored payload changes that.

One more honest boundary, this one inside the lens: on a `409 engine_required` the bots lens says "the bot engine is not ready on this instance" in prose and stops there. It does **not** open Crow's engine-install modal, because the lens is a document served by the hub through the proxy and the modal is a dashboard component — a different document, structurally unreachable from there. The one-click install affordance lives in the Perch panel instead, which is a real dashboard component. The `403 perch_not_attached` case does deep-link to Bot Builder, since that is an ordinary link.

## The `perch` channel

`perch` joins `gmail`, `discord`, `telegram` and `slack` in `ENGINE_CHANNELS` (`servers/gateway/bot-engine-status.js`): a perch turn runs `handleInbound()`, which spawns pi, so it needs the bot engine installed and the C4 attach gate applies.

What it does not need is credentials. `GATEWAY_REQUIRED_FIELDS.perch` is `[]` — modelled explicitly as an empty array rather than left out, because an *absent* entry means "unknown type, make no claims" and would stop the attach gate from ever seeing a perch record as a real attach. A bare `{ "type": "perch" }` record is complete by construction, so the gate fires on engine state alone. `normalizeGatewayFields` builds that record without reading the request body at all, so stray `gw_*` values left over from a previously selected type cannot bleed into it.

The type is offered in both places a channel can be chosen: the Gateways tab dropdown and the create wizard's channel step (`WIZARD_GW_TYPES` is a separate list from `SIMPLE_GATEWAY_TYPES`; a type missing from it silently falls back to the template's channel).

### Attaching `perch` without the bundle warns

`perch` is the one channel whose surface is a *bundle* rather than a remote service, so an attach can be complete, saved, and gated correctly and still have nowhere to put a reply: the lens **is** `perch-hub`. Without the bundle, a turn still 202s and still spawns pi; the answer simply goes nowhere the operator can see.

Both save surfaces therefore raise `&warn=perch_not_installed` — the Gateways-tab save (`bot-builder/api-handlers.js`) and `handleWizardCreate` (`bot-builder/wizard.js`). It is a **warning, never a block**, on the same pattern as C4's `warn=bot_runtime_off`: the record saves, the turn API is untouched, and `GATEWAY_REQUIRED_FIELDS.perch` stays `[]` (a required field there would change what the C4 engine gate treats as a complete attach). The banner carries a one-click install driven by the Perch panel's own job client — `perchGateClientJS()` is exported and used from both places rather than copied.

Two details worth keeping if this code is touched:

- The signal is `perchInstalled()` from `panels/perch.js` — **disk truth at call time**, not `perchRuntimeStatus().running`. Every `webUI` bundle install ends in a gateway restart, so "installed but not running" is a normal window and must not warn.
- One save can raise two warnings at once (a disarmed bot runtime *and* a missing Perch), which reaches the panel as an array. `bot-builder.js` reads `?warn=` as a list and renders one banner per value; free-form warn strings are never split, since several of them contain commas.

A perch turn is one `handleInbound()` call, like a Gmail turn, and it runs **in-process** in the gateway because only that gives a streaming `sendReply` to push down SSE. (Board dispatch is the contrasting case: it spawns a detached `--inject` child.) The bridge is imported lazily so gateway boot stays light.

Perch is not the first in-process `handleInbound` here — the Gmail tick has run one since C4, via `bot-runtime.js` → `bridge_tick_lib.mjs`. The useful consequence is that the two now share a process: **one event loop, and one host-wide pi capacity budget** (`countLivePi()` against `LIFECYCLE_DEFAULTS.maxPi`), which is why a perch turn can come back `deferred` simply because a Gmail turn is holding a slot. It also means a perch turn inherits exactly the same `PIBOT_*` timeout and environment tuning as a Gmail turn on that host — including any systemd drop-in a local-model deployment has set. If you lengthen `PIBOT_TURN_TIMEOUT_MS` for slow local models, you have lengthened it for Perch too, and the turn route's own stale-claim window moves with it.

Because there is no polling tick to serialize turns the way Gmail's does, the turn route enforces one turn per thread itself: a memory guard for this process, plus a DB claim (`status='active'` with a fresh `updated_at`) so a gateway that restarted mid-turn still refuses a second turn. Claims older than one turn budget are reclaimable, so a crashed turn can never wedge a thread permanently. Two pi processes resuming one session file corrupts the transcript, which is what all of that is protecting.

## The envelope model

**Bot Builder is the single writer.** It defines what a bot may do. Perch may narrow that per session and can never widen it.

`GET /dashboard/perch-api/bots/:id/envelope` composes the envelope from the only two real sources of tool ids:

1. **builtins** — the fixed `PI_BUILTIN` list in `servers/gateway/dashboard/panels/bot-builder/data-queries.js`. Because it is fixed, a builtin the definition does not grant is a *known* denial and renders locked rather than simply being absent.
2. **MCP and remote ids** — derived by `toolAllowlist()` in `scripts/pi-bots/bridge.mjs` from the definition's own selections, so every one of them is allowed by construction.

`subagent` is listed as narrowable whenever the definition opts into multi-agent, because `PiRpc` appends it *after* the allowlist. Narrowing means "less than the definition grants", and that includes `subagent`.

Narrowing writes a JSON array of disabled tool ids to `bot_sessions.narrowed_tools`, keyed by `gateway_thread_id` (not the numeric row id — the turn flow only ever knows thread ids, and the narrowing has to apply to the row the next turn resumes). The route validates that every id is in the bot's allowed set; anything else, including a denied builtin or an unknown string, is a widening attempt and comes back as `400 {"error":"widening_rejected","offending":[…]}`. The lens re-checks the box it just unchecked when that happens, so the UI never shows a state the server refused.

At spawn, `applySessionNarrowing()` intersects the stored list with the **final** tool CSV, after the `subagent` append:

```js
export function applySessionNarrowing(allowlistCsv, narrowedJson) {
  // absent / malformed / non-array / empty  =>  the def envelope, untouched
  // otherwise: keep everything in allowlistCsv that is not in the list
}
```

Every failure mode falls back to the unmodified definition envelope. Fail-open here means "open to the definition", never wider.

One detail is load-bearing and counterintuitive. A session narrowed down to *nothing* still pins `--tools ""` on the spawn. Omitting the flag hands pi its **full default tool surface**, so "narrow everything away" would have granted more than the definition, not less. `PiRpc` therefore pushes the flag whenever narrowing changed the CSV, empty result included.

Rows with `narrowed_tools` NULL — every non-perch channel, and every row that predates this column — produce spawn arguments byte-identical to what shipped before.

### Known mismatch: Crow's builtin list is not pi's

Crow advertises seven builtins (`read`, `edit`, `write`, `bash`, `list`, `glob`, `grep`). pi 0.82.0's actual builtins are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

So: **`list` and `glob` do not exist in pi** and are silently ignored when granted, and `ls` and `find` cannot be granted at all. This was proven at spawn — `--tools read,list` yields a model-facing tool set of `["read"]`.

The consequence for Perch is display-level: the Controls pane can show `list` and `glob` as togglable tools that pi will never offer, and can never show `ls` or `find`. Bot Builder's Tools tab has the same mismatch, since both read the same constant. Fixing it is its own change with its own migration questions (a bot definition may already reference the phantom names), so P1 documents it rather than papering over it.

## Supervision and the kill switch

`servers/gateway/perch-runtime.js` owns the hub process. It is initialized from the post-listen boot step, beside the bot runtime, and it starts the child only when **both** conditions hold:

- `CROW_HOME/bundles/perch-hub/payload/hub/server.mjs` exists (the bundle is really installed), and
- `env.CROW_DISABLE_PERCH !== "1"`.

The kill switch is checked **first**, so a host that has switched Perch off reports `reason: "disabled"` even with the payload present, while the status snapshot still reports the disk truth about what is installed. `scripts/run-suite.mjs` sets `CROW_DISABLE_PERCH=1` for every suite run, exactly as it does for the bot runtime, so a scratch gateway never spawns a hub or binds the loopback ports next to a real host's copy. Tests that need the runtime inject their own env through `initPerchRuntime`'s seam.

| Concern | How it is handled |
|---|---|
| Restarts | `superviseProcess({ alwaysResident: true, maxRestarts: 3 })` — the same generic machinery `bot-runtime.js` uses. |
| Bearer token | `CROW_HOME/perch-token`, 32 random bytes as hex, mode 0600, minted once and **reused** on every later init. Regenerating it would silently break every proxied request until the next gateway restart. Minted only after the installed check, so an uninstalled host never accumulates a stray token file. |
| Child output | A `spawn` wrapper drains stdout and stderr into the gateway log with a `[perch-hub]` prefix. This is not decoration: `superviseProcess` pipes those streams and never reads them, so an error-looping child would fill the 64 KB pipe buffer and block on write — a stalled process that still looks "running". |
| Shutdown | `gracefulShutdown` calls `stopPerchRuntimeBounded()`. Without it the hub **survives** the gateway: `shutdownAll()` only reaps the MCP bundle children, supervisor handles are spawned detached, and a surviving child holds its port against the restarted gateway's own child. This was observed live during implementation. (`bot-runtime.js`'s Discord child has the identical gap and is a known follow-up.) |
| Uninstall | The same bounded stop runs **before** the payload directory is deleted, since the child's cwd is inside it. The bound is 5 seconds: a wedged child must not hang an uninstall job forever, and the job logs which of the two happened. The stop is gated on the `perch-hub` id, not merely on the manifest carrying a `webUI` block — otherwise uninstalling some *other* web UI bundle would kill a perfectly healthy hub. |

`perchRuntimeStatus()` returns `{ installed, running, state, lastError, port }` and is what the panel renders.

### Panel states

The **Perch** nav entry is hidden until the bundle is installed (a per-call predicate, so it appears without a restart). The route stays mounted either way, which is what makes the gate card reachable by direct navigation at `/dashboard/perch` on an instance that does not have Perch yet.

1. **Running** — a full-height iframe of the bots lens, plus an "open in a new tab" link.
2. **Installed but down** — "Perch is offline", never a framed dead upstream. This state distinguishes two cases honestly, and the wording matters: when the supervisor has a `lastError` it is printed verbatim; when it has none, the card says the supervisor recorded no error and that Perch was most likely installed *after* this gateway started and has not been supervised yet. That second case is the normal post-install window, not a fault.
3. **Not installed** — a gate card with one-click install, driving the same bundle-install job client the engine gate uses.

The panel reads the disk first and the supervisor second when deciding "installed". They legitimately diverge in the install-then-restart window, and only the disk answer prevents offering to install something that is already installed.

## Ports and network exposure

Nothing about Perch is publicly reachable. Every port is loopback-only and every user request arrives through the dashboard.

| Port(s) | Env override | What |
|---|---|---|
| 4210 | `CROW_PERCH_PORT` | Hub web UI. Reached only via `/proxy/perch-hub`. |
| 4211 | `CROW_PERCH_REGISTRY_PORT` | Session registry, hub-internal. **Never proxied.** |
| 4141–4179 | `PI_HUB_POOL_START` / `PI_HUB_POOL_END` (pinned by the runtime) | Per-session web servers the hub allocates, one port per live session. |

The block deliberately sits clear of upstream Perch's own defaults (4200/4201, pool 4101–4139) so a crow-supervised hub and a standalone `pi-hub` can coexist on one machine. All of it is registered in [Port allocation](./port-allocation), which CI enforces.

The registry split is upstream's design and it holds here: Tailscale Serve proxies arrive from `127.0.0.1`, so a remote-address check on the public port cannot tell tailnet traffic from local pi processes. The registry port simply is not in any Serve or proxy configuration, so nothing off-machine can reach it to rewrite session proxy targets.

Crow's [network exposure invariant](/architecture/gateway) applies unchanged: `/proxy/*` and `/dashboard/*` are both funnel-private. `tests/auth-network.test.js` pins the perch paths explicitly — `/proxy/perch-hub/`, `/proxy/perch-hub/bots`, `/proxy/perch-hub/api/hub/spawn`, and the `/dashboard/perch-api/*` routes all answer 403 to a Funnel-flagged request, and an unauthenticated request to the perch API is refused by `dashboardAuth` rather than passed through.

## The proxy and bearer injection

`/proxy/perch-hub` is the ordinary extension proxy (the same mechanism behind the browser bundle's noVNC view), gated on a dashboard session. Two details are specific to Perch:

**The prefix is stripped before the hub sees the request.** The proxy rewrites `^/proxy/perch-hub` to nothing, so the hub matches a bare `/bots`. Route matching in the hub is therefore unprefixed, and only the URLs the hub *emits* carry the base path. Do not double-prefix.

**The bearer is injected server-side, per request.** A `webUI` manifest may name `authTokenFile`, a filename under `CROW_HOME`; the proxy reads it on every request and sets `Authorization: Bearer <token>` on both the HTTP hook (`on.proxyReq`) and the WebSocket upgrade hook (`on.proxyReqWs`). Both hooks are required: `http-proxy-middleware` is on v3, where the v2 top-level `onProxyReq` option is silently ignored, and the upgrade path never passes through `proxyReq` at all.

The read is lazy by contract. The token is minted in the post-listen step while the proxy's route table is built earlier at factory construction, so a read at construction time would get nothing on the first boot after an install and then serve an empty header for the whole process lifetime. `authTokenFile` is manifest data on disk, so the resolved path is rejected unless it stays inside `CROW_HOME` — a manifest must never be able to make the proxy read `../../.ssh/id_ed25519`. With no token file the header is simply omitted and the hub answers 401, which is an honest failure rather than a forged success.

A `webUI` block also sets `needsRestart` on install, for any add-on type. The proxy's route table and the supervisor are both built at boot, so a bundle installed into a running gateway has neither a route nor a supervised child until the process comes back. Uninstall flips the same flag.

### Security, explicitly accepted

Two properties of this design are risks, they were accepted deliberately, and they are stated here rather than left for someone to discover.

**Any authenticated dashboard session can execute code on the host through Perch.** The dev lens exposes `POST /api/hub/spawn`, which upstream documents as arbitrary code execution — it takes a working directory and a prompt and starts a pi session in tmux. Behind the Crow proxy, the hub's bearer is injected automatically on every request, so the hub's own auth check is not a second gate for a browser that already holds a dashboard session; the dashboard session **is** the auth. This is in scope by the operator's decision to ship the full Perch rather than a bots-only subset, on the reasoning that a self-hosted Crow dashboard is already an operator-only surface with shell-adjacent power. It is protected by the dashboard login, the network-exposure invariant, `SameSite=Lax` cookies, and the `crow_csrf` rail — and it is not protected by anything beyond those. If your instance's dashboard credentials are shared more widely than shell access on the host would be, do not install this bundle.

**Any dashboard session can read every bot's transcripts.** The bots lens shows all bots on the instance and their session transcripts, with no per-bot access control. That matches Crow's single-operator dashboard model, and it is the same trust boundary as the point above, but it is worth knowing before pointing Perch at an instance whose bots handle other people's mail.

## The gateway API

Mounted at `/dashboard/perch-api`, inside the dashboard router, after `dashboardAuth` **and** after the CSRF middleware. The prefix is deliberate: `/dashboard` is skipped by the general rate limiter (a root `/api/perch` mount would 429 the lens after a few minutes of ordinary use, since one lens load is already 1 + N requests), it carries the real CSRF rail, and it is funnel-private. The router also installs `dashboardAuth` on its own prefix as its first statement, so it stays closed wherever it is mounted. Body parsing needs nothing per-route; a global 1 MB JSON parser already runs, and the cap that actually matters is the in-route 32,000-character slice on a turn message.

| Route | Returns |
|---|---|
| `GET /bots` | `{bots:[{id,name,perch_attached,engine:{state},runtime_on}]}` |
| `GET /bots/:id/sessions` | `{sessions:[{id,kind,gateway_type,gateway_thread_id,status,card_id,plan_path,updated_at,live,narrowed_tools}]}` |
| `GET /bots/:id/envelope` | `{tools:[{id,label,allowed}],denied:[{id,label}],skills,model}` |
| `GET /bots/:id/sessions/:threadId/transcript` | `{events,truncated,omitted}` or `404 no_transcript` |
| `POST /bots/:id/turn` | `202 {turnId,sessionId}`; `403 perch_not_attached`, `409 engine_required`, `409 turn_in_progress`, `400 empty_message`, `404 unknown_bot` |
| `GET /turns/:turnId/events` | SSE. Events are `log` (progress) and the terminal `reply` or `error`. `404 unknown_turn`. |
| `POST /bots/:id/sessions/:threadId/narrow` | `{ok:true}` or `400 {error:"widening_rejected",offending}` |

`narrowed_tools` on the sessions row is not optional: the envelope endpoint is per-bot, so that row is the only place the Controls pane can learn a *session's* saved narrowing. The lens reads it as a tri-state and says a different thing for each — a value means a real narrowing, an explicit `null` means "nothing narrowed in this session yet" (the ordinary state of a fresh session), and an absent field means "this Crow build did not report it". Emit the field even when it is null; omitting it makes every fresh session look like a broken build.

`log` events are plain strings, not JSON — the lens writes them straight into the pending line and JSON-parses only the terminal events. Newlines are collapsed, because a bare newline inside an SSE `data:` payload splits the frame.

Turn buffers are garbage-collected 15 minutes after creation, swept lazily on each turn or SSE request so a gateway with no perch traffic holds no timer. The lens runs a matching 15-minute watchdog, so a stream that dies silently still resolves to an honest error rather than a permanent spinner.

`handleInbound`'s **resolved value** is the contract, not its rejection. `{action:"deferred"}` means pi was at capacity and `sendReply` was never called — Gmail's tick would retry, perch has no tick, so the turn ends with a terminal error saying the engine is busy. `{action:"error"}` means the failure was already delivered through `sendReply`, so the terminal event exists and the turn is only marked done. The first `reply` or `error` closes the turn, so a late second one can never double-report.

### Transcripts

The gateway resolves the file; the browser never supplies a path. Both halves come from the `bot_sessions` row: the directory from `pi_session_dir`, and the file by globbing that directory for `*_<pi_session_id>.jsonl`. On disk the names are `<ISO-timestamp>_<uuid>.jsonl` while `pi_session_id` is the bare uuid, so `join(dir, id + ".jsonl")` always misses.

Each line is a `type`-discriminated JSON object (`session`, `model_change`, `thinking_level_change`, `message`, and whatever pi adds next). Lines are returned as-is and the lens renders `message` rows and ignores the rest, which keeps it forward-compatible. Unparseable lines are skipped silently — a half-written last line is normal while a turn is running.

Truncation is from the **tail**: the last 2,000 lines, with `{truncated, omitted}` reported. A live session file on a working host already exceeds 2 MB, and head-truncation would render the oldest turns and hide today's, which is the opposite of what an observatory is for.

## The upstream contract

Crow-specific behavior lives upstream in `pi-lab` behind environment variables, so one codebase serves both the lab hub and the bundle. With none of them set, the hub behaves exactly as it did before, byte for byte.

| Variable | Set by | Effect |
|---|---|---|
| `PERCH_CROW_MODE=1` | perch-runtime | Enables the `/bots` lens route; hides the per-session "Open chat" button and the peer navigation; **disables `/login` entirely** (both routes 404). |
| `PERCH_BASE_PATH` | perch-runtime, to `/proxy/perch-hub` | Prefix applied to every root-absolute URL the hub emits — in HTML **and** in `Location:` headers. The proxy does not rewrite redirect targets, so a bare `Location: /` would escape the prefix. |
| `PERCH_API_TOKEN` | perch-runtime, from `CROW_HOME/perch-token` | The bearer, instead of reading `~/.pi/agent/settings.json`. A stranger's machine has no pi settings file. |
| `PI_HUB_PORT`, `PI_HUB_REGISTRY_PORT` | perch-runtime | 4210 / 4211 (overridable, see above). Both must be set together when booting a hub by hand — the registry default, 4201, is what a live `pi-hub.service` holds. |
| `PI_HUB_POOL_START`, `PI_HUB_POOL_END` | perch-runtime | 4141 / 4179. |

Disabling `/login` in crow mode is not tidying. Behind the gateway the bearer is injected on every proxied request, so the hub's auth check always passes and the login flow can only misfire; removing it also removes two redirect targets from the base-path surface.

One trap worth knowing when hand-building fixtures: the panel and the runtime decide "installed" from the payload directory, but the **proxy's** route table is built from `CROW_HOME/installed.json`. A real install writes both. A hand-assembled payload without the `installed.json` entry renders the running state with an iframe that 404s.

## Vendoring and updates

Perch's source of truth is the `pi-lab` repository. `scripts/vendor-perch.mjs` copies a pinned file list at a pinned git ref into `bundles/perch-hub/payload/`:

```
node scripts/vendor-perch.mjs --ref crow-mode
node scripts/vendor-perch.mjs --dry-run
PI_LAB_DIR=/path/to/pi-lab node scripts/vendor-perch.mjs
```

The list is explicit (`hub/server.mjs`, `hub/auth-source.mjs`, `hub/bots-page.mjs`, `lib/sessions.mjs`) rather than a directory glob, because vendoring by glob is how an unreviewed upstream file silently enters the product. Adding a file is a reviewable diff. The `hub/` and `lib/` sibling layout is load-bearing: the hub imports `../lib/sessions.mjs`.

Contents are read with `git show <ref>:<path>`, never off the working tree, so a dirty `pi-lab` checkout cannot leak into the payload and the commit recorded in `payload/UPSTREAM` provably matches the bytes. The script then computes a digest over the payload, stamps it into the manifest as `payload_sha256`, and bumps the bundle version.

`scripts/check-vendored-payloads.mjs` recomputes that digest in CI's `static-checks` job. Its contract:

- a manifest **without** `payload_sha256` is skipped by design — that is the pre-vendor state of a draft bundle, and it must not redden CI in the interim (a payload directory present with no stamp is announced as a warning, never silently ignored);
- a manifest **with** the field must have a payload whose digest matches exactly. Missing directory, empty directory, or any byte or path change fails the job and lists the offending files.

The digest framing is itself a contract every stamped manifest depends on: for each file, in lexicographic order of its posix relative path, absorb `<relpath> NUL <bytes> NUL`. Paths are hashed as well as contents, so a rename counts as a change.

Note that `verify_paths` in this manifest is inert. The installer only enforces it inside the `npm_required` branch, and this bundle sets `npm_required: false`. The digest check is the guard.

### How an update actually reaches a user

Honestly: **by reinstalling the bundle from the Extensions page.**

A vendored-payload update ships as a bundle version bump in the repository. Crow's auto-update pulls that repository change, but it does **not** refresh installed copies under `CROW_HOME/bundles/` — the installed payload is a copy made at install time, and nothing reconciles it against the repository afterward. There is no auto-reconcile in Phase 1, and no "supervisor restarts the hub on bundle version change" behavior; that line in the original design spec is descoped.

So the update path is: pull, then uninstall and reinstall `perch-hub` from Extensions (or install over it), then let the gateway restart, which the `webUI` block requests automatically. Until that happens, the running hub is whatever was vendored when it was installed. The Perch panel will not warn about this, because from the supervisor's point of view an out-of-date hub that starts cleanly is simply running.

### Deploying `bot_sessions.narrowed_tools`

Per-session narrowing needs one new column, `bot_sessions.narrowed_tools TEXT`. It is **additive with no `SCHEMA_GENERATION` bump**, which has a specific consequence for deploys:

> On a host already at the current schema generation, `needsSchemaInit` is false, so the gateway never re-runs `init-db` at boot. The column arrives through the update script's `guarded-init-db` pass, not through a gateway restart.

Every host's deploy must include an update run (or a direct `guarded-init-db` pass). **Skip it and the Perch channel is entirely non-functional on that host — not degraded, not partially working.** Measured in the Phase 1 acceptance round, not inferred:

- `GET /dashboard/perch-api/bots/:id/sessions` → `500 {"error":"no such column: narrowed_tools"}`. No session list, and therefore no transcripts, no badges, and no Controls pane.
- `POST /dashboard/perch-api/bots/:id/turn` → `500 {"error":"no such column: narrowed_tools"}` as well. The turn reads the newest session row for its in-flight guard *before* it claims anything or imports the bridge, so every message fails there — nothing is spawned, nothing is answered.

What survives is `GET /bots` and the panel chrome around it, which is exactly what makes this bad: the nav entry is there, the hub is up, the bot list renders, and every single thing an operator then tries returns a 500. It reads as "Perch is broken", and the fix is a one-line migration nobody thinks to look for. Run the migration as part of the deploy, not after the first report. This is the same route the `kind` column took to the fleet.

## See also

- [Bot Engine (pi)](./bot-engine) — the runtime a perch turn spawns, and the gate that fires when it is absent.
- [Self-Hosted Bundles](./bundles) — the general bundle contract, including `webUI` blocks.
- [Port allocation](./port-allocation) — the registry CI enforces.
- [Bot Builder guide](/guide/bot-builder) — the operator-facing walkthrough of attaching Perch to a bot.
