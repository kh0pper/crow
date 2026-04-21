# CLAUDE.md — CrowClaw (grackle)

This repo (`git@gitea:kh0pp/crowclaw.git`) stores configuration templates, workspace files, patches, and scripts for the OpenClaw installation on grackle.

## Related Directories

| Directory | Purpose |
|-----------|---------|
| `~/casa-nueva/` | Skill source code (English + Spanish). Deploy with `bash deploy.sh`. See its CLAUDE.md for skill conventions. |
| `~/.openclaw/` | **Grackle** (Kevin's bot) runtime — config, deployed skills, workspace, memory |
| `~/.openclaw-dayane/` | **Frankenstein** (Dayane's bot) runtime — same structure, Spanish |
| `~/crowclaw/` | This repo — config templates, patches, scripts, workspace templates |

**Runtime dirs (`~/.openclaw*`) are NOT checked into git.** This repo holds the canonical templates that get deployed there.

## Repo Structure

```
config/
├── openclaw.json          # Main OpenClaw config (Grackle)
├── exec-approvals.json    # Exec approval settings
└── agents/main/
    ├── auth-profiles.json # OAuth/API auth profiles
    └── models.json        # Model configuration (ZAI GLM-4.7/5)

patches/
├── patch-tts-emoji.py     # Strip emoji from TTS input
└── patch-tts-voice.py     # Voice selection patch

scripts/
├── generate_audio.py      # Audio generation
├── generate_ai_images.py  # AI image generation
├── generate_ai_videos.py  # AI video generation
└── create_title_cards.py  # Title card creation

skills/
└── home-assistant/        # Home Assistant skill (lights, Roomba, speakers, etc.)

workspace/
├── AGENTS.md              # Agent behavior guidelines (session startup, memory, heartbeats)
├── SOUL.md                # Grackle's identity/persona
├── USER.md                # Kevin's profile (timezone, location, preferences)
├── TOOLS.md               # Discord server/channel IDs, local tool notes
├── IDENTITY.md            # Bot identity details
├── HEARTBEAT.md           # Heartbeat check instructions
└── home-assistant/        # HA skill workspace copy
```

## Two Bots, One Machine

Both bots run as systemd user services on grackle:

| Bot | Service | Port | Language |
|-----|---------|------|----------|
| Grackle (Kevin) | `openclaw-gateway.service` | 18789 | English (en-US-BrianNeural) |
| Frankenstein (Dayane) | `openclaw-gateway-dayane.service` | 18790 | Spanish (es-MX-DaliaNeural) |

```bash
# Restart services
systemctl --user restart openclaw-gateway.service
systemctl --user restart openclaw-gateway-dayane.service

# Check status
systemctl --user status openclaw-gateway.service
systemctl --user status openclaw-gateway-dayane.service

# View logs
journalctl --user -u openclaw-gateway.service -f
journalctl --user -u openclaw-gateway-dayane.service -f
```

## Google Workspace CLI (gog)

`gog` (`~/.local/bin/gog`, v0.11.0) provides CLI access to Google Calendar, Gmail, Sheets, Drive, etc. Used by the bots for calendar operations.

- **Config:** `~/.config/gogcli/config.json`
- **Credentials:** `~/.config/gogcli/credentials.json`
- **Keyring:** `~/.config/gogcli/keyring/` (file-based, password: set via `GOG_KEYRING_PASSWORD` env)
- **Account:** `kevin.hopper1@gmail.com`

### Re-authenticating gog (headless server procedure)

OAuth tokens expire periodically. The `gog auth login` browser flow doesn't work on headless grackle because it binds to `127.0.0.1`. The `--remote` two-step flow has a state-matching bug. Use this workaround instead:

**Step 1 — Get the auth URL:**
```bash
export GOG_KEYRING_PASSWORD=openclaw
gog auth add kevin.hopper1@gmail.com --remote --step 1 --force-consent --services all
```
This prints an `auth_url`. Copy it.

**Step 2 — Authorize in browser:**
Open the auth URL on a machine with a browser (e.g., Chromebook). Sign in with `kevin.hopper1@gmail.com` and grant access. Your browser will redirect to a `http://127.0.0.1:PORT/oauth2/callback?...` URL that won't load — that's expected. Copy the full URL from the address bar.

**Step 3 — Extract the auth code:**
From the redirect URL, find the `code=` parameter value. It looks like `4/0AfrIep...`.

**Step 4 — Exchange the code for a refresh token:**
```bash
# Set $GOOGLE_CLIENT_ID and $GOOGLE_CLIENT_SECRET from your GCP Console
# OAuth client (APIs & Services -> Credentials). Never paste real values
# into source files.
curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=PASTE_CODE_HERE" \
  -d "client_id=$GOOGLE_CLIENT_ID" \
  -d "client_secret=$GOOGLE_CLIENT_SECRET" \
  -d "redirect_uri=http://127.0.0.1:PORT/oauth2/callback" \
  -d "grant_type=authorization_code"
```
**Important:** The `redirect_uri` must match the port from the auth URL in Step 1 exactly.

This returns JSON with a `refresh_token`.

**Step 5 — Import the token into gog:**
```bash
cat > /tmp/gog-token.json << EOF
{
  "email": "kevin.hopper1@gmail.com",
  "client": "default",
  "refresh_token": "PASTE_REFRESH_TOKEN_HERE",
  "scopes": ["email","openid","profile",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/chat.memberships",
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/chat.spaces",
    "https://www.googleapis.com/auth/chat.users.readstate.readonly",
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/contacts.other.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.responses.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.settings.sharing",
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile"]
}
EOF
export GOG_KEYRING_PASSWORD=openclaw
gog auth tokens import /tmp/gog-token.json
rm /tmp/gog-token.json
```

**Step 6 — Verify:**
```bash
export GOG_KEYRING_PASSWORD=openclaw
gog calendar list --account kevin.hopper1@gmail.com
```

If it lists calendars, auth is working. The systemd services set `GOG_ACCOUNT` and `GOG_KEYRING_PASSWORD` env vars, so the bots pick up the new token automatically.

**Cleanup:** Remove any stale state files: `rm -f ~/.config/gogcli/oauth-manual-state-*.json`

## Skill Deployment

Skills are developed in `~/casa-nueva/` and deployed to both bot runtime dirs:

```bash
cd ~/casa-nueva
bash deploy.sh              # rsync to ~/.openclaw/skills/ and ~/.openclaw-dayane/skills/
bash deploy.sh --dry-run    # preview only

# Then restart both gateways
systemctl --user restart openclaw-gateway.service
systemctl --user restart openclaw-gateway-dayane.service
```

## Exec Approvals

Currently set to `security: "open"`. If approval prompts return:

```bash
openclaw approvals set --file ~/.openclaw/exec-approvals.json --gateway
```

Editing the JSON file alone does NOT work — the gateway caches the config.

## Key IDs

| Entity | ID |
|--------|-----|
| Grackle bot | `1477391103320920273` |
| Frankenstein bot | `1477713526154985683` |
| Casa Nueva guild | `1039041607296618598` |
| #bot-relay | `1477740671891804355` |
| Kevin (Discord) | `857700998370033704` |
| Dayane (Discord) | `1066168340629950464` |
| Household spreadsheet | `18Wba1fyeRcnDJ1bBseEil7G0RwN1Jr3Xx3rI8ro5caw` |

## Google Sheets

Service account credentials at `~/.config/gsheets/service-account.json`. Spreadsheet tabs: Groceries, Expenses, Budget, Bills, Goals, Pantry, Meal Prep, To-Do.
