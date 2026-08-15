/**
 * Fixture for tests/sync-stamp.test.js's concurrent-first-boot race test.
 * Calls getOrCreateLocalInstanceId() once and prints the result to stdout —
 * spawned as its own process (CROW_DATA_DIR set by the caller) so two
 * racers genuinely race the check-then-write against one on-disk file.
 */
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";

process.stdout.write(getOrCreateLocalInstanceId());
