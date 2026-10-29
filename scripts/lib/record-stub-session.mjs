#!/usr/bin/env node
/**
 * One real pi conversation through the live pi driver against the loopback stub model: two
 * threads, the first making one crow-projects MCP call. The real-pi test runs it; as a script it
 * records day 1's session as the tool-name gate fixture, with every local path scrubbed.
 *
 *   PI_CLI=<pi dist/cli.js> PI_LAB_DIR=<pi-lab checkout> node scripts/lib/record-stub-session.mjs <out.jsonl>
 *
 * The grant is "crow-projects/crow_list_projects", not the bare server: the bridge pins pi's
 * --tools to exact names, and a bare "crow-projects" means only the router-mode tool
 * mcp__crow-projects, which this non-router server never registers.
 *
 * Only the stub model is ever reached: models.json names the stub's loopback baseUrl, and the
 * driver pins every gateway variable to a closed port.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runConversation } from "./live-pi-driver.mjs";
import { startStubModel } from "./stub-model-server.mjs";
import { makeScratch, makeTemplate } from "../research-eval/scratch.mjs";

export const BOT = "real-pi-bot";
const REPO = resolve(import.meta.dirname, "..", "..");

export const SCRIPT = Object.freeze([
  { toolCalls: [{ nameEndsWith: "crow_list_projects", arguments: {} }] },
  { text: "noted" },
  { text: "day two" },
]);

export const botDef = () => ({
  id: BOT,
  display_name: "Real Pi Bot",
  system_prompt: "You are the driver's real-pi test bot.",
  models: { default: "stub/stub-m1" },
  tools: { pi_builtin: ["read"], crow_mcp: ["crow-projects/crow_list_projects"] },
  permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
});

/**
 * The real-pi prerequisites from env, or the reason they are missing. `PI_CLI` and
 * `PI_LAB_DIR` must both be absolute existing paths.
 */
export function realPiPrereqs(env = process.env) {
  const piCli = env.PI_CLI;
  const piLab = env.PI_LAB_DIR;
  if (!piCli) return { reason: "PI_CLI is unset" };
  if (!existsSync(piCli)) return { reason: `PI_CLI ${piCli} does not exist` };
  if (!piLab) return { reason: "PI_LAB_DIR is unset" };
  if (!existsSync(piLab)) return { reason: `PI_LAB_DIR ${piLab} does not exist` };
  return { piCli: resolve(piCli), piLab: resolve(piLab) };
}

/**
 * Runs the two-thread conversation. Resolves `{ result, stub, scratch, events }`; the caller
 * runs `cleanup()` (stub, scratch, template) when done reading the session files.
 */
export async function runRealStubConversation({ piCli, piLab, prodMaxPi, log = () => {} }) {
  const template = await makeTemplate({ botId: BOT });
  let stub = null;
  let scratch = null;
  const cleanup = async () => {
    if (stub) await stub.close();
    if (scratch) scratch.cleanup();
    template.cleanup();
  };
  try {
    scratch = await makeScratch({ botId: BOT, template });
    stub = await startStubModel({ script: SCRIPT.map((s) => ({ ...s })) });
    const events = [];
    const result = await runConversation({
      botDef: botDef(),
      models: { providers: { stub: { baseUrl: stub.baseUrl, api: "openai-completions", apiKey: "stub", models: [{ id: "stub-m1" }] } } },
      scratchHome: scratch.home,
      threads: [
        { id: "day-1", turns: [{ text: "List my projects, then say what you saw." }] },
        { id: "day-2", turns: [{ text: "Good morning." }] },
      ],
      allowServers: ["crow-projects"],
      piPackages: [piLab],
      piCli,
      turnTimeoutMs: 120_000,
      wallMs: 600_000,
      ...(prodMaxPi ? { prodMaxPi } : {}),
      log: (e) => { events.push(e); log(e); },
    });
    return { result, stub, scratch, events, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Replaces every local path the session can carry with a placeholder; longest first. */
export function scrub(text, { scratchHome, piLab, piCli }) {
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const pairs = [
    [scratchHome, "<scratch>"], [real(scratchHome), "<scratch>"],
    [piLab, "<pi-lab>"], [real(piLab), "<pi-lab>"],
    [REPO, "<repo>"], [real(REPO), "<repo>"],
    [dirname(dirname(piCli)), "<pi>"], [dirname(process.execPath), "<node-bin>"],
    [userInfo().homedir, "<home>"],
  ].filter(([p]) => typeof p === "string" && p.length > 1);
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = String(text);
  for (const [p, tag] of pairs) out = out.split(p).join(tag);
  return out;
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  const out = process.argv[2];
  const pre = realPiPrereqs();
  if (!out) { console.error("usage: record-stub-session.mjs <out.jsonl>"); process.exit(2); }
  if (!pre.piCli) { console.error(`cannot record: ${pre.reason}`); process.exit(2); }
  const run = await runRealStubConversation({ piCli: pre.piCli, piLab: pre.piLab, log: (e) => console.error(JSON.stringify(e)) });
  let code = 0;
  try {
    const { result, scratch } = run;
    if (!result.ok) { console.error(`run failed: ${result.contaminated}\n${result.reason ?? ""}`); code = 1; }
    else {
      const raw = readFileSync(result.threads[0].sessionPaths[0], "utf8");
      writeFileSync(resolve(out), scrub(raw, { scratchHome: scratch.home, piLab: pre.piLab, piCli: pre.piCli }));
      console.error(`wrote ${out}`);
    }
  } finally { await run.cleanup(); }
  process.exit(code);
}
