---
name: gitea
description: Gitea — self-hosted git service with issues, PRs, and built-in SSH
triggers:
  - "gitea"
  - "self-host git"
  - "git server"
  - "host my own repo"
  - "crear repo en gitea"
  - "servidor git"
tools:
  - gitea_list_repos
  - gitea_repo_info
  - gitea_create_repo
  - gitea_list_issues
  - gitea_create_issue
---

# Gitea — self-hosted git

Gitea is a lightweight, self-hosted git service. It handles code hosting,
issues, pull requests, and git over SSH with a built-in Go SSH server (no
host `sshd` required).

## First-run setup

1. Start the bundle from the Extensions panel.
2. Open **http://localhost:3040** in a browser.
3. Complete the initial setup wizard. The database is preconfigured to
   SQLite — leave those fields alone and scroll down.
4. Set a strong admin username + password under "Administrator Account
   Settings" and click Install.
5. Log in as the admin, then go to **Settings > Applications >
   Generate New Token**. Give it the `repo`, `issue`, and `user` scopes.
6. Copy the token into your `.env` as `GITEA_TOKEN`, then reload Crow.

## Git over SSH

Gitea's built-in SSH server listens on container port 22, mapped to host
port **2223**. Clone with an explicit port:

```
ssh://git@localhost:2223/username/repo.git
```

The short `git@host:user/repo` scp-style syntax silently hits port 22 and
will NOT reach Gitea. Always use the full `ssh://...:2223/...` form. If you
need the short form, add this to `~/.ssh/config`:

```
Host mygitea
  HostName localhost
  Port 2223
  User git
```

Then `git clone mygitea:username/repo.git` works.

## What the MCP tools can do

- `gitea_list_repos` — list the repos the token owner can see
- `gitea_repo_info` — details for a specific repo
- `gitea_create_repo` — create a new repo under the token owner
- `gitea_list_issues` — list open/closed/all issues in a repo
- `gitea_create_issue` — open a new issue

## Backups

Everything — repos, issues, attachments, the SQLite database — lives in
`~/.crow/gitea/data`. Back this directory up on a schedule; a plain tar
while the container is running is safe for SQLite because Gitea uses WAL
mode, though a briefly stopped container is the gold standard.
