---
name: crow-identity
description: Identity attestations — link federated app handles to your Crow root identity with signed, publicly-verifiable proofs.
triggers:
  - "attest identity"
  - "prove I am"
  - "link my mastodon"
  - "verify handle"
  - "keyoxide"
  - "crow identity attestation"
  - "revoke attestation"
tools:
  - crow_identity_attest
  - crow_identity_verify
  - crow_identity_revoke
  - crow_identity_list
---

# Crow Identity Attestations (F.11)

Crow's root Ed25519 identity can sign attestations for your per-app handles — your Mastodon `@alice@example.com`, your Funkwhale channel, your Matrix MXID, your Lemmy account. Remote viewers fetch these attestations from your gateway's `/.well-known/crow-identity.json` endpoint and verify the signatures cryptographically, giving them a portable "these handles are all the same person" proof that doesn't depend on any single platform.

This is **attestation, not key replacement.** Each federated app still uses its own native keys for federation. The Crow root key signs only the binding `(crow_id, app, external_handle)`.

## When to use this

- You run bundles on multiple federated apps and want followers to verify all your handles come from the same Crow.
- You're migrating platforms and want remote contacts to match your old handles to new ones via a signed trail.
- You want a Keyoxide/ariadne-style "proof set" anchored in your own infrastructure, not a third party.

## When NOT to use this

- **Ephemeral identities.** Once published via `.well-known`, attestations are permanent-until-explicitly-revoked. Revocations themselves are public. Don't attest alts you want deniable.
- **Pseudonymous accounts.** Attesting `@realname@work.example` and `@anonposter@shitposter.example` from the same crow_id links them cryptographically and forever.
- **You don't run the gateway.** Attestations are served from the Crow gateway's `.well-known` endpoints — without that, there's no publication surface.

## Workflow

### Attest a handle

```
crow_identity_attest {
  "app": "mastodon",
  "external_handle": "@alice@mastodon.example",
  "confirm": "yes"
}
```

Returns `{ attestation_id, crow_id, sig, publish_url }`. The attestation is immediately visible at `https://<your-gateway>/.well-known/crow-identity.json`.

Optional `app_pubkey` parameter when the app exposes a stable signing key you want included in the binding (Matrix MXID signing keys, Funkwhale actor keys).

### List your attestations

```
crow_identity_list {}
# or filter:
crow_identity_list { "app": "mastodon", "include_revoked": false }
```

### Verify

Local-DB verification (only works for attestations on THIS Crow instance):

```
crow_identity_verify {
  "crow_id": "crow:kdq7zskhat",
  "app": "mastodon",
  "external_handle": "@alice@mastodon.example"
}
```

Cross-instance verification is a plain HTTP fetch of the remote gateway's `.well-known` — no special tooling needed. Rate-limited at the server side to 60 req/min per remote IP to prevent verification storms.

### Revoke

```
crow_identity_revoke {
  "attestation_id": 42,
  "reason": "Account migrated to new instance",
  "confirm": "yes"
}
```

Revocations are signed and appear in `/.well-known/crow-identity-revocations.json`. The original attestation row stays in the DB marked revoked for audit; it no longer appears in the active attestations list.

### Key rotation

When a bundle rotates its app key (e.g., you regenerate your Mastodon OAuth app), call `crow_identity_revoke` on the old attestation and `crow_identity_attest` with the new `app_pubkey`. Version counter increments automatically. Verifiers that cached old versions see the revocation on next fresh fetch.

## Endpoints

- **`/.well-known/crow-identity.json`** — paginated active attestations, 256 per page, `?cursor=N` for next page. Cache-Control: 60s.
- **`/.well-known/crow-identity-revocations.json`** — paginated revocations with signed revocation proofs. Same pagination scheme.
- Both rate-limited to 60 requests/minute/IP. Both return 500 with `{ error }` if the DB is unavailable.

## Payload format

Canonical JSON (sorted keys) signed with the root Ed25519 private key:

```json
{
  "app": "mastodon",
  "app_pubkey": "optional",
  "created_at": 1744502400,
  "crow_id": "crow:kdq7zskhat",
  "external_handle": "@alice@mastodon.example",
  "version": 1
}
```

Signature is hex-encoded Ed25519 over the UTF-8 bytes of the canonical JSON. Verifiers MUST also check `verifyCrowIdBinding(crow_id, root_pubkey)` — the crow_id is derived from the root pubkey, and a swap attack is only caught if you verify the derivation (not just the signature).

## Safety notes

- **The root pubkey is in `.well-known`.** That's the whole point — it's the trust anchor. But it also means publication is permanent; losing the root private key while attestations are live creates an irrevocable attestation surface. Back up your identity seed (`npm run identity:export`).
- **No gossip over crow-sharing.** Per the plan, attestations are only published via `.well-known` for now. No Nostr, no Hypercore feed. Revisit after F.12 lands.
- **Pinned posts are manual.** You can paste an attestation blob into a pinned Mastodon toot (Keyoxide-style) — that's an operator choice, not automated, because automation would open forgery vectors.
