#!/usr/bin/env node
/**
 * S2 spike — Crow Bot Builder (GATING).
 *
 * Drives `pi --mode rpc` headlessly the way the Bot Session Bridge will, and
 * asserts the four S2 invariants from the plan:
 *
 *   A. send / toolcall / answer  — rpc prompt -> live `tasks_list` -> answer
 *   B. resume by id              — kill pi, respawn `--session <id>`, context kept
 *   C. stop mid-turn + resumable — `{"type":"abort"}` stops the turn; session persists
 *   D. clean stdout JSONL w/ crow MCP DOWN — broken mcp.json -> error on STDERR only,
 *                                            every stdout line is valid JSON
 *
 * All runs use a PINNED cwd and the bridge's explicit-node spawn (no PATH /
 * no getPiInvocation reliance). Isolated from production via PI_CODING_AGENT_DIR
 * (~/.pi-spike/agent-real | agent-brokenmcp) and a private --session-dir.
 *
 * Framing: strict JSONL, LF only, trailing \r stripped — per pi docs/rpc.md
 * (Node `readline` is NOT protocol-compliant; we hand-roll the reader).
 *
 * Usage: node s2_rpc_drive.mjs   (runs A->B->C->D, prints PASS/FAIL per test)
 * Exit 0 iff all PASS.
 */

import { spawn } from "node:child_process";

const HOME = "/home/kh0pp";
const NODE = `${HOME}/.nvm/versions/node/v20.20.2/bin/node`;
const PI_CLI = `${HOME}/.nvm/versions/node/v20.20.2/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js`;
const SPK = `${HOME}/.pi-spike`;
const PINNED_CWD = `${SPK}/cwd`;
const SESSION_DIR = `${SPK}/sessions-s2`;
const MODEL = "qwen3.6-35b-a3b";
const PROVIDER = "crow-local";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

