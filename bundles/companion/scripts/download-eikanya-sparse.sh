#!/bin/bash
#
# Download curated high-quality Live2D models from Eikanya/Live2d-model.
# Uses git sparse-checkout for fast selective downloads.
# Models are for personal use only (not commercial).
#
# Selection criteria: 50+ motions with named motion groups (Azur Lane JP)
# plus Senko from the Live2D directory.
#
# Usage: bash download-eikanya-sparse.sh [target_dir]

set -e

TARGET_DIR="${1:-${EIKANYA_MODELS_DIR:-./live2d-models}}"
REPO_URL="https://github.com/Eikanya/Live2d-model.git"
CLONE_DIR="/tmp/eikanya-live2d-sparse"

echo "=== Eikanya Live2D Model Downloader (Premium Collection) ==="
echo "Target: ${TARGET_DIR}"
echo ""

mkdir -p "${TARGET_DIR}"
rm -rf "$CLONE_DIR"

# All models to download: repo_path -> local_name
# Azur Lane models with 50+ motions (named motion groups)
AZUR_LANE_MODELS=(
  "gaoxiong_7"           # Takao — 111 motions
  "feiteliedadi_4"       # Friedrich der Große — 101 motions
  "zhangwu_2"            # — 86 motions
  "aersasi_3"            # Alsace — 82 motions
  "xinzexi_5"            # New Jersey — 76 motions
  "xinnong_5"            # Xinnong — 76 motions (upgrade from _3)
  "jinjiang_2"           # — 74 motions
  "jinshi_2"             # — 66 motions
  "zhenzhuhao_2"         # — 64 motions
  "yuekechengII_3"       # — 63 motions
  "suweiaitongmeng_3"    # — 63 motions
  "liekexingdunII_2"     # — 61 motions
  "ankeleiqi_3"          # — 61 motions
  "nabulesi_2"           # — 60 motions
  "meikelunbao_2"        # — 60 motions
  "xingdengbao_3"        # — 55 motions
  "ougen_8"              # Eugen — 55 motions
  "kebensi_2"            # — 54 motions
  "xiafei_4"             # — 52 motions
  "tianlangxing_5"       # Sirius — 51 motions
  "naximofu_2"           # — 51 motions
  "guanghui_7"           # Illustrious — 51 motions
  "baifeng_2"            # — 51 motions
  "siwanshi_3"           # — 50 motions
  "dafeng_7"             # Taihou — 49 motions (upgrade from _3)
  "shengluyisi_5"        # Saint Louis — 49 motions (upgrade from _2)
  "qiye_10"              # Enterprise — 49 motions
)

# Build sparse-checkout paths
SPARSE_PATHS="Live2D/Senko_Normals"
for model in "${AZUR_LANE_MODELS[@]}"; do
  SPARSE_PATHS="${SPARSE_PATHS} \"碧蓝航线 Azue Lane/Azue Lane(JP)/${model}\""
done

echo "Setting up sparse checkout for ${#AZUR_LANE_MODELS[@]} Azur Lane models + Senko..."
git clone --filter=blob:none --no-checkout --depth=1 "$REPO_URL" "$CLONE_DIR" 2>&1 | tail -3
cd "$CLONE_DIR"

git sparse-checkout init --cone

# Build the sparse-checkout set command
eval git sparse-checkout set \
  "Live2D/Senko_Normals" \
  $(for m in "${AZUR_LANE_MODELS[@]}"; do echo "\"碧蓝航线 Azue Lane/Azue Lane(JP)/${m}\""; done)

echo "Checking out selected models..."
git checkout 2>&1 | tail -3

echo ""
echo "Copying models to ${TARGET_DIR}..."

# Copy Senko
if [ -d "Live2D/Senko_Normals" ]; then
  rm -rf "${TARGET_DIR}/senko"
  cp -r "Live2D/Senko_Normals" "${TARGET_DIR}/senko"
  echo "  senko: $(du -sh "${TARGET_DIR}/senko" | cut -f1)"
fi

# Copy Azur Lane models (strip version suffix for local name)
for model in "${AZUR_LANE_MODELS[@]}"; do
  src="碧蓝航线 Azue Lane/Azue Lane(JP)/${model}"
  # Local name: strip trailing _N version number
  local_name=$(echo "$model" | sed 's/_[0-9]*$//')

  if [ -d "$src" ]; then
    rm -rf "${TARGET_DIR}/${local_name}"
    cp -r "$src" "${TARGET_DIR}/${local_name}"
    echo "  ${local_name}: $(du -sh "${TARGET_DIR}/${local_name}" | cut -f1) (from ${model})"
  else
    echo "  WARNING: ${model} not found in checkout"
  fi
done

# Remove old lower-quality models that were upgraded
for old in aijier biaoqiang ak12 an94; do
  if [ -d "${TARGET_DIR}/${old}" ]; then
    rm -rf "${TARGET_DIR}/${old}"
    echo "  Removed old model: ${old}"
  fi
done

# Cleanup
echo ""
echo "Cleaning up sparse checkout..."
cd /
rm -rf "$CLONE_DIR"

echo ""
echo "=== Download complete ==="
echo ""
count=0
total_size=0
for d in "${TARGET_DIR}"/*/; do
  name=$(basename "$d")
  size=$(du -sh "$d" | cut -f1)
  moc=$(ls "$d"*.moc3 2>/dev/null | wc -l)
  motions=$(ls "$d/motions/"*.motion3.json 2>/dev/null | wc -l)
  if [ "$moc" -gt 0 ]; then
    echo "  ${name}: ${size}, ${motions} motions"
    count=$((count + 1))
  fi
done
echo ""
echo "${count} models, $(du -sh "${TARGET_DIR}" | cut -f1) total"
