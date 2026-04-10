#!/usr/bin/env python3
"""Patch OpenClaw for Whisper-based language detection in voice TTS.

Idempotent: restores from .bak on each run, then applies all patches.

Runner patches (runner-DMMMVobY.js):
  R1: Request verbose_json from Groq Whisper API
  R2: Capture language field from response
  R3: Pass language through audio.transcription output

Reply patches (reply-Deht_wOB.js):
  P1: Add stripEmojisForTts to text channel TTS path (line ~13098)
  P2: Add stripEmojisForTts definition before text channel usage (line ~12571)
  P3: Change transcribeAudio() return to {text, language} (line ~33011)
  P4: Destructure transcriptionResult in processSegment() (line ~33284)
  P5: Emoji strip + response-text voice selection in voice path (line ~33312)
"""

import os
import sys
import shutil

import subprocess

def _find_openclaw_dist():
    """Auto-detect OpenClaw dist directory from npm global install."""
    try:
        result = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, check=True)
        return os.path.join(result.stdout.strip(), "openclaw", "dist")
    except Exception:
        return os.path.expanduser("~/.nvm/versions/node/v24.8.0/lib/node_modules/openclaw/dist")

_DIST = os.environ.get("OPENCLAW_DIST", _find_openclaw_dist())
RUNNER = os.path.join(_DIST, "runner-DMMMVobY.js")
REPLY = os.path.join(_DIST, "reply-Deht_wOB.js")
RUNNER_BAK = RUNNER + ".bak"
REPLY_BAK = REPLY + ".bak"

# ── Shared constants ──────────────────────────────────────────────

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
results = []


def patch(content, old, new, label):
    """Replace old with new in content exactly once. Track results."""
    if old in content:
        count = content.count(old)
        if count > 1:
            errors.append(f"{label}: found {count} matches (expected 1)")
            results.append(f"ERROR: {label}: ambiguous match ({count} occurrences)")
            return content
        content = content.replace(old, new, 1)
        results.append(f"OK: {label}")
    else:
        errors.append(label)
        results.append(f"ERROR: {label}: target string not found")
    return content


# ── Step 1: Create backups ────────────────────────────────────────

if not os.path.exists(RUNNER_BAK):
    shutil.copy2(RUNNER, RUNNER_BAK)
    results.append(f"OK: Created runner backup at {RUNNER_BAK}")
else:
    results.append(f"OK: Runner backup already exists at {RUNNER_BAK}")

if not os.path.exists(REPLY_BAK):
    print("ERROR: Reply backup does not exist. Cannot proceed without original.")
    sys.exit(1)

# ── Step 2: Restore from backups (clean slate) ───────────────────

shutil.copy2(RUNNER_BAK, RUNNER)
results.append("OK: Restored runner from backup")

shutil.copy2(REPLY_BAK, REPLY)
results.append("OK: Restored reply from backup")

# ── Step 3: Read clean files ─────────────────────────────────────

with open(RUNNER, "r") as f:
    runner = f.read()

with open(REPLY, "r") as f:
    reply = f.read()

# ══════════════════════════════════════════════════════════════════
# RUNNER PATCHES
# ══════════════════════════════════════════════════════════════════

# R1: Request verbose_json format from Groq Whisper
runner = patch(
    runner,
    '\tform.append("model", model);\n'
    '\tif (params.language?.trim())',
    '\tform.append("model", model);\n'
    '\tform.append("response_format", "verbose_json");\n'
    '\tif (params.language?.trim())',
    "R1: Add response_format=verbose_json"
)

# R2: Capture language from Whisper response
runner = patch(
    runner,
    '\t\treturn {\n'
    '\t\t\ttext: requireTranscriptionText((await res.json()).text, "Audio transcription response missing text"),\n'
    '\t\t\tmodel\n'
    '\t\t};',
    '\t\tconst jsonBody = await res.json();\n'
    '\t\tconst _maxNoSpeech = (jsonBody.segments || []).reduce((m, s) => Math.max(m, s.no_speech_prob || 0), 0);\n'
    '\t\treturn {\n'
    '\t\t\ttext: requireTranscriptionText(jsonBody.text, "Audio transcription response missing text"),\n'
    '\t\t\tlanguage: jsonBody.language,\n'
    '\t\t\tnoSpeechProb: _maxNoSpeech,\n'
    '\t\t\tmodel\n'
    '\t\t};',
    "R2: Capture language + noSpeechProb from Whisper response"
)

