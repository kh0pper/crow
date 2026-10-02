# Grackle decommission D3–D5: design

**Status:** design, docs only. Nothing in this document has been executed. Written 2026-10-02 for audit item A9 (weekend push).
**Owner:** crow sessions, with Kevin at every window marked "Kevin present".
**Runbook:** `docs/superpowers/plans/2026-10-02-grackle-decommission-d3-d5.md`.

**Inputs, read in full before changing anything:**
- Gitea `kh0pp/crow-engineering`:
  - `backlog/2026-09-22-grackle-decommission-inventory.md` (the inventory; it is identical to the scratchpad copy it was published from);
  - `backlog/2026-09-24-grackle-d3-data-migration-map.md` @4e96f46 (the table-by-table map; this spec adopts it and only records changes and additions).
- Handoff `docs/superpowers/handoffs/2026-09-24-improvement-queue-handoff-2.md` §Next 2–4.
- Memory `crow-grackle-decommission-progress.md` (D1 shipped, Kevin's 09-22 and 09-24 decisions).
- CLAUDE.md "Network exposure invariant", `~/CROW-SCHEDULE.md` rules, and the global unattended-window rule.

## 1. Where the phase stands

| phase | state |
|---|---|
| D1: embeddings off grackle | **shipped** (#388 `a90d901d`). crow, r4 and raven resolve `crow-embed` (crow `:8004`). **black-swan does not** (§6.1). |
| D2: new-peer history backfill | separate arc (audit A10, schema bump). **Not a blocker** for D3–D5. |
| D3: grackle's local data into crow main | map done; spec = this doc; importer not built. |
| D4: service moves | not started. |
| D5: retire, revoke, wipe | not started. The wipe needs Kevin's explicit OK. |

**Kevin's decisions so far (not re-asked here):**
- **Data and services:**
  - merge grackle's Crow data into crow main, and crow becomes `is_home`;
  - Home Assistant, Casa Nueva/OpenClaw and ntfy move to crow;
  - the blog drafts and settings move to crow main and publish through crow's Funnel;
  - home-search, the three grackle pi-bots and the guide pages move to crow.
- **Retire:**
  - tripweather is archived, then retired;
  - grackle's ed-jobs copy is retired; crow's copy is the only one.
- **Archive:** all orphan data goes to `/mnt/external`, except the Windows C: partition.
- **Ramble moves to crow** (Kevin, 2026-10-02).

## 2. What changed since the 09-22 inventory (read-only checks, 2026-10-02 12:30–12:55 CDT)

### 2.1 grackle is mostly unreachable, and the cause is its network path, not the gateway

**The audit's symptom:** `https://grackle…:8444/health` timed out after 8 s.

**What I measured from crow:**
- **LAN:** every ping to `10.0.0.21` was lost: 30 of 30 over 6 minutes, then 120 of 120 in a 2-minute run (§2.1a). SSH to `10.0.0.21:22` and to `100.121.254.89:22` timed out on every attempt in a 15-minute retry loop.
- **ARP:** crow's neighbour entry for `10.0.0.21` flips between `DELAY` and `REACHABLE`. The MAC `28:94:01:b5:ff:3a` is grackle's NetGear mt7921u USB Wi-Fi adapter (`wlx289401b5ff3a`). Wi-Fi is grackle's only link: the cable moved to crow on 2026-06-23.
- **Tailscale:** the peer flaps between `active; relay "dfw"` and `active; relay "dfw"; offline, last seen 3m ago`. It is **never direct**, even though crow and grackle share the LAN. Last handshake 12:19 CDT, last seen 12:30 CDT. The node key is not expired (expiry 2027-03-22), and this is not the 09-17 logout: the node still re-registers.
- **Instance rows:** grackle ("Primary") was last seen 17:31:15 UTC (12:31 CDT) by both crow and black-swan, so it does surface briefly.
- **Not grackle's gateway:** black-swan, a different network path, gets `000` from grackle's `:9100` embed container too. Every service on grackle is unreachable at the same time.

**Conclusion:** the timeout is grackle's network data path failing, not the crow gateway process hanging. ARP still resolves at moments when ICMP and TCP don't, and Tailscale can't establish a direct path on the same L2. That matches a degraded or flapping USB Wi-Fi link, with packet loss severe enough that the Tailscale relay is all that intermittently gets through. The alternative is a host so overloaded (memory pressure, I/O stall) that its network stack barely runs. The previous incident of that shape is the 2026-02-23 goose coredump loop in LAB-REFERENCE. Two observations weigh against the stall theory: the control-plane check-ins keep happening, and ICMP is answered by the kernel. Neither rules it out.

**Not yet distinguished:** these two causes can't be separated from crow, because no shell was obtainable. The read-only probe in the runbook (W0, step 1) separates them: `journalctl -k` for `mt7921u` resets and disassociations, the NetworkManager state log, `/proc/pressure/*`, and `journalctl --list-boots`.
**Consequences for this design:**
1. **Rescue first.** grackle holds the only copies of the Android release keystore, the `.env` secrets and several unpushed repos (inventory §0.3, §8), so **W0 (rescue) moves to the front and runs as soon as a shell is obtainable.** If the link stays dead, plug a LAN cable in temporarily or use the local console. Every later window assumes a stable link; **W0 includes "get grackle onto a stable link" as its first gate.**
2. **Freeze grackle before migrating.** Don't run a long data window across a flapping link. Copy the backup once, verify its checksum on crow, and work only from the copy afterwards.
3. **Nothing alerted.** This is the second silent grackle outage in two weeks. Audit item A14 (the Tailscale alert) would not have caught it, because the node is not logged out. Noted for A14's scope: alert on peer `offline` > N min, not just on logout.

### 2.1a Raw numbers
- **6-minute sampler (12:34:51–12:39:41):** 30 of 30 LAN pings lost.
- **2-minute ping run (12:38–12:40):** 120 of 120 lost.
- **IPv6:** grackle's IPv6 LAN address `2601:2c5:4900:94f0::6923` (same MAC in crow's neighbour table) gave 3 of 3 pings lost, and ssh timed out.
- **SSH retry loop (12:36–12:51):** about 50 attempts on the LAN and Tailscale addresses, all `Connection timed out`.
- **Tailscale `LastSeen`** keeps advancing in 10-minute steps (17:30Z, then 17:40Z), so grackle intermittently reaches the coordination server over the internet while nothing inbound gets through.
- **ARP caveat:** some access points answer ARP on behalf of associated clients (proxy ARP). So an ARP `REACHABLE` entry on crow does not by itself prove that grackle's kernel is alive.

### 2.2 Other facts verified today
- **black-swan:** app `249d5919`. Its `providers` table has only `grackle-embed/rerank/vision`, all `disabled=0`, and no `crow-embed` row; replication has been stalled since about 08-20 (audit A3). `embeddings.js` `FALLBACK_PROVIDER = "grackle-embed"`. **Its embeddings are failing right now** (grackle `:9100` → `000`). black-swan **can** reach crow `:8004` (`/v1/models` 200). Its auto-update reads `Skipped: CI still running on origin/main (ed2382b01)`.
- **crow providers:**
  - `crow-embed` (rowid 32) is enabled and wins the resolver, because the ids sort alphabetically and `crow-embed` < `grackle-embed`.
  - `grackle-embed` is **still enabled** (rowid 5).
  - `grackle-rerank` and `grackle-vision` are disabled.
  - `dashboard_settings.vision_profiles` still defaults to `default-grackle-vision`, which points at the disabled provider.
- **raven:** no grackle peer row. It has the provider rows, with `grackle-embed` enabled and `crow-embed` enabled.
- **r4:** no grackle peer row. Same provider pattern.
- **MPA phantom liveness:** on **both** crow and black-swan, the MPA row (`520a8629…`) has `last_seen_at` exactly equal to grackle's (`2026-10-02 17:31:15`). MPA's "active" status is therefore relayed inside grackle's sync traffic, not produced by MPA. That's a lead for A8: revoking grackle is expected to end it. Verify in W5.
- **crow ports:** `2586` (ntfy), `8123` (HA), `18789` (OpenClaw), `5050` and `80` are free on crow at the listener level. Of these, port-allocation.md lists only `18789`. `8445` is free in crow's Serve map.
- **crow.db holders:** besides the gateway and its bundle children (maker-lab, funkwhale), a **Claude Code session's stdio MCP servers** (memory, research, sharing, blog; parent `claude`, up 2 days) hold `~/.crow/data/crow.db` open. Stopping the gateway does not stop them (§5.3).
- **crow disks:**
  - `/mnt/external`: 2.3 TB free;
  - `/` (where `~/.crow` lives): 303 GB free;
  - `/mnt/data`: 7.6 GB free (100%). **Don't stage anything there.**
- **crow's own references to grackle:**
  - `~/.pi/agent/settings.json`: `notify.url` → grackle `:8445`, and `piHub.peers` → grackle `:8448`;
  - `~/.claude.json`: MCP `crow-blog-grackle`;
  - `~/bin/tournament-gate-reminder.sh`: sends via grackle's `alerts.sh`;
  - `~/bin/colibri`: uses `id_rsa_grackle`, already broken;
  - `~/bin/grackle`;
  - `claude-config/machines.sh`.
- **Deadman notifications go to ntfy on grackle.** `deadman.sh`-style scripts read `notify.url` from pi settings. **While grackle is down, every lab deadman's alert goes nowhere.** That is why ntfy moves before the D3 window (§3).

## 3. Window order (the core decision)

The 09-24 map ordered the work as D3 → D4 → D5. Given §2, the order becomes:

| window | what | prod impact | Kevin present? |
|---|---|---|---|
| **W0** | Get grackle onto a stable link. Run the read-only diagnosis. Rescue secrets and git (inventory §10 Phase 0). | none (grackle read-only; copies onto crow) | **yes**: credential copies need named approval, and the cable/console is physical |
| **W1** | black-swan embed switch (§6.1) | black-swan embed is already broken; this fixes it | no |
| **W2** | ntfy → crow (§6.2) | push notifications about 15 min | yes, for phone re-subscribe (can be later) |
| **W3** | **D3 import.** Freeze grackle, API backup, revoke the peer, **stop the crow gateway**, import, start the gateway, then publish the blog Funnel on crow. | **crow gateway down for 45–75 min, cap 2 h**; grackle's Crow frozen for good | **yes**: go/no-go, sudo, verification |
| **W4a–g** | Service moves: Home Assistant, OpenClaw, lab-maintenance plus guide pages, home-search, pi-bots enable, KB/research data, retirements | each service ≤ 30 min; one at a time | HA and OpenClaw: yes (phone apps, Discord). Others: no |
| **W5** | Retire: archive to `/mnt/external`, revoke everywhere, provider rows, Tailscale node, SSH keys and shortcuts, docs | none on crow | yes, for the Tailscale admin console |
| **W6** | **Wipe** | grackle gone | **explicit written OK from Kevin**, plus a 7-day soak after W5 |

**Why ntfy before D3:** the D3 deadman has to be able to tell someone it fired. **Why black-swan first:** it's independent, it's broken today, and it can't wait for grackle.

**Hard prerequisites for W3:**
- **A8 merged and deployed on crow and black-swan.** `servers/gateway/proxy.js:607` unconditionally writes `status='offline'` on a failed connect, which overwrites `revoked`. Against a frozen grackle every proxy load fails, so a revoke would last seconds.
- The importer built and green on copies (plan Task 1).
- W0 done.

## 4. D3 design: grackle's data into crow main

### 4.1 Mechanism

D3 uses a purpose-built, tested one-shot script, **`scripts/ops/grackle-d3-import.mjs`**, plus its test. It never hand-runs SQL in a shell.

**Inputs:** the **verified API backup** of grackle's crow.db (read-only, by checksum), the target crow.db path, and a mode.

**Modes:**
- **`--mode plan`:** reads both DBs and writes `report.json`, which holds per-table counts, id remaps, collisions and missing-table decisions. It writes nothing.
- **`--mode rehearse`:** copies the target to a scratch path, applies to the copy, runs `PRAGMA integrity_check` and `foreign_key_check`, and diffs the counts against the plan. Run it any number of times, against a fresh copy of live crow.db each time.
- **`--mode apply`:** the live run. It refuses unless:
  - `systemctl is-active crow-gateway` is not `active`;
  - `lsof` shows no other holder of the target DB, `-wal` or `-shm`;
  - both DBs have `user_version == SCHEMA_GENERATION` (9 today), and it refuses on any mismatch;
  - the source sha256 matches the value given with `--expect-sha`;
  - a marker shows the target was cold-backed-up in this window (`--backup-ok <path>`, and the file must exist and pass `integrity_check`).

**Transactions:**
- **Phase A (data):** one better-sqlite3 transaction, all or nothing. A crash or deadman kill leaves crow.db unchanged.
- **Phase B (queue emits):** after phase A commits, the synced rows are queued through `emitOrQueue(null, db, table, "insert", row)` (servers/shared/sync-emit.js). With no live manager, rows go into the #292 outbox, and **the gateway's drain delivers them on boot.** This is the supported "raw inserts never sync" fix: no peer receives anything while the gateway is down, and nothing is hand-emitted. Phase B records each queued `(table, id)` in the report. `--mode emit-only --report <path>` re-queues from the report and is idempotent (emits are upserts by key on receivers).

**Column handling:** every INSERT lists its columns explicitly from the **intersection** of the source and target `PRAGMA table_info`. Columns that exist only in the source go to a report section, for example `research_sources.file_path` and `s3_key` (16 rows filled). Those values are also written to the archive extract (§4.4), so nothing is silently dropped.

**Embeddings:** embedding blobs carry their parent's remapped id. Every vector is qwen3-embedding-0.6b at 1024 dimensions, and crow `:8004` is the same model (cosine 0.999, measured 09-24), so nothing is re-embedded.

**FTS:** the target's triggers fire on the plain inserts. The test checks the FTS row counts after a rehearse.

### 4.2 Table map: changes to the 09-24 map

Everything in the Gitea map stands, except the items below.

| table group | 09-24 map | **this spec** | why |
|---|---|---|---|
| memories (+ embeddings) | 204 rows, remap 34 colliding ids, emit | **same, and emit only after a per-peer id-range check** | Memory sync is keyed on the numeric id (no portable key until D2). The importer reads the max memory id on each live peer (black-swan 1 row, raven 0, from read-only queries the operator pastes) and refuses to queue memory emits if the remapped crow range overlaps an existing peer id. Fallback: import without emitting, and leave fleet propagation to D2. |
| ramble_cells / wallet | natural keys, emit | **same; insert-or-ignore on the natural key, never overwrite** | crow's row wins on a key clash. The report shows the wallet balance before and after (§4.3). |
| ramble_credits / nest_claims | 82 / 2, local | same | |
| pi_bot_defs (3) | insert | **insert with `enabled=0`** | Two bridges must never run one bot. They are enabled in W4e, after grackle's `pibot-bridge@grackle` is stopped. |
| media_sources / playlists / prefs / briefings | import | **archive extract by default; import only if Kevin installs `media` on crow** | crow lacks the media tables, and the importer must not create a bundle's schema by hand. The owning bundle's init creates it. |
| data_case_studies / sections (16 / 167) | import (needs the bundle) | **same rule: archive extract unless Kevin installs `data-dashboard` on crow before W3** | as above |
| pir_requests, capstone_pir_files, capstone_sync_map, pipeline_runs | import | **archive extract only** | No repo code owns these tables. They come from grackle's untracked `scripts/bots/*.mjs` and `scripts/research/sync_pirs_to_crow.py`. Importing unowned schema into crow.db creates a table nothing maintains. The scripts are archived with them. |
| tax_returns / tax_documents | import | **archive extract only** (`/mnt/external/grackle-archive/private/`, 0700) | Sensitive. Personal documents already go to the private archive (Kevin), so the rows travel with their PDFs. |
| travel-planner.db | copy | **archive** (the bundle isn't in crow's repo) | It's open whether the bundle goes into the repo (Kevin, §8). |
| blog_posts + blog settings | import | same, then publish the Funnel in the same window (§6.3) | Keeps the public blog gap to minutes. |
| data_backends, crowclaw_*, notifications, oauth_*, mcp_sessions, sync_conflicts, audit_log, cross_host_calls | skip/archive | same | |

**The archive extract:** `grackle-d3-extract.db`, a plain SQLite file holding every table and column not imported, written by `--mode apply` alongside the report. Both go to `/mnt/external/grackle-archive/d3/`. If a bundle is installed later, a follow-up import reads from this file, never from grackle.

### 4.3 Ramble player data: decision

**Decision: import it.**
- grackle and crow share one Crow identity (`crow:kdq7zskhat`, the same `identity.json`), so grackle's Ramble state is **the same player's** state, not a second player's.
- The synced subset has mostly converged already (cells 53/79, wallet 31/35, eggs, pet and settings equal or off by one).
- What's missing is small: 26 cells, 4 wallet rows, 82 credits and 2 nest claims.
- Dropping it would silently delete progress, such as explored cells and earned credits, that the player can see.
- Insert-or-ignore on natural keys can't double-count a row that crow already has.

**The one real risk is the balance.** ramble_wallet rows feed a balance, so the report prints `before`/`after` per wallet kind, and the rehearse step must show `after - before` equal to the sum of the 4 imported rows. Kevin sees that delta at the W3 go/no-go and can veto it.

**Not in D3, but required for "Ramble moves to crow":**
- the ramble bundle installed on crow (currently `installed.json` has no ramble entry; the tables already exist in crow.db);
- phones and contacts re-pointed from the grackle gateway URL to crow `:8444`.

The install is the A6 deploy-target action. **Do it in W3, immediately after the import**, so that nobody plays against a frozen grackle.

### 4.4 Non-DB data in D3

| item | action |
|---|---|
| `~/.crow/data/projects/` (83 MB; `6/databases/tea_data.db` is the bulk) | rsync from the frozen grackle into crow's matching project dirs. **Project 6 merges**: same slug and path, and files are never overwritten, so a clash gets a `.grackle` suffix and is reported. Projects 1 and 5 are inserted. |
| glasses_photos and storage_files objects | the objects are already in crow MinIO (09-24 map), so verify with `mc stat` in the plan step; nothing is copied |
| research_sources `s3_key` (16) | the plan step lists the 16 keys and `mc stat`s them on crow MinIO. **If any key is missing**, grackle's MinIO bucket is empty (inventory §7.3), so those objects are lost. The rows import anyway with a report note, and §8 asks Kevin. |
| media audio (2.3 MB), kb-media (2 JPGs), travel-planner.db | copy into the archive; kb-media also goes to crow's kb-media dir |
| **MinIO (grackle)** | **retire.** The service is disabled and the buckets `crow`/`urbit` are empty. Tar `minio-data` (508 K) into the archive. Don't migrate the unit; its plaintext root credentials die with the wipe. |
| **PostgreSQL** | **no live database to move.** The dormant `pgdata` (109 MB, uid 999, Jan 2026) gets tarred into the archive, preserving ownership (`tar --numeric-owner`). grackle's ed-jobs postgres container (stale since 09-17) is retired per Kevin; `~/edjobs-final-20260726.dump` goes to the archive. |
| **ollama** | **drop.** It holds only `nomic-embed-text` and nothing uses it (D1 moved embeddings to crow-embed, and no provider row points at `:11434`). It can be re-pulled. |
| **vllm-cuda-embed, the HF cache, GGUFs, SDXL** | drop (re-downloadable). The 9 MB `sdxl-backgrounds` go to the archive. |

### 4.5 The grackle hand edits (auto-update stuck)

Before W3, diff grackle's dirty checkout (`blog-public.js` with a `/blog/research` 404 tweak, plus untracked `bundles/travel-planner/`, `pi-bots/` and `scripts/bots/*`) into the archive. **A real product need becomes a PR against main; nothing is copied into crow's tree.** A blog behaviour that crow lacks is checked against the imported posts in the W3 rehearse (the plan's link check) before the Funnel goes public.

## 5. Safety model (applies to every window)

### 5.1 Registration
Every window gets a `~/CROW-SCHEDULE.md` Reservations row (templates are in the runbook), written **before** the window starts and moved to Done after.
- W3 also takes a **box hold** (`node ~/crow/scripts/ops/box-reserve.mjs hold --owner grackle-d3 --minutes 150`). With the gateway down there are no model starts anyway, but the hold stops other sessions from starting GPU work that expects the gateway.
- Check the standing automations first: crow-db-backup.timer, the 02:15–04:15 audit interlock, and the auto-update tick. **Auto-update must not restart the gateway mid-window**, so W3 also requires no unmerged PRs scheduled to land (deploys batched outside the window).

### 5.2 Deadman pattern
Every prod-degrading window arms its deadman **before** the first degrading step. It's a **root transient timer**, `systemd-run --on-active=<cap> --unit=<window>-deadman /bin/sh <restore-script>`: its own unit, out of process, and it survives the operator session dying (the 2026-07-08 lesson: never use a setsid/nohup child).

**The restore script for each window:**
- **is idempotent;**
- checks health first (if prod is healthy, it logs and exits);
- if prod is down, it restores and re-checks;
- it notifies on ntfy (crow's, after W2) **and** by email through crow's `~/lab-maintenance/scripts/lib/alerts.sh`. That's two channels, because ntfy itself moves in W2.

**Disarm** with `systemctl stop <window>-deadman.timer` only after the window's verification passes. **The window isn't "monitored" until the deadman is confirmed armed** (`systemctl list-timers | grep deadman`).

**For W3, the deadman restores the gateway, never the database.** Phase A is all-or-nothing, so if the deadman kills the importer mid-run, crow.db is unchanged and starting the gateway is safe. A DB rollback (restoring the cold backup) is a **manual, attended** step, only for a committed import found wrong. Automating it would risk overwriting data written after the gateway came back.

### 5.3 Single writer
In `--mode apply`, the importer refuses if anything but itself holds crow.db. So W3 runs from a shell with **no Claude session that has crow stdio MCP servers.** Either use plain bash over ssh, or end those sessions first; the preflight lists the PIDs (today four `servers/*/index.js` under a `claude` parent). Nothing gets killed automatically.

### 5.4 Network-exposure invariant
The blog moves onto crow's **existing** Funnel host with only `tailscale funnel --set-path` entries for `/blog`, `/robots.txt` and `/sitemap.xml`, all pointing at `http://127.0.0.1:3001` with the same path.
- **Never map `/`.** crow's Funnel root already serves r4's `/s` and `/s-assets` (→ `:3008`); leave them untouched.
- **`/.well-known/` stays unmapped:** nothing on crow's main gateway needs it public today.
- **Code isn't touched,** so `tests/auth-network.test.js` doesn't need to run. If the A8 or importer PRs touch `funnel.js` or auth, they run it.

**Verification goes through the public path, not the tailnet.** Resolve the Funnel name over public DNS (`dig @1.1.1.1`), then `curl --resolve` from a host **off** the tailnet's MagicDNS: expect 200 on `/blog`, and 403 or 404 on `/`, `/dashboard` and `/api/health`.

## 6. D4 design: service moves

Each service moves in its own short window: stop the grackle copy, start on crow, verify, keep the grackle copy restorable until W5. Ports and Serve entries are added to `docs/developers/port-allocation.md` **only if** they come from a bundle compose (CI `check-ports`). Host-level services go in the lab docs instead.

### 6.1 black-swan embed switch (W1)
1. A one-shot `upsertProvider` on black-swan for `crow-embed` → `http://100.118.41.122:8004/v1`, **without a bundle_id**: the same pattern used on crow and r4 on 09-24. black-swan can reach crow `:8004` (verified 200).
2. `grackle-embed` set `disabled=1` on black-swan.
3. **With black-swan's code at 249d5919** (resolver: `FALLBACK_PROVIDER`), `embed_provider` also has to be set where that old resolver reads it. The plan step reads `servers/memory/embeddings.js` **on black-swan** and sets exactly the key it consults: an env var in a systemd drop-in, or the setting row. **Restart black-swan's gateway** (it's black-swan prod, so it needs a deadman: restart-if-down after 10 min).
4. Verify: one embed call through black-swan's memory path returns 1024 dimensions, and the gateway log shows no `grackle-embed`.

### 6.2 ntfy (W2)
- **On crow:** the ntfy bundle compose binds `127.0.0.1:2586`, which is free. Copy `auth.db`, `cache.db` and `server.yml` from grackle's `~/ntfy` while its container is **stopped**. Change `base-url` to `https://crow.dachshund-chromatic.ts.net:8445` (8445 is free in crow's Serve map, so only the hostname changes for clients). Add Serve `:8445 → 127.0.0.1:2586` and a ufw rule on `tailscale0` for 8445 (CLAUDE.md "ufw first" rule).
- **Repoint:**
  - crow `~/.pi/agent/settings.json` `notify.url`;
  - grackle's gateway drop-in `NTFY_EXTRA_TOPICS` (it goes with grackle);
  - the crow gateway's ntfy settings, if any point at grackle (checked in the plan step);
  - phones re-subscribe (Kevin).
- **Rollback:** start grackle's container and revert `notify.url`.

### 6.3 Blog Funnel (inside W3, after the import)
- Add three `--set-path` entries (§5.4).
- Remove `crow-blog-grackle` from `~/.claude.json`. The existing `crow-blog` MCP already targets crow.
- **grackle's Funnel** (`/blog` → `:3002`) is turned off with `tailscale funnel --set-path=/blog off` on grackle when a shell is available. It's harmless if grackle is unreachable, and it dies with the Tailscale node in W5.
- The landing page doesn't link the grackle URL (inventory §4.4), so nothing external needs repointing.

### 6.4 Home Assistant (W4a, Kevin present)
- A host-net container on crow (`:8123`, free) with a stopped-copy of `~/homeassistant/config` (87 MB).
- **Same L2 LAN** (crow is wired on `10.0.0.0/24`), so roomba, Samsung TV and Cast discovery keep working.
- Phones' companion apps repoint from `10.0.0.21:8123` to `10.0.0.237:8123`, or to a new Serve port if Kevin wants tailnet access.
- **Stop grackle's container first** (one Roomba/TV controller at a time).
- The `openclaw` integration is reconfigured in W4b.

### 6.5 Casa Nueva / OpenClaw (W4b, Kevin present)
1. Push `~/casa-nueva` first (ahead 1, 37 dirty; this is W0's git rescue).
2. **Stop `openclaw-gateway` on grackle BEFORE starting on crow.** There is one Discord token, so two bots must never run.
3. Copy `~/.openclaw` whole (credentials inside; covered by W0's named approval) and the user unit with its drop-ins.
4. nvm node on crow: OpenClaw ran on node v24.8 on grackle, and crow's standard is Node 24, so use crow's 24.
5. Its model already points at crow `:8003`.
6. Port `18789` is listed in port-allocation.md as "openclaw-old-docker (pre-existing)". Update that row's description in the W4 docs PR.

### 6.6 lab-maintenance, dashboard and guide pages (W4c)
- crow's `~/lab-maintenance` clone is newer. First reconcile grackle's 9 dirty files (W0 diff), then:
  - move the kh0pp cron set (inventory §3.3, minus the four dead jobs);
  - move `lab-dashboard.service` (`:5050`, free on crow) and the `grackle-dashboard.timer` generator;
  - copy the static `/var/www/html` guides.
- **Serving:** crow doesn't run nginx, so instead of a new nginx serve the dashboard and guides **through a Tailscale Serve port** (proposed `:8454 → 127.0.0.1:5050`, with the static guides served by the same Flask `status.py` or a `python -m http.server` unit). **Decision: no new nginx on crow;** one Serve port is enough.
- `http://grackle/` dies. CLAUDE.md, LAB-REFERENCE.md and the guide index move to the new URL in W5's docs pass.
- Drop grackle from `machines.conf`, `services.json` and `ports*.json`.
- `tournament-gate-reminder.sh` switches to crow's local `alerts.sh`.

### 6.7 Small moves and retirements (W4d–g)
- **home-search:** the Saturday 09:00 cron and `~/home-search-2026` move to crow.
- **KB and research data:** `sync-kb-to-crow.sh` runs once more, then `~/.knowledge-base` and `~/.research-mcp` move to crow as the live source, and the sync is dropped.
- **pi-bots (W4e):** stop `pibot-bridge@grackle.timer`, `pibot-gateways@grackle` and `pibot-discord@grackle`. On crow, set up `pibot-bridge@crow` with the Gmail env (the W0 named approval covers `/etc/crow/pibot-grackle.env`), copy `~/crow/pi-bots/grackle-assistant` (1.9 MB untracked) into crow's matching dir, then set the three imported defs to `enabled=1`.
- **Retire on grackle:** `crow-mcp-bridge`, `crow-db-backup.timer`, `crow-gateway-probe.timer`, `crow-orphan-sweep.timer`, `tailscale-cert-renew.timer`, `whisper-api`, tripweather (archive `~/claude-demo/tripweather` and `/etc/tripweather/environment` first), pi-hub (also drop `piHub.peers` grackle in crow's pi settings), ed-jobs (stop beat, then the worker, Kevin-approved), Timeshift, redis, tor, cups.
- **Samba:** grackle's `[kh0pp-home]` retires and crow's `[crow-home]` already exists. The share content is grackle's home, which W5 archives. Check penguin, magpie and the phones for a mapped `smb://100.121.254.89/kh0pp-home` and remove it (Kevin).

## 7. D5 design: retire and wipe

### 7.1 Archive (W5a)
Archive to `/mnt/external/grackle-archive/` (2.3 TB free), using inventory §10 Phase 4 as-is: personal docs, `~/.crow/tax-documents`, `arc/`, the non-git project dirs, `.crow-mpa`, the full urbit tree including OLD-BROKEN (Kevin: archive everything), `kh0pp-backups`, the pgdata tarball, research-pdfs, peims_data, the latest crow.db backup plus the incident copies, the D3 extract and report, and `~/.claude`.
- **Not the Windows C: partition.**
- Estimate: 15–25 GB.
- Each tree gets a sha256 manifest, verified on crow after the copy.
- Private material goes under `private/` (0700).

### 7.2 Revoke and clean the fleet (W5b)
- **Revoke grackle on crow and black-swan** with `crow_revoke_instance` (or the gateway API), and **confirm it sticks**: after two proxy-reload cycles, `status` still reads `revoked`. That needs A8 deployed on both.
- raven and r4 have no grackle row, so there's nothing to do there.
- Delete or disable the provider rows `grackle-embed`, `grackle-rerank` and `grackle-vision` on crow (it syncs to raven), and on black-swan directly (its replication is stalled). Check r4 as well: it's a separate identity, so its rows are edited there.
- Set `vision_profiles` to drop `default-grackle-vision`, or point it at a live vision provider if one exists (none today, so the profile list empties).
- crow's `~/.crow/env/cuda.env` `GRACKLE_*` vars and r4's `.bak` files stay as they are (inert).
- **Verify MPA:** within an hour of grackle's revoke, MPA's `last_seen_at` stops advancing. That confirms §2.2's lead and gives A8 its evidence.

### 7.3 Tailscale, SSH and docs (W5c)
- **Tailscale:** on grackle, `sudo tailscale serve reset`, `sudo tailscale funnel reset`, then `sudo tailscale logout`. Then delete the node in the admin console (Kevin).
- **SSH:** remove the `kh0pp@grackle` key line from `authorized_keys` on crow, black-swan and raven (and on colibri, mockingbird and penguin if present). Remove `~/bin/grackle` everywhere it's deployed. Retire `~/bin/colibri`'s dead `id_rsa_grackle` reference, or fix it as separate housekeeping.
- **claude-config:** remove the grackle entry from `machines.sh`, the CLAUDE.md network table, the Serve table, the Samba section and the grackle sudo-password mention, and LAB-REFERENCE's grackle sections. Run `deploy.sh all` (and magpie pulls). The CLAUDE.md edit is in Kevin's private config, so show him the diff first.
- **Crow repo:** the remaining `grackle` mentions in code (inventory §0.1: about 78 files) are a separate host-neutral cleanup PR, not D5. D1 already removed the functional defaults. List them in the report.

### 7.4 Wipe (W6)
**Kevin's explicit OK is required**, given after:
- W5 is verified;
- a **7-day soak**, during which nothing on crow, black-swan, raven or r4 references grackle (a grep of the last 7 days of logs shows no 100.121.254.89 connections);
- Kevin confirms nothing on the Windows C: partition needs rescuing (his 09-24 decision was not to archive it).

**Method:**
1. Boot a live USB.
2. `nvme format /dev/nvme0n1 --ses=1` (user-data erase across all 7 partitions), or `--ses=2` (crypto erase) if `nvme id-ctrl` reports support.
3. Verify with `nvme id-ns` and with a read of the first and last GiB.
4. Fallback if format is unsupported: `blkdiscard -s`, then `blkdiscard`.

**The USB Seagate** is wiped **only if** Kevin sells it with the box. His 09-22 decision was that "the Seagate stays with Kevin", but the 09-22 inventory still lists it as an open question. Ask him to confirm.

## 8. Decisions

### 8.1 Mine (under the standing autonomy grant; listed for review)
1. W0 rescue moves before everything (§2.1). ntfy moves before D3 (deadman alerts).
2. The importer runs offline with the gateway stopped; emits go through the outbox and are delivered by the drain on boot. No hand SQL.
3. Ramble player data is imported, insert-or-ignore, with a balance delta shown at go/no-go.
4. Tables with no owner in the repo (pir/capstone/pipeline, tax, crowclaw) go into an archive extract and are never created in crow.db.
5. Bundle-owned tables crow lacks (media, data-dashboard) go into the extract by default. They are imported only if Kevin installs the bundle.
6. pi_bot_defs import disabled and are enabled after grackle's bridge stops.
7. Memory emits are gated on a per-peer id-range check. The fallback is no emit (D2 propagates later).
8. The W3 deadman restores the gateway only. A DB rollback is manual.
9. No nginx on crow; the lab dashboard goes on Serve `:8454`.
10. ollama, MinIO and the model caches are dropped (empty or re-downloadable). pgdata and the ed-jobs dump are archived.

### 8.2 Kevin's (NEEDS_DECISION)
See the stream report. In short:
- **(a)** when he's reachable for W0 (grackle needs a stable link: a cable, or the console) and for W3 (a 2-hour slot, sudo on crow);
- **(b)** sudo authorization for W3 and W5;
- **(c)** confirm the Ramble import, plus the ramble install on crow during W3 (A6);
- **(d)** media and data-dashboard: install on crow and import, or archive only;
- **(e)** travel-planner: into the repo, or archive;
- **(f)** the named approval for each credential copy in W0;
- **(g)** the Seagate: keep or sell (confirm);
- **(h)** Windows C: nothing to rescue (confirm);
- **(i)** the wipe OK after the 7-day soak;
- **(j)** the HA phone URL: LAN only, or a tailnet Serve port.

## 9. Risks

| risk | mitigation |
|---|---|
| grackle's link dies mid-copy | W0 gets it onto a cable first. The backup is checksummed on both ends, and everything after the copy works from crow's copy. |
| A revoke doesn't stick (A8) | W3 is gated on A8 being deployed, and the revoke is re-verified after two reload cycles. |
| Memory id collision on peers | id-range gate, falling back to no emit (§4.2) |
| A stdio MCP server writes crow.db mid-import | the importer refuses on any holder (§5.3) |
| Auto-update restarts the gateway mid-window | no merges scheduled in the window, and the CROW-SCHEDULE row is written before it starts |
| Two Discord bots or two HA instances | stop on grackle first, always (§6.4, §6.5) |
| Silent alert loss | every deadman sends ntfy plus email |
| Wiping something unarchived | 7-day soak, manifest verification, and Kevin's explicit OK |
