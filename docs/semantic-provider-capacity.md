# Semantic provider capacity — Phase 1 + 2

Status: implemented in this PR (Phase 1 + 2). This document covers
the production configuration corrections (Phase 1) and the provider-resilience
code that makes them durable (Phase 2). It supersedes any earlier assumption
that all Gemini keys belonged to one Google Cloud project.

## What was wrong

Three independent faults combined into a capacity outage:

1. **Gemini quota labels were shared.** Five keys from five separate Google
   Cloud projects were labelled `google-project-prod`. The ledger therefore
   treated them as one quota pool: one project's daily 429 cooled every key.
2. **Groq organization restrictions aborted failover.** Groq returns HTTP 400
   with `organization_restricted` when a key belongs to a different
   organization than the request requires. The old classifier mapped every 400
   to `PERMANENT_INPUT`, which is job-scoped, so failover stopped at the first
   restricted key instead of trying independent keys.
3. **The primary provider selector was unset.** Production ran the paid Gemini
   path as primary while its free-tier daily quota was exhausted, so enrichment
   queued indefinitely instead of using the healthy Groq routes.

## Phase 1 — production configuration

Applied in Coolify and verified in the running container:

- `SEMANTIC_PROVIDER=groq` (Groq primary; the only keyed fallback is free-tier
  Gemini, which requires `GEMINI_FREE_API_KEY`. Paid Gemini keys are not part
  of this chain; `SEMANTIC_PROVIDER_FORCE_GEMINI=true` is the rollback path).
- Restricted Groq keys removed; healthy slots renumbered so route discovery
  sees only usable keys. Route IDs are assigned by sorted configured slot;
  after removal `groq-6`/`groq-7` map to the surviving `_14`/`_17` keys.
- Each Gemini key has a distinct quota label (`gemini-project-1` … `-5`).
  Keys from separate Google Cloud projects have independent quotas and must
  never share a label.
- Worker counts are unchanged: 4 search workers and 3 enrichment workers.
  Capacity work must be measured before those defaults change.

## Phase 2 — provider resilience

### Typed provider failures

`ProviderCallError` now carries:

| Field | Meaning |
|---|---|
| `routeScoped` | Failure belongs to one key/project; another route may succeed. |
| `retryAfterMs` | Provider-declared retry delay. |
| `cooldownUntilMs` | Absolute epoch-ms reset for the exhausted window. |
| `quotaScope` | `DAILY` or `MINUTE`. Daily quotas never use the minute clock. |
| `quotaId` | Bounded Google quota identifier for triage (never a credential). |

`classifyProviderError` extracts Google `RetryInfo.retryDelay` and
`QuotaFailure.quotaId` from SDK error envelopes. A daily quota without a retry
delay falls back to the next midnight Pacific, evaluated with the actual DST
offset at the reset instant. These fields are persisted as bounded
`request_metadata` keys (`cooldownUntilMs`, `retryAfterMs`, `quotaScope`,
`quotaId`, `routeScoped`, `providerReasons`) so every replica reads the same
window from `provider_call_events`.

### Groq

- **Route quarantine.** HTTP 400 `organization_restricted` marks that org
  disabled for `GROQ_RESTRICTED_ROUTE_TTL_MS` (default one hour). The route is
  filtered before pacing/fetching, so later calls do not spend time or quota on
  a known-dead credential. Quarantine is in-process; telemetry records the
  event so operators and other replicas can see it.
- **Route-scoped failover.** HTTP 400 `organization_restricted` quarantines the
  organization, so its sibling routes are skipped. A 401/403 credential
  rejection skips only the rejected key: sibling keys and independent orgs may
  still serve. JSON-validation failures are capped by attempted route count
  (below) and may retry a same-org sibling. An error carrying an explicit org
  still advances even when the failing route differs.
- **Content-failure cap.** Invalid or missing model JSON repeats across accounts
  at temperature 0, so failover stops after
  `GROQ_JSON_VALIDATION_MAX_ROUTES` (default 2) and lets the caller use its
  deterministic fallback.
- **Prompt budget.** `GROQ_MAX_PROMPT_CHARS` (default 24,000) and the
  script-aware `GROQ_MAX_PROMPT_TOKENS` (default 6,000) shorten document text
  while keeping every field reference. Text shrinks to zero before the request
  is allowed to exceed either budget; if the fixed references alone cannot fit,
  the call fails closed with `GROQ_PROMPT_BUDGET_EXCEEDED` instead of sending an
  oversized request. `contextTruncated` tells the model the evidence set is
  partial, and all citations stay attributable. The token bound matters for
  CJK/Thai evidence, where one character can cost one token.
- **Pool exhaustion.** When every route is quarantined, the caller receives a
  bounded `GROQ_ROUTE_POOL_DISABLED` error with the earliest route's remaining
  TTL. A mixed cooling/quarantined pool reports the earliest route availability
  as a deferral instead of claiming the pool is disabled.

### Gemini

- A rejected credential (401/403) is route-scoped: only the rejected key is
  skipped; sibling keys and independent projects still serve.
