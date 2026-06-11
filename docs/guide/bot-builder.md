---
title: Bot Builder
---

# Bot Builder

The Bot Builder is where you compose and run your own AI agents. An agent (a "bot") is a persona plus the skills, tools, gateways, and permissions you give it. Everything is configured from the Crow's Nest dashboard in a tabbed editor, with no config files to hand-edit and no separate admin tool.

The Bot Builder is the agentic spine of Crow. The same agent you build here can answer your email, chat on Discord, or run hands-free on your glasses, drawing on Crow's memory, projects, files, and any integration you have installed.

## What an agent is

An agent is a definition with a few parts, each on its own tab in the editor:

| Part | What it controls |
|---|---|
| **AI / Models** | The chat model the agent uses, plus an optional fast voice model for glasses and the speech and vision profiles it speaks through. |
| **Tools & Extensions** | Exactly which tools the agent may call: Crow's own memory, projects, blog, and storage tools, plus the tools contributed by any installed extension. |
| **Skills & Prompt** | The agent's persona (system prompt) and the skills attached to it. Skills are behavioral prompts that teach a workflow. |
| **Gateways** | The channels the agent runs on: Gmail, Discord, or Meta glasses. |
| **Permissions / Safety** | What the agent may do on its own, what needs confirmation, and what is denied. Also the opt-in self-authoring switch. |
| **Project / Kanban** | An optional project the agent works against. |
| **Review / Deploy** | A summary of the definition before you save and deploy it. |

Saving one tab merges only that tab's fields into the definition, so a save never clobbers the other tabs.

## Tools and extensions

Each agent only sees the tools you grant it. The Tools tab lists Crow's built-in tool categories alongside the tools contributed by every installed extension, grouped by extension with an install-state badge.

When you select an extension's tools, the Bot Builder wires that extension into the agent automatically. You do not edit MCP server entries by hand. If an extension provides a tool that the agent's channel cannot reach (for example a tool with no voice equivalent on the glasses path), the editor warns you rather than dropping it silently.

## Skills

Skills are behavioral prompts (Markdown files with a small front-matter header) that teach an agent a specific workflow. Attach them on the Skills tab, grouped by the extension that provides them. A featured "Skill authoring" card lets you attach Crow's skill-writing guide to an agent in one click.

Skills are portable across agents and across channels. Language variants (English, Spanish, and so on) are just different skill files that call the same underlying tools.

## Gateways: one agent, the channels you choose

A gateway connects an agent to a place where people talk to it. The same agent definition can run on more than one channel.

- **Gmail**: The agent reads and replies to email on a connected mailbox.
- **Discord**: The agent joins a Discord server as a bot and answers in channels and DMs, with a per-agent user allowlist.
- **Meta Glasses**: A paired pair of Ray-Ban Meta (Gen 2) glasses binds to one agent. That agent then drives the fast voice turn: its persona, its skills, its scoped tools, and its permissions, spoken through the speech and voice profiles you picked. See the [Meta Glasses guide](/guide/meta-glasses).

Binding glasses to an agent is one-to-one: a device drives one agent at a time, and choosing a new agent for a device releases the old binding.

## Permissions and safety

Every agent carries a permission policy that governs what it may do without asking:

- **Confirm**: Named actions require a confirmation step before they run.
- **Deny**: Named actions are refused outright.
- **Draft-only outbound**: Outbound sends and publishes are downgraded. A blog publish becomes a draft, and a true send (such as an email) is blocked and reported, so an agent cannot speak to the outside world on your behalf unless you allow it.

These rules are enforced on the underlying action, not just the surface tool name. If an agent tries to reach a protected action through a general-purpose tool wrapper, the policy still applies. On the voice path, the same gate runs before any tool executes, and a blocked action is spoken back to you.

## Opt-in self-authoring

An agent can help write its own skills, but only if you turn it on. Self-authoring is **off by default**.

When you enable it for an agent:

1. The agent may **draft** a new skill file into a confined staging area that belongs to that agent. The draft is inert. It is not loaded, it is not attached to the agent, and it cannot take effect.
2. The drafted skill appears in the Bot Builder for review. You can read it, edit the text, and either approve or reject it. Phrasing that could weaken a guardrail is flagged for your attention.
3. On approval, Crow promotes the skill into your skills library and attaches it to the agent. Only then does it load.

A self-authored skill is prompt text only. Approving one cannot grant the agent new tools and cannot change its permission policy, because those come from the Tools and Permissions tabs, not from a skill. The operator-approval gate is the boundary.

This is the core of Crow's stance versus auto-authoring bot platforms: an agent can propose, but a human approves before anything an agent wrote for itself becomes real.

## Deep work

For tasks that take longer than a single turn, an agent can hand work to Crow's orchestrator. The agent acknowledges the request immediately and the result arrives on a later turn, so a long research task does not block a conversation. Ask "what did you find?" on a follow-up turn to collect it.

## Deploy and monitor

The Review / Deploy tab summarizes the agent before you commit it. Once deployed, an agent runs against the same Crow database as every other connection, so its memories, projects, files, and messages are visible everywhere else in Crow.

## Related

- [Meta Glasses](/guide/meta-glasses): Run an agent hands-free on Ray-Ban Meta glasses
- [Bot Builder Architecture](/architecture/bot-builder): The engine, data model, and voice dispatch internals
- [Extensions](/guide/extensions): Install extensions that contribute tools and skills
- [Writing Skills](/developers/skills): Author the behavioral prompts agents use
- [AI Providers (BYOAI)](/guide/ai-providers): Configure the models agents run on
