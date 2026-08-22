import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateClassificationStages, stage } from './stagedClassification';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

const collection = (overrides: Partial<EvidenceCollectionReport> = {}): EvidenceCollectionReport => ({
  sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false, fieldsPresent: ['channel_name', 'video_titles'], reasonCodes: [], providers: [], terminalNegativeSufficiency:{status:'SUFFICIENT',creatorLevelCoverage:true,independentSourceFamilies:1,independentObservations:1,reasonCodes:['CREATOR_LEVEL_NEGATIVE_COVERAGE']}, ...overrides
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

test('video-title terminology alone remains uncertain and explains the abstention', () => {
  const weak = evidence('weak-title', {
    category: 'TERMINOLOGY',
    finalWeight: 35,
    rawWeight: 40,
    provenance: { provider: 'video_metadata', type: 'terminology', matchedTerm: 'trading', sourceRef: 'v1', fields: [{ field: 'video_title', sourceId: 'v1' }] }
  });
  const report = evaluateClassificationStages({ channel_name: 'A', description: '' }, [weak], collection());
  assert.equal(report.lifecycleAction, 'REVIEW');
  assert.equal(stage(report, 'CORROBORATION').disposition, 'ABSTAIN');
  assert.ok(stage(report, 'CORROBORATION').reasonCodes.includes('WEAK_VIDEO_TERMINOLOGY_ONLY'));
});

test('missing evidence enriches and affirmative dominant contradiction rejects', () => {
  assert.equal(evaluateClassificationStages({ channel_name: '', description: '' }, [], collection({ sufficiency: 'MISSING', reasonCodes: ['NO_CLASSIFIABLE_METADATA'] })).lifecycleAction, 'ENRICH');
  const negative = evidence('gaming', { polarity: 'NEGATIVE', category: 'IRRELEVANT_DOMAIN', rawMatches: ['gaming'], finalWeight: -30 });
  assert.equal(evaluateClassificationStages({ channel_name: 'Games', description: 'gaming' }, [negative], collection()).lifecycleAction, 'REJECT');
});

test('promotional hype cannot terminally reject overwhelming trading evidence', () => {
  const items=[
    evidence('bio',{source:'channel_metadata',category:'INSTRUMENT',finalWeight:45,rawWeight:50,provenance:{provider:'channel_metadata',type:'instrument',matchedTerm:'futures',sourceRef:'bio',fields:[{field:'channel_bio',sourceFamilyId:'about'}]}}),
    evidence('video-1',{finalWeight:42,rawWeight:46,provenance:{provider:'video_metadata',type:'method',matchedTerm:'order flow',sourceRef:'v1',fields:[{field:'video_title',sourceId:'v1',sourceFamilyId:'v1'}]}}),
    evidence('video-2',{finalWeight:40,rawWeight:44,provenance:{provider:'video_metadata',type:'method',matchedTerm:'risk management',sourceRef:'v2',fields:[{field:'video_title',sourceId:'v2',sourceFamilyId:'v2'}]}}),
    evidence('hype',{polarity:'NEGATIVE',category:'HYPE_SPECULATION',rawMatches:['guaranteed profit'],finalWeight:-26.1,rawWeight:32})
  ];
  const report=evaluateClassificationStages({channel_name:'Real Futures Trader',description:'Futures order flow education'},items,collection());
  assert.notEqual(report.lifecycleAction,'REJECT');
  assert.equal(stage(report,'CONTRADICTION').disposition,'ABSTAIN');
  assert.ok(stage(report,'CONTRADICTION').reasonCodes.includes('MIXED_EVIDENCE_TERMINAL_REJECTION_WITHHELD'));
});

test('irrelevant-domain evidence must materially dominate positive trading evidence before terminal rejection',()=>{
  const items=[
    evidence('trading',{source:'channel_metadata',category:'INSTRUMENT',finalWeight:60,rawWeight:65,provenance:{provider:'channel_metadata',type:'instrument',matchedTerm:'forex',sourceRef:'bio',fields:[{field:'channel_bio',sourceFamilyId:'about'}]}}),
    evidence('negative',{polarity:'NEGATIVE',category:'IRRELEVANT_DOMAIN',rawMatches:['gaming'],finalWeight:-30,rawWeight:35})
  ];
  const report=evaluateClassificationStages({channel_name:'Forex Creator',description:'Forex education'},items,collection());
  assert.notEqual(report.lifecycleAction,'REJECT');
  assert.equal(stage(report,'CONTRADICTION').disposition,'ABSTAIN');
});

test('provider degradation remains observable without vetoing sufficient independent evidence', () => {
  const items=[evidence('method-a',{provenance:{provider:'video_metadata',type:'method',matchedTerm:'price action',sourceRef:'v1',fields:[{field:'video_title',sourceId:'v1'}]}}),evidence('method-b',{provenance:{provider:'video_metadata',type:'method',matchedTerm:'price action',sourceRef:'v2',fields:[{field:'video_title',sourceId:'v2'}]}})];
  const report = evaluateClassificationStages({ channel_name: 'A', description: 'context' }, items, collection({ degraded: true, reasonCodes: ['PROVIDER_COVERAGE_DEGRADED'] }));
  assert.equal(stage(report, 'AVAILABILITY').disposition, 'PASS');
  assert.equal(stage(report, 'AVAILABILITY').metrics.degraded,true);
  assert.equal(report.lifecycleAction, 'CONFIRM');
});
