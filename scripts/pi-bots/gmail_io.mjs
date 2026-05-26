#!/usr/bin/env node
/**
 * Crow Bot Builder — Gmail I/O helper (the bridge's real Gmail adapter).
 *
 * Dependency-free MCP stdio client to the crow `google-workspace` server (the
 * same server + tools the production MPA bots use). Sends self-guarded mail
 * (gmail_send_to_self / gmail_send_threaded_to_self — recipients restricted to
 * kevin.hopper1@gmail.com / kevin.hopper@maestro.press; +pibot is a self-alias)
 * and reads threads (gmail_search_threads / gmail_get_thread). Used by the
 * bridge for outbound, and by bridge_gmail_e2e.mjs to drive the user side.
 *
 * CLI:
 *   node gmail_io.mjs send  --to A --subject S --body B [--thread TID] [--reply-to R]
 *   node gmail_io.mjs reply --to A --subject S --body B --thread TID
 *   node gmail_io.mjs search --query Q [--max N]
 *   node gmail_io.mjs thread --id TID
 * Prints the tool's JSON result (last line = RESULT <json>).
 */
import { spawn } from "node:child_process";

const GW = "/home/kh0pp/spring-2026/google-workspace-mcp";
const BIN = GW + "/.venv/bin/google-workspace-mcp";
const ENV = {
  GOOGLE_CREDENTIALS_FILE: "/home/kh0pp/.config/google-workspace-mcp-mpa/credentials.json",
  GOOGLE_TOKEN_FILE: "/home/kh0pp/.config/google-workspace-mcp-mpa/gws-token.json",
  GOOGLE_PERSONAL_CREDENTIALS_FILE: "/home/kh0pp/.config/google-workspace-mcp/credentials.json",
  GOOGLE_PERSONAL_TOKEN_FILE: "/home/kh0pp/.config/google-workspace-mcp/token.json",
  // +pibot is a self-alias of kevin.hopper@maestro.press; sanctioned override
  // (gmail.py:26 documents GMAIL_SEND_TO_SELF_ALLOWLIST for new self addresses)
  GMAIL_SEND_TO_SELF_ALLOWLIST: "kevin.hopper1@gmail.com,kevin.hopper@maestro.press,kevin.hopper+pibot@maestro.press",
};

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
const cmd = process.argv[2];

const child = spawn(BIN, [], { cwd: GW, env: Object.assign({}, process.env, ENV), stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 1; const pending = new Map(); let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { const x = pending.get(m.id); pending.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); }
  }
});
function rpc(method, params, ms) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method + " stderr=" + stderr.slice(-200))); } }, ms || 30000); });
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }

(async () => {
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gmail_io", version: "0" } }, 30000);
    notify("notifications/initialized", {});
    let tool, args;
    if (cmd === "send") {
      tool = "gmail_send_to_self";
      args = { to: arg("to"), subject: arg("subject"), body: arg("body") };
      if (arg("thread")) args.thread_id = arg("thread");
      if (arg("reply-to")) args.reply_to = arg("reply-to");
    } else if (cmd === "reply") {
      // Use gmail_send_to_self (with thread_id) instead of gmail_send_threaded_to_self
      // — functionally identical when thread_id is passed, but gmail_send_to_self
      // ALSO supports reply_to (gmail_send_threaded_to_self does not). Reply-To
      // routes the user's Gmail "Reply" click back to the bot's +alias so the
      // bridge_tick keeps seeing follow-ups. Without it, user replies default to
      // the bot's bare maestro.press address and the bot never sees them.
      tool = "gmail_send_to_self";
      args = { to: arg("to"), subject: arg("subject"), body: arg("body"), thread_id: arg("thread") };
      if (arg("reply-to")) args.reply_to = arg("reply-to");
    } else if (cmd === "search") {
      tool = "gmail_search_threads";
      args = { query: arg("query"), max_results: Number(arg("max", "5")) };
    } else if (cmd === "thread") {
      tool = "gmail_get_thread";
      args = { thread_id: arg("id") };
    } else { console.error("unknown cmd " + cmd); process.exit(2); }
    const r = await rpc("tools/call", { name: tool, arguments: args }, 60000);
    const text = ((r && r.content) || []).map((c) => c.text || "").join("\n");
    console.log("TOOL " + tool + " isError=" + !!(r && r.isError));
    console.log(text);
    console.log("RESULT " + JSON.stringify({ isError: !!(r && r.isError), text }));
    child.kill("SIGTERM"); process.exit(r && r.isError ? 1 : 0);
  } catch (e) { console.error("GMAIL_IO ERR " + e.message); child.kill("SIGKILL"); process.exit(2); }
})();
