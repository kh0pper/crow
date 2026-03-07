# Google Workspace Skill

## Description
Interact with Google Workspace apps — Gmail, Calendar, Sheets, Docs, Slides — through the Google Workspace MCP server. Store important information in persistent memory for cross-session access.

## When to Use
- When the user asks about emails, calendar events, or documents
- When creating or editing Google Docs, Sheets, or Slides
- When scheduling meetings or managing calendar
- When sending or drafting emails
- When searching for information across Google Workspace

## External MCP Server
Uses `google_workspace_mcp` which provides tools for:

### Gmail
- Search emails by query, sender, date, labels
- Read email content
- Send and draft emails
- Manage labels

### Google Calendar
- List upcoming events
- Create, update, delete events
- Find free time slots
- Check availability

### Google Sheets
- Create and open spreadsheets
- Read and write cell data
- Search across sheets

### Google Docs
- Create and edit documents
- Search document content
- Read document text

### Google Slides
- Create presentations
- Add and edit slides

## Workflow: Daily Briefing
1. Check Gmail for important/unread emails
2. Get today's and tomorrow's calendar events
3. Store any action items in memory with appropriate deadlines
4. Present consolidated briefing

## Workflow: Meeting Prep
1. Get the calendar event details
2. Search Gmail for related correspondence
3. Check memory for prior context about the meeting topic
4. Search research database for relevant sources
5. Summarize all context for the user

## Workflow: Store Email Content
When an email contains important project information:
1. Extract key details from the email
2. Store in memory with category "project" or "decision"
3. If it contains research-worthy links, add to research pipeline
4. Tag with relevant project names

## Workflow: Document Creation
When creating Google Docs from research:
1. Search research sources and notes for the topic
2. Generate bibliography using `crow_generate_bibliography`
3. Create the document with proper citations
4. Store the document link in memory for future reference

## Best Practices
- Always check memory for context before composing emails
- Store meeting outcomes and action items in memory after meetings
- Link calendar events to research projects when relevant
- Use consistent naming conventions for documents
