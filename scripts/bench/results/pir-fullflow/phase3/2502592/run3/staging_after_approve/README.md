# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Filed:** 2026-01-30 | **Received:** 2026-06-04  
**Sub-question:** SQ3 (cost estimate / follow-up)  
**Priority:** HIGH

## Summary

TEA released 5 CSV files containing district-level PEIMS data on Pregnancy Related Services for school years 2020-21 through 2024-25. Data provided at no charge. Total: **4,742 data rows** across 5 tables.

## Requested vs. Received

| Requested Element | Status |
|---|---|
| PREGNANT_CTE_STUDENTS | Delivered (all 5 years) |
| SINGLEPAR_CTE_STUDENTS | Delivered (all 5 years) |
| ELIG_PREG_REL_SVCS_DAYS | Delivered (all 5 years) |
| E1012 PEP-INDICATOR-CODE / PEP_ATTEND | No responsive records (deleted in 2012) |

## Dataset Inventory

| File | Table | Year | Rows | Columns |
|---|---|---|---|---|
| PRU_11507_21.csv | research_pir2502592_21 | 2020-21 | 1,043 | 6 |
| PRU_11507_22.csv | research_pir2502592_22 | 2021-22 | 1,070 | 6 |
| PRU_11507_23.csv | research_pir2502592_23 | 2022-23 | 1,069 | 6 |
| PRU_11507_24.csv | research_pir2502592_24 | 2023-24 | 1,063 | 6 |
| PRU_11507_25.csv | research_pir2502592_25 | 2024-25 | 497 | 6 |

**Columns:** YEAR, DISTRICT (TEA ID), DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS

## Data Quality Notes

- **FERPA masking:** Values of -999 indicate district-level counts fewer than 10 (FERPA threshold). These are NOT actual -999 values.
- **Year 2024-25 coverage:** Only 497 districts reported vs ~1,050+ for prior years. This reflects incomplete PEIMS reporting for the most recent school year, not missing data.
- **Consistency:** All 5 CSVs share identical column structure. District TEA IDs and names are consistent across years.
- **Source:** PRU_11507 prefix indicates TEA processing batch number 11507.
- **No TEA cover letter/response email found** in attachments — the 5 CSVs were released directly with no accompanying correspondence text.

## Loader

See `loader.py` for the staged data loader. Run with `--dry-run` to verify row counts or `--commit` to load into tea_data.db.

## Related

- PIR #2502803 (follow-up) requests years 2016-17 through 2019-20 (due 2026-04-15, extended to 2026-06-02).
