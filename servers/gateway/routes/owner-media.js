/**
 * The OWNER's media route — `GET /dashboard/media/:key(*)`.
 *
 * Why it exists: `GET /storage/file/:key(*)` (routes/storage-http.js) sits
 * behind the MCP BEARER auth (requireBearerAuth reads only `Authorization`),
 * and a browser `<img>` / `<audio>` sends only the `crow_session` cookie — so
 * every image in the blog panel's draft preview, the editor's live preview,
 * the post list's thumbnails and the Files panel was a 401. This route is the
 * same read on the DASHBOARD's own door instead.
 *
 * What it is NOT: a loosening. It is mounted behind `dashboardAuth` (the real
 * session validator in servers/gateway/dashboard/auth.js, not a cookie-name
 * check), it reads only the `storage_files` row of the key it was asked for —
 * with no reference, post or project rule of its own, because the owner's own
 * file manager must show unpublished files too — and it never appears in
 * PUBLIC_FUNNEL_PREFIXES, so the gateway's Funnel middleware refuses a
 * `Tailscale-Funnel-Request` before this router is reached (the test in
 * tests/blog-media-published-only.test.js pins both).
 *
 * The bytes are PROXIED, never a redirect to a presigned URL: the object store
 * lives on `http://…:9000`, and a redirect there under an HTTPS Serve is
 * mixed content the browser blocks. The type rule (inline allowlist, otherwise
 * `attachment` + a sandboxing CSP) is servers/blog/media-policy.js's, the same
 * one `/blog/media` uses.
 */
import { Router } from "express";
import { createDbClient } from "../../db.js";
import { isAvailable, getObject } from "../../storage/s3-client.js";
import { setMediaResponseHeaders } from "../../blog/media-policy.js";

const NOT_FOUND = "Not found";

/**
 * @param {Function|null} dashboardAuth the dashboard's session middleware
 *   (servers/gateway/dashboard/auth.js) — it also applies the network gate and
 *   refuses Funnel traffic; with no middleware the route is left bare, which
 *   only a test does.
 * @param {object} [deps]
 * @param {{ isAvailable?: Function, getObject?: Function }} [deps.storage]
 *   Test seam for the object store (as blog-public.js has): a test that asserts
 *   which bytes and headers a key answers with must not need a live MinIO.
 *   Production passes nothing and the storage client is used as-is.
 * @returns {Router}
 */
export default function ownerMediaRouter(dashboardAuth, { storage = {} } = {}) {
  const router = Router();
  const auth = dashboardAuth ? [dashboardAuth] : [];
  const storageIsAvailable = storage.isAvailable || isAvailable;
  const storageGetObject = storage.getObject || getObject;

  router.get("/dashboard/media/:key(*)", ...auth, async (req, res) => {
    const s3Key = req.params.key;
    if (!s3Key) return res.status(404).type("text/plain").send(NOT_FOUND);

    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: "SELECT mime_type, bucket FROM storage_files WHERE s3_key = ? LIMIT 1",
        args: [s3Key],
      });
      if (rows.length === 0) return res.status(404).type("text/plain").send(NOT_FOUND);
      const file = rows[0];

      if (!(await storageIsAvailable())) {
        return res.status(503).type("text/plain").send("Storage unavailable");
      }

      // The row's OWN bucket: a key is only meaningful inside the bucket it was
      // stored in (an upload may name one). Empty means the client's default.
      const bucket = file.bucket ? String(file.bucket) : "";
      const { stream, stat } = bucket
        ? await storageGetObject(s3Key, { bucket })
        : await storageGetObject(s3Key);

      // private + no-store: this is the owner's own view of a file that may not
      // be published yet, and a shared cache must never keep a copy. The type
      // goes through media-policy's single parse — the stored string (and the
      // object store's content-type fallback) is untrusted text, so only a
      // clean essence is emitted, never the raw value.
      setMediaResponseHeaders(res, {
        mimeType: file.mime_type,
        objectContentType: stat.metaData?.["content-type"],
        s3Key,
        cacheControl: "private, no-store",
      });
      res.set("Content-Length", String(stat.size));
      stream.pipe(res);
    } catch (err) {
      // A missing object, an unreadable row and a storage error all read the
      // same: the owner sees "not found", never a stack or a bucket name.
      console.warn("[media] owner media error:", err.message);
      if (!res.headersSent) res.status(404).type("text/plain").send(NOT_FOUND);
    } finally {
      db.close();
    }
  });

  return router;
}