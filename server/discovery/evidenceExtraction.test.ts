import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVIDENCE_EXTRACTION_VERSION,
  MAX_CANDIDATES_PER_EXTRACTION,
  MAX_PROVENANCE_PER_CANDIDATE,
  evidenceCandidateKeyForTerm,
  evidenceCanonicalIdentity,
  extractEvidenceCandidates,
  hashEvidenceSource,
} from './evidenceExtraction';

function byNormalized(candidates: ReturnType<typeof extractEvidenceCandidates>, term: string) {
  return candidates.find(candidate => candidate.normalizedTerm === term);
}

test('extracts hashtags, handles/mentions, tags, topics and n-grams from multilingual metadata', () => {
  const description = 'DAX Live #Börsenanalyse @boerse_berlin order flow und Volatilität';
  const candidates = extractEvidenceCandidates({
    channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    channelName: 'Börsenanalyse LuxX',
    channelHandle: 'boerse_berlin',
    description,
    videoTitles: ['Analyse des signaux #devisen @TraderParis'],
    videoTags: ['Order Flow', 'x'],
    topicLabels: ['Day Trading'],
  });

  // Hashtag dedup + lowercase normalization keeps the literal '#' identity.
  const hashtag = byNormalized(candidates, '#börsenanalyse');
  assert.ok(hashtag, 'expected #börsenanalyse');
  assert.equal(hashtag?.signalKind, 'HASHTAG');
  assert.equal(hashtag?.rawTerm, '#Börsenanalyse');

  // Handle field and text mention converge on one canonical candidate.
  const handle = byNormalized(candidates, '@boerse_berlin');
  assert.ok(handle, 'expected @boerse_berlin');
  assert.equal(handle?.signalKind, 'HANDLE');
  assert.equal(handle?.frequency, 2);
  assert.ok((handle?.provenance.length || 0) >= 2);

  const frenchMention = byNormalized(candidates, '@traderparis');
  assert.ok(frenchMention, 'expected @traderparis');
  assert.equal(frenchMention?.signalKind, 'MENTION');

  // Video tags are harvested with tag provenance and merge with matching n-grams.
  const tag = byNormalized(candidates, 'order flow');
  assert.ok(tag, 'expected order flow');
  assert.equal(tag?.signalKind, 'VIDEO_TAG');
  assert.equal(tag?.frequency, 2);
  assert.ok(tag?.provenance.some(entry => entry.extractionMethod === 'VIDEO_TAG'));
  assert.ok(tag?.provenance.some(entry => entry.extractionMethod === 'NGRAM'));

  const topic = byNormalized(candidates, 'day trading');
  assert.ok(topic, 'expected day trading topic label');
  assert.equal(topic?.signalKind, 'TOPIC_LABEL');
});

test('hashtag provenance spans slice the literal back out of the source text', () => {
  const description = 'DAX #Börsenanalyse und mehr';
  const candidates = extractEvidenceCandidates({ channelId: 'UCspan', description });
  const hashtag = candidates.find(candidate => candidate.normalizedTerm === '#börsenanalyse');
  assert.ok(hashtag);
  const span = hashtag!.provenance[0]?.textSpan;
  assert.ok(span && span.end > span.start);
  const points = Array.from(description.normalize('NFC'));
  assert.equal(points.slice(span!.start, span!.end).join(''), '#Börsenanalyse');
});

test('normalization and dedup collapse case and representation variants', () => {
  const candidates = extractEvidenceCandidates({
    channelId: 'UCdedup',
    description: 'Wir lieben #DAX und #dax',
    videoTags: ['ORDER FLOW'],
    videoTitles: ['order flow für alle'],
  });
  const dax = candidates.filter(candidate => candidate.normalizedTerm === '#dax');
  assert.equal(dax.length, 1);
  assert.equal(dax[0].frequency, 2);

  const orderFlow = candidates.filter(candidate => candidate.normalizedTerm === 'order flow');
  assert.equal(orderFlow.length, 1);
  assert.ok(orderFlow[0].frequency >= 2);
});

test('n-gram segmentation stops at stopwords and never fabricates cross-boundary phrases', () => {
  const candidates = extractEvidenceCandidates({
    channelId: 'UCngram',
    description: 'the order flow for beginners',
  });
  const terms = candidates.map(candidate => candidate.normalizedTerm);
  assert.ok(terms.includes('order flow'), `expected order flow in ${JSON.stringify(terms)}`);
  assert.ok(!terms.includes('the order'));
  assert.ok(!terms.includes('flow for'));
  assert.ok(!terms.includes('for beginners'));
});

test('structured videos take precedence over parallel title/description arrays', () => {
  const candidates = extractEvidenceCandidates({
    channelId: 'UCprecedence',
    videos: [{ id: 'vid-1', title: 'Alpha strategy beta' }],
    videoTitles: ['Alpha strategy beta'],
    videoDescriptions: ['Alpha strategy beta'],
  });
  const phrase = byNormalized(candidates, 'alpha strategy');
  assert.ok(phrase);
  // Frequency counts the structured representation once, not three times.
  assert.equal(phrase?.frequency, 1);
  assert.ok(phrase?.provenance.every(entry => entry.sourceId === 'video:vid-1'));
});

