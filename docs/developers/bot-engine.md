---
title: Bot Engine (pi)
---

# Bot Engine (pi)

The **bot engine** is the agent runtime behind Bot Builder's message-based channels — Gmail, Discord, Telegram, Slack, and Perch (the board's roost strip + session drawer). It is [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), pinned to `0.82.0` (requires Node.js >= 22.19). Crow's pi-bots bridge (`scripts/pi-bots/`) spawns it per-turn in RPC mode (`--mode rpc`), feeds it the inbound message plus the bot's definition (model, tools, skills, permission policy), and relays its reply back out the channel it arrived on.

Bots on **Crow Messages** or a **voice/device** channel never need the engine — those run their own loop directly against the gateway's model router, not pi. The engine only matters once a bot has an engine-channel gateway attached.

## The bundle

The engine ships as a bundle, `bundles/bot-engine/`, so it installs the same way any other add-on does — from the Extensions page, or automatically the first time a bot's Gateways tab tries to save a gmail/discord/telegram/slack/perch channel while the engine is absent (see [Per-channel gating](#per-channel-gating) below).

```json
{
  "id": "bot-engine",
  "npm_required": true,
  "verify_paths": ["node_modules/@earendil-works/pi-coding-agent/dist/cli.js"]
}
```

`npm_required: true` puts this bundle on a stricter install path than most bundles (which only warn on an `npm install` failure): the installer

1. removes any existing `node_modules` first — never trusts a partial tree left behind by an interrupted prior install to "pass" on retry,
2. runs `npm ci` (or `npm install` with no lockfile) with `--omit=optional --no-audit --no-fund --ignore-scripts`,
3. checks every path in `verify_paths` actually exists afterward, and
4. on *any* failure at any of those steps, deletes the whole installed bundle directory and reports the install as failed.

A bundle with `npm_required: true` is one the platform considers useless without a working install — there is no silent "installed, but the tool won't actually work" state for the bot engine the way there can be for an optional-dependency bundle.

**Uninstall blast radius.** Because uninstalling the engine stops every gmail/discord/telegram/slack/perch bot dead, the Extensions page's uninstall confirmation for `bot-engine` fetches `GET /bundles/api/engine-blast` first and lists every *enabled* bot that has an engine-channel gateway (bot name + channel types) in the confirmation dialog before letting the uninstall proceed. A disabled bot, or a bot whose only gateway is Crow Messages/voice, is not listed — it isn't affected.

## The resolver ladder

`scripts/pi-bots/pi_resolver.mjs` resolves the engine's CLI entrypoint without assuming any host-specific layout. First hit wins:

```
Ladder (first hit wins):
  1. PIBOT_PI_CLI env — explicit operator override, trusted verbatim (a bad
     path surfaces as an honest spawn error rather than being second-guessed).
  2. <CROW_HOME>/bundles/bot-engine/<pkg>/dist/cli.js — the bot-engine
     extension payload (per-instance, npm-installed at bundle install time).
  3. <repo>/node_modules/<pkg>/dist/cli.js — pi as a declared dependency.
  4. <dirname(execPath)>/../lib/node_modules/<pkg>/dist/cli.js — the global
     npm root of the RUNNING node. Covers nvm (<prefix>/bin/node +
     <prefix>/lib/node_modules), /usr/local, and Debian's /usr layout.
  5. null — callers must surface "bot engine (pi) is not installed", never a
     buried ENOENT/MODULE_NOT_FOUND from a phantom path.
```

Step 5 is deliberate: every caller (the bridge, the readiness checklist, the attach gate) gets one honest, actionable error message — `missingEngineMessage()` — instead of a stack trace pointing at a path nobody configured.

## Supervisor modes

The gateway process itself can run the engine's long-lived adapters — no separate systemd install required on a typical host. `servers/gateway/bot-runtime.js` resolves a mode at boot:

| `PIBOT_SUPERVISOR` | Mode | Behavior |
|---|---|---|
| *(unset)* | `gateway` (default) | The gateway runs the Gmail bridge tick in-process on an interval (`PIBOT_BRIDGE_TICK_MS`, default 60000ms) and supervises a Discord child process directly. No standalone units to install. |
| `external` | `external` | The gateway logs one line and does nothing — a host's own `pibot-*@` systemd units (bridge timer, Discord gateway) are the supervisor of record for that instance's bot definitions. |
| — | `CROW_DISABLE_BOT_RUNTIME=1` forces mode `disabled` regardless of `PIBOT_SUPERVISOR` — the scratch/test kill switch (`scripts/run-suite.mjs` sets this for every suite run so tests never spawn a real bridge tick or Discord child). |

