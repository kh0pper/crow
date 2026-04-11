---
title: Actual Budget
---

# Actual Budget

Connect Crow to Actual Budget, a privacy-first personal finance tool, to track spending, manage budgets, and view financial reports through your AI assistant. All data stays on your server.

## What You Get

- View account balances across all your accounts
- Browse and search transactions by account, date, category, or payee
- Create new transactions from natural language
- View budget categories and allocated amounts by month
- Update budget allocations for any category
- Generate spending reports by category, payee, or time period

## Setup

Crow supports two modes for Actual Budget: self-hosting via Docker or connecting to an existing instance.

### Option A: Docker (self-hosted)

Install Actual Budget as a Crow bundle. This runs Actual Budget in Docker alongside your Crow gateway.

> "Crow, install the Actual Budget bundle"

Or install from the **Extensions** panel in the Crow's Nest.

After installation, Actual Budget will be available at `http://your-server:5006`. On your first visit to the web UI, you will be prompted to set a server password. Use the same password as `ACTUAL_PASSWORD` in your `.env` file:

```bash
# In your .env file
ACTUAL_PASSWORD=your-server-password
```

Restart the bundle for changes to take effect:

> "Crow, restart the Actual Budget bundle"

### Option B: Connect to existing Actual Budget

If you already run an Actual Budget server, connect Crow to it directly.

Set the following in your `.env` file or via **Crow's Nest** > **Settings** > **Integrations**:

```bash
ACTUAL_URL=http://your-actual-server:5006
ACTUAL_PASSWORD=your-server-password
```

Optionally, set `ACTUAL_SYNC_ID` to auto-select a specific budget file (useful if you have multiple budgets):

```bash
ACTUAL_SYNC_ID=your-budget-sync-id
```

You can find the sync ID in Actual's settings under **Advanced** > **Show budget ID**.

## AI Tools

Once connected, you can manage your finances through your AI:

> "What are my account balances?"

> "Show me transactions from last month"

> "Add a transaction: $45.99 at Whole Foods, groceries category"

> "What's my budget for dining out this month?"

> "How much did I spend on transportation in March?"

> "Set the groceries budget to $500 for this month"

## Privacy

Actual Budget is designed with privacy first. All financial data stays on your server. No cloud sync, no third-party access. The AI assistant accesses your data only through the local API.

## A Note on Amounts

Amounts in Actual are stored in cents internally. Crow automatically converts to dollars for display. When creating transactions, use normal dollar amounts (e.g., 45.99) rather than cent values (e.g., 4599).

## Troubleshooting

### "Connection refused" or timeout

Make sure the `ACTUAL_URL` is reachable from the machine running Crow. If Actual Budget is on a different machine, use the correct IP or hostname. Verify the server is running.

### "Login failed" or authentication error

The `ACTUAL_PASSWORD` must match the server password you set during initial setup in Actual's web UI. If you changed the password in the web UI, update your `.env` file to match.

### No budget data showing up

Actual Budget requires you to open and select a budget file before the API can access it. Open the Actual web UI and create or select a budget file. Alternatively, set `ACTUAL_SYNC_ID` in your `.env` to auto-select a specific budget.

### Amounts look wrong

Make sure you are using dollar amounts (e.g., 45.99) when creating transactions through the AI, not cent values (e.g., 4599). Crow handles the conversion automatically.
