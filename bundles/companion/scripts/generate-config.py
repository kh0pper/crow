#!/usr/bin/env python3
"""
Generate Open-LLM-VTuber conf.yaml from Crow's AI profiles.
Reads profiles from Crow's SQLite database and creates a config
with the first available profile as default, plus character configs
for switching between providers and models.
"""

import json
import os
import sqlite3
import sys
from urllib.parse import urlparse

import yaml


# Available Live2D models (bundled + CDN)
AVATAR_MODELS = {
    "mao_pro": {
        "name": "mao_pro",
        "description": "Mao (default)",
        "url": "/live2d-models/mao_pro/runtime/mao_pro.model3.json",
        "kScale": 0.5,
        "initialXshift": 0,
        "initialYshift": 0,
        "kXOffset": 1150,
        "idleMotionGroupName": "Idle",
        "emotionMap": {
            "neutral": 0, "anger": 2, "disgust": 2, "fear": 1,
            "joy": 3, "smirk": 3, "sadness": 1, "surprise": 3,
        },
        "tapMotions": {"HitAreaHead": {"": 1}, "HitAreaBody": {"": 1}},
    },
    "shizuku": {
        "name": "shizuku",
        "description": "Shizuku (bundled)",
        "url": "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/shizuku/shizuku.model.json",
        "kScale": 0.3,
        "initialXshift": 0,
        "initialYshift": 0,
        "emotionMap": {
            "neutral": 0, "anger": 2, "disgust": 2, "fear": 1,
            "joy": 3, "smirk": 3, "sadness": 1, "surprise": 3,
        },
    },
    # Note: hiyori, epsilon, hibiki, mark, simple were removed — they require
    # manual download from https://www.live2d.com/en/learn/sample/ due to
    # license terms. Use Eikanya community models instead.
}

# Eikanya community models (downloaded separately, mounted at /live2d-models/eikanya/)
# Auto-discovered at startup from the mounted directory.
# Each model gets a config entry with emotion mapping based on available motion groups.
EIKANYA_MODELS = {}

# Display name overrides for known Azur Lane characters (pinyin -> English)
DISPLAY_NAMES = {
    "gaoxiong": "Takao",
    "feiteliedadi": "Friedrich der Große",
    "zhangwu": "Zhang Wu",
    "aersasi": "Alsace",
    "xinzexi": "New Jersey",
    "xinnong": "Xinnong",
    "jinjiang": "Jin Jiang",
    "jinshi": "Jin Shi",
    "zhenzhuhao": "Pearl Harbor",
    "yuekechengII": "Yorktown II",
    "suweiaitongmeng": "Soviet Union",
    "liekexingdunII": "Lexington II",
    "ankeleiqi": "Anchorage",
    "nabulesi": "Napoli",
    "meikelunbao": "Mecklenburg",
    "xingdengbao": "Hindenburg",
    "ougen": "Prinz Eugen",
    "kebensi": "Kebensi",
    "xiafei": "Xiafei",
    "tianlangxing": "Sirius",
    "naximofu": "Nakhimov",
    "guanghui": "Illustrious",
    "baifeng": "Hakuhou",
    "siwanshi": "Siwanshi",
    "dafeng": "Taihou",
    "shengluyisi": "Saint Louis",
    "qiye": "Enterprise",
    "senko": "Senko",
    "Cha_AnnoyingParrot": "Annoying Parrot",
}