# R3: Pass language through audio.transcription output
# Include kind: "audio.transcription" to disambiguate from image/video paths
runner = patch(
    runner,
    '\t\treturn {\n'
    '\t\t\tkind: "audio.transcription",\n'
    '\t\t\tattachmentIndex: params.attachmentIndex,\n'
    '\t\t\ttext: trimOutput(result.text, maxChars),\n'
    '\t\t\tprovider: providerId,',
    '\t\treturn {\n'
    '\t\t\tkind: "audio.transcription",\n'
    '\t\t\tattachmentIndex: params.attachmentIndex,\n'
    '\t\t\ttext: trimOutput(result.text, maxChars),\n'
    '\t\t\tlanguage: result.language,\n'
    '\t\t\tnoSpeechProb: result.noSpeechProb,\n'
    '\t\t\tprovider: providerId,',
    "R3: Pass language + noSpeechProb through output object"
)

# ══════════════════════════════════════════════════════════════════
# REPLY PATCHES
# ══════════════════════════════════════════════════════════════════

# P1: Emoji stripping in text channel TTS path
reply = patch(
    reply,
    '\tlet textForAudio = ttsText.trim();',
    '\tlet textForAudio = stripEmojisForTts(ttsText.trim());',
    "P1: Emoji strip in text channel TTS"
)

# P2: Add stripEmojisForTts definition before text channel usage
# The function is defined at voice-channel scope (inside processSegment),
# so we need a separate definition before the text channel TTS path.
text_tts_pos = reply.find('stripEmojisForTts(ttsText')
voice_fn_pos = reply.find('function stripEmojisForTts')
if text_tts_pos != -1 and (voice_fn_pos == -1 or voice_fn_pos > text_tts_pos):
    marker = 'const DEFAULT_TIMEOUT_MS$1 = 3e4;'
    if marker in reply:
        marker_pos = reply.find(marker)
        reply = reply[:marker_pos] + STRIP_FN + '\n' + reply[marker_pos:]
        results.append("OK: P2: Added stripEmojisForTts before text channel TTS")
    else:
        errors.append("P2: marker DEFAULT_TIMEOUT_MS$1 not found")
        results.append("ERROR: P2: marker DEFAULT_TIMEOUT_MS$1 not found")
elif text_tts_pos == -1:
    errors.append("P2: text channel emoji strip call not found (P1 may have failed)")
    results.append("ERROR: P2: text channel emoji strip call not found")
else:
    results.append("OK: P2: stripEmojisForTts already defined before text channel usage")

# P3: Change transcribeAudio() to return {text, language}
reply = patch(
    reply,
    '\t\treturn (await runCapability({\n'
    '\t\t\tcapability: "audio",\n'
    '\t\t\tcfg: params.cfg,\n'
    '\t\t\tctx,\n'
    '\t\t\tattachments: cache,\n'
    '\t\t\tmedia: attachments,\n'
    '\t\t\tagentDir: resolveAgentDir(params.cfg, params.agentId),\n'
    '\t\t\tproviderRegistry,\n'
    '\t\t\tconfig: params.cfg.tools?.media?.audio\n'
    '\t\t})).outputs.find((entry) => entry.kind === "audio.transcription")?.text?.trim() || void 0;',
    '\t\tconst _txEntry = (await runCapability({\n'
    '\t\t\tcapability: "audio",\n'
    '\t\t\tcfg: params.cfg,\n'
    '\t\t\tctx,\n'
    '\t\t\tattachments: cache,\n'
    '\t\t\tmedia: attachments,\n'
    '\t\t\tagentDir: resolveAgentDir(params.cfg, params.agentId),\n'
    '\t\t\tproviderRegistry,\n'
    '\t\t\tconfig: params.cfg.tools?.media?.audio\n'
    '\t\t})).outputs.find((e) => e.kind === "audio.transcription");\n'
    '\t\tconst _txText = _txEntry?.text?.trim() || void 0;\n'
    '\t\tif (!_txText) return;\n'
    '\t\treturn { text: _txText, language: _txEntry?.language, noSpeechProb: _txEntry?.noSpeechProb };',
    "P3: transcribeAudio returns {text, language, noSpeechProb}"
)

