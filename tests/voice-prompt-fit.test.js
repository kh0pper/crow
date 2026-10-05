import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  estimatePromptTokens, requestFits, turnReserveTokens, choosePromptFit, dropOldestExchange,
  PROMPT_MARGIN_TOKENS, MIN_COMPLETION_TOKENS, TURN_RESERVE_MAX_TOKENS,
} from "../servers/gateway/voice/prompt-fit.js";

const sys = (chars) => "p".repeat(chars);
const TOOLS = [{ name: "crow_wm", description: "show", inputSchema: { type: "object" } }];

test("estimatePromptTokens: serialized messages + tools at 3.2 chars per token, rounded up", () => {
  const messages = [{ role: "system", content: "abc" }];
  const chars = JSON.stringify(messages).length + JSON.stringify(TOOLS).length;
  assert.equal(estimatePromptTokens(messages, TOOLS), Math.ceil(chars / 3.2));
  assert.equal(estimatePromptTokens(messages), Math.ceil((JSON.stringify(messages).length + 2) / 3.2), "no tools = an empty list");
});

test("requestFits: prompt + margin + the smallest completion must be inside the context; an unknown context always fits", () => {
  const need = PROMPT_MARGIN_TOKENS + MIN_COMPLETION_TOKENS;
  assert.equal(requestFits(8192 - need, 8192), true);
  assert.equal(requestFits(8192 - need + 1, 8192), false);
  assert.equal(requestFits(41140, 8192), false, "the reported turn: 41,140 prompt tokens against 8,192");
  assert.equal(requestFits(41140, null), true);
  assert.equal(requestFits(41140, undefined), true);
});

test("turnReserveTokens: an eighth of the context, at most 1,024, never under margin + smallest completion", () => {
  assert.equal(turnReserveTokens(8192), 1024);
  assert.equal(turnReserveTokens(32768), TURN_RESERVE_MAX_TOKENS);
  assert.equal(turnReserveTokens(4096), 512);
  assert.equal(turnReserveTokens(500), PROMPT_MARGIN_TOKENS + MIN_COMPLETION_TOKENS);
});

test("choosePromptFit: full when it fits (the lean prompt is never built); unknown context is always full", async () => {
  let leanCalls = 0;
  const lean = async () => { leanCalls++; return "lean"; };
  const fit = await choosePromptFit({ ctx: 8192, tools: TOOLS, full: sys(2000), lean });
  assert.equal(fit.level, "full");
  assert.equal(fit.system, sys(2000));
  assert.equal(fit.est, estimatePromptTokens([{ role: "system", content: sys(2000) }], TOOLS));
  assert.equal(fit.reserve, 1024);
  const unknown = await choosePromptFit({ ctx: null, tools: TOOLS, full: sys(500_000), lean });
  assert.equal(unknown.level, "full");
  assert.equal(unknown.ctx, null);
  assert.equal(leanCalls, 0);
});

test("choosePromptFit: no_skills when only the lean prompt fits; too_large when neither does; the boundary is exact", async () => {
  // ~35.7k tokens of skills (the reported bot) on an 8,192 context.
  const full = sys(114_000);
  const ok = await choosePromptFit({ ctx: 8192, tools: TOOLS, full, lean: () => sys(6000) });
  assert.equal(ok.level, "no_skills");
  assert.equal(ok.system, sys(6000));
  assert.ok(ok.est > 8192 && ok.est_no_skills + ok.reserve <= 8192);
  const big = await choosePromptFit({ ctx: 8192, tools: TOOLS, full, lean: () => sys(60_000) });
  assert.equal(big.level, "too_large");
  assert.ok(big.est_no_skills + big.reserve > 8192);
  // Boundary: est + reserve == ctx fits; one token more does not.
  const base = estimatePromptTokens([{ role: "system", content: "" }], TOOLS);
  const exact = (8192 - 1024 - base) * 3.2;
  const at = await choosePromptFit({ ctx: 8192, tools: TOOLS, full: sys(Math.floor(exact)), lean: () => "" });
  assert.equal(at.level, "full");
  assert.ok(at.est + at.reserve <= 8192);
  const over = await choosePromptFit({ ctx: 8192, tools: TOOLS, full: sys(Math.floor(exact) + 8), lean: () => sys(Math.floor(exact) + 8) });
  assert.equal(over.level, "too_large");
});

test("dropOldestExchange: removes the oldest user message and everything up to the next one; never the system or the current turn", () => {
  const cur = { role: "user", content: "now" };
  const messages = [
    { role: "system", content: "S" },
    { role: "user", content: "q1" }, { role: "assistant", content: "", tool_calls: "[]" }, { role: "tool", content: "r" }, { role: "assistant", content: "a1" },
    { role: "user", content: "q2" }, { role: "assistant", content: "a2" },
    cur,
    { role: "assistant", content: "", tool_calls: "[]" }, { role: "tool", content: "this turn" },
  ];
  assert.equal(dropOldestExchange(messages, cur), 4);
  assert.deepEqual(messages.map((m) => m.content), ["S", "q2", "a2", "now", "", "this turn"]);
  assert.equal(dropOldestExchange(messages, cur), 2);
  assert.deepEqual(messages.map((m) => m.content), ["S", "now", "", "this turn"]);
  assert.equal(dropOldestExchange(messages, cur), 0, "no history left: nothing is dropped");
  assert.equal(messages.length, 4);
  assert.equal(dropOldestExchange([{ role: "system", content: "S" }, { role: "user", content: "x" }], { role: "user", content: "x" }), 0, "an unknown current message drops nothing");
});

test("generateSystemPrompt({ botDef, omitSkills }): the persona and everything else stay, the skill bodies go (REAL generator)", async () => {
  const home = mkdtempSync(join(tmpdir(), "crow-fit-"));
  const prior = process.env.CROW_HOME;
  process.env.CROW_HOME = home;
  try {
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "fit-test-skill-zq.md"), "# Fit test skill\nSKILL-BODY-MARKER " + "x".repeat(4000));
    const { generateSystemPrompt } = await import("../servers/gateway/ai/system-prompt.js");
    const botDef = { bot_id: "general", system_prompt: "You are a general assistant.", skills: ["fit-test-skill-zq"] };
    const full = await generateSystemPrompt({ botDef, customPrompt: "Be brief." });
    assert.match(full, /SKILL-BODY-MARKER/);
    const lean = await generateSystemPrompt({ botDef, customPrompt: "Be brief.", omitSkills: true });
    assert.doesNotMatch(lean, /SKILL-BODY-MARKER|Fit test skill/);
    assert.match(lean, /^You are a general assistant\./);
    assert.match(lean, /## Custom Instructions\nBe brief\.$/);
    assert.ok(full.length - lean.length > 4000);
    assert.equal(await generateSystemPrompt({ botDef, omitSkills: true }), await generateSystemPrompt({ botDef, omitSkills: true }), "byte-stable");
    assert.equal(await generateSystemPrompt({ botDef, deviceId: "d1", omitSkills: false }), await generateSystemPrompt({ botDef, deviceId: "d1" }), "default keeps the skills (glasses unchanged)");
  } finally {
    if (prior === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  }
});
