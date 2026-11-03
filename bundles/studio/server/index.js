#!/usr/bin/env node

/**
 * Studio MCP server — the stdio entry point.
 *
 * One process per MCP client. It holds no song state of its own: every read and
 * edit goes to the session hub in the Crow gateway over the loopback agent API
 * (`server/hub-client.js`), and every render runs here, offline, in the same
 * engine the operator's browser plays.
 *
 * The app modules come through `appImport` (this bundle is installed under
 * `~/.crow/bundles/studio`, so `servers/…` never resolves by itself):
 *
 *   - the database client, for the renderer's storage row and its ACL check;
 *   - the S3 client, for the render's upload and download URL, and for reading
 *     back the recorded takes a render plays;
 *   - the project ACL, so a render is refused where writing is refused;
 *   - the research server's actor helpers, which say whether this call comes
 *     from a Crow bot — the MCP tool layer still forces the author to an agent.
 *
 * Nothing here opens a port: stdio only.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appImport } from "./app-root.js";
import { createHubClient } from "./hub-client.js";
import { createRenderer } from "./render.js";
import { createStudioServer } from "./mcp.js";

/** The app's db client, opened on this instance's crow.db. */
const { createDbClient } = await appImport("servers/db.js");
const db = createDbClient();

/**
 * The S3 client, with the instance's Shared Storage settings opened from the
 * database when an identity is present (the env fallback otherwise). A failure
 * here must not stop the server: edits still work, and a render reports the
 * storage problem its own way.
 * @returns {Promise<object|null>} the s3-client module, or null
 */
async function storageModule() {
  try {
    const storage = await appImport("servers/storage/s3-client.js");
    try {
      const { loadIdentityIfPresent } = await appImport("servers/sharing/identity.js");
      const identity = typeof loadIdentityIfPresent === "function" ? loadIdentityIfPresent() : null;
      if (identity && typeof storage.useDbStorageConfig === "function") {
        await storage.useDbStorageConfig({ db, identity });
      }
    } catch {
      // No identity (or an unreadable one): the env fallback stays in effect.
    }
    return storage;
  } catch {
    return null;
  }
}

const [storage, acl, actor] = await Promise.all([
  storageModule(),
  appImport("servers/shared/project-acl.js"),
  appImport("servers/research/actor.js"),
]);

/** What a render reports when this instance has no storage configured. */
const STORAGE_UNAVAILABLE = "Studio cannot save a render: Crow storage is not available on this instance.";

/** The storage the renderer uploads through; a clear refusal when there is none. */
const renderStorage = storage || {
  uploadObject: async () => {
    throw new Error(STORAGE_UNAVAILABLE);
  },
  getPresignedUrl: async () => {
    throw new Error(STORAGE_UNAVAILABLE);
  },
  // A render that plays recorded takes reads them back through this; without
  // storage there is nothing to read, and the refusal says so once.
  getObject: async () => {
    throw new Error(STORAGE_UNAVAILABLE);
  },
  deleteObject: async () => {
    throw new Error(STORAGE_UNAVAILABLE);
  },
};
if (!storage) console.warn(`[studio] ${STORAGE_UNAVAILABLE}`);

const hub = createHubClient();
const renderer = createRenderer({ db, storage: renderStorage, acl });
const server = createStudioServer({ hub, renderer, actor });

await server.connect(new StdioServerTransport());