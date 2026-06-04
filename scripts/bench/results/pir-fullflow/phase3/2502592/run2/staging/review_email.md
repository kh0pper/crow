# PIR #2502592 — Review for Commit

**TEA Pregnancy/Parenting PEIMS Data (2020-25)**
**Recipient:** Texas Education Agency (PIR@tea.texas.gov) | **SQ3** | **HIGH priority**

---

## Cross-Reference Table

| Original Request Item | Status | Notes |
|-----------------------|--------|-------|
| PREGNANT_CTE_STUDENTS (2020-25) | Delivered | 5 CSV files, 4,742 rows |
| SINGLEPAR_CTE_STUDENTS (2020-25) | Delivered | 5 CSV files, 4,742 rows |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | Delivered | 5 CSV files, 4,742 rows |
| E1012 PEP-INDICATOR-CODE | No responsive | TEA noted deleted in 2012 (known) |

## Dataset Inventory

| File | Table | Rows | Year |
|------|-------|------|------|
| PRU_11507_21.csv | research_pir2502592_21 | 1,043 | 2020-21 |
| PRU_11507_22.csv | research_pir2502592_22 | 1,070 | 2021-22 |
| PRU_11507_23.csv | research_pir2502592_23 | 1,069 | 2022-23 |
| PRU_11507_24.csv | research_pir2502592_24 | 1,063 | 2023-24 |
| PRU_11507_25.csv | research_pir2502592_25 | 497 | 2024-25 |
| **Total** | | **4,742** | |

## Quality Notes

- **FERPA masking:** 1,526 rows (32.2%) contain -999 values. Masking rate decreases over time as district reporting improves.
- **Year 2024-25 partial:** 497 rows due to current-year incomplete reporting.
- **Schema:** All files share identical 6-column structure. No anomalies detected.
- **Cover emails:** 2 .eml files present as correspondence.

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

## Draft Reply to TEA

[Review draft here](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)

---

Reply **APPROVE** to commit the data load and create the draft reply.
Reply **REVISE <your feedback>** to adjust.
Reply **REJECT** to cancel processing.
