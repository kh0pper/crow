---
name: home-assistant
description: "Control smart home devices via Home Assistant. Use when: (1) playing music/media/radio on speakers or TVs, (2) controlling lights, switches, or thermostats, (3) vacuuming with Roomba, (4) checking device status, (5) turning on/off any smart home device, (6) casting media to Chromecast/Google Home/TV. Matches requests mentioning: TV, kitchen, living room, Roomba, vacuum, smart home, lights, speakers, cast, play music, play radio, turn on, turn off."
---

# Home Assistant Skill

Control smart home devices through Home Assistant's REST API using the `homeassistant.py` script.

## Environment

Already configured — `HOMEASSISTANT_URL` and `HOMEASSISTANT_TOKEN` are set in the gateway service environment.

## Known Devices

| Friendly Name | Entity ID | Type |
|---|---|---|
| Kitchen Display | `media_player.kitchen_display` | Google Home / smart speaker |
| Living Room TV | `media_player.living_room_tv` | Chromecast / smart TV |
| Samsung TV | `media_player.samsung_tu7000_55_tv_un55tu7000bxza` | Samsung smart TV |
| Samsung TV Remote | `remote.samsung_tu7000_55_tv_un55tu7000bxza` | Samsung TV remote |
| Home Group | `media_player.home_group` | Google Cast group |
| Robotina (Roomba) | `vacuum.robotina` | iRobot Roomba J8 |
| Robotina Bin Full | `binary_sensor.robotina_bin_full` | Roomba bin sensor |
| Robotina Battery | `sensor.robotina_battery` | Roomba battery % |

## Commands

### List all devices
```bash
python3 scripts/homeassistant.py list
```

### Get device state
```bash
python3 scripts/homeassistant.py state media_player.kitchen_display
```

### Play media on a speaker/TV (radio streams, music URLs, etc.)
```bash
# Play a radio stream on Kitchen Display
python3 scripts/homeassistant.py play media_player.kitchen_display "http://stream.kpft.org:8000/kpft" --type music

# Play on Living Room TV
python3 scripts/homeassistant.py play media_player.living_room_tv "http://stream.kpft.org:8000/kpft" --type music
```

### Control media playback
```bash
python3 scripts/homeassistant.py pause media_player.kitchen_display
python3 scripts/homeassistant.py stop media_player.kitchen_display
python3 scripts/homeassistant.py volume media_player.kitchen_display 0.5
```

### Turn devices on/off
```bash
python3 scripts/homeassistant.py on media_player.samsung_tu7000_55_tv_un55tu7000bxza
python3 scripts/homeassistant.py off media_player.samsung_tu7000_55_tv_un55tu7000bxza
```

### Vacuum (Roomba) commands
```bash
python3 scripts/homeassistant.py vacuum-start
python3 scripts/homeassistant.py vacuum-stop
python3 scripts/homeassistant.py vacuum-dock
python3 scripts/homeassistant.py vacuum-status
```

### Play YouTube videos on TV or speaker (IMPORTANT)
YouTube videos MUST use the `youtube` command, NOT the `play` command. The `youtube` command uses yt-dlp to resolve the correct video ID and casts via the YouTube Cast receiver.

```bash
# Play a YouTube video by URL
python3 scripts/homeassistant.py youtube media_player.living_room_tv "https://www.youtube.com/watch?v=VIDEO_ID"

# Play a YouTube live stream by channel
python3 scripts/homeassistant.py youtube media_player.living_room_tv "https://www.youtube.com/@PBSNewsHour/live"

# Play by search query (resolves via yt-dlp)
python3 scripts/homeassistant.py youtube media_player.living_room_tv "ytsearch:PBS NewsHour live"
```

NEVER guess YouTube video IDs. ALWAYS use the `youtube` command which resolves the correct ID automatically.

### Call any HA service (advanced)
```bash
python3 scripts/homeassistant.py service <domain> <service> '{"entity_id": "...", ...}'
```

## Common Radio Streams

| Station | URL |
|---|---|
| KPFT 90.1 (Houston) | `http://stream.kpft.org:8000/kpft` |

## Tips

- Always use the full entity_id (e.g., `media_player.kitchen_display`, not just "kitchen")
- For audio streams (radio), use `play` with `--type music`
- For YouTube, ALWAYS use the `youtube` command — never use `play` with YouTube URLs
- The Samsung TV entity ID is long: `media_player.samsung_tu7000_55_tv_un55tu7000bxza`
- Use `list` to discover new devices if more are added to Home Assistant
