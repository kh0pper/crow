---
name: ffff-filing
description: "File a tax return via IRS Free File Fillable Forms. Uses crow-browser for automation and crow-tax for calculations. Activates when user asks to file taxes, submit return, or use FFFF."
allowed-tools: ["exec", "message"]
---

# FFFF Filing Skill

You automate IRS Free File Fillable Forms (FFFF) filing using crow-browser for browser control and crow-tax for calculated return data.

## Pre-Flight Checklist

Before starting, verify:
1. crow-tax return is **calculated** (call `crow_tax_calculate` if not)
2. crow-browser container is running (`crow_browser_status`)
3. User has VNC open to watch (`http://localhost:6080/vnc.html`)

## CRITICAL RULES

1. **NEVER assume answers to factual questions.** You MUST ask the user:
   - How many years has AOTC been claimed?
   - Was the student at least half-time?
   - Was the taxpayer covered by HDHP all year?
   - Any virtual currency transactions?
   - Any foreign accounts (FBAR)?
   - Any health insurance marketplace coverage?

2. **NEVER submit the return.** The user reviews and submits manually in VNC.

3. **Always pause for human intervention** on:
   - CAPTCHA / reCAPTCHA
   - Two-factor authentication
   - Security questions
   - The "Do you want to proceed?" confirmation popups
   - Final review before e-file

4. **Screenshot before and after every major step** for verification.

## Filing Flow

### Step 1: Login
```
crow_browser_navigate({ url: "https://www.freefilefillableforms.com" })
crow_browser_screenshot({})
# User handles login, CAPTCHA, 2FA in VNC
crow_browser_wait_for_user({ message: "Please log in and complete any security challenges. Call resume when you're on the dashboard." })
```

### Step 2: Add Forms
Navigate to the form picker. Add required forms in this order:
1. Schedule 1 (Additional Income and Adjustments)
2. Form 8889 (HSA)
3. Form 8863 (Education Credits)

For each: click "Add", handle confirmation popup if it appears.

### Step 3: Fill Forms (Bottom-Up)

**Order matters:** Fill supporting forms FIRST, then Form 1040 LAST.

For each form:
1. Get line values from crow-tax: `crow_tax_get_form({ form: "f8889" })`
2. Navigate to the form in FFFF
3. Use `crow_browser_discover_selectors({ filter: "inputs", frame_selector: "iframe" })` to find fields
4. Use field-resolver.js to match crow-tax line IDs to FFFF aria-labels
5. Fill with `crow_browser_fill_form`
6. Screenshot to verify

Fill order:
1. Form 8889 (HSA)
2. Schedule 1 (adjustments)
3. Form 8863 Page 2 (education credit calculation)
4. Form 8863 Page 1 (credit amount)
5. Form 1040 (personal info, income, deductions, tax, credits)

### Step 4: "Do the Math"

**This is the most dangerous step.** FFFF's "Do the Math" button recalculates and CAN CLEAR user-entered fields.

Use `post-math-refill.js` strategy:
1. Snapshot ALL field values before clicking
2. Click "Do the Math"
3. Wait for recalculation
4. Read all field values again
5. Diff: for each changed field:
   - If readonly (calculated): accept FFFF's value. If >$1 difference from crow-tax, WARN and pause
   - If user-entered and cleared: refill from snapshot
   - If user-entered and reformatted (added commas): accept FFFF's format
6. If FFFF totals disagree with crow-tax by >$5: STOP and alert user

### Step 5: W-2 Entry (FFFF Step 2)

FFFF has a separate "Step 2" for entering W-2/withholding data:
1. Navigate to Step 2
2. Enter each W-2's data from crow-tax return
3. Verify totals match

### Step 6: Review

```
crow_browser_wait_for_user({ message: "All forms are filled. Please review every form in VNC. When satisfied, call resume." })
```

### Step 7: Save & E-File

1. Save the return
2. User navigates to Step 4 (E-File) and submits manually
3. **Do NOT automate the final submit**

## FFFF Quirks Reference

- **Randomized IDs**: Always use aria-label to find fields, never DOM id
- **Confirmation popups**: Appear in OUTER frame even when form is in inner iframe
- **Frame detachment**: After navigating between forms, iframe may detach. Retry.
- **Session timeout**: ~15 min idle. Run heartbeat `evaluate` periodically.
- **"Do the Math"**: Clears some fields — always snapshot/diff/refill
