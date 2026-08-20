# Phases 1–12 final hardening audit

The final review retained the established authority boundaries: Phase 8 allocates,
Phase 9 governs retrieval and continuation, and Phase 12 only observes persisted
lineage. No scheduler, lifecycle, policy authority, or default-on path was added.

## Corrected P2: evaluation coverage watermark consistency

Phase 12 selected cohort revisions at a captured `source_watermark`, but its four
historical coverage anti-joins could read observations classified after that
watermark. A concurrent or later revision could therefore change country,
language, concept, or source-family expansion without belonging to the cohort or
its checksum.

All four lookbacks now apply the same immutable classification watermark as the
cohort query. Unit coverage guards the SQL contract, and the PostgreSQL regression
inserts later-visible historical evidence, materializes on both sides of the
boundary, and checks cohort membership, checksum, and all coverage dimensions.

The fix is query-only and requires no schema migration; migration 109 remains the
schema head.