- Daily-quota cooldowns are authoritative. Capacity decisions, the in-process
  free-tier gate, and the persisted cooldown resolvers use `cooldownUntilMs`
  when present, so a daily 429 is not retried every 90 seconds. A daily window
  that has already passed is not extended by the generic per-minute or
  vocabulary-suppression clocks.
- Per-org cooldown lookups continue to match only rows tagged with that org.
  Untagged rows cool no account.

## Monitoring

`GET /api/provider-metrics` now includes `routeHealth`:

```json
{
  "semanticProvider": "groq",
  "groq": {
    "routeCount": 7,
    "missingOrgLabels": [],
    "routes": [
      { "route": "groq-1", "org": "slot-1", "status": "healthy",
        "cooldownRemainingMs": 0, "disabledRemainingMs": 0,
        "persistedCooldownUntilMs": null }
    ]
  },
  "gemini": {
    "routeCount": 5,
    "missingOrgLabels": [],
    "routes": [
      { "route": "gemini-1", "org": "gemini-project-1", "status": "cooling",
        "cooldownUntilMs": 1762579200000, "cooldownRemainingMs": 3600000 }
    ]
  },
  "recentFailures": [
    { "provider": "groq", "route": "groq-1", "org": "slot-1",
      "status": "CREDENTIALS_EXHAUSTED", "error_class": "CREDENTIALS_EXHAUSTED",
      "cooldown_deferral": false, "events": 2, "route_disabled_events": 2 }
  ]
}
```

Status values are `healthy`, `cooling` (provider 429 window), and `disabled`
(restricted-route quarantine). Local cooldown-deferral echoes are excluded from
cooldowns and reported as `cooldown_deferral: true` rows instead of fresh
failures. Ledger aggregates are cached for 15 seconds (the dashboard polling
interval); in-process route state stays live. The endpoint is read-only,
credential-free, and authorized by the existing `providers.metrics.read` policy.

Key events to watch:

- `CREDENTIALS_EXHAUSTED` with `GROQ_ORGANIZATION_RESTRICTED` — remove/rotate
  that route; the org is quarantined for one hour.
- `GROQ_ROUTE_POOL_DISABLED` — every route is quarantined; check recent
  restrictions before waiting for the TTL.
- `RATE_LIMIT` with `quotaScope=DAILY` — the project is out until
  `cooldownUntilMs` (next Pacific midnight at the latest).
- `GROQ_JSON_VALIDATION_FAILED` / `GROQ_SEMANTIC_CONTENT_INVALID` — model output
  problem, not capacity; the deterministic fallback should take over.

## Rollback and knobs

| Variable | Default | Purpose |
|---|---|---|
| `SEMANTIC_PROVIDER` | unset (Gemini) | `groq` selects Groq primary. |
| `SEMANTIC_PROVIDER_FORCE_GEMINI` | unset | Immediate kill switch back to Gemini. |
| `GROQ_RESTRICTED_ROUTE_TTL_MS` | `3600000` | Restricted-route quarantine. |
| `GROQ_JSON_VALIDATION_MAX_ROUTES` | `2` | Content-failure route cap. |
| `GROQ_MAX_PROMPT_CHARS` | `24000` | Semantic prompt character budget. |
| `GROQ_MAX_PROMPT_TOKENS` | `6000` | Script-aware semantic prompt token budget. |
| `GROQ_RATE_LIMIT_COOLDOWN_MS` | `90000` | Per-org 429 cooldown. |
| `GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS` | `90000` | Per-org fallback cooldown. |

Rollback is configuration-only: unset `SEMANTIC_PROVIDER` or set
`SEMANTIC_PROVIDER_FORCE_GEMINI=true`, then restart. No migration or data
change is required.

## Test coverage

Targeted tests (`node --import tsx --test server/providerResilience.test.ts
server/evidenceEngine/providers/GroqSemanticProvider.test.ts
server/evidenceEngine/providers/GeminiSemanticProvider.test.ts`) cover:

- Google daily-quota extraction, retry-delay parsing, Pacific-midnight fallback
  across both DST transitions, and declared-cooldown precedence.
- Semantic and vocabulary capacity deferral on a declared daily cooldown.
- Groq restricted-key classification, independent-org failover,
  same-org sibling suppression, quarantine TTL skip, pool-disabled reporting,
  JSON-validation route cap, and prompt-cap citation preservation.
- Gemini route-scoped credential failover to an independent account.

## Risks and expected effects

- **Quarantine is per process.** A restart forgets the TTL and retries a
  restricted route once; that is bounded to one attempt and is intentional
  (signals a fixed credential quickly). Persisted telemetry still records it.
- **Prompt capping reduces evidence text, not references.** The model sees
  `contextTruncated=true`; very large evidence sets may classify with less
  descriptive detail instead of failing the whole batch.
- **Groq free-tier limits still apply.** Seven routes do not create unlimited
  throughput; pacing and per-org cooldowns remain, and worker counts stay at 4/3
  until measurements show headroom.
- **Expected improvement:** no more all-429 loops from shared labels, failover
  across independent Groq/Gemini accounts, daily quota windows respected, and
  route-level health visible without log access.
