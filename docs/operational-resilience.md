# Provider-pool and dashboard operational resilience

## YouTube quota exhaustion

YouTube acquisition uses a process-local pool circuit breaker. Individual project
rotation is unchanged. The breaker opens only when **every** configured project
returns Google's `quotaExceeded` (including `dailyLimitExceeded`) reason. Mixed
transport, credential, input, or quota failures retain the pre-existing retry path.

While open, acquisition performs no YouTube requests. After
`YOUTUBE_POOL_BACKOFF_MS` (default 15 minutes), exactly one acquisition is admitted
as a probe. A successful response closes the breaker and emits one recovery log.
Another complete quota result doubles the delay, capped by
`YOUTUBE_POOL_MAX_BACKOFF_MS` (default six hours). No Google reset time is assumed.
An indeterminate failed probe also extends the window: only a successful provider
response is sufficient evidence to resume acquisition.
The state is deliberately process-local: it adds no coordination dependency and
does not alter durable jobs, result ordering, key rotation, or replay inputs. A
restart safely resets the optimization and may produce one bounded pool probe.
Durable jobs deferred by the open breaker are scheduled directly at the probe time
without consuming their attempt budget. Thus an extended provider outage cannot
turn queued discovery work into terminal failures; payloads and idempotency keys
remain unchanged.

Roll out with the defaults and alert on the single `acquisition suspended` and
`acquisition resumed` transition messages. Increase the initial delay if projects
remain exhausted; decrease it when faster recovery detection is more valuable.
Rollback consists of reverting the circuit-breaker change (there is no schema or
data migration). The trade-off is that each replica can make its own probe; shared
persistent state would reduce probes further but would add coordination and failure
modes disproportionate to this hardening task.

## Dashboard host validation

Vite continues to validate Host headers. The canonical Railway production domain
is explicitly allowed, and additional trusted domains can be supplied as a
comma-separated `VITE_ALLOWED_HOSTS` value. Localhost behavior remains Vite's
default. Rollback is removal of the environment value/code entry; no deployment
data changes are involved. Note that the built production server serves static
files through Express, while this allowlist also protects deployments that run the
Vite middleware path.
