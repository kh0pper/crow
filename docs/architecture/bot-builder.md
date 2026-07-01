---
title: Bot Builder Architecture
---

# Bot Builder

The Bot Builder is Crow's native agent platform — the first-class path for building and running agents on Crow.

An agent is a definition stored in the `pi_bot_defs` table in Crow's `crow.db`. The dashboard edits that definition; a lightweight agent runtime executes it per turn; gateways feed turns in from email, Discord, and glasses.

## Components

```
┌──────────────────────────────────────────────────────────────────┐
│  Crow's Nest                                                      │
│  ├── Bot Builder panel  (tabbed editor → pi_bot_defs)             │
│  └── Bot Board panel    (status / board API)                      │
├──────────────────────────────────────────────────────────────────┤
│  Agent definition (pi_bot_defs row)                               │
│   persona · skills · tools · gateways · permission_policy · model │
├──────────────────────────────────────────────────────────────────┤
│  scripts/pi-bots/                                                 │
│   bridge.mjs          per-turn agent runtime (spawns the engine)  │
│   ext_registry.mjs    installed extensions → tools + skills       │
│   skill_resolver.mjs  resolve skill text by name                  │
│   mcp_writer.mjs      mint the per-agent .mcp.json                │
│   skill_proposals.mjs opt-in self-authoring (propose → approve)   │
│   discord_gateway.mjs Discord channel                             │
│   bridge_tick.mjs     Gmail channel                               │
├──────────────────────────────────────────────────────────────────┤
│  bundles/meta-glasses/  glasses gateway: bound bot drives the     │
│                         scoped, permission-enforced voice turn    │
├──────────────────────────────────────────────────────────────────┤
│  crow.db (SQLite, WAL)  pi_bot_defs + shared Crow data            │
└──────────────────────────────────────────────────────────────────┘
```

## The agent definition

Each row in `pi_bot_defs` is a JSON definition with these parts:

- **persona**: the system prompt
- **skills**: names resolved to skill text at run time
- **tools**: the allowed tool set: Crow's core tool categories plus selected extension tools
- **gateways**: the channels the agent runs on (`gmail`, `discord`, `glasses`, `companion`)
- **permission_policy**: confirm / deny sets, `external_send` mode, and the `self_authoring` switch
- **model** and an optional `fast_voice_model`

The editor merges one tab's fields at a time, so saves are non-destructive across tabs. On any Crow instance that does not have the `pi_bot_defs` table, the panel renders a friendly notice instead of failing.

## Extensions contribute tools and skills

An installed extension contributes both MCP tools (declared in its `mcp-addons.json` block) and skills (declared in its manifest). `ext_registry.mjs` enumerates installed extensions and exposes their tools and skills to the Bot Builder palette.

When an agent selects a tool from an extension that is not part of Crow's canonical tool set, `mcp_writer.mjs` mints a per-agent MCP server block and merges it into that agent's own `.mcp.json`. The merge is additive and never mutates the shared canonical configuration. Each agent therefore runs with exactly the servers its selection requires.

## The agent runtime

`bridge.mjs` is the per-turn runtime. For each inbound turn it assembles the agent's system prompt and resolved skill text, points the engine at the agent's minted `.mcp.json`, and runs the turn. Because the runtime spawns per turn, changes to an agent's definition take effect on the next turn with no service restart.

## Gateways

