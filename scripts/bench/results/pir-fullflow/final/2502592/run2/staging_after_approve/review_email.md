# PIR #2502592 — Review Email

## Cross-Reference: Requested Items vs. Deliverables

| Requested Item | Status | Notes |
|---|---|---|
| E1012 PEP-INDICATOR-CODE | No Responsive Records | Indicator deleted from PEIMS in 2012 |
| E0829 SGL-PARENT-PREG-TEEN-CODE | Delivered | Mapped to SINGLEPAR_CTE_STUDENTS |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Delivered | Mapped to ELIG_PREG_REL_SVCS_DAYS |

## Dataset Inventory

| File | Year | Rows |
|---|---|---|
| PRU_11507_21.csv | 2020-2021 | 1,043 |
| PRU_11507_22.csv | 2021-2022 | 1,070 |
| PRU_11507_23.csv | 2022-2023 | 1,069 |
| PRU_11507_24.csv | 2023-2024 | 1,063 |
| PRU_11507_25.csv | 2024-2025 | 497 |
| **Total** | | **4,742** |

## Quality Flags

- **FERPA masking:** 2,037 of 14,226 data cells (14.3%) are -999
  - PREGNANT_CTE_STUDENTS: 978 masked (6.9%)
  - SINGLEPAR_CTE_STUDENTS: 1,059 masked (7.4%)
  - ELIG_PREG_REL_SVCS_DAYS: 0 masked
- **Unique districts:** 1,108 across all five years
- **2024-25 partial:** Only 497 rows (still being compiled by TEA)
- **Masking trend declining:** 49.4% → 36.9% over the five years, consistent with program maturation

## Staging Files

- [README.md](http://100.118.41.122:8080/api/pir/staging/2502592/README.md)
- [loader.py](http://100.118.41.122:8080/api/pir/staging/2502592/loader.py)
- [source_inventory.json](http://100.118.41.122:8080/api/pir/staging/2502592/source_inventory.json)

## Draft Acknowledgment to TEA

```
Dear Jenny Eaton and the Texas Education Agency Public Information Office,

I acknowledge receipt of the records responsive to my Public Information Request #2502592, filed January 29, 2026. I received five CSV files containing district-level PEIMS data on pregnancy-related services for school years 2020-21 through 2024-25, along with the correspondence files. Thank you for producing this data at no charge.

This acknowledgment is for my records. I do not require any further action at this time.

Sincerely,
Kevin Hopper
kevin.hopper1@gmail.com
```

## Instructions

Reply **APPROVE** to commit the data load and create the draft reply.
Reply **REVISE <your feedback>** to adjust.
Reply **REJECT** to cancel processing.
