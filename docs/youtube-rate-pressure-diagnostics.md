# YouTube runtime rate-pressure diagnostics

When YouTube returns a real runtime request-rate failure (`rateLimitExceeded`, `quotaExceeded=false`), the request scheduler emits a redacted `runtime-rate-pressure-diagnostic` trace.

The trace includes:

- non-reversible provider fingerprint (`ytp-xxxxxxxx`), never API-key text;
- HTTP status and sanitized provider reason codes;
- actual spacing since the previous scheduler dispatch;
- current adaptive target spacing;
- rolling 429 count over the configured pressure window (60 seconds by default);
- number of distinct affected provider fingerprints in that window;
- scheduler priority lane.

The existing YouTube outbound trace prefix identifies the logical operation/acquisition, so production logs can distinguish:

1. one provider repeatedly failing (project/provider-specific pressure),
2. several providers failing in the same window (shared runtime/egress pressure), or
3. failures concentrated in one operation family (operation-specific pressure).

Daily project quota exhaustion is intentionally excluded from these runtime-pressure metrics.

This change is diagnostic only. It does not raise the current adaptive pacing ceiling or change provider selection, daily-quota handling, discovery queries, enrichment concurrency, or classification behavior.
