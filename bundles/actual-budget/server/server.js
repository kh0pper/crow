/**
 * Actual Budget MCP Server
 *
 * Provides tools to manage personal finances via the Actual Budget API:
 * - List accounts with balances
 * - List and filter transactions
 * - Get transaction details
 * - Create transactions
 * - View budget categories and amounts
 * - Update budget amounts
 * - Generate spending reports
 *
 * Auth: POST /account/login with { password } to get a Bearer token.
 * Amounts are stored in cents (integer). Negative = expense, positive = income.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ACTUAL_URL = (process.env.ACTUAL_URL || "http://localhost:5006").replace(/\/+$/, "");
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD || "";
const ACTUAL_SYNC_ID = process.env.ACTUAL_SYNC_ID || "";

let authToken = null;
let budgetOpened = false;

/**
 * Authenticate with Actual Budget and get a Bearer token.
 */
async function getToken() {
  if (authToken) return authToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${ACTUAL_URL}/account/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ACTUAL_PASSWORD }),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 400) {
        throw new Error("Actual Budget login failed — check ACTUAL_PASSWORD");
      }
      throw new Error(`Actual Budget login error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    authToken = data.data?.token || data.token;
    if (!authToken) throw new Error("No token returned from Actual Budget login");
    return authToken;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Actual Budget login timed out after 10s");
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Actual Budget at ${ACTUAL_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make an authenticated request to the Actual Budget API.
 * @param {string} path - API path
 * @param {object} [options] - fetch options
 * @returns {Promise<any>} parsed JSON response
 */
async function actualFetch(path, options = {}) {
  const token = await getToken();
  const url = `${ACTUAL_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401) {
        // Token expired, retry once
        authToken = null;
        const newToken = await getToken();
        clearTimeout(timeout);
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), 10000);
        try {
          const retryRes = await fetch(url, {
            ...options,
            signal: retryController.signal,
            headers: {
              Authorization: `Bearer ${newToken}`,
              "Content-Type": "application/json",
              ...options.headers,
            },
          });
          if (!retryRes.ok) throw new Error(`Actual Budget API error: ${retryRes.status} ${retryRes.statusText}`);
          const text = await retryRes.text();
          return text ? JSON.parse(text) : {};
        } finally {
          clearTimeout(retryTimeout);
        }
      }
      if (res.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Actual Budget API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Actual Budget request timed out after 10s: ${path}`);
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Actual Budget at ${ACTUAL_URL} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ensure a budget is opened for querying.
 */
async function ensureBudgetOpen() {
  if (budgetOpened) return;

  let syncId = ACTUAL_SYNC_ID;

  if (!syncId) {
    // List budgets and pick the first one
    const data = await actualFetch("/api/budgets");
    const budgets = data.data || data || [];
    if (Array.isArray(budgets) && budgets.length > 0) {
      syncId = budgets[0].id || budgets[0].syncId || budgets[0].cloudFileId;
    }
    if (!syncId) throw new Error("No budgets found. Create a budget in Actual Budget first.");
  }

  await actualFetch(`/api/budgets/${encodeURIComponent(syncId)}/open`, { method: "POST" });
  budgetOpened = true;
}

/**
 * Run a query against the open budget.
 */
async function runQuery(query) {
  await ensureBudgetOpen();
  const data = await actualFetch("/api/query", {
    method: "POST",
    body: JSON.stringify(query),
  });
  return data.data || data;
}

/**
 * Format cents to dollar string.
 */
function formatAmount(cents) {
  if (cents == null) return "$0.00";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${negative ? "-" : ""}$${dollars.toLocaleString()}.${String(remainder).padStart(2, "0")}`;
}

