---
name: data-scraping
description: Bridge browser automation with the data dashboard for web scraping pipelines
triggers:
  - "scrape"
  - "extract data from"
  - "crawl"
  - "collect data from website"
tools:
  - crow_data_create_database
  - crow_data_write
  - crow_data_schema
  - crow_data_query
---

# Data Scraping Skill

## When to Activate
User wants to scrape a website and store the results in a queryable database.

## Workflow

1. **Identify target**: Confirm what data the user wants from which website
2. **Create database**: `crow_data_create_database` for the project
3. **Create schema**: `crow_data_write` to CREATE TABLE with appropriate columns
4. **Scrape data**: Use browser automation tools to navigate and extract
5. **Insert data**: `crow_data_write` to INSERT extracted rows
6. **Verify**: `crow_data_query` to confirm data was stored correctly
7. **Explore**: User can now explore in the Data Dashboard panel

## Safety
- Databases are stored in `~/.crow/data/projects/{project_id}/databases/`
- Never write to the core crow.db
- Respect robots.txt and rate limiting when scraping
