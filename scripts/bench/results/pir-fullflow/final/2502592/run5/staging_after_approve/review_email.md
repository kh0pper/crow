# PIR #2502592 — Gateway Review

## Cross-Reference Table

| Requested Item | Status |
|---------------|--------|
| PREGNANT_CTE_STUDENTS (2020-25) | Delivered |
| SINGLEPAR_CTE_STUDENTS (2020-25) | Delivered |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | Delivered |
| E1012 PEP-INDICATOR-CODE (2020-25) | No responsive (deleted in 2012) |

## Dataset Inventory

| Table | Year | Rows |
|-------|------|------|
| research_pir2502592_PRU_11507_21 | 2020-2021 | 1043 |
| research_pir2502592_PRU_11507_22 | 2021-2022 | 1070 |
| research_pir2502592_PRU_11507_23 | 2022-2023 | 1069 |
| research_pir2502592_PRU_11507_24 | 2023-2024 | 1063 |
| research_pir2502592_PRU_11507_25 | 2024-2025 | 497 |
| **Total** | | **4742** |

## Quality Notes

- FERPA masking: counts < 10 replaced with `-999` in PREGNANT_CTE_STUDENTS and SINGLEPAR_CTE_STUDENTS.
- Year 2024-25 is partial at 497 rows (vs ~1063 in prior years).
- This PIR was previously loaded on 2026-02-26 (table: research_pregnancy_services). The current staging creates per-year tables named `research_pir2502592_PRU_11507_XX`.

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)
- [row_counts.json](http://100.118.41.122:8080/api/pir/staging/2502592/row_counts.json)

## Draft Reply to TEA

See: http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt

---

Reply APPROVE to commit the data load and create the draft reply.
Reply REVISE <your feedback> to adjust.
Reply REJECT to cancel processing.
