# Grackle decommission D3–D5: implementation plan and runbook

> **For agentic workers:** Task 1 (the importer) is code. Use superpowers:subagent-driven-development or superpowers:executing-plans with TDD. Every window after it (W0–W6) is an **operator runbook**: run it attended, step by step, ticking the checkboxes (`- [ ]`). Do not start any window without its CROW-SCHEDULE row and, where marked, its deadman armed and confirmed.

**Goal:** grackle's Crow data lives in crow main and its services run on crow. The blog is public through crow's Funnel, grackle is revoked everywhere and off the tailnet, and its disk is wiped once Kevin gives the OK.

**Spec:** `docs/superpowers/specs/2026-10-02-grackle-decommission-d3-d5-design.md`. Read it in full. Section numbers (§) below refer to it.

**Inputs:** Gitea `crow-engineering` `backlog/2026-09-22-grackle-decommission-inventory.md` and `backlog/2026-09-24-grackle-d3-data-migration-map.md` @4e96f46.

## Global constraints

- **Order:** W0 → W1 → W2 → W3 → W4a–g → W5 → (7-day soak) → W6. W1 and W2 may run in either order, and W1 may run before W0.
- **W3 gate:** all of the following hold.
  - A8 (the proxy.js:607 revoke fix) is merged and deployed on crow and black-swan.
  - Task 1 is merged with CI green.
  - W0 and W2 are done.
  - Kevin is present and has authorized sudo for the window.
- **Before each window:**
  1. Read `~/CROW-SCHEDULE.md`.
  2. Add the window's row (the template is under each window).
  3. **Clear the row** afterwards by moving it to Done with the outcome. The last column is a **condition**, never a status (schedule rule 3a).
- **Deadmen:**
  - Each is a root transient timer: `sudo systemd-run --on-active=<cap> --unit=<name> /bin/sh <script>`.
  - Arm it **before** the first degrading step, and confirm it with `systemctl list-timers --all | grep <name>`.
  - Disarm it only after verification passes: `sudo systemctl stop <name>.timer`.
  - Every deadman script is idempotent and checks health first.
  - It notifies on two channels: ntfy and email via `~/lab-maintenance/scripts/lib/alerts.sh` on crow.
  - Kit dir (outside the repo): `~/grackle-decom/` on crow, and `~/grackle-decom/` on grackle.
- **Secrets:** never echo a secret value, and never put one in this repo or in Gitea docs. **Every credential copy needs Kevin's named approval** (AskUserQuestion naming each file).
- **Repo work:** follow CLAUDE.md. Work in a worktree, commit with positional paths, run `npm test -- tests/<file>.test.js` (never raw `node --test`), and confirm check-runs before merging.
- **Never `git checkout` in `~/crow`.**

---

## Task 1: build `scripts/ops/grackle-d3-import.mjs` (code, TDD)

**Files:**
- Create: `scripts/ops/grackle-d3-import.mjs`
- Create: `tests/grackle-d3-import.test.js`
- Create: `tests/fixtures/grackle-d3/` (builder helpers only; the fixture DBs are generated in the test from `scripts/init-db.js`, so no binary fixtures)

**Interface (spec §4.1):**
```
node scripts/ops/grackle-d3-import.mjs \
  --source <grackle-backup.db> --target <crow.db> \
  --mode plan|rehearse|apply|emit-only \
  --report <report.json> [--extract <grackle-d3-extract.db>] \
  [--expect-sha <sha256-of-source>] [--backup-ok <cold-backup-path>] \
  [--peer-max-memory-id <name>=<n> ...] [--import-media] [--import-data-dashboard]
```

**Rules pinned by tests:**
- **Source handling:** opened `readonly`. The test checks that the source's mtime and sha256 are unchanged after every mode.
- **`plan`:** writes no file except the report.
- **`rehearse`:** copies the target to `os.tmpdir()` and applies to the copy, never to `--target`.
- **`apply` refuses** (non-zero exit, nothing written) when any of the following holds:
  - `systemctl is-active crow-gateway` prints `active` (inject the probe as a seam);
  - another process holds the target (seam over `lsof -t`);
  - a `user_version` mismatch, or either version ≠ `SCHEMA_GENERATION`;
  - the sha differs from `--expect-sha`;
  - `--backup-ok` is missing or fails `integrity_check`.
- **Column handling:** columns come from the intersection of source and target `table_info`, never `SELECT *`. The test uses a source whose column order differs, for example `chat_messages`, and a source-only column (`research_sources.s3_key`). It asserts that the value lands in the extract and that the report lists it.
- **memories:**
  - Rows whose content exactly matches an existing crow row are skipped.
  - Colliding ids get fresh ids.
  - `memory_embeddings_blob` follows its remapped parent id.
  - FTS counts match the row counts after the run.
