---
name: knowledge-base
description: Manage multilingual knowledge base collections — create, edit, publish, search, verify, and share articles with structured resource tracking
triggers:
  - knowledge base
  - resource guide
  - community resources
  - KB
  - guides
  - verify resources
  - flag outdated
  - base de conocimiento
  - guía de recursos
  - recursos comunitarios
tools:
  - crow-knowledge-base
  - crow-memory
  - crow-sharing
---

# Knowledge Base Management

## When to Activate
- User mentions knowledge base, guides, articles, or resource guides
- User asks to create, edit, search, or publish KB content
- User asks to verify or flag outdated information
- User asks to share a guide or knowledge base with someone
- User asks to import documents into the knowledge base

## Core Workflows

### 1. Create a Bilingual Guide
1. Use `crow_kb_create_article` with the first language (pair_id auto-generated)
2. Note the returned `pair_id`
3. Use `crow_kb_create_article` again with the same `pair_id` for the translation
4. Add structured resources with `crow_kb_manage_resources` (action: "add")
5. Publish both versions with `crow_kb_publish_article`

### 2. Import Existing Content
1. User provides text/markdown content (paste or file reference)
2. Use `crow_kb_import_article` with the content
3. Parse the content to extract structured resource data (org names, phone numbers, addresses, hours, eligibility)
4. For each resource found, use `crow_kb_manage_resources` (action: "add") to create a structured entry
5. Confirm the extracted resources with the user before saving
6. If bilingual content: split EN and ES sections, import as paired articles

### 3. Search and Share
1. User asks for information ("where can I get help with rent?")
2. Use `crow_kb_search` to find relevant articles
3. Present results in the user's preferred language
4. If asked to share: use `crow_share` with `share_type: "kb_article"` and the article ID
5. If the KB has a public/LAN URL, offer it: "This guide is also available at /kb/[collection]/[slug]"

### 4. Maintenance Review
1. Use `crow_kb_review_flags` to check for flagged resources
2. For each flag, present the resource details and flag reason to the user
3. User decides: verify as current, update with new info, or dismiss the flag
4. Apply the decision with `crow_kb_manage_resources`:
   - action: "verify" — marks as verified, clears flag
   - action: "edit" — updates the resource data
   - action: "dismiss" — clears flag without verifying

### 5. Proactive Flagging
When reviewing or reading a guide, check for potentially outdated information:
- Resources not verified in 90+ days → flag with reason "Not verified since [date]"
- Phone numbers in unusual format → flag for review
- Programs with stated end dates that may have passed → flag
- **NEVER auto-update content.** Always flag and wait for human approval.

Use `crow_kb_manage_resources` (action: "flag") with a clear `flag_reason`.

## Categories
When creating articles, organize them into categories. Create categories first with localized names:
- Use the dashboard API or ask the user to name categories
- Categories have localized names (one per supported language)
- Assign articles to categories when creating them

## Visibility Modes
- **private** — Only visible in the Crow's Nest dashboard
- **public** — Accessible at /kb/[collection] from anywhere
- **lan** — Only accessible from the local network (intranet)
- **peers** — Shared with specific Crow contacts

## Language Handling
- Each article has a `language` field (ISO 639-1: en, es, fr, etc.)
- Paired translations share the same `pair_id`
- When presenting results, prefer the user's language
- Public pages auto-detect language from the browser's Accept-Language header
