---
title: Add-on Registry
---

# Add-on Registry

The Crow add-on registry is a curated list of community-built extensions — panels, MCP servers, skills, and bundles.

## What is this?

The registry is a JSON file hosted in the Crow repository that lists available add-ons with their metadata, download URLs, and integrity checksums. It is not a package manager — it is a directory that points to Git repositories.

## Why would I want this?

- **Discover add-ons** — Browse what the community has built
- **Trust verification** — Every listed add-on has a SHA-256 checksum and is pinned to a specific commit
- **Quality baseline** — Submissions are reviewed by maintainers before listing

## Registry Format

The registry is a JSON file at `registry/add-ons.json`:

```json
{
  "version": 2,
  "add-ons": [
    {
      "id": "my-addon",
      "name": "My Add-on",
      "description": "What this add-on does",
      "type": "bundle",
      "version": "1.0.0",
      "author": "contributor-handle",
      "category": "productivity",
      "tags": ["keyword1", "keyword2"],
      "icon": "book",
      "requires": {
        "env": ["API_KEY"],
        "min_ram_mb": 256,
        "min_disk_mb": 100
      },
      "env_vars": [
        {
          "name": "API_KEY",
          "description": "Your API key for the service",
          "required": true,
          "secret": true
        }
      ],
      "ports": [8080],
      "notes": "Optional notes shown in the Extensions panel"
    }
  ]
}
```

### Entry Fields

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique identifier (lowercase, hyphens only) |
| `name` | Yes | Human-readable name |
| `description` | Yes | One-line description |
| `type` | Yes | `panel`, `mcp-server`, `skill`, or `bundle` |
| `version` | Yes | Semver version |
| `author` | Yes | GitHub username or handle |
| `category` | Yes | Category: `ai`, `media`, `productivity`, `storage`, `smart-home`, `networking`, `gaming`, `data`, `finance` (unknown values display as "other") |
| `tags` | No | Array of searchable tags (max 10) |
| `icon` | No | Icon key: `brain`, `cloud`, `image`, `book`, `home`, `rss`, `mic`, `music`, `message-circle`, `gamepad`, `archive`, `file-text` |
| `requires.env` | No | Required environment variable names |
| `requires.min_ram_mb` | No | Minimum RAM in MB |
| `requires.min_disk_mb` | No | Minimum disk space in MB |
| `requires.gpu` | No | Set `true` if the add-on needs a GPU |
| `env_vars` | No | Detailed env var descriptions (name, description, required, secret, default) |
| `ports` | No | Ports used by the add-on |
| `webUI` | No | Web interface: `{ "port", "path", "label" }` or `null` for headless add-ons |
| `server` | No | MCP server config: `{ "command", "args", "envKeys" }` |
| `panel` | No | Path to Crow's Nest panel module |
| `skills` | No | Array of skill file paths |
| `docker` | No | Docker config: `{ "composefile": "docker-compose.yml" }` |
| `notes` | No | Additional notes (shown in italics on the Extensions card) |

## Submission Process

### 1. Build and Test

- Create your add-on following the [Creating Add-ons](/developers/creating-addons) guide
- Test it thoroughly with your own Crow instance
- Verify it works with both dark and light themes (for panels)

### 2. Publish Your Repository

- Push to a public GitHub repository
- Include a `manifest.json`, `LICENSE`, and a `README.md`
- Tag a release matching the version in your manifest:

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 3. Generate Checksum

Download your release archive and generate the SHA-256 checksum:

```bash
curl -L -o addon.tar.gz https://github.com/you/your-addon/archive/v1.0.0.tar.gz
sha256sum addon.tar.gz
```

### 4. Submit an Issue

Open an issue in the Crow repository using the **Add-on Submission** template. Include:

- Add-on name and description
- Repository URL
- Version and commit SHA
- SHA-256 checksum
- Brief explanation of what it does and why it's useful

### 5. Review

A maintainer reviews your submission for:

- **Security** — No hardcoded secrets, no network calls without user consent, no file system access outside `~/.crow/`
- **Quality** — Follows Crow conventions (factory pattern, Zod constraints, etc.)
- **Completeness** — Has manifest, license, and reasonable documentation
- **Functionality** — Actually works when installed

### 6. Listing

Once approved, the maintainer adds your add-on to `registry/add-ons.json` and merges. Your add-on is now discoverable by all Crow users.

## Turnaround

Maintainers aim to review submissions within 72 hours. If changes are needed, you'll get feedback on the issue.

## Updating a Listed Add-on

To update your add-on:

1. Push changes and tag a new version
2. Open a new issue with the updated version, commit SHA, and checksum
3. The maintainer updates the registry entry

## Governance

The registry is maintainer-curated. Maintainers can:

- Approve or reject submissions
- Remove add-ons that become unmaintained or pose security concerns
- Request changes before listing

The goal is a small, high-quality directory rather than a large, unreviewed package index.

## Integrity Verification

When installing an add-on, verify the checksum:

```bash
curl -L -o addon.tar.gz <download_url>
echo "<expected_sha256>  addon.tar.gz" | sha256sum -c
```

A mismatch means the archive has been tampered with or the URL has changed. Do not install it.
