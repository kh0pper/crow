# CrowClaw — OpenClaw Bot Management

Manage OpenClaw bots through conversation: create, configure, deploy, monitor, and manage user profiles.

## Triggers

- openclaw, bot management, discord bot, telegram bot, bot status
- create bot, deploy bot, start bot, stop bot, restart bot
- user profile, voice settings, language settings
- bot logs, bot health, safety events

## Quick Reference

### Bot Lifecycle
| Action | Tool |
|--------|------|
| Create a new bot | `crow_create_bot` |
| Update config | `crow_configure_bot` (dot-path into openclaw.json) |
| Deploy to disk | `crow_deploy_bot` (writes config, systemd unit, runs security audit) |
| Start / Stop / Restart | `crow_start_bot` / `crow_stop_bot` / `crow_restart_bot` |
| Delete bot | `crow_delete_bot` (archives config, removes service) |

### Monitoring
| Action | Tool |
|--------|------|
| Status (all or one) | `crow_bot_status` |
| View logs | `crow_bot_logs` |
| Deep health check | `crow_bot_health` |

### User Profiles
| Action | Tool |
|--------|------|
| Add user | `crow_create_user_profile` |
| Update user | `crow_update_user_profile` |
| List users | `crow_list_user_profiles` |
| Remove user | `crow_delete_user_profile` |

Profile changes auto-regenerate VOICE_LANGMAP and USER-PROFILES.md.

### Workspace & Skills
| Action | Tool |
|--------|------|
| List templates | `crow_list_workspace_templates` |
| Read file | `crow_get_workspace_file` |
| Write/update file | `crow_update_workspace_file` |
| List skills | `crow_list_bot_skills` |
| Deploy skill | `crow_deploy_skill` |
| Remove skill | `crow_remove_skill` |

## Workflows

### Create a new bot
1. `crow_create_bot` with name, language, port
2. `crow_create_user_profile` for the owner
3. `crow_update_workspace_file` for SOUL.md, USER.md, AGENTS.md
4. `crow_deploy_bot` (confirm gate — returns preview first)
5. `crow_start_bot`

### Add a user to an existing bot
1. `crow_create_user_profile` with platform, user ID, language, voice
2. VOICE_LANGMAP and USER-PROFILES.md regenerate automatically
3. Restart bot to pick up new VOICE_LANGMAP: `crow_restart_bot`

### Check on a bot
1. `crow_bot_status` for quick overview
2. `crow_bot_health` for deep check (HTTP, systemd, Discord)
3. `crow_bot_logs` if something looks wrong

### BYOAI Setup
Set `ai_source` to `"byoai"` on the bot, then `crow_deploy_bot` will generate models.json from Crow's AI provider config automatically.

## Safety Defaults

New bots get hardened defaults:
- `security: "allowlist"` (not open)
- `allowFrom` restricted to owner IDs only
- `groupPolicy: "allowlist"`, `allowBots: false`
- Content moderation enabled (OpenAI Moderation API)
- PII detection for SSN, credit card, phone numbers
- Exec denylist blocks dangerous commands

`crow_configure_bot` warns when security settings are downgraded.

## Panel

Bot dashboard at `http://grackle/dashboard/bots` — bot cards, detail view, profiles, workspace files, deployment history, safety events. Links to OpenClaw Control UI.
