---
title: Customization
---

# Customization

Make Crow behave the way you want — across every platform — just by asking.

## What is crow.md?

Every Crow instance has a set of instructions called **crow.md** that tells your AI how to behave. Think of it as a personality and preferences file. It controls things like:

- How Crow introduces itself
- How memories are stored and recalled
- What happens at the start and end of each session
- Transparency rules (what Crow tells you about behind-the-scenes actions)
- Which skills and tools are available

Unlike a configuration file buried in a folder somewhere, crow.md lives in your database. That means it travels with your data — whether you're talking to Crow through Claude, ChatGPT, Gemini, or any other supported platform.

## Why it matters

Without crow.md, each AI platform would treat Crow as a blank slate. With it, Crow behaves consistently no matter where you connect:

- **Same personality** — Your preferences for tone, language, and detail level apply everywhere
- **Same protocols** — Memory handling, session greetings, and transparency rules stay the same
- **Portable** — Switch platforms or devices and your customizations come with you

## How to customize

You do not need to open any files or write any code. Just talk to your AI. Crow has tools that update your context behind the scenes — specifically `crow_update_context_section` and `crow_add_context_section` — but you never need to call them directly. A plain request is all it takes.

### Setting a language preference

> "Crow, update my context to prefer Spanish responses"

Crow updates your context so that every future session — on any platform — defaults to Spanish. You can also be more specific:

> "Crow, respond in Spanish but keep technical terms in English"

### Adding context about your work

> "Crow, add a context section about my job. I'm a high school biology teacher and I use Crow mostly for lesson planning and student project tracking."

This creates a custom section in your crow.md that Crow will reference when helping you, so it can tailor suggestions to your situation without you repeating yourself.

### Adjusting transparency

> "Crow, I don't need the FYI messages about which tools you're using. Keep it minimal."

Crow will update the transparency rules to reduce informational messages during your sessions.

### Adding project-specific context

> "Crow, add a context section for my home renovation project. We're remodeling the kitchen — budget is $15,000, contractor is starting in April, and I'm tracking materials and receipts."

Now when you ask Crow about your renovation, it already knows the key details.

### Requesting concise responses

> "Crow, update my context to prefer short, concise responses. Skip the preamble."

This adjusts how Crow communicates with you across all platforms.

## Viewing your context

To see what your crow.md currently looks like, just ask:

> "Show me my crow.md"

You can also ask for specific sections:

> "What are my current transparency rules?"

Under the hood, this uses the `crow_get_context` tool, but you do not need to remember that.

### Default sections

Every Crow instance starts with these sections:

| Section | What it controls |
|---|---|
| **identity** | How Crow introduces itself and what it calls you |
| **memory_protocol** | Rules for storing, recalling, and managing memories |
| **session_protocol** | What happens at the start and end of each conversation |
| **transparency_rules** | When and how Crow tells you about behind-the-scenes actions |
| **skills_reference** | Which skills are available and how they activate |

## Protected vs custom sections

The five default sections listed above are **protected**. You can edit their content freely, but you cannot delete them — they provide the core behavioral framework that keeps Crow functioning properly.

**Custom sections** are ones you create yourself (like the work context or renovation project examples above). These can be added, updated, and removed at any time:

> "Crow, remove the context section about my renovation project"

There is no limit to how many custom sections you can add.

## Custom skills

Crow's behavior is driven by **skills** — markdown files that define workflows for specific tasks. You can customize skills or create new ones without writing any code.

### Viewing skills

From the **Crow's Nest**, open the **Skills** panel to browse all available skills. You'll see two types:

- **Built-in skills** — Ship with Crow and get updated when you update Crow. These are read-only in the Skills panel.
- **User skills** — Your custom or overridden skills, stored in `~/.crow/skills/`. These take precedence over built-in skills and are never overwritten by updates.

### Customizing a built-in skill

If a built-in skill doesn't quite work for you, override it:

> "Crow, I want to customize the sharing skill to skip the confirmation step when sharing with my contacts"

Crow will copy the built-in skill to your user directory (`~/.crow/skills/sharing.md`) and apply your changes. Your version takes priority from then on.

You can also do this manually from the Skills panel — click a built-in skill, then click **Override with Custom Copy**.

### Creating a new skill

Describe what you want automated:

> "Crow, create a skill for my morning routine. Check my email, summarize today's calendar, and list any Trello cards due this week."

Crow will propose the skill, ask for your approval, then save it to `~/.crow/skills/`. The skill activates automatically when you say something like "morning routine" or "daily briefing."

### Removing a custom skill

> "Crow, remove my custom sharing skill"

This deletes the override from `~/.crow/skills/`, restoring the built-in version. You can also delete skills from the Skills panel in the Crow's Nest.

### Installing community skills

Browse community skills in the **Extensions** panel. Installed skills are placed in `~/.crow/skills/` automatically, so they're safe from updates.

