# Low-audience dashboard visibility

`SKIPPED_LOW_AUDIENCE` is an acquisition-budget state, not a semantic rejection.

Required operator behavior:

- 1–29 subscriber channels remain stored and auditable.
- They remain excluded from deeper enrichment for that run.
- They should not be mixed into the normal/default Channels table.
- They should remain retrievable when the operator explicitly selects a `SKIPPED_LOW_AUDIENCE` / low-audience filter.
- Hidden/unavailable subscriber counts continue normal processing and are not placed in this bucket.

This document records the serving requirement separately from runtime rate-pressure diagnostics so the dashboard change can be implemented and validated independently.
