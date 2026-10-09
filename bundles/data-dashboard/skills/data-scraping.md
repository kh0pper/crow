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
  - crow_data_schema
  - crow_data_query
---

# Data Scraping Skill

## When to Activate
User wants to scrape a website and store the results in a queryable database.

## Workflow

1. **Identify target**: Confirm what data the user wants from which website
2. **Create database**: `crow_data_create_database` for the project (an empty file in the project's databases folder)
3. **Scrape data**: Use browser automation tools to navigate and extract
4. **Load data**: Crow does not write to databases (`crow_data_write` is disabled). Give the user the extracted rows (for example as CSV) and have them load it with their own tools, such as `sqlite3 <path> ".import --csv rows.csv items"`
5. **Verify**: `crow_data_query` to confirm the data is there
6. **Explore**: User can now explore in the Data Dashboard panel

## Safety
- Databases are stored in `~/.crow/data/projects/{project_id}/databases/`
- Crow reads datasets read-only and can never open its own databases
- Respect robots.txt and rate limiting when scraping
