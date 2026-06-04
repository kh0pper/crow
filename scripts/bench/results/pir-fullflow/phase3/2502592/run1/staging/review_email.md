# PIR #2502592 — Gateway Review

**Recipient:** Texas Education Agency (PIR@tea.texas.gov)  
**Status:** requested → awaiting-load  
**Case Type:** Delivery

---

## Cross-Reference Table

| Original Request Item | Entity Response | Status |
|----------------------|-----------------|--------|
| E1012 PEP-INDICATOR-CODE | Not provided — TEA previously noted this field was deleted in 2012 | **No Docs** (known) |
| E0829 SGL-PARENT-PREG-TEEN-CODE | Delivered as `SINGLEPAR_CTE_STUDENTS` | **Delivered** |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Delivered as `ELIG_PREG_REL_SVCS_DAYS` | **Delivered** |

Note: TEA used descriptive column names rather than the PEIMS element codes. The E1012 field was previously noted as deleted in 2012 (per status_notes from Feb 2, 2026 extension).

---

## Dataset Inventory

| Table | File | Rows | Year |
|-------|------|------|------|
| research_pir2502592_21 | PRU_11507_21.csv | 1,043 | 2020-2021 |
| research_pir2502592_22 | PRU_11507_22.csv | 1,070 | 2021-2022 |
| research_pir2502592_23 | PRU_11507_23.csv | 1,069 | 2022-2023 |
| research_pir2502592_24 | PRU_11507_24.csv | 1,063 | 2023-2024 |
| research_pir2502592_25 | PRU_11507_25.csv | 497 | 2024-2025 |
| **Total** | | **4,742** | |

---

## Quality Notes (inline from README.md)

- **FERPA masking:** Counts below 10 are replaced with -999 in all numeric fields (PREGNANT_CTE_STUDENTS, SINGLEPAR_CTE_STUDENTS, ELIG_PREG_REL_SVCS_DAYS).
- **Partial year data:** The 2024-2025 file has 497 rows (vs ~1,000+ for prior years), consistent with partial school year data not yet finalized for the current academic year.
- **Field naming:** TEA used descriptive names instead of PEIMS element codes (E0829 → SINGLEPAR_CTE_STUDENTS, E0939 → ELIG_PREG_REL_SVCS_DAYS).
- **Coverage:** All Texas school districts across 5 school years.
- **Sample districts with non-zero data:** Lufkin ISD, Bryan ISD, Brownsville ISD, Winfree Academy Charter, Carrollton-Farmers Branch ISD, Dallas ISD, Duncanville ISD, Garland ISD, Irving ISD, Richardson ISD.
- **ARC factor cross-ref:** Bryan ISD (15,761 students, Region 6, Brazos County), Dallas ISD (145,113 students, Region 10), Brownsville ISD (40,765 students, Region 1, Cameron County) all present in the dataset.

---

## Draft Acknowledgment to TEA

> Dear Jenny Eaton and the Texas Education Agency Public Information Office,
>
> I have received the five CSV files containing district-level Pregnancy Related Services PEIMS data for school years 2020-21 through 2024-25, released in response to PIR #2502592. I appreciate you providing these records at no charge.
>
> Thank you for your prompt attention to this request.
>
> Sincerely,
> Kevin Hopper
> kevin.hopper1@gmail.com

---

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

---

## Instructions

Reply **APPROVE** to commit the data load and create the draft reply.  
Reply **REVISE \<your feedback\>** to adjust.  
Reply **REJECT** to cancel processing.