**When to use `external`:** any host that already runs `pibot-*@` systemd units against the same bot definitions database. Running both at once is a **double-run hazard** — the gateway's in-process bridge and the systemd timer would each poll Gmail and answer the same message twice, and the gateway's in-process Discord supervisor would open a second client session on the same bot token that the systemd unit is already using. Set the drop-in on the **gateway** unit (not the pibot units themselves), e.g.:

```ini
# /etc/systemd/system/<gateway-unit>.service.d/pibot-supervisor.conf
[Service]
Environment=PIBOT_SUPERVISOR=external
```

then `systemctl daemon-reload` and restart the gateway. A host with no pre-existing `pibot-*@` units should leave the default `gateway` mode alone.

## The `bot_runtime` flag and `runtimeGate`

Even in `gateway` mode, the bridge tick and Discord child only actually run while the `feature_flags.bot_runtime` flag is on (**Settings → Bot Runtime**, defaults to on for an MPA-shaped host, off otherwise). `runtimeGate()` (`scripts/pi-bots/runtime-gate.mjs`) polls that flag every 30 seconds (`pollMs`, default 30000) and calls `start()`/`stop()` on a transition, with a `busy` guard so a stop can never overlap an in-flight start. Flipping the dashboard toggle arms or disarms the runtime with **no gateway restart** — the same self-gating rule every standalone pi-bots runner already respects.

## Breaker semantics

The bridge tick is guarded by a circuit breaker so a persistently broken bot (bad credentials, a dead model) can't spam retries forever:

- `PIBOT_BREAKER_THRESHOLD` (default `3`) consecutive tick failures — the tick threw, or its result carried errors with zero successful turns handled — opens the breaker.
- While open, ticks are skipped silently until `PIBOT_BREAKER_COOLDOWN_MS` (default `600000`, 10 minutes) has elapsed.
- The first tick after the cooldown is attempted as a **half-open trial**: success closes the breaker and zeroes the failure count; failure keeps it open and pushes `retryAt` out another full cooldown window.
- A deliberate off/on cycle of the `bot_runtime` flag **resets the breaker unconditionally** — stale failure state from a previous outage must never survive an intentional stop/start.

## Readiness states

The bot engine's status is a single precedence-ordered resolution (`servers/gateway/bot-engine-status.js`), most urgent first:

| State | Meaning |
|---|---|
| `installing` | An install job for the `bot-engine` bundle is currently in flight. |
| `absent` | `resolvePiCli()` found nothing anywhere in the ladder — ground truth that there's nothing installed to have failed. Absent always beats a stale open breaker. |
| `unhealthy` | The engine resolves, but the circuit breaker (above) is open — carries the last error and `retryAt`. |
| `ready` | The engine resolves and the breaker is closed. |

The Bot Builder readiness checklist splits `ready` one step further into what the operator actually needs to know: if the runtime mode is `gateway` and the `bot_runtime` flag is off, the row shows **disarmed** (engine installed, but nothing will poll it) instead of a plain green check. Mode `external` never shows disarmed — an external supervisor polls regardless of the in-gateway flag.

## Per-channel gating

