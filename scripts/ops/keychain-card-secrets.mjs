#!/usr/bin/env node
/**
 * Operator step (approval-card secret masking, 2026-10-26): confirm manual
 * keychain entries saved BEFORE the card list existed, one by one, so they may
 * hide text on bot approval cards. Entries saved through the keychain UI from
 * now on are recorded automatically. Shows labels and ids, never values.
 *
 *   node scripts/ops/keychain-card-secrets.mjs list
 *   node scripts/ops/keychain-card-secrets.mjs confirm <id> [<id> ...]
 *
 * Confirm only entries you recognise: a bot with a shell can mark a keychain
 * row as manual in crow.db. Uses this shell's CROW_HOME / CROW_DATA_DIR (the
 * default instance when unset). Run it from an operator shell; inside the bot
 * sandbox the secrets dir is read-only and nothing can be recorded.
 */
import { confirmManualEntriesForCards, listManualEntriesForCards } from "../../servers/shared/secret-values-collect.js";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "list") {
  const rows = listManualEntriesForCards();
  if (!rows.length) console.log("No readable manual keychain entries.");
  for (const r of rows) console.log(String(r.id).padStart(5) + "  " + r.label);
} else if (cmd === "confirm" && rest.length) {
  const ids = rest.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const n = confirmManualEntriesForCards({ ids });
  console.log(n + " of " + ids.length + " entr" + (ids.length === 1 ? "y" : "ies") + " confirmed for approval cards.");
} else {
  console.error("usage: keychain-card-secrets.mjs list | confirm <id> [<id> ...]");
  process.exit(2);
}