# P4: Destructure transcriptionResult in processSegment()
reply = patch(
    reply,
    '\t\tconst transcript = await transcribeAudio({\n'
    '\t\t\tcfg: this.params.cfg,\n'
    '\t\t\tagentId: entry.route.agentId,\n'
    '\t\t\tfilePath: wavPath\n'
    '\t\t});\n'
    '\t\tif (!transcript) {\n'
    '\t\t\tlogVoiceVerbose(`transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);\n'
    '\t\t\treturn;\n'
    '\t\t}\n'
    '\t\tlogVoiceVerbose(`transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);',
    '\t\tconst transcriptionResult = await transcribeAudio({\n'
    '\t\t\tcfg: this.params.cfg,\n'
    '\t\t\tagentId: entry.route.agentId,\n'
    '\t\t\tfilePath: wavPath\n'
    '\t\t});\n'
    '\t\tif (!transcriptionResult) {\n'
    '\t\t\tlogVoiceVerbose(`transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);\n'
    '\t\t\treturn;\n'
    '\t\t}\n'
    '\t\tif ((transcriptionResult.noSpeechProb || 0) > 0.6) {\n'
    '\t\t\tlogVoiceVerbose(`transcription dropped (no_speech_prob=${(transcriptionResult.noSpeechProb || 0).toFixed(3)}): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);\n'
    '\t\t\treturn;\n'
    '\t\t}\n'
    '\t\tconst transcript = transcriptionResult.text;\n'
    '\t\tconst whisperLang = transcriptionResult.language;\n'
    '\t\tlogVoiceVerbose(`transcription ok (${transcript.length} chars, lang=${whisperLang ?? "?"}, nsp=${(transcriptionResult.noSpeechProb || 0).toFixed(3)}): guild ${entry.guildId} channel ${entry.channelId}`);',
    "P4: Destructure transcriptionResult + no_speech_prob filter"
)

# P5: Emoji strip + Whisper-based voice selection (replaces regex approach)
reply = patch(
    reply,
    '\t\tconst speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();\n'
    '\t\tif (!speakText) {\n'
    '\t\t\tlogVoiceVerbose(`tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);\n'
    '\t\t\treturn;\n'
    '\t\t}\n'
    '\t\tconst ttsResult = await textToSpeech({\n'
    '\t\t\ttext: speakText,\n'
    '\t\t\tcfg: ttsCfg,\n'
    '\t\t\tchannel: "discord",\n'
    '\t\t\toverrides: directive.overrides\n'
    '\t\t});',
    STRIP_FN
    + '\t\tconst speakText = stripEmojisForTts(directive.overrides.ttsText ?? directive.cleanedText.trim());\n'
    '\t\tif (!speakText) {\n'
    '\t\t\tlogVoiceVerbose(`tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);\n'
    '\t\t\treturn;\n'
    '\t\t}\n'
    '\t\tconst _hasSpanishChars = /[áéíóúüñ¿¡]/i.test(speakText);\n'
    '\t\tconst _hasSpanishWords = /\\b(nada|claro|bueno|buena|buenos|buenas|hola|gracias|puedo|puedes|puede|tengo|tiene|quiero|vamos|entiendo|también|entonces|porque|perdón|disculpa)\\b/i.test(speakText);\n'
    '\t\tconst detectedLang = (_hasSpanishChars || _hasSpanishWords) ? "es" : ((whisperLang && whisperLang.toLowerCase() === "spanish") ? "es" : "en");\n'
    '\t\tconst langVoiceMap = { "es": "es-MX-JorgeNeural", "en": "en-US-BrianNeural" };\n'
    '\t\tconst targetVoice = langVoiceMap[detectedLang] || "en-US-BrianNeural";\n'
    '\t\tlogVoiceVerbose(`voice-language: response=${detectedLang} whisper=${whisperLang ?? "?"} voice=${targetVoice}`);\n'
    '\t\tconst langTtsCfg = JSON.parse(JSON.stringify(ttsCfg));\n'
    '\t\tif (!langTtsCfg.messages) langTtsCfg.messages = {};\n'
    '\t\tif (!langTtsCfg.messages.tts) langTtsCfg.messages.tts = {};\n'
    '\t\tif (!langTtsCfg.messages.tts.edge) langTtsCfg.messages.tts.edge = {};\n'
    '\t\tlangTtsCfg.messages.tts.edge.voice = targetVoice;\n'
    '\t\tconst ttsResult = await textToSpeech({\n'
    '\t\t\ttext: speakText,\n'
    '\t\t\tcfg: langTtsCfg,\n'
    '\t\t\tchannel: "discord",\n'
    '\t\t\toverrides: directive.overrides\n'
    '\t\t});',
    "P5: Response-text voice selection + emoji strip in voice path"
)

