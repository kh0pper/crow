---
name: crow-crosspost
description: F.12 cross-app publishing — mirror a post from one federated bundle to another via pure-function transforms.
triggers:
  - "cross-post"
  - "crosspost"
  - "mirror post to"
  - "publish to both"
  - "mastodon and"
  - "share my post to"
tools:
  - crow_crosspost
  - crow_crosspost_cancel
  - crow_crosspost_mark_published
  - crow_list_crossposts
  - crow_list_crosspost_transforms
---

# Crow Cross-Posting (F.12.2)

Publish a post from one federated bundle (source) to another (target) via a pure-function transform from `servers/gateway/crossposting/transforms.js`. This skill is for **operator-initiated or rule-driven** cross-posts — NOT for automatic firehose mirrors.

## Design invariants

- **Idempotency is required.** Every call to `crow_crosspost` needs an `idempotency_key` (typically `sha256(source_app + source_post_id + target_app)`). Duplicate keys within 7 days return the cached result; they do not re-queue.
- **60-second publish delay by default.** When a rule fires on `on_publish` or `on_tag`, the cross-post is queued with a 60-second delay and a Crow notification surfaces ("About to cross-post to mastodon. Cancel?"). The operator can cancel before it fires. `trigger: "manual"` fires immediately (operator already chose).
- **No fake undo after publish.** Cross-posts cannot be reliably retracted. Delete activities propagate asynchronously and inconsistently across the fediverse. Treat every publish as permanent.
- **This tool only produces the transformed payload + audit log entry.** It does NOT invoke the target bundle's publish API directly — the caller (usually a rule dispatcher) must invoke the target's `<app>_post` / `<app>_post_photo` / `<app>_upload_video` tool with the transformed payload, then call `crow_crosspost_mark_published` to close the log entry.

## Available transforms

```
crow_list_crosspost_transforms {}
# → { pairs: ["writefreely→mastodon", "gotosocial→mastodon", "pixelfed→mastodon",
#              "funkwhale→mastodon", "peertube→mastodon", "blog→gotosocial"] }
```

Transforms are pure functions — no network I/O. Each respects the target app's character limits, includes an attribution footer linking to the canonical source, and strips HTML → plaintext for targets that don't accept HTML.

Adding a new transform: edit `servers/gateway/crossposting/transforms.js`, pick a `(source_app, target_app)` pair where BOTH speak the fediverse, follow the rules in the file's top comment.

## Common workflows

### Manual one-off cross-post

```
# 1. Compute the idempotency key
idem = sha256("writefreely:42:mastodon")

# 2. Queue (fires immediately with trigger=manual)
crow_crosspost {
  "source_app": "writefreely",
  "source_post_id": "42",
  "source_post": {
    "title": "My latest post",
    "content": "<p>Long-form body…</p>",
    "url": "https://blog.example.com/my-latest-post"
  },
  "target_app": "mastodon",
  "idempotency_key": "<idem>",
  "trigger": "manual",
  "confirm": "yes"
}
# → { log_id, status: "ready", transformed_preview: { status: "📝 My latest post..." } }

# 3. Publish the transformed payload via the target bundle's tool
mastodon_post {
  "status": "<transformed_preview.status>",
  "visibility": "public"
}
# → { id: "109xxx", url: "..." }

# 4. Close the audit log entry
crow_crosspost_mark_published {
  "log_id": <log_id>,
  "target_post_id": "109xxx"
}
```

### Rule-driven cross-post with delay

```
crow_crosspost {
  "source_app": "pixelfed",
  "source_post_id": "8b3f...",
  "source_post": { "content_excerpt": "Sunset shot", "url": "https://photos.example.com/p/8b3f", "sensitive": false },
  "target_app": "mastodon",
  "idempotency_key": "<idem>",
  "trigger": "on_publish",
  "confirm": "yes"
}
# → { log_id, status: "queued", scheduled_at: <now + 60>, delay_seconds: 60 }
# A Crow notification surfaces with the cancel link.
```

Operator can cancel before `scheduled_at`:
```
crow_crosspost_cancel { "log_id": <id> }
```

After `scheduled_at` passes, a future dispatcher (not yet shipped — lands in a follow-up) calls the target app's publish verb + `crow_crosspost_mark_published`.

### List recent cross-posts

```
crow_list_crossposts { "status": "queued" }
# → Pending queue with countdown to scheduled_at

crow_list_crossposts { "limit": 50 }
# → All recent cross-posts with status + target_post_id
```

## Integration with F.11 identity attestation

If you've attested your handles on the source and target apps, cross-posts inherit the identity claim: a verifier fetching `.well-known/crow-identity.json` on your gateway sees both handles bound to the same crow_id. This makes cross-posts visibly yours rather than looking like spam from an unrelated account.

## Safety notes

- **Publish delay is the safety valve.** Don't set `delay_seconds: 0` on `on_publish` rules unless you're confident. The 60s default exists because LLMs making autonomous posts can make errors that are easier to catch pre-publish than retract post-publish.
- **Never cross-post DMs.** The `source_post.visibility` field is passed through but defaults to `public` — if the source post was `direct` or `private`, the operator should explicitly set the target's visibility to match.
- **Cross-posts are attribution-footered.** The transform always emits a `via <source_url>` line so viewers on the target can navigate back to the canonical post. If you strip the footer in a custom transform, viewers will see a bare mirror — and delete-propagation being unreliable, that mirror may outlive the source.
- **Idempotency scope is per-Crow-instance.** Two different Crows cross-posting the same source post will not dedupe each other — that's by design.

## Log retention

Entries >30 days are garbage-collected by the daily cleanup sweeper (not yet wired — manual `DELETE FROM crosspost_log WHERE created_at < strftime('%s', 'now', '-30 days')` until F.12.3 or similar).