- **project_spaces:** the source row whose slug and workspace path equal a target row is merged, not inserted (the grackle 6 = crow 6 case). Child rows are remapped to the target id.
- **ramble_cells / ramble_wallet / ramble_credits / ramble_nest_claims:** insert-or-ignore on the natural key, so a target row is never changed. The report has `wallet_balance_before`/`after` per kind. The test asserts `after - before` = the sum of the inserted rows.
- **pi_bot_defs:** inserted with `enabled = 0`, whatever the source value.
- **Tables the target lacks** (media_*, data_case_studies/sections, pir_requests, capstone_*, pipeline_runs, tax_*, crowclaw_*) go to the extract, never `CREATE`d in the target. media and data-dashboard are imported only with `--import-media` or `--import-data-dashboard`, **and only if the table already exists** in the target (created by the bundle). Otherwise the tool refuses with a clear message.
- **Skipped tables** (notifications, oauth_*, mcp_sessions, sync_conflicts, audit_log, cross_host_calls, and the already-synced contacts, messages, crow_context and providers) are listed in the report with their counts.
- **Phase A** is one better-sqlite3 transaction. The test injects a throw after half the tables and asserts the target is byte-identical in its row counts.
- **Phase B** queues synced rows via `emitOrQueue(null, db, table, "insert", row)` from `servers/shared/sync-emit.js`. The tables are memories, research_notes, glasses_note_sessions, ramble_cells and ramble_wallet. Phase B records `(table, key)` in the report.
  - Memory emits are skipped, with the report reason `peer-id-overlap`, if any `--peer-max-memory-id` value is ≥ the lowest remapped id.
  - The test uses `_setEligibilityForTest` and asserts the `sync_outbox` rows, not a live peer.
- **`emit-only`:** re-queues from the report and is idempotent. Running it twice gives no duplicate outbox rows for the same `(table, key, lamport)`.
- **Output:** a JSON report whose top-level keys are `source_sha, target_before_counts, target_after_counts, per_table, remaps, extract_tables, skipped, emits, wallet`.

**Steps:**
- [ ] Write the failing tests above (one `describe` per rule), and run `npm test -- tests/grackle-d3-import.test.js` to see them fail.
- [ ] Implement until they pass. Keep to one file, plus small pure helpers exported for the tests.
- [ ] **Rehearse against real copies, read-only on prod:**
  - [ ] Take a crow copy through `curl -s -X POST http://127.0.0.1:3001/api/admin/backup` (localhost, in-process) and note the path it returns.
  - [ ] The grackle source is the newest file in grackle's `~/backups/crow/`, copied in W0, or the W3 backup once it exists.
  - [ ] Run `--mode plan` and then `--mode rehearse`, and paste the summary into the PR.
- [ ] Run the full `npm test` once. Commit with positional paths, push, open the PR, and confirm check-runs are all `completed/success` before merging.

---

## W0: stable link, diagnosis, rescue (Kevin present; no prod impact)

**Schedule row template:**
```
| **YYYY-MM-DD (Day) HH:MM → est. +2 h (grackle read-only + copies to crow; no deadman needed: nothing in prod is stopped)** | **grackle decommission W0**: stable link, read-only diagnosis, secrets + git rescue to crow/`/mnt/external` | Claude session (crow) + Kevin | manual, attended | the rescue manifest is verified on crow AND this row is moved to Done |
```

- [ ] **1. Link.** Connect grackle by Ethernet (temporary cable or a spare switch port), or work at its console.
  - [ ] Confirm from crow: `ping -c 20 10.0.0.21` loses nothing, and `~/bin/grackle hostname` answers.
  - [ ] **Gate:** if no stable shell is possible, stop here and report.
- [ ] **2. Diagnosis (read-only).** Over ssh, run:
  ```
  journalctl --list-boots | tail -5
  journalctl -k --since -48h | grep -iE 'mt79|wlx|deauth|disassoc|reason|usb .*reset|disconnect'
  journalctl -u NetworkManager --since -48h | grep -iE 'state change|disconnect|deactivat|activated'
  cat /proc/pressure/{memory,io,cpu}; free -m; ps -eo pid,pcpu,pmem,rss,etime,comm --sort=-pcpu | head
  journalctl -p warning --since -48h | grep -iE 'oom|hung_task|blocked for more'
  ```
  Record which hypothesis (spec §2.1) the evidence supports, either Wi-Fi link or host stall, in the stream report and in memory `crow-grackle-decommission-progress.md`.
- [ ] **3. Freeze nothing yet.** grackle's services keep running.
- [ ] **4. Credential rescue.**
  - [ ] AskUserQuestion naming each file (inventory §10 step 1).
  - [ ] For each approved file, `scp` it to `~/grackle-decom/rescue/` on crow (`umask 077`, mode 0600).
  - [ ] Copy the **Android keystore** (`~/.crow/android-keystore/*.jks`) to **two** places: crow `~/grackle-decom/rescue/` and `/mnt/external/grackle-archive/private/`.
  - [ ] Write a sha256 manifest on both ends and diff them.
