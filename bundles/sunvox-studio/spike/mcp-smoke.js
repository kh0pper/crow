/**
 * MCP protocol smoke — spawns server/index.js over stdio and exercises the
 * four tools via JSON-RPC, exactly as a gateway/MCP client would.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The fixture sits outside the work dir, so allow this folder explicitly.
const child = spawn(process.execPath, [path.join(HERE, "..", "server", "index.js")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, SUNVOX_READ_DIRS: HERE } });

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 30000);
    pending.set(id, (msg) => { clearTimeout(t); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
console.log("initialize OK:", init.serverInfo?.name, init.serverInfo?.version);
notify("notifications/initialized", {});

const tools = await rpc("tools/list", {});
const names = tools.tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
if (names.join() !== "sunvox_compose,sunvox_info,sunvox_module_types,sunvox_render") throw new Error("unexpected tool list");

const fixture = path.join(HERE, "fixture.sunvox");

const info = await rpc("tools/call", { name: "sunvox_info", arguments: { path: fixture } });
const infoJson = JSON.parse(info.content[0].text);
console.log(`sunvox_info OK: "${infoJson.name}" bpm=${infoJson.bpm} duration=${infoJson.duration_s}s`);
if (infoJson.bpm !== 125) throw new Error("info bpm mismatch");

const composed = await rpc("tools/call", {
  name: "sunvox_compose",
  arguments: {
    name: "mcp-smoke",
    render: true,
    format: "wav",
    spec: {
      bpm: 110, tpl: 6,
      modules: [
        { id: "drums", type: "DrumSynth" },
        { id: "lead", type: "Analog generator", params: { Waveform: 2, Volume: 180 } },
        { id: "rev", type: "Reverb", params: { Wet: 80 } },
      ],
      connections: [["lead", "rev", "out"]],
      patterns: [{
        name: "p1", tracks: 2, lines: 16, x: 0, y: 0,
        events: [
          ...[0, 4, 8, 12].map((l) => ({ track: 0, line: l, note: "C2", velocity: 120, module: "drums" })),
          ...[[0, "C4"], [2, "E4"], [4, "G4"], [6, "E4"], [8, "A4"], [10, "G4"], [12, "E4"], [14, "C4"]]
            .map(([l, n]) => ({ track: 1, line: l, note: n, velocity: 100, module: "lead" })),
        ],
      }],
    },
  },
});
if (composed.isError) throw new Error("compose failed: " + composed.content[0].text);
const cj = JSON.parse(composed.content[0].text);
console.log(`sunvox_compose OK: project=${cj.project_path} (${cj.project_bytes}B) render=${cj.render_path} ${cj.duration_s}s effective=${JSON.stringify(cj.info.effective_tempo?.at_line_0)}`);
if (cj.info.effective_tempo?.at_line_0?.bpm !== 110) throw new Error("composed tempo mismatch");

const rendered = await rpc("tools/call", { name: "sunvox_render", arguments: { path: fixture, format: "wav", out_name: "mcp-smoke-render" } });
if (rendered.isError) throw new Error("render failed: " + rendered.content[0].text);
const rj = JSON.parse(rendered.content[0].text);
console.log(`sunvox_render OK: ${rj.path} ${rj.size_bytes}B ${rj.duration_s}s`);

const cat = await rpc("tools/call", { name: "sunvox_module_types", arguments: {} });
const catJson = JSON.parse(cat.content[0].text);
console.log(`sunvox_module_types OK: ${Object.keys(catJson.modules).length} types`);

child.kill();
console.log("\nMCP SMOKE PASS: all four tools work over stdio JSON-RPC.");
process.exit(0);
