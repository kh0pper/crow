# Desktop Setup (Claude Desktop)

Run Crow locally with Claude Desktop using stdio transport. No cloud deployment needed — everything runs on your machine.

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed
- [Node.js](https://nodejs.org) 18 or later
- Git

## Step 1: Clone and Install

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
npm run setup
```

This installs dependencies and creates the local SQLite database at `data/crow.db`.

## Step 2: Configure API Keys

Copy the example env file and add your keys:

```bash
cp .env.example .env
```

Edit `.env` and add keys for the services you want. All core servers (memory, research, sharing, blog) work without any API keys — only storage (requires MinIO) and external integrations need keys.

> **Security note**: Your `.env` file contains API keys that act like passwords. Never share it, commit it to GitHub, or post its contents anywhere. The file is already listed in `.gitignore` so git won't track it, but always double-check before pushing code. See the [Security Guide](https://github.com/kh0pper/crow/blob/main/SECURITY.md) for more about keeping your keys safe.

## Step 3: Generate Claude Desktop Config

```bash
npm run desktop-config
```

This outputs a JSON block for your Claude Desktop configuration. Copy it and add it to:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

## Step 4: Restart Claude Desktop

Quit and reopen Claude Desktop. You should see the MCP server icons in the input area, indicating Crow is connected.

## Limitations

- Only works with Claude Desktop (stdio transport)
- Only accessible from the machine running the servers
- No OAuth — direct process connection
- For mobile/web access, use the [Cloud Deploy](./cloud-deploy) instead
