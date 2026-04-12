---
name: forgejo
description: Forgejo — community-driven soft-fork of Gitea for self-hosted git
triggers:
  - "forgejo"
  - "federated git"
  - "codeberg"
  - "community git"
  - "servidor git comunitario"
tools:
  - forgejo_list_repos
  - forgejo_repo_info
  - forgejo_create_repo
  - forgejo_list_issues
  - forgejo_create_issue
---

# Forgejo — community-driven git

Forgejo is a community-governed, AGPL-licensed soft-fork of Gitea. It runs
on Codeberg.org and is API-compatible with Gitea's v1 REST endpoints.

## Why both Gitea and Forgejo?

Both bundles ship because the choice is principled, not technical:

- **Gitea** is the upstream project with the broader ecosystem and a
  Business Source License for newer code.
- **Forgejo** is a fork started in 2022 after governance changes at Gitea.
  It stays fully AGPL-licensed, is governed by the Codeberg e.V.
  non-profit, and actively works on ActivityPub federation so forges can
  follow each other like Mastodon instances.

Install whichever matches your values. Running both on the same host is
fine — the default ports do not collide (Gitea 3040/2223, Forgejo
3050/2224).

## First-run setup

1. Start the bundle from the Extensions panel.
2. Open **http://localhost:3050** in a browser.
3. Complete the initial setup wizard. The database is preconfigured to
   SQLite.
4. Set a strong admin username + password and click Install.
5. Log in as admin, then go to **Settings > Applications > Generate New
   Token**. Give it the `repo`, `issue`, and `user` scopes.
6. Copy the token into your `.env` as `FORGEJO_TOKEN`, then reload Crow.

## Git over SSH

Forgejo's built-in SSH server listens on host port **2224**:

```
ssh://git@localhost:2224/username/repo.git
```

The short `git@host:user/repo` scp-style syntax hits port 22 and will
NOT reach Forgejo. Use the full URL or an `~/.ssh/config` alias:

```
Host myforgejo
  HostName localhost
  Port 2224
  User git
```

## ActivityPub federation (optional, future)

Forgejo's federation features are maturing. If you want other forges to
follow your repos, you'll eventually need a public HTTPS domain served
through the Caddy bundle (`requires.bundles: ["caddy"]`) and a valid TLS
cert. Until then, Forgejo still works perfectly as a standalone self-
hosted git service — federation is opt-in.

## Backups

Everything lives in `~/.crow/forgejo/data`. Back up that directory to
preserve repos, issues, attachments, and the SQLite database.
