#!/usr/bin/env node
/**
 * S4 spike — Crow Bot Builder. Does pi tolerate a JSON-Schema `pattern` tool
 * param where crow-chat (--jinja qwen) did NOT? Result sets the GUI fail-closed
 * rule (plan §3/§5: fail-closed on pattern tools unless model is non-local).
 *
 * Isolation: the s4 MCP server is exposed via a cwd .mcp.json (the per-bot MCP
 * mechanism proven in S2). `--tools` allowlists EXACTLY ONE s4 tool so the
 * tools[] array sent to the model carries only the schema under test.
 *
 *   L-pat   : LOCAL crow-local + s4_echo_pattern (param has `pattern`)
 *   L-plain : LOCAL crow-local + s4_echo_plain   (no pattern — CONTROL)
 *   C-pat   : CLOUD alibaba    + s4_echo_pattern (no llama.cpp — CONTROL)
 *
 * Scar signatures (memory crowchat-jinja-regex-toolcall): literal <tool_call> /
 * <function= in assistant text, upstream 500 / "Failed to parse input", an
 * extension_error, or agent_end with NO successful s4 tool_execution_end.
 */
import { spawn } from "node:child_process";

const HOME = "/home/kh0pp";
const NODE = `${HOME}/.nvm/versions/node/v20.20.2/bin/node`;
const PI_CLI = `${HOME}/.nvm/versions/node/v20.20.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`;
const SPK = `${HOME}/.pi-spike`;
const CWD_S4 = `${SPK}/cwd-s4`;
const SDIR = `${SPK}/sessions-s4`;

const results = [];
const rec = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

