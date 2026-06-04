# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

**Received:** 2026-05-13  
**Source:** TEA (pir@tea.texas.gov)  
**Case Type:** Delivery  

## Overview

TEA released 5 CSV files containing district-level pregnancy and parenting services PEIMS data covering academic years 2020-21 through 2024-25. Delivered at no charge.

## Dataset Inventory

| File | Rows | Table | Year |
|------|------|-------|------|
| PRU_11507_21.csv | 1,043 | research_pir2502592_21 | 2020-21 |
| PRU_11507_22.csv | 1,070 | research_pir2502592_22 | 2021-22 |
| PRU_11507_23.csv | 1,069 | research_pir2502592_23 | 2022-23 |
| PRU_11507_24.csv | 1,063 | research_pir2502592_24 | 2023-24 |
| PRU_11507_25.csv | 497 | research_pir2502592_25 | 2024-25 |
| **Total** | **4,742** | 5 tables | |

## Column Schema

All CSVs share identical columns:

- `YEAR` — Academic year identifier
- `DISTRICT` — District ID
- `DISTNAME` — District name
- `PREGNANT_CTE_STUDENTS` — Count of pregnant CTE students
- `SINGLEPAR_CTE_STUDENTS` — Count of single-parent CTE students
- `ELIG_PREG_REL_SVCS_DAYS` — Eligible pregnancy-related services days

## Quality Notes

- FERPA masking: counts below 10 replaced with -999. The loader converts these to NULL.
- Year 2024-25 (PRU_11507_25) has only 497 rows vs ~1,050 in prior years — likely reflects partial year reporting or fewer districts reporting at that time.
- All 5 CSV files parsed successfully with no encoding errors.
- 2 TEA cover emails (.eml) included as correspondence artifacts.

## Loader

- `loader.py` — Reads CSVs from holding dir, converts -999 to NULL, writes to tea_data.db
- `--dry-run`: prints row counts per table
- `--commit`: inserts rows (skips if table already has data)
- Target DB: `~/spring-2026/texas-gov-data-mcp/data/tea_data.db`
