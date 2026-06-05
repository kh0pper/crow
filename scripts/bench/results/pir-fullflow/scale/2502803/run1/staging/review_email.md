# Review: PIR #2502803 — TEA Pregnancy/Parenting PEIMS Data (2016-20)

## Summary

TEA released 4 CSV files containing district-level PEIMS data for pregnant CTE students, single-parent CTE students, and eligible pregnancy-related services days for school years 2016-17 through 2019-20. The data was delivered at no charge with FERPA masking applied. All requested items are accounted for.

## Cross-Reference Table

| Requested Item | Status | Notes |
|---|---|---|
| PREGNANT_CTE_STUDENTS by district, 2016-20 | Delivered | 4 CSV files, 4374 rows total |
| SINGLEPAR_CTE_STUDENTS by district, 2016-20 | Delivered | Same files |
| ELIG_PREG_REL_SVCS_DAYS by district, 2016-20 | Delivered | Same files |
| Years 2016-17 through 2019-20 | Delivered | 2020-21 through 2024-25 under PIR #2502592 |

## Dataset Inventory

| File | Year | Rows | Masked P | Masked SP |
|---|---|---|---|---|
| PRU_11576_17.csv | 2016-2017 | 1,087 | 268 | 284 |
| PRU_11576_18.csv | 2017-2018 | 1,092 | 240 | 291 |
| PRU_11576_19.csv | 2018-2019 | 1,095 | 223 | 250 |
| PRU_11576_20.csv | 2019-2020 | 1,100 | 222 | 246 |
| **Total** | | **4,374** | **953** | **1,071** |

Columns: YEAR, DISTRICT, DISTNAME, PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS

## Quality Flags
- FERPA masking: counts fewer than 10 replaced with -999 in pregnant and single-parent columns. No masking found in the services days column.
- Consistent structure across all 4 files.
- District count rises slightly each year (1087 → 1100), consistent with PEIMS reporting changes.
- 3 EML files are duplicates of an amendment letter under PIR #2502592 — not substantive responses.

## Staging Files
- [README.md](http://100.118.41.122:8080/api/pir/staging/2502803/README.md) — full documentation with quality flags
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502803/loader.py) — data loader (--dry-run passed, --commit on approval)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502803/source_inventory.json) — complete file inventory with cross-reference

## Draft Acknowledgment to TEA
[View draft reply](http://100.118.41.122:8080/api/pir/staging/2502803/draft_acknowledgment.txt)

```
Dear Ms. Eaton,

Thank you for releasing the PEIMS data responsive to PIR #2502803. I confirm receipt of four CSV files covering 2016-17 through 2019-20 district-level data for pregnant CTE students, single-parent CTE students, and eligible pregnancy-related services days, totaling 4,374 rows. The FERPA masking is noted.

I will review the data and follow up if I need clarification on any entries.

Kevin Hopper
kevin.hopper1@gmail.com
```

## Next Steps
Reply **APPROVE** to commit the data load and create the draft reply.
Reply **REVISE** with feedback to adjust.
Reply **REJECT** to cancel processing.
