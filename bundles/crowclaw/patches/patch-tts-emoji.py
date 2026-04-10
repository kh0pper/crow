#!/usr/bin/env python3
"""Patch OpenClaw reply module to strip emojis from TTS text before synthesis."""

import sys
import os
import subprocess

def _find_openclaw_dist():
    """Auto-detect OpenClaw dist directory from npm global install."""
    try:
        result = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, check=True)
        return os.path.join(result.stdout.strip(), "openclaw", "dist")
    except Exception:
        return os.path.expanduser("~/.nvm/versions/node/v24.8.0/lib/node_modules/openclaw/dist")

_DIST = os.environ.get("OPENCLAW_DIST", _find_openclaw_dist())
filepath = os.path.join(_DIST, "reply-Deht_wOB.js")

with open(filepath, "r") as f:
    content = f.read()

# The emoji stripping function
STRIP_FN = (
    'function stripEmojisForTts(text) {\n'
    '\treturn text.replace(/[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}'
    '\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}'
    '\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}\\u{1F900}-\\u{1F9FF}'
    '\\u{1FA00}-\\u{1FA6F}\\u{1FA70}-\\u{1FAFF}\\u{200D}\\u{20E3}'
    '\\u{E0020}-\\u{E007F}]/gu, "").replace(/\\s{2,}/g, " ").trim();\n'
    '}\n'
)

errors = []

# 1. Patch voice channel path
old_voice = 'const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();'
new_voice = 'const speakText = stripEmojisForTts(directive.overrides.ttsText ?? directive.cleanedText.trim());'

if old_voice in content:
    # Insert function definition right before this line, then replace the line
    content = content.replace(old_voice, STRIP_FN + new_voice, 1)
    print("OK: Patched voice channel TTS path")
else:
    errors.append("Could not find voice channel TTS target")
    print("ERROR: Could not find voice channel TTS target")

# 2. Patch text channel TTS path
old_text = '\tlet textForAudio = ttsText.trim();'
new_text = '\tlet textForAudio = stripEmojisForTts(ttsText.trim());'

if old_text in content:
    content = content.replace(old_text, new_text, 1)
    print("OK: Patched text channel TTS path")
else:
    errors.append("Could not find text channel TTS target")
    print("ERROR: Could not find text channel TTS target")

# 3. Make sure stripEmojisForTts is defined BEFORE the text channel usage too
text_tts_pos = content.find('stripEmojisForTts(ttsText')
voice_fn_pos = content.find('function stripEmojisForTts')

if text_tts_pos != -1 and voice_fn_pos != -1:
    if voice_fn_pos > text_tts_pos:
        # Function defined after first usage - need to add it before
        marker = 'const DEFAULT_TIMEOUT_MS$1 = 3e4;'
        marker_pos = content.find(marker)
        if marker_pos != -1:
            content = content[:marker_pos] + STRIP_FN + '\n' + content[marker_pos:]
            print("OK: Added stripEmojisForTts before text channel TTS path")
        else:
            errors.append("Could not find insertion marker for text channel")
            print("ERROR: Could not find insertion marker")
    else:
        print("OK: Function already defined before text channel usage")

if errors:
    print(f"\nFAILED with {len(errors)} error(s)")
    sys.exit(1)

with open(filepath, "w") as f:
    f.write(content)

print("\nPatch applied successfully")
