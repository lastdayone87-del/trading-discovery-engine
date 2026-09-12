# Benchmark Evaluation Sets (Phase 0 scaffolding)

Status: **NOT YET MEASURED.** This directory defines *what* will be measured and
*how* — no harness, no fixtures, no numbers yet. Harness + pilot fixtures are
Phase C work; nothing here executes.

## Planned suites

1. **Classification recall/precision** — frozen positive trading channels +
   negative distractors, multilingual (priority: vi, tl, ur, bn, ne, id).
2. **Offline E2E yield** — parser extraction against pre-cached frozen metadata
   payloads. Zero live network calls by definition.
3. **Deterministic discovery recall** — FOUND (pages 1–3) / DUPLICATE /
   NOT_FOUND / WRONG_MARKET / WRONG_LANGUAGE per explicit ground rules.
4. **InnerTube container benchmark** — 250 keyless description fetches from the
   Cloud Run container; record error/throttle rate before any enablement.
5. **Country-trail audit set** — excluded CONFIRMED/LIKELY channels + null-country
   UNCERTAIN sample for gate-precision review.
6. **Discord-ownership audit set** — canonical/brand/social/partner cases for
   false-association measurement.

## Fixture contract

Pilot first: 80 channels across DE, NO, SG, JP (validates the harness), then the
14-market comprehensive corpus. Every positive fixture entry must satisfy the
5-point source-validation protocol independently:

- [A] Identity linkage · [B] Domicile (`CLASS_B1_CORPORATE` /
  `CLASS_B2_INDIVIDUAL` / `CLASS_B3_PLATFORM_DECLARED` — `locationTag` alone
  never proves corporate domicile) · [C] Trading · [D] Market relevance ·
  [E] 90-day liveness

Regulatory registers prove licensing/incorporation — never channel ownership or
trading content. See `fixtures/five-point-schema.json` for the machine schema.
