# Desktop Install

Run Crow locally on your personal computer. No cloud, no server — everything runs on your machine and connects directly to your AI tools via stdio transport.

## What This Gives You

- All core Crow features: memory, projects, sharing, blog
- Direct connection to Claude Desktop, Claude Code, Cursor, Windsurf, Cline, and more
- Local SQLite database — your data stays on your machine
- No accounts or API keys needed for core features

## Prerequisites

::: code-group

```bash [macOS]
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and Git
brew install node git
```

```bash [Linux (Ubuntu/Debian)]
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
```

```powershell [Windows]
# Download and install Node.js from https://nodejs.org (LTS version)
# Git: download from https://git-scm.com/download/win
# Or use winget:
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

:::

Verify your installation:

```bash
node --version   # Should be 18.x or later
npm --version
git --version
```

## Install Crow

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
npm run setup
```

This installs dependencies and creates a local SQLite database. No API keys or external services needed.

## Generate MCP Configuration

```bash
npm run mcp-config
```

This creates `.mcp.json` with your local server paths. Only servers with the required environment variables are included — core servers (memory, projects, sharing, blog) are always included since they need no API keys.

## Connect to Your AI Platform

### Claude Desktop

```bash
npm run desktop-config
```

Copy the output JSON into your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Restart Claude Desktop. Look for the MCP server icons in the input area.

### Claude Code

Claude Code automatically reads `.mcp.json` from your project:

```bash
cd crow
claude
```

### Cursor / Windsurf / Cline

These editors read `.mcp.json` from your project directory. Open the `crow` folder in your editor and the MCP servers will be available.

See the [Platforms guide](../platforms/) for detailed setup instructions for each AI tool.

## Optional: Add External Integrations

Edit `.env` to add API keys for external services:

```bash
cp .env.example .env
# Edit .env with your preferred editor
```

After editing, regenerate the MCP config:

```bash
npm run mcp-config
```

See the [Integrations page](../integrations/) for all available services and where to get API keys.

## Optional: Multi-Device Access with Tailscale

By default, your desktop install only works on the machine running the servers. To access Crow from your phone or other devices:

1. Start the gateway: `node servers/gateway/index.js`
2. Install [Tailscale](https://tailscale.com) on this machine and your other devices
3. Access your Crow at `http://<tailscale-hostname>:3001` from any device

See the [Tailscale Setup Guide](./tailscale-setup) for details.

## Reducing Context Usage

By default, each Crow server is a separate entry in your AI tool's config. For fewer context tokens, use the combined server:

```bash
npm run mcp-config -- --combined
```

This generates a single `crow-core` entry that activates servers on demand. See the [Context & Performance guide](/guide/context-performance) for details.

## Limitations

- Only accessible from this machine (unless you add Tailscale or the gateway)
- No web-based Crow's Nest (requires the gateway)
- No public blog (requires the gateway + HTTPS)
- For remote access from any device, see [Oracle Cloud](./oracle-cloud) or [Home Server](./home-server)

::: tip Solve these limitations with chaining
Most of these limitations disappear when you chain this desktop instance with a cloud or home server instance. Your desktop stays local and fast, while the cloud instance provides remote access, a public blog, and data backup. Set up [Oracle Cloud](./oracle-cloud) or [Google Cloud](./google-cloud), then [chain them](./multi-device) — memories sync automatically.
:::
