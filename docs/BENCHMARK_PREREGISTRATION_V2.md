# Frozen Benchmark Specification / Preregistration v2

**Status: PREREGISTRATION ONLY — no benchmark has been executed under this specification.**
**Do not modify this document after benchmark execution begins. Any change requires a new spec version.**

- Benchmark specification version: `benchmark-preregistration-v2`
- Supersedes (does not modify): `docs/BENCHMARK_PREREGISTRATION.md` (`benchmark-preregistration-v1`, frozen, byte-unchanged).
- Engine base (frozen): `fed806fc3965b64d9925fbaa0e9b0c6c65e21e41` (current `origin/main`; recorded as the v2 frozen base (record exact SHA in the execution record; the runner records `runningCommit` explicitly — no silent later commit).

## 1. What changes from v1

Exactly the following versioned literals, and nothing else:

| Item | v1 value | v2 value |
|---|---|---|
| Spec version | `benchmark-preregistration-v1` | `benchmark-preregistration-v2` |
| Scope size (`BENCHMARK_PREREG_SCOPE_SIZE`) | `300` | `120` |
| Pool rules version | `pool-rules-benchmark-prereg-v1` | `pool-rules-benchmark-prereg-v2` |
| Selection experimentId | `benchmark-prereg-v1-selection` | `benchmark-prereg-v2-selection` |
| Ordering experimentId | `benchmark-prereg-v1-ordering` | `benchmark-prereg-v2-ordering` |
| Pool opportunity prefix | `benchmark-prereg-v1:pool:` | `benchmark-prereg-v2:pool:` |
| Runner log/out namespace | `benchmark-prereg-v1` | `benchmark-prereg-v2` (out dir `./benchmark-prereg-v2`) |

New v2 identities guarantee zero observation collisions with any v1 execution, past or future.

## 2. Why scope 120 (the complete rationale, fixed before execution)

- §9-equivalent floor (unchanged from v1): minimum 30 eligible *attributed* observations per reported arm (CONTROL/THOMPSON/CONTEXTUAL); arms below minimum report `INSUFFICIENT_SAMPLE — no comparison`.
- The frozen assignment is approximately 50% CONTROL / 25% THOMPSON / 25% CONTEXTUAL — not three equal arms. Correct arithmetic: at exclusion rate e, expected attributed per arm is SCOPE × (1−e) × share. For 120: CONTROL stays viable to e ≤ 50%, but **each treatment arm needs e ≈ 0%** (120 × 1.0 × 0.25 = 30 exactly).
- Plain consequence: 120 keeps CONTROL viable under moderate exclusions and gives both treatments a chance only on unusually clean executions. Treatment-arm `INSUFFICIENT_SAMPLE` is a likely terminal outcome, not an edge case.
- Why 120 anyway: it is the largest scope consistently plannable on observed production states (eligible floor 128 across the census window; data ceiling ~186), and the smallest scope at which CONTROL retains its §9 minimum under up to 50% exclusions. Larger values were never observed plannable; smaller values surrender CONTROL's margin for no methodological gain.
- **Explicitly accepted risk:** treatment arms will likely complete with `INSUFFICIENT_SAMPLE` unless runtime exclusions stay near zero. That is a valid terminal outcome under the unchanged analysis rules, not a protocol violation. A repeat would be a new execution with full disclosure of all runs, never a silent replacement.

## 3. Everything else frozen (identical to v1)

Assignment math (§6-equivalent), all §7 parameters, gates and defaults, exclusion rules, UCB1 control, arms/basis-points/priors/weights, stopping rules (14-day ceiling, coded caps only), failure/exclusion handling, analysis rules (descriptive only, no statistical claims), provenance requirements, production-safety posture. No tuning, no threshold/parameter/gate changes, no favorable selection of any kind.

## 4. Validation before freezing (no benchmark run)

- `npx tsc --noEmit` (full-project typecheck).
- Contract/unit suites: `querySelectionExperiments`, `retrievalExperiment`, `discoveryFrontierTrials`, `relationshipCanary`, `benchmarkPreregFindings.contract`, `benchmarkPreregV1` tests.
- CI workflows covering touched paths.
- A `--plan` dry-run is part of validation only insofar as it proves plumbing; the authorizing plan is produced fresh at execution time.

## 5. V1 coexistence (implementation)

- v1 names, values, and defaults are untouched: the runner defaults to `--spec-version v1` (byte-identical v1 behavior, existing tests unmodified and passing), the hot path recognizes both versions' exact frozen identities, and snapshot/record builders default to the v1 spec. v2 is selected explicitly and flows its own identities, scope, prefix, and log tag end to end. No v1 observation can acquire v2 attribution or vice versa.

## 6. Enforced execution safeguards

- Same-day plan: `--execute` refuses unless the plan snapshot's `collectedAt` is today (UTC) — `isSameUtcDayPlan`.
- Stopped scheduler: `--execute` refuses unless the `autonomous_discovery` scheduler row reads `is_enabled=false AND is_running=false`, in addition to the pre-existing live-lease check — `isSchedulerStoppedForBenchmark`. Stopping the scheduler is a production configuration change requiring separate explicit authorization (and restoration afterwards).

## 7. Authorization record

- v2 drafted on branch `benchmark-prereg-v2` from `origin/main` (`fed806fc`); PR opened, NOT merged, awaiting explicit review + execution authorization.
- `--execute` additionally requires: a successful same-day `--plan`, stopped autonomous scheduler (production config change, separately authorized), and a write-capable database path.