export function createActualBudgetServer(options = {}) {
  const server = new McpServer(
    { name: "crow-actual-budget", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_actual_accounts ---
  server.tool(
    "crow_actual_accounts",
    "List all Actual Budget accounts with current balances",
    {},
    async () => {
      try {
        const accounts = await runQuery({
          table: "accounts",
          select: ["id", "name", "type", "balance", "closed"],
        });

        const items = (Array.isArray(accounts) ? accounts : []).map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type || "checking",
          balance: formatAmount(a.balance),
          balance_cents: a.balance,
          closed: a.closed || false,
        }));

        const openAccounts = items.filter((a) => !a.closed);
        const totalCents = openAccounts.reduce((sum, a) => sum + (a.balance_cents || 0), 0);

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `${openAccounts.length} open account(s), total: ${formatAmount(totalCents)}\n${JSON.stringify(items, null, 2)}`
              : "No accounts found. Create accounts in Actual Budget first.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_actual_transactions ---
  server.tool(
    "crow_actual_transactions",
    "List transactions with optional filters. Amounts in cents (negative = expense, positive = income).",
    {
      account_id: z.string().max(100).optional().describe("Filter by account ID"),
      start_date: z.string().max(20).optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().max(20).optional().describe("End date (YYYY-MM-DD)"),
      category: z.string().max(200).optional().describe("Filter by category name (partial match)"),
      payee: z.string().max(200).optional().describe("Filter by payee name (partial match)"),
      limit: z.number().min(1).max(500).optional().default(50).describe("Max results (default 50)"),
    },
    async ({ account_id, start_date, end_date, category, payee, limit }) => {
      try {
        const query = {
          table: "transactions",
          select: ["id", "date", "amount", "payee_name", "category_name", "notes", "account_name"],
          orderBy: [{ field: "date", direction: "desc" }],
          limit,
        };

        const filters = [];
        if (account_id) filters.push({ field: "account_id", op: "eq", value: account_id });
        if (start_date) filters.push({ field: "date", op: "gte", value: start_date });
        if (end_date) filters.push({ field: "date", op: "lte", value: end_date });
        if (category) filters.push({ field: "category_name", op: "contains", value: category });
        if (payee) filters.push({ field: "payee_name", op: "contains", value: payee });
        if (filters.length > 0) query.filter = filters;

        const transactions = await runQuery(query);
        const items = (Array.isArray(transactions) ? transactions : []).map((t) => ({
          id: t.id,
          date: t.date,
          amount: formatAmount(t.amount),
          amount_cents: t.amount,
          payee: t.payee_name || null,
          category: t.category_name || null,
          account: t.account_name || null,
          notes: t.notes || null,
        }));

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `${items.length} transaction(s):\n${JSON.stringify(items, null, 2)}`
              : "No transactions found matching the filters.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_actual_get_transaction ---
  server.tool(
    "crow_actual_get_transaction",
    "Get detailed information about a specific transaction by ID",
    {
      transaction_id: z.string().max(100).describe("Transaction ID"),
    },
    async ({ transaction_id }) => {
      try {
        const transactions = await runQuery({
          table: "transactions",
          select: ["id", "date", "amount", "payee_name", "category_name", "notes", "account_name", "cleared", "reconciled"],
          filter: [{ field: "id", op: "eq", value: transaction_id }],
        });

        const items = Array.isArray(transactions) ? transactions : [];
        if (items.length === 0) {
          return { content: [{ type: "text", text: `No transaction found with ID "${transaction_id}".` }] };
        }

        const t = items[0];
        const result = {
          id: t.id,
          date: t.date,
          amount: formatAmount(t.amount),
          amount_cents: t.amount,
          payee: t.payee_name || null,
          category: t.category_name || null,
          account: t.account_name || null,
          notes: t.notes || null,
          cleared: t.cleared || false,
          reconciled: t.reconciled || false,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_actual_create_transaction ---
  server.tool(
    "crow_actual_create_transaction",
    "Create a new transaction. Amount in cents (negative = expense, positive = income).",
    {
      account_id: z.string().max(100).describe("Account ID to add the transaction to"),
      date: z.string().max(20).describe("Transaction date (YYYY-MM-DD)"),
      amount: z.number().describe("Amount in cents (negative for expenses, positive for income)"),
      payee_name: z.string().max(200).optional().describe("Payee name"),
      category: z.string().max(200).optional().describe("Category name"),
      notes: z.string().max(2000).optional().describe("Transaction notes"),
    },
    async ({ account_id, date, amount, payee_name, category, notes }) => {
      try {
        await ensureBudgetOpen();

        const transaction = {
          account_id,
          date,
          amount,
        };
        if (payee_name) transaction.payee_name = payee_name;
        if (category) transaction.category = category;
        if (notes) transaction.notes = notes;

        const data = await actualFetch("/api/transactions", {
          method: "POST",
          body: JSON.stringify({ transaction }),
        });

        const created = data.data || data;
        return {
          content: [{
            type: "text",
            text: `Transaction created: ${formatAmount(amount)} ${payee_name ? `to "${payee_name}"` : ""} on ${date}.\n${JSON.stringify(created, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_actual_budgets ---
  server.tool(
    "crow_actual_budgets",
    "Get budget categories and amounts for a given month",
    {
      month: z.string().max(10).describe("Month in YYYY-MM format (e.g. 2026-04)"),
    },
    async ({ month }) => {
      try {
        const categories = await runQuery({
          table: "categories",
          select: ["id", "name", "group_name"],
        });

        // Get budget amounts for the month
        const budgetData = await runQuery({
          table: "budget",
          select: ["category_id", "month", "budgeted", "spent", "balance"],
          filter: [{ field: "month", op: "eq", value: month }],
        });

        const catMap = new Map();
        (Array.isArray(categories) ? categories : []).forEach((c) => {
          catMap.set(c.id, { name: c.name, group: c.group_name || "Ungrouped" });
        });

        const items = (Array.isArray(budgetData) ? budgetData : []).map((b) => {
          const cat = catMap.get(b.category_id) || { name: b.category_id, group: "Unknown" };
          return {
            category_id: b.category_id,
            category: cat.name,
            group: cat.group,
            budgeted: formatAmount(b.budgeted),
            budgeted_cents: b.budgeted || 0,
            spent: formatAmount(b.spent),
            spent_cents: b.spent || 0,
            balance: formatAmount(b.balance),
            balance_cents: b.balance || 0,
          };
        });

        // Group by category group
        const groups = {};
        items.forEach((item) => {
          if (!groups[item.group]) groups[item.group] = [];
          groups[item.group].push(item);
        });

        const totalBudgeted = items.reduce((s, i) => s + i.budgeted_cents, 0);
        const totalSpent = items.reduce((s, i) => s + i.spent_cents, 0);

        return {
          content: [{
            type: "text",
            text: items.length > 0
              ? `Budget for ${month}: ${formatAmount(totalBudgeted)} budgeted, ${formatAmount(totalSpent)} spent\n${JSON.stringify(groups, null, 2)}`
              : `No budget data found for ${month}. Budget amounts may not be set yet.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_actual_update_budget ---
  server.tool(
    "crow_actual_update_budget",
    "Set the budget amount for a category in a given month. Amount in cents.",
    {
      category_id: z.string().max(100).describe("Category ID (from crow_actual_budgets)"),
      month: z.string().max(10).describe("Month in YYYY-MM format (e.g. 2026-04)"),
      amount: z.number().describe("Budget amount in cents"),
    },
    async ({ category_id, month, amount }) => {
      try {
        await ensureBudgetOpen();

        const data = await actualFetch("/api/budget", {
          method: "POST",
          body: JSON.stringify({
            category_id,
            month,
            amount,
          }),
        });

        return {
          content: [{
            type: "text",
            text: `Budget updated: ${formatAmount(amount)} for category "${category_id}" in ${month}.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- crow_actual_reports ---
  server.tool(
    "crow_actual_reports",
    "Generate a spending summary report. Groups transactions by category, payee, or month.",
    {
      type: z.enum(["category", "payee", "monthly"]).describe("Report type: group by category, payee, or month"),
      start_date: z.string().max(20).describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().max(20).describe("End date (YYYY-MM-DD)"),
    },
    async ({ type, start_date, end_date }) => {
      try {
        const transactions = await runQuery({
          table: "transactions",
          select: ["id", "date", "amount", "payee_name", "category_name"],
          filter: [
            { field: "date", op: "gte", value: start_date },
            { field: "date", op: "lte", value: end_date },
          ],
          orderBy: [{ field: "date", direction: "asc" }],
          limit: 5000,
        });

        const items = Array.isArray(transactions) ? transactions : [];

        if (items.length === 0) {
          return { content: [{ type: "text", text: `No transactions found between ${start_date} and ${end_date}.` }] };
        }

        const groups = {};

        items.forEach((t) => {
          let key;
          if (type === "category") {
            key = t.category_name || "Uncategorized";
          } else if (type === "payee") {
            key = t.payee_name || "Unknown";
          } else {
            // monthly
            key = t.date ? t.date.substring(0, 7) : "Unknown";
          }

          if (!groups[key]) {
            groups[key] = { total_cents: 0, income_cents: 0, expense_cents: 0, count: 0 };
          }
          groups[key].total_cents += t.amount || 0;
          groups[key].count += 1;
          if ((t.amount || 0) >= 0) {
            groups[key].income_cents += t.amount || 0;
          } else {
            groups[key].expense_cents += t.amount || 0;
          }
        });

        // Convert to sorted array
        const report = Object.entries(groups)
          .map(([name, data]) => ({
            name,
            total: formatAmount(data.total_cents),
            total_cents: data.total_cents,
            income: formatAmount(data.income_cents),
            expenses: formatAmount(data.expense_cents),
            transaction_count: data.count,
          }))
          .sort((a, b) => a.total_cents - b.total_cents); // Most expenses first

        const totalExpenses = items.filter((t) => (t.amount || 0) < 0).reduce((s, t) => s + t.amount, 0);
        const totalIncome = items.filter((t) => (t.amount || 0) >= 0).reduce((s, t) => s + t.amount, 0);

        return {
          content: [{
            type: "text",
            text: `Spending report (${type}) from ${start_date} to ${end_date}:\n` +
              `Total income: ${formatAmount(totalIncome)}, Total expenses: ${formatAmount(totalExpenses)}, Net: ${formatAmount(totalIncome + totalExpenses)}\n` +
              `${items.length} transaction(s) in ${report.length} group(s):\n${JSON.stringify(report, null, 2)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
