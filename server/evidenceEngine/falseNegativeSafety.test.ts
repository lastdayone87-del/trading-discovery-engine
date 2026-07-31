import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceBasedTradingEngine } from './index';
import type { EvidenceProvider } from './types';
import { ChannelMetadataProvider } from './providers/ChannelMetadataProvider';
import { CountryKnowledgeProvider } from './providers/CountryKnowledgeProvider';
import { DiscordProvider } from './providers/DiscordProvider';
import { ExternalLinkProvider } from './providers/ExternalLinkProvider';
import { GeminiSemanticProvider } from './providers/GeminiSemanticProvider';
import { MultilingualContextProvider } from './providers/MultilingualContextProvider';
import { VideoMetadataProvider } from './providers/VideoMetadataProvider';

const deterministicEngine = () => new EvidenceBasedTradingEngine([
  new ChannelMetadataProvider(),
  new VideoMetadataProvider(),
  new ExternalLinkProvider(),
  new CountryKnowledgeProvider(),
  new MultilingualContextProvider(),
  new DiscordProvider()
]);

test('reviewed French false negative is preserved as insufficient rather than verified non-trading', async () => {
  const decision = await deterministicEngine().evaluateChannel({
    channel_name: 'Benjamin Deleuze - Trading',
    description: '',
    video_titles: [],
    country: 'France'
  });

  assert.equal(decision.status, 'UNCERTAIN');
  assert.equal(decision.evidenceCollection.sufficiency, 'INSUFFICIENT');
  assert.equal(decision.evidenceCollection.sparseMetadata, true);
  assert.equal(decision.totalPositiveWeight, 0);
  assert.equal(decision.totalNegativeWeight, 0);
  assert.match(decision.mathematicalJustification, /absence of a vocabulary match is not negative evidence/i);
});

test('completely missing metadata is distinguished from sparse but classifiable metadata', async () => {
  const decision = await deterministicEngine().evaluateChannel({ channel_name: '', description: '', country: 'France' });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.equal(decision.evidenceCollection.sufficiency, 'MISSING');
  assert.ok(decision.evidenceCollection.reasonCodes.includes('NO_CLASSIFIABLE_METADATA'));
});

test('rich unmatched metadata is sufficient to inspect but remains uncertain without explicit evidence', async () => {
  const decision = await deterministicEngine().evaluateChannel({
    channel_name: 'Créateur indépendant',
    description: 'Une chaîne spécialisée avec des explications détaillées publiées chaque semaine pour sa communauté.',
    video_titles: ['Leçon approfondie numéro un', 'Leçon approfondie numéro deux'],
    country: 'France'
  });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.equal(decision.evidenceCollection.sufficiency, 'SUFFICIENT');
  assert.equal(decision.totalNegativeWeight, 0);
});

test('low static-vocabulary video coverage is not fabricated into negative evidence', async () => {
  const decision = await deterministicEngine().evaluateChannel({
    channel_name: 'Communauté spécialisée',
    description: '',
    video_titles: ['Lecture matinale des graphiques', 'Préparation de séance en direct', 'Bilan des opérations'],
    country: 'France'
  });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.equal(decision.negativeEvidence.some(item => item.category === 'MULTI_VIDEO_CONSISTENCY'), false);
});

test('explicit irrelevant-domain evidence still produces a precise non-trading decision', async () => {
  const decision = await deterministicEngine().evaluateChannel({
    channel_name: 'Cuisine avec Benjamin',
    description: 'Recette de cuisine, pâtisserie et cuisine française chaque semaine.',
    video_titles: ['Macarons et gâteaux', 'Recette de crêpes'],
    country: 'France'
  });
  assert.equal(decision.status, 'NON_TRADING');
  assert.ok(decision.negativeEvidence.some(item => item.category === 'IRRELEVANT_DOMAIN'));
  assert.match(decision.mathematicalJustification, /Explicit negative-domain evidence/i);
});

test('provider failures are observable degradation and never become negative evidence', async () => {
  const failingProvider: EvidenceProvider = {
    name: 'gemini_semantic',
    async collectEvidence() { throw new Error('synthetic provider outage'); }
  };
  const engine = new EvidenceBasedTradingEngine([failingProvider]);
  const decision = await engine.evaluateChannel({ channel_name: 'Unrecognized creator', description: '', country: 'France' });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.equal(decision.evidenceCollection.degraded, true);
  assert.equal(decision.evidenceCollection.providers[0].availability, 'FAILED');
  assert.match(decision.evidenceCollection.providers[0].reason || '', /synthetic provider outage/);
  assert.equal(decision.negativeEvidence.length, 0);
});

test('not-applicable and unavailable providers are reported separately from failures', async () => {
  const priorKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const engine = new EvidenceBasedTradingEngine([
      new VideoMetadataProvider(), new ExternalLinkProvider(), new DiscordProvider(), new GeminiSemanticProvider()
    ]);
    const decision = await engine.evaluateChannel({ channel_name: 'Sparse creator', description: '', country: 'France' });
    const states = Object.fromEntries(decision.evidenceCollection.providers.map(item => [item.provider, item.availability]));
    assert.equal(states.video_metadata, 'NOT_APPLICABLE');
    assert.equal(states.external_links, 'NOT_APPLICABLE');
    assert.equal(states.discord_metadata, 'NOT_APPLICABLE');
    assert.equal(states.gemini_semantic, 'UNAVAILABLE');
    assert.equal(decision.evidenceCollection.degraded, true);
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  }
});