class PiRpc {
  constructor({ provider, model, tools }) {
    const args = [PI_CLI, "--mode", "rpc", "--provider", provider, "--model", model,
      "--session-dir", SDIR, "--no-session", "--tools", tools];
    this.proc = spawn(NODE, args, {
      cwd: CWD_S4,
      env: { ...process.env, PATH: `${HOME}/.nvm/versions/node/v20.20.2/bin:${process.env.PATH || ""}`,
        PI_CODING_AGENT_DIR: `${SPK}/agent-real`, PI_PROVIDER: provider },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.events = []; this.responses = []; this.badStdout = []; this.stderr = ""; this._b = ""; this._w = [];
    this.proc.stdout.on("data", (c) => {
      this._b += c.toString("utf8");
      let nl;
      while ((nl = this._b.indexOf("\n")) >= 0) {
        let ln = this._b.slice(0, nl); this._b = this._b.slice(nl + 1);
        if (ln.endsWith("\r")) ln = ln.slice(0, -1);
        if (!ln) continue;
        let m; try { m = JSON.parse(ln); } catch { this.badStdout.push(ln.slice(0, 160)); continue; }
        (m.type === "response" ? this.responses : this.events).push(m);
        for (const w of this._w.slice()) if (w.p(m)) { this._w.splice(this._w.indexOf(w), 1); w.r(m); }
      }
    });
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
    this.exited = new Promise((res) => this.proc.on("exit", (c) => res(c ?? -1)));
  }
  send(o) { this.proc.stdin.write(JSON.stringify(o) + "\n"); }
  waitFor(p, ms, label) {
    return new Promise((resolve, reject) => {
      const hit = this.events.find(p) || this.responses.find(p);
      if (hit) return resolve(hit);
      const w = { p, r: resolve }; this._w.push(w);
      setTimeout(() => { const i = this._w.indexOf(w); if (i >= 0) { this._w.splice(i, 1); reject(new Error(`timeout:${label}`)); } }, ms);
    });
  }
  async prompt(message, ms) {
    this.send({ type: "prompt", message });
    await this.waitFor((m) => m.type === "response" && m.command === "prompt", 15000, "ack");
    return this.waitFor((m) => m.type === "agent_end", ms, "agent_end");
  }
  assistantText() {
    // Authoritative final message list = the LAST agent_end (avoids the
    // message_end/agent_end double-count that produced "DONEDONE").
    let last = null;
    for (const e of this.events) if (e.type === "agent_end") last = e;
    const ms = last ? last.messages : this.events.filter((e) => e.type === "message_end").map((e) => e.message);
    let t = "";
    for (const mm of ms || []) if (mm && mm.role === "assistant" && Array.isArray(mm.content))
      t += mm.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return t;
  }
  async close() { try { this.proc.stdin.end(); } catch {} this.proc.kill("SIGTERM");
    const k = setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {} }, 5000); await this.exited; clearTimeout(k); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function warm() {
  try {
    await fetch("http://100.118.41.122:8003/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3.6-35b-a3b", messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
      signal: AbortSignal.timeout(90000),
    });
  } catch {}
}

function analyze(pi, toolName) {
  const txt = pi.assistantText();
  // Authoritative "tool actually ran server-side": the s4 server logs an
  // INVOKED line with a fresh nonce to stderr (pi surfaces MCP-server stderr).
  const inv = (pi.stderr.match(
    new RegExp(`\\[s4-pattern-mcp\\] INVOKED tool=${toolName} code=\\S+ nonce=(N[0-9A-F]+)`),
  ) || [])[1] || null;
  const serverInvoked = !!inv;
  const answeredNonce = !!inv && new RegExp(`NONCE=\\s*${inv}`).test(txt);
  const rpcToolEnd = pi.events.some((e) => e.type === "tool_execution_end" &&
    new RegExp(`mcp__s4__${toolName}`).test(e.toolName || "") && e.isError === false);
  const hermes = /<tool_call>|<function=|<\|tool|<｜tool/.test(txt);
  const five00 = /Failed to parse input|HTTP 500|status code 500|\b500\b[^0-9].*pars/i.test(pi.stderr) ||
    pi.events.some((e) => e.type === "extension_error") ||
    /Failed to parse input/.test(JSON.stringify(pi.events));
  return { serverInvoked, answeredNonce, rpcToolEnd, hermes, five00,
    nonce: inv, txtPreview: txt.slice(0, 70).replace(/\n/g, " ") };
}

async function scenario({ tag, provider, model, tool, expectWork, ms }) {
  const code = tool === "s4_echo_pattern" ? "2026-05-16" : "HELLO";
  const pi = new PiRpc({ provider, model, tools: `mcp__s4__${tool}` });
  try {
    // FORCING prompt: the tool returns a server-generated random `nonce` that
    // is impossible to produce without genuinely invoking the tool.
    await pi.prompt(
      `You have exactly one tool: ${tool}. Call it once with code "${code}". ` +
      `It returns JSON containing a "nonce" field with a random value. ` +
      `You CANNOT know the nonce without calling the tool. ` +
      `After the tool result, reply with exactly one line: NONCE=<the nonce value>.`, ms);
    const a = analyze(pi, tool);
    // "tolerated" = server confirms the tool ran AND the model relayed the
    // server's unguessable nonce AND no scar signature.
    const tolerated = a.serverInvoked && a.answeredNonce && !a.hermes && !a.five00;
    rec(`${tag} (${provider}/${model} ${tool})`, expectWork ? tolerated : true,
      `srvInvoked=${a.serverInvoked} answeredNonce=${a.answeredNonce} rpcToolEnd=${a.rpcToolEnd} ` +
      `hermes=${a.hermes} 500/err=${a.five00} nonce=${a.nonce} txt=${JSON.stringify(a.txtPreview)}`);
    return { tag, ...a, tolerated };
  } catch (e) {
    rec(`${tag} (${provider}/${model} ${tool})`, !expectWork, `EXC ${e.message}`);
    return { tag, calledOk: false, hermes: false, five00: false, tolerated: false, exc: e.message };
  } finally { await pi.close(); }
}

async function main() {
  await warm();
  // CONTROL 1: local + plain tool (no pattern) -> MUST work (proves path is sound)
  const lPlain = await scenario({ tag: "L-plain CONTROL", provider: "crow-local", model: "qwen3.6-35b-a3b",
    tool: "s4_echo_plain", expectWork: true, ms: 240000 });
  // SUBJECT: local + pattern tool -> the question
  const lPat = await scenario({ tag: "L-pat SUBJECT", provider: "crow-local", model: "qwen3.6-35b-a3b",
    tool: "s4_echo_pattern", expectWork: false, ms: 240000 });
  // CONTROL 2: cloud + pattern tool -> MUST work (no llama.cpp --jinja)
  const cPat = await scenario({ tag: "C-pat CONTROL", provider: "alibaba-coding", model: "qwen3-coder-plus",
    tool: "s4_echo_pattern", expectWork: true, ms: 150000 });

  console.log("\n===== S4 VERDICT =====");
  const localToleratesPattern = lPat.tolerated;
  const controlsValid = lPlain.tolerated && cPat.tolerated;
  if (!controlsValid) {
    console.log("S4 INCONCLUSIVE — a control failed (path/cloud not sound); cannot attribute to `pattern`.");
    console.log(`  L-plain tolerated=${lPlain.tolerated} | C-pat tolerated=${cPat.tolerated}`);
    process.exit(3);
  }
  if (localToleratesPattern) {
    console.log("S4 RESULT: pi+crow-local TOLERATES a `pattern`-schema tool (scar does NOT reproduce under pi).");
    console.log("  -> GUI rule MAY relax: pattern tools need not hard fail-closed even for local model.");
  } else {
    console.log("S4 RESULT: pi+crow-local does NOT tolerate `pattern` (scar reproduces).");
    console.log(`  evidence: calledOk=${lPat.calledOk} hermes=${lPat.hermes} 500/err=${lPat.five00}`);
    console.log("  -> GUI rule CONFIRMED: fail-closed on pattern-schema tools when bot model is local.");
  }
  console.log(`S4-DRIVE OK (controls valid; subject observed)`);
  process.exit(0);
}
main().catch((e) => { console.error("S4-DRIVE crashed:", e); process.exit(2); });
