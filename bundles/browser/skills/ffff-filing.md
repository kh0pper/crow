---
name: ffff-filing
description: "File a tax return via IRS Free File Fillable Forms. Uses crow-browser for automation and crow-tax for calculations. Activates when user asks to file taxes, submit return, or use FFFF."
allowed-tools: ["exec", "message"]
---

# FFFF Filing Skill

You automate IRS Free File Fillable Forms (FFFF) filing using crow-browser for browser control and crow-tax for calculated return data.

## Pre-Flight Checklist

Before starting, verify:
1. crow-tax return is **calculated** (`crow_tax_calculate`) — all documents ingested and verified
2. crow-browser container is running (`crow_browser_status`)
3. User has VNC open to watch (Browser panel or `/proxy/browser/vnc.html`)

## CRITICAL RULES

1. **NEVER assume answers to factual questions.** You MUST ask the user:
   - How many years has AOTC been claimed for this student?
   - Was the student at least half-time? Graduate or undergraduate?
   - Was the taxpayer covered by HDHP all year? How many months?
   - Any virtual currency transactions?
   - Any foreign accounts (FBAR)?
   - Any health insurance marketplace coverage?
   - Is a 6013(h) election needed? What was the green card date?

2. **NEVER submit the return.** The user reviews and submits manually in VNC.

3. **Always pause for human intervention** on:
   - CAPTCHA / reCAPTCHA
   - Two-factor authentication / security questions
   - Confirmation popups (let user click Yes/No)
   - Final review before e-file

4. **W-2 data MUST be verified with the user.** PDF ingestion is unreliable:
   - Show extracted values side-by-side with box labels
   - Highlight any discrepancies (e.g., TRS employees have blank SS boxes)
   - User confirms each W-2 before data is added to the return

5. **Screenshot before and after every major step** for verification.

## FFFF Page Structure

FFFF has a multi-frame layout:
- **Main frame**: Contains the top tabs (Step 1–4), action buttons (Save, Do the Math, Print, etc.)
- **Tree frame** (`ffi_treeview_redirect`): Left sidebar with form list. Each form is an `<li>` with `onclick="LoadFormOnTreeRequest('formId')"`. Click the `<li>` element to navigate.
- **Form frame** (`ffi_page_redirect`): Right pane where form content renders. Changes when you click a form in the tree.

**Form IDs in tree:**
- `Form 1040`: tree item text starts with "Form 1040 - U.S."
- `Schedule 1`: `id="formf1040s1"`, calls `LoadFormOnTreeRequest('f1040s1')`
- `Form 8889`: `id="formf8889t"`, calls `LoadFormOnTreeRequest('f8889t')`
- `Form 8863`: `id="formf8863"`, calls `LoadFormOnTreeRequest('f8863')`
- `W-2 forms`: tree items contain employer name

**Field lookup**: Use `title` attribute (NOT `aria-label` — despite the attribute existing, `title` is what FFFF consistently populates). Field `name` attributes are **randomized per session** — never use them for targeting.

## Filing Flow

### Step 1: Login
```
crow_browser_navigate({ url: "https://www.freefilefillableforms.com" })
crow_browser_screenshot({})
crow_browser_wait_for_user({ message: "Please log in and complete CAPTCHA/2FA. Resume when you're on the forms page." })
```

### Step 2: Add Forms
Click "Add/View Forms" button (`id="btnAddView"`) and add required forms:
1. Schedule 1 (if adjustments exist: educator expense, student loan interest, HSA)
2. Form 8889 (if HSA)
3. Form 8863 (if education credits)

FFFF auto-adds Form 1040. W-2 forms are added in Step 2 (withholding verification).

Handle confirmation dialogs — FFFF shows native `confirm()` when adding forms.

### Step 3: Fill Forms (Bottom-Up)

Navigate between forms by clicking `<li>` elements in the tree frame. Each form renders in the form frame. Fill supporting forms FIRST, then 1040 LAST.

**Fill order:**
1. **Form 8889 (HSA)** — via tree `id="formf8889t"`
   - Line 6: Contribution limit (self $4,300 / family $8,550 for 2025)
   - Line 9: Employer contributions (W-2 code W — NOT deductible)
   - Line 15: Qualified medical expenses
   - Note: Line 14a (distributions) comes from 1099-SA data in W-2 Step 2

2. **Schedule 1** — via tree `id="formf1040s1"`
   - Line 11: Educator expenses (max $300 per educator)
   - Line 21: Student loan interest

