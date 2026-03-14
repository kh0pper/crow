---
title: Using Skills
---

# Using Skills

Skills are the workflows that make Crow useful. They define what happens when you ask your AI to do something — how it searches your memory, manages research, publishes blog posts, or organizes your notes.

You don't need to know how skills work to use them. Just talk naturally, and Crow activates the right skill automatically.

## What Skills Do for You

When you say "research climate change," Crow doesn't just search the web. It:

1. Checks your memory for prior research on the topic
2. Creates a research project to organize findings
3. Searches for sources and generates proper citations
4. Stores everything with cross-references

That entire workflow is defined in a skill (`research-pipeline.md`). Without it, you'd need to call each tool individually.

## How to Trigger Skills

Skills activate based on what you say. You don't need special commands or syntax — just describe what you want:

| What you say | Skill that activates |
|---|---|
| "Remember this for later" | Memory Management |
| "Research voter turnout trends" | Research Pipeline |
| "Write a blog post about..." | Blog |
| "Here are my notes, organize them" | Ideation |
| "Message Sarah about the meeting" | Social (Nostr messaging) |
| "Upload this file" | Storage |
| "Share my research with Alex" | Sharing |
| "What can you do?" | Onboarding Tour |
| "Back up my data" | Backup |

Crow also understands Spanish and other languages — the trigger matching is intent-based, not keyword-based.

## Key Skills Walkthrough

### Memory Management

Crow stores memories automatically when you share important information, but you can also be explicit:

> "Remember that I prefer MLA citations for my history papers"

> "What do you remember about my kitchen renovation?"

Memories persist across sessions and platforms. If you store something while using Claude, it's there when you switch to ChatGPT.

### Research Pipeline

Start a research project with a simple request:

> "Start a research project on renewable energy storage"

Crow creates the project, then as you find sources:

> "Add this article as a source: [URL]"

It generates citations automatically in APA, MLA, Chicago, or web format. When you're done:

> "Generate a bibliography for my energy storage project in Chicago format"

### Ideation (Notes to Plans)

Paste a brain dump and let Crow organize it:

> "Here are my notes from today's meeting: [paste notes]"

Crow clusters your notes by theme, cross-references with existing projects, flags contradictions, and offers to distribute them into projects or generate an action plan.

### Blog

Create and publish posts conversationally:

> "Write a blog post about my hiking trip to Big Bend"

> "Publish it with the tag 'travel'"

Posts default to private until you explicitly publish them.

### Sharing & Social

Share items with contacts via encrypted P2P:

> "Share my climate research with Alex"

> "Message Sarah: the deadline moved to Friday"

All messages use end-to-end encryption via Nostr.

## Compound Workflows

Skills combine for complex tasks. Before running a multi-step workflow, Crow shows a checkpoint:

> **[crow checkpoint: Running "Daily briefing". Steps: 1) Gmail 2) Calendar 3) Trello 4) Memory. Say "skip" to cancel or "skip step N" to omit a step.]**

Example compound workflows:

- **"Daily briefing"** — Email + calendar + task boards + stored reminders
- **"Prepare for my meeting about X"** — Calendar details + email threads + memory context + research notes
- **"Start research on X"** — Memory check + project creation + web search + source documentation

## Customizing Skills

### Override a built-in skill

If a skill doesn't work quite right for you:

> "Crow, customize the sharing skill to skip confirmation when sharing with my contacts"

Crow copies the skill to `~/.crow/skills/` and applies your changes. Your version takes priority permanently.

### Create a new skill

Describe what you want automated:

> "Crow, create a skill for my morning routine. Check my email, summarize today's calendar, and list any Trello cards due this week."

Crow proposes the skill, asks for your approval, then saves it. It activates automatically from then on.

### Remove a custom skill

> "Crow, remove my custom sharing skill"

This restores the built-in version.

### Browse available skills

Open the **Skills** panel in the Crow's Nest to see all available skills, or ask:

> "What skills do you have?"

## Safety Checkpoints

Certain actions trigger safety confirmations — Crow asks before doing anything destructive, resource-heavy, or network-altering. See the [Customization guide](/guide/customization#safety-checkpoints) for details.
