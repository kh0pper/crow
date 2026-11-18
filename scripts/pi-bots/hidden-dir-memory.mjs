#!/usr/bin/env node
/**
 * The record the bot bridge keeps of the operator's secret FOLDERS it hides
 * from a bot (~/.ssh, ~/.gnupg, ~/.config/gcloud, ~/.aws, ~/.azure, ~/.kube,
 * ~/.config/gh, ~/.terraform.d — one list, servers/shared/operator-secret-paths.js),
 * each by (dev, ino). The credential FILES on that list (~/.docker/config.json,
 * ~/.netrc, ~/.npmrc, ~/.pgpass, ~/.config/containers/auth.json) are NOT
 * recorded: a tool that rewrites one (`npm config set`, `docker login`) puts a
 * new inode at the same path, and remembering that would refuse every bot until
 * a manual reset. They are masked fresh on every spawn instead.
 *
 * The first spawn that sees a folder records it. A later spawn REFUSES to start
 * a bot when a recorded folder is gone or is a different one at the same
 * path, and the failed turn says so — that is how a re-pointed ancestor or a
 * swapped-in decoy shows up after the fact. An unreadable record refuses too
 * (fail closed). The operator's re-confirm is either of these:
 *
 *   node scripts/pi-bots/hidden-dir-memory.mjs --reset
 *   rm <CROW_HOME>/secrets/hidden-secret-dirs-*.json
 *
 * and the next spawn records whatever is there again.
 *
 *   node scripts/pi-bots/hidden-dir-memory.mjs            list what is recorded
 *   node scripts/pi-bots/hidden-dir-memory.mjs --list     the same
 *   node scripts/pi-bots/hidden-dir-memory.mjs --reset    forget every record
 *   node scripts/pi-bots/hidden-dir-memory.mjs --reset --crow-home ~/.crow-<x>
 *   node scripts/pi-bots/hidden-dir-memory.mjs --help
 *
 * `--crow-home <dir>` acts on THAT instance's record instead of the one CROW_HOME
 * (default ~/.crow) resolves. A co-hosted instance keeps its own
 * `<CROW_HOME>/secrets/` records, so an operator acting on that instance's bell
 * must not reset the default instance's: the bell spells the command out with
 * this flag, in ~-relative form. A leading `~/` in the value is expanded here as
 * well, so a quoted copy of the command works too.
 *
 * There is one record per operator home (`hidden-secret-dirs-<id>.json`), so a
 * co-hosted or moved home never inherits another one's entries. Read-only apart
 * from --reset; it never touches the folders or files themselves.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readHiddenDirMemory, hiddenDirStateFiles, resetAllHiddenDirIdentity } from "./hidden_files.mjs";
import { secretsDir } from "../../servers/shared/secret-values.js";

const USAGE = [
  "usage: node scripts/pi-bots/hidden-dir-memory.mjs [--list | --reset | --help] [--crow-home <dir>]",
  "",
  "  --list              show the secret folders Crow remembers hiding (the default)",
  "  --reset             forget every record, so the next bot spawn records them again",
  "  --crow-home <dir>   act on this instance's record (default: CROW_HOME, else ~/.crow)",
].join("\n");

/** Expand a leading `~` in a flag value (a quoted copy of a bell's command). */
function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = [];
let crowHomeFlag = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--crow-home") {
    const v = args[i + 1];
    if (!v || v.startsWith("--")) {
      console.error("hidden-dir-memory: --crow-home needs a directory\n" + USAGE);
      process.exit(2);
    }
    crowHomeFlag = v;
    i += 1;
    continue;
  }
  if (a.startsWith("--crow-home=")) {
    const v = a.slice("--crow-home=".length);
    if (!v) {
      console.error("hidden-dir-memory: --crow-home needs a directory\n" + USAGE);
      process.exit(2);
    }
    crowHomeFlag = v;
    continue;
  }
  if (!["--list", "--reset"].includes(a)) unknown.push(a);
}
if (unknown.length > 0) {
  console.error("hidden-dir-memory: unknown argument: " + unknown[0] + "\n" + USAGE);
  process.exit(2);
}

// The instance to act on: the flag wins over CROW_HOME, which wins over ~/.crow
// (secretsDir() resolves the same way the gateway does — hidden_files.mjs
// hiddenDirResetCommand spells a non-default home out as this flag).
const dir = crowHomeFlag ? join(expandHome(crowHomeFlag), "secrets") : secretsDir();
const crowHome = crowHomeFlag ? expandHome(crowHomeFlag) : dirname(dir);
if (args.includes("--reset")) {
  const gone = resetAllHiddenDirIdentity(crowHome);
  console.log(gone.length === 0
    ? "No record in " + dir + " — nothing to forget."
    : "Forgot " + gone.length + " record(s) in " + dir + ". The next bot spawn records whatever is there.");
  process.exit(0);
}

const files = hiddenDirStateFiles(crowHome);
if (files.length === 0) {
  console.log("Nothing recorded yet (" + dir + "). A first sight is recorded at the next bot spawn.");
  process.exit(0);
}
let bad = 0;
for (const file of files) {
  const memory = readHiddenDirMemory(file);
  if (!memory.ok) {
    bad += 1;
    console.error("The record is " + memory.reason + ": " + file);
    continue;
  }
  console.log("Secret folders Crow remembers hiding" + (memory.home ? " for " + memory.home : "") + " (" + file + "):");
  const rels = Object.keys(memory.dirs).sort();
  if (rels.length === 0) console.log("  (none yet)");
  for (const rel of rels) console.log("  ~/" + rel + "  device " + memory.dirs[rel].dev + "  inode " + memory.dirs[rel].ino);
}
if (bad > 0) {
  console.error("A bot spawn is refused until you reset it: node scripts/pi-bots/hidden-dir-memory.mjs --reset" +
    (crowHomeFlag ? " --crow-home " + crowHomeFlag : ""));
  process.exit(1);
}