# PIR #2502592 — District-Level Pregnancy Related Services Data (PEIMS)

**Requester:** Kevin Hopper (kevin.hopper1@gmail.com)  
**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Filed:** 2026-01-29  
**Response Received:** 2026-05-29  
**Purpose:** Academic research on at-risk factors in Texas school districts (UNT graduate coursework)

## Data Received

The TEA delivered district-level PEIMS data for 3 Pregnancy Related Services data elements across 5 school years:

| PEIMS Element | Name | Description |
|---|---|---|
| E1012 | PEP-INDICATOR-CODE | Pregnancy, Education, and Parenting program participation indicator |
| E0829 | SGL-PARENT-PREG-TEEN-CODE | Single Parent / Pregnant Teen indicator for CTE students |
| E0939 | TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Total days present while eligible for pregnancy related services |

## Staging Inventory

| Table | CSV File | Rows | School Year |
|---|---|---|---|
| research_pir2502592_2020_2021 | PRU_11507_21.csv | 1,043 | 2020-2021 |
| research_pir2502592_2021_2022 | PRU_11507_22.csv | 1,070 | 2021-2022 |
| research_pir2502592_2022_2023 | PRU_11507_23.csv | 1,069 | 2022-2023 |
| research_pir2502592_2023_2024 | PRU_11507_24.csv | 1,063 | 2023-2024 |
| research_pir2502592_2024_2025 | PRU_11507_25.csv | 497 | 2024-2025 |
| **Total** | | **4,742** | |

## Schema (per table)

| Column | Type | Notes |
|---|---|---|
| YEAR | TEXT | School year (e.g., "2020-2021") |
| DISTRICT | TEXT | 6-digit TEA district ID |
| DISTNAME | TEXT | District name |
| PREGNANT_CTE_STUDENTS | INTEGER | E1012 — masked: -999 → NULL |
| SINGLEPAR_CTE_STUDENTS | INTEGER | E0829 — masked: -999 → NULL |
| ELIG_PREG_REL_SVCS_DAYS | REAL | E0939 — masked: -999 → NULL |

## Quality Flags

- **FERPA masking:** All numeric fields use -999 for values masked under FERPA. Loader converts to NULL.
- **Completeness:** All 5 requested school years (2020-21 through 2024-25) delivered.
- **2024-25 row count (497):** Significantly lower than other years (1,043–1,070). This may indicate partial data, or districts that only report when they have non-zero values in at least one category. Verify before analysis.
- **District coverage:** Earlier years cover ~1,043–1,070 districts. Verify against TEA's total district count for the respective years.
- **Format:** CSV with consistent 6-column schema across all 5 files. No structural issues found.

## Loader

`loader.py` supports `--dry-run` (print row counts) and `--commit` (insert into tea_data.db). Duplicate guard prevents re-loading existing tables.
