# Post-implementation startup and provider-resilience review

## Scope and root cause

This review covers HTTP startup, `/api/health`, the autonomous producer, durable
queue workers, startup maintenance, and provider initialization. Provider clients
do not perform network I/O at module load. However, queue workers previously
started as an import side effect, before Express listened. In addition, startup
awaited a database-backed purge, and the health endpoint queried schema and queue
state on every probe. A legacy country-exclusion audit was also invoked at module
load. Finally, authorization policy matching omitted Express's `/api` mount path,
so an otherwise healthy probe could be rejected before reaching the route. These
couplings made readiness depend on background or diagnostic dependencies rather
than the ability of the HTTP process to serve.

## Architectural decisions

- Readiness represents a usable HTTP/API process: the listener binds promptly,
  while `ready` is withheld until the configured database has connected,
  migrations/defaults have completed, and queue controls can be read. It never
  calls an external provider.
- The server listener is established before development middleware initialization
  and before any maintenance, scheduler, or worker is launched.
- Worker startup is explicit and idempotent. It no longer occurs during module
  import, so importing route dependencies cannot start provider-backed work.
- Startup country auditing is explicit rather than an import side effect, and
  mounted API paths are matched against their complete authorization path.
- Startup maintenance, durable workers, and the autonomous producer are launched
  only after readiness. Each launch is failure-isolated. A synchronous failure,
  rejected promise, timeout, or HTTP 429 is logged as degraded background work and
  cannot revoke HTTP readiness or terminate startup.
- Existing durable job claiming, idempotency keys, quota reservations, retry and
  backoff, ordering, replay records, and scheduler locking are unchanged. This is
  an orchestration-only change and adds no discovery behavior.

The database is a dependency of every dashboard data endpoint, worker, and
scheduler. Readiness therefore includes database initialization, while detailed
schema and queue diagnostics remain available through authenticated operational
endpoints. Provider availability is deliberately not conflated with readiness.

## Failure verification

Automated startup lifecycle coverage injects exhausted-quota (HTTP 429), provider
timeout, and synchronous provider-initialization failures. In every case the HTTP
readiness snapshot remains healthy and each background failure is contained. The
complete suite continues to cover provider retry/backoff and durable queue
semantics independently.

## Rollout considerations

1. Deploy normally and wait for `/api/health` to report HTTP 200, `ready`, and
   `database: ready`. The process binds before database initialization so Railway
   can observe it, but returns HTTP 503 until PostgreSQL connectivity, migrations,
   defaults, and queue controls have been verified. The startup log records the
   schema version and channel count from that same configured database.
2. Confirm the startup log precedes worker and autonomous-producer activity.
3. Inspect provider metrics and durable queue depth separately; provider outage
   may increase pending job age while deployment health remains green.
4. Alert on provider error/timeout rates and queue latency, not on HTTP readiness,
   for discovery degradation.
5. During a total 429 event, verify the instance remains ready, jobs retain their
   retry policy, and work resumes from the durable queue after quota recovery.

## Rollback strategy

Revert the startup-orchestration commit and redeploy. No migration, configuration
change, queue rewrite, or data repair is required. Jobs created before, during, or
after rollout use the same payloads and durable state, making rolling deployment
and rollback safe. Rolling back restores the former readiness coupling, so it
should be used only if an unrelated regression requires immediate mitigation.

## Backward compatibility

The health response retains `status: "ok"` and `readiness: "ready"` when healthy,
and all API paths, authorization policies, environment variables, worker
concurrency settings, scheduler configuration, and queue payloads are preserved.
The health response adds a redacted `database` state and remains HTTP 503 until
PostgreSQL initialization succeeds. Provider conditions still degrade discovery
instead of deployment health.
