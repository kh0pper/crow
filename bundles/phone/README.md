# Phone (assistant calls)

Your Crow bots can propose phone calls to businesses. You approve each call in
Crow's Nest → Phone (local login, plus a 2FA code when 2FA is on). This
release runs calls on a simulated line so you can try the whole flow: you type
the business's lines and watch the assistant respond. The real Bluetooth phone
line comes in the next release.

- Runner: `crow-phone-runner` on 127.0.0.1:3065 (Docker).
- Secret: `PHONE_RUNNER_SECRET`, asked for at install (generate with `openssl rand -hex 24`). It is shared by the gateway and the runner.
- Nothing is exposed publicly.
