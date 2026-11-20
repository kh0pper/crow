/**
 * Fixture for tests/sync-stamp.test.js's concurrent-first-boot race test.
 * Calls getOrCreateLocalInstanceId() once and prints the result to stdout —
 * spawned as its own process (CROW_DATA_DIR set by the caller) so two
 * racers genuinely race the check-then-write against one on-disk file.
 *
 * `--no-hardlinks` makes every link(2) fail with EPERM — the shape of a
 * filesystem without hard links — so the same race can be run over the
 * module's exclusive-create fallback. The stub is injected through
 * getOrCreateLocalInstanceId's `link` option (the module's test seam): the
 * real function then takes its `no-hardlinks` branch exactly as it would on
 * such a mount.
 */
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";

const noHardlinks = process.argv.includes("--no-hardlinks");
const link = noHardlinks
  ? () => {
    const err = new Error("EPERM: operation not permitted, link");
    err.code = "EPERM";
    throw err;
  }
  : undefined;

process.stdout.write(getOrCreateLocalInstanceId(link ? { link } : {}));