Five gateway types need the engine — `gmail`, `discord`, `telegram`, `slack`, `perch` (`ENGINE_CHANNELS`). Attaching one of these to a bot while the engine state is `absent` is refused at save time (both the Gateways-tab save and the wizard's final create share the same gate), with a modal offering to install the bundle in place. **Crow Messages** and **voice/device** gateways are never gated — they don't touch pi at all.

## Long-lived (interactive) children

Every mode above assumes a child that lives for exactly one turn: spawn, one `promptTurn`, close. Perch's interactive sessions (the `/dashboard/perch` hub) are the one exception — a child spawned by `servers/gateway/perch-interactive.js` stays up across many turns, hibernating (closing) when idle and waking (respawning, resuming the same pi session file) on the next message. It is assembled through the same `buildBotWorld`/`prepareSpawn` path as every other engine channel and is gated by the same `ENGINE_CHANNELS` / attach-time engine check as a `perch` gateway generally, so nothing above this section changes for it. What is specific to the long-lived shape — its own state machine, its capacity accounting against this same `PIBOT_MAX_PI` budget, its stall/abort policy, and the `PI_BOT_INTERACTIVE` env marker it alone sets — lives entirely in `perch-interactive.js`'s own header comment, since none of it is reachable outside a spawned interactive session.

### When a bot needs you: waiting, not "no"

A question or approval card in a Perch session **pauses** that session until the operator answers it or cancels it:

- Perch children get `PI_BOT_INTERACTIVE_ASK_TIMEOUT_MS=2147483647` (the largest Node timer), so pi-lab never turns the operator's silence into a "no". A pi-lab that supports parking sends `crow-state:{"kind":"ask-parked","reason":"timeout"|"aborted"}` instead of denying. The card then expires and the turn ends as **parked**: silent, with no error, no reply and no push.
- An expired card stays visible, read-only, and the session still shows as waiting for you (Perch "waiting on you", Bot Board "waiting"). A late answer gets `409 request_expired`, and nothing runs. If a dialog request carries its own `timeout` (an older pi-lab), the card expires 2 s before that timeout.
- **One push per question episode:** the first card in a session writes one high-priority "needs you" notification and pushes it. Further cards while that row is unread update the same row (title "… needs you (N)", the latest question, and every question in `metadata.group`) and don't push. A trailing reminder goes out at most once per `PERCH_ATTENTION_REPUSH_MS` (default 10 min), and only while a card is still waiting and the row isn't snoozed. Answering, cancelling, aborting or stopping the session closes the group, so the next question pushes again.
- **A waiting session keeps its child awake and holds one `PIBOT_MAX_PI` slot**, so background jobs and channel turns may queue behind it. The board's card execute refuses (`409 waiting_on_operator`) a card whose Perch session is waiting on the operator.
- A Perch child whose bot has a project workspace also gets `PI_BOT_WORKSPACE`, `PI_BOT_PROJECTS_ROOT` and `PI_BOT_ID` (`scripts/pi-bots/bot-workspace-env.mjs`). These are set only for a real `<data>/projects/<one segment>/workspace` directory. Channel and job children never get them, a bot def can't set them, and any inherited copy is dropped. pi-lab uses them so routine commands in the project's workspace don't trip the `~/.crow` check. The bot's own engine folder (`<workspace>/bots/<id>/`, its default cwd) stays outside that exemption.

### Read confinement and MCP config delivery (S6)

With pi-lab at or after `c8bbb02` (declared as `MIN_PI_LAB_REV` in `scripts/pi-bots/pi-lab-compat.mjs`), a bot's read tools (`read`, `grep`, `find`, `ls`, `send_user_file`) reach only its spawn cwd, its world root, its `write_paths`, and `permission_policy.read_paths`. Any `.mcp.json` is unreadable to a bot, whatever its roots.

**The effective `read_paths`** are computed per spawn in `scripts/pi-bots/bot-read-paths.mjs` (PiRpc applies them to the policy copy; the stored def is never changed). They are:
- the operator's entries (Bot Builder › Permissions › *Folders this bot can read*: absolute paths, validated on save);
- the bot's project `workspace_dir`, added automatically and only when the bot has a project (the Permissions tab shows it read-only);

`bypass` sends `["/"]`. A bot with no project and no entries sends no `read_paths` key at all.

A project bot's world sits under `<workspace>/bots/<id>`, so adding the workspace also lets every bot in a project read its sibling bots' worlds: transcripts, outputs and uploads, but never their `.mcp.json`. This is a deliberate, known trade-off; the alternative is moving project bot worlds out of the workspace.

**MCP config delivery** is set by `PIBOT_MCP_CONFIG_DELIVERY` (`scripts/pi-bots/mcp-delivery.mjs`), which takes `fd`, `file` or `auto`; the default is `auto`. `auto` picks `fd` when the pi-lab that pi loads passes the compat check, and `file` otherwise. An older pi-lab ignores the fd, so in fd mode it would run the bot with no MCP servers.
- In `fd` mode the bridge spawns pi with `PI_BOT_MCP_CONFIG_FD=4`, pipes the built config on fd 4 and closes its end. pi-lab reads it to EOF once and closes it. Nothing is written: not `<world>/.mcp.json`, and not `/tmp/pibot-job-*/.mcp.json` for background jobs. This keeps the signed actor headers (`actor-sig.mjs`) off disk entirely.
- `PI_BOT_MCP_CONFIG` stays set to the world root's (absent) `.mcp.json`. For a current pi-lab the fd wins and `dirname()` keeps the world root readable. An older pi-lab pins to the missing file and gets an empty bot layer, so it never walks the cwd ancestors for `.mcp.json`.
- A stale file left by an earlier file-mode turn is removed once it is older than 10 minutes (`removeStaleBotMcp`). Delivery is chosen per process, and a file-mode process's pi may not have read a fresh file yet. The pi-lab check is cached for 5 minutes per process.
- `file` mode is the pre-S6 path described below.

Both the gateway and `pibot-gateways` log the pi-lab check once at boot, with a clear WARNING when pi-lab is older. One caveat stays: a bot with an allowlisted file-reading bash command (`cat`, `python3`, …) can still read anything, so keep those out of `bash_allow` for confined bots.

### Open-anywhere: cwd is split from the world root

A Perch session runs in **any directory the operator picks**, not only its bot's configured workspace. Two values that used to be one are now separate (`buildBotWorld` returns both):

- **`cwd`** — the operator's chosen working directory (`bot_sessions.cwd`, nullable; set at spawn via `POST /bots/:id/interactive {cwd}` or mid-session via `POST /interactive/:sid/control {cwd}`). It is pi's process cwd and the directory added to the child's `write_paths` (so the bot can do real work there, like bare pi did). The per-bot `.mcp.json` stays in the world root (`world.mcpConfigPath`) and reaches pi through the engine-reserved `PI_BOT_MCP_CONFIG` env var the bridge sets at spawn: pi-lab's mcp-client then loads the global file plus that file only, so a chosen project directory's own `.mcp.json` is neither read by the bot nor overwritten (the writer replaces the whole file, and writing it at cwd clobbered real project configs on 2026-09-12/13). A bot with no configured directory at all falls back to `<crowHome>/pi-bots/<botId>` rather than refusing to spawn.
- **world root (`sessionDir`)** — still the *storage* root: pi session files (`sessions/`), `outputs/<sid>`, and uploads. A session's deliverables never litter the chosen directory, and the existing outputs-download jail is untouched.

A mid-session cwd change persists to the row and **hibernates the live child** with a visible log frame; the next message wakes in the new directory. It is never a live `chdir` (pi's process cwd is fixed at spawn). `control({cwd})` is refused with `turn_in_progress` mid-turn.

Supporting endpoints (all behind the same `dashboardAuth` as every perch-api route, and **not** in `PUBLIC_FUNNEL_PREFIXES`):

| Endpoint | Purpose |
|---|---|
| `GET /dashboard/perch-api/browse?path=` | Server-backed directory **names** + paths only (never contents) for the launcher's picker. `~` expansion, `..` collapsed via `resolve()`, realpath'd, dot-dirs last, capped 500; `parent` derived from the resolved realpath so `..` from a symlinked dir doesn't ping-pong. |
| `GET /dashboard/perch-api/interactive/:sid/files/list` | Flat listing of the session's **outputsDir only** (never uploadsDir): dotfiles and symlinks skipped (`lstatSync`), no recursion, mtime-desc, capped 200. Downloads still go through the existing `workspace/*` fd-based `O_NOFOLLOW` jail. |

The hub's chat surface is four tabs (Chat / Session / Files / Activity). Tab switching is pure visibility toggling on the client — it never touches the SSE lifecycle, which belongs to the session, not the tab. Log/tool/error frames route to the Activity rail; the Chat transcript keeps only messages, ask cards, and hard failures.

## Actor signing (board, phone, artifacts)

A bot's per-turn MCP config reaches `/board/mcp`, `/phone/mcp` and `/artifacts/mcp` with a shared path-scoped token plus `X-Crow-Actor-*` headers naming the bot (and, for the board, the job). The headers count only with an `X-Crow-Actor-Sig` HMAC that the gateway verifies (`scripts/pi-bots/actor-sig.mjs`). A missing or bad signature downgrades the call to an unattributed bot; the first rejected board signature in a process logs one `[board-mcp]` warning, later ones are only counted.

**Which processes sign:**

- **The gateway** mints a per-boot key in memory at startup. It is never written to disk, the DB or any environment. In-gateway channel turns, Perch sessions, in-process jobs and skill review sign with it.
- **The supervised Discord child** (gateway mode) receives that key over stdin (`CROW_ACTOR_KEY_STDIN=1` only means "read stdin").
- **Out-of-gateway runners** (`pibot-gateways@<instance>` on an external-supervisor instance, the bridge timer, `bridge.mjs --inject`) never hold the per-boot key. Without the shared board secret below, their bots' board writes stay unattributed, and their phone and artifacts calls always do.

Generic bot jobs now carry their job id: a job's board headers are signed over `(bot, job)`, so `board_mutations.job_id` is recorded for them as for card jobs.

**Optional shared board-signing secret (external-supervisor instances only):**

The board key can instead come from an operator secret, so a runner's board signatures verify at the gateway and survive a gateway restart. It covers board signatures only; phone and artifacts keep the per-boot key.

- It is accepted **only** as a systemd credential named `board-actor-secret`. The source file is root-owned, mode 0600 (for example `/etc/crow/board-actor-secret`, 32 or more random bytes, hex or base64), and both the gateway unit and the runner unit of the instance load it:

  ```ini
  [Service]
  LoadCredential=board-actor-secret:/etc/crow/board-actor-secret
  ```

  systemd hands each unit a copy at `$CREDENTIALS_DIRECTORY/board-actor-secret`, readable by the service user only. The secret is used only when `CREDENTIALS_DIRECTORY` really lies under `/run/credentials/` or `$XDG_RUNTIME_DIR/credentials/` (under `/run/user/`), paths every sandboxed bot has masked. System units (the usual case, `User=` set) can load a root-owned source. A **user** unit's manager runs as that user, so its `LoadCredential=` source must be a file the user can read (for example mode 0600 under the user's own config, outside every Crow and bot directory); the copy then lands under `$XDG_RUNTIME_DIR/credentials/`.
- Each process reads the file **once** at startup (no symlinks, no FIFOs, owner and mode checked on the opened file), keeps only `HMAC-SHA256(secret, "crow-board-actor-v1")` in memory and logs `board actor signing: shared-secret | per-boot | none`; the runner warns on `none`.
- It is **refused unless the pi sandbox is active in its full tier** in that process (`piSandboxStatus() === "active"`; `active-no-pidns` is refused too), with a warning; signing then falls back to the per-boot key (or none). The secret is read only at startup, so if the log says `board shared secret ignored: pi sandbox not active`, fix the sandbox and restart both units once it is healthy.
- `CROW_BOARD_ACTOR_SECRET` and `CROW_BOARD_ACTOR_SECRET_FILE` are **ignored** with a warning: an environment variable stays readable in `/proc/<pid>/environ` to every same-uid process, and a custom path would be masked only for bots whose spawner knew it.
- **Children never inherit it.** Every bot and child env builder strips a stale `CROW_BOARD_ACTOR_SECRET` (and pi children also lose `CROW_BOARD_ACTOR_SECRET_FILE` and `CREDENTIALS_DIRECTORY`). The Discord child receives the derived board key over stdin, never the secret.
- **One secret per instance.** Signatures made with it do not expire at a gateway restart. Rotate by replacing the source file and restarting both units; every older signature then fails.
- Gateway-mode instances (no external runner) need nothing: the per-boot key covers every signer.

**Known limits:**

- **Unsandboxed bots.** Without bubblewrap a bot shell can read anything the service user can, including a credential copy. That is why shared-secret mode refuses to run without the sandbox. The sandbox mode is each spawner's own `CROW_PI_SANDBOX`, though: any same-uid Crow process on the host that spawns pi with the sandbox off runs unsandboxed bots. Keep it `auto` or `required` everywhere on a host that holds the secret.
- **No per-boot expiry** in shared-secret mode (rotate the secret instead).
- **Real `LoadCredential=` file shapes** (systemd chowns the copy to the service user, or keeps it root-owned with a read ACL) are covered by tests only; both shapes are accepted, nothing world-readable is.
- **Rollout double count.** A runner not yet restarted on this build folds only one wrapper level, so it counts each PID-namespace sandboxed pi twice and admits about half as many until it restarts.

## The pi sandbox (defense in depth, not containment)

Every pi child goes through `PiRpc` in `scripts/pi-bots/bridge.mjs`, whatever started it (channel turns, Perch sessions, background jobs, skill review, the Discord child). That spawn runs through `scripts/pi-bots/pi_sandbox.mjs`.

**What it is:** defense in depth that removes the casual routes from a bot's shell to docker and sudo. **What it is not:** a containment boundary. The filesystem stays writable, so a bot with an open shell still has the escape routes listed below. A real boundary needs a dedicated unprivileged bot user, which is an operator decision.

The probe has two tiers. When bubblewrap can create a user and PID namespace with a fresh `/proc` (status `active`), pi starts as:

```
bwrap --dev-bind / / --unshare-user --unshare-pid --proc /proc \
  --tmpfs /run/user --tmpfs /tmp/tmux-<uid> --tmpfs /tmp/cc-daemon-<uid> --tmpfs /tmp/.X11-unix \
  --tmpfs /run/credentials \
  --ro-bind /dev/null <docker.sock> \
  --ro-bind ~/.config/systemd ~/.config/systemd --ro-bind ~/.local/share/systemd ~/.local/share/systemd \
  --info-fd 3 -- node cli.js …
```

If the PID-namespace flags fail but a plain user namespace works, pi starts without `--unshare-pid --proc /proc` (status `active-no-pidns`, with a one-time warning): every mask below still applies, but bots can see host processes, and the board shared secret is refused. setpriv is used only when both bwrap tiers fail.

The session paths are masked even when nothing is running at spawn time:

- `/run/user` is masked whole whenever it exists.
- `/run/credentials` (systemd unit credentials, including the board secret) is masked whenever it exists, for every pi child whatever the spawner's env. It is root's, so it is never created here; while it is absent no credential exists.
- The tmux and cc-daemon dirs are pre-created on the host with mode 0700.
- `/tmp/.X11-unix` is masked only when present, because it must stay root-owned for X servers. X is reachable through abstract sockets anyway.

The two systemd dirs are created empty when missing.

- **Docker:** the docker socket is masked, so a bot's shell, MCP servers and allowlisted interpreters cannot reach the daemon. The gateway itself keeps docker.
- **The user session is hidden.** That covers:
  - the session D-Bus and the systemd user manager, so `systemd-run --user` is no longer a way out of the sandbox;
  - gnupg, keyring, pipewire and pulse;
  - the tmux server;
  - the Claude Code daemon socket;
  - X11 path sockets.

  The child env also loses `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `SSH_AUTH_SOCK`, `TMUX`, `TMUX_PANE`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` and every `*_SOCK`, `*_SOCKET` and `*_SOCKET_PATH`.
- **User unit dirs are not directly writable.** This is not a guarantee: a bot can rename an ancestor directory (see the remaining routes below).
- **No privilege raises:** `no_new_privs` is set, so sudo and setuid/setgid binaries (crontab, at, pkexec) cannot raise privilege.
- **No other processes at all:** pi runs in its own PID namespace with a fresh `/proc`, so no host process (the gateway, other bots) is even visible, and their `/proc/<pid>/{root,environ,mem}` do not exist inside. `--die-with-parent` is deliberately not used: the close's group SIGTERM ends the outer bwrap at once, and the parent-death SIGKILL would cut pi's own SIGTERM drain and MCP shutdown short.
- **The masks are locked mounts.** The child cannot unmount them, even from a nested user namespace.
- **Changed for bots by the PID namespace** (full tier only):
  - Bots cannot see host processes: `ps`, `pgrep`, `top` and `kill <host pid>` inside a bot shell see only the sandbox's own processes.
  - Processes a bot starts (`nohup`, `setsid`, a daemon, a backgrounded server) die when pi exits, because the namespace ends with it.
  - PIDs written by in-sandbox processes (pid files, logs) are namespace-local; a host-side `kill(pid, 0)` liveness check on them sees a different or dead process.
  - Operators with bash-enabled bots should check those bots' skills for `ps`, `pgrep`, `kill`, `nohup`, `setsid` or `tmux` use.
- **Unchanged:** uid, network, cwd and the rest of the filesystem (read-write). Inside, files owned by other uids/gids show as `nobody`/`nogroup`, which affects owner-checking tools such as sudo and git's `safe.directory` on root-owned trees.

**Escape routes that remain** (all of them need the dedicated user to close):

- **Writable files that something unsandboxed runs later:**
  - `~/.bashrc` and other rc files;
  - `~/crow`, the gateway's own source, which runs on the next restart or auto-update;
  - desktop autostart entries;
  - `~/.ssh/authorized_keys`;
  - any script a privileged process executes.
- **`ssh localhost`** (or another lab host) using a readable private key in `~/.ssh`. That gives an unsandboxed shell.
- **Renaming an ancestor of the user unit dirs.** `mv ~/.config ~/.config.x && mkdir -p ~/.config/systemd/user` moves the read-only mount away. A unit written to the fresh dir (or to `~/.config/environment.d`) is loaded at the next reload or boot. This is the same persistence class as rc files.
- **The system D-Bus** (`/run/dbus/system_bus_socket`). Privileged methods are polkit-gated, and the setuid polkit helper cannot run under `no_new_privs`, so no escalation is known. It is still open.
- **Abstract unix sockets**, because there is no network namespace (for example `@/tmp/.X11-unix/X*`).
- **Reading anything the uid can read:** crow.db, tokens, `~/.claude`. That is S6, which is pi-lab read confinement.

Groups cannot be dropped without privilege (`setpriv --clear-groups` needs CAP_SETGID). `id -G` inside shows the docker gid as 65534, but the group is still in the credential; only the objects it opens are masked.

**Without bubblewrap** (for example black-swan, where Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1` also applies), pi starts as `setpriv --no-new-privs -- node cli.js …` when `setpriv` exists. sudo and setuid are blocked; docker and the user session are not.

**The probe:**
- A failed probe is retried after 5 minutes, so a transient failure doesn't leave the process unsandboxed until restart.
- A success is kept for the life of the process.
- `piSandboxStatus()` reports `active`, `nnp-only: …`, `fallback: …` or `off`.

`CROW_PI_SANDBOX` is read from the gateway's own environment only. A bot def's `spawn_env` cannot set it; it is stripped like `PI_BOT_*`. The values:

- `auto` (the default) uses bwrap when it can, otherwise the setpriv fallback, otherwise a plain spawn. It warns once per reason.
- `required` refuses to spawn pi without bwrap.
- `off` never wraps.

**Process accounting under bwrap** (outer PIDs on the parent side):
- `proc.pid` is the outer bwrap, the process-group leader. bwrap's `--info-fd` reports the PID namespace's init (an inner bwrap), kept as `PiRpc.sandboxInitPid`; `PiRpc.piPid` is pi's outer pid, resolved as that init's child.
- Under the setpriv fallback, `proc.pid` is pi.
- `listBridgePi()` folds the nested wrappers and pi into one entry: the outer wrapper's pid/ppid (lease and orphan rules unchanged) and pi's RSS. `countLivePi()` therefore counts one sandboxed pi once.
- `close()` signals the process group with SIGTERM. The outer bwrap exits at once while pi drains inside; the 5 s SIGKILL bound stays armed in the background until the whole group is gone, so a pi that ignores SIGTERM is still killed. The reaper signals the outer wrapper's process group and pi itself.
- Perch leases list the outer wrapper, the namespace init and pi, so a reaper from an older build (no folding, or one level of folding) still sees every entry of a live session as leased.

**Docker-backed tools inside a bot turn:**
- `crow_browser_launch` fails on its container recreate/restart path; a plain launch over CDP works.
- `crow_browser_status` reports `container_running: "unknown (no docker access)"` and keeps the VNC url.
- The same tools work from the gateway and from operator sessions.

**Gateway restart:**
- crow-gateway.service uses the default control-group KillMode, so every in-gateway pi dies with it.
- Jobs whose `worker_pid` is dead are re-queued and rerun with an MCP config signed by the new per-boot key (or, in shared-secret mode, by the unchanged board key).
- The supervised Discord child receives the new key over stdin.

## See also

- [Self-Hosted Bundles](./bundles) — the general bundle contract this bundle follows.
- [Bot Builder tutorial](/guide/bot-builder-tutorial) — the operator-facing walkthrough, including where the install prompt appears.
