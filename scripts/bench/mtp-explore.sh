#!/usr/bin/env bash
# MTP exploration harness — ISOLATED. mtp-test-8013 @ 127.0.0.1:8013. No jq.
# SAMP profiles (Unsloth Qwen3.6, verified 2026-05-16):
#   greedy = temp 0
#   scode  = thinking/precise-coding: temp 0.6 top_p 0.95 top_k 20 min_p 0
#   sgen   = thinking/general: temp 1.0 top_p 0.95 top_k 20 min_p 0 presence_penalty 1.5
set -uo pipefail
source /home/kh0pp/.crow/env/rocm.env
# BACKEND={rocm|vulkan} selects the toolbox image + device args (§1.0). The vulkan
# image tag is confirmed by the §1.B spike; override with VK_IMG if it differs.
BACKEND="${BACKEND:-rocm}"
ROCM_IMG="${ROCM_IMG:-kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3}"
VK_IMG="${VK_IMG:-kyuz0/amd-strix-halo-toolboxes:vulkan-radv-mtp}"
if [ "$BACKEND" = vulkan ]; then IMG="$VK_IMG"; else IMG="$ROCM_IMG"; fi
NAME="mtp-test-8013"; PORT="8013"
RES="/home/kh0pp/crow/scripts/bench/results"; mkdir -p "$RES"
# Vulkan (RADV) needs /dev/dri only; ROCm needs /dev/kfd + /dev/dri. Both backends get
# hf-cache (NVMe) at /models and the external library (NTFS, ro) at /models-ext.
if [ "$BACKEND" = vulkan ]; then DEVARGS=( --device=/dev/dri ); else DEVARGS=( --device=/dev/kfd --device=/dev/dri ); fi
DRARGS=( "${DEVARGS[@]}" --group-add "${VIDEO_GID}" --group-add "${RENDER_GID}"
  --env-file /home/kh0pp/.crow/env/rocm.env
  -v /home/kh0pp/llm/hf-cache:/models -v /mnt/external/llm-models:/models-ext:ro
  --ipc=host --shm-size=16g )
export PR_PROSE='You are a senior engineer. Explain, in about 220 words, how speculative decoding with multi-token prediction draft heads speeds up LLM inference, why the output remains mathematically identical to greedy decoding, and what the acceptance rate means. Be concrete and technical.'
export PR_CODE='Write a complete Python module implementing an LRU cache class with get/put O(1), a typed dataclass Config, full docstrings, type hints, and a pytest test suite with at least six test cases covering eviction, update, and edge cases. Output only code.'
pybody(){ ALIAS="$1" WHICH="$2" SAMP="${3:-greedy}" python3 - <<'PY'
import json,os
p=os.environ['PR_CODE'] if os.environ['WHICH']=='code' else os.environ['PR_PROSE']
s=os.environ.get('SAMP','greedy')
samp={'greedy':{"temperature":0},
 'scode':{"temperature":0.6,"top_p":0.95,"top_k":20,"min_p":0},
 'sgen':{"temperature":1.0,"top_p":0.95,"top_k":20,"min_p":0,"presence_penalty":1.5}}[s]
b={"model":os.environ['ALIAS'],"messages":[{"role":"user","content":p}],"max_tokens":256,"stream":False}
b.update(samp)
print(json.dumps(b))
PY
}
cmd="${1:-}"; shift || true
case "$cmd" in
  launch)
    MODEL="$1"; ALIAS="$2"; shift 2
    CTX="${CTX:-16384}"; FA="${FA:-on}"; NP="${NP:-1}"
    MMARG=(); [ -n "${MMPROJ:-}" ] && MMARG=( --mmproj "$MMPROJ" )
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" "${DRARGS[@]}" -p 127.0.0.1:${PORT}:8000 --entrypoint llama-server "$IMG" \
      -m "$MODEL" --alias "$ALIAS" --host 0.0.0.0 --port 8000 -ngl 999 -fit "${FIT:-off}" -fa "$FA" --no-mmap -c "$CTX" --parallel "$NP" --jinja "${MMARG[@]}" "$@" >/dev/null
    echo "launched $NAME ($ALIAS) backend=$BACKEND ctx=$CTX fa=$FA np=$NP mmproj=${MMPROJ:-none} img=$IMG flags: $*"
    t0=$(date +%s)
    for i in $(seq 1 "${READY_TRIES:-240}"); do
      if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
        r=$(curl -s -m 60 "http://127.0.0.1:${PORT}/v1/chat/completions" -H 'content-type: application/json' \
            -d "{\"model\":\"${ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"temperature\":0}" 2>/dev/null)
        echo "$r" | grep -q '"content"' && { echo "READY after $(( $(date +%s)-t0 ))s"; exit 0; }
      fi
      docker ps --format '{{.Names}}' | grep -q "^${NAME}\$" || { echo DIED; docker logs "$NAME" 2>&1|tail -25; exit 1; }
      sleep 5
    done
    echo TIMEOUT; docker logs "$NAME" 2>&1|tail -25; exit 1 ;;
  measure)  # $1=alias $2=label $3=prose|code $4=greedy|scode|sgen
    ALIAS="$1"; LABEL="$2"; WHICH="${3:-prose}"; SAMP="${4:-greedy}"
    LOG="$RES/mtp-${LABEL}-$(date -u +%Y%m%dT%H%M%SZ).log"
    echo "=== $LABEL ($ALIAS) prompt=$WHICH samp=$SAMP ===" | tee "$LOG"
    curl -s -m 120 "http://127.0.0.1:${PORT}/v1/chat/completions" -H 'content-type: application/json' \
      -d "{\"model\":\"${ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"warmup\"}],\"max_tokens\":16,\"temperature\":0}" >/dev/null
    BODY="$(pybody "$ALIAS" "$WHICH" "$SAMP")"
    for run in 1 2 3 4 5; do
      curl -s -m 240 "http://127.0.0.1:${PORT}/v1/chat/completions" -H 'content-type: application/json' -d "$BODY" \
        | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get('timings',{})))" | tee -a "$LOG"
    done
    grep '^{' "$LOG" | python3 -c "
