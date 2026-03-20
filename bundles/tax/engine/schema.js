/**
 * Crow Tax — Zod Schemas for Tax Documents
 *
 * Defines the shape of all supported document types and the
 * complete TaxReturn structure.
 */

import { z } from "zod";

// --- Primitives ---

export const FilingStatus = z.enum(["single", "mfj", "mfs", "hoh", "qw"]);

export const Person = z.object({
  name: z.string(),
  ssn: z.string().regex(/^\d{9}$/, "SSN must be 9 digits"),
  dateOfBirth: z.string().optional(),
});

export const Dependent = z.object({
  name: z.string(),
  ssn: z.string().regex(/^\d{9}$/, "SSN must be 9 digits"),
  dateOfBirth: z.string(),
  relationship: z.string(),
  monthsLived: z.number().min(0).max(12).optional(),
  qualifiesForChildTaxCredit: z.boolean().default(false),
  qualifiesForEitc: z.boolean().default(false),
});

// --- Income Documents ---

export const W2 = z.object({
  employer: z.string(),
  ein: z.string().optional(),
  wages: z.number().describe("Box 1: Wages, tips, other compensation"),
  federalWithheld: z.number().describe("Box 2: Federal income tax withheld"),
  ssWages: z.number().describe("Box 3: Social security wages"),
  ssTaxWithheld: z.number().describe("Box 4: Social security tax withheld"),
  medicareWages: z.number().describe("Box 5: Medicare wages and tips"),
  medicareTaxWithheld: z.number().describe("Box 6: Medicare tax withheld"),
  stateWages: z.number().optional().describe("Box 16: State wages"),
  stateWithheld: z.number().optional().describe("Box 17: State income tax"),
  code12: z.array(z.object({
    code: z.string(),
    amount: z.number(),
  })).optional().describe("Box 12 entries (e.g., code W for HSA employer contributions)"),
  isStatutoryEmployee: z.boolean().default(false).describe("Box 13: Statutory employee"),
});

export const Form1099SA = z.object({
  payer: z.string(),
  grossDistribution: z.number().describe("Box 1: Gross distribution"),
  earnings: z.number().optional().describe("Box 2: Earnings on excess contributions"),
  distributionCode: z.number().describe("Box 3: Distribution code (1=normal, 2=excess)"),
  fmv: z.number().optional().describe("Box 4: FMV on date of death"),
  hsaOrMsa: z.enum(["hsa", "archer_msa", "ma_msa"]).default("hsa"),
});

export const Form1099INT = z.object({
  payer: z.string(),
  interest: z.number().describe("Box 1: Interest income"),
  earlyWithdrawalPenalty: z.number().optional().describe("Box 2: Early withdrawal penalty"),
  usSavingsBondInterest: z.number().optional().describe("Box 3: US savings bond interest"),
  federalWithheld: z.number().optional().describe("Box 4: Federal tax withheld"),
  taxExemptInterest: z.number().optional().describe("Box 8: Tax-exempt interest"),
});

export const Form1099DIV = z.object({
  payer: z.string(),
  ordinaryDividends: z.number().describe("Box 1a: Total ordinary dividends"),
  qualifiedDividends: z.number().optional().describe("Box 1b: Qualified dividends"),
  capitalGainDistributions: z.number().optional().describe("Box 2a: Capital gain distributions"),
  federalWithheld: z.number().optional().describe("Box 4: Federal tax withheld"),
});

export const Form1099NEC = z.object({
  payer: z.string(),
  nonemployeeCompensation: z.number().describe("Box 1: Nonemployee compensation"),
  federalWithheld: z.number().optional().describe("Box 4: Federal tax withheld"),
});

export const Form1099G = z.object({
  payer: z.string(),
  unemploymentCompensation: z.number().optional().describe("Box 1: Unemployment compensation"),
  stateRefund: z.number().optional().describe("Box 2: State or local income tax refund"),
  federalWithheld: z.number().optional().describe("Box 4: Federal tax withheld"),
});

export const Form1099MISC = z.object({
  payer: z.string(),
  rents: z.number().optional().describe("Box 1: Rents"),
  royalties: z.number().optional().describe("Box 2: Royalties"),
  otherIncome: z.number().optional().describe("Box 3: Other income"),
  federalWithheld: z.number().optional().describe("Box 4: Federal tax withheld"),
});

// --- Deductions & Credits ---