| Gateway | Entry point | Transport |
|---|---|---|
| **Gmail** | `bridge_tick.mjs` | Polls a connected mailbox, drafts or sends replies subject to policy |
| **Discord** | `discord_gateway.mjs` | A long-lived Discord WebSocket that drives the runtime, with a per-agent user allowlist |
| **Meta Glasses** | `bundles/meta-glasses/` | A paired device binds to an agent and drives the fast voice turn |
| **AI Companion** | `bundles/companion/` + the gateway's `/llm/v1` router (`servers/gateway/routes/llm-router.js`) | A kiosk device binds to an agent; the [companion](/architecture/companion)'s OLVV loop runs that agent's persona/avatar/tools, with the router routing fast (4B) → escalate (35B) |
| **Crow Messages** | `scripts/pi-bots/gateways/crow-messages.mjs` | The agent is reachable as a contact over Crow's peer messaging; authorized senders' encrypted DMs drive the runtime and the agent replies from its own derived identity. See [Crow Messages](#crow-messages-bots-as-contacts) below. |

> The Meta Glasses and AI Companion channels run their own voice loop (the glasses voice turn; OLVV for the companion) rather than the pi `bridge.mjs` runtime — so the bound agent's persona/skills/tools drive the turn, but the engine is the voice front end, not pi. See [AI Companion](/architecture/companion).

## Crow Messages: bots as contacts

The Crow Messages gateway makes an agent reachable as a first-class contact over Crow's peer-to-peer messaging. The whole surface — sharing a bot, the cross-Crow directory, and group rooms — rests on one principle: **a bot is a contact.** See the [Crow Messages guide](/guide/crow-messages) for the user-facing walkthrough.

**Per-bot identity.** Each agent that runs a crow-messages gateway has a Nostr keypair *derived* from the instance seed plus the bot id (`deriveBotIdentity`). Nothing is stored: the same derivation runs in the dashboard (to show the bot's address and mint invites) and in the pi-bots host (to subscribe and reply), so the two always agree. The bot answers from its own key, as itself.

**Adapter and authorization.** `scripts/pi-bots/gateways/crow-messages.mjs` subscribes the bot to its own pubkey, decrypts inbound DMs, and drives the real `bridge.mjs` runtime for authorized senders. Authorization is **default-deny** and keyed on the cryptographically verified event signer, never on any claimed field in the message body. The access list (`bot_message_acl`) is populated by accepting an ed25519-signed invite (`bot_message_invites`); an optional "allow paired instances" mode also admits the operator's own paired Crows. A persistent seen-event table makes the turn idempotent against a relay's replay window.

**Bots as contacts + the directory.** Accepting a bot writes a `contacts` row flagged `is_bot`, which is the seam the rest of the feature builds on. Bots that opt in are advertised to the operator's paired instances over a signed `advertised-bots` transport, and `getBotDirectory` aggregates them across the fleet (grouped by instance, deduped by messaging pubkey) so the dashboard can browse and one-click add them.

**Group rooms.** A room reuses the existing `contact_groups` table: a group becomes a multi-party room when it carries a `room_uid` (plain organizational groups are untouched). Members reuse `contact_group_members`; room messages live in their own `room_messages` table. Transport is **hub-and-spoke** over the same pairwise DMs: the room's host instance fans each message out to every member (people and bots uniformly) via a publish-only `sendControl` that does not pollute the one-to-one message cache. A bot is just a participant addressed at its pubkey, so local and remote bots are one code path.

Two structural invariants make rooms safe rather than merely tuned:

- **Loop safety.** A bot runs a turn only on a *human*-authored message, and only when the host's computed `addressed_to` names it (or the room is in "always" mode). A bot's own reply is marked bot-authored, which every bot ignores. Re-fanning a bot reply never re-triggers a bot, so the work is bounded at one turn per bot per human message — a loop is impossible by construction.
- **Signer-verified attribution.** A received room message is attributed to the verified signer, not to any author label in the payload, so a member cannot impersonate another member or flip the bot badge to suppress addressing.

## The voice path

A glasses device carries a `bound_bot_id`. When a device is bound, its voice turn is driven by that agent rather than a generic profile:

- **Prompt**: the bound agent's persona and skills, plus a short voice-style addendum.
- **Tools**: a scoped set. Crow's core tool categories are included when the agent selected a tool under the matching server, and an extension's tools are included only when the agent selected them and the server is connected. A canonical-to-voice-category map decides which selections have a voice equivalent; selections with none are surfaced as a warning in the editor rather than dropped silently.
- **Model and voice**: the agent's `fast_voice_model`, resolved through Crow's profile system, with the device's speech, text-to-speech, and vision profiles supplying the voices.
- **Permissions**: a policy-aware dispatch wrapper runs before any tool executes. It resolves the effective action behind any general-purpose tool wrapper, then enforces the agent's confirm and deny sets and its `external_send` mode (downgrading publishes to drafts and blocking true sends). A blocked or confirm-required action is spoken back.

This wrapper is the security boundary for voice. It closes the gap left by the older name-only confirm gate, which could be bypassed by routing a protected action through a wrapper tool.

## Deep work

Long-running work is handed off as a background job via the `crow_delegate` tool. The job is enqueued in the shared `bot_jobs` table and run by a pi worker in the Bot Builder host process — a single strong agent doing the multi-step work in one coherent context. The agent acknowledges immediately with a job ID and the result is delivered on a later turn (retrieved with `crow_job_status`, or pushed to the originating channel), since the job outlives the turn that started it. A persistent completion-notification path is a planned follow-on.

## Opt-in self-authoring

`skill_proposals.mjs` implements the propose-then-approve flow. When an agent's `permission_policy.self_authoring` is true, the runtime adds a confined staging directory to the agent's write paths and injects the skill-writing guidance. The agent can draft a skill file into staging only.

A staged file is inert by construction. The skill resolver loads skills by name from the skills directories, and the staging directory is not one of them, so a staged file cannot resolve and is not attached to the agent. Approval, through the Bot Board API, promotes the operator-reviewed text into the skills library and attaches it to the agent's definition. The approve path includes an optimistic update guard, a no-clobber check against existing files, and a refusal to follow symlinks. Because skills are prompt text, approval can never grant tools or change a permission policy.

## Related

- [Bot Builder Guide](/guide/bot-builder): The user-facing walkthrough
- [Meta Glasses](/guide/meta-glasses): The glasses gateway in use
- [Context Management](/architecture/context-management): How tools are advertised to keep context lean
