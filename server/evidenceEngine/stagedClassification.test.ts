import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateClassificationStages, stage } from './stagedClassification';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

const collection = (overrides: Partial<EvidenceCollectionReport> = {}): EvidenceCollectionReport => ({
  sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false, fieldsPresent: ['channel_name', 'video_titles'], reasonCodes: [], providers: [], ...overrides
});
const evidence = (id: string, partial: Partial<EvidenceItem>): EvidenceItem => ({
  id, source: 'video_metadata', polarity: 'POSITIVE', category: 'METHODOLOGY_CONCEPT', fact: id,
  rawMatches: ['price action'], confidence: 90, reliability: 'HIGH', reliabilityMultiplier: .85,
  rawWeight: 10, finalWeight: 8.5, timestamp: '2026-01-01T00:00:00Z', ...partial
});

test('confirmation requires a semantic candidate and independent corroboration', () => {
  const items = [
    evidence('method', { provenance: { provider: 'video_metadata', type: 'method', matchedTerm: 'price action', sourceRef: 'v1', fields: [{ field: 'video_title', index: 0, publishedAt: '2026-01-01' }] } }),
    evidence('instrument', { source: 'channel_metadata', category: 'INSTRUMENT', rawMatches: ['futures'], provenance: { provider: 'channel_metadata', type: 'instrument', matchedTerm: 'futures', sourceRef: 'bio', fields: [{ field: 'channel_bio' }] } })
  ];
  const report = evaluateClassificationStages({ channel_name: 'A', description: 'Futures education', videos: [{ title: 'Price action', published_at: '2026-01-01' }] }, items, collection());
  assert.equal(report.lifecycleAction, 'CONFIRM');
  assert.equal(stage(report, 'CORROBORATION').disposition, 'PASS');
  assert.deepEqual(stage(report, 'CORROBORATION').fields.map(field => field.field).sort(), ['channel_bio', 'video_title']);
});

test('one incidental field abstains rather than turning score into confirmation', () => {
  const report = evaluateClassificationStages({ channel_name: 'A', description: '' }, [evidence('single', {})], collection());
  assert.equal(report.lifecycleAction, 'REVIEW');
  assert.equal(stage(report, 'CORROBORATION').disposition, 'ABSTAIN');
});

test('missing evidence enriches and affirmative dominant contradiction rejects', () => {
  assert.equal(evaluateClassificationStages({ channel_name: '', description: '' }, [], collection({ sufficiency: 'MISSING', reasonCodes: ['NO_CLASSIFIABLE_METADATA'] })).lifecycleAction, 'ENRICH');
  const negative = evidence('gaming', { polarity: 'NEGATIVE', category: 'IRRELEVANT_DOMAIN', rawMatches: ['gaming'], finalWeight: -30 });
  assert.equal(evaluateClassificationStages({ channel_name: 'Games', description: 'gaming' }, [negative], collection()).lifecycleAction, 'REJECT');
});

test('provider degradation remains observable without vetoing sufficient independent evidence', () => {
  const items=[evidence('method-a',{provenance:{provider:'video_metadata',type:'method',matchedTerm:'price action',sourceRef:'v1',fields:[{field:'video_title',sourceId:'v1'}]}}),evidence('method-b',{provenance:{provider:'video_metadata',type:'method',matchedTerm:'price action',sourceRef:'v2',fields:[{field:'video_title',sourceId:'v2'}]}})];
  const report = evaluateClassificationStages({ channel_name: 'A', description: 'context' }, items, collection({ degraded: true, reasonCodes: ['PROVIDER_COVERAGE_DEGRADED'] }));
  assert.equal(stage(report, 'AVAILABILITY').disposition, 'PASS');
  assert.equal(stage(report, 'AVAILABILITY').metrics.degraded,true);
  assert.equal(report.lifecycleAction, 'CONFIRM');
});
