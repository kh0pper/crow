---
title: Project Spaces
description: First-class shareable workspaces with members, capabilities, attached assets, and an audit trail.
---

# Project Spaces

A **project space** is the unit of shareable, collaborative work in Crow. Every project space has:

- A **slug** (human-readable, used in URLs and storage paths)
- A **workspace directory** on disk for bots and agents to write into
- A **MinIO storage prefix** for project-scoped files
- **Members** with roles and per-member capability overrides
- An **audit log** of who did what, when
- Optional **attached assets**: research sources, notes, data backends, files

Project spaces are first-class in Crow's MCP surface — your AI can create them, share them, manage members, and reason about them. They are also where bots operate: a bot's workspace IS the project's workspace.

## Quick start

```
"Create a project called Spring 2026 Research with description ..."
```

The AI calls `crow_create_project`. Behind the scenes, Crow creates:
- A row in `project_spaces` (with a generated slug like `spring-2026-research-12`)
- An owner row in `project_members` for the local user
- A workspace directory at `~/.crow/data/projects/<slug>/workspace/`
- A MinIO key prefix `crow-files/projects/<slug>/`

You can immediately add sources, notes, data backends, and members.

## Members and roles

Every project space has at least one member: the local user (its creator, as `owner`). Adding a contact as a member grants them a role.

| Role | Default Capabilities |
|---|---|
| **owner** | All capabilities, including `manage_members` and `delete_project` |
| **editor** | Read + write on sources, notes, files, and tasks. `invoke_bot`. `query_backend`. |
| **viewer** | Read on sources, notes, files, tasks. |
| **guest** | Read on sources and notes only. |

The role sets *default* capability bundles. Per-member overrides can flip any capability on or off via a JSON object:

```json
{"invoke_bot": false}
```

For example: "Robin is an editor but can't talk to the bot" — set role=editor + capabilities `{"invoke_bot": false}`. Or: "Sam is a guest but can query the tea-data backend" — set role=guest + capabilities `{"query_backend:tea-data": true}`.

### Adding a member

Via the AI:

```
"Add Robin to project #12 as an editor without invoke_bot"
```

The AI calls `crow_add_member` with the project id, contact id, role, and capability JSON.

Via the dashboard: open the project's detail view, scroll to the **Members** section, fill in the small inline form (contact dropdown + role select + optional capability JSON), submit.

### Removing a member

Via the AI:

```
"Revoke Robin's access to project #12"
```

`crow_remove_member` performs a soft-revoke (sets `revoked_at`; doesn't delete the row). The member's capabilities go to zero immediately. The audit log records who revoked and when.

Via the dashboard: click the **revoke** button in the member row.

## Capabilities

Capabilities are boolean gates checked at every write path:

| Capability | Gated path |
|---|---|
| `read_sources`, `read_notes`, `read_files`, `read_tasks` | (currently advisory — read paths in Phase 1 are local-only) |
| `write_sources` | `crow_add_source` when `project_id` is set |
| `write_notes` | `crow_add_note` when `project_id` is set |
| `write_files` | `crow_upload_file` + `POST /storage/upload` when `project_id` is set |
| `write_tasks` | (advisory — task writes flow through the bundle's own tools) |
| `invoke_bot` | Bot inbound: Gmail allowlist + future Nostr peer routes |
| `query_backend` (master) + `query_backend:<id>` (per-backend overrides) | Bot's data-backend allowlist |
| `manage_members` | `crow_add_member`, `crow_remove_member`, `crow_share` (project mode) |
| `delete_project` | (advisory — Phase 1 uses soft archive) |

Capabilities are resolved at the moment of the write: role default ⇒ per-member JSON override ⇒ final boolean.

## Workspace directory

Every project gets a directory at `~/.crow/data/projects/<slug>/workspace/`. This is:

- Where bots assigned to the project write artifacts (`<workspace>/bots/<bot_id>/`)
- The default `write_paths` entry for bots in the project
- Available to agents via the `crow_workspace_dir` MCP tool

The directory persists across project archive (it's only deleted on hard delete).

## Attaching assets

### Sources and notes

When you `crow_add_source` or `crow_add_note` with a `project_id`, Crow:

1. Checks `write_sources` / `write_notes` capability for the local user
2. Inserts the row with the project_id
3. Appends a `source.add` / `note.add` audit entry

### Files

`crow_upload_file` and `POST /storage/upload` accept an optional `project_id`. When set:

- The caller must have `write_files`
- The file is stored under `crow-files/projects/<slug>/...`
- `storage_files.project_id` is set
- A `file.upload` audit entry is written
- If `reference_id` is also set (e.g., for a source's attachment), the referenced row's project must match — Crow rejects cross-project file references

Files uploaded *without* `project_id` retain pre-redesign behavior (visible to the logged-in user, no project ACL applied).

### Data backends

`crow_register_backend` already supports `project_id`. A bot assigned to the project inherits its project's backends (via `query_backend` capability resolution).

## Bots and project spaces

A bot's **project** is set on the `pi_bot_defs.project_id` column. When the bridge spawns a turn for a project-native bot:

1. `session_dir` resolves to `<project workspace>/bots/<bot_id>/`
2. The prompt receives a structured context block (project name, slug, workspace path, member list)
3. The Kanban snapshot reads from the project's `tasks_db_uri` (falls back to the bundle default)
4. Every turn appends a `bot.invoke` audit entry (or `bot.error` on failure)
5. The Gmail inbound allowlist is the union of the static operator addresses + every project member's email with `invoke_bot=true`

Edit a bot's project via the Bot Builder panel's **Project / Kanban** tab.

## Audit log

Every meaningful mutation appends to `project_audit_log`:

| Action | Written by |
|---|---|
| `member.add`, `member.update`, `member.revoke` | Project tools + projects panel |
| `source.add`, `note.add`, `file.upload` | Add-source / add-note / upload (when project_id set) |
| `bot.invoke`, `bot.error` | Bot bridge after every turn |
| `share.send`, `share.revoke`, `share.received` | Project sharing flow |

View it in the dashboard's Audit log section, or via the `crow_audit_log` MCP tool:

```
"Show me the last 20 audit entries for project #12"
```

## Sharing project spaces

See the [Data Sharing guide](./data-sharing) for the full sharing model.

In Phase 1, **clone mode** is the only mode shipping. A clone delivers:

- The project metadata row
- All sources and notes
- The audit log up to the snapshot moment
- Manifests of data backends (env-var names only — never secrets)
- A manifest of project files (with 24-hour presigned URLs the recipient can use to pull blobs out-of-band)

The recipient gets a new independent project with a `-clone-N` slug. No further sync. The origin records a `share.send` audit entry and a `project_members` row (with `mode='clone'`) so future revocation can find the share record.

Subscription (live one-way sync) and federated read are planned follow-on milestones.

## Archive vs delete

Phase 1 uses **soft archive**: changing a project's status to `archived` sets `archived_at` and hides the project from active listings. Sources, notes, members, audit, and the workspace directory are preserved. The project can be unarchived from the dashboard at any time.

Hard delete (drop the workspace dir, cascade everything) is not implemented in Phase 1 — file your decision before re-implementing as a one-way operation.

## See also

- [Sharing guide](./sharing) — peer connections and the broader share model
- [Data Sharing guide](./data-sharing) — clone / subscription / federated-read sharing modes
- [Data Backends guide](./data-backends) — connecting external MCP servers as project assets
