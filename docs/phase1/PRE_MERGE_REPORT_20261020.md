# Pre-merge report — Phase 1 quota/discovery hardening and hard cap

Date: 2026-10-20 · Status: **awaiting explicit merge/deploy approval**. No merge,
no deployment, no production migration, no flag/settings change, no enforcement
activation, and no probe has been performed by this session.

## Proposed heads

| Deliverable | Proposed head | Notes |
| --- | --- | --- |
| PR #531 (`phase1-hardening`) | this commit; code/test parent `8e696ed` | Based on `6267ba1`, the external #530 merge. #530 was merged by another actor, not this session. |
| Hard cap (`feat/youtube-key-hard-cap`) | docs `9ab4f35`; code/test parent `5ecd905` | Rebased on phase1 `3c53e57`. Default OFF; no new migration. |
| Hard cap storage | migrations 148 leases + 151 tombstones | 149–152 come from the external #530 merge; this feature adds no table or migration. |

## Review rounds

1. **Round 1** — reviewed `f3e5f43`; fixes landed at `64d83fb`. 83 review threads
   existed in total; 63 were already resolved/outdated before this round.
2. **Round 2** — 20 unresolved threads at `64d83fb` were triaged and resolved at
   `8e696ed`. The bot re-review acknowledged the 79/80/81/82 fixes. No third
   review round was requested.

### Dispositions of the 20 round-2 threads

| Disposition | Threads |
| --- | --- |
| Fixed or outdated with current-tree evidence | 0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 64, 79, 80, 81, 82 |
| Invalid/stale with current-tree evidence | 17 (migration numbering changed by #530), 45 (duplicate-count PostgreSQL coverage already exists) |
| P3 non-blocking follow-up | 70 (redundant screening call), 72 (metrics-only saturation counter) |
| Documented activation limitation | 77 (downstream ingestion may spend official quota; probe ledger is retrieval-only) |

All 20 threads now have evidence replies and are resolved. Thread 77 is not
claimed as fixed: the probe remains disabled, and no zero-total-official-call
claim is made.

## Tests and evidence

- `npx tsc --noEmit`: clean at `8e696ed` and hard-cap `5ecd905`.
- Phase 1 quota CI ([39500041358](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39500041358)):
  **33/33 unit**, **11/11 PostgreSQL**, 0 skipped.
- Rollback CI ([39500041456](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39500041456)):
  pass; pre-state 145; zero schema/constraint diffs; constraints sha256
  `870ec871…d3dee`, schema sha256 `140cc55b…7ea`.
- Affected local suites: **68/68** (rendered controls, recovery, quota replay,
  dbCore quota, probe executor). Browser fallback CI
  ([39500053124](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39500053124)) green.
- Hard-cap CI ([39501810518](https://github.com/lastdayone87-del/trading-discovery-engine/actions/runs/39501810518)):
  **51/51 unit**, **21/21 PostgreSQL**, 0 skipped. This run did not enable or
  deploy enforcement.
- The full `npm test` sweep is not a gate for this PR: it currently has broad,
  pre-existing failures in unrelated legacy/environment-dependent contract
  suites. The changed-path suites above are the targeted gate.

## Residual issues / limitations

- **PR Agent is red only on `API_KEY_INVALID`** from the Gemini provider. The
  job log shows the authentication failure; this is infrastructure, not a code
  finding. It is not claimed as passing.
- **Probe downstream quota (thread 77):** `defaultIngestChannel` delegates to
  normal ingestion, whose official calls use the normal quota path. The probe
  ledger counts retrieval only. The probe is disabled and must not be activated
  until downstream official spend is measured and separately approved.
- **P3 follow-ups:** 70 (redundant `evaluateTermQualityFlags` call) and 72
  (saturation counter can overcount non-persisted/duplicate directives). Neither
  changes queue, provider, or persistence correctness.
- **GCP suspension investigation:** read-only and still access-blocked. No cause
  is claimed; exact missing access is recorded in
  `GCP_SUSPENSION_DIAGNOSTIC_20261020.md`.
- **Production state:** no production read-only verification or migration was
  performed. CI and shadow evidence are not production proof.
- **Local PostgreSQL:** unavailable on this host; the `postgres:17` CI service
  is the database proof.

## Gates still closed

Merge, deploy, production migration apply, app-settings/flag changes, hard-cap
enforcement activation, queue unpause/resume, and any probe remain **not
approved**. Activation of the hard cap additionally requires migrations 148 and
151 to be applied and `youtube_key_daily_cap_enforced=true` set only after
explicit approval; default/absent means OFF.
