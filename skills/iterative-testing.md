---
name: iterative-testing
description: Iterative prompt-and-record testing — run test plans on remote AI clients (Claude.ai, ChatGPT, etc.), record results, and plan fixes
triggers:
  - test round
  - run tests
  - iterative testing
  - test on claude.ai
  - test on chatgpt
  - remote client testing
  - test the gates
  - test confirmation
tools:
  - crow-memory
---

# Iterative Testing

## When to Activate

- User wants to test Crow tools on a remote AI client (Claude.ai, ChatGPT, Gemini, etc.)
- User says "run test round", "test on Claude.ai", "let's test the gates"
- User wants to run a structured test plan with pass/fail tracking
- Any manual test cycle where prompts are given, results collected, and fixes planned

## Automated Testing (Claude.ai)

For Claude.ai testing, an automated runner is available:

```bash
# Run a specific test plan
node scripts/test-claude-ai.js tests/claude-ai/confirm-gates.json

# Run all test plans in the directory
node scripts/test-claude-ai.js tests/claude-ai/

# With options
node scripts/test-claude-ai.js tests/claude-ai/confirm-gates.json \
  --port 9223 --timeout 60000 --delay 3000
```

**Prerequisites:** Export Claude.ai session cookies to `~/.crow/claude-ai-cookie.json` (see script `--help` for format).

**Results** are saved as timestamped JSON in `tests/claude-ai/results/`. When starting a test round, check for recent automated results there before falling back to manual testing.

## Overview

This skill manages a structured test loop:

1. **Define** — Build or load a test plan (prompts + expected behavior)
2. **Run** — Feed prompts to the user one at a time; user runs them on the remote client and reports back (or use automated runner for Claude.ai)
3. **Record** — Log each result (pass/fail/partial, notes, raw response excerpts)
4. **Analyze** — After all tests, summarize results and plan fixes for failures

The skill is platform-agnostic — it works for any remote AI client where you can't run tests programmatically. For Claude.ai specifically, use the automated runner (`node scripts/test-claude-ai.js`) when possible.

## Workflow

### Phase 0 — Check for Automated Results

Before starting manual testing, check for recent automated results:

1. Look in `tests/claude-ai/results/` for JSON files matching the feature being tested
2. If results exist from today or recently, load them and skip to Phase 4 (Analyze)
3. If no results exist, suggest running the automated runner first (for Claude.ai) or proceed with manual testing

### Phase 1 — Define the Test Plan

Ask the user or derive from context:

1. **What are we testing?** — Feature name, PR, or change description
2. **Which client?** — Claude.ai, ChatGPT, Gemini, etc.
3. **Test prompts** — Numbered list of exact prompts to give the remote client
4. **Expected behavior** — What should happen for each prompt (pass criteria)

If a test plan already exists (from a plan document or prior round), load it. Don't make the user repeat themselves.

Format the plan as a numbered checklist:

```
Test Plan: [Feature] — Round N on [Client]

1. Prompt: "[exact text]"
   Expected: [what should happen]

2. Prompt: "[exact text]"
   Expected: [what should happen]
```

**[crow checkpoint: Test plan ready (N tests on [client]). Say "go" to start, or edit any test first.]**

### Phase 2 — Run Tests

For each test, present:

```
--- Test N/Total ---
Prompt to give [client]:

  [exact prompt text]

Expected: [what should happen]

Paste the response (or describe what happened) when ready.
```

Wait for the user to report the result. Do not move to the next test until the current one is recorded.

### Phase 3 — Record Results

When the user reports back, classify the result:

| Result | Meaning |
|--------|---------|
| **PASS** | Behavior matches expected outcome |
| **FAIL** | Behavior does not match — the client ignored the gate/guardrail |
| **PARTIAL** | Some expected behavior observed but not fully correct |

Record for each test:
- Result (pass/fail/partial)
- What actually happened (brief)
- Raw response excerpt if the user provides one
- Any notes

Show a running tally after each result:

```
Recorded: Test N — [PASS/FAIL/PARTIAL]
Progress: X/Y complete (P pass, F fail, A partial)
```

### Phase 4 — Analyze & Plan

After all tests are complete, produce a summary:

```
## Test Results: [Feature] — Round N

Client: [client]
Date: [date]
Results: P pass / F fail / A partial out of Y total

### Results Table

| # | Prompt | Expected | Result | Notes |
|---|--------|----------|--------|-------|
| 1 | "..." | ... | PASS | ... |
| 2 | "..." | ... | FAIL | ... |

### Failures Analysis
[For each failure, explain what went wrong and potential fixes]

### Next Steps
[Recommendations: code changes, description tweaks, another round, etc.]
```

Then:

1. **Store results** in Crow memory:
   - Category: `testing`
   - Tags: `test-results, [feature], round-N, [client]`
   - Importance: 7
   - Content: The full summary table

2. **If failures exist**: Offer to enter plan mode to design fixes
   > **[crow checkpoint: N failures detected. Enter plan mode to design fixes? Or save results and stop here.]**

3. **If all pass**: Celebrate and note the feature is verified on that client

## Multi-Round Tracking

When running follow-up rounds (e.g., Round 4 after fixing Round 3 failures):

1. Check memory for prior round results: `crow_search_memories` with tags `test-results, [feature]`
2. Show what changed since last round (code fixes, description updates, etc.)
3. Focus new tests on prior failures + regression tests for things that passed before
4. Compare results across rounds in the final summary

## Tips

- Keep prompts short and direct — remote clients have their own system prompts that may interfere
- Test one behavior per prompt when possible
- Include at least one "happy path" test (something that should work normally)
- For confirmation gate testing: test both "direct destructive action" and "compound workflow with destructive step"
- If a test is ambiguous (could be pass or fail), mark it PARTIAL and note why
- The user may want to screenshot the remote client — that's fine, just ask them to describe the key behavior

## Transparency

*[crow: activated skill — iterative-testing.md]*

When starting a test round:
*[crow: starting test round N — N tests on [client]]*

When recording results:
*[crow: test N result — [PASS/FAIL/PARTIAL]]*
