#!/usr/bin/env bash
# H.2 35b leg (KV q8_0 vs f16: KLD-own-base quality + serve perf) + H.3 MTP
# draft-depth sweep (off/2/3/4, acceptance from timings) — ONE overnight
# bots-down window. Measures everything, then ALWAYS restores the prod
# compose snapshot (f16/MTP2) — no unattended config ship; morning review
# decides. Detached deadman (deadman.sh, own systemd unit) is the
# out-of-process backstop.
#
# REBUILT 2026-07-08 after the VOID run + prod-down incident
# (results-20260708-0230/INCIDENT.md). Fixes:
#   1. compose env: $D35/.env now exists (addon dir is self-sufficient);
#      preflight FAILS if the rendered compose has an empty volume spec.
#   2. images: vulkan-radv-mtp everywhere — kyuz0 rocm-7.2.1 predates
#      draft-mtp and cannot load the Qwen3.6 MTP gguf.
#   3. deadman: launched via systemd-run as its OWN unit — setsid/nohup
#      children die with the runner service's cgroup (proven 2026-07-08).
#   4. restore: compose up from each addon's own dir with retry (containers
#      can be REMOVED, `docker start` can't recreate); loud ntfy on failure.
#   5. in-window self-test: 2-chunk throwaway ppl load-check + abort-early
#      if the f16-mtp2 baseline serve fails (restore immediately, no flail).
#   6. KLD base .dat written to a temp name, mv'd into place only on
#      success — a failed base run can't poison the reuse path.
set -uo pipefail
IP=100.118.41.122
KIT=/home/kh0pp/crow/scripts/bench/h2-35b-overnight
D35=/home/kh0pp/crow-addons/llamacpp-vulkan-qwen36-35b-a3b
DCOP=/home/kh0pp/crow-addons/llamacpp-vulkan-qwen36-27b-copilot
C35=llamacpp-vulkan-qwen36-35b-a3b
QDIR=/home/kh0pp/crow/scripts/bench/results/quality
IMG="kyuz0/amd-strix-halo-toolboxes:vulkan-radv-mtp"
M=/models/qwen36-35b-a3b-mtp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf
TEXT=/work/wiki.test.raw
BASEDAT=/work/35bq5-f16kv.dat
RES="$KIT/results-$(date +%Y%m%d-%H%M)"
mkdir -p "$RES"
exec > >(tee -a "$RES/run.log") 2>&1

source /home/kh0pp/.crow/env/rocm.env
DRARGS=( --device=/dev/kfd --device=/dev/dri --group-add "${VIDEO_GID}" --group-add "${RENDER_GID}"
  --env-file /home/kh0pp/.crow/env/rocm.env
  -v /home/kh0pp/llm/hf-cache:/models -v "$QDIR":/work --ipc=host --shm-size=16g )

log(){ echo "$(date -Is) $*"; }
ok(){ curl -s -m 5 "http://$IP:$1/health" | grep -q '"ok"'; }
wait_health(){ local port=$1 tries=$2; for i in $(seq 1 "$tries"); do ok "$port" && return 0; sleep 5; done; return 1; }
# ntfy creds read at runtime from pi settings — NEVER hardcode (repo is public)
ntfy(){ local cfg tok url topic
  cfg=$(python3 -c "import json;n=json.load(open('/home/kh0pp/.pi/agent/settings.json')).get('notify',{});print(n.get('token',''),n.get('url',''),n.get('topic',''))" 2>/dev/null) || return 0
  read -r tok url topic <<< "$cfg"
  [ -n "$tok" ] && curl -s -m 10 -H "Authorization: Bearer $tok" \
    -H "Title: $1" -d "$2" "$url/$topic" >/dev/null 2>&1 || true; }
ppl(){ docker run --rm "${DRARGS[@]}" --entrypoint llama-perplexity "$IMG" "$@"; }
kv_lines(){ docker logs "$C35" 2>&1 | grep -iE "KV buffer size" | tail -2; }
bench(){ python3 "$KIT/bench-completion.py" "$1" "http://$IP:8003" "$2" "${3:-3}"; }

serve(){ # serve COMPOSE-FILE LABEL -> 0 on healthy
  cp "$KIT/$1" "$D35/docker-compose.yml"
  (cd "$D35" && docker compose up -d)
  if wait_health 8003 120; then log "serving $2"; kv_lines; return 0; fi
  log "WARN: $2 NEVER became healthy — container log tail:"
  docker logs "$C35" 2>&1 | tail -15
  return 1
}
down(){ (cd "$D35" && docker compose down) >/dev/null 2>&1 || true; }

