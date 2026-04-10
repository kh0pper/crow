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
    """Read AI profiles from Crow's dashboard_settings table."""
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute(
            "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'"
        )
        row = cursor.fetchone()
        conn.close()
        if row:
            return json.loads(row[0])
    except Exception as e:
        print(f"Warning: Could not read AI profiles: {e}", file=sys.stderr)
    return []


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

    # Auto mode: prefer local profiles (faster inference for voice chat)
    for p in profiles:
        base = p.get("baseUrl", "")
        if "localhost" in base or "172.17" in base or "127.0.0.1" in base:
            return p
    return profiles[0] if profiles else None


def generate_config(profiles, env_vars):
    """Generate conf.yaml content from AI profiles and env vars."""
    tts_voice = env_vars.get("COMPANION_TTS_VOICE", "en-US-AvaMultilingualNeural")
    persona = env_vars.get("COMPANION_PERSONA", "") or (
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
    char_name = env_vars.get("COMPANION_CHARACTER_NAME", "Crow")
    avatar = env_vars.get("COMPANION_AVATAR", "mao_pro")

    eikanya = discover_eikanya_models()
    all_models = {**AVATAR_MODELS, **eikanya}
    if avatar not in all_models:
        print(f"Warning: Unknown avatar '{avatar}', falling back to mao_pro", file=sys.stderr)
        avatar = "mao_pro"

    default_profile = resolve_ai_profile(profiles, env_vars)

    if default_profile:
        # Rewrite Docker bridge IPs to localhost (for host network mode)
        base_url = default_profile["baseUrl"]
        if "172.17.0.1" in base_url:
            base_url = base_url.replace("172.17.0.1", "localhost")
        llm_config = {
            "base_url": base_url,
            "llm_api_key": default_profile["apiKey"],
            "model": default_profile.get("_model") or default_profile.get("defaultModel", default_profile["models"][0]),
            "temperature": 0.8,
        }
    else:
        llm_config = {
            "base_url": "http://localhost:11434/v1",
            "llm_api_key": "not-needed",
            "model": "qwen2.5:latest",
            "temperature": 0.8,
        }

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
                "proactive_speak_prompt": "proactive_speak_prompt",
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
                "asr_model": "sherpa_onnx_asr",
                "sherpa_onnx_asr": {
                    "model_type": "sense_voice",
                    "sense_voice": "./models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx",
                    "tokens": "./models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt",
                    "num_threads": 4,
                    "use_itn": True,
                    "provider": "cpu",
                },
            },
            "tts_config": {
                "tts_model": "edge_tts",
                "edge_tts": {"voice": tts_voice},
            },
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

    Format:
        COMPANION_PROFILE_1_NAME=User
        COMPANION_PROFILE_1_AVATAR=Cha_AnnoyingParrot
        COMPANION_PROFILE_1_VOICE=en-GB-LibbyNeural
        COMPANION_PROFILE_2_NAME=Partner
        COMPANION_PROFILE_2_AVATAR=senko
        COMPANION_PROFILE_2_VOICE=en-US-AvaMultilingualNeural
    """
    profiles = []
    for i in range(1, 10):  # Support up to 9 profiles
        name = os.environ.get(f"COMPANION_PROFILE_{i}_NAME")
        if not name:
            continue
        profiles.append({
            "name": name,
            "avatar": os.environ.get(f"COMPANION_PROFILE_{i}_AVATAR", "mao_pro"),
            "voice": os.environ.get(f"COMPANION_PROFILE_{i}_VOICE", "en-US-AvaMultilingualNeural"),
        })
    return profiles


def generate_character_configs(all_models, default_avatar):
    """Generate per-avatar character configs for the companion's character selector.

    Each "character" in the Open-LLM-VTuber UI represents a different avatar model,
    all using the same LLM provider (configured in Crow's Nest settings).

    If household profiles are defined (COMPANION_PROFILE_* env vars), profile
    characters are generated INSTEAD of plain avatar characters. Each profile
    gets its own name, avatar, and TTS voice in the character selector.
    """
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

            config = {
                "character_config": {
                    "conf_name": f"crow_profile_{slug}",
                    "conf_uid": f"crow_profile_{slug}_001",
                    "character_name": profile["name"],
                    "human_name": profile["name"],
                    "live2d_model_name": avatar_id,
                    "persona_prompt": profile_persona,
                    "tts_config": {
                        "tts_model": "edge_tts",
                        "edge_tts": {"voice": profile["voice"]},
                    },
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
    else:
        print(f"Reading AI profiles from {db_path}")
        profiles = get_ai_profiles(db_path)
        print(f"Found {len(profiles)} AI profile(s)")

    env_vars = {
        "COMPANION_TTS_VOICE": os.environ.get("COMPANION_TTS_VOICE", "en-US-AvaMultilingualNeural"),
        "COMPANION_PERSONA": os.environ.get("COMPANION_PERSONA", ""),
        "COMPANION_CHARACTER_NAME": os.environ.get("COMPANION_CHARACTER_NAME", "Crow"),
        "COMPANION_AVATAR": os.environ.get("COMPANION_AVATAR", "mao_pro"),
        "COMPANION_AI_PROFILE": os.environ.get("COMPANION_AI_PROFILE", ""),
        "COMPANION_AI_MODEL": os.environ.get("COMPANION_AI_MODEL", ""),
    }

    # Generate main config
    config = generate_config(profiles, env_vars)
    conf_path = os.path.join(app_dir, "conf.yaml")
    with open(conf_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"Generated {conf_path}")

    # Generate mcp_servers.json with Crow bridges
    # - "crow" connects to the router (memory, projects, blog, sharing — 7 category tools)
    # - "crow-storage" connects directly to the storage server for background generation
    #   (exposes crow_generate_background etc. as individual tools the LLM can call by name)
    mcp_bridge_host = os.environ.get("CROW_MCP_BRIDGE_HOST", "localhost")
    mcp_bridge_port = os.environ.get("CROW_MCP_BRIDGE_PORT", "3004")
    mcp_config = {
        "mcp_servers": {
            "crow": {
                "command": "uv",
                "args": [
                    "run", "mcp-proxy",
                    f"http://{mcp_bridge_host}:{mcp_bridge_port}/router/mcp",
                    "--transport", "streamablehttp",
                ],
            },
            "crow-storage": {
                "command": "uv",
                "args": [
                    "run", "mcp-proxy",
                    f"http://{mcp_bridge_host}:{mcp_bridge_port}/storage/mcp",
                    "--transport", "streamablehttp",
                ],
            },
            "crow-wm": {
                "command": "uv",
                "args": [
                    "run", "mcp-proxy",
                    f"http://{mcp_bridge_host}:{mcp_bridge_port}/wm/mcp",
                    "--transport", "streamablehttp",
                ],
            },
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
    char_configs = generate_character_configs(all_avatar_models, default_avatar)
    for filename, char_config in char_configs.items():
        char_path = os.path.join(characters_dir, filename)
        with open(char_path, "w") as f:
            yaml.dump(char_config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        print(f"  Character: {char_path}")

    total_chars = len(char_configs)
    print(f"Generated {total_chars} avatar character preset(s) ({len(all_avatar_models)} total avatars, default: {default_avatar})")
    print("Config generation complete.")


if __name__ == "__main__":
    main()
