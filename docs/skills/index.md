# Skills

Skills are markdown files in `skills/` that define behavioral prompts for the AI assistant. They're not code — they describe workflows, trigger patterns, and integration logic that Claude loads on demand.

## Core Skills

| Skill | File | Purpose |
|---|---|---|
| **Superpowers** | `superpowers.md` | Master routing — maps user intent to skills and tools |
| **Memory Management** | `memory-management.md` | When and how to store/recall memories |
| **Research Pipeline** | `research-pipeline.md` | Project and research workflow with citations and verification |
| **Session Context** | `session-context.md` | Session start/end protocols |
| **Plan & Review** | `plan-review.md` | Checkpoint-based planning for multi-step tasks |
| **Session Summary** | `session-summary.md` | Quick session wrap-up: deliverables, decisions, next steps |
| **Reflection** | `reflection.md` | Session friction analysis and improvement proposals |
| **Skill Writing** | `skill-writing.md` | Dynamic skill creation and improvement |
| **i18n** | `i18n.md` | Multilingual output adaptation |

## Platform Skills

| Skill | File | Purpose |
|---|---|---|
| **Crow Context** | `crow-context.md` | Cross-platform behavioral context (crow.md) management |
| **Blog** | `blog.md` | Blog creation, publishing, theming, and export |
| **Storage** | `storage.md` | File storage management and quota tracking |
| **Sharing** | `sharing.md` | P2P encrypted sharing workflows (invite, share, inbox) |
| **Social** | `social.md` | Messaging and social interactions via Nostr |
| **Peer Network** | `peer-network.md` | Peer management, relay config, identity, blocking |
| **Onboarding** | `onboarding.md` | First-run sharing setup and device migration |
| **Onboarding Tour** | `onboarding-tour.md` | First-run platform tour for new users |
| **Add-ons** | `add-ons.md` | Add-on browsing, installation, and removal |
| **Network Setup** | `network-setup.md` | Tailscale remote access guidance |
| **Backup** | `backup.md` | Database backup and restore workflows |
| **Bug Report** | `bug-report.md` | Bug and feature reporting |

## Integration Skills

| Skill | File | Purpose |
|---|---|---|
| **Web Search** | `web-search.md` | Brave Search workflows with citation |
| **Google Workspace** | `google-workspace.md` | Gmail, Calendar, Drive, Docs, Sheets |
| **Google Chat** | `google-chat.md` | Google Chat spaces and messages |
| **GitHub** | `github.md` | Repos, issues, PRs, code search |
| **Slack** | `slack.md` | Team messaging workflows |
| **Discord** | `discord.md` | Server and channel management |
| **Microsoft Teams** | `microsoft-teams.md` | Teams messaging workflows |
| **Notion** | `notion.md` | Wiki pages and databases |
| **Project Management** | `project-management.md` | Trello and Canvas LMS workflows |
| **Filesystem** | `filesystem.md` | File management operations |
| **Mobile Access** | `mobile-access.md` | Gateway and remote access workflows |

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
3. The skill will be available immediately — no build step needed
