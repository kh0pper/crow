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
      "  action_url = \"https://crow.dachshund-chromatic.ts.net:8447/dashboard/tasks?view=all\"\n" +
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

  "mpa-pipeline-reliability": {
    name: "MPA: Pipeline Reliability Tracker",
    description:
      "Tier-0 nightly reliability tracker. Every day at 03:30 America/Chicago, reads aggregated pipeline_runs data (pre-computed and injected into the goal via ${RELIABILITY_SUMMARY} placeholder), stores a memory tagged `pipeline_reliability,summary,${TODAY}` with the run table, and calls out any Tier-1 pipelines with 10+ consecutive clean runs as promotion candidates for the next weekly retro.",
    goal:
      "Store the pipeline reliability summary as a memory by making exactly ONE tool call.\n\n" +
      "The reliability table has already been computed for you (the pipeline-runner injected " +
      "the aggregated pipeline_runs data below). Your job is only to wrap it in the memory " +
      "content and call crow_store_memory once.\n\n" +
      "RELIABILITY TABLE:\n\n" +
      "${RELIABILITY_SUMMARY}\n\n" +
      "CALL — crow_store_memory with these exact arguments:\n" +
      "  content = a short memory body, formatted exactly as:\n" +
      "    \"Pipeline reliability summary ${TODAY}\\n\\n\" +\n" +
      "    <the RELIABILITY TABLE content shown above, verbatim>\n" +
      "  category = \"process\"\n" +
      "  importance = 4\n" +
      "  tags = \"mpa,pipeline_reliability,summary\"\n\n" +
      "After the tool call succeeds, respond with a single short confirmation line containing " +
      "the stored memory id. Never fabricate pipeline names or counts — only include what the " +
      "pre-computed table shows.",
    preset: "mpa-reliability",
    defaultCron: "30 3 * * *",
    storeResult: false,
    resultCategory: null,
  },

  "mpa-consulting-prospectus-generator": {
    name: "MPA: Consulting Prospectus Generator",
    description:
      "Tier-1 consulting prospectus generator. Weekdays at 09:00 America/Chicago, pulls up to 3 pending prospects from the consulting_pipeline table (stage='prospect' AND last_pipeline_action IS NULL, capstone-analyzed districts first), fetches district profile + ARC + FSP + STAAR + bond + per-pupil data from the texas-gov-data MCP addon, drafts a 2-3 page personalized markdown prospectus for each, and drops the markdown into ~/maestro-press-assistant/prospectuses/inbox/ where the render-prospectus.path systemd watcher converts it to PDF within a few seconds. Silent no-op when the queue is empty. Writes one summary memory + one normal-priority ntfy per run.",
    goal:
      "Generate consulting prospectuses for pending prospects by making the tool calls below " +
      "in order. Emit EXACTLY ONE tool call per response — never multiple in a single message.\n\n" +
      "CALL 1 — crow_consulting_list_pending with these exact arguments:\n" +
      "  limit = 3\n" +
      "Response shape: {\"count\": N, \"items\": [{tea_id, name, org_type, esc_region, county, " +
      "total_students, charter_status, has_capstone_analysis, notes}, ...]}. Capture items as " +
      "${PENDING}. If ${PENDING} is empty (count == 0), skip straight to the FINAL memory/" +
      "notification steps below with ${GENERATED_COUNT} = 0 and ${GENERATED_LIST} = \"\".\n\n" +
      "For each prospect in ${PENDING}, in order, do the following sequence (one tool call per " +
      "turn; wait for each response before emitting the next call):\n\n" +
      "CALL — tea_get_district with district_id = <prospect.tea_id>. Skip this call for orgs " +
      "whose tea_id starts with \"ESC\" or \"NTO:\" (those are ESCs or non-TEA orgs and the " +
      "TEA tools won't know them). For skipped orgs, write a minimal prospectus body using " +
      "only the fields already in the consulting_pipeline row and proceed directly to the " +
      "crow_consulting_write_prospectus call. Capture the response's district profile as " +
      "${DISTRICT}.\n\n" +
      "CALL — tea_get_arc_factors with district_id = <tea_id>. Capture as ${ARC}. If the call " +
      "errors, continue — the prospectus can still be drafted from the data you have.\n\n" +
      "CALL — tea_get_fsp_data with district_id = <tea_id>. Capture as ${FSP}. Optional; " +
      "skip on error.\n\n" +
      "CALL — tea_get_per_pupil_expenditure with district_id = <tea_id>. Capture as ${PPE}. " +
      "Optional; skip on error.\n\n" +
      "CALL — tea_get_bond_summary with district_id = <tea_id>. Capture as ${BOND}. Optional; " +
      "skip on error. Only meaningful for ISDs (not charters).\n\n" +
      "CALL — tea_get_staar_scores_longitudinal with district_id = <tea_id>. Capture as " +
      "${STAAR}. Optional; skip on error.\n\n" +
      "Now draft the prospectus markdown. Use EXACTLY this structure (substitute bracketed " +
      "values with real data from the tool responses — never fabricate, and always cite the " +
      "school year for each metric):\n\n" +
      "    # Maestro Press — <DISTRICT.name> Engagement Prospectus\n" +
      "    *<today's date in Month D, YYYY format> · Prepared for district leadership*\n\n" +
      "    ## District snapshot (<school year>)\n" +
      "    - Enrollment: <total students>\n" +
      "    - ESC region: <region>, County: <county>\n" +
      "    - Type: <ISD | charter | ESC | ...>\n" +
      "    - Accountability rating: <rating if available>\n\n" +
      "    ## ARC factor profile\n" +
      "    <2-3 sentences citing specific ARC percentages with year, referencing at-risk, " +
      "    economically disadvantaged, ELL, special ed, homeless, and/or foster-care counts " +
      "    that came back from tea_get_arc_factors>\n\n" +
      "    ## Fiscal profile\n" +
      "    <2-3 sentences citing FSP category totals and per-pupil expenditure with year, " +
      "    only if those tool calls succeeded>\n\n" +
      "    ## Bond history\n" +
      "    <2-3 sentences citing bond proposition totals and pass/fail outcomes from " +
      "    tea_get_bond_summary, only if the call succeeded and the org is an ISD>\n\n" +
      "    <IF prospect.has_capstone_analysis == 1, add this section:>\n" +
      "    ## Published Maestro Press analysis of your district\n" +
      "    <one short paragraph acknowledging that Maestro Press has already published a " +
      "    constitutional-efficiency case study of this district — do not attempt to quote " +
      "    the case study; reference it by title framing only>\n\n" +
      "    ## How Maestro Press can help\n" +
      "    Three bullets tying the specific numbers above to one of:\n" +
      "    1. ARC-based needs-based funding analysis — empirical weights vs. frozen 0.20\n" +
      "    2. Bond election efficacy review for fast-growth or historically-failed districts\n" +
      "    3. Constitutional-efficiency gap analysis under the Edgewood/Morath standard\n\n" +
      "    ## Next step\n" +
      "    A 20-minute discovery call to review the data above and identify one actionable " +
      "    analysis Maestro Press can deliver within a 4-6 week engagement.\n\n" +
      "    Kevin Hopper · Maestro Press · kevin.hopper@maestro.press\n\n" +
      "Capture the completed markdown as ${PROSPECTUS_MD}.\n\n" +
      "CALL — crow_consulting_write_prospectus with these exact arguments:\n" +
      "  tea_id = <prospect.tea_id>\n" +
      "  markdown = ${PROSPECTUS_MD}\n" +
      "The response has {tea_id, name, md_path, expected_pdf_path, bytes}. Append " +
      "\"<name> → <expected_pdf_path>\" to ${GENERATED_LIST} (newline-delimited). Increment " +
      "${GENERATED_COUNT}.\n\n" +
      "After you have processed every prospect in ${PENDING} (or if ${PENDING} was empty):\n\n" +
      "FINAL — crow_store_memory with these exact arguments:\n" +
      "  content = a short markdown summary, formatted exactly as:\n" +
      "    \"Consulting prospectus generator ${TODAY} — generated: ${GENERATED_COUNT}\\n\" +\n" +
      "    ${GENERATED_LIST}\n" +
      "  category = \"consulting\"\n" +
      "  importance = 4\n" +
      "  tags = \"mpa,consulting,prospectus,generator\"\n" +
      "Capture the returned memory id as ${MEMORY_ID}.\n\n" +
      "FINAL — crow_create_notification with these exact arguments (skip this step only if " +
      "${GENERATED_COUNT} == 0):\n" +
      "  title = \"MPA prospectus generator — ${GENERATED_COUNT} prospectus${GENERATED_COUNT_PLURAL} ready\"\n" +
      "  body = <first 240 characters of ${GENERATED_LIST}>\n" +
      "  type = \"consulting\"\n" +
      "  priority = \"normal\"\n" +
      "  action_url = \"/dashboard/memory?edit=${MEMORY_ID}&instance=${INSTANCE_ID}\"\n\n" +
      "After all tool calls succeed, respond with a single short confirmation line containing " +
      "${GENERATED_COUNT} and ${MEMORY_ID}. Never fabricate district data — only cite numbers " +
      "the TEA tool responses actually returned. If a TEA tool errors, omit that section from " +
      "the prospectus rather than filling in a guess.",
    preset: "mpa-prospectus",
    defaultCron: "0 9 * * 1-5",
    storeResult: false,
    resultCategory: null,
  },

  "bot:echo-bot:tick": {
    name: "Bot: echo-bot tick",
    description:
      "Phase 7.7 verification stub. Polls Gmail for unread bot/echo-bot threads, drafts an ECHO: reply that quotes the original message, and re-labels the thread to bot/echo-bot/processed. Tier-0 safety: drafts only, no sends.",
    goal:
      "Process unread bot/echo-bot Gmail threads by drafting an echo reply for each. The whole " +
      "pipeline is ONE PASS — call gmail_search_threads exactly once at the start, iterate over " +
      "its results once, then emit the final response and stop.\n\n" +
      "STEP 1 — call gmail_search_threads ONCE with arguments:\n" +
      "  query: label:bot/echo-bot is:unread -label:bot/echo-bot/processed\n" +
      "  max_results: 5\n\n" +
      "Capture the threads array from the response. Let DRAFTED start at 0. If the threads " +
      "array is empty, skip to the FINAL RESPONSE step immediately — do NOT call gmail_search_threads " +
      "again, ever.\n\n" +
      "STEP 2 — for EACH thread T in the threads array (process them in order, then move on; " +
      "do not revisit a thread), perform exactly three tool calls:\n\n" +
      "  2a. gmail_get_thread with:\n" +
      "      thread_id: <the literal string from T.thread_id — pass the raw value, NEVER wrap " +
      "      it in extra quotes>\n" +
      "  From the response, extract the most recent message's Subject, From, and Date headers " +
      "and its snippet.\n\n" +
      "  2b. gmail_create_draft with:\n" +
      "      to: <From header of the most recent message; if it is in the form \"Name <addr>\", " +
      "      use only the addr part>\n" +
      "      subject: if the original Subject already begins with \"ECHO:\" use it verbatim, " +
      "      otherwise prepend \"ECHO: \" to it\n" +
      "      body: a plain-text echo with this exact shape (literal text, including the leading " +
      "      \"Echo-bot received your message.\" line and the \"--- Original snippet ---\" divider; " +
      "      substitute the actual header values inline):\n" +
      "        Echo-bot received your message.\n\n" +
      "        Original subject: <Subject>\n" +
      "        Original from: <From>\n" +
      "        Original date: <Date>\n\n" +
      "        --- Original snippet ---\n" +
      "        <snippet>\n" +
      "      thread_id: <the literal T.thread_id value, raw, no extra quotes>\n" +
      "  If gmail_create_draft returns success: true, increment DRAFTED by 1.\n\n" +
      "  2c. gmail_label_thread with:\n" +
      "      thread_id: <the literal T.thread_id value, raw, no extra quotes>\n" +
      "      add_labels: [\"bot/echo-bot/processed\"]\n" +
      "      remove_labels: [\"bot/echo-bot\", \"UNREAD\"]\n\n" +
      "FINAL RESPONSE — after STEP 2 has run once for every thread in the original search result " +
      "(or immediately if the search returned zero threads), respond with EXACTLY one line and " +
      "nothing else:\n" +
      "  echo-bot drafted DRAFTED reply(ies)\n" +
      "where DRAFTED is the literal counter value. Do not call any tool after emitting the final " +
      "line.\n\n" +
      "ABSOLUTE RULES:\n" +
      "  (a) Call gmail_search_threads at most once per run — never re-search.\n" +
      "  (b) Never call any send/forward/delete tool. The only delivery tool is gmail_create_draft.\n" +
      "  (c) Never fabricate header values; only use what gmail_get_thread returned.\n" +
      "  (d) When passing thread_id as a tool argument, pass the raw id string returned by the " +
      "      search — do NOT wrap it in additional quote characters and do NOT pass the literal " +
      "      string \"null\".",
    preset: "bot-echo",
    defaultCron: "*/5 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.3 (2026-05-12) — weekly digest tick.
  // bots-sql-mcp now exposes job_candidates_query / job_candidates_score_update
  // / bot_preferences_get; the preset's scout + digest-writer agents reference
  // those tools directly. Enabling this pipeline requires bot_registry.enabled=1
  // for 'job-search' AND a row in `schedules` pointing at 'pipeline:bot:job-search:tick'
  // with cron '0 7 * * MON'.
  "bot:job-search:tick": {
    name: "Bot: job-search weekly tick",
    description:
      "Phase 8 Job Search Bot weekly digest. Runs scout (scores job_candidates against bot_preferences) then digest-writer (composes Mon-morning Gmail draft). Tier-1: drafts only, no sends. Pathway A (ed-jobs ingest) populates job_candidates continuously via mpa-edjobs-sync.timer; this tick is the LLM-driven scoring + delivery step.",
    goal:
      "Today's date is ${TODAY}. Use this for any date you need to write (subject line, body) — " +
      "never invent or infer dates from training data.\n\n" +
      "Single-agent weekly job-search digest. The job-search-worker agent does scoring + " +
      "digest composition in one conversation (multi-agent coordinator-dispatch hangs; see " +
      "presets.js comment).\n\n" +
      "STEP 1 — score the batch. Read bot_preferences once, then job_candidates_query for a " +
      "small batch of status='new' rows (limit set in the agent's prompt; small while we " +
      "iterate, will grow once timing is trusted). Apply the rubric in the agent's prompt and " +
      "call job_candidates_score_update on each row, transitioning to 'shortlisted' or " +
      "'rejected' (or 'applied' for already-applied roles).\n\n" +
      "STEP 2 — send the digest. Pull the shortlist via job_candidates_query({status:'shortlisted'}), " +
      "compose ONE markdown digest grouped into three tiers (≥0.75 / 0.55-0.74 / longshots), " +
      "and call gmail_send_to_self exactly once to kevin.hopper1@gmail.com with subject " +
      "'Job-Search Digest — <Monday date>'. gmail_send_to_self actually delivers (not drafts) " +
      "and renders the markdown as HTML so the user sees a formatted digest in their inbox.\n\n" +
      "ABSOLUTE RULES: (a) gmail_send_to_self is the only delivery tool — the allowlist " +
      "enforces user-bound recipient. Never gmail_send, never gmail_create_draft (the latter " +
      "lands in the bot account's Drafts folder where the user never sees it). (b) Never " +
      "re-pick a row whose employer+role appears in bot_preferences.applied_already; the agent " +
      "marks those as 'applied' on first sight. (c) Always emit exactly one send per tick even " +
      "when the shortlist is empty (a one-line 'no shortlisted candidates this week' email is " +
      "acceptable).",
    preset: "bot-job-search",
    defaultCron: "0 7 * * MON",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.4-A (2026-05-12) — drafter pipeline.
  // Generates Google Docs (resume + cover letter) for shortlisted candidates
  // that don't yet have an application_id. Idempotent — re-running does
  // nothing for already-drafted candidates because the agent filters on
  // application_id IS NULL.
  "bot:job-search:draft-applications": {
    name: "Bot: job-search drafter (Phase 8.4-A)",
    description:
      "Phase 8.4-A drafter. For each shortlisted job_candidates row missing application_id, generates a tailored resume + cover letter Google Doc, records the doc in bot_conversations, and links the candidate. Tier-1 safety: Gmail drafts only, never sends; never invents experience.",
    goal:
      "Today's date is ${TODAY}. Use this for the cover-letter [Date] header — never invent or " +
      "infer dates from training data.\n\n" +
      "Run the application-drafter agent. It will: (1) query shortlisted candidates without an " +
      "application_id, (2) read master-resume.md and relevant tailored variants from the " +
      "jobsearch-notes mirror, (3) for each candidate (up to 3 per tick) generate a Google Doc " +
      "in the 'Job Search Drafts' folder containing a tailored resume + cover letter, (4) " +
      "upsert a bot_conversations row with status='awaiting-user' and the google_doc_id, (5) " +
      "link the candidate via job_candidates_set_application, and (6) emit ONE Gmail draft " +
      "linking to all newly-drafted docs.\n\n" +
      "ABSOLUTE RULES: Drafts only. Never invent experience. Never re-draft the same candidate " +
      "(application_id filter is the contract).",
    preset: "bot-job-search-drafter",
    defaultCron: "30 7 * * MON",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.4-A.5 (2026-05-12) — drafts notifier pipeline.
  // Composes a single Gmail digest naming all newly-drafted application docs.
  // Idempotent — re-running emits nothing if no rows are in current_step='draft-created'.
  "bot:job-search:notify-drafts": {
    name: "Bot: job-search drafts notifier (Phase 8.4-A.5)",
    description:
      "Phase 8.4-A.5. Single-purpose pipeline that emits a Gmail digest naming all bot_conversations rows with status='awaiting-user' AND current_step='draft-created'. Advances each row to current_step='pending-review' with the new gmail_thread_id, so the next notifier run only picks up genuinely-new drafts.",
    goal:
      "Run the drafts-notifier agent. It will: (1) list bot_conversations at status='awaiting-user' " +
      "and current_step='draft-created', (2) compose one markdown digest naming each drafted " +
      "document, (3) call gmail_send_to_self exactly once (which actually delivers to the user's " +
      "inbox with HTML-rendered markdown), (4) patch each conversation to " +
      "current_step='pending-review' with the new gmail_thread_id.\n\n" +
      "ABSOLUTE RULES: One Gmail send per run. Never gmail_send, never gmail_create_draft " +
      "(the allowlist on gmail_send_to_self enforces user-bound recipient). Idempotent — zero " +
      "work if no rows are pending notification.",
    preset: "bot-job-search-notifier",
    defaultCron: "35 7 * * MON",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.4-B (2026-05-12) — reply reader.
  // Scans user replies on draft-digest threads every 15 min. Advances
  // conversations to status='applied' (ready-to-submit) or 'archived'
  // (user-rejected). Idempotent via last_user_msg_at watermark.
  "bot:job-search:process-replies": {
    name: "Bot: job-search reply reader (Phase 8.4-B + Polish #2 tick-digest path)",
    description:
      "Phase 8.4-B reply reader. Polls user replies on BOTH draft-digest threads (current_step='pending-review') and weekly tick-digest threads (current_step='tick-digest'). Parses apply/skip/looks-good on draft threads, parses yes-to/draft/pick on tick threads (sets user_priority). Idempotent: skips messages older than last_user_msg_at.",
    goal:
      "Run the reply-reader agent. It will: (1) list bot_conversations at status='awaiting-user' " +
      "(both pending-review and tick-digest), (2) group by gmail_thread_id and dispatch by " +
      "current_step, (3a) for pending-review threads, parse apply/skip/looks-good and advance " +
      "each matched conversation, clearing application_id + flipping candidate status on skip, " +
      "(3b) for tick-digest threads, parse 'yes to <N|employer>' / 'draft <…>' / 'pick <…>' / " +
      "'top N' and call job_candidates_score_update with user_priority=1 for each resolved " +
      "candidate id (the drafter then picks user-priority rows first next tick).\n\n" +
      "ABSOLUTE RULES: Read-only on Gmail (no draft, no send). Only write conversation state, " +
      "candidate user_priority/match_notes/status. Idempotent — safe to run every 15 min.",
    preset: "bot-job-search-replyreader",
    defaultCron: "*/15 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.4-C (2026-05-12) — comment applier.
  // Polls Google Docs every 15 min for unresolved user comments on 'applied'
  // conversations. Applies inline edits via gdocs_find_replace. Conservative:
  // only acts on comments with explicit quoted context, skips vague requests.
  "bot:job-search:apply-feedback": {
    name: "Bot: job-search comment applier (Phase 8.4-C)",
    description:
      "Phase 8.4-C comment applier. Polls Google Docs for unresolved user comments on the bot's applied draft documents, applies inline edits via find_replace on the highlighted text, replies with a summary, and resolves the comment. Idempotent via comment.resolved + skip-on-bot-reply.",
    goal:
      "Today's date is ${TODAY}. The NOW_ISO timestamp for this run is ${NOW_ISO} — " +
      "use this EXACT string as the value of last_comment_applied_at when you patch " +
      "each conversation in STEP 3c (or in the zero-unit close-the-gate patch). Never " +
      "invent or guess a timestamp.\n\n" +
      "Run the comment-applier agent. It will: (1) list bot_conversations at " +
      "status='applied'. (1.5) GATE — drop rows whose payload.process_comments_requested_at " +
      "is absent or older than payload.last_comment_applied_at. The gate is the user's " +
      "explicit email signal (parsed by the reply-reader's PROCESS-COMMENTS intent); " +
      "comments accumulate freely without it. (2) For each GATE-OPEN row, " +
      "gdocs_list_comments → process each unresolved user comment via Path A (targeted edit " +
      "via gdocs_apply_comment_edit), Path B (question reply + resolve), or Path C " +
      "(rule-application via gdocs_read + gdocs_find_replace batch). (2.5) For each " +
      "GATE-OPEN row, ALSO inspect payload.process_comments_request_body for rule-" +
      "application phrases (e.g. 'rewrite per the rules', 'no em dashes', 'apply the " +
      "writing rules'). If matched, run the email-path version of Path C using the email " +
      "body as the directive — even when zero doc comments exist. (3) For each conversation " +
      "that produced at least one applied unit across step 2 + step 2.5, send ONE " +
      "notification email via gmail_send_to_self threaded on the conversation's " +
      "gmail_thread_id, then patch payload.last_comment_applied_at as the idempotency stamp. " +
      "(3-zero-unit) For each GATE-OPEN conversation that produced ZERO applied units, " +
      "STILL patch payload.last_comment_applied_at (to close the gate) but SKIP the " +
      "notification — without the patch the gate stays open and the agent loops every " +
      "minute.\n\n" +
      "ABSOLUTE RULES: Tool routing — gmail_send_to_self for notifications TO USER " +
      "(allowlist enforces). Never gmail_send, never gmail_create_draft. Path A edits stay " +
      "inside the user's highlighted text; Path C and STEP 2.5 apply rules globally via " +
      "find_replace batches. GATE-CLOSED rows are skipped silently (no list_comments, no " +
      "patch). Idempotent: re-runs on the same Doc skip comments the bot already replied to " +
      "(skip-on-bot-reply check at top of step 2).",
    preset: "bot-job-search-commentapplier",
    defaultCron: "*/15 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.4-D (2026-05-12) — finalizer.
  // Emits a 'ready to submit' Gmail digest for each batch of approved-but-
  // not-finalized conversations and advances state. PDF rendering deferred
  // to 8.5; tracker file mutation (applications-2026-summer.md on grackle)
  // deferred to 8.7. Idempotent via current_step='ready-to-submit' filter.
  "bot:job-search:finalize": {
    name: "Bot: job-search finalizer (Phase 8.4-D)",
    description:
      "Phase 8.4-D finalizer. Picks up bot_conversations at status='applied' AND current_step='ready-to-submit' (set by reply-parser). Emits one Gmail digest with a copy-paste tracker row per row, transitions each conversation to current_step='finalized', and sets job_candidates.status='applied'. Idempotent.",
    goal:
      "Today's date is ${TODAY}. Use this exact YYYY-MM-DD value in every tracker row and in " +
      "match_notes — never invent or infer dates.\n\n" +
      "Run the application-finalizer agent. It will: (1) list bot_conversations ready to " +
      "finalize, (2) emit a single 'Ready to submit' Gmail draft listing each application with " +
      "a copy-paste tracker row, (3) patch each conversation to current_step='finalized' and " +
      "set job_candidates.status='applied'. PDF rendering and grackle-side tracker append are " +
      "out of scope (Phases 8.5 and 8.7 respectively).\n\n" +
      "ABSOLUTE RULES: One Gmail draft per run. Never gmail_send. Atomic per-row " +
      "(bot_conversations + job_candidates both updated).",
    preset: "bot-job-search-finalizer",
    defaultCron: "*/15 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.6 (2026-05-12) — ATS application-questions intelligence.
  // For each finalized application, detects the ATS platform from the posting
  // URL and emits a Gmail reply with ready-to-paste answers to the platform's
  // typical application questions. Idempotent via payload.ats_qa_drafted_at.
  // Threads on the row's existing gmail_thread_id (the notifier's thread).
  "bot:job-search:platform-prep": {
    name: "Bot: job-search ATS platform-prep (Phase 8.6)",
    description:
      "Phase 8.6 ATS Q&A drafter. Picks up bot_conversations at current_step='finalized' AND payload.ats_qa_drafted_at IS NULL. Detects the ATS platform (TEDK12, Workday, Greenhouse, etc.) from row.payload.url via ats_platforms.json substring matching, generates ready-to-paste answers per the registry's question set, and drafts a Gmail reply on the existing thread. Idempotent via payload.ats_qa_drafted_at stamp.",
    goal:
      "Today's date is ${TODAY}. The NOW_ISO timestamp for this run is ${NOW_ISO} — " +
      "use this EXACT string as the value of ats_qa_drafted_at when you patch each " +
      "conversation in STEP 7. Never invent or guess a timestamp.\n\n" +
      "Run the platform-prep agent. It will: (1) list finalized bot_conversations whose " +
      "payload.ats_qa_drafted_at is still null, (2) detect the ATS platform for each from the " +
      "embedded ats_platforms.json registry, (3) call gdocs_read per row to fetch the " +
      "drafted cover-letter content for grounding, (4) compose ONE Gmail digest threaded " +
      "on the row's gmail_thread_id with platform-specific Q&A per row, (5) patch each row " +
      "with payload.ats_qa_drafted_at + ats_platform as idempotency stamps.\n\n" +
      "ABSOLUTE RULES: One Gmail send per run, and it MUST be threaded (pass thread_id " +
      "to gmail_send_to_self). Never gmail_send, never gmail_create_draft, never " +
      "gmail_create_threaded_reply (the latter two still draft and would not appear in " +
      "the user's inbox). Status/current_step are NOT changed — this is post-finalize " +
      "enrichment. Idempotent — zero work if no rows lack ats_qa_drafted_at.",
    preset: "bot-job-search-platform-prep",
    defaultCron: "*/15 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 8.6.B (2026-05-12) — Post-finalize completion acknowledgment.
  // For each bot_conversations row that has reached current_step='finalized'
  // AND has both payload.pdf_rendered_at and payload.ats_qa_drafted_at
  // stamped (meaning every downstream step — finalizer, PDF render, and
  // ATS Q&A draft — has completed), emits a single Gmail digest summarizing
  // the artifacts produced and threaded on the existing application thread.
  // Idempotent via payload.ack_emailed_at.
  "bot:job-search:ack-complete": {
    name: "Bot: job-search completion ack (Phase 8.6.B)",
    description:
      "Phase 8.6.B completion-acknowledgment. Picks up bot_conversations at current_step='finalized' where both payload.pdf_rendered_at and payload.ats_qa_drafted_at are stamped AND payload.ack_emailed_at is still null. Drafts a single Gmail digest threaded on the application's existing gmail_thread_id summarizing the source Doc, PDFs, tracker append, and ATS Q&A draft. Idempotent via payload.ack_emailed_at stamp.",
    goal:
      "Today's date is ${TODAY}. The NOW_ISO timestamp for this run is ${NOW_ISO} — " +
      "use this EXACT string as the value of ack_emailed_at when you patch each " +
      "conversation in STEP 4. Never invent or guess a timestamp.\n\n" +
      "Run the ack-complete agent. It will: (1) list finalized bot_conversations and " +
      "filter to those where pdf_rendered_at + ats_qa_drafted_at are present but " +
      "ack_emailed_at is null, (2) compose ONE Gmail digest summarizing the artifacts " +
      "for each row, (3) post it threaded on the first row's gmail_thread_id, (4) patch " +
      "each row with payload.ack_emailed_at as the idempotency stamp.\n\n" +
      "ABSOLUTE RULES: One Gmail send per run, and it MUST be threaded (gmail_send_to_self " +
      "with thread_id). Never gmail_send, never gmail_create_draft, never " +
      "gmail_create_threaded_reply (the latter two still draft and would not appear in the " +
      "user's inbox). Status/current_step are NOT changed — this is a notification, not a " +
      "state transition. Idempotent — zero work if no rows lack ack_emailed_at.",
    preset: "bot-job-search-ack-complete",
    defaultCron: "*/15 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 9.3 (2026-05-13) — natural-language refine-search.
  // Polls every 15 min for refine-request rows the reply-reader has written
  // (status='pending', current_step='refine-request'). For each: interprets
  // the user's natural-language refine_text into a parameterized
  // job_candidates_query, runs it, and SENDS a refined digest via
  // gmail_send_to_self threaded on the user's reply thread. Lets the user
  // iteratively narrow / broaden the candidate pool until they find roles
  // they want to apply for.
  "bot:job-search:refine-search": {
    name: "Bot: job-search refine search (Phase 9.3)",
    description:
      "Phase 9.3 refine-search. Polls bot_conversations at status='pending' AND current_step='refine-request' (written by the reply-reader when it detects a non-PICK reply on a tick-digest thread). Interprets the natural-language refine_text into job_candidates_query parameters, runs the query, and SENDS a refined digest via gmail_send_to_self threaded on the original reply. Lets the user iteratively narrow / broaden the candidate pool via plain email replies until they find roles to apply for.",
    goal:
      "Today's date is ${TODAY}. The NOW_ISO timestamp for this run is ${NOW_ISO} — use " +
      "this EXACT string as the value of fulfilled_at when you patch each refine-request " +
      "row in PHASE 7. Never invent or guess a timestamp.\n\n" +
      "Run the refine-search-worker agent. It will: (1) list pending refine-request rows " +
      "(up to 5), (2) interpret each row's natural-language refine_text into query " +
      "parameters (employer, title_includes, min_score, limit, etc.), (3) run " +
      "job_candidates_query, (4) compose a numbered digest of matching postings, (5) SEND " +
      "the digest threaded on the user's reply via gmail_send_to_self, (6) upsert a new " +
      "tick-digest-style bot_conversations row with the refined shortlist so the " +
      "reply-reader can resolve numeric picks ('draft 1, 3') against the refined results, " +
      "(7) mark the refine-request row as fulfilled.\n\n" +
      "ABSOLUTE RULES: (a) gmail_send_to_self is the only delivery tool — the allowlist " +
      "enforces user-bound recipient. Never gmail_send, never gmail_create_draft. (b) " +
      "job_candidates is READ-ONLY for this pipeline; never write to it. (c) Exactly one " +
      "Gmail send per refine-request row. (d) If the query returns 0 rows, send a " +
      "'no matches' digest explaining the interpreted filters so the user can adjust.",
    preset: "bot-job-search-refine",
    defaultCron: "*/15 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 9.4 (2026-05-13) — PIR conversational layer.
  // Polls every 15 min for user replies on PIR digest threads
  // (bot_conversations rows at bot_id='pir-tracker', status='awaiting-user',
  // current_step='tick-digest'). Parses commands like 'mark received 2503540',
  // 'draft follow-up for HARM-PPE-2', 'what's the status of 2504156?' and
  // either executes bounded actions (status update via pir_update_state) or
  // composes a Q&A reply via gmail_send_to_self. Follow-up emails TO PIR
  // senders stay as drafts (gmail_create_draft).
  "bot:pir-tracker:converse": {
    name: "Bot: pir-tracker conversational layer (Phase 9.4)",
    description:
      "Phase 9.4 PIR conversational layer. Polls user replies on PIR digest threads every 15 min. Parses natural-language commands (mark received, withdraw, draft follow-up) or questions (show me status, list PIRs by recipient) and either executes bounded pir_update_state actions or composes a contextualized Q&A reply via gmail_send_to_self threaded on the digest. Follow-up drafts TO PIR senders stay as gmail_create_draft.",
    goal:
      "Today's date is ${TODAY}. The NOW_ISO timestamp for this run is ${NOW_ISO}.\n\n" +
      "Run the pir-converse-worker agent. It will: (1) list pir-tracker digest rows at " +
      "status='awaiting-user' / current_step='tick-digest', (2) for each, fetch the Gmail " +
      "thread and walk new inbound messages since row.last_user_msg_at, (3) parse each " +
      "message's intent — status update / follow-up draft / status query / list / unparseable, " +
      "(4) execute the action (pir_update_state for status changes, gmail_create_draft for " +
      "follow-up drafts TO TEA/districts, gmail_send_to_self for Q&A replies TO the user), " +
      "(5) update each digest row's last_user_msg_at watermark.\n\n" +
      "ABSOLUTE RULES: (a) Tool routing by recipient — gmail_send_to_self for user replies, " +
      "gmail_create_draft for PIR senders, never gmail_send. (b) pir_update_state is the " +
      "only mutator of pir_requests; all five Step 2.5 checklist fields must be restated on " +
      "every call. (c) Never auto-advance status to 'received' without explicit user command. " +
      "(d) Idempotent: re-runs on the same thread skip messages older than last_user_msg_at.",
    preset: "bot-pir-tracker-converse",
    defaultCron: "*/15 * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 9.1 (2026-05-13) — PIR Tracker Bot daily tick.
  // Pairs with the bot-pir-tracker preset. Triggered by a row in the
  // schedules table at cron '0 7 * * *' (daily 7am CDT). The Gmail
  // attachment-ingest helper (mpa-pir-response-sync.timer, every 30 min on
  // crow) populates bot_conversations rows that this tick consumes.
  "bot:pir-tracker:tick": {
    name: "Bot: pir-tracker daily tick",
    description:
      "Phase 9.1 PIR Tracker Bot daily 7am tick. Lists active PIRs, drafts a polite follow-up Gmail per overdue row (and stamps next_followup_date = today + 5 business days via pir_update_state), summarizes attachment-ingest results since the last tick, and SENDS one markdown digest to kevin.hopper1@gmail.com via gmail_send_to_self (renders markdown as HTML in the user's inbox). Follow-up drafts to PIR senders stay drafts. Single-agent, Tier-1: drafts for external recipients, sends only for the user-bound digest. Mutates pir_requests only via pir_update_state (Step 2.5 checklist enforced at the tool boundary).",
    goal:
      "Today's date is ${TODAY}. The NOW_ISO timestamp for this run is ${NOW_ISO} — " +
      "use this EXACT string as the value of digested_at when you patch each ingested " +
      "conversation in PHASE 3. Use ${TODAY} verbatim in the digest subject line and in " +
      "any 'today' wording in the body. Never invent or guess dates.\n\n" +
      "Run the pir-tracker-worker agent through its four phases:\n" +
      "  PHASE 1 — pir_list_active (no args). Build a mental inventory of the active queue.\n" +
      "  PHASE 2 — pir_list_overdue (defaults to today UTC). For each overdue row, draft " +
      "ONE polite follow-up via gmail_create_draft (addressed to the PIR recipient — TEA, " +
      "ISD, etc. — drafts only, never sent), then call pir_update_state with all five " +
      "mandatory checklist fields explicitly restated and next_followup_date set to today " +
      "+ 5 business days.\n" +
      "  PHASE 3 — bot_conversations_list_by_status({bot_id:'pir-tracker', " +
      "status:'awaiting-user', current_step:'response-arrived'}). Summarize for the " +
      "digest, then bot_conversations_patch each to current_step='digest-included' with " +
      "payload_merge:true and payload.digested_at=${NOW_ISO}.\n" +
      "  PHASE 4 — compose and gmail_send_to_self ONE markdown digest to " +
      "kevin.hopper1@gmail.com, subject 'PIR Tracker Digest — ${TODAY}'. The send_to_self " +
      "path actually delivers (not a draft) and renders markdown as HTML so the user gets " +
      "a formatted digest in their inbox. Sections are skipped when empty.\n\n" +
      "ABSOLUTE RULES: (a) Tool routing by recipient: gmail_send_to_self for the user's " +
      "digest (kevin.hopper1@gmail.com only — allowlist enforces this); gmail_create_draft " +
      "for PIR follow-ups (TEA, ISDs, AG, etc. — drafts only, NEVER auto-sent). Never call " +
      "gmail_send. (b) pir_update_state is the only tool that mutates pir_requests; raw " +
      "SQL is not in the tool list anyway. (c) Never auto-advance status to 'received' or " +
      "'partial' when attachments arrive — surface as TODO in the digest. (d) Don't " +
      "propose specific data-load SQL or TEA cross-references in the draft content — flag " +
      "the human work in the digest TODOs.",
    preset: "bot-pir-tracker",
    defaultCron: "0 7 * * *",
    storeResult: false,
    resultCategory: null,
  },
  // Phase 3 (2026-05-14) — Email router freeform improvise pipeline.
  // Picks up bot_conversations rows where bot_id='router', status='awaiting-improvise',
  // current_step='queued' (written by ~/crow/scripts/bots/router_dispatch.mjs when an
  // inbound email at kevin.hopper+bot@maestro.press doesn't match a known intent).
  // Runs the bot-router-improvise preset, which has broad tool access (job_candidates_query,
  // pir_list_active, bots_sql_query, gmail_send_threaded_to_self) and figures out what the
  // user wants based on the latest message body, then replies threaded.
  "bot:router:improvise": {
    name: "Bot: router improvise (Phase 3)",
    description:
      "Phase 3 freeform email-router agent. Reads bot_conversations rows queued by the router script when the inbound email didn't match a known intent, interprets the request, takes action(s), and replies threaded via gmail_send_threaded_to_self.",
    goal:
      "Today's date is ${TODAY}. The NOW_ISO timestamp for this run is ${NOW_ISO}.\n\n" +
      "Run the router-improvise-worker agent. It will: (1) list bot_conversations at " +
      "bot_id='router', current_step='queued' (limit 5), (2) for each row, read " +
      "payload.body to understand the user's request, (3) take appropriate action(s) using " +
      "the available read-only tools (job_candidates_query, pir_list_*, etc.), (4) send a " +
      "threaded reply via gmail_send_threaded_to_self summarizing what the bot did or " +
      "answering the user's question, (5) patch the row to status='completed' / " +
      "current_step='completed' (payload_merge:true).\n\n" +
      "ABSOLUTE RULES: (a) gmail_send_threaded_to_self is the only delivery tool — never " +
      "gmail_send, never gmail_create_draft (external email is always Tier-1 drafts in " +
      "this lab; the router only emails the user). (b) READ-ONLY on every DB table; never " +
      "mutate job_candidates, pir_requests, or any other bot table. The only write is the " +
      "bot_conversations_patch at the end. (c) If the request asks for an action the bot " +
      "can't take (send external email, run a destructive op, etc.), respond with a clear " +
      "explanation of why and what the user should do instead. (d) Keep replies concise: " +
      "150-400 words for a typical answer; lists/tables only when listing >3 items.",
    preset: "bot-router-improvise",
    defaultCron: "* * * * *",
    storeResult: false,
    resultCategory: null,
  },

  // Phase 2 (2026-05-15) — mpa-tasks bidirectional task-assistant: inbound
  // converse handler. Picks up bot_conversations rows written by
  // router_dispatch.mjs (bot_id='mpa-tasks', current_step='queued') for
  // list-management / "take task N" requests. Single-agent (coordinator-
  // dispatch hangs). Terminal current_step leaves 'queued' (rev 2) so the
  // every-minute selector does not reprocess — mirrors bot:router:improvise.
  "bot:mpa-tasks:converse": {
    name: "MPA Tasks: Converse",
    description:
      "Bidirectional task-assistant inbound handler. Every minute, processes queued mpa-tasks conversation rows: CRUD the Maestro-Press task list via the tasks_* tools, answer list questions, and when the user asks the bot to TAKE a task, flag it for the work pipeline. Single-agent (coordinator-dispatch hangs — see feedback_mpa_orchestrator_single_agent_required). Tier: reads + tasks_* writes + user-bound threaded replies only; NEVER sends external email, NEVER marks a task done autonomously.",
    goal:
      "The NOW_ISO timestamp for this run is ${NOW_ISO}. Process queued mpa-tasks " +
      "conversations by making tool calls in order. Do not describe what you would " +
      "do — actually call every tool.\n\n" +
      "PHASE 1 — LIST. Call bot_conversations_list_by_status EXACTLY ONCE with " +
      "bot_id='mpa-tasks', current_step='queued', limit=5. If count=0, output " +
      "'No queued mpa-tasks requests' and STOP.\n\n" +
      "PHASE 2 — For each row: read row.payload.body (strip lines starting with " +
      "'>'). Call gmail_get_thread(row.gmail_thread_id) ONCE; the LATEST message " +
      "not from kevin.hopper@maestro.press is the user's current request.\n\n" +
      "PHASE 3 — Classify the request into ONE action and execute it against the " +
      "tasks list (the tasks_* tools operate on the live to-do list):\n" +
      "  LIST/QUERY ('what's on my list', 'show overdue', 'what's due this week') " +
      "→ tasks_list (status default 'open'; use overdue=true or due_within_days=N " +
      "as asked). Summarize the returned items as a numbered markdown list " +
      "(id, title, priority, due_date, status).\n" +
      "  CREATE ('add a task …', 'create a task …') → tasks_create with title " +
      "(required) and any due_date (YYYY-MM-DD), priority (1-5), tags the user " +
      "stated. Confirm with the new task id.\n" +
      "  UPDATE ('reschedule task N', 'change priority of N', 'retag N', 'rename " +
      "N') → tasks_update({id:N, …only the changed fields}).\n" +
      "  COMPLETE ('mark N done', 'close N', 'finished N') → tasks_complete({id:N}). " +
      "(This is USER-DIRECTED completion and is allowed; the bot still never marks " +
      "a task done on its OWN initiative.)\n" +
      "  REOPEN ('reopen N') → tasks_reopen({id:N}).\n" +
      "  SUBTASK ('add a subtask under N: …') → tasks_add_subtask({parent_id:N, " +
      "title:…}).\n" +
      "  TAKE ('take task N', 'work on N', 'you do N', 'research N and write it " +
      "up', 'draft N for me') → DO NOT do the work now. Call bot_conversations_patch " +
      "with DOUBLE-QUOTED JSON:\n" +
      "    bot_conversations_patch({\n" +
      "      \"id\": row.id,\n" +
      "      \"current_step\": \"awaiting-work\",\n" +
      "      \"payload_merge\": true,\n" +
      "      \"payload\": { \"work_task_id\": N, \"work_requested_at\": \"${NOW_ISO}\" }\n" +
      "    })\n" +
      "  then reply (next phase) that you've queued task N and will follow up on " +
      "this thread when the artifact is ready.\n" +
      "  AMBIGUOUS / not a task request → reply asking the user to clarify, listing " +
      "the actions you support.\n\n" +
      "PHASE 4 — REPLY. Call gmail_send_threaded_to_self with EXACTLY these args: " +
      "to='kevin.hopper1@gmail.com' (REQUIRED — the user's allowlisted self " +
      "address), subject = the inbound thread's Subject (or 'Re: your task " +
      "request' if the Subject is empty), thread_id = row.gmail_thread_id " +
      "(REQUIRED — sourced from the row's TOP-LEVEL gmail_thread_id field, NOT " +
      "payload), and body = a concise markdown statement of exactly what you did " +
      "(ids affected, the list if asked, or the queued-task confirmation). One " +
      "reply per row.\n\n" +
      "PHASE 5 — CLOSE. For every row you fully handled INLINE (everything except " +
      "TAKE), call bot_conversations_patch({\"id\": row.id, \"status\": \"idle\", " +
      "\"current_step\": \"completed\"}) — current_step MUST leave 'queued' or the " +
      "every-minute loop reprocesses it forever. For TAKE rows leave status and " +
      "current_step exactly as set in PHASE 3 (current_step='awaiting-work'). Then " +
      "output a one-line summary per row.",
    preset: "bot-mpa-tasks-converse",
    defaultCron: "* * * * *",
    storeResult: false,
    resultCategory: null,
  },
};