test('extraction is deterministic and keys are stable sha256 identities', () => {
  const input = {
    channelId: 'UCdeterminism',
    description: 'Gold trading #Xauusd with @SmartMoneyConcepts',
    videoTags: ['liquidity sweep', 'liquidity sweep'],
  };
  const first = extractEvidenceCandidates(input);
  const second = extractEvidenceCandidates(input);
  assert.deepEqual(first, second);

  const gold = first.find(candidate => candidate.normalizedTerm === '#xauusd');
  assert.ok(gold);
  assert.equal(gold!.canonicalIdentity, 'SEARCH_TERM:#xauusd');
  assert.equal(gold!.canonicalCandidateKey, evidenceCandidateKeyForTerm('#xauusd'));
  assert.equal(evidenceCanonicalIdentity('XAUUSD'), 'SEARCH_TERM:xauusd');
  assert.equal(hashEvidenceSource('abc'), hashEvidenceSource('abc'));
  assert.notEqual(hashEvidenceSource('abc'), hashEvidenceSource('abd'));
  assert.equal(EVIDENCE_EXTRACTION_VERSION, 'evidence-extraction-v1');
});

test('provenance is capped and candidates carry bounded frequency', () => {
  const candidates = extractEvidenceCandidates({
    channelId: 'UCcap',
    channelName: 'flow alpha',
    description: 'flow alpha',
    videoTitles: ['flow alpha', 'flow alpha'],
    pinnedComment: 'flow alpha',
    videoTags: ['flow alpha'],
  });
  const flow = byNormalized(candidates, 'flow alpha');
  assert.ok(flow);
  assert.equal(flow!.frequency, 6);
  assert.equal(flow!.provenance.length, MAX_PROVENANCE_PER_CANDIDATE);
});

test('empty and malformed metadata never throws and yields no candidates', () => {
  assert.deepEqual(extractEvidenceCandidates({ channelId: 'UCempty' }), []);
  assert.deepEqual(extractEvidenceCandidates({ channelId: 'UCempty', videoTags: [], topicLabels: [] }), []);
});

test('n-grams never span punctuation boundaries', () => {
  const candidates = extractEvidenceCandidates({
    channelId: 'UCpunct',
    description: 'order.flow and alpha-beta gamma',
  });
  assert.equal(byNormalized(candidates, 'order flow'), undefined);
  assert.equal(byNormalized(candidates, 'alpha beta'), undefined);
});

test('trailing sentence punctuation is trimmed from hashtag and mention spans', () => {
  const description = 'Follow #OrderFlow. and @SmartMoney, now';
  const candidates = extractEvidenceCandidates({ channelId: 'UCtrim', description });
  const hashtag = byNormalized(candidates, '#orderflow');
  const mention = byNormalized(candidates, '@smartmoney');
  assert.ok(hashtag);
  assert.ok(mention);
  const points = Array.from(description.normalize('NFC'));
  for (const candidate of [hashtag!, mention!]) {
    const span = candidate.provenance[0]?.textSpan;
    assert.ok(span);
    const slice = points.slice(span!.start, span!.end).join('');
    assert.doesNotMatch(slice, /[.,;:!?]$/u);
  }
});

test('explicitly empty structured videos suppress stale parallel title arrays', () => {
  const candidates = extractEvidenceCandidates({
    channelId: 'UCemptyvideos',
    videos: [],
    videoTitles: ['stale title must not be harvested'],
    videoDescriptions: ['stale description must not be harvested'],
  });
  assert.deepEqual(candidates, []);
});

test('malformed non-array and non-object metadata is ignored without throwing', () => {
  const candidates = extractEvidenceCandidates({
    channelId: 'UCmalformed',
    description: 42 as unknown as string,
    channelHandle: 7 as unknown as string,
    videoTags: 'not-an-array' as unknown as string[],
    topicLabels: [null, 3] as unknown as string[],
    videos: [null, 42] as unknown as Array<{ id: string; title: string; description: string }>,
  });
  assert.deepEqual(candidates, []);
});

test('candidate cap retains the most frequently observed signals', () => {
  const videoTags = [
    'repeated signal phrase',
    'repeated signal phrase',
    ...Array.from({ length: MAX_CANDIDATES_PER_EXTRACTION + 20 }, (_, index) => `uniqueterm${index}x`),
  ];
  const candidates = extractEvidenceCandidates({ channelId: 'UCcaporder', videoTags });
  assert.equal(candidates.length, MAX_CANDIDATES_PER_EXTRACTION);
  assert.ok(candidates.some(candidate => candidate.normalizedTerm === 'repeated signal phrase'));
});
