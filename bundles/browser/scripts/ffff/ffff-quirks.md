# FFFF Quirks & Known Behaviors

Documented from the 2025 filing sessions. Reference before any FFFF automation.

## Page Structure

FFFF uses a multi-frame layout:
- **Main frame**: Top-level page with tabs (Step 1-4) and action buttons
- **Tree frame** (`ffi_treeview_redirect`): Left sidebar form list
- **Form frame** (`ffi_page_redirect`): Right pane where selected form renders

Navigation: click `<li>` in tree frame → form loads in form frame. Each `<li>` has `onclick="LoadFormOnTreeRequest('formId')"`.

## Field Identification

- **Use `title` attribute** to find fields (always populated, human-readable)
- **Do NOT use `name` attribute** — randomized per session (e.g., `e3570900328`, `s2026521355`)
- **Do NOT use `aria-label`** — not consistently populated (many are null)
- **Do NOT use `id`** — also randomized

Field titles follow the pattern: `Line 1a. Total amount from Form(s) W-2, box 1 (see instructions)`

## Buttons Location

Action buttons are in the **main frame**, NOT the form frame:
- `id="btnPerformMath"` — Do the Math
- `id="btnSave"` — Save
- `id="btnPrintForms"` — Print Return
- `id="btnAddView"` — Add/View Forms
- `id="btnDeleteForm"` — Delete this Form
- `id="btnCompletedForm"` — Done With This Form
- `id="btnFormInstruction"` — Instructions For This Form

## "Do the Math" Behavior

The button recalculates all auto-calculated (readonly) fields. From testing:
- **Editable fields were NOT cleared** when values were consistent
- **Auto-calculated fields updated correctly** based on editable inputs
- The button disables itself after click (`this.disabled=true`) then submits
- Wait 8 seconds after clicking for full recalculation

**Precaution:** Still snapshot editable fields before clicking, in case future FFFF versions behave differently.

## Confirmation Popups

FFFF uses native `confirm()` dialogs for:
- Adding/removing forms
- Certain navigation actions

These appear in the main frame context. Handle with `page.on('dialog')`.

## Session Timeout

Sessions expire after ~15 minutes of inactivity. Symptoms:
- Fields become unresponsive
- Navigation returns to login page

**Prevention:** Periodically evaluate a no-op in the main frame (e.g., read `document.title`).

## Step 2: W-2 / Withholding Verification

FFFF has a separate "Step 2" tab for W-2 data entry. This is where:
- W-2 Box 1-6, 12, 13 values are entered per employer
- 1099-SA distribution data is entered
- Total withholding is verified against 1040 Line 25

**Critical check:** After entering all W-2 data, Line E (net difference) must be $0. If not, there's a mismatch between W-2 data and 1040 Line 25.

## TRS Employees (Texas Teachers)

Most Texas public school teachers pay into TRS (Teacher Retirement System) instead of Social Security. Their W-2s have:
- **Box 3 (SS wages): BLANK** — enter 0
- **Box 4 (SS tax): BLANK** — enter 0
- **Box 5 (Medicare wages): POPULATED** — may differ from Box 1 due to pre-tax deductions
- **Box 6 (Medicare tax): POPULATED**
- **Box 13 (Retirement plan): CHECKED**

Some Texas districts are exceptions and DO pay Social Security. Check the employee's W-2 to confirm.

## 6013(h) Election Statement

If filing jointly with a nonresident alien spouse (6013(h) election):
1. Check the "nonresident alien or dual-status alien spouse" checkbox on Form 1040
2. Use FFFF's **"Add Statement"** button to attach the election text directly to the e-filed return
3. **No separate mailing is required** — the statement is included with the electronic filing

## Rounding

FFFF rounds all amounts to whole dollars. Crow-tax calculates to the cent. Small differences (< $1) are expected and normal. Compare at the dollar level.

## Form 8889 (HSA) Notes

- Line 14a (distributions) and Line 14c are populated from 1099-SA data entered in Step 2
- Line 9 (employer contributions) = W-2 code W amount — this is NOT deductible
- Line 13 (HSA deduction) = personal contributions only (employer contributions excluded)
- If employer contributions (line 9) exceed the limit (line 8), the excess is taxable

## E-File Is Step 4

The e-file submission is in "Step 4". This should NEVER be automated — the user must review and submit manually.
