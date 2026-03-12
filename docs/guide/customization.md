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

> "Crow, always respond to me in Spanish"

Crow updates your context so that every future session — on any platform — defaults to Spanish.

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

## Per-device context

::: info Coming soon
A future update will support per-device overrides, so you can have different preferences depending on where you are using Crow. For example, you might want verbose responses on your desktop but short answers on your phone. For now, crow.md applies uniformly across all platforms and devices.
:::
