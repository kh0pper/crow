#!/usr/bin/env node
/**
 * Operator step (approval-card secret masking, 2026-10-26): confirm passwords
 * already in the Crow keychain (saved BEFORE the card list existed) so they
 * may hide text on bot approval cards. Passwords saved through the keychain
 * UI from now on are recorded automatically. Never prints a value.
 *
 *   node scripts/ops/keychain-card-secrets.mjs confirm
 *
 * Type each password you know, one per line (echo is off on a terminal), and
 * an empty line to finish. A password is recorded only when a MANUAL keychain
 * entry holds exactly that value; labels and ids live in crow.db, which a bot
 * with a shell can write, so they play no part. Passwords are read on stdin,
 * never from the command line (shell history). Uses this shell's CROW_HOME /
 * CROW_DATA_DIR. Run it from an operator shell; inside the bot sandbox the
 * secrets dir is read-only and nothing can be recorded.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { confirmTypedValueForCards } from "../../servers/shared/secret-values-collect.js";

const args = process.argv.slice(2);
if (args[0] !== "confirm" || args.length !== 1) {
  console.error("usage: keychain-card-secrets.mjs confirm   (passwords are read from stdin)");
  process.exit(2);
}
const tty = !!process.stdin.isTTY;
let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = createInterface({ input: process.stdin, output: tty ? out : undefined, terminal: tty });
const ask = () => new Promise((resolve) => {
  if (tty) { process.stdout.write("Password (empty line to finish): "); muted = true; }
  rl.once("line", (l) => { muted = false; if (tty) process.stdout.write("\n"); resolve(l); });
  rl.once("close", () => resolve(null));
});
let recorded = 0;
let missed = 0;
for (;;) {
  const line = await ask();
  if (line == null || line === "") break;
  const n = confirmTypedValueForCards({ value: line });
  if (n) recorded++; else missed++;
}
rl.close();
if (missed) console.error(missed + " typed value(s) matched no manual keychain entry (or are too weak, or are also an extension secret); not recorded.");
if (!recorded) { console.error("Nothing recorded."); process.exit(1); }
console.log(recorded + " entr" + (recorded === 1 ? "y" : "ies") + " confirmed for approval cards.");
