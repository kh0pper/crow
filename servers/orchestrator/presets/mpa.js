// MPA (multi-platform assistant) presets — gmail, outreach, cfp-monitor, memory-review, reliability, prospectus, triage.
export const mpaPresets = {
  "mpa-gmail": {
    description:
      "Single-agent Gmail/Calendar worker for MPA pipelines. Same single-agent pattern as the briefing preset (local crow-chat, avoids coordinator-dispatch issues). Categories include `addons` so the google-workspace tools from ~/.crow-mpa/mcp-addons.json are bridged into the registry. Read-only + write-to-drafts tools only — no send, no delete.",
    categories: ["memory", "addons"],
    provider: "crow-chat",
    agents: [
      {
        name: "gmail-worker",
        systemPrompt:
          "You are a Gmail/Calendar worker for Maestro Press Assistant. Execute the goal exactly, " +
          "calling the listed tools as needed. You MUST invoke tools — do not merely describe what " +
          "you would do. If asked to summarize, call the listed tools first, then produce a short " +
          "summary from the actual returned data. Never fabricate email subjects, senders, or dates.",
        tools: [
          "gmail_search_threads",
          "gmail_get_thread",
          "gmail_list_labels",
          "gmail_label_thread",
          "gmail_archive",
          "gmail_create_draft",
          "gcal_list_calendars",
          "gcal_list_events",
          "gcal_get_event",
          "gcal_create_event",
          "crow_store_memory",
          "crow_create_notification",
        ],
        maxTurns: 10,
      },
    ],
  },

  "mpa-outreach": {
    description:
      "Single-agent outreach drafter for MPA. Finds Gmail threads where Kevin sent the last message a week or more ago with no reply, writes polite follow-up drafts to the Gmail Drafts folder, and stores a summary as an MPA memory. Tier-1 safety: only write action is gmail_create_draft — drafts are NEVER sent automatically; Kevin reviews each one in Gmail Drafts and sends manually.",
    categories: ["memory", "addons"],
    provider: "crow-chat",
    agents: [
      {
        name: "outreach-worker",
        systemPrompt:
          "You are the Maestro Press outreach worker. Execute the goal exactly, calling the listed " +
          "tools in order. You MUST invoke tools — do not merely describe what you would do. " +
          "Safety rules, absolute: (1) You will ONLY create drafts via gmail_create_draft — you " +
          "MUST NEVER send a message. gmail_create_draft leaves the message in the Drafts folder " +
          "for Kevin to review and send manually. (2) Skip any thread where the most recent " +
          "message is NOT from Kevin himself (kevin.hopper@maestro.press or kevin.hopper1@gmail.com " +
          "or derivatives) — if the other side already replied, there is nothing to nudge. " +
          "(3) Skip transactional senders: auto-replies, receipts, invoices, calendar invites, " +
          "newsletters, mailing lists, no-reply addresses, domains like stripe/quickbooks/" +
          "docusign/mailgun/digitalocean/github. (4) Every draft body must be short (under 120 " +
          "words), polite, and reference the thread's actual subject — no generic template prose. " +
          "Never fabricate a prior commitment, quote, or agreement that isn't in the thread.",
        tools: [
          "gmail_search_threads",
          "gmail_get_thread",
          "gmail_create_draft",
          "crow_store_memory",
        ],
        maxTurns: 30,
      },
    ],
  },

  "mpa-cfp-monitor": {
    description:
      "Single-agent conference CFP monitor for MPA. Runs three narrow brave_web_search queries against Maestro Press topics (Texas school finance, AI in K-12, education equity), filters hits for call-for-papers / submission / abstract signals, dedupes against existing tasks by source URL via tasks_search, and creates one new task per fresh hit via tasks_create so the hits live in the tasks panel (and surface through the deadline-watcher automatically). Fires a notification only when at least one NEW task was created. Tier-0 safety: no sends, no external posts; only the tasks addon + notification layer are written.",
    categories: ["memory", "addons"],
    provider: "crow-chat",
    agents: [
      {
        name: "cfp-scout",
        systemPrompt:
          "You are the Maestro Press conference-CFP scout. Execute the goal exactly, calling " +
          "tools in order. You MUST invoke tools — do not merely describe what you would do. " +
          "CRITICAL: emit EXACTLY ONE tool call per response. The orchestrator dispatches " +
          "tools one at a time; never emit multiple <tool_call> blocks in a single message. " +
          "After each tool returns, read its result in the next turn, then emit the next " +
          "single tool call. Be conservative: only surface hits whose title or description " +
          "explicitly mentions one of the CFP signals listed in the goal. Never fabricate a " +
          "URL, title, conference name, or deadline.",
        tools: [
          "brave_web_search",
          "tasks_search",
          "tasks_create",
          "crow_create_notification",
        ],
        maxTurns: 20,
      },
    ],
  },

  "mpa-memory-review": {
    description:
      "Single-agent nightly memory review worker for MPA. Scans recent MPA-tagged memories for duplicates, drift, and consolidation candidates, then stores a single review report memory. Tier-0 safety: deliberately NO crow_update_memory or crow_delete_memory in the allowlist — review-only. Widen the allowlist later once the review reports are reliably actionable.",
    categories: ["memory"],
    provider: "crow-chat",
    agents: [
      {
        name: "memory-reviewer",
        systemPrompt:
          "You are the Maestro Press memory-review worker. Execute the goal exactly, calling " +
          "the listed tools in order. You MUST invoke tools — do not merely describe what you " +
          "would do. You are read-only except for the single crow_store_memory call at the end; " +
          "do NOT attempt to update or delete any memory. Your job is to flag consolidation " +
          "candidates for a human reviewer, not to act on them. Be concrete: every flagged pair " +
          "or cluster must cite specific memory IDs the human can look up. Never fabricate " +
          "memory IDs or contents — only reference what the list/search tools actually returned.",
        tools: [
          "crow_list_memories",
          "crow_search_memories",
          "crow_memory_stats",
          "crow_store_memory",
        ],
        maxTurns: 12,
      },
    ],
  },

  "mpa-reliability": {
    description:
      "Single-agent pipeline reliability tracker for MPA. Nightly, pulls rows from the pipeline_runs table via a small memory-layer query, computes per-pipeline consecutive_clean_runs over the most recent 20 runs, and stores/updates a memory tagged `pipeline_reliability,<name>` per pipeline. When a Tier-1 pipeline hits 10+ consecutive clean runs, flags it for promotion candidacy in the weekly retro. Tier-0 safety: read-only against pipeline_runs, memory write only.",
    categories: ["memory"],
    provider: "crow-chat",
    agents: [
      {
        name: "reliability-tracker",
        systemPrompt:
          "You are the Maestro Press pipeline-reliability tracker. Execute the goal exactly, " +
          "calling tools in order. You MUST invoke tools — do not merely describe what you would " +
          "do. CRITICAL: emit EXACTLY ONE tool call per response. Be conservative: only flag a " +
          "pipeline as promotion-ready if you have 10 consecutive 'completed' entries in the " +
          "most recent pipeline_runs rows you were given. Never fabricate pipeline names or " +
          "counts — only cite what the input data contains.",
        tools: [
          "crow_store_memory",
          "crow_search_memories",
          "crow_update_memory",
          "crow_list_memories",
        ],
        maxTurns: 15,
      },
    ],
  },

  "mpa-prospectus": {
    description:
      "Single-agent consulting prospectus generator for MPA. Pulls one pending prospect from the consulting_pipeline table, fetches district profile + ARC + FSP + STAAR + bond + per-pupil data from the texas-gov-data MCP bundle, drafts a 2-3 page personalized markdown prospectus, and writes it into the prospectus inbox where the systemd render-prospectus.path watcher converts it to PDF. Tier-1 safety: reads are TEA tools + consulting state; writes are consulting_write_prospectus (drops markdown + marks row generated) + crow_store_memory + crow_create_notification. No sends, no external posts.",
    categories: ["memory", "addons", "consulting"],
    provider: "crow-chat",
    agents: [
      {
        name: "prospectus-writer",
        systemPrompt:
          "You are the Maestro Press consulting prospectus writer. Execute the goal exactly, " +
          "calling tools in order. You MUST invoke tools — do not merely describe what you would " +
          "do. CRITICAL: emit EXACTLY ONE tool call per response. The orchestrator dispatches " +
          "tools one at a time; never emit multiple <tool_call> blocks in a single message. " +
          "After each tool returns, read its result in the next turn, then emit the next single " +
          "tool call. Draft the prospectus markdown from the actual TEA data returned by the " +
          "texas-gov-data tools — never fabricate enrollment, ARC percentages, bond totals, " +
          "STAAR scores, or demographic counts. Cite the school year (e.g., SY 2023-2024) for " +
          "every metric. Keep the prospectus 2-3 pages (target 800-1200 words); no marketing " +
          "fluff, no speculative claims. When a district has has_capstone_analysis=1, reference " +
          "the published Maestro Press analysis in one paragraph. The single crow_consulting_" +
          "write_prospectus tool at the end both writes the markdown file and marks the row " +
          "generated — do not call any other write tool for that step.",
        tools: [
          // Consulting pipeline state
          "crow_consulting_list_pending",
          "crow_consulting_get",
          "crow_consulting_write_prospectus",
          // TEA data via the texas-gov-data addon
          "tea_get_district",
          "tea_get_district_demographics",
          "tea_get_arc_factors",
          "tea_get_arc_factors_longitudinal",
          "tea_get_fsp_data",
          "tea_get_fsp_data_longitudinal",
          "tea_get_staar_scores",
          "tea_get_staar_scores_longitudinal",
          "tea_get_per_pupil_expenditure",
          "tea_get_bond_summary",
          "tea_get_accountability_rating",
          "tea_get_graduation_rates",
          "tea_get_idra_equity_profile",
          "tea_get_campuses_in_district",
          // Memory + notification fan-out
          "crow_store_memory",
          "crow_create_notification",
        ],
        maxTurns: 40,
      },
    ],
  },

  "mpa-triage": {
    description:
      "Single-agent Gmail triage worker for MPA. Classifies recent unread threads into action buckets, auto-archives pure noise, and records a compact summary as a memory. Tier-0 safety: only write action is gmail_archive on newsletter-noise threads; no drafts, no sends, no replies.",
    categories: ["memory", "addons"],
    provider: "crow-chat",
    agents: [
      {
        name: "triage-worker",
        systemPrompt:
          "You are the Maestro Press triage worker. Execute the goal exactly, calling the listed " +
          "tools in order. You MUST invoke tools — do not merely describe what you would do. " +
          "Classify each thread using only the subject/from/snippet returned by gmail_search_threads; " +
          "do not call gmail_get_thread unless the goal tells you to. Be conservative: only archive " +
          "a thread if you are highly confident it is newsletter-noise — marketing blasts, digest " +
          "emails, promotional offers, automated platform digests with no action item. When in " +
          "doubt, do NOT archive. Never fabricate subjects, senders, or classifications.",
        tools: [
          "gmail_search_threads",
          "gmail_list_labels",
          "gmail_label_thread",
          "gmail_archive",
          "crow_store_memory",
        ],
        maxTurns: 30,
      },
    ],
  },
};