def discover_eikanya_models(eikanya_dir="/app/live2d-models/eikanya"):
    """Auto-discover Eikanya models from the mounted directory."""
    models = {}
    if not os.path.isdir(eikanya_dir):
        return models

    for entry in sorted(os.listdir(eikanya_dir)):
        model_dir = os.path.join(eikanya_dir, entry)
        if not os.path.isdir(model_dir):
            continue

        # Find model3.json
        model_json = None
        for f in os.listdir(model_dir):
            if f.endswith(".model3.json"):
                model_json = f
                break
        if not model_json:
            continue

        # Read model3.json to get motion groups
        try:
            with open(os.path.join(model_dir, model_json)) as f:
                model_data = json.load(f)
        except Exception:
            continue

        motions = model_data.get("FileReferences", {}).get("Motions", {})
        motion_groups = list(motions.keys())
        motion_count = sum(len(v) for v in motions.values())

        # Determine idle motion group name
        idle_group = None
        for candidate in ["Idle", "idle", "home"]:
            if candidate in motion_groups:
                idle_group = candidate
                break

        # Build emotion map based on available motion groups
        # Map emotions to motion group indices that semantically match
        emotion_map = {"neutral": 0, "anger": 0, "disgust": 0, "fear": 0,
                       "joy": 0, "smirk": 0, "sadness": 0, "surprise": 0}

        # Find indices for semantically appropriate motions
        group_map = {}
        for i, name in enumerate(motion_groups):
            group_map[name.lower()] = i

        # Map emotions to touch/interaction motions for variety
        if "touch_head" in group_map:
            emotion_map["joy"] = group_map["touch_head"]
            emotion_map["smirk"] = group_map["touch_head"]
        if "touch_body" in group_map:
            emotion_map["surprise"] = group_map["touch_body"]
        if "touch_special" in group_map:
            emotion_map["anger"] = group_map["touch_special"]
            emotion_map["disgust"] = group_map["touch_special"]
        if "wedding" in group_map:
            emotion_map["joy"] = group_map["wedding"]
        if "login" in group_map:
            emotion_map["fear"] = group_map["login"]
        if "complete" in group_map:
            emotion_map["smirk"] = group_map["complete"]

        # Semantic motion groups (e.g., parrot model with Angry, Cry, Ouch, SayHello_HAPPY)
        if "angry" in group_map:
            emotion_map["anger"] = group_map["angry"]
            emotion_map["disgust"] = group_map["angry"]
        if "cry" in group_map:
            emotion_map["sadness"] = group_map["cry"]
            emotion_map["fear"] = group_map["cry"]
        if "ouch" in group_map:
            emotion_map["surprise"] = group_map["ouch"]
        if "sayhello_happy" in group_map:
            emotion_map["joy"] = group_map["sayhello_happy"]
            emotion_map["smirk"] = group_map["sayhello_happy"]

        display_name = DISPLAY_NAMES.get(entry, entry.title())
        if entry == "senko":
            source = "anime"
        elif entry.startswith("Cha_"):
            source = "community"
        else:
            source = "Azur Lane"

        model_config = {
            "name": entry,
            "description": f"{display_name} ({source}, {motion_count} motions)",
            "url": f"/live2d-models/eikanya/{entry}/{model_json}",
            "kScale": 0.25,
            "initialXshift": 0,
            "initialYshift": 0,
            "emotionMap": emotion_map,
        }

        if idle_group:
            model_config["idleMotionGroupName"] = idle_group

        # Build tap motions from available touch groups
        tap_motions = {}
        if "touch_head" in group_map:
            tap_motions["head"] = {"": group_map["touch_head"]}
        if "touch_body" in group_map:
            tap_motions["body"] = {"": group_map["touch_body"]}
        if tap_motions:
            model_config["tapMotions"] = tap_motions

        models[entry] = model_config

    return models


def get_crow_db_path():
    """Resolve Crow's database path."""
    env_path = os.environ.get("CROW_DB_PATH")
    if env_path and os.path.exists(env_path):
        return env_path
    home_path = os.path.expanduser("~/.crow/data/crow.db")
    if os.path.exists(home_path):
        return home_path
    if os.path.exists("/crow-data/crow.db"):
        return "/crow-data/crow.db"
    return None


def get_ai_profiles(db_path):
    """Read AI profiles from Crow's dashboard_settings table.

    Profile shape evolution:
      LEGACY (pre-2026): each profile has inline `baseUrl`, `apiKey`,
        `models` fields — fully self-contained.
      CURRENT: each profile has a `provider_id` pointer into the
        `providers` table. `baseUrl` / `apiKey` / `models` live on the
        provider row, not the profile.

    The rest of this script expects the LEGACY shape. To stay backward-
    compatible with both schemas we JOIN to the providers table and
    populate the legacy fields from there when `provider_id` is set.
    Keeps every downstream consumer working without changes.
    """
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        # Load profiles JSON.
        cursor = conn.execute(
            "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'"
        )
        row = cursor.fetchone()
        profiles = json.loads(row[0]) if row else []

        # Load providers keyed by id, if the table exists.
        providers_by_id = {}
        try:
            p_cursor = conn.execute(
                "SELECT id, base_url, api_key, models, disabled FROM providers"
            )
            for p_row in p_cursor.fetchall():
                if p_row["disabled"]:
                    continue
                try:
                    models = json.loads(p_row["models"] or "[]")
                except Exception:
                    models = []
                providers_by_id[p_row["id"]] = {
                    "baseUrl": p_row["base_url"],
                    "apiKey": p_row["api_key"],
                    "models": models,
                }
        except sqlite3.OperationalError:
            # providers table doesn't exist → legacy schema, nothing to merge.
            pass

        conn.close()

        # Enrich each profile in-place with provider fields when missing.
        enriched = []
        for p in profiles:
            if not isinstance(p, dict):
                continue
            prov = providers_by_id.get(p.get("provider_id"))
            if prov:
                # Don't clobber a legacy inline field if it's already present.
                p.setdefault("baseUrl", prov["baseUrl"])
                p.setdefault("apiKey", prov["apiKey"])
                p.setdefault("models", prov["models"])
            # Skip profiles that still don't have a baseUrl — they can't
            # drive the companion's LLM. A profile with kind=auto (router)
            # has no provider and is filtered here.
            if not p.get("baseUrl"):
                continue
            enriched.append(p)
        return enriched
    except Exception as e:
        print(f"Warning: Could not read AI profiles: {e}", file=sys.stderr)
        return []


