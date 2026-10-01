# Phone: your assistant calls businesses for you

Your Crow bots can propose phone calls to **businesses**: book an appointment,
ask about hours, prices or stock. **Every call needs your approval.**

## How it works
1. A bot proposes a call plan: the business, the goal, the limits it may agree to
   (dates, days, time window, max price) and only the details you allow it to share.
2. Approve it **in the chat** (see below), or open **Crow's Nest → Phone**: review, tick **This is a business**, optionally
   **Allow cloud model for this call**, enter your 2FA code (when 2FA is on), and approve.
3. The assistant opens every call with: *"Hi, I'm an automated assistant calling on
   behalf of {your name}. This call may be recorded."* (Spanish calls use Spanish.)
4. You watch the transcript live and can stop at any time. The result (booked,
   information gathered, needs a callback, …) goes back to the bot and to your notifications.

## Approving from the chat
When you ask a bot for a call in a **Perch** chat, the plan appears right there as a
**call card**, so you never have to leave the conversation (handy on a phone):

- **Waiting for your approval:** the business, number, goal, limits, the call's language, any
  time the bot proposed, and the details the assistant may share. Edit a detail, or clear it to
  withhold it. Tick **This is a business**, optionally **Allow cloud model for this call**, enter
  your 2FA code when 2FA is on, then:
  - **Approve now**: the call starts right away, even if the bot proposed a later time;
  - **Approve for…** a date and time (prefilled with the bot's proposal, if any);
  - or **Reject**.
- **Live call:** the transcript updates as the call runs. On the simulated line, type what the
  business says into **Business says…** and press **Send**. When the business answers and nobody
  has typed yet, the card says *"The business answered — type what they say."*
  **Stop call** ends it at any time.
- **Finished:** the outcome, a short summary and any booking, with a link to the full record in
  **Phone**. Older finished calls stay in Phone; the chat shows only the latest one.
- **The bot's result:** the bot gets the result in the same chat. If it cannot take it right
  away (mid-reply, a busy box, or Crow just restarted), Crow keeps retrying for up to 10 minutes.

Approving in the card uses the same gates as the Phone panel:
- **Who can act:** only a **password sign-in on this Crow** can approve, reject or type the
  business's lines.
- **Peer sign-ins:** someone viewing the chat through a peer sign-in sees only the call's status,
  never its transcript, and can only stop it.
- **What you approve:** the approval covers exactly the plan you saw. If the plan changed in the
  meantime (edited in Phone, say), the card says so and asks you to review it again.
- **Where cards and results go:**
  - A card, and the bot's result, only go to a chat session of the bot that proposed the call.
    This protects against a misdirected or carelessly forged chat id. It is not a guarantee
    against a bot that deliberately impersonates another bot.
  - Every call is always listed in **Phone**.
- **Other channels:** calls proposed from Gmail, Discord or Telegram still appear only in **Phone**.

## Setup
- **Install** the Phone bundle from Extensions. The install form asks for the runner
  secret `PHONE_RUNNER_SECRET`; generate one with `openssl rand -hex 24`.
- **Phone settings** (owner name and number, models, daily cap, AI-call notice) need a
  local login **and** your current 2FA code, the same as approving calls. The local
  model setting must name a non-cloud provider.

## This release
Calls run on a **simulated line**: you type what the business says ("Business says…")
and watch the assistant respond. You get two minutes for each line. If you say nothing for
six seconds after the call is answered, the assistant speaks first: its disclosure, then "Hello?".
This lets you try the whole flow safely. The real
phone line (your own phone over Bluetooth) comes in the next release.

## Networking
The phone runner uses host networking so it can reach Crow and your local models, but it listens on `127.0.0.1:3065` only and opens no network ports to other machines. Because host networking is a privileged capability, installing the bundle asks for your explicit consent.

## Safety rails
- Only US/Canada business numbers. Never 911 or other N11 codes, 900/976, or your own number.
- The assistant cannot press keys except in automated menus, cannot agree to anything
  outside your limits, and never shares payment card numbers.
- A bot can only read the status and result of calls it proposed. Results reach bots as
  structured, untrusted facts (outcome and booking), never the transcript.
- AI-voice calls are regulated (the FCC treats AI voices as "artificial voice" under the TCPA).
  Only approve calls to businesses, and acknowledge the notice in Phone settings.
