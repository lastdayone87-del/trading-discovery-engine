import test from 'node:test';
import assert from 'node:assert/strict';
// Architecture regression coverage for semantic classification accuracy:
// duplicate-token dominance (false NON_TRADING), thin-evidence gaming
// channels (must not flip either way without evidence), legitimate
// deterministic rejects, and the semantic provider fallback chain.
// All fixtures are synthetic mechanism reproductions — never real channels.
import { EvidenceBasedTradingEngine, executeSemanticChain, resolveSemanticProviderChain } from './index';
import type { EvidenceItem, EvidenceProvider, RawChannelInput } from './types';

const engine = new EvidenceBasedTradingEngine();

function evaluate(channelName: string, description: string, country = 'UNKNOWN') {
  return engine.evaluateChannel({
    channel_name: channelName,
    description,
    video_titles: [],
    video_descriptions: [],
    external_links: [],
    country,
    enrichment_stage: 0,
  } as RawChannelInput);
}

test('mixed trading content with an address garden token is not terminally rejected', async () => {
  // Mechanism: one 'garten' token (street address) matched by two providers
  // used to sum past the terminal threshold. After observation-key dedup the
  // same token counts once and the mixed creator stays uncertain pending
  // adjudication instead of terminally rejected.
  const decision = await evaluate(
    'Invest Journal',
    'Everything revolves around stocks, ETFs and crypto. Impressum: Finn Hantke, Am Geus Garten 22, Odenthal. Contact by E-Mail.'
  );
  assert.notEqual(decision.status, 'NON_TRADING');
  assert.equal(decision.status, 'UNCERTAIN');
  // Evidence is retained (not discarded): both polarities stay visible.
  assert.ok(decision.positiveEvidence.length > 0);
  assert.ok(decision.negativeEvidence.length > 0);
});

test('mixed crypto content with vlog tokens is not terminally rejected', async () => {
  const decision = await evaluate(
    'Crypto Notes',
    'Bitcoin and cryptocurrency analysis. Daily vlog with honest takes. Crypto asmr streams every week.'
  );
  assert.notEqual(decision.status, 'NON_TRADING');
});

test('thin gaming bio without trading signals stays uncertain either way', async () => {
  const decision = await evaluate(
    'Pixel Plays',
    'i suffer for content. New uploads whenever ranked grind allows.'
  );
  assert.equal(decision.status, 'UNCERTAIN');
});

test('pure gaming bio with distinct negative tokens still rejects deterministically', async () => {
  const decision = await evaluate(
    'LetsPlay Central',
    'Daily minecraft gaming walkthroughs and fortnite live streams. New valorant gameplay videos every single day.'
  );
  assert.equal(decision.status, 'NON_TRADING');
});

test('single negative token cannot reach the terminal threshold alone', async () => {
  const decision = await evaluate(
    'Chart Desk',
    'Day trading futures strategies with charts and risk management education for beginners. Weekend cooking vlog.'
  );
  assert.notEqual(decision.status, 'NON_TRADING');
});

test('single-token multi-document negatives route to semantic review, not terminal math', async () => {
  // Flamenco-style input: one negative token across bio and video titles.
  // Without a serving semantic provider this must stay UNCERTAIN (terminal
  // math requires genuinely independent or multi-token evidence).
  const bio = 'Clases de guitarra flamenca, acordes y compases tradicionales.';
  const titles = ['Aprende Rasgueo Flamenco Fácil', 'Soleá por Bulerías Guitarra'];
  const withoutSemantic = await engine.evaluateChannel({
    channel_name: 'Flamenco Notes',
    description: bio,
    video_titles: titles,
    video_descriptions: [],
    external_links: [],
    country: 'Spain',
    enrichment_stage: 1,
  } as RawChannelInput);
  assert.equal(withoutSemantic.status, 'UNCERTAIN');
});

