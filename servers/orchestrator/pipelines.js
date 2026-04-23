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

  "mpa-memory-consolidation": {
    name: "MPA: Memory Consolidation",
    description:
      "Tier-0 nightly memory-review pipeline. Every day at 03:00 America/Chicago, scans the most recent MPA-tagged memories, flags near-duplicate or drift candidates, and stores a single review report memory tagged `mpa,consolidation,review`. Review-only for first ship — the mpa-memory-review preset has no delete/update tool, so the worst case is a noisy report. Widen the preset's tool allowlist once the reports prove consistently actionable.",
    goal:
      "Record a daily memory-review marker by making exactly two tool calls in this order. " +
      "Do not reason in prose first — call the tools immediately.\n\n" +
      "CALL 1 — crow_memory_stats (no arguments). The response text starts with " +
      "\"Memory Statistics:\" then \"Total memories: N\". Capture N as ${TOTAL}.\n\n" +
      "CALL 2 — crow_store_memory with these exact arguments:\n" +
      "  content = \"MPA memory review ${TODAY} — total memories: ${TOTAL}. Review-only " +
      "    pipeline; no mutations performed.\"\n" +
      "  category = \"process\"\n" +
      "  importance = 3\n" +
      "  tags = \"mpa,consolidation,review\"\n\n" +
      "After crow_store_memory returns, respond with exactly one line: the stored memory id " +
      "and ${TOTAL}. Do not call any other tool.",
    preset: "mpa-memory-review",
    defaultCron: "0 3 * * *",
    storeResult: false,
    resultCategory: null,
  },

  "mpa-conference-cfp-monitor": {
    name: "MPA: Conference CFP Monitor",
    description:
      "Tier-0 weekly CFP scout. Mondays at 07:00 America/Chicago, runs three narrow brave_web_search queries against Maestro Press topic areas, filters hits for explicit call-for-papers signals, dedupes against existing tasks by URL, and creates one task per fresh hit in the MPA tasks panel. Pushes a notification when any NEW tasks were created; silent when everything surfaced is already a known task.",
    goal:
      "Scout new conference CFPs and turn each fresh hit into a task. Emit ONE tool call " +
      "per response — never batch tool calls into one message.\n\n" +
      "STEP 1 — Call brave_web_search with:\n" +
      "  query = \"\\\"Texas school finance\\\" conference 2026 OR 2027 \\\"call for\\\"\"\n" +
      "  count = 10\n\n" +
      "STEP 2 — Call brave_web_search with:\n" +
      "  query = \"AI K-12 education conference 2026 OR 2027 \\\"call for proposals\\\"\"\n" +
      "  count = 10\n\n" +
      "STEP 3 — Call brave_web_search with:\n" +
      "  query = \"education equity policy conference 2026 OR 2027 \\\"call for papers\\\"\"\n" +
      "  count = 10\n\n" +
      "After STEP 3, from ALL three responses keep only entries whose title or description " +
      "explicitly contains one of (case-insensitive): \"call for papers\", \"call for " +
      "proposals\", \"call for presentations\", \"submit abstract\", \"submit proposal\", " +
      "\"cfp\", \"submission deadline\", \"abstract deadline\". Cap at 2 kept per query, 6 " +
      "total. For each, note TITLE (≤70 chars), URL, DEADLINE_SNIPPET (date phrase from " +
      "description or \"(no deadline found)\"), and TOPIC (\"Texas school finance\", \"AI " +
      "K-12\", or \"education equity\").\n\n" +
      "STEP 4..N — For each kept entry, one at a time (one tool call per response):\n" +
      "  (a) Call tasks_search with query=<that URL>, status=\"any\", limit=1. If the " +
      "      response's data.count > 0, the URL is already tracked — skip to the next " +
      "      entry.\n" +
      "  (b) If count == 0, the entry is fresh. Try to parse DEADLINE_SNIPPET into YYYY-MM-" +
      "      DD. Only keep a parsed due_date when the snippet is an unambiguous full " +
      "      calendar date (e.g. \"March 2, 2027\" → 2027-03-02). If only month/year, " +
      "      omit due_date entirely.\n" +
      "  (c) Call tasks_create with:\n" +
      "        title = \"CFP: \" + <TITLE>\n" +
      "        description = (multiline)\n" +
      "            \"URL: <URL>\\n\" +\n" +
      "            \"Topic: <TOPIC>\\n\" +\n" +
      "            \"Deadline (raw): <DEADLINE_SNIPPET>\\n\" +\n" +
      "            \"Discovered: ${TODAY}\"\n" +
      "        priority = 2\n" +
      "        due_date = <parsed YYYY-MM-DD, or OMITTED>\n" +
      "        phase = \"scouting\"\n" +
      "        tags = \"mpa,cfp,scouting\"\n" +
      "      Track the running list of created tasks as ${NEW_SUMMARY} (one line each: " +
      "      \"- <TITLE> (<due or raw deadline>)\") and increment ${NEW_COUNT}.\n\n" +
      "FINAL — If ${NEW_COUNT} == 0, do NOT call crow_create_notification. Respond with one " +
      "line saying no new CFPs qualified.\n\n" +
      "Otherwise, call crow_create_notification with:\n" +
      "  title = \"MPA: ${NEW_COUNT} new CFP candidate(s)\"\n" +
      "  body = <first 200 chars of ${NEW_SUMMARY}>\n" +
      "  type = \"scouting\"\n" +
      "  priority = \"normal\"\n" +
      "  action_url = \"https://grackle.dachshund-chromatic.ts.net:8447/dashboard/tasks?view=all\"\n" +
      "Absolute URL points at MPA's own dashboard (port 8447) so clicks land where the " +
      "tasks live.\n\n" +
      "Then respond with one short line: ${NEW_COUNT} new CFP(s), total hits scanned. " +
      "Never fabricate a URL, title, or deadline.",
    preset: "mpa-cfp-monitor",
    defaultCron: "0 7 * * 1",
    storeResult: false,
    resultCategory: null,
  },

  "mpa-weekly-retro": {
    name: "MPA: Weekly Retro",
    description:
      "Tier-0 weekly retrospective pipeline. Sundays at 16:00 America/Chicago, searches the past week's MPA memories, synthesizes a short retro covering triage volume, outreach activity, and notable threads, stores the retro as a tagged memory, and pushes a normal-priority notification with a 200-char preview. Reuses the `briefing` preset with its expanded tool allowlist.",
    goal:
      "Compose the weekly retrospective by calling the tools below in exact order. Call tools " +
      "FIRST, then compose the final text from their returned data.\n\n" +
      "CALL 1 — crow_search_memories with exact arguments:\n" +
      "  query = \"mpa\"\n" +
      "  limit = 40\n" +
      "  semantic = false\n" +
      "The response is a text block; each hit begins \"[#<id>] <category> | imp:<n> | " +
      "<created_at>\" followed by content and tags. Consider only hits whose created_at is " +
      "within the last 7 calendar days of ${TODAY}. For everything older, skip.\n\n" +
      "From those recent hits, count: TRIAGE_RUNS (tags contain `triage`), " +
      "OUTREACH_RUNS (tags contain `outreach`), BRIEFING_COUNT (category = briefing or tags " +
      "contain `digest`), CONSOLIDATION_COUNT (tags contain `consolidation`), and " +
      "TOTAL_WEEK (sum of all recent hits). Also pick up to three NOTABLE lines — pick the " +
      "most specific, concrete entries (actual sender/subject/outreach recipient, not empty " +
      "runs) and emit each as \"#<id>: <≤90-char snippet>\".\n\n" +
      "Build ${RETRO_BODY} as this exact markdown (keep to ≤900 chars):\n" +
      "  \"Week of ${TODAY}: ${TOTAL_WEEK} MPA memories.\\n\" +\n" +
      "  \"- triage: <TRIAGE_RUNS> runs\\n\" +\n" +
      "  \"- outreach: <OUTREACH_RUNS> runs\\n\" +\n" +
      "  \"- briefings/digests: <BRIEFING_COUNT>\\n\" +\n" +
      "  \"- consolidation reviews: <CONSOLIDATION_COUNT>\\n\" +\n" +
      "  \"\\nNotable:\\n\" +\n" +
      "  \"- <NOTABLE_1 or \\\"(none)\\\">\\n\" +\n" +
      "  \"- <NOTABLE_2 or \\\"(none)\\\">\\n\" +\n" +
      "  \"- <NOTABLE_3 or \\\"(none)\\\">\"\n\n" +
      "CALL 2 — crow_store_memory with exact arguments:\n" +
      "  content = ${RETRO_BODY}\n" +
      "  category = \"retro\"\n" +
      "  importance = 4\n" +
      "  tags = \"mpa,retro,week-of-${TODAY}\"\n" +
      "Capture the returned memory id as ${RETRO_ID}.\n\n" +
      "CALL 3 — crow_create_notification with exact arguments:\n" +
      "  title = \"MPA weekly retro — week of ${TODAY}\"\n" +
      "  body = <first 200 characters of ${RETRO_BODY}>\n" +
      "  type = \"retro\"\n" +
      "  priority = \"normal\"\n" +
      "  action_url = \"/dashboard/memory?edit=${RETRO_ID}&instance=${INSTANCE_ID}\"\n\n" +
      "After the three tool calls succeed, respond with one short line containing the " +
      "stored memory id and the counts. Never fabricate memory IDs or snippets — every " +
      "citation must trace back to a hit crow_search_memories actually returned.",
    preset: "briefing",
    defaultCron: "0 16 * * 0",
    storeResult: false,
    resultCategory: null,
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

  "mpa-follow-up-nudger": {
    name: "MPA: Follow-Up Nudger",
    description:
      "Tier-1 Gmail follow-up nudger, complement to mpa-outreach-drafter. Weekdays at 14:00 CDT, finds INBOUND-originated inbox threads (someone else wrote Kevin first) where Kevin replied and the other party has gone quiet for 5+ days. Writes a gentle \"just following up\" draft in Gmail Drafts (thread-scoped). Never sends. The outreach-drafter at 18:00 covers the mirror case (Kevin initiated, no reply); this one covers inbound threads Kevin is waiting on. Filters exclude each other so nothing gets double-nudged in a given day: outreach-drafter queries `in:sent`, this pipeline queries `in:inbox` and only acts when the thread's FIRST message is NOT from Kevin.",
    goal:
      "Draft gentle follow-up nudges for stalled INBOUND-originated threads by making the " +
      "tool calls below in order.\n\n" +
      "CALL 1 — gmail_search_threads with these exact arguments:\n" +
      "  query = \"in:inbox older_than:5d newer_than:60d -subject:invoice -subject:receipt " +
      "-subject:digest -subject:newsletter -category:promotions -category:social " +
      "-category:updates -category:forums\"\n" +
      "  max_results = 10\n" +
      "Capture the response's `data.threads` array as ${INBOX_THREADS}. If it is empty, skip " +
      "straight to the FINAL step below with zero drafts.\n\n" +
      "For each thread in ${INBOX_THREADS}:\n\n" +
      "CALL — gmail_get_thread with thread_id = <that thread's thread_id>. The response has " +
      "`data.messages` (ordered oldest → newest) with per-message headers.from, headers.to, " +
      "headers.date, and body_text.\n\n" +
      "Decide whether to draft a follow-up using these rules in order:\n" +
      "  - SKIP if data.messages.length < 2 — need at least one inbound + one Kevin reply.\n" +
      "  - SKIP if data.messages[0].headers.from CONTAINS " +
      "\"kevin.hopper@maestro.press\", \"kevin.hopper1@gmail.com\", or \"kevin hopper\" " +
      "— that's an outbound-originated thread and belongs to the 18:00 outreach-drafter.\n" +
      "  - SKIP if data.messages[-1].headers.from does NOT contain " +
      "\"kevin.hopper@maestro.press\", \"kevin.hopper1@gmail.com\", or \"kevin hopper\" " +
      "— the other side already replied; nothing to nudge yet.\n" +
      "  - SKIP transactional/automated inbound senders based on " +
      "data.messages[0].headers.from: addresses containing \"no-reply\", \"noreply\", " +
      "\"notifications@\", \"billing@\", \"receipts@\", \"support@\", \"hello@\", or " +
      "domains stripe/quickbooks/docusign/mailgun/github/digitalocean/tailscale/anthropic/" +
      "openai/substack/medium.\n" +
      "  - SKIP if there is any thread label suggesting automated content " +
      "(CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_UPDATES, CATEGORY_FORUMS).\n\n" +
      "For each thread that passes the filters, the recipient is the sender of the FIRST " +
      "inbound message — data.messages[0].headers.from. Strip any display-name wrapper and " +
      "keep only the bare email.\n\n" +
      "CALL — gmail_create_draft with these exact arguments:\n" +
      "  to = <extracted recipient email from data.messages[0].headers.from>\n" +
      "  subject = \"Re: \" + <thread's first-message subject without existing 'Re:' prefix>\n" +
      "  body = a short polite follow-up (UNDER 100 words) referencing the actual thread " +
      "topic in one line, acknowledging that it's been a few days since your reply, and " +
      "asking a single clarifying question or offering a concrete next step drawn from the " +
      "thread. Sign as \"Kevin\". Example shape only (substitute the actual subject and ask):\n" +
      "    \"Hi <first-name>,\\n\\nJust following up on <subject-snippet> — I realize it's " +
      "been a few days since my reply.\\n\\n<one clarifying question or concrete next " +
      "step>.\\n\\nHappy to wait if this needs more time on your end.\\n\\nKevin\"\n" +
      "  thread_id = <that thread's thread_id>   (so the draft threads as a reply to the " +
      "existing conversation)\n" +
      "Never fabricate a prior commitment, quote, or agreement — only reference what the " +
      "actual thread contains.\n\n" +
      "Track the count of drafts you successfully created as ${DRAFT_COUNT} and the list of " +
      "(recipient, subject) pairs as ${DRAFT_SUMMARY}.\n\n" +
      "FINAL — crow_store_memory with these exact arguments:\n" +
      "  content = a short markdown summary of this run, formatted exactly as:\n" +
      "    \"Follow-up nudger ${TODAY} — drafted: ${DRAFT_COUNT}, skipped: <count>\\n\" +\n" +
      "    \"- <recipient>: <subject>\" (one line per draft created; omit the list " +
      "if ${DRAFT_COUNT} == 0)\n" +
      "  category = \"outreach\"\n" +
      "  importance = 3\n" +
      "  tags = \"mpa,outreach,follow-up,draft\"\n\n" +
      "After the final tool call succeeds, respond with a single short confirmation line " +
      "containing the stored memory id and the draft count. Do not send any email — " +
      "gmail_create_draft only leaves the draft for Kevin's manual review.",
    preset: "mpa-outreach",
    defaultCron: "0 14 * * 1-5",
    storeResult: false,
    resultCategory: null,
  },

  "mpa-project-help-ethics-tracker": {
    name: "MPA: Project Help Ethics Tracker",
    description:
      "Tier-0 watcher for replies from Austin ISD Office of the General Counsel on the Project Help / conflict-of-interest clearance thread. Every 6 hours, runs one Gmail search for unread inbound from austinisd.org in the last 14 days. If anything matches, pushes a HIGH-priority ntfy notification and stores a short audit memory. Narrow read-only + notification/memory writes — no drafts, no replies, no archives. Rationale: AISD ethics clearance is a prerequisite for any Project Help consulting work; a reply must surface fast rather than waiting for the next scheduled triage pass.",
    goal:
      "Scan Kevin's inbox for new AISD ethics / Project Help correspondence by making at most three " +
      "tool calls in order.\n\n" +
      "CALL 1 — gmail_search_threads with these exact arguments:\n" +
      "  query = \"from:austinisd.org is:unread newer_than:14d\"\n" +
      "  max_results = 10\n" +
      "The response is {\"success\": true, \"data\": {\"threads\": [...]}}. Capture the threads " +
      "array as ${AISD_THREADS} and its length as ${AISD_COUNT}. Each thread object has " +
      "`from`, `subject`, and `snippet` fields.\n\n" +
      "If ${AISD_COUNT} == 0: do not call any more tools. Respond with the single line " +
      "\"No unread AISD threads in the last 14 days; skipped notification.\" and stop.\n\n" +
      "Otherwise, build ${THREAD_LINES} as a newline-joined list, one line per thread in " +
      "${AISD_THREADS}, in this exact shape:\n" +
      "    \"- <from>: <subject>\"\n" +
      "where <from> is the thread.from field (preserve its display-name/email form exactly " +
      "as returned) and <subject> is thread.subject trimmed to 100 characters.\n\n" +
      "CALL 2 — crow_store_memory with these exact arguments:\n" +
      "  content = \"AISD ethics tracker ${TODAY} — unread from austinisd.org: ${AISD_COUNT}\\n\" + " +
      "${THREAD_LINES}\n" +
      "  category = \"triage\"\n" +
      "  importance = 5\n" +
      "  tags = \"mpa,ethics,aisd,project-help\"\n" +
      "Capture the returned memory id as ${MEMORY_ID}.\n\n" +
      "CALL 3 — crow_create_notification with these exact arguments:\n" +
      "  title = \"AISD ethics tracker — ${AISD_COUNT} new from austinisd.org\"\n" +
      "  body = <first 240 characters of ${THREAD_LINES}>\n" +
      "  type = \"ethics\"\n" +
      "  priority = \"high\"\n" +
      "  action_url = \"/dashboard/memory?edit=${MEMORY_ID}&instance=${INSTANCE_ID}\"\n\n" +
      "After the notification is created, respond with a single short confirmation line " +
      "containing ${AISD_COUNT}, ${MEMORY_ID}, and the notification id. Do not fabricate " +
      "threads, subjects, or senders — only echo what gmail_search_threads actually returned.",
    preset: "mpa-gmail",
    defaultCron: "0 */6 * * *",
    storeResult: false,
    resultCategory: null,
  },
};
