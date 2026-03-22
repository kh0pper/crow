# Skills

Skills are markdown files in `skills/` that define behavioral prompts for the AI assistant. They're not code — they describe workflows, trigger patterns, and integration logic that Claude loads on demand.

## Core Skills

| Skill | File | Purpose |
|---|---|---|
| **I18n** | `i18n.md` | Defines how Crow adapts to each user's preferred language. All user-facing output is delivered in the user's language. S |
| **Memory Management** | `memory-management.md` | Store, search, and retrieve persistent memories across sessions. Use this skill to maintain context about the user, thei |
| **Plan Review** | `plan-review.md` | Before executing multi-step or significant tasks, Crow outlines its approach as an inline plan and waits for user approv |
| **Reflection** | `reflection.md` | A meta-skill for evaluating *how well things went* and proposing concrete fixes. Identifies friction, maps root causes,  |
| **Research Pipeline** | `research-pipeline.md` | Manage academic and professional research with full source tracking, APA citations, and verification. Every piece of inf |
| **Session Summary** | `session-summary.md` | Save session summary and key learnings to Crow memory |
| **Skill Writing** | `skill-writing.md` | This skill enables the AI to create, modify, and propose new skill files (`skills/*.md`) when existing skills don't cove |
| **Superpowers** | `superpowers.md` | This is the master routing skill. Consult this **before every task** to determine which skills and tools to activate. It |

## Platform Skills

| Skill | File | Purpose |
|---|---|---|
| **Add Ons** | `add-ons.md` | Browse, install, update, and remove Crow add-ons |
| **Backup** | `backup.md` | Database backup and restore — SQL dumps, binary copies, S3 upload, git archival |
| **Blog** | `blog.md` | Blog management — create, edit, publish, theme, RSS, export, share |
| **Bug Report** | `bug-report.md` | Report bugs and request features — works with or without GitHub configured |
| **Context Management** | `context-management.md` | Self-monitor context usage and suggest optimization when many tools are active |
| **Crow Context** | `crow-context.md` | Manages the crow.md cross-platform behavioral context document. This document defines how Crow behaves across all AI pla |
| **Data Backends** | `data-backends.md` | Guides connecting external data systems (Postgres, APIs, SaaS) through MCP servers and capturing query results into Crow |
| **Ideation** | `ideation.md` | Universal notes-to-plans — organize raw notes, brain dumps, and scattered ideas into structured plans |
| **Network Setup** | `network-setup.md` | Tailscale setup guidance for secure remote Crow's Nest access |
| **Onboarding** | `onboarding.md` | Guide new users through setting up Crow's P2P sharing layer for the first time. Handles identity generation, first conta |
| **Onboarding Tour** | `onboarding-tour.md` | First-run tour showing new users what Crow can do |
| **Peer Network** | `peer-network.md` | Manage your Crow peer network: view and manage contacts, configure relays, check identity information, block/unblock pee |
| **Podcast** | `podcast.md` | Podcast publishing — upload audio, create episodes, iTunes-compatible RSS |
| **Safety Guardrails** | `safety-guardrails.md` | Universal safety checkpoints — confirm before destructive, resource-heavy, or network-altering actions |
| **Scheduling** | `scheduling.md` | Manage scheduled and recurring tasks for the user. |
| **Sharing** | `sharing.md` | Share memories, research projects, sources, and notes with trusted contacts via Crow's peer-to-peer sharing layer. All d |
| **Social** | `social.md` | Send and receive encrypted messages with Crow contacts via the Nostr protocol. All messages use NIP-44 encryption (ChaCh |
| **Storage** | `storage.md` | File storage management — upload, organize, retrieve, quota monitoring |
| **Tutoring** | `tutoring.md` | Socratic tutoring with progress tracking via persistent memory. |

## Integration Skills

| Skill | File | Purpose |
|---|---|---|
| **Discord** | `discord.md` | Interact with Discord servers — channels, messages, threads — through the Discord MCP server. Monitor community discussi |
| **Extension Dev** | `extension-dev.md` | Develop, test, and publish Crow extensions (bundles, panels, MCP servers, skills) |
| **Filesystem** | `filesystem.md` | Access and manage local files and directories through the Filesystem MCP server. Read documents, organize research mater |
| **Github** | `github.md` | Interact with GitHub — repositories, issues, pull requests, code — through the GitHub MCP server. Track development work |
| **Google Chat** | `google-chat.md` | Interact with Google Chat — spaces, messages, threads — through the Google Workspace MCP server. Google Chat is already  |
| **Google Workspace** | `google-workspace.md` | Interact with Google Workspace apps — Gmail, Calendar, Sheets, Docs, Slides — through the Google Workspace MCP server. S |
| **Iterative Testing** | `iterative-testing.md` | Iterative prompt-and-record testing — run test plans on remote AI clients (Claude.ai, ChatGPT, etc.), record results, and plan fixes |
| **Microsoft Teams** | `microsoft-teams.md` | Interact with Microsoft Teams — chats, channels, meetings — through the Teams MCP server. This integration is experiment |
| **Mobile Access** | `mobile-access.md` | Guides setup and troubleshooting of remote access to Crow's memory and research tools from Claude mobile apps (Android/i |
| **Notion** | `notion.md` | Interact with Notion workspaces — pages, databases, wiki content — through the Notion MCP server. Use Notion as a struct |
| **Project Management** | `project-management.md` | Interact with Trello boards and Canvas LMS to retrieve and manage project/learning data. Syncs important information to  |
| **Slack** | `slack.md` | Interact with Slack workspaces — channels, messages, threads — through the Slack MCP server. Monitor conversations, send |
| **Songbook** | `songbook.md` | Personal chord book — ChordPro charts, transposition, chord diagrams, setlists, and music theory |
| **Web Search** | `web-search.md` | Search the web using Brave Search for research, fact-checking, current events, and general information gathering. Every  |

## Developer Skills

| Skill | File | Purpose |
|---|---|---|
| **Crow Developer** | `crow-developer.md` | Developer workflow for working on the Crow platform — doc updates, skill sync, quality checklist |

## How Skills Work

1. **Trigger**: The `superpowers.md` skill has a trigger table that maps user intent phrases to skill activations
2. **Activate**: When a match is found, the relevant skill file is loaded
3. **Execute**: The skill defines the workflow — which tools to use, in what order, and how to handle results
4. **Surface**: Skill activations are shown to the user: *[crow: activated skill — research-pipeline.md]*

## Compound Workflows

Skills can combine to handle complex requests:

- **"Daily briefing"** → Gmail + Calendar + Slack + Trello + Memory
- **"Start research on X"** → Memory + Projects + Brave Search + arXiv + Zotero
- **"Prepare for meeting"** → Calendar + Gmail + Memory + Research + Slack
- **"Publish my research"** → Projects + Blog + Storage (upload images)
- **"Set up file sharing"** → Storage + Sharing + Peer Network

## Creating New Skills

Skills are plain markdown. To add a new one:

1. Create `skills/your-skill.md` with description, triggers, and workflow
2. Add a row to the trigger table in `skills/superpowers.md`
3. Run `npm run sync-skills` to update this page
4. The skill will be available immediately — no build step needed
