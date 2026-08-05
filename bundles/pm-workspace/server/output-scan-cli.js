// CLI wrapper: exit 0 clean, 1 findings, 2 usage/error.
import { loadRules, scanText, scanFiles } from "./output-scan.js";

const args = process.argv.slice(2);
const ri = args.indexOf("--rules");
if (ri < 0 || !args[ri + 1]) { console.error("usage: output-scan-cli.js --rules FILE [--stdin] [files...]"); process.exit(2); }
const rules = loadRules(args[ri + 1]);
const files = args.filter((a, i) => i !== ri && i !== ri + 1 && a !== "--stdin");
let total = 0;
if (args.includes("--stdin")) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const f = scanText(Buffer.concat(chunks).toString("utf8"), rules);
  total += f.length;
  for (const x of f) console.log(`stdin: ${x.name} (${x.severity}) at ${x.index}`);
}
const byFile = scanFiles(files, rules);
for (const [p, f] of Object.entries(byFile)) {
  total += f.length;
  for (const x of f) console.log(`${p}: ${x.name} (${x.severity})${x.index != null ? " at " + x.index : ""}`);
}
console.log(total === 0 ? "CLEAN" : `FINDINGS: ${total}`);
process.exit(total === 0 ? 0 : 1);
