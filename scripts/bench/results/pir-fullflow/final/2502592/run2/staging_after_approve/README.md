# PIR #2502592 — TEA Pregnancy/Parenting PEIMS Data (2020-25)

**Recipient:** Texas Education Agency  
**Date Received:** 2026-06-05  
**Data Years:** 2020-2021 through 2024-2025  
**Request ID:** PRU_11507  
**Contact:** pir@tea.texas.gov (Jenny Eaton)

## Summary

TEA delivered 5 CSV files containing district-level PEIMS data on pregnancy-related services. The response covers all 5 requested school years (2020-21 through 2024-25).

### Data Delivered

| Item | Status | Mapped Column(s) |
|------|--------|-----------------|
| E1012 PEP-INDICATOR-CODE | No Responsive Records | N/A — TEA confirmed this indicator was deleted from PEIMS in 2012 |
| E0829 SGL-PARENT-PREG-TEEN-CODE | Delivered | SINGLEPAR_CTE_STUDENTS |
| E0939 TOTAL-ELIG-PREG-REL-SVCS-DAYS-PRESENT | Delivered | ELIG_PREG_REL_SVCS_DAYS |

### Dataset Inventory

| File | Year | Rows |
|------|------|------|
| PRU_11507_21.csv | 2020-2021 | 1,043 |
| PRU_11507_22.csv | 2021-2022 | 1,070 |
| PRU_11507_23.csv | 2022-2023 | 1,069 |
| PRU_11507_24.csv | 2023-2024 | 1,063 |
| PRU_11507_25.csv | 2024-2025 | 497 |
| **Total** | | **4,742** |

### Data Quality Notes

- **Unique districts across all years:** 1,108
- **FERPA masking (-999):** 2,037 of 14,226 data cells (14.3%)
  - PREGNANT_CTE_STUDENTS: 978 masked (6.9%)
  - SINGLEPAR_CTE_STUDENTS: 1,059 masked (7.4%)
  - ELIG_PREG_REL_SVCS_DAYS: 0 masked (0%)
- **Year 2024-25:** Only 497 rows (partial data, still in progress)
- **Masking rate declining over time:** 2020-21 had 49.4% masked vs 2023-24 at 36.9%, consistent with fewer small districts reporting as programs mature

### Schema

All 5 CSV files share the same 6-column structure:
- `YEAR` — School year (e.g., "2020-2021")
- `DISTRICT` — 5-digit TEA district ID
- `DISTNAME` — District name
- `PREGNANT_CTE_STUDENTS` — Count of pregnant CTE students (FERPA-masked: -999)
- `SINGLEPAR_CTE_STUDENTS` — Count of single-parent CTE students (FERPA-masked: -999)
- `ELIG_PREG_REL_SVCS_DAYS` — Eligible pregnancy-related services days (numeric, 0.0 for non-eligible)

### Files

- Source CSVs: `pir-incoming/2502592/PRU_11507_21.csv` through `PRU_11507_25.csv`
- Correspondence: `pir-incoming/2502592/Public Information Request - District-Level Pregnancy Related Services Data (PEIMS).eml`

### Staging Artifacts

- `loader.py` — Python loader (supports --dry-run and --commit)
- `source_inventory.json` — Detailed file inventory
- `row_counts.json` — Per-table row counts from dry-run
- `claims.json` — Verified tallies from computed_facts