test('semantic UNRELATED verdict still terminally rejects single-token cases', async () => {
  // Same input, but with a serving semantic provider attributing UNRELATED
  // at channel_bio: the semantic terminal path (not token math) decides.
  const { ChannelMetadataProvider } = await import('./providers/ChannelMetadataProvider');
  const { VideoMetadataProvider } = await import('./providers/VideoMetadataProvider');
  const { CountryKnowledgeProvider } = await import('./providers/CountryKnowledgeProvider');
  const { GroqSemanticProvider } = await import('./providers/GroqSemanticProvider');
  const stub = {
    classify: async () => ({
      label: 'UNRELATED',
      confidence: 96,
      supportedLanguage: true,
      reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
      explanation: 'The creator focuses on flamenco guitar instruction, not trading.',
      concepts: ['flamenco instruction'],
      languages: [{ language: 'es', script: 'Latin', confidence: 100, field: 'channel_bio' }],
      citations: [{ field: 'channel_bio' }],
    }),
  };
  const scoped = new EvidenceBasedTradingEngine([
    new ChannelMetadataProvider(),
    new VideoMetadataProvider(),
    new CountryKnowledgeProvider(),
    new GroqSemanticProvider(stub as never),
  ]);
  const savedGroq = process.env.GROQ_API_KEY;
  const savedProvider = process.env.SEMANTIC_PROVIDER;
  process.env.GROQ_API_KEY = 'test-routing-key';
  process.env.SEMANTIC_PROVIDER = 'groq';
  try {
    const decision = await scoped.evaluateChannel({
      channel_name: 'Flamenco Notes',
      description: 'Clases de guitarra flamenca, acordes y compases tradicionales para todos los niveles.',
      video_titles: ['Aprende Rasgueo Flamenco Fácil', 'Soleá por Bulerías Guitarra'],
      video_descriptions: [],
      external_links: [],
      country: 'Spain',
      enrichment_stage: 1,
    } as RawChannelInput);
    assert.equal(decision.status, 'NON_TRADING');
  } finally {
    if (savedGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedGroq;
    if (savedProvider === undefined) delete process.env.SEMANTIC_PROVIDER; else process.env.SEMANTIC_PROVIDER = savedProvider;
  }
});

test('semantic chain order respects configuration and force flags', () => {
  assert.deepEqual(resolveSemanticProviderChain('gemini_semantic', {}), ['gemini_semantic']);
  assert.deepEqual(resolveSemanticProviderChain('gemini_semantic', { SEMANTIC_PROVIDER_FORCE_GEMINI: 'true' }), ['gemini_semantic']);
  assert.deepEqual(
    resolveSemanticProviderChain('gemini_semantic', { GROQ_API_KEY: 'k' }),
    ['gemini_semantic', 'groq_semantic']
  );
  assert.deepEqual(
    resolveSemanticProviderChain('groq_semantic', { SEMANTIC_PROVIDER: 'groq', GROQ_API_KEY: 'k' }),
    ['groq_semantic']
  );
  assert.deepEqual(
    resolveSemanticProviderChain('gemini_semantic', { GEMINI_FREE_API_KEY: 'k' }),
    ['gemini_semantic', 'gemini_free_semantic']
  );
});

function stubProvider(
  name: string,
  behavior: { availability?: 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_APPLICABLE'; fail?: string; abstain?: boolean }
): EvidenceProvider {
  return {
    name: name as never,
    availability: () => behavior.availability === undefined
      ? { availability: 'AVAILABLE' as const }
      : { availability: behavior.availability, reason: 'test' },
    collectEvidence: async () => {
      if (behavior.fail) throw Object.assign(new Error(behavior.fail), { errorClass: 'TRANSIENT' });
      if (behavior.abstain) {
        return [{
          id: 'x', source: name, polarity: 'POSITIVE', category: 'SEMANTIC_ABSTENTION',
          fact: 'abstain', rawMatches: [], confidence: 0, reliability: 'LOWER', reliabilityMultiplier: 0.4,
          rawWeight: 0, finalWeight: 0,
          provenance: { provider: name, type: 'SEMANTIC_ABSTENTION', matchedTerm: '', sourceRef: 't', fields: [], semantic: { reasonCodes: ['SEMANTIC_MODEL_ABSTAINED'] } },
          timestamp: new Date().toISOString(),
        }] as never as EvidenceItem[];
      }
      return [{
        id: 'x', source: name, polarity: 'POSITIVE', category: 'METHODOLOGY_CONCEPT',
        fact: 'found', rawMatches: ['strategy'], confidence: 84, reliability: 'MEDIUM', reliabilityMultiplier: 0.65,
        rawWeight: 24, finalWeight: 10,
        provenance: { provider: name, type: 'METHODOLOGY_CONCEPT', matchedTerm: 'strategy', sourceRef: 't', fields: [] },
        timestamp: new Date().toISOString(),
      }] as never as EvidenceItem[];
    },
  } as never as EvidenceProvider;
}

const chainInput = { channel_name: 'T', description: 'Day trading education with charts.' } as RawChannelInput;
const chainKnowledge = {} as never;

test('chain falls back on primary failure and records both attempts', async () => {
  const calls: string[] = [];
  const primary = stubProvider('gemini_semantic', { fail: 'boom' });
  const groqStub = stubProvider('groq_semantic', {});
  const fallback = {
    ...groqStub,
    collectEvidence: async (input: never, knowledge: never) => {
      calls.push('fallback');
      return groqStub.collectEvidence(input as never, knowledge as never);
    },
  } as EvidenceProvider;
  const result = await executeSemanticChain([primary, fallback], chainInput, chainKnowledge);
  assert.deepEqual(calls, ['fallback']);
  assert.equal(result.items.length, 1);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[0].availability, 'FAILED');
  assert.ok(result.reports[0].reasonCodes.includes('PROVIDER_TRANSIENT_FAILURE'));
  assert.equal(result.reports[1].outcome, 'EXECUTED_WITH_EVIDENCE');
  assert.ok(result.reports[1].reasonCodes.includes('SEMANTIC_FALLBACK_SUCCEEDED'));
});

test('chain stops at abstention and never shops for a second opinion', async () => {
  let fallbackCalls = 0;
  const primary = stubProvider('gemini_semantic', { abstain: true });
  const groqStub = stubProvider('groq_semantic', {});
  const fallback = {
    ...groqStub,
    collectEvidence: async (input: never, knowledge: never) => {
      fallbackCalls += 1;
      return groqStub.collectEvidence(input as never, knowledge as never);
    },
  } as EvidenceProvider;
  const result = await executeSemanticChain([primary, fallback], chainInput, chainKnowledge);
  assert.equal(fallbackCalls, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].outcome, 'ABSTAINED_LOW_CONFIDENCE');
});