def get_tts_profiles(db_path):
    """Read TTS profiles from Crow's dashboard_settings table.

    Shape: [{id, name, provider, apiKey, baseUrl, defaultVoice, isDefault}]
    """
    if not db_path:
        return []
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute(
            "SELECT value FROM dashboard_settings WHERE key = 'tts_profiles'"
        )
        row = cursor.fetchone()
        conn.close()
        if row:
            return json.loads(row[0])
    except Exception as e:
        print(f"Warning: Could not read TTS profiles: {e}", file=sys.stderr)
    return []


def find_tts_profile(tts_profiles, profile_id):
    """Return the matching profile, or the default, or first, or None."""
    if profile_id:
        for p in tts_profiles:
            if p.get("id") == profile_id:
                return p
    for p in tts_profiles:
        if p.get("isDefault"):
            return p
    return tts_profiles[0] if tts_profiles else None


def tts_config_block(tts_profile, voice):
    """Map a Crow tts_profile + voice → OLVV tts_config block.

    Supported provider mappings (as of OLVV SHA 19b58b1f):
      edge       → edge_tts { voice }
      openai     → openai_tts { model, voice, api_key, base_url }
      azure      → azure_tts { api_key, region, voice }
      elevenlabs → elevenlabs_tts { api_key, voice_id }
      piper      → piper_tts { voice_name }
      kokoro     → openai_tts { voice, base_url, api_key }  (OpenAI-compatible)

    Falls back to edge_tts with the supplied voice if profile is None
    or provider is unknown — preserves legacy behavior.
    """
    if not tts_profile:
        effective_voice = voice or "en-US-AvaMultilingualNeural"
        return {"tts_model": "edge_tts", "edge_tts": {"voice": effective_voice}}

    provider = tts_profile.get("provider", "edge")
    effective_voice = voice or tts_profile.get("defaultVoice", "")
    api_key = tts_profile.get("apiKey", "")
    base_url = tts_profile.get("baseUrl", "")

    if provider == "edge":
        return {
            "tts_model": "edge_tts",
            "edge_tts": {"voice": effective_voice or "en-US-AvaMultilingualNeural"},
        }

    if provider == "openai":
        return {
            "tts_model": "openai_tts",
            "openai_tts": {
                "model": "tts-1",
                "voice": effective_voice or "alloy",
                "api_key": api_key,
                "base_url": base_url or "https://api.openai.com/v1",
                "file_extension": "mp3",
            },
        }

    if provider == "azure":
        # Azure endpoint shape: https://<region>.tts.speech.microsoft.com
        # OLVV takes region name, not full URL. Best-effort parse.
        region = ""
        if base_url:
            m = base_url.replace("https://", "").replace("http://", "").split(".")
            if m:
                region = m[0]
        return {
            "tts_model": "azure_tts",
            "azure_tts": {
                "api_key": api_key,
                "region": region,
                "voice": effective_voice or "en-US-JennyNeural",
            },
        }

    if provider == "elevenlabs":
        return {
            "tts_model": "elevenlabs_tts",
            "elevenlabs_tts": {
                "api_key": api_key,
                "voice_id": effective_voice or "EXAVITQu4vr4xnSDxMaL",
            },
        }

    if provider == "piper":
        return {
            "tts_model": "piper_tts",
            "piper_tts": {
                "voice_name": effective_voice or "en_US-amy-medium",
                "voice_models_dir": base_url or "",
            },
        }

    if provider == "kokoro":
        # Kokoro-FastAPI is OpenAI-compatible — route through openai_tts.
        return {
            "tts_model": "openai_tts",
            "openai_tts": {
                "model": "kokoro",
                "voice": effective_voice or "af_bella",
                "api_key": api_key or "not-needed",
                "base_url": base_url or "http://localhost:8880/v1",
                "file_extension": "mp3",
            },
        }

    print(
        f"Warning: Unknown TTS provider '{provider}', falling back to edge_tts",
        file=sys.stderr,
    )
    return {
        "tts_model": "edge_tts",
        "edge_tts": {"voice": effective_voice or "en-US-AvaMultilingualNeural"},
    }


