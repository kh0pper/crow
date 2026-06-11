# W3-3 — Non-technical health view + first-success moment

**Date:** 2026-06-11
**Finding:** W3-3 in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md). Vision anchor: **layered disclosure** — the operator-confirmed canonical example is exactly this surface ("a plain-language notice with a one-click fix; the curious can open a layer down"). Inventory (2026-06-11) confirmed: all signals already exist server-side; nest is fully i18n'd; notifications plumbing exists; nothing marks onboarding complete.

## Part 1 — Status strip + detail on the nest home

**New module** `servers/gateway/dashboard/panels/nest/health-signals.js`:
`collectHealthSignals(db)` → `{ ok: boolean, issues: [{id, severity: 'warn'|'info', label, actionLabel, actionHref}], details: [{id, label, value, state: 'ok'|'warn'|'info'|'off'}] }` — every signal wrapped in try/catch (a failing signal becomes state 'off', never throws), 30s module-level cache (same pattern as the docker cache in nest/data-queries.js).

Signals (reuse the existing sources; NO new polling of docker/peers beyond what nest already queries):
| id | Source | ok | warn |
|---|---|---|---|
| `disk` | existing os/df logic from `/api/health` (`gateway/index.js:1012-1030` — extract or re-call cheaply) | ≥10% free | <10% free → "Disk space is low" |
| `storage` | `MINIO_ENDPOINT` unset → state 'off' ("not set up", info-only, NOT a warning); set → `isAvailable()` | reachable | configured but unreachable → "File storage isn't responding" |
| `agents` | `SELECT COUNT(*) FROM pi_bot_defs WHERE enabled=1` | always ok (count display) | — |
| `peers` | `crow_instances` status/last_seen_at (already loaded for the carousel — reuse) | all online or none paired | paired peer unseen >24h → info "Peer X hasn't been seen since …" |
| `updates` | `auto_update_*` keys in dashboard_settings | current | latest>current → info "An update is available" (auto-update normally handles it) |
| `backup` | newest file mtime in `CROW_BACKUP_DIR` (default `~/.crow/backups`) | <7 days | none ever → info "Backups aren't set up yet" + link; >7 days → warn "Last backup was N days ago" |

**Rendering** (in `nest/html.js`, new section ABOVE the panel grid): a one-line strip — green check + `t("health.allgood")` ("Everything looks good" / "Todo funciona bien") when `ok`, else amber + plain-language issue lines each with its action link (`<a>` to the relevant panel/setting; backup gets a "Run backup now" POST button wired to a small dashboard route that invokes the existing backup logic server-side — reuse `routes/admin-backup.js`'s core by extracting its handler body into an exported function, keeping the localhost route untouched). `<details>` element (native, keyboard-accessible) holds the detail grid built from F6a `statCard`/`statGrid`/`badge`. `aria-live="polite"` on the strip. All strings i18n'd en+es.

## Part 2 — Health monitor → plain-language notifications

In the gateway (next to the existing schedule executor start), a 15-minute `setInterval` (unref'd, kill switch `CROW_DISABLE_HEALTH_MONITOR=1`) calling `collectHealthSignals` and creating a notification (`createNotification`, type `'system'`, priority high for warns) for each **newly-degraded** warn-severity issue. Dedupe: persist `health_last_notified` (JSON `{issueId: epoch}`) in dashboard_settings; re-notify the same issue at most every 24h. Info-severity issues never notify (visible on the strip only). First run delayed 2 minutes after boot (don't fire during startup churn).

## Part 3 — First-success moment

1. **Completion flag:** reaching the onboarding `done` step sets `onboarding_completed_at` (dashboard_settings) if absent.
2. **Done step upgrade:** subtle celebration consistent with the design system (CSS-only — e.g. a brief check-mark pop animation; no libraries) + three "what to try first" action cards (F6a components): store a first memory (→ AI chat or memory panel), create an agent (→ Bot Builder), connect your AI client (→ Connect panel). i18n en+es.
3. **Post-setup redirect:** after FIRST password creation (the setup flow in `dashboard/index.js` — read where it redirects today), redirect to `/dashboard/onboarding` when `onboarding_completed_at` is absent. NO redirect on ordinary visits (existing operators are never nagged).

## Constraints

- Strip render budget: signals must add ≤50ms p50 to nest render (cache + cheap queries; the docker/peer data is already fetched by nest).
- No schema changes (dashboard_settings keys only). Fleet-safe; deploy = pull + restart (no init-db needed).
- The monitor must never crash the gateway (every cycle fully try/caught) and never send through pi-bot channels — dashboard/ntfy notifications only (createNotification's existing path).

## Testing

- `tests/health-signals.test.js`: stubbed-db collectHealthSignals — backup-stale threshold math, MINIO-unset → info not warn, failing signal → 'off' not throw, cache behavior (injectable now()).
- `tests/health-monitor-dedupe.test.js`: dedupe window logic (pure function extracted — `shouldNotify(lastMap, issueId, now)`).
- Onboarding flag: extend an existing onboarding test if present, else a small route-level test of the done step setting the flag.
- Full suite green; disposable-instance boot shows the monitor armed + nest renders with the strip; post-deploy manual check on the real dashboard.
