#!/usr/bin/env node
/**
 * Kiosk tool-surface evaluation, live. Runs every utterance (cases.mjs and held-out.mjs) through
 * the PRODUCT (product.mjs) against ONE model on an OpenAI-compatible MODEL SERVER, directly —
 * never through a gateway (a gateway may start a model on demand). Sends nothing unless the server
 * already lists the model, and checks again before every utterance.
 *
 *   node scripts/kiosk-eval/run.mjs --base-url=http://127.0.0.1:8000/v1 --model=<id> --label=quick --trials=10 --out=/path/quick.jsonl [--resume]
 *   … --shipped --label=shipped   the display as this release ships it: only the show, window and plain
 *                                 utterances, on a display with no sources, items or media (reported, not gated)
 *
 * For each trial and each utterance the two arms (four tools, one tool) run back to back, in an
 * order that alternates, so a stall or a busy minute falls on both. Every row is appended to --out
 * the moment it exists; --resume skips rows already there. The forcing rule is the product's own
 * (tool-forcing.js reads the server's /models). Sampling is the product's (the voice turn's 0.7).
 *
 * A request that fails (transport error, timeout, a status that is not the product's own tool_choice
 * step-down) is NOT an answer: the turn is retried, up to 3 times, after checking the model is
 * still there. If it still fails, the run stops with exit 4 and no verdict. Exit 3 = the model is
 * not resident (nothing was sent). report.mjs reads the rows.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import createOpenAIAdapter from "../../servers/gateway/ai/adapters/openai.js";
import { createToolForcing } from "../../servers/gateway/voice/tool-forcing.js";
import { CASES, judge } from "./cases.mjs";
import { WM_VERBS } from "../../bundles/kiosk/server/tools.js";
import { HELD_OUT } from "./held-out.mjs";
import { HELD_OUT_R1 } from "./held-out-r1.mjs";
import { HELD_OUT_R2 } from "./held-out-r2.mjs";
import { HELD_OUT_R3 } from "./held-out-r3.mjs";
/** Every spent held-out set (each found a defect; none judges a fix). */
export const SPENT_SETS = Object.freeze([HELD_OUT_R1, HELD_OUT_R2, HELD_OUT_R3]);
import { execFileSync } from "node:child_process";
import { createProductDisplay } from "./product.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MAX_ATTEMPTS = 3;
/** The held-out set is SPENT when it shares any utterance with a spent set (run 1 or run 2). `spent` may be one set or a list of sets. */
export const heldOutSpent = (set = HELD_OUT, spent = SPENT_SETS) => {
  const all = (Array.isArray(spent[0]) ? spent : [spent]).flat();
  return set.length > 0 && set.some((c) => all.some((s) => s.say.trim().toLowerCase() === c.say.trim().toLowerCase()));
};
/** A run writes into a NEW file: an existing non-empty --out is refused unless --resume. → null | the reason. */
export function outGuard(out, resume, { exists = existsSync, read = (f) => readFileSync(f, "utf8") } = {}) {
  if (resume) return null;
  if (exists(out) && read(out).trim()) return `${out} exists and is not empty: a rerun writes into a new directory (or pass --resume to continue this one)`;
  return null;
}
/** An utterance the shipped display can serve: a plain question, a card, or a window verb, with nothing playing. */
export const shippedCase = (c) => !c.state?.playing && [].concat(c.expect || []).every((w) => w.tool === "crow_show" || (w.tool === "crow_wm" && WM_VERBS.includes(w.do)));

/** Read-only: does this server list the model? → { ok, engine } | { ok: false, reason } */
export async function preflight({ baseUrl, model, fetchImpl = fetch }) {
  try {
    const r = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(4000) });
    const hit = r.ok ? ((await r.json()).data || []).find((m) => m && m.id === model) : null;
    return hit ? { ok: true, engine: String(hit.owned_by || "unknown") } : { ok: false, reason: "not_resident" };
  } catch { return { ok: false, reason: "not_resident" }; }
}

/** One utterance on one arm, through the product. make() → a fresh display (createProductDisplay's result). → a row (no key yet). */
export async function runTurn(c, arm, make) {
  const d = make({ surface: arm, state: c.state || {}, lang: c.lang });
  const g = d.gates(c.say);
  const want = [].concat(c.expect || []).map((w) => w.tool);
  const offered_expected = want.every((t) => g.offered.includes(t));
  const fast = (await d.fastPaths(c.say)) !== null;
  // The product would never offer the tool this request needs: that is the product's failure, and no model is asked.
  // ran: false — no turn happened, so nothing ended on a claim; this row counts as wrong and in the held-out offer figure only.
  if (!offered_expected || fast) return { ok: false, ran: false, offered_expected, fast_path: fast, must: g.must !== null, must_done: false, failed: null, tool_choice: null, corrected: false, requests: 0, tools: [], calls: [], errors: [], ms: 0 };
  const r = await d.ask(c.say);
  const done = r.calls.filter((x) => x.result?.ok === true);
  return {
    ok: r.errors.length === 0 && judge(c, r), offered_expected, fast_path: r.fast_path, must: g.must !== null, ran: true,
    // A plain question asked while a window is open, and whether the turn changed the screen anyway (reported).
    window_open: (c.state?.windows?.length || 0) > 0, plain: c.expect === null, changed: done.some((x) => x.result?.effect !== false),
    must_done: g.must !== null && r.failed === null && done.some((x) => x.tool === g.must),
    failed: r.failed, tool_choice: r.tool_choice, corrected: r.corrected, requests: r.requests, tools: r.tools,
    // For reading a wrong turn afterwards. Arguments are cut short; this file stays in the run's own scratch directory.
    calls: r.calls.map((x) => `${x.tool}:${x.result?.outcome || "?"} ${JSON.stringify(x.args).slice(0, 160)}`).concat(r.other.map((n) => `${n}:other`)),
    errors: r.errors, ms: r.ms,
  };
}

