---
name: nextcloud
description: Access and manage files on Nextcloud via WebDAV
triggers:
  - nextcloud
  - nextcloud files
  - sync files
tools:
  - filesystem
  - crow-memory
---

# Nextcloud Integration

## When to Activate

- User mentions Nextcloud or wants to access Nextcloud files
- User wants to sync documents between Crow and Nextcloud

## How It Works (v1 — Files Only)

Nextcloud files are accessed via a WebDAV mount on the local filesystem. The `filesystem` MCP server reads/writes files at `NEXTCLOUD_MOUNT_PATH`.

Future versions will add calendar and contacts via CalDAV/CardDAV.

## Workflow 1: Browse Files

1. Use filesystem tools to list files at the Nextcloud mount path
2. Navigate folders as the user requests
3. Read document contents when asked

## Workflow 2: Save to Nextcloud

1. When the user wants to save content to Nextcloud:
   - Write the file to the mount path using filesystem tools
   - WebDAV sync will propagate it to Nextcloud automatically
2. Confirm the file was saved

## Workflow 3: Search Files

1. Use filesystem search within the mount path
2. Present results with folder paths relative to Nextcloud root

## Setup Requirements

### Connecting to an Existing Nextcloud Instance

```bash
# Install davfs2
sudo apt install davfs2

# Create mount point
sudo mkdir -p /mnt/nextcloud

# Add to /etc/fstab for automatic mounting
# https://your-nextcloud.com/remote.php/dav/files/USERNAME /mnt/nextcloud davfs user,rw,auto 0 0

# Store credentials
echo "/mnt/nextcloud USERNAME PASSWORD" | sudo tee -a /etc/davfs2/secrets
sudo chmod 600 /etc/davfs2/secrets

# Mount
sudo mount /mnt/nextcloud
```

### Deploying a New Instance

Use the Docker Compose file in this bundle to deploy Nextcloud + MariaDB.

## Tips

- The mount path is set via `NEXTCLOUD_MOUNT_PATH` environment variable
- WebDAV mounts can be slow for large directory listings — cache results when possible
- Store frequently accessed paths in Crow memory for quick navigation
- This integration works best with desktop/local Crow setups

## Limitations (v1)

- **Files only** — no calendar or contacts integration yet
- **No real-time sync** — files are available when the WebDAV mount is active
- Calendar + contacts (CalDAV/CardDAV) planned for v2 via custom MCP server
