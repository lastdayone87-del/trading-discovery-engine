# Semantic classification scale improvements (Phase 4)

> Status: implemented behind safe defaults. Phase 4 is independent of the
> Phase 1+2 provider-resilience PR and the Phase 3 search/classification
> decoupling PR; it applies to the semantic provider path and the enrichment
> worker startup regardless of which of those ships first.

## 1. Scope and constraints

The approved Phase 4 policy allows scale work only after measurement:

- No new infrastructure purchase or hardware upgrade. Everything below runs on
  the existing deployment.
- Search concurrency stays at 4 workers. Phase 4 does not change it.
- Enrichment starts at 3 workers. A request for more is clamped to 3 unless
  durable measurements prove semantic success > 90 %, p95 < 30 s, and a stable
  ENRICH backlog. The hard ceiling is 6.
- Batched semantics groups independent channels into one prompt (default
  maximum 8, operator clamp 2–10). Batching is opt-in.
- The semantic cache key is `input_checksum + promptVersion + featureVersion +
  modelVersion + adjudicator model/flag + batch prompt version + repair prompt
  version + provider request settings` (plus provider and cache version).
- The deterministic prefilter is shadow-first and must be validated for false
  negatives before enforcement.

## 2. Components

### 2.1 Semantic result cache

Files: `server/evidenceEngine/semanticResultCache.ts`,
`server/classificationInputChecksum.ts`, migration
`169_semantic_classification_cache.sql`.

- Stores only the final parsed semantic model result, never a whole
  classification decision. Deterministic providers and the normal decision
  policy run on every evaluation, so a cache hit cannot freeze a stale
  evidence decision.
- Key: SHA-256 over the cache version, model-facing prompt fingerprint,
  provider name, prompt version, feature version, candidate model version,
  adjudicator model version, adjudication-enabled flag, batch prompt version
  (when batching is enabled), the Groq citation-repair prompt version, and the
  Groq request settings that change the model-facing call (prompt caps,
  completion allowance, reasoning effort).
  The fingerprint covers exactly the declared country/language hints and
  bounded documents serialized into the prompt: `job_id`/`run_id`,
  audience counters, retrieval-only documents, and corpus entries past the
  prompt limit are excluded, so a recheck under a new job can hit; any
  evidence the model can actually see, or any prompt/model/repair/request
  settings change, is a miss. The producing
  `batch_prompt_version` is also stored as a column so a superseded batch can
  be purged by version. The diagnostic envelope records
  `input_checksum_version: canonical-json-v1` beside every new fingerprint so
  rows written with the earlier insertion-order hash remain distinguishable.
- Fail-open: a missing migration, database outage, or structurally invalid row
  is a miss. A corrupt row is validated before it is counted, deleted rather
  than replayed, and can never reach evidence construction. Three consecutive
  cache failures open a 60-second process-local circuit so a doomed connection
  cannot slow every classification. Every read/write is also bounded by the
  caller's abort signal and `SEMANTIC_RESULT_CACHE_TIMEOUT_MS` (default 500 ms).
  Injected test/shadow clients never read or write the production cache.
- Only a structurally complete result with at least one citation is written.
  A missing/partial model reply and an uncited abstention stay out of the cache
  so a later attempt can recover instead of replaying a degenerate result.
- Writes are `ON CONFLICT (cache_key) DO NOTHING`: the first stored result wins,
  and a concurrent duplicate evaluation cannot rewrite it.
- Hits increment `hits` and set `last_hit_at` for measurement.

**Retention.** Migration 169 does not install an automatic purge. Rows are
small and keyed by evidence; stale rows simply stop being read. Trim manually
when needed (safe because the cache is never authoritative). Retain by last
use, not creation, so a frequently hit entry is not purged merely for age:

```sql
DELETE FROM semantic_classification_cache
WHERE COALESCE(last_hit_at, created_at) < now() - interval '90 days';
```

### 2.2 Deterministic semantic prefilter

Files: `server/semanticPrefilter.ts`, provider `availability()` methods.

Modes (`SEMANTIC_PREFILTER_MODE`):

| Mode | Behavior |
|------|----------|
| `off` | No evaluation, no behavior change. |
| `shadow` (default) | Evaluate and count; **always** call the semantic provider. |
| `enforce` | A confident `WITHHOLD_SEMANTIC` decision makes semantic providers report `NOT_APPLICABLE`. |

