# PIR #2502592 — Review for Commit

**PIR:** TEA Pregnancy/Parenting PEIMS Data (2020-25)  
**Status:** 5 CSV files, 4,742 total rows  
**Received:** 2026-06-04  

---

## Cross-Reference: Requested Items vs Delivered

| Requested Item | Status |
|---|---|
| PREGNANT_CTE_STUDENTS (2020-25) | **Delivered** — 4,742 rows across 5 CSVs |
| SINGLEPAR_CTE_STUDENTS (2020-25) | **Delivered** — 4,742 rows across 5 CSVs |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | **Delivered** — 4,742 rows across 5 CSVs |
| E1012 PEP-INDICATOR-CODE (2020-25) | **No responsive records** — TEA notes PEP_ATTEND deleted in 2012 |

## Dataset Inventory (from row_counts.json)

| Table | Source File | Rows |
|---|---|---|
| research_pir2502592_2020_2021 | PRU_11507_21.csv | 1,043 |
| research_pir2502592_2021_2022 | PRU_11507_22.csv | 1,070 |
| research_pir2502592_2022_2023 | PRU_11507_23.csv | 1,069 |
| research_pir2502592_2023_2024 | PRU_11507_24.csv | 1,063 |
| research_pir2502592_2024_2025 | PRU_11507_25.csv | 497 |
| **Total** | | **4,742** |

## Data Quality Notes (from README.md)

- **FERPA Masking:** Counts below 10 replaced with -999; loader converts to NULL.
- **2024-25 anomaly:** Only 497 rows vs ~1,050-1,070 in prior years — possibly partial year or late-reporting districts.
- **Columns:** YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS (all TEXT).
- All files delivered at no charge.

## Draft Reply to TEA

See: _staging/2502592/draft_acknowledgment.txt

---

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

## Instructions

Reply **APPROVE** to commit the data load and create the draft reply.
Reply **REVISE** with feedback to adjust.
Reply **REJECT** to cancel processing.
