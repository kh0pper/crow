#!/usr/bin/env node
/**
 * Operator step (approval-card secret masking, 2026-10-26): confirm manual
 * keychain entries saved BEFORE the card list existed, one by one, so they may
 * hide text on bot approval cards. Entries saved through the keychain UI from
 * now on are recorded automatically. Never prints a value.
 *
 *   node scripts/ops/keychain-card-secrets.mjs confirm
 *
 * Interactive, in ONE run: it lists each manual entry's id, a fingerprint (8
 * hex of an HMAC under a nonce made fresh for this run and never stored, so
 * it means nothing outside it) and its label (control characters stripped).
 * Then type the picks on stdin, one `id:fingerprint` per line, and an empty
 * line to finish. Picks are never taken from the command line (they would
 * land in shell history). Labels live in crow.db, which a bot with a shell can
 * write: check each entry against the password you know, not its label. The
 * entries are re-decrypted and recorded only if every fingerprint matches.
 * Uses this shell's CROW_HOME / CROW_DATA_DIR. Run it from an operator shell;
 * inside the bot sandbox the secrets dir is read-only and nothing is recorded.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { confirmManualEntriesForCards, listManualEntriesForCards } from "../../servers/shared/secret-values-collect.js";

const args = process.argv.slice(2);
if (args[0] !== "confirm" || args.length !== 1) {
  console.error("usage: keychain-card-secrets.mjs confirm   (interactive; picks are read from stdin)");
  process.exit(2);
}
const nonce = randomBytes(32);
const rows = listManualEntriesForCards({ nonce });
if (!rows.length) { console.log("No readable manual keychain entries."); process.exit(0); }
for (const r of rows) {
  console.log(String(r.id).padStart(5) + "  " + r.fingerprint + "  " + r.label + (r.duplicateLabel ? "  (label repeats)" : ""));
}
console.log("Pick entries: one id:fingerprint per line, an empty line to finish.");
const rl = createInterface({ input: process.stdin });
const pairs = [];
let bad = false;
for await (const line of rl) {
  const t = line.trim();
  if (!t) break;
  const m = t.match(/^(\d+):([0-9a-f]{8})$/);
  if (!m) { bad = true; console.error("not id:fingerprint: " + JSON.stringify(t.slice(0, 40))); continue; }
  pairs.push({ id: Number(m[1]), fingerprint: m[2] });
}
rl.close();
if (bad || !pairs.length) { console.error("Nothing recorded."); process.exit(1); }
const n = confirmManualEntriesForCards({ pairs, nonce });
if (n === 0) { console.error("Nothing recorded: an id was not found or its fingerprint does not match."); process.exit(1); }
console.log(n + " entr" + (n === 1 ? "y" : "ies") + " confirmed for approval cards.");
