# Box ledger (synthetic test fixture)

Made-up rows in the shapes a real ledger uses. No real hosts or people.

## Rules

| when | what |
|---|---|
| 2026-10-26 09:00 → 10:00 | not a reservation: this table is not under Reservations |

## Reservations (active + upcoming)

| when (local) | what | owner | how it runs | clear WHEN |
|---|---|---|---|---|
| **2026-10-26 (Mon) now → est. 1.5 h, hard stop 2026-10-26 22:30 (CPU only, no GPU)** | **Render the turntable stills** | alex (render lane) | a capped unit | when the stills exist |
| **2026-10-26 (Mon) 21:00 → 22:50 (second box only)** | **Long-context profiling window** | second user | a deadman timer | at 22:50 |
| **2026-10-27 (Tue) 21:00 → 04:00 Wed (GPU evicted once)** | **Overnight [benchmark](https://example.com/run) sweep** | alex | a capped unit | when the report is written |
| **2026-10-27 (Tue) 08:00 → cap 45 min (CPU only)** | **Full test suite** | alex | `npm test` | when it finishes |
| **2026-10-27 (Tue) now → cap 2 h** | **Docs build** | alex | a script | when it is built |
| **2026-10-28 (Wed) 09:30 → est. ~3 h (network only)** | **Model download** | second user | a script | when verified |
| 2026-10-28 13:00 → end of day | Disk check | alex | by hand | when done |
| **2026-10-29 (Thu) 07:00 ARMED, starts when the copy lands** | **Archive copy** | alex | a unit | when copied |
| 2026-09-10 10:15 → ONGOING (standing service) | Speech service on the second box | alex | a service | never |
| **2026-10-20 (Tue) from ~now, multi-session (CPU only)** | **Lane B worktrees** | alex | worktrees | when the lane ends |
| **2026-10-14 (Wed) 19:00 → until Stage 3 completes (~early Nov); nights only** | **Stage 3 queue** | alex | a queue | when the queue drains |
| **2026-10-02 (Fri) — W4 HELD BY THE OWNER (not scheduled)** | **Decommission step 4** | alex | by hand | when approved |
| **2026-10-24 (Sat) 09:00 → 17:00 (on demand)** | **Weekend helper** | alex | a timer | at 17:00 |
| **2026-10-26 (Mon) 18:00 → 18:30** | **Short check** | alex | by hand | at 18:30 |
| next week sometime | Undated idea | alex | — | — |
| ~~**2026-10-26 (Mon) 10:00 → cap 40 min**~~ | ~~**Cleared window**~~ | alex | a unit | done |
~~| **2026-10-26 (Mon) 11:00 → cap 45 min** | **Cleared by a leading strike** | alex | a unit | done |
| ~~2026-10-25 (Sun) 16:05 → 16:24~~ **DONE** | **Done window** | alex | a unit | done |
| **2026-10-26 (Mon) 23:05 → ~15 min (attended)** | **Reboot to apply a kernel flag** | alex | by hand | when it is back |

## Standing automations

| when | what |
|---|---|
| 02:30 daily | the nightly audit |
