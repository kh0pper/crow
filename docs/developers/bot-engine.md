---
title: Bot Engine (pi)
---

# Bot Engine (pi)

The **bot engine** is the agent runtime behind Bot Builder's message-based channels — Gmail, Discord, Telegram, and Slack. It is [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), pinned to `0.74.2`. Crow's pi-bots bridge (`scripts/pi-bots/`) spawns it per-turn in RPC mode (`--mode rpc`), feeds it the inbound message plus the bot's definition (model, tools, skills, permission policy), and relays its reply back out the channel it arrived on.

Bots on **Crow Messages** or a **voice/device** channel never need the engine — those run their own loop directly against the gateway's model router, not pi. The engine only matters once a bot has an engine-channel gateway attached.

## The bundle

The engine ships as a bundle, `bundles/bot-engine/`, so it installs the same way any other add-on does — from the Extensions page, or automatically the first time a bot's Gateways tab tries to save a gmail/discord/telegram/slack channel while the engine is absent (see [Per-channel gating](#per-channel-gating) below).

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

**Uninstall blast radius.** Because uninstalling the engine stops every gmail/discord/telegram/slack bot dead, the Extensions page's uninstall confirmation for `bot-engine` fetches `GET /bundles/api/engine-blast` first and lists every *enabled* bot that has an engine-channel gateway (bot name + channel types) in the confirmation dialog before letting the uninstall proceed. A disabled bot, or a bot whose only gateway is Crow Messages/voice, is not listed — it isn't affected.

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

Only four gateway types need the engine — `gmail`, `discord`, `telegram`, `slack` (`ENGINE_CHANNELS`). Attaching one of these to a bot while the engine state is `absent` is refused at save time (both the Gateways-tab save and the wizard's final create share the same gate), with a modal offering to install the bundle in place. **Crow Messages** and **voice/device** gateways are never gated — they don't touch pi at all.

## See also

- [Self-Hosted Bundles](./bundles) — the general bundle contract this bundle follows.
- [Bot Builder tutorial](/guide/bot-builder-tutorial) — the operator-facing walkthrough, including where the install prompt appears.
