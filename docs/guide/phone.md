# Phone: your assistant calls businesses for you

Your Crow bots can propose phone calls to **businesses**: book an appointment,
ask about hours, prices or stock. **Every call needs your approval.**

## How it works
1. A bot proposes a call plan: the business, the goal, the limits it may agree to
   (dates, days, time window, max price) and only the details you allow it to share.
2. Open **Crow's Nest → Phone**, review, tick **This is a business**, optionally
   **Allow cloud model for this call**, enter your 2FA code (when 2FA is on), and approve.
3. The assistant opens every call with: *"Hi, I'm an automated assistant calling on
   behalf of {your name}. This call may be recorded."* (Spanish calls use Spanish.)
4. You watch the transcript live and can stop at any time. The result (booked,
   information gathered, needs a callback, …) goes back to the bot and to your notifications.

## Setup
- **Install** the Phone bundle from Extensions. The install form asks for the runner
  secret `PHONE_RUNNER_SECRET`; generate one with `openssl rand -hex 24`.
- **Phone settings** (owner name and number, models, daily cap, AI-call notice) need a
  local login **and** your current 2FA code, the same as approving calls. The local
  model setting must name a non-cloud provider.

## This release
Calls run on a **simulated line**: you type what the business says ("Business says…")
and watch the assistant respond. This lets you try the whole flow safely. The real
phone line (your own phone over Bluetooth) comes in the next release.

## Safety rails
- Only US/Canada business numbers. Never 911 or other N11 codes, 900/976, or your own number.
- The assistant cannot press keys except in automated menus, cannot agree to anything
  outside your limits, and never shares payment card numbers.
- A bot can only read the status and result of calls it proposed. Results reach bots as
  structured, untrusted facts (outcome and booking), never the transcript.
- AI-voice calls are regulated (the FCC treats AI voices as "artificial voice" under the TCPA).
  Only approve calls to businesses, and acknowledge the notice in Phone settings.
