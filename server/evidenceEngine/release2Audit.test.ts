import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('Phase 3 dual-write is observational, failure-contained, and linked after immutable diagnostics', async () => {
  const [diagnostics, dual, settings] = await Promise.all([
    read('../classificationDiagnostics.ts'), read('./dualWrite.ts'), read('../db/migrations/055_evidence_documents_and_assertions.sql')
  ]);
  assert.match(diagnostics, /persistClassificationEvidenceBundle[\s\S]+\.catch/);
  assert.match(dual, /servingAuthority:\s*false/);
  assert.match(settings, /dual_write_enabled','false'/);
});

test('Phase 3 exposes V2 contracts and compatibility adapters without replacing production providers', async () => {
  const [types, adapter, index] = await Promise.all([read('./documentTypes.ts'), read('./providerV2.ts'), read('./index.ts')]);
  assert.match(types, /EvidenceProviderV2/);
  assert.match(adapter, /LegacyEvidenceProviderV2/);
  assert.match(adapter, /assertionsToLegacyEvidenceItems/);
  assert.match(index, /new ChannelMetadataProvider/);
});

test('Phase 3 separates search context and does not begin Release 3', async () => {
  const [canonical, semantic, ingestion] = await Promise.all([
    read('./canonicalEvidencePlane.ts'), read('./providers/GeminiSemanticProvider.ts'), read('../ingestionPipeline.ts')
  ]);
  assert.match(canonical, /search_match_context/);
  assert.match(semantic, /search_match_context/);
  assert.match(semantic, /\.filter\(document=>!/);
  assert.match(ingestion, /search_match_context:candidate.matchedDocument/);
  const migrations = await readdir(new URL('../db/migrations/', import.meta.url));
  assert.ok(migrations.includes('055_evidence_documents_and_assertions.sql'));
  assert.ok(migrations.includes('056_evidence_coverage_snapshots.sql'));
  assert.equal(migrations.includes('057_creator_focus_classification.sql'), false);
});

test('Phase 3 keeps the research graph assertion schema intact and exposes read-only evidence inspection', async () => {
  const [migration, server] = await Promise.all([read('../db/migrations/055_evidence_documents_and_assertions.sql'), read('../../server.ts')]);
  assert.match(migration, /classification_evidence_assertions/);
  assert.match(migration, /pre-existing evidence_assertions/);
  for (const route of ['/api/evidence-documents', '/api/evidence-assertions', '/api/evidence-coverage']) assert.ok(server.includes(route), route);
});
