import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceBasedTradingEngine } from './index';
import { hasCreatorLevelSemanticUnrelatedNegative } from './negativeEvidenceRole';
import type {
  EvidenceFieldRef,
  EvidenceItem,
  EvidenceProvider,
  EvidenceSourceType,
  RawChannelInput,
} from './types';

type Field = EvidenceFieldRef['field'];

function semanticNegative(
  id: string,
  options: {
    fields: Array<{ field: Field; sourceId?: string; sourceFamilyId?: string }>;
    calibratedConfidence?: number;
    claimPolarity?: EvidenceItem['claimPolarity'];
  },
): EvidenceItem {
  return {
    id,
    source: 'gemini_semantic',
    polarity: 'NEGATIVE',
    category: 'IRRELEVANT_DOMAIN',
    fact: 'Semantic verdict: the creator focus is unrelated.',
    rawMatches: ['unrelated'],
    confidence: 96,
    reliability: 'HIGH',
    reliabilityMultiplier: 1,
    rawWeight: 30,
    finalWeight: -30,
    claimPolarity: options.claimPolarity,
    provenance: {
      provider: 'gemini_semantic',
      type: 'IRRELEVANT_DOMAIN',
      matchedTerm: 'unrelated',
      sourceRef: 'structured-semantic:test',
      fields: options.fields,
      semantic: {
        modelVersion: 'test',
        promptVersion: 'test',
        featureVersion: 'test',
        calibrationVersion: 'test',
        taxonomyLabel: 'UNRELATED',
        rawConfidence: 96,
        calibratedConfidence: options.calibratedConfidence ?? 84,
        detectedLanguages: [],
        reasonCodes: ['PRIMARY_UNRELATED', 'OFFER_NONE', 'CONTENT_ENTERTAINMENT'],
      },
    },
    timestamp: new Date(0).toISOString(),
  };
}

const provider = (items: EvidenceItem[]): EvidenceProvider => ({
  name: 'gemini_semantic',
  async collectEvidence() { return items; },
});

const evaluate = (input: RawChannelInput, providers: EvidenceProvider[]) =>
  new EvidenceBasedTradingEngine(providers).evaluateChannel(input);

test('a top-tier semantic unrelated verdict citing a short real bio is creator-level', async () => {
  const item = semanticNegative('n1', {
    fields: [
      { field: 'channel_title', sourceId: 'title-1' },
      { field: 'channel_bio', sourceId: 'bio-1' },
    ],
  });
  const decision = await evaluate(
    { channel_name: 'Limp Bizkit - Topic', description: 'DAD VIBES' },
    [provider([item])],
  );
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.status, 'SUFFICIENT');
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.creatorLevelCoverage, true);
  assert.deepEqual(
    decision.evidenceCollection.terminalNegativeSufficiency?.reasonCodes,
    ['SEMANTIC_CREATOR_LEVEL_NEGATIVE'],
  );
  assert.equal(decision.stagedClassification?.lifecycleAction, 'REJECT');
  assert.equal(decision.status, 'NON_TRADING');
});

test('a title-only semantic negative still cannot reject', async () => {
  const item = semanticNegative('n1', { fields: [{ field: 'channel_title', sourceId: 'title-1' }] });
  const decision = await evaluate(
    { channel_name: 'Short Creator', description: '' },
    [provider([item])],
  );
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.status, 'INSUFFICIENT');
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.creatorLevelCoverage, false);
  assert.equal(decision.status, 'UNCERTAIN');
});

test('a quoted or disclaimer semantic negative still cannot reject', async () => {
  for (const claimPolarity of ['QUOTED', 'DISCLAIMER'] as const) {
    const item = semanticNegative('n1', {
      fields: [{ field: 'channel_bio', sourceId: 'bio-1' }],
      claimPolarity,
    });
    const decision = await evaluate(
      { channel_name: 'Creator', description: 'Short unrelated bio.' },
      [provider([item])],
    );
    assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.status, 'INSUFFICIENT', claimPolarity);
    assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.creatorLevelCoverage, false, claimPolarity);
    assert.equal(decision.status, 'UNCERTAIN', claimPolarity);
  }
});

test('a sub-top-tier semantic negative still cannot reject on a short bio', async () => {
  const item = semanticNegative('n1', {
    fields: [{ field: 'channel_bio', sourceId: 'bio-1' }],
    calibratedConfidence: 75,
  });
  const decision = await evaluate(
    { channel_name: 'Creator', description: 'Short unrelated bio.' },
    [provider([item])],
  );
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.status, 'INSUFFICIENT');
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.creatorLevelCoverage, false);
  assert.equal(decision.status, 'UNCERTAIN');
});

