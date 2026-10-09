// Child process for the R-M5 cross-process quota test (tests/artifacts-model.test.js).
import { createDbClient } from "../../servers/db.js";
import { createLocalBlobStore } from "../../bundles/artifacts/server/blob-store.js";
import * as store from "../../bundles/artifacts/server/store.js";
import { _overrideLimitsForTest } from "../../bundles/artifacts/server/limits.js";
const [dbPath, blobRoot, cap, tag] = process.argv.slice(2);
_overrideLimitsForTest({ instanceBytes: Number(cap) });
const db = createDbClient(dbPath);
const blobs = createLocalBlobStore(blobRoot);
try {
  await store.createArtifact(db, blobs, { title: "P" + tag, type: "page", source: { html: tag.repeat(200000) + String(process.pid) }, actor: { kind: "session" } }, {});
  process.stdout.write("ok");
} catch (e) { process.stdout.write(e.code || e.message); }
db.close();
