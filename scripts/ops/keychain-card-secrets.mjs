#!/usr/bin/env node
/**
 * Operator step (approval-card secret masking, 2026-10-26): confirm the manual
 * keychain entries saved BEFORE the card list existed, so they may hide text
 * on bot approval cards. Entries saved through the keychain UI from now on are
 * recorded automatically. Prints a count, never a value.
 *
 *   node scripts/ops/keychain-card-secrets.mjs confirm
 *
 * Uses this shell's CROW_HOME / CROW_DATA_DIR (the default instance when
 * unset). Run it from an operator shell, not from a bot: inside the bot
 * sandbox the secrets dir is read-only and this cannot record anything.
 */
import { confirmManualEntriesForCards } from "../../servers/shared/secret-values-collect.js";

const cmd = process.argv[2];
if (cmd !== "confirm") {
  console.error("usage: keychain-card-secrets.mjs confirm");
  process.exit(2);
}
const n = confirmManualEntriesForCards();
console.log(n + " manual keychain entr" + (n === 1 ? "y" : "ies") + " confirmed for approval cards.");
