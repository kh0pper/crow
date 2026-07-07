#!/usr/bin/env python3
"""Bench one llama-server config (H.2 35b leg / H.3 MTP sweep).

usage: bench-completion.py LABEL BASE_URL MODE RUNS [SEED_BASE]
  BASE_URL like http://100.118.41.122:8003 (no path)
  MODE:
    prefill  — 6000 random words (~32.6k tok), n_predict 8, raw /completion
               (same protocol as the H.1/H.2 copilot+solo legs, comparable)
    gen      — 200 random words, n_predict 128, raw /completion
    critique — critique-prompt.txt (real diffs, ~16.5k tok), 512 tokens via
               /v1/chat/completions (chat template — how critics actually
               call it; raw completion EOS-stops instantly on instruct
               models), temperature 0, reports MTP acceptance from timings
"""
import json, os, random, sys, time, urllib.request

WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
         "mike november oscar papa quebec romeo sierra tango uniform victor whiskey "
         "xray yankee zulu").split()
KIT = os.path.dirname(os.path.abspath(__file__))


def one_run(base_url, mode, prompt, n_predict):
    if mode == "critique":
        url = base_url.rstrip("/") + "/v1/chat/completions"
        payload = {
            "model": "bench",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": n_predict,
            "temperature": 0,
            "cache_prompt": False,
        }
    else:
        url = base_url.rstrip("/") + "/completion"
        payload = {
            "prompt": prompt,
            "n_predict": n_predict,
            "cache_prompt": False,
            "temperature": 0,
        }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=1800) as r:
        out = json.load(r)
    wall = time.time() - t0
    t = out.get("timings", {})
    res = {
        "prompt_n": t.get("prompt_n"),
        "pp_per_sec": round(t.get("prompt_per_second") or 0, 1),
        "gen_n": t.get("predicted_n"),
        "gen_per_sec": round(t.get("predicted_per_second") or 0, 1),
        "wall_s": round(wall, 2),
    }
    if t.get("draft_n"):
        res["draft_n"] = t["draft_n"]
        res["draft_acc"] = t.get("draft_n_accepted")
        res["acc_rate"] = round((t.get("draft_n_accepted") or 0) / t["draft_n"], 3)
    return res


def make_prompt(mode, seed):
    if mode == "critique":
        return open(os.path.join(KIT, "critique-prompt.txt")).read()
    words = 6000 if mode == "prefill" else 200
    rng = random.Random(seed)
    text = " ".join(rng.choice(WORDS) + str(rng.randint(0, 9999)) for _ in range(words))
    return "Summarize the following log tokens in one word.\n" + text


if __name__ == "__main__":
    label, url, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    seed_base = int(sys.argv[5]) if len(sys.argv) > 5 else 1000
    npred = {"prefill": 8, "gen": 128, "critique": 512}[mode]
    results = []
    for i in range(n):
        r = one_run(url, mode, make_prompt(mode, seed_base + i), npred)
        results.append(r)
        print(f"[{label} {mode} run {i+1}] {r}", flush=True)
    key = "pp_per_sec" if mode == "prefill" else "gen_per_sec"
    vals = sorted(x[key] for x in results)
    line = f"[{label}] MEDIAN {mode}: {vals[len(vals)//2]} tok/s over {n} runs"
    accs = [x["acc_rate"] for x in results if "acc_rate" in x]
    if accs:
        line += f" | acceptance median {sorted(accs)[len(accs)//2]}"
    print(line, flush=True)