export const EducatorExpense = z.object({
  name: z.string().describe("Educator name"),
  role: z.enum(["teacher", "instructor", "counselor", "principal", "aide"]),
  k12School: z.boolean().default(true),
  hoursPerYear: z.number().min(0).describe("Hours worked per year (must be 900+)"),
  amount: z.number().describe("Unreimbursed expenses"),
});

export const ScheduleCData = z.object({
  businessName: z.string().optional(),
  businessCode: z.string().optional(),
  ein: z.string().optional(),
  grossReceipts: z.number(),
  costOfGoodsSold: z.number().default(0),
  expenses: z.object({
    advertising: z.number().default(0),
    carAndTruck: z.number().default(0),
    commissions: z.number().default(0),
    insurance: z.number().default(0),
    legalAndProfessional: z.number().default(0),
    officeExpense: z.number().default(0),
    rentOrLease: z.number().default(0),
    supplies: z.number().default(0),
    utilities: z.number().default(0),
    other: z.number().default(0),
  }).default({}),
  homeOfficeDeduction: z.number().default(0),
});

export const CapitalGainTransaction = z.object({
  description: z.string(),
  dateAcquired: z.string().optional(),
  dateSold: z.string(),
  proceeds: z.number(),
  costBasis: z.number(),
  isLongTerm: z.boolean(),
});

// --- Education Credits ---

export const EducationCredit = z.object({
  studentName: z.string(),
  institution: z.string(),
  tuitionPaid: z.number().describe("1098-T Box 1: Payments received for qualified tuition"),
  scholarships: z.number().default(0).describe("1098-T Box 5: Scholarships or grants"),
  isGraduate: z.boolean().default(false).describe("1098-T Box 9: Graduate student"),
  isHalfTime: z.boolean().default(true).describe("1098-T Box 8: At least half-time student"),
  yearsClaimedAotc: z.number().default(0).describe("Number of prior years AOTC was claimed (max 4 total)"),
  felonyDrugConviction: z.boolean().default(false),
});

// --- HSA ---

export const HsaData = z.object({
  coverageType: z.enum(["self", "family"]),
  employerContributions: z.number().describe("From W-2 code W — already excluded from Box 1, NOT deductible"),
  personalContributions: z.number().describe("Personal after-tax contributions — deductible"),
  distributions: z.number().describe("From 1099-SA Box 1"),
  qualifiedExpenses: z.number().describe("Qualified medical expenses paid from HSA"),
  distributionCode: z.number().describe("From 1099-SA Box 3"),
  monthsCovered: z.number().min(1).max(12).default(12),
  hadHdhpFullYear: z.boolean().default(true),
  catchUp55: z.boolean().default(false),
});

// --- Special Situations ---

export const SpecialSituations = z.object({
  nonresidentSpouseElection: z.boolean().default(false).describe("Section 6013(h) election for dual-status spouse"),
  spouseGreenCardDate: z.string().optional().describe("Date spouse became resident (for 6013(h))"),
  blindTaxpayer: z.boolean().default(false),
  blindSpouse: z.boolean().default(false),
  over65Taxpayer: z.boolean().default(false),
  over65Spouse: z.boolean().default(false),
});

// --- Complete Tax Return ---

export const TaxReturn = z.object({
  taxYear: z.number(),
  filingStatus: FilingStatus,
  taxpayer: Person,
  spouse: Person.optional(),
  dependents: z.array(Dependent).default([]),

  w2s: z.array(W2).default([]),
  income1099: z.object({
    sa: z.array(Form1099SA).default([]),
    int: z.array(Form1099INT).default([]),
    div: z.array(Form1099DIV).default([]),
    nec: z.array(Form1099NEC).default([]),
    g: z.array(Form1099G).default([]),
    misc: z.array(Form1099MISC).default([]),
  }).default({}),

  deductions: z.object({
    studentLoanInterest: z.number().optional().describe("From 1098-E"),
    educatorExpenses: z.array(EducatorExpense).default([]),
    hsaPersonalContributions: z.number().optional(),
    iraContributions: z.number().optional(),
    charitableDonations: z.number().optional(),
    medicalExpenses: z.number().optional(),
    mortgageInterest: z.number().optional().describe("From 1098"),
    saltTaxes: z.number().optional().describe("State and local taxes"),
    otherItemized: z.number().optional(),
  }).default({}),

  hsa: HsaData.optional(),

  educationCredits: z.array(EducationCredit).default([]),

  selfEmployment: ScheduleCData.optional(),
  capitalGains: z.array(CapitalGainTransaction).default([]),

  specialSituations: SpecialSituations.default({}),
});