Policy is precision-first. A single finance/trading lexicon signal (English,
Spanish/Portuguese, French, German/Dutch, Italian, Nordic/Polish, Japanese,
Korean, Chinese, Arabic, Cyrillic, Hindi, or a known finance link) vetoes
withholding. Only an explicit unrelated-domain cue (gaming, cooking, music,
beauty/entertainment, sports, lifestyle/travel), a stale-and-inactive channel,
or a thin low-audience surface can withhold. Unmodeled or empty context is
always classified.

Enforcement skips **only** the semantic call. Deterministic providers, evidence
construction, and the decision policy still run, so a withheld channel is never
automatically rejected.

**Runtime false-negative gate.** In shadow mode every withheld channel still
receives a semantic verdict, and the provider records whether that verdict was
positive (`ACTIVE_TRADING` / `INVESTING_EDUCATION`). The enrichment diagnostics
endpoint reports `phase4.semanticPrefilter.shadowComparisons`,
`shadowFalseNegatives`, and up to 20 `recentFalseNegatives` samples. Switch to
`enforce` only when this real-traffic evidence shows no unexplained false
negatives. The static labeled sample in `server/semanticPrefilter.test.ts`
additionally pins zero false negatives across the supported market languages
while withholding at least 30 % of the labeled unrelated sample.

Counters are process-local, reset on restart, and are per replica. They are
diagnostic evidence, not a durable ledger.

### 2.3 Batched semantic classification

Files: `server/evidenceEngine/semanticBatch.ts`, provider candidate calls.

- Opt-in: `SEMANTIC_BATCH_CLASSIFICATION_ENABLED=false` by default.
- Coalesces independent requests by provider client group and model over a
  bounded window (`SEMANTIC_BATCH_WINDOW_MS`, default 400 ms, clamped to
  0–2000 ms), up to `SEMANTIC_BATCH_MAX_SIZE` (default 8, clamp 2–10) and a
  serialized prompt budget (`SEMANTIC_BATCH_MAX_PROMPT_CHARS`, default
  120,000 characters, clamp 20,000–400,000). The window is paid out of the
  stage-0 semantic attempt budget (2 s aggregate), so the default leaves most
  of the attempt for inference and the clamp prevents a configured window from
  outlasting the attempt; raise it only when quota, not latency, is the
  bottleneck. Oversized batches are split before dispatch, and a single
  oversized prompt travels alone so it can only fail itself.
- The batch prompt declares an explicit array schema, one result per input, in
  input order, with per-channel citations and an instruction never to merge
  evidence across inputs. Groq's completion allowance scales with batch size.
- If a batch exceeds Groq's prompt budget, nested document text (including the
  structured evidence inside a citation-repair request) is shortened in place:
  every batch member and every field reference survives, and the repair
  instructions plus the embedded request stay separated by the shared marker
  and re-serialized as parseable JSON. A raw prompt without that structure is
  shortened at its tail; `contextTruncated` marks the partial evidence.
- Each array element is parsed independently and structurally validated. A
  missing/invalid element falls back to a single call for **that channel
  only**. A malformed whole-batch container (not an array or `{results:[...]}`)
  fails the entire batch instead of turning one provider call into N+1.
- A whole-batch provider failure rejects every member without a per-channel
  retry storm; normal job retry policy owns recovery.
- Caller aborts are honored while queued and in flight. Replacing the
  scheduler configuration cancels queued work instead of leaving an orphaned
  timer behind.
- Citation repair routes through the same scheduler, so independent Groq
  repairs can share one provider call. The repair prompt version is part of
  the cache identity.
- With batching disabled, the provider call path is unchanged.

### 2.4 Per-account Gemini capacity

File: `server/providerResilience.ts`.

Independent Gemini keys belong to separate Google Cloud projects with their own
quotas, so callers are serialized per account, not globally:

- Two-key advisory lock: `pg_try_advisory_lock($1, hashtext($2))` with
  `$2 = geminiOrg`; unlock uses the same pair. Independent projects proceed in
  parallel. A `hashtext` collision can only serialize two accounts
  (performance, not correctness).
- Pacing (`GEMINI_ORG_MIN_INTERVAL_MS`, default 6000 ms; legacy
  `GEMINI_GLOBAL_MIN_INTERVAL_MS` stays honored) and rate-limit cooldown reads
  are strictly scoped to the serving account's `geminiOrg` tag.
- Rolling token bucket: when `GEMINI_ORG_MAX_CALLS_PER_MINUTE` calls have
  occurred inside `GEMINI_ORG_RATE_WINDOW_MS` (default 60 s), the call defers
  with `GEMINI_ORG_TOKEN_BUCKET_EMPTY` instead of sleeping a worker. `0`
  disables the bucket. Deferral carries the account so retry scheduling can use
  that account's window.