- [ ] **5. Git rescue** (inventory §8):
  - [ ] Push casa-nueva (ahead 1, 37 dirty: commit on a `grackle-rescue-YYYYMMDD` branch, never on top of someone's main without review), ai-coding-guide (+3), open-multi-agent (+7 → gitea), research-bundles/tea-maps (+5), lab-maintenance (9 dirty: push to a branch, reconcile in W4c), maestro-press-landing (12 dirty → branch), and ai-edu-suite (126 dirty → branch).
  - [ ] Tell Kevin that the ai-edu-suite remote URL embeds a GitHub PAT that needs rotating. The rotation is his.
- [ ] **6. grackle's dirty crow checkout** (spec §4.5): `git -C ~/crow diff > ~/grackle-decom/crow-handedits.diff` and `tar` the untracked dirs (`bundles/travel-planner`, `pi-bots`, `scripts/bots`) into `~/grackle-decom/`. Copy both to crow.
- [ ] **7. Pre-copy the bulky archive trees** that never change (urbit, kh0pp-backups, pgdata tar, the minio-data tar, `.crow-mpa`, `arc/`) to `/mnt/external/grackle-archive/` with `rsync -a --checksum`. W5 then only tops up.

**Verification:** `sha256sum -c` passes on crow for every rescued file, the git remotes show the pushed refs, and the keystore exists in both places.
**Rollback:** nothing to roll back, since grackle wasn't changed.

---

## W1: black-swan embed switch (no Kevin needed; black-swan prod)

**Schedule row template:**
```
| **YYYY-MM-DD HH:MM → est. +20 min (black-swan gateway restart ~1 min; deadman 10 min)** | **grackle decommission W1**: black-swan embeddings grackle-embed → crow-embed | Claude session (crow) | manual over `ssh black-swan` | black-swan /health ok AND embed call returns 1024 dims via crow-embed AND bs-w1-deadman not armed AND row moved to Done |
```

**Deadman (on black-swan):**
- Script `~/grackle-decom/bs-w1-restore.sh`:
  ```
  #!/bin/sh
  curl -sf -m 5 http://127.0.0.1:3001/health >/dev/null && exit 0
  systemctl start crow-gateway
  ```
- Check the port first with `systemctl cat crow-gateway` on black-swan.
- Arm with `sudo systemd-run --on-active=600 --unit=bs-w1-deadman /bin/sh /home/ubuntu/grackle-decom/bs-w1-restore.sh`.

**Steps:**
- [ ] Read `servers/memory/embeddings.js` **on black-swan** (`~/.crow/app`, 249d5919) and record the exact keys it consults: env var name and setting key.
- [ ] Back up black-swan's DB with `curl -s -X POST http://127.0.0.1:<port>/api/admin/backup` on black-swan.
- [ ] Arm the deadman and confirm it.
- [ ] Add `crow-embed` with a one-shot `upsertProvider` run from `~/.crow/app`: id `crow-embed`, base_url `http://100.118.41.122:8004/v1`, **no bundle_id**, and models copied from crow's `crow-embed` row (`sqlite3 'file:~/.crow/data/crow.db?mode=ro' "select models from providers where id='crow-embed'"`). This is the same pattern as 09-24 on crow and r4.
- [ ] Set `grackle-embed` `disabled=1` through the same provider API.
- [ ] Set the key found in the first step to `crow-embed`. If it's an env var, write a drop-in `/etc/systemd/system/crow-gateway.service.d/embed.conf`.
- [ ] Restart black-swan's gateway with `sudo systemctl daemon-reload && sudo systemctl restart crow-gateway`.
- [ ] **Verify:**
  - [ ] `/health` returns 200.
  - [ ] A memory search through black-swan's MCP, or a direct call of the resolved embed config, returns a 1024-dimension vector.
  - [ ] `journalctl -u crow-gateway --since -5min | grep -c grackle-embed` returns 0.
- [ ] Disarm the deadman.

**Rollback:**
1. Remove the drop-in.
2. Re-enable `grackle-embed` (pointless while grackle is down, but it restores the prior state).
3. Restart.

---

## W2: ntfy to crow (Kevin for the phones; ~15 min without push)

**Schedule row template:**
```
| **YYYY-MM-DD HH:MM → est. +30 min (push notifications down ≤15 min; deadman 45 min restores grackle ntfy + notify.url)** | **grackle decommission W2**: ntfy grackle → crow (:8445 Serve → 127.0.0.1:2586) | Claude session (crow) | manual | crow ntfy publishes+receives on :8445 AND crow pi notify.url points at crow AND w2-deadman not armed AND row moved to Done |
```

**Deadman (on crow):**
- Script `~/grackle-decom/w2-restore.sh`:
  1. if crow ntfy answers `https://crow.dachshund-chromatic.ts.net:8445/v1/health`, exit;
  2. else restore `~/.pi/agent/settings.json` from `settings.json.bak-w2`;
  3. `ssh -o ConnectTimeout=10 kh0pp@10.0.0.21 'docker start ntfy'`;
  4. send email.
- Arm with `sudo systemd-run --on-active=2700 --unit=w2-deadman …`.

**Steps:**
- [ ] `cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak-w2`, then arm and confirm the deadman.
- [ ] On grackle: `docker stop ntfy`, then copy `~/ntfy/{auth.db,cache.db,server.yml}` and `pi-token.txt` to crow under the ntfy bundle's data dir. Mode 0600; this is a credential copy approved in W0.
- [ ] Edit `server.yml`, setting `base-url: https://crow.dachshund-chromatic.ts.net:8445`.
- [ ] Start ntfy on crow from the repo bundle (`bundles/ntfy`, port 2586 on loopback), using the bundle install path rather than hand-written compose.
- [ ] `sudo tailscale serve --bg --https=8445 http://127.0.0.1:2586`, then `sudo ufw allow in on tailscale0 to any port 8445 proto tcp`.
- [ ] Edit crow pi `notify.url` to the crow URL, keeping topic and token unchanged.
- [ ] Check the crow gateway's ntfy settings (`dashboard_settings` keys like `ntfy%`) and repoint any that name grackle, through the settings UI or API, never with raw SQL.
- [ ] **Verify:**
  - [ ] Publish a test message with the pi token. It arrives on the topic, checked with a curl subscriber from black-swan (a real remote node).
  - [ ] Kevin's phone re-subscribes and receives it.
- [ ] Disarm the deadman.

**Rollback:** run the restore script by hand.

---

## W3: D3 import + blog Funnel + Ramble install (Kevin present; crow gateway down 30–45 min, cap 2 h)

**Schedule row template:**
```
| **YYYY-MM-DD (Day) HH:MM → est. +2 h; crow gateway STOPPED ~30–45 min, hard cap 7200 s (w3-deadman restarts it; NEVER touches crow.db); grackle Crow frozen for good (grackle-freeze-deadman restarts it at +3 h unless crow's IMPORT-COMMITTED marker exists)** | **grackle decommission W3 (D3)**: freeze grackle Crow, API backup, revoke peer, import into crow main (`scripts/ops/grackle-d3-import.mjs --mode apply`), Ramble install on crow, blog Funnel on crow | Claude session (crow) + Kevin | manual, attended; box hold `grackle-d3` | crow-gateway active AND /health 200 AND import report verified AND w3-deadman + grackle-freeze-deadman not armed AND box hold released AND public /blog 200 via Funnel AND row moved to Done |
```
Also check that no PR merge or auto-update is due inside the window: hold merges, and note it in the schedule row.

**Deadman A (crow), `~/grackle-decom/w3-restore.sh`:**
```sh
#!/bin/sh
# W3 deadman: restore the crow gateway. NEVER touches crow.db (phase A is all-or-nothing).
LOG=/home/kh0pp/grackle-decom/w3-deadman.log
H() { curl -sf -m 5 http://127.0.0.1:3001/health >/dev/null; }
if systemctl is-active --quiet crow-gateway && H; then echo "$(date -Is) healthy, no-op" >>"$LOG"; exit 0; fi
echo "$(date -Is) FIRED" >>"$LOG"
pkill -TERM -f grackle-d3-import.mjs; sleep 5
systemctl start crow-gateway
i=0; while [ $i -lt 36 ]; do H && break; i=$((i+1)); sleep 5; done
STATE=$(H && echo ok || echo DOWN)
echo "$(date -Is) restore done: $STATE" >>"$LOG"
sudo -u kh0pp node /home/kh0pp/crow/scripts/ops/box-reserve.mjs release >>"$LOG" 2>&1
sudo -u kh0pp sh -c '. /home/kh0pp/lab-maintenance/scripts/lib/alerts.sh && send_alert "W3 deadman FIRED: crow gateway $STATE"' >>"$LOG" 2>&1
# ntfy: read url/topic/token at runtime from ~/.pi/agent/settings.json (never hardcode), as deadman.sh does
```
Arm with `sudo systemd-run --on-active=7200 --unit=w3-deadman /bin/sh /home/kh0pp/grackle-decom/w3-restore.sh`.

Before relying on email, confirm the `send_alert` function name and signature in crow's `~/lab-maintenance/scripts/lib/alerts.sh` (`grep -n '^send_alert\|^[a-z_]*()' …`).

**Deadman B (grackle), `~/grackle-decom/freeze-restore.sh`:**
```sh
#!/bin/sh
# Un-freeze grackle's Crow at the cap UNLESS crow committed the import.
if sudo -u kh0pp ssh -o ConnectTimeout=10 -o BatchMode=yes kh0pp@100.118.41.122 'test -f ~/grackle-decom/IMPORT-COMMITTED'; then
  echo "$(date -Is) import committed on crow; staying frozen" >> /home/kh0pp/grackle-decom/freeze.log; exit 0; fi
systemctl start crow-gateway
echo "$(date -Is) un-frozen (no commit marker)" >> /home/kh0pp/grackle-decom/freeze.log
```
Arm on grackle with `sudo systemd-run --on-active=10800 --unit=grackle-freeze-deadman /bin/sh /home/kh0pp/grackle-decom/freeze-restore.sh`.

**Pre-window (T-60 → T-0, nothing degraded):**
- [ ] Confirm the gates in "Global constraints". For A8, after a test revoke on a throwaway row in the A8 PR's own acceptance, `crow_instances.status` stays `revoked` across two proxy reloads.
- [ ] Get Kevin's answers for spec §8.2 (c) and (d): Ramble import yes or no, and media/data-dashboard bundles. **If he picked install, install those bundles on crow now** (gateway up) so their tables exist.
- [ ] Collect the peer max memory ids, read-only:
  - black-swan: `sqlite3 'file:…/crow.db?mode=ro' 'select max(id) from memories'`;
  - raven: the `python3` read-only query, since raven has no sqlite3 or node.
- [ ] Run a fresh rehearse on a crow API backup with yesterday's grackle backup copy. Expect zero errors, and check the report against the spec §4.2 numbers (memories about 204, blog 31, research_sources 270, ramble deltas).
- [ ] List the crow.db holders with `lsof /home/kh0pp/.crow/data/crow.db`. End every Claude session holding crow stdio MCP servers, then run the rest of W3 from plain bash (spec §5.3).
- [ ] Write the schedule row and run `node ~/crow/scripts/ops/box-reserve.mjs hold --owner grackle-d3 --reason "W3 import, gateway stopped" --minutes 150`.

**Freeze grackle (grackle degraded from here: blog, Ramble, grackle MCP):**
- [ ] On grackle: arm deadman B and confirm it.
- [ ] `curl -s -X POST http://127.0.0.1:3002/api/admin/backup`, recording the returned path, `size_bytes` and `verified:true`.
- [ ] `sudo systemctl stop crow-gateway pibot-bridge@grackle.timer pibot-gateways@grackle pibot-discord@grackle`. Leave them **enabled**, so deadman B and a reboot can bring them back until W5 disables them.
- [ ] Run `sha256sum` on the backup, `scp` it to crow `~/grackle-decom/d3/`, and run `sha256sum` again on crow. The two must be equal.

**Revoke (crow gateway still up):**
- [ ] Revoke instance `49cf71ca878643ba7717f344329266fd` on crow and on black-swan with `crow_revoke_instance` (via each gateway's MCP, from a session or curl with the local token).
- [ ] Verify that `status='revoked'` survives about 2 minutes (two proxy reload cycles) on both. **If it reverts to `offline`, STOP**: A8 isn't effective. Un-freeze grackle (`sudo systemctl start crow-gateway` on grackle), disarm both deadmen, and reschedule.

**Import (crow gateway DOWN from here):**
- [ ] Arm deadman A and confirm it with `systemctl list-timers --all | grep w3-deadman`.
- [ ] `sudo systemctl stop crow-gateway` (the bundle children exit with it). Confirm `lsof /home/kh0pp/.crow/data/crow.db` is empty.
- [ ] Take the cold backup: `sqlite3 /home/kh0pp/.crow/data/crow.db ".backup /home/kh0pp/grackle-decom/d3/crow-pre-d3.db"`, followed by `sqlite3 …/crow-pre-d3.db 'pragma integrity_check'`, which must print `ok`. The gateway is stopped, so an offline `.backup` is safe here.
- [ ] Run the importer:
  ```
  cd ~/crow && CROW_DATA_DIR=/home/kh0pp/.crow/data node scripts/ops/grackle-d3-import.mjs \
    --source ~/grackle-decom/d3/<backup>.db --expect-sha <sha> \
    --target /home/kh0pp/.crow/data/crow.db --backup-ok ~/grackle-decom/d3/crow-pre-d3.db \
    --mode apply --report ~/grackle-decom/d3/report.json --extract ~/grackle-decom/d3/grackle-d3-extract.db \
    --peer-max-memory-id black-swan=<n> --peer-max-memory-id raven=<n> [--import-media] [--import-data-dashboard]
  ```
  `CROW_DATA_DIR` must be crow's, so `getOrCreateLocalInstanceId()` returns crow's id. Confirm the report's `emits.instance_id` equals `0867ac2809dedd885ba7769b21966f8e`.
- [ ] Check the report: `per_table` counts equal the rehearse counts, the wallet delta equals the rehearse delta, and `extract_tables` and `skipped` match the spec.
- [ ] Run `sqlite3 crow.db 'pragma integrity_check; pragma foreign_key_check;'`. It must print `ok` and no FK rows.
- [ ] Copy the project files: `rsync -a --ignore-existing` from grackle `~/.crow/data/projects/{1,5,6}/` into crow's matching dirs. For project 6 clashes, copy as `*.grackle` and list them. Also copy kb-media.
- [ ] `touch ~/grackle-decom/IMPORT-COMMITTED`.
- [ ] `sudo systemctl start crow-gateway`, then wait for `/health` 200.

**Verify (gateway up):**
- [ ] The dashboard loads. Spot-check that Memories shows grackle-era memories (search for 3 known titles from the report).
- [ ] The Blog panel lists 31 drafts, and the settings show title "Maestro Press" and the custom CSS.
- [ ] Projects shows grackle projects 1 and 5, plus the merged 6.
- [ ] Bot Builder shows the 3 defs **disabled**.
- [ ] Outbox drain: `select count(*) from sync_outbox` (read-only) decreases over about 5 minutes. black-swan's memory count rises unless memory emits were gated off. Note that black-swan replication is generally stalled (audit A3); if its count doesn't rise, record that and leave it to the A3 fix.
- [ ] Disarm deadman A.

**Ramble on crow (gateway up):**
- [ ] Install the ramble bundle on crow through Extensions (this is A6's deploy target).
- [ ] Verify the Ramble panel loads and the wallet balance equals the report's `after`.
- [ ] Kevin re-points his phone or PWA to crow `:8444`, and contacts are told the new URL.

**Blog Funnel (spec §5.4):**
- [ ] Add the Funnel paths:
  ```
  sudo tailscale funnel --bg --set-path=/blog http://127.0.0.1:3001/blog
  sudo tailscale funnel --bg --set-path=/robots.txt http://127.0.0.1:3001/robots.txt
  sudo tailscale funnel --bg --set-path=/sitemap.xml http://127.0.0.1:3001/sitemap.xml
  ```
- [ ] Run `tailscale funnel status` and confirm `/s` and `/s-assets` are unchanged and there is **no `/`** entry.
- [ ] Publish nothing new; Kevin decides what to publish. To verify, publish then unpublish one test post, **or** check `/blog` index 200 with 0 posts.
- [ ] **Public-path check**, from a host whose resolver is not MagicDNS. On crow, use `curl --resolve` with a public IP: `IP=$(dig +short @1.1.1.1 crow.dachshund-chromatic.ts.net | head -1)`, then `curl -s -o /dev/null -w '%{http_code}' --resolve crow.dachshund-chromatic.ts.net:443:$IP https://crow.dachshund-chromatic.ts.net/blog` (expect 200). Repeat for `/`, `/dashboard` and `/api/health`, which must **not** return 200 (expect 403 or 404).
- [ ] Remove `crow-blog-grackle` from `~/.claude.json` (back it up first).
- [ ] Disarm deadman B on grackle, if reachable, with `sudo systemctl stop grackle-freeze-deadman.timer`. If grackle is unreachable, it fires harmlessly into "staying frozen", because the marker exists.
- [ ] `node ~/crow/scripts/ops/box-reserve.mjs release`, then move the schedule row to Done.
- [ ] Update memory `crow-grackle-decommission-progress.md`.

**Rollback:**
- **Before IMPORT-COMMITTED:**
  1. Start crow-gateway.
  2. On grackle, `sudo systemctl start crow-gateway` and the pibot units.
  3. Un-revoke grackle: `crow_update_instance` with status `active`, on crow and on black-swan.
  4. Disarm both deadmen.
- **After commit, import found wrong (attended only):**
  1. Stop crow-gateway.
  2. `cp ~/grackle-decom/d3/crow-pre-d3.db ~/.crow/data/crow.db`, removing `-wal` and `-shm` first.
  3. Start the gateway.
  4. Clear the queued outbox: the restored DB predates it, so it's gone automatically. **But** any rows already delivered to peers stay there. Record those from `report.emits` for manual cleanup.
  5. Funnel: `sudo tailscale funnel --set-path=/blog off`, and likewise for robots.txt and sitemap.xml.
  6. Un-freeze grackle as above.

---

## W4: service moves (one service per window)

**Schedule row template (one per sub-window):**
```
| **YYYY-MM-DD HH:MM → est. +45 min (<service> down ≤30 min; deadman <cap> restarts grackle's copy)** | **grackle decommission W4<x>**: <service> grackle → crow | Claude session (crow) [+ Kevin] | manual | <service> healthy on crow AND grackle copy stopped+disabled AND w4<x>-deadman not armed AND row moved to Done |
```

**Deadman pattern for every W4 sub-window:**
- A crow root transient timer with the sub-window's cap.
- Script: if the crow copy is healthy, exit; otherwise stop the crow copy, then `ssh kh0pp@10.0.0.21 '<start grackle copy>'`, then send email and ntfy.
- **The "stop the crow copy" step is mandatory** for OpenClaw and HA, to prevent two live copies.

**Rule:** always stop grackle's copy **before** starting crow's.

### W4a: Home Assistant (Kevin present, cap 45 min)
- [ ] On grackle: `docker stop homeassistant`, then `rsync -a ~/homeassistant/config/` to crow `~/homeassistant/config/`.
- [ ] On crow: start a host-net container with the same image tag as grackle's (`docker inspect` on grackle) and the same volume layout. Port `:8123` is free.
- [ ] Add a ufw rule for 8123 on `eno1` (LAN), and on `tailscale0` only if Kevin chose tailnet access (§8.2 j).
- [ ] **Verify:** the UI loads at `http://10.0.0.237:8123`; roomba, Samsung TV and Cast entities report state; Kevin's phone app reconnects at the new URL.
- [ ] Disable grackle's container restart policy with `docker update --restart=no homeassistant`.

### W4b: Casa Nueva / OpenClaw (Kevin present, cap 45 min)
- [ ] Confirm the casa-nueva push from W0.
- [ ] On grackle: `systemctl --user stop openclaw-gateway && systemctl --user disable openclaw-gateway`.
- [ ] Copy `~/.openclaw` (approved in W0), the user unit and its drop-ins (`google.conf`, `vllm-key.conf`), the Sheets service-account path and the gog keyring.
- [ ] On crow: `loginctl enable-linger kh0pp` (if not already on), then start the unit with crow's Node 24.
- [ ] Reconfigure the HA `openclaw` integration URL.
- [ ] **Verify:** the bot answers in Discord, one pantry or grocery command round-trips to Sheets, and **only one** bot instance is online in Discord.
- [ ] Update port-allocation.md row 18789 in the W5 docs PR.

### W4c: lab-maintenance, dashboard and guides (no Kevin; cap 60 min)
- [ ] Reconcile grackle's 9 dirty files (W0 branch) into crow's clone, and push.
- [ ] Move the crontab entries from inventory §3.3 to crow's kh0pp crontab: collect-health, cleanup, run-updates, run-audit, scan-ports, security-audit, digests, memory-watchdog. Drop dream-check, backup-crow-via-api, the newsagg restart and sync-kb-to-crow (W4f).
- [ ] Install `lab-dashboard.service` on crow (`:5050`, free), plus the `grackle-dashboard` generator renamed for crow, plus the static guides from grackle `/var/www/html`.
- [ ] Run `sudo tailscale serve --bg --https=8454 http://127.0.0.1:5050` and add a ufw rule for 8454 on `tailscale0`. Re-check that 8454 is free in `tailscale serve status` first.
- [ ] Remove grackle from `machines.conf`, `services.json` and `ports*.json`.
- [ ] Repoint `~/bin/tournament-gate-reminder.sh` to crow's local `alerts.sh`.
- [ ] On grackle: comment out the crontab lines, then `systemctl disable --now lab-dashboard grackle-dashboard.timer`.
- [ ] **Verify:** `https://crow…:8454/` and `/api/status` return 200 from black-swan, the next 15-minute health run writes fresh data, and a test alert email arrives.

### W4d: home-search (no Kevin; cap 30 min)
- [ ] Copy `~/home-search-2026` to crow and move its Saturday 09:00 cron entry.
- [ ] Do a dry run of the report script if it has one, or check the next Saturday's email.
- [ ] Remove the cron line on grackle.

### W4e: pi-bots (Kevin for the Gmail creds; cap 30 min)
- [ ] On grackle: `sudo systemctl disable --now pibot-bridge@grackle.timer pibot-gateways@grackle pibot-discord@grackle`.
- [ ] Copy `/etc/crow/pibot-grackle.env` (approved in W0) to crow `/etc/crow/pibot-crow.env`. Check whether crow already has a `pibot-*@crow` unit pattern; crow currently runs only `pibot-gateways@r4`. Copy the `~/crow/pi-bots/grackle-assistant` dir.
- [ ] Enable the bridge timer on crow, then flip the 3 imported defs to enabled in Bot Builder.
- [ ] **Verify:** a test email to each bot gets one reply, and grackle sent none.

### W4f: KB and research data (no Kevin; cap 30 min)
- [ ] Run `sync-kb-to-crow.sh` a final time, then move `~/.knowledge-base` and `~/.research-mcp` to crow and point their MCP configs at the crow paths.
- [ ] Drop the sync cron.

### W4g: retirements on grackle (no Kevin except ed-jobs; no crow impact)
- [ ] Archive tripweather (`~/claude-demo/tripweather` and `/etc/tripweather/environment`) to `/mnt/external/grackle-archive/private/`, then `systemctl disable --now tripweather`.
- [ ] ed-jobs: `docker stop edjobs_celery_beat`, then the apply worker, postgres and redis. Copy the dump to the archive.
- [ ] Disable `crow-mcp-bridge`, `crow-db-backup.timer`, `crow-gateway-probe.timer`, `crow-orphan-sweep.timer`, `tailscale-cert-renew.timer`, `whisper-api`, `pi-hub` (user), `ollama`, Timeshift, `redis-server`, `tor`, `cups`, `smbd` and `nmbd`.
- [ ] Remove `piHub.peers` grackle from crow `~/.pi/agent/settings.json`, after a `.bak`.
- [ ] Samba: check penguin and magpie for mapped grackle shares; Kevin checks his phones.

---

## W5: archive, revoke everywhere, Tailscale, SSH, docs (Kevin for the admin console)

**Schedule row template:**
```
| **YYYY-MM-DD HH:MM → est. +3 h (no crow prod impact; copies to /mnt/external)** | **grackle decommission W5**: archive top-up, fleet revoke check, provider rows, Tailscale removal, SSH keys, docs | Claude session (crow) + Kevin | manual | archive manifests verified AND grackle absent from `tailscale status` AND no grackle rows enabled anywhere AND row moved to Done |
```

- [ ] **Archive top-up** (spec §7.1):
  - [ ] Run `rsync -a --checksum` for each tree into `/mnt/external/grackle-archive/`, using `private/` (0700) for personal and tax material.
  - [ ] Write `MANIFEST.sha256` per tree with `sha256sum -c` on crow.
  - [ ] Add the final API backup of grackle's crow.db, the incident copies, the D3 report and extract, `~/.claude`, and the Windows-free disk listing.
- [ ] **Fleet:**
  - [ ] grackle shows `revoked` on crow and black-swan, still there after 24 h.
  - [ ] Disable the `grackle-embed`, `grackle-rerank` and `grackle-vision` provider rows on crow (synced to raven) and on black-swan and r4 directly, through the provider API, never with raw SQL.
  - [ ] Remove `default-grackle-vision` from `vision_profiles` through the settings UI.
  - [ ] **MPA check** (spec §2.2): 1 h after the revoke, MPA's `last_seen_at` is unchanged on crow and black-swan. Record the result for A8.
- [ ] **Tailscale:**
  - [ ] On grackle: `sudo tailscale funnel reset; sudo tailscale serve reset; sudo tailscale logout`.
  - [ ] Kevin deletes the node in the admin console.
  - [ ] Verify `tailscale status | grep grackle` returns nothing on crow.
- [ ] **SSH:**
  - [ ] Delete the `kh0pp@grackle` lines from `authorized_keys` on crow, black-swan and raven, plus colibri, mockingbird and penguin where reachable. Back up each first.
  - [ ] Remove `~/bin/grackle` on every machine that has it, and the `grackle` shortcut references in claude-config.
- [ ] **Docs** (Kevin reviews the CLAUDE.md diff first, since it's private config):
  - [ ] claude-config `machines.sh`, `CLAUDE.md` (network list, Serve table, Samba, grackle sudo mention, guide pages → `:8454`) and `LAB-REFERENCE.md` (Casa Nueva → crow, lab-maintenance → crow). Then `deploy.sh all`.
  - [ ] Crow repo PR: port-allocation.md (ntfy 2586 / Serve 8445, 18789 OpenClaw, 8454 lab dashboard if listed), plus a list of the remaining code mentions of grackle for a follow-up host-neutral cleanup.
- [ ] Start the 7-day soak clock and write the date into memory.

**Rollback:** before the Tailscale logout, every step is reversible from the archive and the `.bak` files. After the logout, re-auth with `sudo tailscale login` on grackle's console.

---

## W6: wipe (Kevin's explicit written OK; after the 7-day soak)

**Schedule row template:**
```
| **YYYY-MM-DD HH:MM → est. +45 min (grackle only; irreversible)** | **grackle decommission W6**: NVMe wipe (Kevin OK'd on <date>, verbatim: "<quote>") | Kevin + Claude session | console, live USB | wipe verified AND row moved to Done |
```

- [ ] **Pre-checks:**
  - [ ] 7 days have passed since W5.
  - [ ] Searching the last 7 days of logs on crow, black-swan, raven and r4 for `100.121.254.89` and `grackle.dachshund` finds no live dependency.
  - [ ] Archive manifests re-verified.
  - [ ] Kevin re-confirms: Windows C: has nothing to rescue, and the Seagate goes or stays.
- [ ] **Wipe:**
  1. Boot a live USB.
  2. Run `nvme id-ctrl /dev/nvme0n1 -H | grep -i -E 'format|crypto|sanitize'`.
  3. Run `nvme format /dev/nvme0n1 --ses=2` if crypto erase is supported, else `--ses=1`. If format is unsupported, run `blkdiscard -s /dev/nvme0n1 || blkdiscard /dev/nvme0n1`.
  4. If the Seagate leaves with the box, wipe it too: `blkdiscard`, or `dd if=/dev/zero bs=16M status=progress` for a USB HDD.
- [ ] **Verify:** `hexdump -C -n 1048576 /dev/nvme0n1 | head` and a read at the last GiB show zeros or random data, with no partition table.
- [ ] Final memory update. Close audit A9 and queue item 6.

---

## Estimated window lengths

| window | wall clock | prod impact |
|---|---|---|
| W0 | 1.5–2 h (more if the link must be fixed) | none |
| W1 | 20 min | black-swan gateway ~1 min |
| W2 | 30 min | push ≤ 15 min |
| W3 | ~2 h including prep | **crow gateway 30–45 min (cap 2 h)**; grackle Crow frozen for good |
| W4a / W4b | 45 min each | HA / Casa Nueva ≤ 30 min each |
| W4c | 1–1.5 h | none (dashboard URL changes) |
| W4d–g | ~1.5 h total | none on crow |
| W5 | 2–3 h (archive top-up over Ethernet; much longer over the failing Wi-Fi) | none |
| W6 | 45 min, after the 7-day soak | grackle only |
