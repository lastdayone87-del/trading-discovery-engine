import assert from 'node:assert/strict';
import test from 'node:test';
import { VideoMetadataProvider, isExplicitCreatorTradingText } from './evidenceEngine/providers/VideoMetadataProvider';
import { getLayeredKnowledgeContext } from './evidenceEngine/knowledgePacks';
import { evaluateClassificationStages } from './evidenceEngine/stagedClassification';
import { ConfigurableWeightedStrategy } from './evidenceEngine/scoringEngine';

function creatorInput(titles: string[]) {
  return {
    channel_name: 'Strategie di Trading',
    description: '',
    country: 'Italy',
    enrichment_stage: 1,
    video_titles: titles,
    video_descriptions: titles.map(() => ''),
    videos: titles.map((title, index) => ({
      id: `video-${index}`,
      title,
      source_family_id: `family-${index}`,
      source_entity_id: 'creator-1'
    }))
  } as any;
}

test('explicit creator-owned trading titles count as trading-focused after enrichment', async () => {
  const context = getLayeredKnowledgeContext('Italy');
  const titles = [
    'Strategia di Trading per questa settimana',
    'Trading Live - apertura europea',
    'Errori da trader da evitare',
    'Trading: come preparo la sessione',
    'Live Trading mattutino',
    'Trading e gestione della posizione',
    'Routine del trader',
    'Aggiornamento mercati',
    'Commento settimanale',
    'Domande e risposte'
  ];
  const input = creatorInput(titles);
  const evidence = await new VideoMetadataProvider().collectEvidence(input, context);
  const consistency = evidence.find(item => item.category === 'MULTI_VIDEO_CONSISTENCY');
  assert.ok(consistency, 'repeated trading uploads should emit consistency evidence');
  assert.equal(consistency!.confidence, 70);

  const collection = {
    sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false,
    fieldsPresent: ['video_titles'], reasonCodes: [], providers: [],
    terminalNegativeSufficiency: { status: 'INSUFFICIENT', creatorLevelCoverage: false, independentSourceFamilies: 0, independentObservations: 0, reasonCodes: [] }
  } as any;
  const stages = evaluateClassificationStages(input, evidence, collection);
  assert.equal(stages.stages.find(stage => stage.stage === 'CANDIDATE_DETECTION')?.disposition, 'PASS');
  assert.equal(stages.stages.find(stage => stage.stage === 'CORROBORATION')?.disposition, 'PASS');
  assert.equal(stages.lifecycleAction, 'CONFIRM');
  const decision = new ConfigurableWeightedStrategy().evaluateDecision(evidence, context, 'Italy', collection, stages);
  assert.equal(decision.status, 'TRADING_CONFIRMED');
});

test('trading-card usage does not become financial trading evidence', async () => {
  const context = getLayeredKnowledgeContext('United States');
  assert.equal(isExplicitCreatorTradingText('Pokemon trading cards opening and grading', context), false);
  const titles = Array.from({ length: 10 }, (_, index) => `Pokemon Trading Cards opening episode ${index + 1}`);
  const evidence = await new VideoMetadataProvider().collectEvidence(creatorInput(titles), context);
  assert.equal(evidence.some(item => item.category === 'MULTI_VIDEO_CONSISTENCY'), false);
});
