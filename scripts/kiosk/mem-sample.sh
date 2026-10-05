#!/bin/bash
# Chromium memory = sum of Pss over all chromium processes (smaps_rollup).
# One CSV row per run (a systemd user timer runs it every 60 s as the kiosk user):
#   iso_time,chromium_pss_kb,chromium_procs,agent_pss_kb,mem_available_kb,swap_used_kb
# Output: ${CROW_KIOSK_MEM_CSV:-$HOME/.local/state/crow-kiosk/mem.csv}; trimmed to the last 20160 rows (14 days).
set -euo pipefail
OUT="${CROW_KIOSK_MEM_CSV:-$HOME/.local/state/crow-kiosk/mem.csv}"
PROC="${CROW_KIOSK_PROC:-/proc}"
mkdir -p "$(dirname "$OUT")"

pss_of() {  # pss_of <comm regex> -> "total_kb count"
  local re="$1" total=0 n=0 pid comm kb
  for d in "$PROC"/[0-9]*; do
    pid="${d##*/}"
    comm="$(cat "$d/comm" 2>/dev/null)" || continue
    [[ "$comm" =~ $re ]] || continue
    kb="$(awk '/^Pss:/ {print $2; exit}' "$d/smaps_rollup" 2>/dev/null)" || continue
    [ -n "$kb" ] || continue
    total=$((total + kb)); n=$((n + 1)); : "$pid"
  done
  echo "$total $n"
}

read -r chrome_kb chrome_n < <(pss_of '^(chromium|chrome)')
read -r agent_kb _ < <(pss_of '^crow-kiosk-agen')
avail_kb="$(awk '/^MemAvailable:/ {print $2}' "$PROC/meminfo")"
swap_used_kb="$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {print t-f}' "$PROC/meminfo")"
[ -s "$OUT" ] || echo "time,chromium_pss_kb,chromium_procs,agent_pss_kb,mem_available_kb,swap_used_kb" > "$OUT"
echo "$(date -Iseconds),$chrome_kb,$chrome_n,$agent_kb,$avail_kb,$swap_used_kb" >> "$OUT"
if [ "$(wc -l < "$OUT")" -gt 20161 ]; then
  { head -1 "$OUT"; tail -n 20160 "$OUT"; } > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
fi
