#!/bin/bash
# Download free Live2D sample models if not already present
# Models are cached in the companion-models Docker volume

MODELS_DIR="/app/live2d-models"

download_if_missing() {
    local name="$1"
    local url="$2"
    local dest="$MODELS_DIR/$name"

    if [ -f "$dest/runtime/"*.model3.json ] 2>/dev/null; then
        echo "  $name: already downloaded"
        return 0
    fi

    echo "  $name: downloading from $url..."
    local tmpfile="/tmp/${name}.zip"
    if curl -sL "$url" -o "$tmpfile" 2>/dev/null; then
        mkdir -p "$dest"
        unzip -qo "$tmpfile" -d "$dest" 2>/dev/null || true
        rm -f "$tmpfile"
        echo "  $name: done"
    else
        echo "  $name: download failed (will use fallback avatar)"
    fi
}

echo "Checking Live2D models..."
echo "  mao_pro: bundled with Open-LLM-VTuber"
echo "  shizuku: loaded from CDN at runtime"

# Note: Live2D sample models require manual download from
# https://www.live2d.com/en/learn/sample/ due to license agreement.
# For automated deployment, the bundled mao_pro and CDN shizuku
# models are available without additional downloads.

echo "Available avatars: mao_pro (default), shizuku (CDN)"
echo "To add more avatars, download Live2D sample models from:"
echo "  https://www.live2d.com/en/learn/sample/"
echo "and place them in the live2d-models/ directory."