restore_prod(){
  log "restoring prod (35b snapshot compose + copilot, compose-up from own dirs)"
  down
  cp "$KIT/compose-prod-snapshot.yml" "$D35/docker-compose.yml"
  for attempt in 1 2; do
    (cd "$D35" && docker compose up -d) && break
    log "WARN: 35b compose up failed (attempt $attempt)"; sleep 5
  done
  for attempt in 1 2; do
    (cd "$DCOP" && docker compose up -d) && break
    log "WARN: copilot compose up failed (attempt $attempt)"; sleep 5
  done
  wait_health 8003 90 && log "35b healthy" || log "ERROR: 35b NOT healthy"
  wait_health 8010 90 && log "copilot healthy" || log "ERROR: copilot NOT healthy"
  STATE="8003=$(ok 8003 && echo ok || echo DOWN) 8010=$(ok 8010 && echo ok || echo DOWN)"
  # disarm the deadman only if prod is actually back; otherwise leave the backstop armed
  if ok 8003 && ok 8010; then
    systemctl --user stop h2-deadman.service >/dev/null 2>&1 || true
    ntfy "H.2/H.3 overnight window finished" "prod: $STATE — results in $RES"
  else
    ntfy "H.2/H.3 RESTORE FAILED — PROD DOWN" "prod: $STATE — deadman still armed; results in $RES"
  fi
}

abort_window(){ log "ABORT: $1"; ntfy "H.2/H.3 window ABORTED" "$1"; exit 1; } # EXIT trap restores

# ---------- preflight (prod still up; nothing touched yet) ----------
log "=== H.2 35b + H.3 MTP overnight window: preflight ==="
[ -f "/home/kh0pp/llm/hf-cache/qwen36-35b-a3b-mtp/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf" ] || { log "FATAL: gguf missing"; exit 1; }
[ -f "$QDIR/wiki.test.raw" ] || { log "FATAL: wiki.test.raw missing"; exit 1; }
FREE_G=$(df --output=avail -BG /home/kh0pp/crow | tail -1 | tr -dc 0-9)
[ "$FREE_G" -ge 20 ] || { log "FATAL: <20G free ($FREE_G G)"; exit 1; }
docker image inspect "$IMG" >/dev/null 2>&1 || { log "FATAL: image $IMG not present"; exit 1; }
[ -f "$D35/.env" ] || { log "FATAL: $D35/.env missing — compose vars would be empty (2026-07-08 incident)"; exit 1; }
# every variant is rendered through $D35 — assert the env actually resolves
RENDERED=$( (cd "$D35" && docker compose config 2>&1) ) || { log "FATAL: compose config failed: $RENDERED"; exit 1; }
echo "$RENDERED" | grep -qE "^\s+source:\s*/" || { log "FATAL: compose volume source empty — .env not applied"; exit 1; }
for f in compose-f16-mtp0.yml compose-f16-mtp2.yml compose-f16-mtp3.yml compose-f16-mtp4.yml compose-q8-mtp2.yml; do
  grep -q "$IMG" "$KIT/$f" || { log "FATAL: $f not on $IMG"; exit 1; }
done
command -v systemd-run >/dev/null || { log "FATAL: systemd-run missing (deadman)"; exit 1; }
ok 8003 || { log "FATAL: 35b not healthy at window start — refusing to touch a degraded prod"; exit 1; }
ok 8010 || { log "FATAL: copilot not healthy at window start"; exit 1; }
cp "$D35/docker-compose.yml" "$KIT/compose-prod-snapshot.yml"
grep -q "$IMG" "$KIT/compose-prod-snapshot.yml" || { log "FATAL: prod compose not on $IMG — snapshot would restore a broken config"; exit 1; }
log "preflight OK — prod compose snapshotted"

trap restore_prod EXIT
systemctl --user stop h2-deadman.service >/dev/null 2>&1 || true
systemd-run --user --collect --unit=h2-deadman "$KIT/deadman.sh" 14400 \
  || { trap - EXIT; log "FATAL: could not arm deadman — window not opened"; exit 1; }
log "deadman armed (14400s, own systemd unit h2-deadman)"
ntfy "H.2/H.3 overnight window START" "bots down; deadman 4h armed"

log "stopping standard pair (by NAME)"
docker stop "$C35" llamacpp-vulkan-qwen36-27b-copilot

