#!/usr/bin/env python3
"""
Patch Open-LLM-VTuber's openai_tts engine for per-language voice selection.

Crow's companion is bilingual (EN/ES). Kokoro voices are language-specific —
an English voice (af_heart) phonemizes Spanish text with English G2P, so Spanish
replies sound badly mispronounced. OLVV's openai_tts uses one fixed `self.voice`
per call. This patch makes generate_audio detect the language of each text chunk
(OLVV synthesizes sentence-by-sentence) and pick the matching voice:
  - Spanish  -> COMPANION_VOICE_ES (default ef_dora)
  - English  -> the configured default voice (self.voice)

Idempotent. No new dependencies (heuristic detector).
"""

import sys

TTS_FILE = "/app/src/open_llm_vtuber/tts/openai_tts.py"

MARKER = "_crow_pick_voice"

# The two helper methods, inserted just before generate_audio.
METHODS = '''    # [crow-patch] per-language voice selection (bilingual EN/ES companion)
    def _crow_detect_es(self, text):
        """Lightweight EN-vs-ES detector. True if the chunk looks Spanish."""
        import re
        t = (text or "").lower()
        if not t.strip():
            return False
        if re.search(r"[\\u00f1\\u00bf\\u00a1]", t):  # n-tilde, inverted ? and !
            return True
        tokens = re.findall(r"[a-z\\u00e1\\u00e9\\u00ed\\u00f3\\u00fa\\u00fc\\u00f1]+", t)
        if not tokens:
            return False
        es_words = {
            "que","de","la","el","los","las","un","una","por","para","con","como","como",
            "qué","cómo","gracias","hola","sí","muy","más","pero","porque","cuando","donde",
            "quién","hacer","tienes","tengo","puedo","puedes","quiero","está","estás","estoy",
            "soy","eres","bien","ahora","aquí","algo","todo","nada","también","entonces","vamos",
            "buenos","días","noche","señor","señora","tu","su","mi","ella","nosotros","claro",
        }
        en_words = {
            "the","and","you","is","are","what","can","do","to","of","in","it","that","this",
            "for","on","with","your","my","have","not","be","will","me","we","they","i'm","let",
        }
        es = sum(1 for w in tokens if w in es_words)
        en = sum(1 for w in tokens if w in en_words)
        if re.search(r"[\\u00e1\\u00e9\\u00ed\\u00f3\\u00fa\\u00fc]", t):  # accented vowels lean ES
            es += 1
        return es > en

    def _crow_pick_voice(self, text):
        import os
        if self._crow_detect_es(text):
            return os.environ.get("COMPANION_VOICE_ES", "ef_dora")
        return self.voice

'''

OLD_VOICE_LINE = (
    '                    voice=self.voice,  # Voice name(s) expected by the '
    'compatible server (e.g., "af_sky+af_bella")'
)
NEW_VOICE_LINE = (
    "                    voice=self._crow_pick_voice(text),  # [crow-patch] "
    "per-language voice (EN default / ES ef_dora)"
)

INSERT_ANCHOR = "    def generate_audio(self, text, file_name_no_ext=None, speed=1.0):"


def main():
    try:
        with open(TTS_FILE, "r") as f:
            content = f.read()
    except FileNotFoundError:
        print(f"patch-tts-language-voice: {TTS_FILE} not found, skipping", file=sys.stderr)
        return

    if MARKER in content:
        print("patch-tts-language-voice: already patched")
        return

    if OLD_VOICE_LINE not in content:
        print(
            "patch-tts-language-voice: voice line not found (OLVV changed?), skipping",
            file=sys.stderr,
        )
        return
    if INSERT_ANCHOR not in content:
        print(
            "patch-tts-language-voice: generate_audio anchor not found, skipping",
            file=sys.stderr,
        )
        return

    content = content.replace(OLD_VOICE_LINE, NEW_VOICE_LINE, 1)
    content = content.replace(INSERT_ANCHOR, METHODS + INSERT_ANCHOR, 1)

    with open(TTS_FILE, "w") as f:
        f.write(content)
    print("patch-tts-language-voice: applied (EN/ES per-chunk voice selection)")


if __name__ == "__main__":
    main()