def slugify(name):
    """Convert profile name to a safe slug."""
    return name.lower().replace(" ", "_").replace(".", "_")


def resolve_ai_profile(profiles, env_vars):
    """Resolve the AI profile to use, respecting COMPANION_AI_PROFILE env var."""
    profile_slug = env_vars.get("COMPANION_AI_PROFILE", "")
    model_override = env_vars.get("COMPANION_AI_MODEL", "")

    if profile_slug:
        # Find the profile by slug
        for p in profiles:
            slug = p.get("name", "").lower().replace(" ", "_").replace(".", "_")
            if slug == profile_slug:
                selected = dict(p)
                if model_override and model_override in (p.get("models") or []):
                    selected["_model"] = model_override
                return selected

    # Auto mode: prefer local profiles (faster inference for voice chat).
    # "Local" includes loopback, RFC1918 LAN, the Docker bridge, AND Tailscale
    # CGNAT (100.64.0.0/10) — Crow's own endpoints are commonly addressed by
    # their Tailscale IP (e.g. http://100.118.41.122:8003/v1), which the old
    # substring check missed, causing a silent fall-through to a cloud profile.
    for p in profiles:
        if is_local_base(p.get("baseUrl", "")):
            return p
    return profiles[0] if profiles else None


def is_local_base(url):
    """True if a base_url points at a host reachable on the local machine/LAN.

    Matches loopback (localhost/127.x/0.0.0.0), the Docker bridge (172.17.x),
    RFC1918 private ranges (10.x, 192.168.x, 172.16-31.x), and Tailscale
    CGNAT (100.64.0.0/10 == 100.64-100.127). Used to prefer local inference
    for the companion's voice turns.
    """
    if not url:
        return False
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return False
    if host in ("localhost", "0.0.0.0"):
        return True
    if host.endswith(".local"):
        return True
    parts = host.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return False
    try:
        o = [int(p) for p in parts]
    except ValueError:
        return False
    if not all(0 <= n <= 255 for n in o):
        return False
    # loopback / link-local-ish
    if o[0] == 127:
        return True
    # RFC1918
    if o[0] == 10:
        return True
    if o[0] == 192 and o[1] == 168:
        return True
    if o[0] == 172 and 16 <= o[1] <= 31:
        return True
    # Tailscale CGNAT 100.64.0.0/10
    if o[0] == 100 and 64 <= o[1] <= 127:
        return True
    return False


