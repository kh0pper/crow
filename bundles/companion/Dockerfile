FROM python:3.10-slim

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency management
RUN pip install --no-cache-dir uv

# Clone Open-LLM-VTuber at a pinned SHA.
# Rationale: the Companion bundle's scripts/generate-config.py emits TTS
# blocks whose shape depends on OLVV's conf.yaml schema. Pinning keeps us
# on a known-good revision that supports edge_tts, openai_tts, azure_tts,
# piper_tts, and elevenlabs_tts providers. Bump deliberately, not by drift.
ARG OLVV_SHA=19b58b1f6c01e082289fce089392997b9d14fbc4
RUN git clone --recursive https://github.com/Open-LLM-VTuber/Open-LLM-VTuber.git /app \
    && cd /app \
    && git checkout ${OLVV_SHA} \
    && git submodule update --init --recursive

# Install Python dependencies + mcp-proxy for Crow MCP bridge
RUN uv sync --no-dev && uv pip install pyyaml mcp-proxy

# Copy config generator, notify bridge, bg refresh, window manager, and entrypoint
COPY scripts/generate-config.py /app/scripts/generate-config.py
COPY scripts/notify-bridge.py /app/scripts/notify-bridge.py
COPY scripts/inject-theme.sh /app/scripts/inject-theme.sh
COPY scripts/inject-bg-refresh.sh /app/scripts/inject-bg-refresh.sh
COPY scripts/inject-wm.sh /app/scripts/inject-wm.sh
COPY scripts/crow-wm.js /app/scripts/crow-wm.js
COPY scripts/patch-tool-calling.py /app/scripts/patch-tool-calling.py
COPY scripts/patch-auto-group.py /app/scripts/patch-auto-group.py
COPY scripts/patch-tutor-event.py /app/scripts/patch-tutor-event.py
COPY scripts/crow-webrtc.js /app/scripts/crow-webrtc.js
COPY scripts/inject-webrtc.sh /app/scripts/inject-webrtc.sh
COPY scripts/crow-voice-panel.js /app/scripts/crow-voice-panel.js
COPY scripts/inject-voice-panel.sh /app/scripts/inject-voice-panel.sh
COPY scripts/crow-face-tracking.js /app/scripts/crow-face-tracking.js
COPY scripts/inject-face-tracking.sh /app/scripts/inject-face-tracking.sh
COPY scripts/inject-call-enhancements.sh /app/scripts/inject-call-enhancements.sh
COPY scripts/entrypoint.sh /app/entrypoint.sh
COPY scripts/download-models.sh /app/scripts/download-models.sh
RUN chmod +x /app/entrypoint.sh /app/scripts/download-models.sh /app/scripts/inject-theme.sh /app/scripts/inject-bg-refresh.sh /app/scripts/inject-wm.sh /app/scripts/inject-webrtc.sh /app/scripts/inject-voice-panel.sh /app/scripts/inject-face-tracking.sh /app/scripts/inject-call-enhancements.sh

EXPOSE 12393

ENTRYPOINT ["/app/entrypoint.sh"]