test('chain degrades to empty evidence when every provider fails', async () => {
  const result = await executeSemanticChain(
    [stubProvider('gemini_semantic', { fail: 'down' }), stubProvider('groq_semantic', { fail: 'down' })],
    chainInput,
    chainKnowledge
  );
  assert.deepEqual(result.items, []);
  assert.equal(result.reports.length, 2);
  assert.ok(result.reports.every(report => report.availability === 'FAILED'));
});

test('chain skips unconfigured providers and stops at not-applicable input', async () => {
  const result = await executeSemanticChain(
    [stubProvider('gemini_semantic', { availability: 'UNAVAILABLE' }), stubProvider('groq_semantic', { availability: 'UNAVAILABLE' })],
    chainInput,
    chainKnowledge
  );
  assert.equal(result.items.length, 0);
  assert.equal(result.reports[0].availability, 'UNAVAILABLE');
  assert.equal(result.reports[1].availability, 'UNAVAILABLE');
  const naProvider: EvidenceProvider = {
    ...stubProvider('na_semantic', { availability: 'NOT_APPLICABLE' }),
  } as EvidenceProvider;
  const naResult = await executeSemanticChain(
    [naProvider, stubProvider('groq_semantic', {})],
    chainInput,
    chainKnowledge
  );
  assert.equal(naResult.items.length, 0);
  assert.equal(naResult.reports.length, 1);
  assert.equal(naResult.reports[0].outcome, 'NOT_APPLICABLE');
});