def generate_config(profiles, env_vars, tts_profiles=None):
    """Generate conf.yaml content from AI profiles and env vars.

    TTS resolution order:
      1. legacy COMPANION_TTS_VOICE env var, as a voice override
      2. platform default tts_profile (if any) + its defaultVoice
      The resolved voice is passed into tts_config_block() alongside the
      default tts_profile so the right OLVV TTS block gets emitted.
    """
    tts_profiles = tts_profiles or []
    legacy_voice = env_vars.get("COMPANION_TTS_VOICE", "")
    default_tts_profile = find_tts_profile(tts_profiles, None)
    tts_voice = legacy_voice or (default_tts_profile.get("defaultVoice") if default_tts_profile else "en-US-AvaMultilingualNeural")
    persona = env_vars.get("COMPANION_PERSONA", "") or (
        "You are Crow, an AI companion and assistant. You are helpful, curious, "
        "and have a dry wit. Keep responses conversational and concise since they "
        "will be spoken aloud. IMPORTANT: Respond in the SAME language the user spoke "
        "(English or Spanish) -- mirror their language naturally, and if they switch "
        "languages mid-conversation, switch with them. "
        "When the user asks to open, play, watch, show, or search for something new, "
        "use the crow_wm_open tool. When the user says resume, unpause, pause, mute, unmute, "
        "or volume up/down, use the crow_wm_media tool. NEVER describe what you would do "
        "without calling the tool. If in doubt, call the tool."
    )
    char_name = env_vars.get("COMPANION_CHARACTER_NAME", "Crow")
    avatar = env_vars.get("COMPANION_AVATAR", "mao_pro")

    eikanya = discover_eikanya_models()
    all_models = {**AVATAR_MODELS, **eikanya}
    if avatar not in all_models:
        print(f"Warning: Unknown avatar '{avatar}', falling back to mao_pro", file=sys.stderr)
        avatar = "mao_pro"

    default_profile = resolve_ai_profile(profiles, env_vars)

    if default_profile and default_profile.get("baseUrl"):
        # Rewrite Docker bridge IPs to localhost (for host network mode)
        base_url = default_profile["baseUrl"]
        if "172.17.0.1" in base_url:
            base_url = base_url.replace("172.17.0.1", "localhost")
        # Resolve the model name defensively: a profile may carry _model (an
        # explicit override), defaultModel, or a models[] list — guard each so
        # a profile with a null key or empty models list can't crash config gen.
        models_list = default_profile.get("models") or []
        model_name = (
            default_profile.get("_model")
            or default_profile.get("defaultModel")
            or (models_list[0] if models_list else None)
        )
        llm_config = {
            "base_url": base_url,
            "llm_api_key": default_profile.get("apiKey") or "not-needed",
            "model": model_name or "qwen3.6-35b-a3b",
            "temperature": 0.8,
        }
    else:
        llm_config = {
            "base_url": "http://localhost:11434/v1",
            "llm_api_key": "not-needed",
            "model": "qwen2.5:latest",
            "temperature": 0.8,
        }

    # Companion model routing: when COMPANION_PROXY_URL is set (compose default:
    # the gateway's in-process /llm/v1 router, servers/gateway/routes/llm-router.js),
    # OLVV talks to it instead of a model directly. The router picks the fast model
    # (Qwen3.5-4B) by default, escalating to the 35B on a "!escalate" prefix, and
    # forwards messages + tools verbatim so OLVV's own tool loop / crow_wm /
    # streaming all keep working. The `model` field is a placeholder — the router
    # rewrites it per chosen upstream. (Host network → localhost reaches the gateway.)
    proxy_url = os.environ.get("COMPANION_PROXY_URL", "")
    if proxy_url:
        llm_config = {
            "base_url": proxy_url.rstrip("/"),
            "llm_api_key": "not-needed",
            "model": os.environ.get("COMPANION_PROXY_MODEL", "qwen3.5-4b"),
            "temperature": 0.8,
        }
        print(f"Companion LLM routed through the gateway /llm/v1 router: {proxy_url}", file=sys.stderr)

    config = {
        "system_config": {
            "conf_version": "v1.2.1",
            "host": os.environ.get("COMPANION_BIND_HOST", "0.0.0.0"),
            "port": int(os.environ.get("COMPANION_PORT", "12393")),
            "config_alts_dir": "characters",
            "tool_prompts": {
                "live2d_expression_prompt": "live2d_expression_prompt",
                "group_conversation_prompt": "group_conversation_prompt",
                "mcp_prompt": "mcp_prompt",
            },
        },
        "character_config": {
            "conf_name": "crow_default",
            "conf_uid": "crow_default_001",
            "live2d_model_name": avatar,
            "character_name": char_name,
            "avatar": "",
            "human_name": "Human",
            "persona_prompt": persona,
            "agent_config": {
                "conversation_agent_choice": "basic_memory_agent",
                "agent_settings": {
                    "basic_memory_agent": {
                        "llm_provider": "openai_compatible_llm",
                        "faster_first_response": True,
                        "segment_method": "pysbd",
                        "use_mcpp": True,
                        "mcp_enabled_servers": ["crow-wm", "crow-storage"],
                    }
                },
                "llm_configs": {"openai_compatible_llm": llm_config},
            },
            "asr_config": {
                # Bilingual (EN/ES) STT via faster-whisper, in-container on crow's
                # idle CPU (the LLMs run on the GPU, so the CPU is free). language=""
                # -> Whisper auto-detects per utterance, so Spanish and English both
                # transcribe accurately. sense_voice (the old ASR) was English/CJK-only
                # and could not handle Spanish at all. Model overridable for speed:
                # COMPANION_WHISPER_MODEL=large-v3-turbo|medium|small.
                "asr_model": "faster_whisper",
                "faster_whisper": {
                    "model_path": os.environ.get("COMPANION_WHISPER_MODEL", "large-v3"),
                    "download_root": "./models/faster-whisper",
                    "language": "",
                    "device": "cpu",
                    "compute_type": "int8",
                },
            },
            "tts_config": tts_config_block(default_tts_profile, tts_voice),
            "vad_config": {
                "vad_model": None,
                "silero_vad": {
                    "orig_sr": 16000,
                    "target_sr": 16000,
                    "prob_threshold": 0.4,
                    "db_threshold": 60,
                    "required_hits": 3,
                    "required_misses": 24,
                    "smoothing_window": 5,
                },
            },
            "tts_preprocessor_config": {
                "remove_special_char": True,
                "ignore_brackets": True,
                "ignore_parentheses": True,
                "ignore_asterisks": True,
                "ignore_angle_brackets": True,
                "translator_config": {
                    "translate_audio": False,
                    "translate_provider": "deeplx",
                    "deeplx": {
                        "deeplx_target_lang": "JA",
                        "deeplx_api_endpoint": "http://localhost:1188/v2/translate",
                    },
                },
            },
        },
    }

    return config


