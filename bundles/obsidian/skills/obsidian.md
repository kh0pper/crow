---
name: obsidian
description: Read, search, and sync notes with your Obsidian vault
triggers:
  - obsidian
  - vault
  - daily note
  - obsidian note
  - sync to obsidian
tools:
  - obsidian
  - crow-research
  - crow-memory
---

# Obsidian Integration

## When to Activate

- User mentions Obsidian, vault, or daily notes
- User wants to read or search notes in their Obsidian vault
- User wants to sync Crow research to Obsidian

## Prerequisites

The Obsidian MCP server must be configured with `OBSIDIAN_VAULT_PATH` pointing to the vault directory.

## Workflow 1: Search and Read Notes

1. Use Obsidian tools to search the vault by keyword or path
2. Read specific notes when the user asks about a topic
3. If relevant to current research, offer to save as a Crow research source

## Workflow 2: Sync Research to Obsidian

When the user says "sync research to Obsidian" or "export notes to vault":

1. List research projects with `crow_list_projects`
2. Ask which project to sync (or sync all)
3. For each source in the project:
   - Format as Obsidian-compatible markdown
   - Include YAML frontmatter: `title`, `authors`, `date`, `tags`, `citation`
   - Use wikilinks for cross-references between notes
   - Place in a `Research/[Project Name]/` folder in the vault

### Note Format

```markdown
---
title: "Source Title"
authors: "Author List"
date: "YYYY-MM-DD"
tags: [research, project-name, topic]
citation: "APA citation"
source_type: academic_paper
---

# Source Title

## Summary
[content_summary from Crow]

## Notes
[Any research notes linked to this source]

## Citation
> [APA citation]
```

## Workflow 3: Daily Notes Integration

If the user uses Obsidian daily notes:
- Offer to append Crow session summaries to today's daily note
- Include key decisions, memories stored, and research progress

## Tips

- Obsidian vault paths are local — this integration works best with desktop/local Crow setups
- Wikilinks (`[[Note Name]]`) are Obsidian's native linking format
- Respect the user's existing folder structure — ask before creating new folders
