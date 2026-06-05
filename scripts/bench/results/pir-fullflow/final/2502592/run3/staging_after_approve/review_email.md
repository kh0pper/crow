# PIR #2502592 — Staging Complete — Awaiting Approval

**Entity:** Texas Education Agency (TEA)  
**Contact:** pir@tea.texas.gov (Jenny Eaton)  
**Received:** 2026-05-13 (re-staged 2026-06-05)

---

## Cross-Reference

| Original Request Items | Status |
|------------------------|--------|
| Pregnancy/parenting PEIMS data (2020-21 through 2024-25) | **Delivered** — 5 CSV files, 4742 rows |
| E1012 PEP_ATTEND | Partial — deleted in 2012 (per status_notes) |

## Dataset Inventory

| File | Table | Year | Rows |
|------|-------|------|------|
| PRU_11507_21.csv | research_pir2502592_PRU_11507_21 | 2020-2021 | 1043 |
| PRU_11507_22.csv | research_pir2502592_PRU_11507_22 | 2021-2022 | 1070 |
| PRU_11507_23.csv | research_pir2502592_PRU_11507_23 | 2022-2023 | 1069 |
| PRU_11507_24.csv | research_pir2502592_PRU_11507_24 | 2023-2024 | 1063 |
| PRU_11507_25.csv | research_pir2502592_PRU_11507_25 | 2024-2025 | 497 |
| **Total** | | | **4742** |

## Quality Flags

**FERPA Masking:** Counts below 10 replaced with -999.
- PREGNANT_CTE_STUDENTS: 978 masked cells (20.6% of data)
- SINGLEPAR_CTE_STUDENTS: 1059 masked cells (22.3% of data)
- ELIG_PREG_REL_SVCS_DAYS: 0 masked (not applicable)

**Year Coverage:** Years 2020-21 through 2023-24 have full district counts (~1043-1070 each). Year 2024-25 has only 497 rows (school year not yet complete).

**Unique Districts:** 1108 unique districts across all 5 files.

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)
- [row_counts.json](http://100.118.41.122:8080/api/pir/staging/2502592/row_counts.json)
- [claims.json](http://100.118.41.122:8080/api/pir/staging/2502592/claims.json)
- [draft_acknowledgment.txt](http://100.118.41.122:8080/api/pir/staging/2502592/draft_acknowledgment.txt)

## Draft Reply to TEA

> Dear Jenny Eaton,
>
> Thank you for sending the district-level pregnancy-related services data for PIR #2502592. I have received the 5 CSV files (PRU_11507_21 through 25) covering school years 2020-21 through 2024-25, along with the correspondence emails.
>
> I confirm receipt of all records as listed in your transmission. The data will be processed for our research use.
>
> Please let me know if you need anything further.
>
> Best regards,  
> Kevin Hopper  
> kevin.hopper1@gmail.com

---

**Reply APPROVE to commit the data load and create the draft reply.**  
**Reply REVISE <your feedback> to adjust.**  
**Reply REJECT to cancel processing.**
