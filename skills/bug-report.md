---
name: bug-report
description: Report bugs and request features — works with or without GitHub configured
triggers:
  - bug report
  - report a bug
  - feature request
  - file an issue
  - found a bug
tools:
  - crow-memory
  - github (optional)
---

# Bug & Feature Reporting

## When to Activate

- User reports a problem, error, or unexpected behavior
- User requests a new feature or enhancement
- User says "file an issue", "open a ticket", "report a bug"

## Path Detection

Check if GitHub MCP server is available:
- **GitHub available**: Use `search_issues` + `create_issue` for full workflow
- **No GitHub**: Gather details and save to Crow memory as a structured report

## Workflow 1: Report a Bug

### Step 1 — Gather Information

Ask the user for:
1. **What happened?** — Brief description of the problem
2. **Steps to reproduce** — What were you doing when it happened?
3. **Expected behavior** — What should have happened instead?
4. **Environment** — Which platform (Claude, ChatGPT, etc.), browser, OS if relevant

Keep the conversation natural. Don't dump all questions at once — ask follow-ups based on their responses.

### Step 2A — GitHub Available

1. **Check for duplicates**: `search_issues` with keywords from the description
2. If duplicate found: Show the existing issue and ask if it's the same problem
3. If no duplicate: Create the issue

**For Crow repository** (`kh0pper/crow`): Use the bug-report template format:
```markdown
## Description
[User's description]

## Steps to Reproduce
1. [Step 1]
2. [Step 2]

## Expected Behavior
[What should happen]

## Actual Behavior
[What actually happens]

## Environment
- Platform: [Claude/ChatGPT/etc.]
- Setup: [Desktop/Cloud/Docker]
```

**For other repositories**: Use a simpler format appropriate to the project.

### Step 2B — No GitHub

1. Save the report to Crow memory:
   - Category: `bug-report`
   - Tags: `bug, report, [affected-area]`
   - Content: Structured report with all gathered details
   - Importance: 7

2. Tell the user:
   > I've saved this bug report to your memory. You can:
   > - Share it with the developer directly
   > - Submit it yourself at the project's issue tracker
   > - Connect GitHub to Crow to file issues automatically in the future

## Workflow 2: Request a Feature

### Step 1 — Gather Information

Ask the user for:
1. **What feature?** — Title and brief description
2. **Why?** — What problem does it solve? What's the use case?
3. **Any examples?** — Have you seen this in other tools?

### Step 2A — GitHub Available

1. **Check for duplicates**: `search_issues` with keywords
2. If similar request exists: Show it, suggest upvoting or commenting

**For Crow repository**: Route to the correct template:
- New integration → use `integration-request.md` template
- New skill/workflow → use `skill-proposal.md` template
- New add-on → use `addon-submission.md` template
- General feature → standard feature request format

### Step 2B — No GitHub

1. Save to Crow memory:
   - Category: `feature-request`
   - Tags: `feature, request, [area]`
   - Content: Structured request with title, rationale, use cases
   - Importance: 6

2. Tell the user the report is saved and how to submit it manually.

## Transparency

*[crow: activated skill — bug-report.md]*

When filing to GitHub:
**[crow checkpoint: About to create issue in [repo]. Title: "[title]". Proceed?]**

When saving to memory:
*[crow: saved bug report to memory — "[brief title]"]*

## Tips

- Be empathetic — the user is experiencing a problem
- Don't ask for information the user already provided
- If the bug is about Crow itself, note the platform and setup type
- For Crow bugs, check if `skills/` or `servers/` are relevant and tag accordingly
