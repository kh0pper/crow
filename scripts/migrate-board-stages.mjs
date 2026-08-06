// scripts/migrate-board-stages.mjs
//
// Thin wrapper. The migration itself now lives in the registry at
// scripts/migrations/0001-board-stages.mjs and runs automatically at gateway
// boot for whichever instance is booting. This entry point stays for manual and
// deploy-script invocation, and resolves the same per-instance paths it always
// did.
import { tasksDbPath, botsDbPath } from "./pi-bots/instance-paths.mjs";
import { run } from "./migrations/0001-board-stages.mjs";

const out = run({ dbPath: botsDbPath(), tasksDbPath: tasksDbPath(), log: (m) => console.log(m) });
if (out?.deferred) {
  console.log("  (deferred — a target table is absent on this instance; the registry will retry)");
}
