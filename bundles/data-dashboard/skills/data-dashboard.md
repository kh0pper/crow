---
name: data-dashboard
description: Data exploration, SQL queries, visualization, and case studies
triggers:
  - "explore data"
  - "run query"
  - "show schema"
  - "create database"
  - "case study"
  - "data dashboard"
  - "query database"
  - "import CSV"
  - "chart"
  - "visualize"
tools:
  - crow_data_list_databases
  - crow_data_schema
  - crow_data_query
  - crow_data_preview
  - crow_data_create_database
  - crow_data_save_query
  - crow_data_list_saved
  - crow_data_case_study_create
  - crow_data_case_study_publish
---

# Data Dashboard Skill

## When to Activate
User wants to explore data, run SQL queries, create visualizations, or build case studies from their project databases.

## Workflow

### 1. Database Discovery
- Start with `crow_data_list_databases` to see available databases
- If no databases exist, offer to create an empty one with `crow_data_create_database` (the user fills it with their own tools)

### 2. Schema Exploration
- Use `crow_data_schema` to understand table structure
- Use `crow_data_preview` for quick data samples

### 3. Query Execution
- Use `crow_data_query` for read-only queries (one statement, max 5000 rows)
- Crow does not change data: `crow_data_write` is disabled. Data goes in with the user's own tools
- Save useful queries with `crow_data_save_query`

### 4. Case Studies
- Combine findings into `crow_data_case_study_create` with text + chart sections
- Publish to blog with `crow_data_case_study_publish`

## Safety Rules
- Datasets are opened read-only: one statement per query, SELECT/WITH/EXPLAIN/PRAGMA/VALUES, nothing is ever written
- A dataset must live in the data folder's `datasets/` or a project's `databases/` folder (`~/.crow/data/` by default)
- Crow's own databases (crow.db, tasks.db) can never be registered or queried as datasets
- `crow_data_write` is disabled while the Data Dashboard is being retired