import sys,json,statistics as st
ts=[json.loads(l) for l in sys.stdin if l.startswith('{') and l.strip()!='{}']
g=sorted(x['predicted_per_second'] for x in ts if x.get('predicted_per_second'))
pp=sorted(x['prompt_per_second'] for x in ts if x.get('prompt_per_second'))
dn=sum(x.get('draft_n',0) for x in ts); da=sum(x.get('draft_n_accepted',0) for x in ts)
print('runs=%d gen_tok/s median=%.2f min=%.2f max=%.2f  pp_tok/s median=%.1f%s'%(len(ts),st.median(g),g[0],g[-1],
  (st.median(pp) if pp else 0),
  '  accept=%.1f%%(%d/%d)'%(100*da/dn,da,dn) if dn else ''))
" | tee -a "$LOG"
    echo "saved: $LOG" ;;
  capture)  # $1=alias $2=which $3=outfile  (greedy, full reasoning+content)
    ALIAS="$1"; WHICH="$2"; OUT="$3"
    curl -s -m 240 "http://127.0.0.1:${PORT}/v1/chat/completions" -H 'content-type: application/json' \
      -d "$(pybody "$ALIAS" "$WHICH" greedy)" > "${OUT}.json"
    OUT="$OUT" python3 - <<'PY'
import json,os,sys
o=os.environ['OUT']; d=json.load(open(o+'.json')); ch=d.get('choices')
if not ch: print('ERR',json.dumps(d)[:200]); sys.exit(1)
m=ch[0]['message']; full=(m.get('reasoning_content') or '')+(m.get('content') or '')
open(o,'w').write(full); print('captured',len(full),'chars finish=',ch[0].get('finish_reason'))
PY
    ;;
  toolcall)
    ALIAS="$1"
    BODY=$(ALIAS="$ALIAS" python3 - <<'PY'
import json,os
print(json.dumps({"model":os.environ['ALIAS'],"temperature":0,"max_tokens":512,
"chat_template_kwargs":{"enable_thinking":False},
"messages":[{"role":"user","content":"What is the weather in Austin, Texas right now? Use the tool."}],
"tools":[{"type":"function","function":{"name":"get_weather","description":"Get current weather for a city",
"parameters":{"type":"object","properties":{"city":{"type":"string"},"units":{"type":"string","enum":["c","f"]}},"required":["city"]}}}],
"tool_choice":"auto"}))
PY
)
    curl -s -m 120 "http://127.0.0.1:${PORT}/v1/chat/completions" -H 'content-type: application/json' -d "$BODY" \
      | python3 -c "
import sys,json
d=json.load(sys.stdin); m=d.get('choices',[{}])[0].get('message',{}); tc=m.get('tool_calls')
print('tool_calls:',bool(tc))
if tc:
  f=tc[0]['function']; print('name:',f['name'],'args:',f['arguments'])
  try: json.loads(f['arguments']); print('valid_json: TRUE')
  except Exception as e: print('valid_json: FALSE',e)
else: print('finish:',d.get('choices',[{}])[0].get('finish_reason'),'content:',(m.get('content') or '')[:160])
" ;;
  vision)  # $1=alias $2=image-file  → base64 the image, ask for a description (§1.A vision gate)
    ALIAS="$1"; IMGF="$2"
    BODY=$(ALIAS="$ALIAS" IMGF="$IMGF" python3 - <<'PY'
import json,os,base64,mimetypes
f=os.environ['IMGF']; mt=mimetypes.guess_type(f)[0] or 'image/png'
url="data:%s;base64,%s"%(mt, base64.b64encode(open(f,'rb').read()).decode())
print(json.dumps({"model":os.environ['ALIAS'],"temperature":0,"max_tokens":300,
"chat_template_kwargs":{"enable_thinking":False},
"messages":[{"role":"user","content":[
  {"type":"text","text":"What does this image show? Read any text in it exactly."},
  {"type":"image_url","image_url":{"url":url}}]}]}))
PY
)
    curl -s -m 120 "http://127.0.0.1:${PORT}/v1/chat/completions" -H 'content-type: application/json' -d "$BODY" \
      | python3 -c "import sys,json
d=json.load(sys.stdin); ch=d.get('choices',[{}])
print(ch[0].get('message',{}).get('content') or ('ERR '+json.dumps(d)[:300]))" ;;
  logs) docker logs "$NAME" 2>&1 | grep -iE 'draft acceptance|statistics draft' | tail -8 ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo nothing ;;
  *) echo "usage: launch MODEL ALIAS [flags] | measure A L [prose|code] [greedy|scode|sgen] | capture | toolcall | vision A IMGFILE | logs | stop  (env: BACKEND CTX FA NP MMPROJ READY_TRIES)"; exit 2 ;;
esac
