---
title: Bot Builder
---

# Bot Builder

> New to bots? Start with the step-by-step [Your First Bot tutorial](/guide/bot-builder-tutorial) — this page is the full reference.

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
- **Crow Messages**: The agent becomes reachable as a contact. People you invite can message it, you can browse and add the bots running across your Crows, and you can put people and bots together in a group room. See the [Crow Messages guide](/guide/crow-messages).
- **Perch**: The agent becomes chattable from the Perch page in your own dashboard. There is nothing to configure — choosing the channel is the whole setup. Perch needs the Perch Hub extension installed. See [Perch](#perch-talk-to-an-agent-from-your-own-dashboard) below.

Binding glasses to an agent is one-to-one: a device drives one agent at a time, and choosing a new agent for a device releases the old binding.

## Perch: talk to an agent from your own dashboard

Perch is an extension that adds a **Perch** page to the Crow's Nest. It shows every agent on your Crow, every conversation each one has had on any channel, and the transcript of each. For agents you attach the Perch channel to, it also gives you a message box.

Nothing about Perch is exposed to the internet. It runs on your machine, listens only there, and is reachable only through your dashboard login.

### 1. Install Perch

Install **Perch Hub** from the Extensions page, or open **Perch** in the nav and use the **Install Perch** button on the card you land on. Perch registers a small local service, so Crow restarts itself to route it; the page reloads on its own when the gateway is back, and a **Perch** entry appears in the nav.

If Perch says it is offline right after installing, that is usually the restart still pending — the card tells you which case you are in, and says so plainly when the supervisor has recorded a real error instead.

### 2. Attach the Perch channel to an agent

Open the agent in Bot Builder, go to the **Gateways** tab, choose **Perch (dashboard chat)**, and save. There are no fields to fill in. You can also pick Perch as the channel while creating an agent in the wizard.

Perch turns run on the same bot engine that Gmail and Discord use, so if the engine is not installed yet Crow will offer to install it before letting you save.

You can attach the channel before installing Perch itself, and the save goes through — but Crow warns you, because the page that would show the agent's replies is the Perch extension. The warning comes with an **Install Perch** button beside it, and once the install and restart finish you land back on the same agent without the warning.

Agents without the channel attached still appear in Perch. You can read their sessions and transcripts; you just cannot message them. Watching is free, talking is the part you opt into.

### 3. Message the agent

Open **Perch**. Each agent is a card. Attached agents have a message box at the bottom of theirs: type, send, and the reply streams back as the agent produces it. If something goes wrong — the engine is not ready, the agent is already busy with another message in the same conversation — the card says so in place of the reply, rather than spinning.

Each conversation is a session. It shows up in the session list under the agent with a **transcript** you can open, and the agent picks the thread back up where you left it.

### 4. Narrow an agent's tools for one conversation

Open **Controls** on any session row. You see the agent's full envelope: every tool it is allowed to use, each with a checkbox, plus its model and skills.

Uncheck a tool and it is switched off **for that conversation only**, from the next message onward. The agent's definition is untouched, and every other conversation keeps the full set. This is for the moment when you want an agent to answer a question without touching your files, without editing anything, without reaching out over the network — for this one thread, right now.

Tools shown with a padlock are ones the agent is not allowed at all. They are not togglable here; they link to Bot Builder, which is the only place that grants a tool. Perch can only ever take away.

### 5. Reading the badges

Every session row carries badges:

- the **channel** it came in on — `perch`, `gmail`, `discord`, and so on;
- a **card** badge when the session was started by a bot-board dispatch, linking straight back to the card on the board;
- a **live** badge while a turn is actually running.

### Before you install it

Two things are worth knowing, because Perch does not hide them.

Everyone who can sign in to your dashboard can read **every** agent's transcripts in Perch. There is no per-agent access control.

Perch also carries its full original session manager, which can start programs on the machine it runs on. That is deliberate — it is a self-hosted operator tool, and it is behind your dashboard login and nothing else. Install it on a Crow whose dashboard login you treat as seriously as shell access on that machine, and not on one where the login is shared more widely than that.

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
- [Crow Messages](/guide/crow-messages): Share a bot, browse bots across your Crows, and build group rooms
- [Bot Builder Architecture](/architecture/bot-builder): The engine, data model, and voice dispatch internals
- [Perch Hub](/developers/perch-hub): How the Perch extension is supervised, proxied, and updated
- [Extensions](/guide/extensions): Install extensions that contribute tools and skills
- [Writing Skills](/developers/skills): Author the behavioral prompts agents use
- [AI Providers (BYOAI)](/guide/ai-providers): Configure the models agents run on
