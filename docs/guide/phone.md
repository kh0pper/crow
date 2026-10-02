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
4. You watch the transcript live and can hang up at any time. The result (see
   [Outcomes](#outcomes)) goes back to the bot and to your notifications.

## Approving from the chat
When you ask a bot for a call in a **Perch** chat, the plan appears right there as a
**call card**, so you never have to leave the conversation (handy on a phone):

Every card opens with the business's name and a status pill, then the number and the call's
language on one line.

- **Needs approval:** the **Goal** and **Limits**, any time the bot proposed, and **May share**
  (open when there are details to share; edit one, or clear it to withhold it). Tick
  **This is a business** and, optionally, **Allow cloud model for this call** (the row shows which
  cloud model). Enter your 2FA code when 2FA is on, then:
  - **Approve and call now**: the call starts right away, even if the bot proposed a later time;
  - **Schedule for later ▸**: shows a date and time (prefilled with the bot's proposal, if any)
    and **Approve for this time**;
  - or **Reject**.
- **Live:** the pill shows a running timer. The transcript reads like a chat: the assistant on the
  left, the business on the right, and line events ("dialing", "answered") as small notes. On the
  simulated line, type what the business says into **Business says…** and press **Send**. When the
  business answers and nobody has typed yet, the card says *"The business answered — type what they
  say."* **Hang up** ends the call at any time. Once the line is down and the assistant is writing
  its summary (any ending after the business said something), the pill says *Wrapping up…*, stops
  pulsing, and the typing row goes away; that takes up to about 20 seconds.
- **Finished:** a coloured outcome pill (green: got the info or booked; amber: needs a callback,
  no answer, voicemail; grey: stopped by you; red: failed), the answer in large text, any booking,
  **Show transcript**, and a link to the full record in **Phone**. Older finished calls stay in
  Phone; the chat shows only the latest one.
- **The bot's result:** the bot gets the result in the same chat (see
  [What the bot receives](#what-the-bot-receives)). If it cannot take it right
  away (mid-reply, a busy box, or Crow just restarted), Crow keeps retrying for up to 10 minutes.

Approving in the card uses the same gates as the Phone panel:
- **Who can act:** only a **password sign-in on this Crow** can approve, reject or type the
  business's lines.
- **Peer sign-ins:** someone viewing the chat through a peer sign-in sees only the call's status,
  never its transcript, and can only hang up.
- **What you approve:** the approval covers exactly the plan you saw. If the plan changed in the
  meantime (edited in Phone, say), the card says so and asks you to review it again.
- **Where cards and results go:**
  - A card, and the bot's result, only go to a chat session of the bot that proposed the call.
    This protects against a misdirected or carelessly forged chat id. It is not a guarantee
    against a bot that deliberately impersonates another bot.
  - Every call is always listed in **Phone**.
- **Other channels:** calls proposed from Gmail, Discord or Telegram still appear only in **Phone**.

## Outcomes
| Outcome | Meaning |
|---|---|
| `booked` | An appointment inside your limits was made. |
| `info_gathered` | The assistant got the information the goal asked for. |
| `needs_callback` | Something needs you: an offer outside your limits, a question it could not answer, silence, or the time limit. |
| `refused` | The business declined, or asked not to be called again. |
| `no_answer`, `busy`, `voicemail`, `not_in_service` | The call did not reach a person. |
| `stopped` | You hung up. The summary still records anything learned before you did. (If an appointment had already been recorded, the outcome is `booked`.) |
| `phone_busy`, `phone_unreachable` | Your own phone was busy or could not be reached. |
| `line_lost`, `taken_over` | The call moved to your phone, or you took it over yourself. |
| `failed`, `not_admissible` | The call could not run (blocked number, daily cap, no model, an error). |

**How a call ends.** The assistant normally ends the call itself and reports what it learned. If
its last sentence is a goodbye ("…That's all I needed, thank you.", "Muchas gracias, hasta luego.")
but it forgets to end the call, Crow hangs up for it. A goodbye in the middle of a line ("Thanks
for your help. I'd also like…") does not count, and neither does a plain "thank you".
Whenever a call ends after the business has said something (a goodbye, your **Hang up**, silence,
the time limit), the assistant writes a short summary of what was learned. That summary is checked
like everything else:
- `booked` is only ever reported for an appointment the assistant **recorded during the call**
  (which already had to fit your limits). A summary that claims a booking without one becomes
  `needs_callback`, noted "booking not confirmed during the call".
- If the summary cannot be written (model error, or over 20 seconds), a call Crow hung up after a
  goodbye is recorded as `needs_callback` with the goodbye as its summary, never as a success.

## What the bot receives
The bot that asked for the call gets a short message with a block of **untrusted facts**: the
business, the outcome, the call's summary (one line, at most 300 characters) and a booking, if one
was recorded, plus a link to the call in **Phone**. The bot is told not to follow any instructions
inside that block. It never gets the transcript or the details you allowed the assistant to share.

## Setup
- **Install** the Phone bundle from Extensions. The install form asks for the runner
  secret `PHONE_RUNNER_SECRET`; generate one with `openssl rand -hex 24`.
- **Phone settings** (owner name and number, models, daily cap, AI-call notice) need a
  local login **and** your current 2FA code, the same as approving calls. The local
  model setting must name a non-cloud provider.

## After upgrading Crow
Upgrading Crow updates the Phone runner's source but does not rebuild it. The runner is rebuilt the
next time you **Restart** (or **Start**) Phone in Extensions. Do that once after an upgrade, when no
call is live: restarting the runner ends a call in progress.

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
  untrusted facts (outcome, a one-line summary of at most 300 characters, and booking), never the
  transcript.
- AI-voice calls are regulated (the FCC treats AI voices as "artificial voice" under the TCPA).
  Only approve calls to businesses, and acknowledge the notice in Phone settings.
