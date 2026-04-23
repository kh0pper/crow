/**
 * Pipeline Definitions
 *
 * Each pipeline is a predefined multi-agent workflow that can be run
 * immediately or on a schedule. Pipelines map to orchestrator presets
 * with a specific goal template.
 *
 * Fields:
 *   - name: Human-readable name
 *   - description: What this pipeline does
 *   - goal: The goal string passed to the orchestrator
 *   - preset: Which team preset to use (from presets.js)
 *   - defaultCron: Suggested cron expression (used by crow_schedule_pipeline)
 *   - storeResult: If true, store the final output as a Crow memory
 *   - resultCategory: Memory category for stored results
 */

export const pipelines = {
  "memory-consolidation": {
    name: "Memory Consolidation",
    description: "Review recent memories for duplicates, conflicts, and consolidation opportunities",
    goal:
      "Search all memories and analyze them for: (1) duplicate or near-duplicate entries that should be merged, " +
      "(2) conflicting information that needs resolution, (3) related memories that could be consolidated into " +
      "a single richer entry. Report your findings with specific memory IDs and recommended actions.",
    preset: "memory_ops",
    defaultCron: "0 3 * * *", // Daily at 3am
    storeResult: true,
    resultCategory: "process",
  },

  "daily-summary": {
    name: "Daily Summary",
    description: "Summarize today's activity: new memories, project updates, and notable events",
    goal:
      "Search recent memories and project activity from the last 24 hours. Produce a concise daily summary covering: " +
      "(1) new memories stored today with key themes, (2) project updates or new sources added, " +
      "(3) any notable patterns or insights. Keep the summary under 500 words.",
    preset: "research",
    defaultCron: "0 22 * * *", // Daily at 10pm
    storeResult: true,
    resultCategory: "learning",
  },

  "research-digest": {
    name: "Research Digest",
    description: "Review all active projects and summarize their current state and recent progress",
    goal:
      "List all research projects and for each one: check its sources, notes, and any related memories. " +
      "Produce a digest summarizing the current state of each project, recent additions, and suggested next steps.",
    preset: "research",
    defaultCron: "0 9 * * 1", // Weekly on Monday at 9am
    storeResult: true,
    resultCategory: "project",
  },

  "mpa-outreach-drafter": {
    name: "MPA: Outreach Drafter",
    description:
      "Tier-1 Gmail outreach drafter. Weekdays at 18:00 CDT, finds threads where Kevin sent the last message 7+ days ago without a reply, writes a short polite nudge as a draft in Gmail Drafts (thread-scoped so it shows up as a reply in context). Never sends — Kevin reviews each draft and sends manually from Gmail. Scoped to 'people already in the inbox', so no external contact list is required.",
    goal:
      "Draft polite follow-up messages for stalled outbound threads by making the tool calls " +
      "below in order.\n\n" +
      "CALL 1 — gmail_search_threads with these exact arguments:\n" +
      "  query = \"in:sent older_than:7d newer_than:30d -subject:invoice -subject:receipt " +
      "-subject:digest -subject:newsletter\"\n" +
      "  max_results = 5\n" +
      "Capture the response's `data.threads` array as ${SENT_THREADS}. If it is empty, skip " +
      "straight to the FINAL step below with zero drafts.\n\n" +
      "For each thread in ${SENT_THREADS}:\n\n" +
      "CALL — gmail_get_thread with thread_id = <that thread's thread_id>. The response has " +
      "`data.messages` (ordered oldest → newest) with per-message headers.from, headers.to, " +
      "headers.date, and body_text.\n\n" +
      "Inspect the LAST message in the thread (data.messages[-1]). Decide whether to draft a " +
      "nudge using these rules:\n" +
      "  - SKIP if headers.from does NOT contain \"kevin.hopper@maestro.press\", " +
      "\"kevin.hopper1@gmail.com\", or \"kevin hopper\" — only nudge when Kevin's message is " +
      "the last one (i.e. the other side hasn't replied).\n" +
      "  - SKIP transactional/automated senders based on the original recipient " +
      "(data.messages[0].headers.to): addresses containing \"no-reply\", \"noreply\", " +
      "\"notifications@\", \"billing@\", \"receipts@\", or domains stripe/quickbooks/docusign/" +
      "mailgun/github/digitalocean/tailscale/anthropic/openai.\n" +
      "  - SKIP if the thread subject starts with \"Re:\" AND the first message's from is NOT " +
      "Kevin (reply chain Kevin didn't originate).\n" +
      "  - SKIP if there is any thread label suggesting automated content (CATEGORY_PROMOTIONS, " +
      "CATEGORY_SOCIAL, CATEGORY_UPDATES, CATEGORY_FORUMS).\n\n" +
      "For each thread that passes the filters, extract the recipient from data.messages[-1]." +
      "headers.to. If that field has multiple addresses, use the first one. Strip any display-" +
      "name wrapper and keep only the bare email.\n\n" +
      "CALL — gmail_create_draft with these exact arguments:\n" +
      "  to = <extracted recipient email>\n" +
      "  subject = \"Re: \" + <thread's first-message subject without existing 'Re:' prefix>\n" +
      "  body = a short polite nudge (UNDER 120 words) that references the actual thread " +
      "subject in one line, acknowledges that some time has passed since your last message, " +
      "and asks a clear single question or offers a specific next step. Sign as \"Kevin\". " +
      "Example shape only (substitute the actual subject and ask):\n" +
      "    \"Hi <first-name>,\\n\\nCircling back on <subject-snippet> — I realize it's been a " +
      "few weeks since I last wrote.\\n\\n<one specific question or next-step sentence>.\\n\\n" +
      "No pressure if this has fallen off the priority list; happy to revive whenever works.\\n\\n" +
      "Kevin\"\n" +
      "  thread_id = <that thread's thread_id>   (so the draft threads as a reply to the " +
      "existing conversation)\n" +
      "Never fabricate a prior commitment or quote. Only refer to what the actual thread " +
      "contains.\n\n" +
      "Track the count of drafts you successfully created as ${DRAFT_COUNT} and the list of " +
      "(recipient, subject) pairs as ${DRAFT_SUMMARY}.\n\n" +
      "FINAL — crow_store_memory with these exact arguments:\n" +
      "  content = a short markdown summary of this run, formatted exactly as:\n" +
      "    \"Outreach drafter ${TODAY} — drafted: ${DRAFT_COUNT}, skipped: <count>\\n\" +\n" +
      "    \"- <recipient>: <subject>\" (one line per draft created; omit the list " +
      "if ${DRAFT_COUNT} == 0)\n" +
      "  category = \"outreach\"\n" +
      "  importance = 3\n" +
      "  tags = \"mpa,outreach,draft\"\n\n" +
      "After the final tool call succeeds, respond with a single short confirmation line " +
      "containing the stored memory id and the draft count. Do not send any email — " +
      "gmail_create_draft only leaves the draft for Kevin's manual review.",
    preset: "mpa-outreach",
    defaultCron: "0 18 * * 1-5",
    storeResult: false,
    resultCategory: null,
  },

  "mpa-deadline-watcher": {
    name: "MPA: Deadline Watcher",
    description:
      "Tier-0 deadline watcher. Every 3 hours during the workday, pulls the 24h + overdue task buckets from the tasks bundle and pushes a ntfy notification if anything is due soon or overdue. Complements the 07:00 daily briefing by catching mid-day slippage and giving Kevin multiple shots at noticing critical items. No LLM reasoning beyond reading the bucket counts.",
    goal:
      "Check Kevin's tight-window deadlines by making at most two tool calls in order.\n\n" +
      "CALL 1 — tasks_briefing_snapshot with these exact arguments:\n" +
      "  today = \"${TODAY}\"\n" +
      "  window_days = 1\n" +
      "The response is {\"success\": true, \"data\": {\"content\": \"...\", \"counts\": {\"within\": N, \"overdue\": M}}}. " +
      "Capture counts.within as ${WITHIN_COUNT}, counts.overdue as ${OVERDUE_COUNT}, and the " +
      "content string as ${BUCKET_MARKDOWN}.\n\n" +
      "If ${WITHIN_COUNT} == 0 AND ${OVERDUE_COUNT} == 0: do not call any more tools. " +
      "Respond with the single line \"No deadlines within 24h and no overdue items; skipped notification.\" " +
      "and stop.\n\n" +
      "Otherwise, CALL 2 — crow_create_notification with these exact arguments:\n" +
      "  title = \"MPA deadlines: ${WITHIN_COUNT} due within 24h, ${OVERDUE_COUNT} overdue\"\n" +
      "  body = <first 240 characters of ${BUCKET_MARKDOWN}>\n" +
      "  type = \"deadline\"\n" +
      "  priority = \"high\"\n" +
      "  action_url = \"/dashboard/tasks?instance=${INSTANCE_ID}\"\n\n" +
      "After the notification is created, respond with a single short confirmation line containing " +
      "the counts and the notification id. Do not fabricate tasks — only echo what " +
      "tasks_briefing_snapshot returned.",
    preset: "briefing",
    defaultCron: "0 9,12,15,18 * * 1-5",
    storeResult: false,
    resultCategory: null,
  },

  "mpa-email-triage": {
    name: "MPA: Email Triage",
    description:
      "Tier-0 Gmail triage pipeline. Every 2 hours, classifies recent unread inbox threads into five action buckets (client-action-needed, vendor-reply, newsletter-noise, grant-foundation-related, capstone-personal), auto-archives anything classified as newsletter-noise, and stores a compact classification summary as an MPA memory tagged `mpa,triage`. Read-only + one narrow write (archive noise) — no drafts, no replies, no sends.",
    goal:
      "Triage Kevin's recent unread Gmail by making the tool calls below in order.\n\n" +
      "CALL 1 — gmail_search_threads with these exact arguments:\n" +
      "  query = \"label:inbox is:unread newer_than:2h\"\n" +
      "  max_results = 20\n" +
      "Capture the response's `data.threads` array as ${THREADS}. If it is empty, skip " +
      "straight to the FINAL step below with no archives and no summary bullets.\n\n" +
      "For each thread in ${THREADS}, classify it into exactly one of these buckets using " +
      "only the thread's subject, from, and snippet fields. Use case-insensitive keyword " +
      "matching, prefer a narrower bucket over a broader one, and default to the safest " +
      "bucket when unsure:\n" +
      "  - newsletter-noise — marketing blast, promotional offer, automated platform " +
      "    digest, retail newsletter, \"view in browser\" template, unsubscribe-footer " +
      "    sender. Only classify here if you are highly confident.\n" +
      "  - grant-foundation-related — sender or subject mentions grant, foundation, RFP, " +
      "    NOFO, philanthropy, award, fellowship, funding opportunity, or a known funder " +
      "    (Gates, Ford, Kellogg, Meadows, TEA grants).\n" +
      "  - vendor-reply — reply from a registered vendor/platform (Stripe, QuickBooks, " +
      "    Mailgun, Tailscale, DigitalOcean, Google Cloud, Gitea, Linear, Stripe Atlas, " +
      "    AWS, Camoufox) about a service action, bill, or account notice.\n" +
      "  - capstone-personal — UNT, INSD, professor, dissertation, capstone, textbook, " +
      "    family, personal correspondence not tied to Maestro Press operations.\n" +
      "  - client-action-needed — anything else that plausibly needs Kevin's response " +
      "    within 24h (journalists, partners, AISD staff, PIR replies, consulting " +
      "    prospects, named human correspondents).\n\n" +
      "THEN, for each thread classified as newsletter-noise AND ONLY those:\n" +
      "CALL — gmail_archive with thread_id = <that thread's thread_id>.\n" +
      "Do not archive anything classified in any other bucket. Skip the archive if there " +
      "is any doubt about the classification.\n\n" +
      "FINAL — crow_store_memory with these exact arguments:\n" +
      "  content = a short markdown summary of the triage run, formatted exactly as:\n" +
      "    \"Triage ${TODAY} (total: N)\\n\" +\n" +
      "    \"- client-action-needed (K):\\n\" +\n" +
      "    \"  - <from>: <subject>\" (one per thread in that bucket; omit the bucket " +
      "    header entirely when K = 0)\\n\" +\n" +
      "    ... one block per non-empty bucket in the order listed above ...\\n\" +\n" +
      "    \"archived: <count of newsletter-noise threads archived>\"\n" +
      "  category = \"triage\"\n" +
      "  importance = 3\n" +
      "  tags = \"mpa,triage\"\n\n" +
      "After the final tool call succeeds, respond with a single short confirmation line " +
      "containing the stored memory id, total threads seen, and archived count. Do not " +
      "fabricate threads or classifications — only include what gmail_search_threads " +
      "actually returned.",
    preset: "mpa-triage",
    defaultCron: "0 */2 * * *",
    storeResult: false,
    resultCategory: null,
  },

  "mpa-gmail-digest": {
    name: "MPA: Gmail Inbox Digest",
    description:
      "Read-only smoke-test pipeline for the google-workspace addon. Lists recent unread Gmail threads, produces a concise digest, stores it as a memory tagged `mpa,gmail`. Proves the full chain (scheduler → orchestrator → crow-chat → addon stdio → local MCP → Gmail REST) works end-to-end. Not scheduled by default — trigger manually via crow_schedule_pipeline or the dashboard.",
    goal:
      "Produce a concise digest of recent unread Gmail activity by making these tool calls in order:\n\n" +
      "CALL 1 — gmail_search_threads with arguments:\n" +
      "  query = \"label:inbox is:unread newer_than:1d\"\n" +
      "  max_results = 10\n" +
      "Capture the response's `data.threads` array.\n\n" +
      "CALL 2 — crow_store_memory with arguments:\n" +
      "  content = a short bulleted summary of those threads — one line each in the form\n" +
      "    \"- <sender>: <subject>\" (or \"- (empty inbox)\" if the result had zero threads)\n" +
      "  category = \"briefing\"\n" +
      "  importance = 4\n" +
      "  tags = \"mpa,gmail,digest\"\n\n" +
      "After both tool calls succeed, respond with a single short confirmation line containing the " +
      "stored memory id and the count of threads summarized. Do not fabricate threads — only " +
      "include what gmail_search_threads actually returned.",
    preset: "mpa-gmail",
    defaultCron: null,
    storeResult: false,
    resultCategory: null,
  },

  "mpa-daily-briefing": {
    name: "MPA: Daily Briefing",
    description:
      "Maestro Press morning nudge — pulls today's calendar events and recent unread email via the google-workspace addon, combines them with the tasks briefing, stores the result in tasks_briefings, and pushes a ntfy notification that deep-links to the Tasks panel.",
    goal:
      "Compose Kevin's morning briefing by making exactly five tool calls in this order. " +
      "Substitute ${TODAY} below with today's date in America/Chicago in ISO format " +
      "(YYYY-MM-DD). The -05:00 timezone offset is America/Chicago during Daylight Saving Time " +
      "(mid-March through early November). Do not substitute any other values — the literals " +
      "shown are mandatory.\n\n" +
      "CALL 1 — gcal_list_events with these exact arguments:\n" +
      "  calendar_id = \"primary\"\n" +
      "  time_min = \"${TODAY}T00:00:00-05:00\"\n" +
      "  time_max = \"${TODAY}T23:59:59-05:00\"\n" +
      "  max_results = 10\n" +
      "The response is {\"success\": true, \"data\": {\"events\": [...]}}. Capture the events " +
      "array as ${EVENTS}. If the call fails or returns no events, use an empty array.\n\n" +
      "CALL 2 — gmail_search_threads with these exact arguments:\n" +
      "  query = \"label:inbox is:unread newer_than:1d\"\n" +
      "  max_results = 5\n" +
      "The response is {\"success\": true, \"data\": {\"threads\": [...]}}. Capture the threads " +
      "array as ${THREADS}. If the call fails or returns no threads, use an empty array.\n\n" +
      "CALL 3 — tasks_briefing_snapshot with these exact arguments:\n" +
      "  today = \"${TODAY}\"\n" +
      "  window_days = 3\n" +
      "Capture the response's `content` string verbatim as ${TASKS_MARKDOWN}.\n\n" +
      "Now build ${BRIEFING_CONTENT} as this exact markdown, concatenating the three " +
      "sections with single blank lines between them:\n\n" +
      "\"## Today's calendar\\n\" +\n" +
      "  (if ${EVENTS} is empty: \"- (no events today)\\n\")\n" +
      "  (else: one line per event in the form\n" +
      "    \"- HH:MM – <event.summary>\"\n" +
      "   where HH:MM is the start time in local 24-hour format, parsed from event.start.dateTime " +
      "(or \"all-day\" when only event.start.date is set, no time); preserve event order)\n\n" +
      "\"\\n## Unread email (last 24h)\\n\" +\n" +
      "  (if ${THREADS} is empty: \"- (no unread)\\n\")\n" +
      "  (else: one line per thread in the form\n" +
      "    \"- <from>: <subject>\"\n" +
      "   where <from> is the display name or bare email from thread.from, and <subject> is " +
      "thread.subject trimmed to 80 chars; preserve thread order)\n\n" +
      "\"\\n\" + ${TASKS_MARKDOWN}\n\n" +
      "CALL 4 — tasks_store_briefing with these exact arguments:\n" +
      "  briefing_date = \"${TODAY}\"\n" +
      "  content = ${BRIEFING_CONTENT}\n" +
      "Capture the returned `id` field as ${BRIEFING_ID}.\n\n" +
      "CALL 5 — crow_create_notification with these exact arguments:\n" +
      "  title = \"MPA daily briefing - ${TODAY}\"\n" +
      "  body = <first 200 characters of ${BRIEFING_CONTENT}>\n" +
      "  type = \"briefing\"\n" +
      "  priority = \"normal\"\n" +
      "  action_url = \"/dashboard/tasks?briefing=${BRIEFING_ID}&instance=${INSTANCE_ID}\"\n\n" +
      "After all five tool calls have succeeded, respond with a single short confirmation " +
      "line containing ${BRIEFING_ID} and the counts (events: N, unread: N). Do not describe " +
      "what you would do — actually call every tool listed above. Do not fabricate events, " +
      "senders, or subjects — only include what the tools actually returned.",
    preset: "briefing",
    defaultCron: "0 7 * * 1-5",
    storeResult: false,
    resultCategory: null,
  },
};
