/**
 * Where the gateway's own DB and keychain key live — the ONE pair the seal, its read-back
 * proof, and the spawn-time unseal must all use (0.7), so a proof can never pass against a
 * different database than the child's env came from.
 *
 * This lives in a gateway-side file, not in servers/shared/addon-secrets.js, because it
 * imports servers/db.js: the shared module stays free of DB-path resolution so a child, a
 * CLI or the wall profile can import it.
 *
 * resolveDbPath() is the same resolver chain createDbClient uses (servers/db.js), NOT
 * resolveInstanceDataDir(): that one falls back to os.homedir() and can name a different
 * file in a process whose HOME differs from the instance's.
 */
import { resolveCrowHome } from "../shared/crow-home.js";
import { resolveDbPath } from "../db.js";
import { keychainKeyPath } from "./keychain/key.js";

/** `{ dbPath, keyPath }` for this process's instance, resolved at call time. */
export function gatewayKeychainPaths() {
  return { dbPath: resolveDbPath(), keyPath: keychainKeyPath(resolveCrowHome()) };
}