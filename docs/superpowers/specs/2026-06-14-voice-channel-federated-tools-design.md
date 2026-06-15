# Voice channel honors federated (cross-instance) tools

**Status:** Design (approved-in-brainstorming 2026-06-14; implementation deferred
to a fresh session). This is the "fix the product, not the instance" answer to
the recurring "glasses can't play my music" failure.

## Problem (root-caused this session)

A bot bound to a voice device (Meta glasses → `crow-glasses` on **grackle**) asks
to play music. funkwhale's **backend + library (8,386 tracks) live only on crow**;
grackle has no funkwhale backend. Yet grackle has a **local funkwhale MCP addon
installed** pointing at `https://grackle…:8446` (dead — HTTP 000). The voice
tool-executor resolves `fw_play` against **local `connectedServers` only**, finds
grackle's broken local funkwhale, and calls it → "funkwhale services isn't
responding." The working, federated funkwhale on crow is never consulted.

Two prior layers were fixed this session and are prerequisites that now hold:
- crow's MPA instance now **exposes** the `funkwhale` capability to peers
  (`remote_exposed_tools`, set 2026-06-14) — previously deny-all silently blocked it.
- The federation transport is verified: from grackle, `crow_tools{action:"fw_play",
  params:{…}}` against crow MPA (`:8447/router/mcp`) returns the real library.

## Why text bots work but voice doesn't

Text bots (`scripts/pi-bots/bridge.mjs`) reach federated tools because **pi**
connects directly to the remote gateway's MCP endpoint via `.mcp.json`
remote-blocks (`def.tools.remote_mcp` → `mcp__crow-remote-<id8>-<canonicalId>`,
`scripts/pi-bots/remote-blocks.mjs`), gated by `feature_flags.remote_invocation`.
The **voice loop is in-process** (`bundles/meta-glasses/panel/routes.js`
`runVoiceTurn` → `toolExecutor.executeToolCalls`) and never spawns pi, so the
`.mcp.json` remote-block mechanism cannot apply. The voice executor
(`servers/gateway/ai/tool-executor.js` `createToolExecutor`/`executeTool`) only
dispatches to local `connectedServers` entries.

But the proxy **already holds a live MCP client to each remote instance** in
`connectedServers` (`proxy.js:564`, `{ client, tools, isRemote:true, instanceId,
… }`). The remote MPA entry's `tools` are the *exposed* set (incl. `crow_tools`),
not individual `fw_*`. So the missing piece is purely **routing**: recognize that
`fw_play` belongs to a remote-blocked capability and dispatch it to that
instance's `client` as `crow_tools{action:"fw_play", params:<args>}`.

## Design

Small, additive, and reuses everything already verified. No behavior change for
bots that don't opt in (gated entirely by the per-bot remote config).

1. **Voice tool-executor remote routing** (`servers/gateway/ai/tool-executor.js`):
   - `createToolExecutor` accepts the bot's remote-capability map (from
     `remoteServersForBot(def)` → `[{instanceId, canonicalId}]`) plus a resolver
     to the `connectedServers` remote entry for an `instanceId`.
   - In `executeTool`, BEFORE the local-`connectedServers` lookup, if the
     effective tool name belongs to a remote-blocked `canonicalId` (i.e. the tool
     is one this capability owns on the remote instance), dispatch via that
     instance's remote `client.callTool({ name:"crow_tools", arguments:{ action:
     <tool>, params:<args> } })` and return its result. Honors
     `feature_flags.remote_invocation` (default off; same flag text bots use).
   - Map a remote capability's tool names → the capability: reuse the remote
     entry's discovered manifest / `crow_discover`, or carry the capability's tool
     list in the remote-block. (Decide in implementation; `crow_discover` on the
     remote client is the authoritative source.)
2. **Wire the voice loop** (`bundles/meta-glasses/panel/routes.js:937`): pass the
   bound bot's remote config + `remoteEnabled` into `createToolExecutor` (today it
   calls `createToolExecutor({ botDef })` with neither). `getChatTools` already
   advertises the bot's selected tools to the model.
3. **Configure `crow-glasses`**: set `tools.remote_mcp` (existing schema) so
   funkwhale points at the crow/MPA instance, and enable
   `feature_flags.remote_invocation` on grackle. `fw_play` then resolves *remote*.
4. **Remove grackle's local funkwhale addon** (the band-aid): uninstall it from
   grackle's `installed.json` / `mcp-addons.json` so nothing shadows the federated
   one and the library comes from crow. (Verify nothing else on grackle depends on
   a local funkwhale first.)
5. **Tests + E2E**: unit — `executeTool` routes a remote-blocked tool to the remote
   client (mocked) as `crow_tools{action,params}`, and leaves local tools
   untouched; E2E (gated) — a `crow-glasses`-style bot config calls `fw_play` and
   it federates to crow. Manual: glasses "shuffle play my music" plays crow's
   library.

## Reuses (all verified this session)

`remote_mcp` config schema + `remoteServersForBot` · `feature_flags.remote_invocation`
flag · the peer-exposure gate (funkwhale exposed on MPA) · the proxy's live remote
`client` in `connectedServers` · the `crow_tools{action,params}` federated call.
The only genuinely new code is the voice executor's remote-routing branch.

## Risks / call-outs

- `tool-executor.js` is shared by **voice and chat**. The remote branch must be
  strictly behind the per-bot remote config + `remote_invocation` flag — zero
  change for non-opted-in callers. Pin this with a test asserting the local path
  is unchanged when no remote config is present.
- Tool-name → capability resolution must be unambiguous (a remote `fw_play` vs a
  hypothetical local tool of the same name). Prefer explicit: only route names the
  remote-blocked capability actually owns (per `crow_discover` on that capability).
- Generalizes beyond funkwhale: once the voice executor honors remote-blocks, ANY
  exposed cross-instance capability (media/news, memory, etc.) works on voice —
  the real "service available on one instance is available on all" outcome.

## Out of scope

- A Bot Builder UI for picking cross-instance tools (today `remote_mcp` is a def
  field; the glasses bot is configured directly). Nice follow-up for the Bot
  Builder UX wave.
- Per-peer exposure / multi-instance roster work (Theme 12).
- The interim band-aid (repointing grackle's local addon at crow's backend) — the
  operator chose the standard federation fix (B) over that.