# ══════════════════════════════════════════════════════════════════
# Write patched files
# ══════════════════════════════════════════════════════════════════

with open(RUNNER, "w") as f:
    f.write(runner)

with open(REPLY, "w") as f:
    f.write(reply)

# ══════════════════════════════════════════════════════════════════
# Verification
# ══════════════════════════════════════════════════════════════════

verify_errors = []

# Runner verifications
if 'form.append("response_format", "verbose_json")' not in runner:
    verify_errors.append("Runner missing verbose_json")
if "language: jsonBody.language" not in runner:
    verify_errors.append("Runner missing language capture")
if "noSpeechProb: _maxNoSpeech" not in runner:
    verify_errors.append("Runner missing noSpeechProb capture")
if "language: result.language," not in runner:
    verify_errors.append("Runner missing language passthrough")
if "noSpeechProb: result.noSpeechProb," not in runner:
    verify_errors.append("Runner missing noSpeechProb passthrough")

# Reply verifications
if "stripEmojisForTts(ttsText" not in reply:
    verify_errors.append("Reply missing emoji strip in text channel")
if "stripEmojisForTts(directive" not in reply:
    verify_errors.append("Reply missing emoji strip in voice channel")
if "noSpeechProb: _txEntry?.noSpeechProb" not in reply:
    verify_errors.append("Reply missing transcribeAudio noSpeechProb return")
if "const whisperLang = transcriptionResult.language;" not in reply:
    verify_errors.append("Reply missing whisperLang destructure")
if "noSpeechProb || 0) > 0.6" not in reply:
    verify_errors.append("Reply missing no_speech_prob filter")
if '_hasSpanishChars' not in reply:
    verify_errors.append("Reply missing response text language detection")
if "langTtsCfg.messages.tts.edge.voice = targetVoice;" not in reply:
    verify_errors.append("Reply missing voice override")
if "detectLanguageForVoice" in reply:
    verify_errors.append("Reply still contains old regex detectLanguageForVoice")

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print("PATCH RESULTS")
print("=" * 60)
for r in results:
    print(f"  {r}")

if verify_errors:
    print("\nVERIFICATION FAILURES:")
    for v in verify_errors:
        print(f"  FAIL: {v}")

if errors or verify_errors:
    print(f"\nFAILED: {len(errors)} patch error(s), {len(verify_errors)} verification error(s)")
    sys.exit(1)
else:
    print(f"\nSUCCESS: All {len(results)} patches applied and verified")
    print(f"  Runner: {RUNNER}")
    print(f"  Reply:  {REPLY}")