def get_household_profiles():
    """Read household profiles from COMPANION_PROFILE_* env vars.

    Current keys (per-profile, 1..9):
        COMPANION_PROFILE_N_NAME            — display name (required)
        COMPANION_PROFILE_N_AVATAR          — Live2D model id
        COMPANION_PROFILE_N_TTS_PROFILE_ID  — id of a platform tts_profile
        COMPANION_PROFILE_N_TTS_VOICE       — voice name within that profile

    Legacy fallback (deprecated, read for one release):
        COMPANION_PROFILE_N_VOICE  (raw Edge TTS voice)
    """
    profiles = []
    for i in range(1, 10):
        name = os.environ.get(f"COMPANION_PROFILE_{i}_NAME")
        if not name:
            continue
        voice = (
            os.environ.get(f"COMPANION_PROFILE_{i}_TTS_VOICE")
            or os.environ.get(f"COMPANION_PROFILE_{i}_VOICE")
            or ""
        )
        profiles.append({
            "name": name,
            "avatar": os.environ.get(f"COMPANION_PROFILE_{i}_AVATAR", "mao_pro"),
            "tts_profile_id": os.environ.get(f"COMPANION_PROFILE_{i}_TTS_PROFILE_ID", ""),
            "voice": voice or "en-US-AvaMultilingualNeural",
        })
    return profiles


def get_companion_bots(db_path):
    """Read pi_bot_defs for bots bound to a companion gateway (Part 3).

    Each returned bot gets its own OLVV character preset (crow_bot_<slug>) so a
    kiosk can select its bound bot's persona + avatar per device via ?device=.
    The model pair stays global (the gateway /llm/v1 router) — presets only carry
    persona/avatar/voice, never an llm_config.
    """
    if not db_path:
        return []
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE enabled = 1"
            ).fetchall()
        except sqlite3.OperationalError:
            rows = conn.execute(
                "SELECT bot_id, display_name, definition FROM pi_bot_defs"
            ).fetchall()
        conn.close()
    except Exception as e:
        print(f"Warning: could not read pi_bot_defs: {e}", file=sys.stderr)
        return []
    bots = []
    for r in rows:
        try:
            d = json.loads(r["definition"] or "{}")
        except Exception:
            continue
        gws = d.get("gateways") or []
        if not any((g or {}).get("type") == "companion" for g in gws):
            continue
        feats = d.get("companion_features") or {}
        bots.append({
            "slug": slugify(r["bot_id"]),
            "bot_id": r["bot_id"],
            "name": d.get("display_name") or r["display_name"] or r["bot_id"],
            "persona": d.get("system_prompt") or "",
            "avatar": feats.get("avatar_model") or None,
            "features": feats,
        })
    return bots


