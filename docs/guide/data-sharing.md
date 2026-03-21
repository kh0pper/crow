---
title: Data Sharing
description: Share databases between Crow users using clone, federated read, or subscription modes.
---

# Data Sharing

Share databases with other Crow users. Three modes give you control over how much data travels and who can access it.

## Sharing Modes

| Mode | What Happens | Best For |
|---|---|---|
| **Clone** | Full copy of the database is sent to the recipient. They get an independent snapshot. | One-time handoffs, small datasets, offline access |
| **Federated Read** | Recipient queries your database remotely through the gateway proxy. No data is copied. | Large datasets, live data, controlled access |
| **Subscription** | Recipient receives ongoing updates as you modify the source database. | Collaborative projects, shared reference data |

## Clone

A clone sends a complete copy of a database file to a contact. The recipient gets their own independent copy — changes they make don't affect your original.

```
"Clone my county-data database and share it with Robin"
```

The AI uses `crow_share` with `share_type: "database"` and `mode: "clone"`. The database file transfers through Hypercore, the same P2P channel used for memory sharing.

### When to Clone

- The dataset is small enough to transfer comfortably (under ~500 MB)
- The recipient needs offline access
- You want to hand off a dataset without maintaining a connection

## Federated Read

Federated read gives a contact permission to run read-only queries against your database through the gateway proxy. No data is copied — queries execute on your machine and only results travel over the network.

```
"Give Robin read access to my tax-filings database"
```

The recipient can then query your database from their own AI or Data Dashboard. Requests are authenticated with bearer tokens and subject to the same [safety model](./data-dashboard#safety-model) as local queries.

### When to Federate

- The dataset is large and cloning would be impractical
- You want the recipient to always see the latest data
- You need to revoke access later without chasing down copies

Revoke access at any time:

```
"Revoke Robin's access to my tax-filings database"
```

## Subscription

A subscription is a persistent sync channel. When you update the source database, changes propagate to the subscriber automatically through Hypercore replication.

```
"Subscribe Robin to updates on my county-data database"
```

Subscriptions are one-directional — the subscriber receives your changes but their local modifications (if any) don't flow back to you.

### When to Subscribe

- Multiple people need the same reference dataset kept up to date
- You're maintaining a shared data source (e.g., a curated dataset for a research group)
- You want automated sync without manual re-sharing

## Managing Shared Databases

### List Active Shares

```
"Show me my shared databases"
```

### Check Share Status

The Nest's Sharing panel shows all active database shares, including mode, recipient, and last sync time.

### Revoking Access

All sharing modes support revocation:

- **Clone** — Nothing to revoke. The recipient already has a copy.
- **Federated Read** — Immediately stops query access.
- **Subscription** — Stops future updates. Data already received stays with the subscriber.

## Next Steps

- [Sharing Guide](./sharing) — General P2P sharing concepts
- [Data Dashboard](./data-dashboard) — Query and visualize shared databases
- [Data Backends](./data-backends) — Register databases for sharing
