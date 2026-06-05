# PIR #2502592 — Gateway Review

## Summary
TEA responded to our PIR #2502592 requesting district-level PEIMS data on pregnancy-related CTE services. They released 5 CSV files covering school years 2020-21 through 2024-25 at no charge.

## Requested Items Status

| Requested Field | Status |
|-----------------|--------|
| PREGNANT_CTE_STUDENTS (2020-25) | **Delivered** — 5 CSVs, 4742 rows total |
| SINGLEPAR_CTE_STUDENTS (2020-25) | **Delivered** — 5 CSVs, 4742 rows total |
| ELIG_PREG_REL_SVCS_DAYS (2020-25) | **Delivered** — 5 CSVs, 4742 rows total |
| E1012 PEP_INDICATOR_CODE (2020-25) | **No Responsive** — deleted in 2012 (per TEA) |

## Dataset Inventory

| Table | Year | Rows |
|-------|------|------|
| research_pir2502592_PRU_11507_21 | 2020-2021 | 1043 |
| research_pir2502592_PRU_11507_22 | 2021-2022 | 1070 |
| research_pir2502592_PRU_11507_23 | 2022-2023 | 1069 |
| research_pir2502592_PRU_11507_24 | 2023-2024 | 1063 |
| research_pir2502592_PRU_11507_25 | 2024-2025 | 497 |
| **Total** | | **4742** |

## Quality Flags

- **FERPA masking**: 978 cells in PREGNANT_CTE_STUDENTS (6.9%) and 1059 in SINGLEPAR_CTE_STUDENTS (7.4%) show -999 (counts <10). ELIG_PREG_REL_SVCS_DAYS has zero masked values (0%).
- **District coverage**: 1,108 unique districts across all 5 years.
- **Year 2024-25 anomaly**: Only 497 rows vs ~1050-1070 for prior years — likely partial reporting or fewer districts active in 2024-25.

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

## Draft Reply to TEA

[Inline — see _staging/2502592/draft_acknowledgment.txt]

> Dear Jenny Eaton,
>
> Thank you for providing the responsive records for PIR #2502592. I have received the five CSV files covering district-level PEIMS data for school years 2020-21 through 2024-25, including counts for PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, and ELIG_PREG_REL_SVCS_DAYS. I note that the E1012 PEP_INDICATOR_CODE is not available due to its deletion in 2012.
>
> I appreciate the prompt response and that the records were released at no charge.
>
> Sincerely,
> Kevin Hopper
> kevin.hopper1@gmail.com

## Notes

- This PIR was previously loaded on 2026-02-26 (same data, same row count). This re-run uses the new table naming convention `research_pir<pir_number>_<dataset>`.
- **PIR #2502803**: Follow-up request for years 2016-17 through 2019-20, due April 15, 2026.

## Instructions

Reply **APPROVE** to commit the data load and create the draft reply.
Reply **REVISE \<your feedback\>** to adjust.
Reply **REJECT** to cancel processing.
