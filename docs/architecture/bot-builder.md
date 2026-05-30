---
title: Bot Builder Architecture
---

# Bot Builder

The Bot Builder is Crow's native agent platform. It is the first-class path for building and running agents on Crow, and it is distinct from the earlier [CrowClaw](/architecture/crowclaw) bundle, which wraps the external OpenClaw engine and remains available as a legacy option.

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
| **AI Companion** | `bundles/companion/` + `scripts/companion/model-proxy.mjs` | A kiosk device binds to an agent; the [companion](/architecture/companion)'s OLVV loop runs that agent's persona/avatar/tools, with a model proxy routing fast (4B) → escalate (35B) |

> The Meta Glasses and AI Companion channels run their own voice loop (the glasses voice turn; OLVV for the companion) rather than the pi `bridge.mjs` runtime — so the bound agent's persona/skills/tools drive the turn, but the engine is the voice front end, not pi. See [AI Companion](/architecture/companion).

## The voice path

A glasses device carries a `bound_bot_id`. When a device is bound, its voice turn is driven by that agent rather than a generic profile:

- **Prompt**: the bound agent's persona and skills, plus a short voice-style addendum.
- **Tools**: a scoped set. Crow's core tool categories are included when the agent selected a tool under the matching server, and an extension's tools are included only when the agent selected them and the server is connected. A canonical-to-voice-category map decides which selections have a voice equivalent; selections with none are surfaced as a warning in the editor rather than dropped silently.
- **Model and voice**: the agent's `fast_voice_model`, resolved through Crow's profile system, with the device's speech, text-to-speech, and vision profiles supplying the voices.
- **Permissions**: a policy-aware dispatch wrapper runs before any tool executes. It resolves the effective action behind any general-purpose tool wrapper, then enforces the agent's confirm and deny sets and its `external_send` mode (downgrading publishes to drafts and blocking true sends). A blocked or confirm-required action is spoken back.

This wrapper is the security boundary for voice. It closes the gap left by the older name-only confirm gate, which could be bypassed by routing a protected action through a wrapper tool.

## Deep work

Long-running work is handed to Crow's [orchestrator](/architecture/orchestrator). The orchestrator dispatches the job in the background with a time ceiling and an in-memory job map. The agent acknowledges immediately and the result is delivered on a later turn, since the job outlives the turn that started it. A persistent completion-notification path is a planned follow-on.

## Opt-in self-authoring

`skill_proposals.mjs` implements the propose-then-approve flow. When an agent's `permission_policy.self_authoring` is true, the runtime adds a confined staging directory to the agent's write paths and injects the skill-writing guidance. The agent can draft a skill file into staging only.

A staged file is inert by construction. The skill resolver loads skills by name from the skills directories, and the staging directory is not one of them, so a staged file cannot resolve and is not attached to the agent. Approval, through the Bot Board API, promotes the operator-reviewed text into the skills library and attaches it to the agent's definition. The approve path includes an optimistic update guard, a no-clobber check against existing files, and a refusal to follow symlinks. Because skills are prompt text, approval can never grant tools or change a permission policy.

## Related

- [Bot Builder Guide](/guide/bot-builder): The user-facing walkthrough
- [Meta Glasses](/guide/meta-glasses): The glasses gateway in use
- [CrowClaw](/architecture/crowclaw): The legacy OpenClaw-based bot engine
- [Orchestrator](/architecture/orchestrator): Background deep-work execution
- [Context Management](/architecture/context-management): How tools are advertised to keep context lean