class PiRpc {
  constructor({ configDir, sessionId, cwd }) {
    const args = [
      PI_CLI, "--mode", "rpc",
      "--provider", PROVIDER, "--model", MODEL,
      "--session-dir", SESSION_DIR,
    ];
    if (sessionId) args.push("--session", sessionId);
    this.proc = spawn(NODE, args, {
      cwd: cwd || PINNED_CWD,
      env: {
        ...process.env,
        PATH: `${HOME}/.nvm/versions/node/v20.20.2/bin:${process.env.PATH || ""}`,
        PI_CODING_AGENT_DIR: configDir,
        PI_PROVIDER: PROVIDER,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.events = [];
    this.responses = [];
    this.stdoutLines = 0;
    this.badStdoutLines = []; // lines that failed JSON.parse — must stay empty
    this.stderr = "";
    this._buf = "";
    this._waiters = [];

    this.proc.stdout.on("data", (chunk) => {
      this._buf += chunk.toString("utf8");
      let nl;
      while ((nl = this._buf.indexOf("\n")) >= 0) {
        let line = this._buf.slice(0, nl);
        this._buf = this._buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        this.stdoutLines++;
        let msg;
        try { msg = JSON.parse(line); }
        catch { this.badStdoutLines.push(line.slice(0, 200)); continue; }
        if (msg.type === "response") this.responses.push(msg);
        else this.events.push(msg);
        for (const w of this._waiters.slice()) {
          if (w.pred(msg)) { this._waiters.splice(this._waiters.indexOf(w), 1); w.resolve(msg); }
        }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.exited = new Promise((res) => this.proc.on("exit", (c) => res(c ?? -1)));
  }

  send(cmd) { this.proc.stdin.write(JSON.stringify(cmd) + "\n"); }

  waitFor(pred, ms, label) {
    return new Promise((resolve, reject) => {
      const hit = this.events.find(pred) || this.responses.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      this._waiters.push(w);
      setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) { this._waiters.splice(i, 1); reject(new Error(`timeout: ${label} (stderr tail: ${this.stderr.slice(-300)})`)); }
      }, ms);
    });
  }

  async prompt(message, ms = 240000) {
    this.send({ type: "prompt", message });
    await this.waitFor((m) => m.type === "response" && m.command === "prompt", 15000, "prompt-ack");
    return this.waitFor((m) => m.type === "agent_end", ms, "agent_end");
  }

  async getState() {
    this.send({ type: "get_state" });
    return this.waitFor((m) => m.type === "response" && m.command === "get_state", 15000, "get_state");
  }

  lastAssistantText() {
    // scan agent_end messages then message_end events for last assistant text
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      const msgs = e.type === "agent_end" ? e.messages : e.type === "message_end" ? [e.message] : null;
      if (!msgs) continue;
      for (let j = msgs.length - 1; j >= 0; j--) {
        const mm = msgs[j];
        if (mm && mm.role === "assistant" && Array.isArray(mm.content)) {
          const t = mm.content.filter((c) => c.type === "text").map((c) => c.text).join("");
          if (t.trim()) return t;
        }
      }
    }
    return "";
  }

  async close() {
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill("SIGTERM");
    const t = setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {} }, 5000);
    await this.exited;
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function warm() {
  // Cut cold-start: ping the local model directly.
  try {
    await fetch("http://100.118.41.122:8003/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 4, temperature: 0 }),
      signal: AbortSignal.timeout(90000),
    });
  } catch { /* best effort */ }
}

async function main() {
  const onlyIdx = process.argv.indexOf("--only");
  const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null; // e.g. "D" or "AD"
  const run = (letter) => !ONLY || ONLY.includes(letter);
  await warm();
  let sidA;

  // ---- Test A: send / toolcall / answer (real cfg, crow MCP UP) ----
  if (run("A")) {
    const pi = new PiRpc({ configDir: `${SPK}/agent-real` });
    try {
      await pi.prompt(
        "Call the tasks_list tool with no arguments. It returns JSON with an integer field 'count'. " +
        "Then reply with exactly one line: COUNT=<count>. Do not call any other tool.",
      );
      const toolStart = pi.events.find(
        (e) => e.type === "tool_execution_start" && /mcp__crow-tasks__tasks_list/.test(e.toolName || ""),
      );
      const toolEnd = pi.events.find(
        (e) => e.type === "tool_execution_end" && /mcp__crow-tasks__tasks_list/.test(e.toolName || ""),
      );
      const txt = pi.lastAssistantText();
      const st = await pi.getState();
      sidA = st.data?.sessionId;
      const cleanStdout = pi.badStdoutLines.length === 0;
      const ok = !!toolStart && !!toolEnd && !toolEnd.isError && /COUNT\s*=\s*64\b/.test(txt) && !!sidA && cleanStdout;
      record("A send/toolcall/answer (rpc, live tasks_list=64)", ok,
        `tool=${!!toolStart}/${!!toolEnd} answer=${JSON.stringify(txt.slice(0, 40))} sid=${sidA ? "y" : "n"} cleanStdout=${cleanStdout}(${pi.stdoutLines} lines)`);
    } catch (e) {
      record("A send/toolcall/answer (rpc, live tasks_list=64)", false, e.message);
    } finally { await pi.close(); }
  }

  // ---- Test B: resume by id (context survives a fresh pi process) ----
  if (run("B") && sidA) {
    const pi = new PiRpc({ configDir: `${SPK}/agent-real`, sessionId: sidA });
    try {
      const st0 = await pi.getState();
      const resumedSame = st0.data?.sessionId === sidA && (st0.data?.messageCount ?? 0) > 0;
      await pi.prompt(
        "Do NOT call any tool. Earlier in THIS conversation you reported a COUNT value. " +
        "Reply with exactly one line: PREV=<that number>.",
      );
      const txt = pi.lastAssistantText();
      const ok = resumedSame && /PREV\s*=\s*64\b/.test(txt) && pi.badStdoutLines.length === 0;
      record("B resume-by-id (context kept across respawn)", ok,
        `resumedSame=${resumedSame} answer=${JSON.stringify(txt.slice(0, 40))}`);
    } catch (e) {
      record("B resume-by-id (context kept across respawn)", false, e.message);
    } finally { await pi.close(); }
  } else if (run("B")) {
    record("B resume-by-id (context kept across respawn)", false, "skipped: no sessionId from A");
  }

  // ---- Test C: stop mid-turn via abort, then prove session resumable ----
  let sidC;
  if (run("C")) {
    const pi = new PiRpc({ configDir: `${SPK}/agent-real` });
    try {
      pi.send({ type: "prompt", message:
        "Without calling any tool, list the numbers 1 through 40, each on its own line, " +
        "with a one-sentence reflection after each number. Be thorough and slow." });
      await pi.waitFor((m) => m.type === "response" && m.command === "prompt", 15000, "prompt-ack");
      await pi.waitFor((m) => m.type === "agent_start", 60000, "agent_start");
      await sleep(2500); // let it get mid-turn
      pi.send({ type: "abort" });
      const abortResp = await pi.waitFor((m) => m.type === "response" && m.command === "abort", 15000, "abort-resp");
      // after abort the turn should end; process stays alive (rpc loop)
      await pi.waitFor((m) => m.type === "agent_end", 30000, "agent_end-after-abort").catch(() => null);
      const st = await pi.getState(); // still responsive => process alive post-abort
      sidC = st.data?.sessionId;
      const ok = abortResp.success === true && !!sidC && st.data?.isStreaming === false && pi.badStdoutLines.length === 0;
      record("C stop-mid-turn (abort acked, pi alive & idle)", ok,
        `abort.success=${abortResp.success} sid=${sidC ? "y" : "n"} isStreaming=${st.data?.isStreaming}`);
    } catch (e) {
      record("C stop-mid-turn (abort acked, pi alive & idle)", false, e.message);
    } finally { await pi.close(); }
  }
  // C2: resumable after stop
  if (run("C") && sidC) {
    const pi = new PiRpc({ configDir: `${SPK}/agent-real`, sessionId: sidC });
    try {
      const st = await pi.getState();
      const ok = st.data?.sessionId === sidC && (st.data?.messageCount ?? 0) > 0;
      record("C2 resumable-after-stop (--session reopens)", ok,
        `sid match=${st.data?.sessionId === sidC} messageCount=${st.data?.messageCount}`);
    } catch (e) {
      record("C2 resumable-after-stop (--session reopens)", false, e.message);
    } finally { await pi.close(); }
  } else if (run("C")) {
    record("C2 resumable-after-stop (--session reopens)", false, "skipped: no sessionId from C");
  }

  // ---- Test D: clean stdout JSONL with a crow MCP server DOWN ----
  // mcp-client.ts reads ~/.pi/agent/mcp.json (homedir, NOT PI_CODING_AGENT_DIR)
  // + every cwd-ancestor .mcp.json. So "MCP down" is exercised via a pinned
  // bot-workspace cwd (~/.pi-spike/cwd-d) whose .mcp.json adds a deliberately
  // unreachable server `crow-broken` (nonexistent cwd). Healthy ~/.pi/agent
  // servers stay up; the broken one must fail to STDERR only, stdout stays JSONL.
  if (run("D")) {
    const pi = new PiRpc({ configDir: `${SPK}/agent-real`, cwd: `${SPK}/cwd-d` });
    try {
      await pi.prompt("Reply with exactly one line: READY. Do not call any tool.", 180000);
      const txt = pi.lastAssistantText();
      const cleanStdout = pi.badStdoutLines.length === 0;
      const errOnStderr = /\[pi-lab\/mcp-client\]\s+crow-broken/.test(pi.stderr);
      const errNotOnStdout = !/pi-lab\/mcp-client|crow-broken/.test(
        JSON.stringify(pi.events) + JSON.stringify(pi.responses),
      );
      const ok = cleanStdout && errOnStderr && errNotOnStdout && /READY/.test(txt);
      record("D stdout-clean w/ a crow MCP DOWN (stderr-only diag)", ok,
        `cleanStdout=${cleanStdout}(${pi.stdoutLines} lines, bad=${pi.badStdoutLines.length}) ` +
        `errOnStderr=${errOnStderr} errNotOnStdout=${errNotOnStdout} answer=${JSON.stringify(txt.slice(0, 30))}`);
    } catch (e) {
      record("D stdout-clean w/ a crow MCP DOWN (stderr-only diag)", false, e.message);
    } finally { await pi.close(); }
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);
  console.log(`\nS2-DRIVE ${allOk ? "OK" : "FAIL"} (${results.filter((r) => r.ok).length}/${results.length} passed)`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error("S2-DRIVE crashed:", e); process.exit(2); });
