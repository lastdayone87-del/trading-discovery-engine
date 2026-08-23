# Migration 119 invariant

Only an `ENRICH_CHANNEL` job terminalized by `INVESTIGATION_DEADLINE_EXCEEDED` is recoverable when the same investigation step has a durable prior `STEP_RETRYING` event whose `failureClass` is one of the retryable infrastructure/provider classes recognized by the runtime. Semantic terminal channels remain excluded.
