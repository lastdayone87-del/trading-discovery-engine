import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiSemanticProvider, type SemanticModelClient } from './providers/GeminiSemanticProvider';
import { calibrateSemanticConfidence } from './semanticCalibration';

const knowledge = { globalInstruments: [], globalPlatformsPropFirms: [], globalAdvancedConcepts: [], globalNegativeTerms: [] };
const client = (...responses: unknown[]): SemanticModelClient => ({ classify: async () => {
  if (!responses.length) throw new Error('unexpected model call');
  return responses.shift();
}});
const trading = {
  label: 'ACTIVE_TRADING', confidence: 94, supportedLanguage: true,
  reasonCodes: ['REPEATED_EXECUTION_DISCUSSION'], explanation: 'Explains entries and exits in Spanish.', concepts: ['gestión de riesgo'],
  languages: [{ language: 'es', script: 'Latin', confidence: 98, field: 'video_title' }], citations: [{ field: 'video_title', index: 0 }]
};

test('structured multilingual semantics provide calibrated, field-cited evidence without requiring a vocabulary hit', async () => {
  const [item] = await new GeminiSemanticProvider(client(trading)).collectEvidence({ channel_name: 'Mesa Abierta', description: '', videos: [{ title: 'Así preparo entrada, salida y riesgo' }] }, knowledge);
  assert.equal(item.category, 'METHODOLOGY_CONCEPT');
  assert.equal(item.confidence, 84);
  assert.deepEqual(item.provenance?.fields, [{ field: 'video_title', index: 0, sourceId: undefined }]);
  assert.equal(item.provenance?.semantic?.taxonomyLabel, 'ACTIVE_TRADING');
  assert.equal(item.provenance?.semantic?.calibrationVersion, 'multilingual-semantic-calibration-bootstrap-1');
  assert.deepEqual(item.rawMatches, ['gestión de riesgo']);
});

test('unsupported languages explicitly abstain and never manufacture positive or negative weight', async () => {
  const unsupported = { ...trading, label: 'AMBIGUOUS', supportedLanguage: false, concepts: [], citations: [], reasonCodes: ['UNSUPPORTED_LANGUAGE'] };
  const [item] = await new GeminiSemanticProvider(client(unsupported)).collectEvidence({ channel_name: '未知', description: '未知内容' }, knowledge);
  assert.equal(item.category, 'SEMANTIC_ABSTENTION');
  assert.equal(item.finalWeight, 0);
  assert.deepEqual(item.rawMatches, []);
  assert.ok(item.provenance?.semantic?.reasonCodes.includes('SEMANTIC_MODEL_ABSTAINED'));
});

test('ambiguous first-tier results can be escalated to the versioned adjudicator', async () => {
  const previous = process.env.MULTILINGUAL_ADJUDICATION_ENABLED;
  process.env.MULTILINGUAL_ADJUDICATION_ENABLED = 'true';
  try {
    const ambiguous = { ...trading, label: 'AMBIGUOUS', confidence: 52 };
    const [item] = await new GeminiSemanticProvider(client(ambiguous, trading)).collectEvidence({ channel_name: 'Code Switch', description: 'Opero live with risk controls' }, knowledge);
    assert.equal(item.provenance?.semantic?.modelVersion, 'gemini-2.5-flash');
    assert.equal(item.category, 'METHODOLOGY_CONCEPT');
  } finally {
    if (previous === undefined) delete process.env.MULTILINGUAL_ADJUDICATION_ENABLED; else process.env.MULTILINGUAL_ADJUDICATION_ENABLED = previous;
  }
});

test('bootstrap calibration is bounded and deliberately conservative', () => {
  assert.equal(calibrateSemanticConfidence(101), 84);
  assert.equal(calibrateSemanticConfidence(70), 64);
  assert.equal(calibrateSemanticConfidence(Number.NaN), 35);
});

test('provider failures escape to the engine availability boundary', async () => {
  const failing: SemanticModelClient = { classify: async () => { throw new Error('semantic outage'); } };
  await assert.rejects(() => new GeminiSemanticProvider(failing).collectEvidence({ channel_name: 'A', description: 'rich metadata for classification' }, knowledge), /semantic outage/);
});