def generate_character_configs(all_models, default_avatar, tts_profiles=None):
    """Generate per-avatar character configs for the companion's character selector.

    Each "character" in the Open-LLM-VTuber UI represents a different avatar model,
    all using the same LLM provider (configured in Crow's Nest settings).

    If household profiles are defined (COMPANION_PROFILE_* env vars), profile
    characters are generated INSTEAD of plain avatar characters. Each profile
    gets its own name, avatar, and TTS voice in the character selector.
    """
    tts_profiles = tts_profiles or []
    configs = {}
    household = get_household_profiles()
    profile_avatars = set()

    if household:
        # Read base persona for profile scoping
        base_persona = os.environ.get("COMPANION_PERSONA", "") or (
            "You are Crow, an AI companion and assistant. You are helpful, curious, "
            "and have a dry wit. Keep responses conversational and concise since they "
            "will be spoken aloud. IMPORTANT: Always respond in English regardless of "
            "the language of the user's input. The speech recognition may mistranscribe "
            "English as Chinese or other languages; interpret the intent and respond in English. "
            "When the user asks to open, play, watch, show, or search for something new, "
            "use the crow_wm_open tool. When the user says resume, unpause, pause, mute, unmute, "
            "or volume up/down, use the crow_wm_media tool. NEVER describe what you would do "
            "without calling the tool. If in doubt, call the tool."
        )

        # Profile mode: each profile becomes a character with distinct name, avatar, voice
        for profile in household:
            slug = slugify(profile["name"])
            avatar_id = profile["avatar"]
            if avatar_id not in all_models:
                print(f"Warning: Profile '{profile['name']}' uses unknown avatar '{avatar_id}', falling back to mao_pro", file=sys.stderr)
                avatar_id = "mao_pro"

            # Per-user memory scoping: add profile tag instructions to persona
            profile_persona = (
                f"{base_persona}\n\n"
                f"MEMORY SCOPING: You are currently talking to {profile['name']}. "
                f"When storing memories (crow_store_memory), ALWAYS include "
                f"\"profile:{slug}\" in the tags field. "
                f"When searching memories (crow_search_memories, crow_recall_by_context), "
                f"include \"profile:{slug}\" in the query to retrieve only "
                f"{profile['name']}'s memories. "
                f"Do NOT access other household members' memories unless "
                f"{profile['name']} explicitly asks about shared information."
            )

            # Resolve this profile's TTS provider block.
            # Priority: explicit tts_profile_id → default platform profile → fallback edge_tts.
            profile_tts = find_tts_profile(tts_profiles, profile.get("tts_profile_id"))
            tts_block = tts_config_block(profile_tts, profile.get("voice", ""))

            config = {
                "character_config": {
                    "conf_name": f"crow_profile_{slug}",
                    "conf_uid": f"crow_profile_{slug}_001",
                    "character_name": profile["name"],
                    "human_name": profile["name"],
                    "live2d_model_name": avatar_id,
                    "persona_prompt": profile_persona,
                    "tts_config": tts_block,
                }
            }
            configs[f"crow_profile_{slug}.yaml"] = config

        print(f"  Household profiles: {', '.join(p['name'] for p in household)}")
        # Fall through to also generate avatar characters below
        # so users can switch avatars beyond their profile default.
        profile_avatars = {p["avatar"] for p in household}

    # Generate one character per avatar (skip default and profile avatars)
    for model_id, model_config in all_models.items():
        if model_id == default_avatar:
            continue  # Skip the default — it's already in conf.yaml
        if household and model_id in profile_avatars:
            continue  # Already has a profile character

        display_name = model_config.get("description", model_id)
        # Strip the model_id from description if it looks like "Name (source, N motions)"
        short_name = display_name.split(" (")[0] if " (" in display_name else display_name

        config = {
            "character_config": {
                "conf_name": f"crow_avatar_{model_id}",
                "conf_uid": f"crow_avatar_{model_id}_001",
                "character_name": f"Crow ({short_name})",
                "live2d_model_name": model_id,
            }
        }
        configs[f"crow_avatar_{model_id}.yaml"] = config

    return configs


def generate_model_dict():
    """Generate model_dict.json with all available avatars (bundled + Eikanya)."""
    models = list(AVATAR_MODELS.values())
    eikanya = discover_eikanya_models()
    models.extend(eikanya.values())
    return models, eikanya


