# PIR #2502592 — Review for Data Load

## Cross-Reference Table

| Requested Item | Status | Notes |
|---|---|---|
| E1012 PEP-INDICATOR-CODE | No Docs | TEA confirmed element deleted from PEIMS in 2012 |
| E0829 SGL-PARENT-PREG-TEEN-CODE | Delivered | 4,742 rows across 5 CSV files |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Delivered | 4,742 rows across 5 CSV files |
| All Texas districts | Delivered | District-level aggregated data |
| Years 2020-21 through 2024-25 | Delivered | 5 CSV files |

## Dataset Inventory

| File | School Year | Rows |
|---|---|---|
| PRU_11507_21.csv | 2020-2021 | 1,043 |
| PRU_11507_22.csv | 2021-2022 | 1,070 |
| PRU_11507_23.csv | 2022-2023 | 1,069 |
| PRU_11507_24.csv | 2023-2024 | 1,063 |
| PRU_11507_25.csv | 2024-2025 | 497 |
| **TOTAL** | | **4,742** |

## Data Notes

- **FERPA masking:** Counts below 10 are replaced with -999 in the raw data. Loader converts -999 to NULL.
- **2024-2025 partial year:** Only 497 records vs 1,043-1,070 for full years. This is a partial-year snapshot, not a data quality issue.
- **No E1012 data:** Element was deleted from PEIMS in 2012 per TEA.
- All CSV files have identical column structure and are consistent in format.

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

## Draft Reply to TEA (Jenny Eaton)

[View reply](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)

---

Reply APPROVE to commit the data load and create the draft reply.
Reply REVISE <your feedback> to adjust.
Reply REJECT to cancel processing.
