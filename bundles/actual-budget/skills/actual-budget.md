---
name: actual-budget
description: Manage personal finances with Actual Budget — check balances, review transactions, manage budgets, and generate spending reports
triggers:
  - actual budget
  - personal finance
  - budget tracking
  - spending
  - transactions
  - money management
  - check my balance
  - how much did I spend
tools:
  - crow-actual-budget
  - crow-memory
---

# Actual Budget

## When to Activate

- User asks about their finances, balances, spending, or budget
- User mentions Actual Budget or budgeting
- User wants to log a transaction or expense
- User asks for a spending report or financial summary
- User wants to view or update budget amounts

## Workflow 1: Check Balances

1. Use `crow_actual_accounts` to list all accounts with balances
2. Present open accounts with their current balances
3. Show the total net worth across all accounts
4. If the user asks about a specific account, highlight that one

## Workflow 2: Review Transactions

1. Use `crow_actual_transactions` with appropriate filters:
   - Recent: leave filters empty, use default limit
   - By date range: set `start_date` and `end_date` (YYYY-MM-DD)
   - By account: set `account_id` (get IDs from `crow_actual_accounts`)
   - By category: set `category` (partial match)
   - By payee: set `payee` (partial match)
2. Present transactions with date, payee, category, and amount
3. Amounts: negative = expense, positive = income (displayed in dollars)
4. For details on a specific transaction, use `crow_actual_get_transaction`

## Workflow 3: Create Transaction

1. Gather from the user: account, date, amount, payee, and category
2. Get the account ID from `crow_actual_accounts` if the user gives a name
3. Convert the dollar amount to cents (e.g. $42.50 = 4250, -$15.99 = -1599)
4. Use `crow_actual_create_transaction` with:
   - `account_id`: the target account
   - `date`: YYYY-MM-DD format
   - `amount`: in cents, negative for expenses
   - `payee_name`: who the money went to/from
   - `category`: budget category name
   - `notes`: optional description
5. Confirm the transaction was created

## Workflow 4: View Budget

1. Use `crow_actual_budgets` with the target month (YYYY-MM)
   - Current month: use today's year-month
   - The user may say "this month", "last month", "March", etc.
2. Present categories grouped by their category group
3. Show budgeted amount, spent amount, and remaining balance per category
4. Highlight categories that are over budget (balance negative)

## Workflow 5: Update Budget

1. Use `crow_actual_budgets` first to show current amounts and get category IDs
2. Use `crow_actual_update_budget` with:
   - `category_id`: from the budgets listing
   - `month`: YYYY-MM format
   - `amount`: budget amount in cents
3. Confirm the update

## Workflow 6: Spending Report

1. Use `crow_actual_reports` with:
   - `type`: "category" (where money goes), "payee" (who gets the money), or "monthly" (trends over time)
   - `start_date` and `end_date`: the reporting period (YYYY-MM-DD)
2. Common requests:
   - "How much did I spend this month?" = category report, current month
   - "What did I spend at restaurants?" = payee report, filter results
   - "Spending trends this year" = monthly report, Jan 1 to today
3. Present the summary with totals, then the grouped breakdown

## Tips

- Amounts are always in cents internally. Convert for the user: $42.50 = 4250 cents
- Negative amounts = money going out (expenses). Positive = money coming in (income)
- Store the user's budget preferences in memory (categories they track, typical spending patterns)
- When the user says "log" or "add" an expense, use Create Transaction
- For "how much did I spend on X", use the transactions endpoint with category/payee filters or the reports endpoint

## Error Handling

- If Actual Budget is unreachable: "Can't connect to Actual Budget at the configured URL. Make sure the server is running."
- If auth fails: "Actual Budget rejected the password. Check ACTUAL_PASSWORD in settings."
- If no budgets found: "No budgets found. Create a budget in Actual Budget first, then set ACTUAL_SYNC_ID if you have multiple budgets."
- If a query returns empty: the budget may not have data for that period yet