def main():
    app_dir = os.environ.get("APP_DIR", "/app")
    db_path = get_crow_db_path()

    if not db_path:
        print("Warning: Crow database not found, using fallback config", file=sys.stderr)
        profiles = []
        tts_profiles = []
    else:
        print(f"Reading AI profiles from {db_path}")
        profiles = get_ai_profiles(db_path)
        print(f"Found {len(profiles)} AI profile(s)")
        tts_profiles = get_tts_profiles(db_path)
        print(f"Found {len(tts_profiles)} TTS profile(s)")

    env_vars = {
        "COMPANION_TTS_VOICE": os.environ.get("COMPANION_TTS_VOICE", ""),
        "COMPANION_PERSONA": os.environ.get("COMPANION_PERSONA", ""),
        "COMPANION_CHARACTER_NAME": os.environ.get("COMPANION_CHARACTER_NAME", "Crow"),
        "COMPANION_AVATAR": os.environ.get("COMPANION_AVATAR", "mao_pro"),
        "COMPANION_AI_PROFILE": os.environ.get("COMPANION_AI_PROFILE", ""),
        "COMPANION_AI_MODEL": os.environ.get("COMPANION_AI_MODEL", ""),
    }

    # Generate main config
    config = generate_config(profiles, env_vars, tts_profiles)
    conf_path = os.path.join(app_dir, "conf.yaml")
    with open(conf_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"Generated {conf_path}")

    # Generate mcp_servers.json with Crow bridges
    # - "crow" connects to the router (memory, projects, blog, sharing — 7 category tools)
    # - "crow-storage" connects directly to the storage server for background generation
    #   (exposes crow_generate_background etc. as individual tools the LLM can call by name)
    mcp_bridge_host = os.environ.get("CROW_MCP_BRIDGE_HOST", "localhost")
    # The Crow gateway listens on 3001 by default (the prior 3004 default pointed
    # at no running process, so every MCP bridge failed to connect). /router and
    # /storage require bearer auth; /wm is open. We pass the local MCP token as an
    # Authorization header to all three — harmless for /wm, required for the rest.
    mcp_bridge_port = os.environ.get("CROW_MCP_BRIDGE_PORT", "3001")
    mcp_token = os.environ.get("CROW_LOCAL_MCP_TOKEN", "")
    if not mcp_token:
        print(
            "Warning: CROW_LOCAL_MCP_TOKEN is unset — crow/crow-storage MCP bridges "
            "will get 401 from the gateway (crow-wm is open and still works).",
            file=sys.stderr,
        )

    def _mcp_proxy_args(path):
        args = [
            "run", "mcp-proxy",
            f"http://{mcp_bridge_host}:{mcp_bridge_port}{path}",
            "--transport", "streamablehttp",
        ]
        if mcp_token:
            args += ["--headers", "Authorization", f"Bearer {mcp_token}"]
        return args

    mcp_config = {
        "mcp_servers": {
            "crow": {"command": "uv", "args": _mcp_proxy_args("/router/mcp")},
            "crow-storage": {"command": "uv", "args": _mcp_proxy_args("/storage/mcp")},
            "crow-wm": {"command": "uv", "args": _mcp_proxy_args("/wm/mcp")},
        }
    }
    mcp_path = os.path.join(app_dir, "mcp_servers.json")
    with open(mcp_path, "w") as f:
        json.dump(mcp_config, f, indent=4)
    print(f"Generated {mcp_path} (Crow MCP bridge + direct storage)")

    # Generate model_dict.json with all avatars
    model_dict, eikanya = generate_model_dict()
    model_dict_path = os.path.join(app_dir, "model_dict.json")
    with open(model_dict_path, "w") as f:
        json.dump(model_dict, f, indent=4)
    bundled_count = len(AVATAR_MODELS)
    eikanya_count = len(eikanya)
    print(f"Generated {model_dict_path} with {len(model_dict)} avatar(s) ({bundled_count} bundled + {eikanya_count} Eikanya)")

    # Generate character configs — one per avatar for the companion character selector.
    # AI provider is set in Crow's Nest settings; character selector switches avatars.
    all_avatar_models = {**AVATAR_MODELS, **eikanya}
    default_avatar = env_vars.get("COMPANION_AVATAR", "mao_pro")
    characters_dir = os.path.join(app_dir, "characters")
    os.makedirs(characters_dir, exist_ok=True)
    # Clean old character configs (may have LLM-based ones from before the flip)
    for old_file in os.listdir(characters_dir):
        if old_file.startswith("crow_") and old_file.endswith(".yaml"):
            os.remove(os.path.join(characters_dir, old_file))
    char_configs = generate_character_configs(all_avatar_models, default_avatar, tts_profiles)
    for filename, char_config in char_configs.items():
        char_path = os.path.join(characters_dir, filename)
        with open(char_path, "w") as f:
            yaml.dump(char_config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        print(f"  Character: {char_path}")

    total_chars = len(char_configs)
    print(f"Generated {total_chars} avatar character preset(s) ({len(all_avatar_models)} total avatars, default: {default_avatar})")

    # Part 3: per-companion-bot character presets. A kiosk device bound to a bot
    # selects crow_bot_<slug> (persona + avatar) via ?device=. No llm_config here —
    # the model pair is the global gateway /llm/v1 router.
    bot_presets = 0
    for bot in get_companion_bots(db_path):
        avatar = bot["avatar"] if bot["avatar"] in all_avatar_models else default_avatar
        cc = {
            "conf_name": f"crow_bot_{bot['slug']}",
            "conf_uid": f"crow_bot_{bot['slug']}_001",
            "character_name": bot["name"],
            "human_name": bot["name"],
            "live2d_model_name": avatar,
        }
        if bot["persona"]:
            cc["persona_prompt"] = bot["persona"]
        path = os.path.join(characters_dir, f"crow_bot_{bot['slug']}.yaml")
        with open(path, "w") as f:
            yaml.dump({"character_config": cc}, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        bot_presets += 1
        print(f"  Bot preset: {path}")
    if bot_presets:
        print(f"Generated {bot_presets} companion-bot character preset(s)")
    print("Config generation complete.")


if __name__ == "__main__":
    main()