/**
 * The whole run for one model. deps: make(opts) → display; check() → preflight result; write(row);
 * done: Set of keys already written; pause(ms). → { rows, aborted? }.
 */
export async function runAll({ sets, trials, make, check, write, done = new Set(), pause = sleep, pauseMs = 250, retryMs = 5000, log = () => {} }) {
  let n = 0;
  for (let trial = 0; trial < trials; trial += 1) for (const [set, list] of sets) for (const [i, c] of list.entries()) {
    const arms = (trial + i) % 2 === 0 ? ["four", "single"] : ["single", "four"];
    const pf = await check();
    if (!pf.ok) return { rows: n, aborted: `the model is no longer listed by its server (before ${c.id}, trial ${trial})` };
    for (const arm of arms) {
      const key = `${trial}|${c.id}|${arm}`;
      if (done.has(key)) continue;
      let row = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        row = await runTurn(c, arm, make);
        if (!row.errors.length) break;
        log(`${key}: request failed (${row.errors[0]}), attempt ${attempt} of ${MAX_ATTEMPTS}`);
        row = null;
        await pause(retryMs);
        if (!(await check()).ok) return { rows: n, aborted: `the model went away during ${key}` };
      }
      if (!row) return { rows: n, aborted: `${key}: the request failed ${MAX_ATTEMPTS} times` };
      write({ key, trial, id: c.id, set, arm, ...row });
      n += 1;
      await pause(pauseMs);
    }
  }
  return { rows: n };
}

async function main() {
  const arg = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.slice(2), "1"] : [a.slice(2, i), a.slice(i + 1)]; }));
  const cfg = { baseUrl: arg["base-url"], model: arg.model };
  if (!cfg.baseUrl || !cfg.model || !arg.out) { console.error("usage: run.mjs --base-url=<model server /v1> --model=<id> --out=<file.jsonl> [--label=quick|larger] [--trials=3] [--ctx=8192] [--pause-ms=250] [--resume]"); process.exit(2); }
  const og = outGuard(arg.out, arg.resume === "1");
  if (og) { console.error(og); process.exit(2); }
  if (heldOutSpent()) { console.error("the held-out set shares utterances with a SPENT set (held-out-r1/-r2/-r3.mjs): write a new one first"); process.exit(2); }
  const pf = await preflight(cfg);
  if (!pf.ok) { console.error(`model ${cfg.model} is not resident at ${cfg.baseUrl}: nothing was sent and nothing was started`); process.exit(3); }
  const label = arg.label || cfg.model;
  const done = new Set();
  if (arg.resume && existsSync(arg.out)) for (const l of readFileSync(arg.out, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); if (r.key) done.add(r.key); }
  else writeFileSync(arg.out, `${JSON.stringify({ header: true, label, model: cfg.model, engine: pf.engine, at: new Date().toISOString(), trials: Number(arg.trials || 3), cases: CASES.length, held_out: HELD_OUT.length, shipped: arg.shipped === "1", run: arg.run || null, head: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })() })}\n`);
  const chat = createOpenAIAdapter({ baseUrl: cfg.baseUrl, model: cfg.model });
  // The product's own forcing rule, asked of this server.
  const forcing = createToolForcing({ resolveKey: async () => ({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: "none" }), log: (m) => console.error(m) });
  const shipped = arg.shipped === "1";
  const make = (o) => createProductDisplay({ ...o, chat, forcing: () => forcing("eval/model", null), ctxLen: Number(arg.ctx || 8192), shipped });
  const res = await runAll({
    sets: shipped ? [["main", CASES.filter(shippedCase)], ["held", HELD_OUT.filter(shippedCase)]] : [["main", CASES], ["held", HELD_OUT]], trials: Math.max(1, Number(arg.trials || 3)), make,
    check: () => preflight(cfg), write: (row) => appendFileSync(arg.out, `${JSON.stringify(row)}\n`), done,
    pauseMs: Number(arg["pause-ms"] || 250), log: (m) => console.error(m),
  });
  if (res.aborted) { console.error(`STOPPED, no verdict: ${res.aborted}. ${res.rows} rows were written; run again with --resume when the model is back.`); process.exit(4); }
  console.error(`${label}: ${res.rows} rows written to ${arg.out}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((err) => { console.error(err.message); process.exit(1); });
