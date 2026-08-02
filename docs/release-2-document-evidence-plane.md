# Release 2 document evidence plane

Release 2 implements Phase 3 only. It adds an immutable, document-attributed
classification evidence plane behind default-off dual-write controls. It does
not implement creator-focus classifier v4, change classification thresholds,
change dashboard admission, or begin the gap-specific scheduler.

## Compatibility and serving safety

- Existing evidence providers and the staged classifier remain the production
  serving path.
- `LegacyEvidenceProviderV2` exposes the new acquire/derive contract while the
  assertion compatibility adapter round-trips the exact legacy `EvidenceItem`.
- Document persistence starts only after the immutable production classification
  diagnostic is written. A dual-write failure is contained and cannot modify or
  roll back the classification decision.
- Both `evidence_document_dual_write_enabled` and
  `evidence_assertion_dual_write_enabled` default to `false`.
- Every Release 2 result has no serving authority. Rollback disables dual writes;
  immutable observations remain available for replay and audit.

## Evidence identity and independence

- Documents are subject-bound, field-aware, checksummed, and source-family
  attributed. A changed document creates a different key; a retry is idempotent.
- Search-match context is a separate document and is excluded from the semantic
  classifier input. It cannot masquerade as channel About evidence.
- A video's title, description, and known transcript share its source family.
- Search matches and unresolved playlist containers do not count as independent
  corroboration. Multiple providers interpreting one document still contribute
  one independent document family.
- Provider failure and unsupported coverage remain observable coverage facts,
  not positive or negative evidence.

## Schema naming

The repository already owns an `evidence_assertions` table for the research
evidence graph. Phase 3 therefore uses `classification_evidence_assertions` to
avoid a destructive or ambiguous schema collision.

## Controls and verification

| Setting | Default |
| --- | --- |
| `evidence_document_dual_write_enabled` | `false` |
| `evidence_assertion_dual_write_enabled` | `false` |

Verification requires `npm test`, `npm run lint`, `npm run build`, migration
application in a PostgreSQL environment, and the Phase 3 independent audit tests.
