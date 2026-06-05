# PIR #2502592 — Gateway Review

**PIR:** TEA Pregnancy/Parenting PEIMS (2020-25)
**Recipient:** Texas Education Agency (PIR@tea.texas.gov)
**Received:** 2026-02-26 | **5 CSV files, 4,742 total rows**

---

## Cross-Reference: Requested Items vs. Deliverables

| Requested Item | Status | Notes |
|---|---|---|
| E0829 (SINGLEPAR_CTE_STUDENTS) | **Delivered** | District-level counts, FERPA-masked |
| E0939 (PREGNANT_CTE_STUDENTS) | **Delivered** | District-level counts, FERPA-masked |
| ELIG_PREG_REL_SVCS_DAYS | **Delivered** | Services days, district-level |
| E1012 (PEP-INDICATOR-CODE) | **No responsive** | Deleted 2012, per TEA prior notice |

## Dataset Inventory (from loader dry-run)

| Table | File | Year | Rows |
|---|---|---|---|
| research_pir2502592_2020_2021 | PRU_11507_21.csv | 2020-21 | 1,043 |
| research_pir2502592_2021_2022 | PRU_11507_22.csv | 2021-22 | 1,070 |
| research_pir2502592_2022_2023 | PRU_11507_23.csv | 2022-23 | 1,069 |
| research_pir2502592_2023_2024 | PRU_11507_24.csv | 2023-24 | 1,063 |
| research_pir2502592_2024_2025 | PRU_11507_25.csv | 2024-25 | 497 |
| **Total** | | | **4,742** |

## Data Quality Notes

- **FERPA masking:** Counts below 10 replaced with -999 → converted to NULL in loader.
- **2024-25 partial:** Only 497 districts (vs 1,063-1,070 in prior years). Likely because 2024-25 PEIMS is not yet finalized for all districts.
- **Schema consistency:** All 5 files share identical 6-column structure. No mismatches.
- **Year coverage:** Complete — all 5 requested years delivered.

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md) — Full documentation
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py) — DB loader (dry-run passed)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json) — File inventory
- [claims.json](http://100.118.41.122:8080/api/pir/staging/2502592/claims.json) — Verified row counts
- [draft_acknowledgment.txt](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt) — Reply to TEA

## Draft Reply to TEA

> Dear TEA Public Information Office,
>
> I have received the five CSV files (PRU_11507_21 through PRU_11507_25) containing district-level PEIMS data for pregnancy and parenting services, covering school years 2020-21 through 2024-25. Thank you for providing this data at no charge.
>
> I note that E1012 (PEP-INDICATOR-CODE) was not produced, consistent with your prior notice that this element was deleted in 2012.
>
> I will review the data and reach out if I have follow-up questions.
>
> Kevin Hopper
> kevin.hopper1@gmail.com

---

**Related:** PIR #2502803 (follow-up for 2016-17 through 2019-20, due 2026-04-15)

**Instructions:** Reply **APPROVE** to commit the data load and create the draft reply. Reply **REVISE \<your feedback\>** to adjust. Reply **REJECT** to cancel processing.
