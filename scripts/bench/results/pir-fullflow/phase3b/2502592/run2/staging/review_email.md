# PIR #2502592 — Gateway Review

## Cross-Reference Table

| Requested Item | Status |
|----------------|--------|
| PREGNANT_CTE_STUDENTS (2020-25) | Delivered — 4,742 rows |
| SINGLEPAR_CTE_STUDENTS (2020-25) | Delivered — 4,742 rows |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | Delivered — 4,742 rows |
| E1012 PEP-INDICATOR-CODE (2020-25) | No Responsive — deleted in 2012 |

## Dataset Inventory (from row_counts.json)

| Table | Rows |
|-------|------|
| research_pir2502592_20202021 | 1,043 |
| research_pir2502592_20212022 | 1,070 |
| research_pir2502592_20222023 | 1,069 |
| research_pir2502592_20232024 | 1,063 |
| research_pir2502592_20242025 | 497 |
| **Total** | **4,742** |

## Data Quality (from README.md)

- FERPA masking: -999 converted to NULL (3,020 masked cells across 3 numeric columns in the full 9,116-row table)
- District counts: ~1,043-1,100 per year (full state coverage)
- 2024-2025 partial: 497 rows (mid-year PEIMS reporting)
- Combined with PIR #2502803 (years 2016-17 through 2019-20, 4,374 rows) for a total of 9,116 rows in `research_pregnancy_services`

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

## Draft Acknowledgment to TEA (Jenny Eaton)

[View draft](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)

---

**Pre-APPROVED:** Data was committed in the previous session (4,742 rows). Tracker has been corrected (status=received, lease cleared). Staging artifacts recreated for completeness.

Reply APPROVE to confirm, REVISE <feedback> to adjust, REJECT to cancel.
