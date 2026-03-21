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
  - crow_data_write
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
- If no databases exist, offer to create one with `crow_data_create_database`

### 2. Schema Exploration
- Use `crow_data_schema` to understand table structure
- Use `crow_data_preview` for quick data samples

### 3. Query Execution
- Use `crow_data_query` for read-only SELECT queries (max 5000 rows, 10s timeout)
- Use `crow_data_write` for mutations (INSERT, CREATE TABLE, UPDATE, DELETE)
- Save useful queries with `crow_data_save_query`

### 4. Case Studies
- Combine findings into `crow_data_case_study_create` with text + chart sections
- Publish to blog with `crow_data_case_study_publish`

## Safety Rules
- `crow_data_query` only allows SELECT/EXPLAIN/PRAGMA/WITH
- `crow_data_write` is separate and only operates on user-owned databases
- Neither tool can access the core crow.db — only project-scoped secondary databases
- All database paths must be within `~/.crow/data/`