---

## Per-device context

Crow supports **per-device overrides** so you can have different preferences depending on where you're using it. For example, verbose responses on your desktop but short answers on your phone, or Spanish on one device and English on another.

### How it works

Each device can have its own version of any crow.md section. When Crow connects from a specific device, it merges:

1. **Global sections** — your base configuration (applies everywhere)
2. **Device-specific overrides** — replacements for specific sections on a particular device

If a section has a device-specific version, that version is used instead of the global one. Sections without device overrides use the global version as usual.

### Setting device preferences

Just tell Crow what device you're on and what you want:

> "Crow, on my phone, I prefer short responses. Add a device override for 'phone'."

> "Crow, when I'm on my work laptop (device: 'work-laptop'), respond in a more formal tone."

> "Crow, on the Raspberry Pi (device: 'colibri'), skip the dynamic context sections to save bandwidth."

Under the hood, this creates a device-specific section using the `crow_add_context_section` tool with a `device_id` parameter.

### Managing device overrides

You can view which device overrides exist:

> "List my crow.md sections and show which ones have device overrides"

Remove a device override to restore the global version for that device:

> "Remove the identity override for my phone"

### Technical details

- **Device IDs** are free-form strings you choose (e.g., `"phone"`, `"grackle"`, `"work-laptop"`)
- Global sections have `device_id = NULL`; device sections have a non-null `device_id`
- Protected sections (identity, memory_protocol, etc.) can have device overrides, but the global version cannot be deleted
- Deleting a device override restores the global version — it does not delete the section entirely
- The MCP `instructions` field (auto-injected context) also supports `deviceId` for per-device condensed context

### Setting up a device ID

To enable per-device context, set the `CROW_DEVICE_ID` environment variable before starting the gateway:

```bash
# In your .env file
CROW_DEVICE_ID=grackle
```

This tells Crow which device it's running on. Once the gateway wiring is complete, it will automatically apply the right device overrides to the MCP instructions.

---

## Safety checkpoints

Crow uses a tiered safety system that asks for confirmation before taking risky actions. This happens automatically — you don't need to enable it.

### Tier 1 — Destructive actions

Crow will confirm before publishing, deleting, or sending anything irreversible. You'll see what's about to happen and can cancel:

- Deleting files, posts, or memories
- Publishing or unpublishing blog posts
- Sending messages (cannot be unsent from Nostr relays)
- Sharing items with contacts
- Bulk operations affecting 3+ items

### Tier 2 — Resource-intensive operations

Before installing heavy add-ons or bundles, Crow checks whether your device can handle them. On resource-constrained devices (like a Raspberry Pi), you'll get a warning about expected resource usage.

### Tier 3 — Network and security changes

Any change to relay configuration, firewall rules, discoverability, or VPN settings requires explicit approval. Crow will show exactly what would change and wait for a clear "yes."

### Customizing safety behavior

You can adjust these checkpoints to match your preferences:

> "Crow, skip confirmation when deleting draft posts"

> "Crow, always confirm before any publish action"

Safety customizations are stored in your crow.md and apply across all platforms.

---

## Common customization examples

Here are some more ideas for what you can do:

### Academic use

> "Crow, add a context section for my research. I'm a PhD student in computational linguistics. When I add sources, always include DOI links. Prefer APA 7th edition citations."

### Family shared instance

> "Crow, update the identity section. We're the Garcia family. We use Crow for meal planning, grocery lists, and tracking school events."

### Bilingual home

> "Crow, on the kitchen tablet (device: 'kitchen'), always respond in Spanish. On my laptop, keep English."

### Privacy-focused

> "Crow, update the memory protocol. Never store personal financial information or passwords. Always ask before storing health-related data."

### Developer workflow

> "Crow, add a context section for my dev setup. I use VS Code, prefer TypeScript, and deploy to Vercel. When I ask about code, assume Node.js 20+ unless I say otherwise."

---

## Frequently asked questions

### Does customization sync across platforms?

Yes. Because crow.md lives in your database (not in a file on one device), your customizations apply whether you're using Claude, ChatGPT, Gemini, or any other MCP-compatible platform.

### Can I break something by customizing?

The five protected sections (identity, memory_protocol, session_protocol, transparency_rules, skills_reference) cannot be deleted, only edited. Even if you edit them with something unhelpful, you can always reset them:

> "Crow, reset the memory_protocol section to its default"

### How is this different from CLAUDE.md?

**CLAUDE.md** is a file in the Crow repo that tells developers how to build and extend Crow. **crow.md** is your personal behavioral configuration stored in the database. They serve completely different audiences — CLAUDE.md is for builders, crow.md is for users.

### Can I export my customizations?

Your crow.md is part of your Crow database. When you back up your database (`npm run backup`), all customizations are included. You can also view your full context anytime:

> "Show me my complete crow.md"