- Untagged legacy rows cool no account (fail-open for at most one window after
  deploy, after which every semantic path tags its rows).

Groq capacity, cooldowns, and route quarantine are unchanged.

### 2.5 Measured enrichment scale gate

Files: `server/enrichmentScaleGate.ts`, `server/queueManager.ts`.

Startup resolves the requested worker count. A request at or below the
baseline of 3 starts directly. A request above 3 loads durable metrics and is
clamped to 3 unless **all** pass:

| Measurement | Threshold |
|-------------|-----------|
| Semantic sample (configured health window, default 2 h, non-cancelled) | at least 50 calls |
| Semantic success rate | strictly > 90 % |
| Semantic p95 latency (successful calls) | strictly < 30 s |
| ENRICH pending + processing | at most 500 |
| Backlog stability (1 h completed/created) | at least 0.9, or no creations and pending within cap |

On success the effective count is capped at 6. Any metrics/query error fails
closed to 3, and the metrics wait itself is bounded by
`ENRICHMENT_SCALE_METRICS_TIMEOUT_MS` (default 5000 ms): a stalled query or
connection resolves to baseline workers instead of leaving the pool stopped.
The gate is re-evaluated on each process start; a running process
never changes its worker count. `ENRICHMENT_SCALE_GATE_ENABLED=false` is the
operator rollback that restores the raw explicit environment value (skipping
the metrics load entirely), still capped at the approved hard ceiling of 6.
The diagnostics block reports the live what-if decision separately from
`runningWorkers`, so a passing live decision is never mistaken for the
currently running pool.

## 3. Configuration

| Variable | Default | Purpose / rollback |
|----------|---------|--------------------|
| `SEMANTIC_RESULT_CACHE_ENABLED` | `true` | `false` bypasses all cache reads and writes. |
| `SEMANTIC_RESULT_CACHE_TIMEOUT_MS` | `500` | Per-read/write bound; non-positive or blank falls back to 500. |
| `SEMANTIC_PREFILTER_MODE` | `shadow` | `off` disables; `enforce` skips semantic calls for confident unrelated domains. |
| `SEMANTIC_PREFILTER_STALE_DAYS` | `730` | `0` disables the staleness rule. |
| `SEMANTIC_PREFILTER_MIN_SUBSCRIBERS` | `50` | Low-audience thin-surface threshold. |
| `SEMANTIC_BATCH_CLASSIFICATION_ENABLED` | `false` | `true` enables coalescing. |
| `SEMANTIC_BATCH_MAX_SIZE` | `8` | Clamped 2–10. |
| `SEMANTIC_BATCH_WINDOW_MS` | `400` | Clamped 0–2000; must fit the 2 s attempt budget. |
| `SEMANTIC_BATCH_MAX_PROMPT_CHARS` | `120000` | Serialized batch budget, clamped 20000–400000; oversized batches split before dispatch. |
| `GEMINI_ORG_MIN_INTERVAL_MS` | `6000` | Per-account pacing. |
| `GEMINI_ORG_MAX_CALLS_PER_MINUTE` | `10` | Per-account rolling bucket; `0` disables. |
| `GEMINI_ORG_RATE_WINDOW_MS` | `60000` | Rolling window length. |
| `ENRICHMENT_SCALE_GATE_ENABLED` | `true` | `false` restores the raw explicit worker count. |
| `ENRICHMENT_WORKER_CONCURRENCY` | unset (3) | Above 3 only takes effect when the gate passes or is disabled. |
| `ENRICHMENT_SCALE_MIN_SUCCESS_RATE` | `0.9` | Gate threshold. |
| `ENRICHMENT_SCALE_MAX_P95_MS` | `30000` | Gate threshold. |
| `ENRICHMENT_SCALE_MIN_SAMPLE` | `50` | Gate sample floor. |
| `ENRICHMENT_SCALE_MAX_PENDING` | `500` | Gate backlog cap. |
| `ENRICHMENT_SCALE_MIN_COMPLETION_RATIO` | `0.9` | Gate stability ratio. |
| `ENRICHMENT_SCALE_METRICS_TIMEOUT_MS` | `5000` | Startup bound on the gate's metrics read; timeout falls back to 3 workers. |
| `ENRICHMENT_SCALE_METRICS_WINDOW_HOURS` | `2` | Provider sample window for success rate/p95; clamped 1–24. Widen when traffic is sparse; a fixed 24 h window keeps old outages in the denominator after recovery. |

Production defaults at merge time: Groq remains the primary semantic provider,
cache on, prefilter shadow, batching off, scale gate on, and enrichment at 3.