test('the legacy long-bio creator-level path still supports terminal rejection', async () => {
  const item = semanticNegative('n1', {
    fields: [{ field: 'channel_bio', sourceId: 'bio-1' }],
    calibratedConfidence: 75,
  });
  const decision = await evaluate(
    { channel_name: 'Creator', description: 'This unrelated bio is intentionally longer than the legacy forty character creator coverage threshold.' },
    [provider([item])],
  );
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.status, 'SUFFICIENT');
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.creatorLevelCoverage, true);
  assert.deepEqual(
    decision.evidenceCollection.terminalNegativeSufficiency?.reasonCodes,
    ['CREATOR_LEVEL_NEGATIVE_COVERAGE'],
  );
  assert.equal(decision.status, 'NON_TRADING');
});

test('a top-tier semantic negative does not override substantive positive trading evidence', async () => {
  const negative = semanticNegative('n1', {
    fields: [{ field: 'channel_bio', sourceId: 'bio-1' }],
  });
  const positive: EvidenceItem = {
    id: 'p1',
    source: 'video_metadata',
    polarity: 'POSITIVE',
    category: 'METHODOLOGY_CONCEPT',
    fact: 'Trading education',
    rawMatches: ['trading'],
    confidence: 90,
    reliability: 'HIGH',
    reliabilityMultiplier: 1,
    rawWeight: 24,
    finalWeight: 24,
    provenance: {
      provider: 'video_metadata',
      type: 'authentic-trading-practice',
      matchedTerm: 'trading',
      sourceRef: 'v1',
      fields: [{ field: 'video_title', index: 0, sourceId: 'v1', sourceFamilyId: 'video:v1' }],
    },
    timestamp: new Date(0).toISOString(),
  };
  const decision = await evaluate(
    {
      channel_name: 'Trading Creator',
      description: 'DAD VIBES',
      video_titles: ['Trading education'],
    },
    [provider([negative, positive])],
  );
  assert.notEqual(decision.status, 'NON_TRADING');
  assert.equal(decision.evidenceCollection.terminalNegativeSufficiency?.status, 'SUFFICIENT');
});

test('the semantic creator-level helper stays safe at the boundaries', () => {
  const bioCited = semanticNegative('n1', { fields: [{ field: 'channel_bio', sourceId: 'bio-1' }] });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([bioCited], { description: 'DAD VIBES' }), true);
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([bioCited], { description: '   ' }), false);

  const titleOnly = semanticNegative('n1', { fields: [{ field: 'channel_title', sourceId: 'title-1' }] });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([titleOnly], { description: 'DAD VIBES' }), false);

  const quoted = semanticNegative('n1', {
    fields: [{ field: 'channel_bio', sourceId: 'bio-1' }],
    claimPolarity: 'QUOTED',
  });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([quoted], { description: 'DAD VIBES' }), false);

  const lowConfidence = semanticNegative('n1', {
    fields: [{ field: 'channel_bio', sourceId: 'bio-1' }],
    calibratedConfidence: 75,
  });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([lowConfidence], { description: 'DAD VIBES' }), false);

  const familyOnly = semanticNegative('n1', {
    fields: [{ field: 'channel_bio', sourceFamilyId: 'bio-family-1' }],
  });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([familyOnly], { description: 'DAD VIBES' }), true);

  // Field-built semantic citations may legitimately omit generated ids when the
  // input has no canonical entity/family id; the non-empty bio is the guard.
  const unattributedBio = semanticNegative('n1', { fields: [{ field: 'channel_bio' }] });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([unattributedBio], { description: 'DAD VIBES' }), true);
});

test('transcript and pinned citations survive a boilerplate bio and invalid confidence', () => {
  const transcript = semanticNegative('n-transcript', {
    fields: [{ field: 'channel_bio', sourceId: 'bio-1' }, { field: 'transcript_excerpt', sourceId: 'transcript-1' }],
  });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([transcript], {
    description: 'Share your videos with friends, family, and the world',
  }), true);

  const pinned = semanticNegative('n-pinned', {
    fields: [{ field: 'pinned_comment', sourceId: 'pinned-1' }],
  });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([pinned], { description: 'DAD VIBES' }), true);

  const invalidConfidence = semanticNegative('n-invalid', {
    fields: [{ field: 'transcript_excerpt', sourceId: 'transcript-1' }],
    calibratedConfidence: Number.NaN,
  });
  assert.equal(hasCreatorLevelSemanticUnrelatedNegative([invalidConfidence], { description: 'DAD VIBES' }), false);
});