# ---------- phase 0: in-window self-test (cheap, abort-early) ----------
log "=== 0/4 self-test: 2-chunk ppl load-check on $IMG ==="
ppl -m "$M" -f "$TEXT" -c 512 --chunks 2 -ngl 999 -fa on --no-mmap \
  --kl-divergence-base /work/.h2-selftest-throwaway.dat 2>&1 | tail -3 \
  || true
[ -f "$QDIR/.h2-selftest-throwaway.dat" ] || abort_window "self-test: llama-perplexity could not produce a base dat on $IMG (gguf load failure?)"
rm -f "$QDIR/.h2-selftest-throwaway.dat"
log "self-test OK — image loads the gguf"

# ---------- phase 1: quality (llama-perplexity, GPU exclusive) ----------
if [ ! -f "$QDIR/35bq5-f16kv.dat" ]; then
  log "=== 1/4 KLD base f16-KV ctx512x48 ==="
  ppl -m "$M" -f "$TEXT" -c 512 --chunks 48 -ngl 999 -fa on --no-mmap \
    --kl-divergence-base /work/35bq5-f16kv.dat.tmp 2>&1 | tee "$RES/kldbase-35bq5-f16kv.log" | tail -4
  if [ -f "$QDIR/35bq5-f16kv.dat.tmp" ]; then
    mv "$QDIR/35bq5-f16kv.dat.tmp" "$QDIR/35bq5-f16kv.dat"
  else
    abort_window "KLD base run produced no .dat — no point continuing"
  fi
else
  log "=== 1/4 KLD base exists — reusing $QDIR/35bq5-f16kv.dat ==="
fi
log "=== 2/4 KLD q8_0-KV vs base ==="
ppl -m "$M" -f "$TEXT" -c 512 --chunks 48 -ngl 999 -fa on --no-mmap \
  -ctk q8_0 -ctv q8_0 \
  --kl-divergence --kl-divergence-base "$BASEDAT" 2>&1 | tee "$RES/kld-35bq5-q8kv.log" | tail -25
log "=== 3/4 PPL f16-KV ctx4096x40 ==="
ppl -m "$M" -f "$TEXT" -c 4096 --chunks 40 -ngl 999 -fa on --no-mmap \
  2>&1 | tee "$RES/ppl-35bq5-f16kv-c4096.log" | grep -iE "Final estimate" | tail -2
log "=== 4/4 PPL q8_0-KV ctx4096x40 ==="
ppl -m "$M" -f "$TEXT" -c 4096 --chunks 40 -ngl 999 -fa on --no-mmap \
  -ctk q8_0 -ctv q8_0 \
  2>&1 | tee "$RES/ppl-35bq5-q8kv-c4096.log" | grep -iE "Final estimate" | tail -2

# ---------- phase 2: serve perf (KV A/B) + H.3 MTP sweep ----------
log "--- f16 / MTP2 (prod baseline) ---"
if serve compose-f16-mtp2.yml f16-mtp2; then
  bench f16-mtp2 prefill; bench f16-mtp2 gen; bench f16-mtp2 critique
else
  down; abort_window "baseline f16-mtp2 did not serve — variants would be meaningless"
fi; down

log "--- f16 / MTP off ---"
if serve compose-f16-mtp0.yml f16-mtp0; then
  bench f16-mtp0 gen; bench f16-mtp0 critique
fi; down

log "--- f16 / MTP3 ---"
if serve compose-f16-mtp3.yml f16-mtp3; then
  bench f16-mtp3 critique
fi; down

log "--- f16 / MTP4 ---"
if serve compose-f16-mtp4.yml f16-mtp4; then
  bench f16-mtp4 critique
fi; down

log "--- q8_0 KV / MTP2 (H.2 A/B side B) ---"
if serve compose-q8-mtp2.yml q8-mtp2; then
  bench q8-mtp2 prefill; bench q8-mtp2 gen; bench q8-mtp2 critique
else
  log "NOTE: q8 KV + MTP may be incompatible — see container log above"
fi; down

# ---------- summary ----------
{
  echo "# H.2 35b + H.3 MTP overnight results ($(date -Is))"
  echo; echo "## Quality (KLD own-base, PPL@4096)"
  grep -hiE "mean +KLD|median +KLD|same top|Maximum KLD|99.9%" "$RES"/kld-35bq5-q8kv.log 2>/dev/null || true
  grep -hiE "Final estimate" "$RES"/ppl-35bq5-*.log 2>/dev/null || true
  echo; echo "## Serve medians + KV sizes + acceptance"
  grep -hE "MEDIAN|KV buffer size" "$RES/run.log" || true
} > "$RES/RESULTS.md"
log "=== window done — RESULTS.md written ==="
# EXIT trap restores prod