## 4. Rollout sequence

1. **Deploy.** Migration 169 applies automatically during database
   initialization (`server/dbCore.ts`). The cache fails open if the table is
   briefly unavailable.
2. **Observe cache and shadow prefilter for 24–48 h.** Confirm cache hits are
   increasing, no classification regressions appear in semantic success/p95,
   and the ENRICH backlog is unchanged or falling.
3. **Review `recentFalseNegatives` and `shadowFalseNegatives`.** Any withheld
   channel that the model called `ACTIVE_TRADING` or `INVESTING_EDUCATION` is a
   false negative. Tighten the lexicon/rules or keep `shadow`; do not enforce
   with unexplained samples.
4. **Switch `SEMANTIC_PREFILTER_MODE=enforce`** only after step 3 is clean.
   Watch semantic call volume and the withdrawal reason distribution.
5. **Enable batching** (`SEMANTIC_BATCH_CLASSIFICATION_ENABLED=true`) only
   after quota headroom and success rate are validated. Compare per-channel
   outcome quality and p95 latency against the unbatched window before keeping
   it on.
6. **Request 6 enrichment workers** only when the gate's measurements pass for
   a sustained window and the backlog stays stable after the change. Never
   raise search concurrency as part of this phase; it requires its own
   measurement.

## 5. Monitoring

Diagnostics endpoint: `GET /api/diagnostics/enrichment-backlog` (operator
authenticated). The `phase4` block contains the process-local prefilter
snapshot, cache totals, scale metrics, and the gate decision.

Semantic success and latency by provider:

```sql
SELECT provider,
       COUNT(*)::int AS calls,
       COUNT(*) FILTER (WHERE status='SUCCESS')::int AS successes,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status='SUCCESS') / NULLIF(COUNT(*),0), 2) AS success_pct,
       ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
             FILTER (WHERE status='SUCCESS'))::int AS p95_ms
FROM provider_call_events
WHERE operation='multilingual-semantic-classification'
  -- Match the gate's configured health window (default 2 h). Use
  -- ENRICHMENT_SCALE_METRICS_WINDOW_HOURS to widen it.
  AND occurred_at > now() - interval '2 hours'
  AND status <> 'CANCELLED'
GROUP BY provider
ORDER BY calls DESC;
```

Groq route/org pressure:

```sql
SELECT request_metadata->>'groqOrg' AS org,
       COUNT(*) FILTER (WHERE status='RATE_LIMITED')::int AS rate_limited,
       COUNT(*) FILTER (WHERE status='SUCCESS')::int AS successes,
       COUNT(*) FILTER (WHERE status='PERMANENT_ERROR')::int AS permanent_errors
FROM provider_call_events
WHERE provider='groq'
  AND operation='multilingual-semantic-classification'
  AND occurred_at > now() - interval '1 hour'
GROUP BY 1
ORDER BY rate_limited DESC;
```

Per-account Gemini bucket usage (attempts in the rolling window):

```sql
SELECT request_metadata->>'geminiOrg' AS org,
       COUNT(*)::int AS calls_last_minute
FROM provider_call_events
WHERE provider='gemini'
  AND occurred_at > now() - interval '1 minute'
  AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true'
GROUP BY 1
ORDER BY calls_last_minute DESC;
```

Deferrals never reach Google, so they create no real quota consumption. They
do emit a provider row tagged `geminiCapacityDeferral=true`, which the pacing
and rolling-bucket reads exclude; otherwise queued retries could keep a full
account full forever. Inspect retry scheduling instead:

```sql
SELECT COUNT(*)::int AS jobs_waiting_on_org_capacity
FROM jobs
WHERE type='ENRICH_CHANNEL'
  AND last_error LIKE '%GEMINI_ORG_TOKEN_BUCKET_EMPTY%'
  AND updated_at > now() - interval '1 hour';
```

Cache effectiveness (cumulative hits; entries hit recently):

```sql
SELECT COUNT(*)::int AS entries,
       COALESCE(SUM(hits),0)::int AS cumulative_hits,
       COUNT(*) FILTER (WHERE last_hit_at > now() - interval '24 hours')::int AS entries_hit_24h,
       MAX(created_at) AS newest_entry_at
FROM semantic_classification_cache;
```

Cache hits per classification (approximate; reads the diagnostic evidence
reason codes):

```sql
SELECT date_trunc('hour', created_at) AS hour,
       COUNT(*)::int AS classifications,
       COUNT(*) FILTER (WHERE evidence_items::text LIKE '%SEMANTIC_RESULT_CACHE_HIT%')::int AS cache_hits
FROM production_classification_diagnostics
WHERE created_at > now() - interval '24 hours'
GROUP BY 1
ORDER BY 1;
```

