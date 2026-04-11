/**
 * Actual Budget API Routes — Express router for Crow's Nest Actual Budget panel
 *
 * Bundle-compatible version: uses env vars directly for API calls.
 * Protected by dashboardAuth. Proxies REST calls to the configured
 * Actual Budget instance for the dashboard panel.
 */

import { Router } from "express";

const ACTUAL_URL = () => (process.env.ACTUAL_URL || "http://localhost:5006").replace(/\/+$/, "");
const ACTUAL_PASSWORD = () => process.env.ACTUAL_PASSWORD || "";
const ACTUAL_SYNC_ID = () => process.env.ACTUAL_SYNC_ID || "";

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
    const res = await fetch(`${ACTUAL_URL()}/account/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ACTUAL_PASSWORD() }),
    });

    if (!res.ok) throw new Error("Actual Budget login failed — check ACTUAL_PASSWORD");
    const data = await res.json();
    authToken = data.data?.token || data.token;
    if (!authToken) throw new Error("No token returned from login");
    return authToken;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Actual Budget login timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Actual Budget — is the server running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch from Actual Budget API with auth and timeout.
 */
async function abFetch(path, options = {}) {
  const token = await getToken();
  const url = `${ACTUAL_URL()}${path}`;
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
        authToken = null;
        throw new Error("Authentication expired — refresh the page");
      }
      throw new Error(`Actual Budget ${res.status}: ${res.statusText}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Actual Budget request timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Actual Budget — is the server running?");
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

  let syncId = ACTUAL_SYNC_ID();

  if (!syncId) {
    const data = await abFetch("/api/budgets");
    const budgets = data.data || data || [];
    if (Array.isArray(budgets) && budgets.length > 0) {
      syncId = budgets[0].id || budgets[0].syncId || budgets[0].cloudFileId;
    }
    if (!syncId) throw new Error("No budgets found");
  }

  await abFetch(`/api/budgets/${encodeURIComponent(syncId)}/open`, { method: "POST" });
  budgetOpened = true;
}

/**
 * Run a query against the open budget.
 */
async function runQuery(query) {
  await ensureBudgetOpen();
  const data = await abFetch("/api/query", {
    method: "POST",
    body: JSON.stringify(query),
  });
  return data.data || data;
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function actualBudgetRouter(authMiddleware) {
  const router = Router();

  // --- Account Balances ---
  router.get("/api/actual-budget/accounts", authMiddleware, async (req, res) => {
    try {
      const accounts = await runQuery({
        table: "accounts",
        select: ["id", "name", "type", "balance", "closed"],
      });

      const items = (Array.isArray(accounts) ? accounts : []).filter((a) => !a.closed).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type || "checking",
        balance_cents: a.balance || 0,
      }));

      const totalCents = items.reduce((sum, a) => sum + a.balance_cents, 0);
      res.json({ accounts: items, total_cents: totalCents });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Monthly Summary (current month) ---
  router.get("/api/actual-budget/summary", authMiddleware, async (req, res) => {
    try {
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;

      const transactions = await runQuery({
        table: "transactions",
        select: ["id", "amount"],
        filter: [
          { field: "date", op: "gte", value: startDate },
          { field: "date", op: "lte", value: endDate },
        ],
      });

      const items = Array.isArray(transactions) ? transactions : [];
      let income = 0;
      let expenses = 0;
      items.forEach((t) => {
        if ((t.amount || 0) >= 0) {
          income += t.amount || 0;
        } else {
          expenses += t.amount || 0;
        }
      });

      res.json({
        income_cents: income,
        expense_cents: expenses,
        net_cents: income + expenses,
        transaction_count: items.length,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // --- Recent Transactions ---
  router.get("/api/actual-budget/recent", authMiddleware, async (req, res) => {
    try {
      const transactions = await runQuery({
        table: "transactions",
        select: ["id", "date", "amount", "payee_name", "category_name", "account_name"],
        orderBy: [{ field: "date", direction: "desc" }],
        limit: 20,
      });

      const items = (Array.isArray(transactions) ? transactions : []).map((t) => ({
        id: t.id,
        date: t.date,
        amount_cents: t.amount || 0,
        payee: t.payee_name || null,
        category: t.category_name || null,
        account: t.account_name || null,
      }));

      res.json({ transactions: items });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
