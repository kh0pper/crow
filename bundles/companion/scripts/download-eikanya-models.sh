#!/bin/bash
#
# Download curated Live2D models from Eikanya/Live2d-model repository.
# Models are for personal use only (not commercial).
#
# These are Cubism 3 (.moc3) models from mobile games, downloaded via
# GitHub's API to avoid cloning the entire multi-GB repository.
#
# Usage: bash download-eikanya-models.sh [target_dir]
#   Default target: ./live2d-models (or set EIKANYA_MODELS_DIR env var)

set -e

TARGET_DIR="${1:-${EIKANYA_MODELS_DIR:-./live2d-models}}"
REPO="Eikanya/Live2d-model"
API="https://api.github.com/repos/${REPO}"

echo "=== Eikanya Live2D Model Downloader ==="
echo "Target: ${TARGET_DIR}"
echo ""

mkdir -p "${TARGET_DIR}"

# Model catalog: path_in_repo|local_name|display_name
MODELS=(
  "Live2D/Senko_Normals|senko|Senko (fox girl)"
  "碧蓝航线 Azue Lane/Azue Lane(JP)/xinnong_3|xinnong|Xinnong (Azur Lane)"
  "碧蓝航线 Azue Lane/Azue Lane(JP)/dafeng_3|dafeng|Dafeng (Azur Lane)"
  "碧蓝航线 Azue Lane/Azue Lane(JP)/aijier_2|aijier|Aijier (Azur Lane)"
  "碧蓝航线 Azue Lane/Azue Lane(JP)/shengluyisi_2|shengluyisi|Saint Louis (Azur Lane)"
  "碧蓝航线 Azue Lane/Azue Lane(JP)/biaoqiang_3|biaoqiang|Biaoqiang (Azur Lane)"
  "碧蓝航线 Azue Lane/Azue Lane(JP)/aersasi_3|aersasi|Alsace (Azur Lane)"
  "少女前线 girls Frontline/live2dnew/ak12_2402/normal|ak12|AK-12 (Girls Frontline)"
  "少女前线 girls Frontline/live2dnew/an94_3303/normal|an94|AN-94 (Girls Frontline)"
)

download_tree() {
  local repo_path="$1"
  local local_dir="$2"
  local display_name="$3"

  echo "Downloading: ${display_name}..."

  # URL-encode the path
  local encoded_path=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${repo_path}'))")

  # Get the tree recursively via GitHub API
  # First, get the tree SHA for this path
  local items
  items=$(curl -sL "${API}/contents/${encoded_path}" \
    -H "Accept: application/vnd.github.v3+json" 2>/dev/null)

  if echo "$items" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    :
  else
    echo "  ERROR: Failed to fetch ${repo_path}"
    return 1
  fi

  # Check if it's an array (directory) or object (file)
  local is_array
  is_array=$(echo "$items" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d,list) else 'no')" 2>/dev/null)

  if [ "$is_array" = "no" ]; then
    echo "  ERROR: Path is not a directory: ${repo_path}"
    return 1
  fi

  mkdir -p "${local_dir}"

  # Download files and recurse into subdirectories
  echo "$items" | python3 -c "
import sys, json
items = json.load(sys.stdin)
for item in items:
    print(f\"{item['type']}|{item['path']}|{item.get('download_url', '')}|{item['name']}\")
" | while IFS='|' read -r type path dl_url name; do
    if [ "$type" = "file" ] && [ -n "$dl_url" ]; then
      # Download file
      curl -sL "$dl_url" -o "${local_dir}/${name}"
    elif [ "$type" = "dir" ]; then
      # Recurse
      download_tree "$path" "${local_dir}/${name}" "${display_name}/${name}"
    fi
  done

  echo "  Done: ${local_dir}"
}

total=${#MODELS[@]}
count=0

for entry in "${MODELS[@]}"; do
  IFS='|' read -r repo_path local_name display_name <<< "$entry"
  count=$((count + 1))

  local_dir="${TARGET_DIR}/${local_name}"

  # Skip if already downloaded
  if [ -d "$local_dir" ] && ls "$local_dir"/*.moc3 >/dev/null 2>&1; then
    echo "[${count}/${total}] Already exists: ${display_name} — skipping"
    continue
  fi

  echo "[${count}/${total}] ${display_name}"
  download_tree "$repo_path" "$local_dir" "$display_name"
  echo ""

  # Rate limit courtesy
  sleep 1
done

echo ""
echo "=== Download complete ==="
echo "Models saved to: ${TARGET_DIR}"
ls -1d "${TARGET_DIR}"/*/ 2>/dev/null | while read -r d; do
  name=$(basename "$d")
  moc=$(ls "$d"/*.moc3 2>/dev/null | head -1)
  if [ -n "$moc" ]; then
    size=$(du -sh "$d" | cut -f1)
    echo "  ${name}: ${size}"
  fi
done