ENRICH backlog and throughput: use the existing `aggregate`, `throughput`, and
`oldest` blocks from the same endpoint. Gate thresholds are evaluated against
those durable values.

## 6. Rollback

All controls are feature-flag based and additive:

| Symptom | Action |
|---------|--------|
| Cache serving stale/wrong verdicts | `SEMANTIC_RESULT_CACHE_ENABLED=false`; no restart required beyond env propagation. Cache rows remain inert. |
| Prefilter withholds a real creator | `SEMANTIC_PREFILTER_MODE=off` (or back to `shadow`). Withheld channels immediately classify again. |
| Batch quality or latency regression | `SEMANTIC_BATCH_CLASSIFICATION_ENABLED=false`. |
| Enrichment scale causes pressure | Unset `ENRICHMENT_WORKER_CONCURRENCY` (returns to 3) or set `ENRICHMENT_SCALE_GATE_ENABLED=false` and set concurrency explicitly (still capped at 6). |
| Gemini account misbehaves | Per-account cooldown/bucket already defers automatically; the account's route can be removed without affecting other projects. |

Phase 3 classification jobs are durable and remain drainable: Phase 4 adds no
new job type, and disabling cache/prefilter/batching only removes an
optimization. Migration 169 can stay applied after rollback; dropping the table
is optional and destroys only non-authoritative cache rows.

## 7. Risks and mitigations

- **Prefilter false negatives.** Highest-risk control. Mitigated by
  precision-first finance vetoes, shadow-first rollout, real-traffic
  false-negative samples, and the static labeled sample. Enforcement skips only
  semantics, never deterministic evidence or the decision policy.
- **Cache staleness.** Key covers evidence and all model-facing versions.
  Prompt, feature, model, adjudicator, or adjudication-flag changes invalidate
  automatically. The cache stores only the model result, not the decision.
- **Corrupt cache rows.** Structurally validated as a whole before counting a
  hit; anything incomplete is deleted and treated as a miss, never sent to
  evidence construction. Degenerate/uncited results are never persisted.
- **Batch schema drift or partial output.** Per-item alignment by index,
  structural item validation, explicit cardinality, per-item single-call
  fallback, and no retry storm on a malformed container or whole-batch failure.
- **Batch latency.** The coalescing window adds at most `SEMANTIC_BATCH_WINDOW_MS`
  to a request; usually the batch fills earlier. Enabled only after p95 review.
- **Advisory-lock collision.** A `hashtext` collision serializes two accounts
  (slower, not incorrect). The bucket and cooldown still read strict org tags.
- **Scale gate false pass.** Requires a minimum sample, strict success/p95
  bounds, and a stable backlog; query failure fails closed to 3. The gate never
  exceeds 6.
- **Elevated metrics cost.** Scale metrics load only at startup and when the
  diagnostics endpoint is called, not on every job.

## 8. Test evidence

Fresh runs in the Phase 4 worktree:

- New Phase 4 suites: **82 passed, 0 failed**
  (`semanticResultCache`, `semanticPrefilter`, `semanticBatch`,
  `semanticResultShape`, `geminiOrgCapacity`, `enrichmentScaleGate`).
- Provider, capacity, queue, and diagnostics regression suites: **136 passed,
  0 failed** (`providerResilience`, `geminiSemanticPacing`,
  `enrichConcurrencyDefaults`, `searchCapacityDefaults`,
  `classificationDiagnostics`, `productionIntegration`,
  `manualRecheckClassification`, `enrichmentBacklogDiagnostics`,
  `enrichmentBacklogEvidence`, `enrichmentBacklogDrain.contract`,
  `providerFailureDiagnostics`).
- Provider implementation suites: **125 passed, 0 failed**
  (`GeminiSemanticProvider`, `GroqSemanticProvider`,
  `GeminiFreeSemanticProvider`).
- Migration runner, including a unique-version guard: **2 passed, 0 failed**.
- Combined Phase 4 plus regression run: **345 passed, 0 failed**.
- `npx tsc --noEmit`: clean.
- `multilingualSemanticProvider.test.ts` retains one pre-existing
  environment-dependent assertion (`gemini-3.6-flash` vs expected
  `gemini-2.5-flash`) that reproduces identically on clean `origin/main`.
- `npm run build` fails with a rollup native `ERR_DLOPEN_FAILED` in this
  environment; the same failure reproduces on clean `origin/main`, so it is
  environmental rather than caused by this change.
