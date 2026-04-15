# S3-capable bundles

Any Crow bundle that stores user-generated media (music, photos, videos, documents) can opt in to the platform's **shared S3 storage** — one MinIO (or any S3-compatible endpoint) that every paired Crow instance points at.

When a bundle opts in:

- The operator configures **one** set of credentials in the Nest (Settings → Multi-Instance → Shared Storage).
- Credentials replicate to every paired instance (sealed at rest via `secret-box` so feed files never hold plaintext).
- The bundle install flow injects the right app-specific env vars into `<bundle>/.env` automatically, using the translator layer that already knows `AWS_*`, `S3_*`, `PEERTUBE_OBJECT_STORAGE_*`, and `AWS_STORAGE_BUCKET_NAME`.
- The Shared Storage panel surfaces a "drift" badge when the bundle's on-disk config doesn't match current DB config, with an **Apply** button that rewrites the block and `docker compose up -d --force-recreate`s.

## Minimal adopter checklist

1. **Add a `storage` block to the bundle manifest**:

   ```json
   {
     "id": "mybundle",
     "storage": {
       "translator": "mastodon",
       "bucket": "mymedia"
     }
   }
   ```

   - `translator` — must match a key in `servers/gateway/storage-translators.js::TRANSLATORS`. Currently: `funkwhale`, `mastodon`, `peertube`, `pixelfed`. To add a new app, extend the translator map and add a test fixture.
   - `bucket` — suffix appended to `storage.shared.bucket_prefix`. For a shared storage prefix of `crow` and `bucket: "mymedia"`, the bundle gets `crow-mymedia`.

2. **Reference the env vars in the bundle's `docker-compose.yml`** exactly as the translator emits them. Each translator documents its shape at the top of `storage-translators.js`. Mastodon example:

   ```yaml
   environment:
     S3_ENABLED: ${S3_ENABLED:-}
     S3_BUCKET: ${S3_BUCKET:-}
     S3_REGION: ${S3_REGION:-}
     S3_HOSTNAME: ${S3_HOSTNAME:-}
     S3_ENDPOINT: ${S3_ENDPOINT:-}
     AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:-}
     AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-}
   ```

3. **Nothing else**. The gateway install flow (`servers/gateway/routes/bundles.js::installBundle`) step 2.5 auto-detects the manifest's `storage.translator`, opens the sealed credentials via secret-box, runs `translate(...)`, and writes a managed block to `<bundle>/.env`:

   ```
   # crow-shared-storage BEGIN (managed by gateway — do not edit)
   # crow-shared-storage-version: <sha256-hex>
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   ...
   # crow-shared-storage END
   ```

   The version stamp is `sha256(JSON.stringify(sortedKeys.map(k => [k, translated[k]])))` over the **plaintext** translator output, so fresh-nonce re-seals don't spuriously signal drift. The Nest Shared Storage panel reads this stamp via `readManagedBlockVersion()` and surfaces bundles that are out of date.

## Verifying the adoption

After shipping a manifest change:

```bash
# List all adopters
grep -l '"translator":' bundles/*/manifest.json

# Inspect an installed bundle's managed block after install
cat ~/.crow/bundles/<id>/.env | sed -n '/# crow-shared-storage BEGIN/,/# crow-shared-storage END/p'
```

In the Nest: Settings → Multi-Instance → Shared Storage. Installed S3-capable bundles appear at the bottom with an "in sync" / "drifted" / "missing" badge.

## What's NOT automatic

- **Enforcement** — the bundle's own compose must reference the env vars. The gateway only writes them; containers read them on first start.
- **Reconfiguration on credential change** — click **Apply** on the Shared Storage panel, or enable `storage.local.auto_apply_to_bundles` (local-only, not synced) to auto-recreate after every save.
- **Pre-existing bundle installs** — if a bundle was installed before it gained a `storage.translator`, uninstall + reinstall, or use the Apply button once the bundle declares it.

## The translator layer

`servers/gateway/storage-translators.js` takes a canonical Crow record:

```js
{ endpoint: "http://host:port", region: "us-east-1", bucket: "crow-mybundle", accessKey: "...", secretKey: "..." }
```

and returns the app-specific env kv pairs. To add a new app, add an entry to the `TRANSLATORS` map and (recommended) a fixture in `scripts/ops/verify-secret-box.mjs`-style smoke script.

Both the gateway install flow and the standalone `bundles/funkwhale/scripts/configure-storage.mjs` tool call the same `translate()` — no divergence between installed-via-Nest and manual env-edit paths.
