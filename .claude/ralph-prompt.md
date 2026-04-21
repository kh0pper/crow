You are iteratively debugging the Claude.ai MCP test automation in ~/crow/.

Read the full plan at ~/.claude/plans/snug-moseying-abelson.md for context.

Each iteration:

1. Kill leftover Chrome: pkill -f 'crow-test-chrome' 2>/dev/null
2. Run: node scripts/test-claude-ai.js tests/claude-ai/confirm-gates.json 2>&1
3. If cookies expired (login page detected), STOP: output <promise>AUTOMATION STABLE</promise> and tell the user to re-export cookies.
4. If automation error: diagnose, make ONE fix, move to next iteration.
5. If clean run (all 4 tests execute without automation crashes/hangs): update tests/claude-ai/results/ralph-progress.json — increment consecutiveCleanRuns. Reset to 0 on any automation failure.
6. When consecutiveCleanRuns reaches 5, output <promise>AUTOMATION STABLE</promise>

A "clean run" = the automation works end-to-end. Test PASS/FAIL verdicts don't matter — only that Chrome launches, navigates, sends prompts, waits, extracts, and saves results without crashing.

Track progress in tests/claude-ai/results/ralph-progress.json with fields: consecutiveCleanRuns, totalIterations, lastError, history[].
