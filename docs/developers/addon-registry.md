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

The registry is a JSON file at `registry/addons.json`:

```json
{
  "version": 1,
  "addons": [
    {
      "name": "crow-weather-panel",
      "description": "Weather dashboard panel showing local forecast",
      "type": "panel",
      "author": "contributor-handle",
      "license": "MIT",
      "repository": "https://github.com/contributor/crow-weather-panel",
      "version": "1.0.0",
      "commit": "a1b2c3d4e5f6789012345678901234567890abcd",
      "download_url": "https://github.com/contributor/crow-weather-panel/archive/a1b2c3d.tar.gz",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "crow_min_version": "1.0.0",
      "added": "2026-03-01"
    }
  ]
}
```

### Entry Fields

| Field | Description |
|---|---|
| `name` | Package name (must match manifest) |
| `description` | Short description |
| `type` | `panel`, `mcp-server`, `skill`, or `bundle` |
| `author` | GitHub username or handle |
| `license` | SPDX license identifier |
| `repository` | Public Git repository URL |
| `version` | Semver version (must match manifest and Git tag) |
| `commit` | Full SHA of the pinned commit |
| `download_url` | Direct download link for the pinned commit |
| `sha256` | SHA-256 hash of the downloaded archive |
| `crow_min_version` | Minimum Crow version required |
| `added` | Date the add-on was listed |

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

Once approved, the maintainer adds your add-on to `registry/addons.json` and merges. Your add-on is now discoverable by all Crow users.

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
