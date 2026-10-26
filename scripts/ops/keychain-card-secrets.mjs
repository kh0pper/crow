#!/usr/bin/env node
/**
 * Operator step (approval-card secret masking, 2026-10-26): confirm manual
 * keychain entries saved BEFORE the card list existed, one by one, so they may
 * hide text on bot approval cards. Entries saved through the keychain UI from
 * now on are recorded automatically. Never prints a value.
 *
 *   node scripts/ops/keychain-card-secrets.mjs list
 *   node scripts/ops/keychain-card-secrets.mjs confirm <id>:<hash> [<id>:<hash> ...]
 *
 * `list` shows each entry's id, a fingerprint (first and last two characters
 * for values of 12+ characters, and 8 hex of its sha256) and its label, with
 * control characters stripped. Labels live in crow.db, which a bot with a
 * shell can write, so check the fingerprint against the password you know,
 * not the label. `confirm` re-decrypts the entries and records them only if
 * every fingerprint still matches. Uses this shell's CROW_HOME / CROW_DATA_DIR
 * (the default instance when unset). Run it from an operator shell; inside
 * the bot sandbox the secrets dir is read-only and nothing can be recorded.
 */
import { confirmManualEntriesForCards, listManualEntriesForCards } from "../../servers/shared/secret-values-collect.js";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "list") {
  const rows = listManualEntriesForCards();
  if (!rows.length) console.log("No readable manual keychain entries.");
  for (const r of rows) {
    console.log(String(r.id).padStart(5) + "  " + r.fingerprint.padEnd(16) + "  " + r.label + (r.duplicateLabel ? "  (label repeats: check the fingerprint)" : ""));
  }
} else if (cmd === "confirm" && rest.length) {
  const pairs = rest.map((a) => {
    const i = a.indexOf(":");
    return i > 0 ? { id: Number(a.slice(0, i)), fingerprint: a.slice(i + 1) } : null;
  });
  if (pairs.some((p) => !p || !Number.isInteger(p.id) || !p.fingerprint)) {
    console.error("each entry is <id>:<hash>, the hash as `list` prints it");
    process.exit(2);
  }
  const n = confirmManualEntriesForCards({ pairs });
  if (n === 0) {
    console.error("Nothing recorded: an id was not found or its fingerprint no longer matches.");
    process.exit(1);
  }
  console.log(n + " entr" + (n === 1 ? "y" : "ies") + " confirmed for approval cards.");
} else {
  console.error("usage: keychain-card-secrets.mjs list | confirm <id>:<hash> [...]");
  process.exit(2);
}