3. **Form 8863 Page 2** — student/institution info (via tree, has long encoded ID)
4. **Form 8863 Page 1** — credit calculation (via tree `id="formf8863"`)
   - Lines 13-16: Income limits for LLC
   - Line 19: Nonrefundable credit amount

5. **Form 1040** — via tree (first item)
   - Personal info (name, SSN, address, filing status)
   - Line 1a: Total W-2 wages
   - Line 12e: Standard deduction
   - Line 16: Tax amount
   - Line 25a: Federal income tax withheld (from ALL W-2s)
   - Occupation fields
   - **6013(h) checkbox**: "Check this box, If treating a nonresident alien..." — check if applicable
   - **Digital assets**: Check "No" if no crypto transactions

### Step 4: 6013(h) Election Statement (if applicable)

If the 6013(h) checkbox is checked, FFFF has an **"Add Statement"** button that lets you attach a text statement directly to the e-filed return. You do NOT need to mail it separately.

Use "Add Statement" to enter:
```
Election to Treat Nonresident Alien Spouse as U.S. Resident

Pursuant to IRC Section 6013(g) and (h), we elect to treat [SPOUSE NAME]
(SSN: [SSN]) as a U.S. resident for the entire [YEAR] tax year for purposes
of filing a joint return under Section 6013(a).

[SPOUSE NAME] was a nonresident alien on a [VISA TYPE] at the beginning of
[YEAR]. [He/She] was issued a Permanent Resident Card (green card) on
[DATE], at which point [he/she] became a resident alien under the green
card test (IRC Section 7701(b)(1)(A)(i)).

We understand that by making this election, both spouses' worldwide income
is subject to U.S. tax for the entire [YEAR] tax year.
```

### Step 5: "Do the Math"

The "Do the Math" button is in the **main frame** (`id="btnPerformMath"`), NOT in the form frame.

Strategy:
1. Snapshot all editable field values in the form frame before clicking
2. Click `#btnPerformMath` in the main page
3. Wait 8 seconds for recalculation
4. Re-read all field values
5. Check for cleared fields — refill from snapshot if needed
6. Compare key totals against crow-tax calculation (tolerance: $5)

**In practice (from this session):** "Do the Math" did NOT clear fields when values were correct. It updated auto-calculated (readonly) fields properly. The main risk is when FFFF disagrees with a user-entered value.

### Step 6: W-2 Entry (FFFF Step 2)

FFFF Step 2 ("Verify Federal Withholding") is a separate tab. Navigate by clicking the Step 2 tab text in the main frame.

W-2 forms are entered here with all box values (1-6, 12, 13). **This is where the actual W-2 data lives** — the 1040 Line 25a just shows the total.

After entering W-2 data:
- **Line A1** should equal total of all W-2 Box 2 values
- **Line A3** should match 1040 Line 25a
- **Line E** (net difference) should be **$0** — if not, there's a mismatch

**Important for TRS employees (Texas teachers):** Some Texas school districts participate in TRS instead of Social Security. These employees have **blank Box 3 and Box 4** on their W-2. Enter 0 for SS wages and SS tax. Medicare (Box 5/6) is still applicable.

### Step 7: Review & Save

1. Click "Save" (`id="btnSave"`) to save the return
2. Tell user to review all forms in VNC
3. User navigates to Step 4 (E-File) and submits manually
4. **Do NOT automate the final submit**

## FFFF Quirks Reference

- **Field lookup**: Use `title` attribute to find fields. `name` attributes are randomized per session.
- **Tree navigation**: Click `<li>` elements in the tree frame. Each has an `onclick` that calls `LoadFormOnTreeRequest('formId')`.
- **Buttons in main frame**: Save, Do the Math, Print, Add/View Forms, Delete Form — all in the main page frame, NOT the form frame.
- **Confirmation popups**: Native `confirm()` dialogs. Appear in main frame context.
- **"Do the Math" button**: `id="btnPerformMath"` in main frame. Safe to click — snapshot/verify as a precaution.
- **Session timeout**: ~15 min idle. Periodically evaluate something in the main frame to keep alive.
- **Step 2 withholding**: W-2 data entered here feeds into the withholding verification. Line E must be $0.
- **6013(h) statement**: Use "Add Statement" button in FFFF — no need to mail separately.
- **Rounding**: FFFF rounds to whole dollars. Crow-tax values will differ by cents — this is expected.
