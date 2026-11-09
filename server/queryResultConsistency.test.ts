import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessQueryResultConsistency } from './queryResultConsistency';

function channels(values: Array<{ name: string; description?: string; title?: string }>) {
  return values.map(value => ({
    channelName: value.name,
    description: value.description,
    matchedDocument: {
      type: value.title ? 'VIDEO' as const : 'CHANNEL' as const,
      title: value.title || value.name,
      description: value.description,
    },
  }));
}

test('holds a Singapore query whose page is dominated by Devanagari/Gujarati creator content', () => {
  const decision = assessQueryResultConsistency('Singapore', channels(
    Array.from({ length: 12 }, (_, index) => ({
      name: `channel-${index}`,
      description: index % 2 === 0
        ? 'MPSC, PSI, STI परीक्षेसाठी उपयुक्त चॅनल. स्पर्धा परीक्षा तयारी.'
        : 'ગુજરાત સરકારી ભરતી અને સ્પર્ધાત્મક પરીક્ષાની તૈયારી.',
    })),
  ));
  assert.equal(decision.hold, true);
  assert.ok(decision.incompatibleScripts.includes('Deva'));
  assert.ok(decision.incompatibleScripts.includes('Gujr'));
  assert.ok(decision.reasonCodes.includes('QUERY_RESULT_SCRIPT_MISMATCH'));
});

test('does not hold a Singapore query with English and Chinese creator content', () => {
  const decision = assessQueryResultConsistency('Singapore', channels(
    Array.from({ length: 12 }, (_, index) => ({
      name: index % 2 === 0 ? `sg-trader-${index}` : `新加坡交易${index}`,
      description: index % 2 === 0
        ? 'Singapore stock market analysis and technical trading education.'
        : '新加坡股票市场分析与交易教育。',
    })),
  ));
  assert.equal(decision.hold, false);
});

test('allows a Latin-name channel with a Tamil bio in Singapore', () => {
  const decision = assessQueryResultConsistency('Singapore', channels(
    Array.from({ length: 12 }, (_, index) => ({
      name: `sg-tamil-${index}`,
      description: 'சிங்கப்பூர் பங்குச் சந்தை பகுப்பாய்வு மற்றும் வர்த்தகம்.',
    })),
  ));
  assert.equal(decision.hold, false);
});

test('does not hold a Belgium query with Dutch/English creator content', () => {
  const decision = assessQueryResultConsistency('Belgium', channels(
    Array.from({ length: 12 }, (_, index) => ({
      name: `be-${index}`,
      description: index % 2 === 0
        ? 'Beursanalyse België, aandelen en technische analyse.'
        : 'Belgian stocks, ETF investing and market analysis.',
    })),
  ));
  assert.equal(decision.hold, false);
});

test('holds a US query page dominated by Arabic-script creator content', () => {
  const decision = assessQueryResultConsistency('United States', channels(
    Array.from({ length: 12 }, (_, index) => ({
      name: `us-${index}`,
      description: 'تحليل السوق والأسهم والتداول.',
    })),
  ));
  assert.equal(decision.hold, true);
  assert.ok(decision.incompatibleScripts.includes('Arab'));
});

test('does not hold below the minimum sample or when the incompatible share is below threshold', () => {
  const insufficient = assessQueryResultConsistency('Singapore', channels(
    Array.from({ length: 5 }, (_, index) => ({ name: `x-${index}`, description: 'MPSC परीक्षा तयारी.' })),
  ));
  assert.equal(insufficient.hold, false);
  assert.ok(insufficient.reasonCodes.includes('INSUFFICIENT_RESULT_SAMPLE'));

  const borderline = assessQueryResultConsistency('Singapore', channels([
    ...Array.from({ length: 6 }, (_, index) => ({ name: `english-${index}`, description: 'Singapore market analysis.' })),
    ...Array.from({ length: 4 }, (_, index) => ({ name: `native-${index}`, description: 'MPSC परीक्षा तयारी.' })),
  ]));
  assert.equal(borderline.hold, false);
});

test('fails open for a country without a script profile', () => {
  const decision = assessQueryResultConsistency('Atlantis', channels(
    Array.from({ length: 12 }, (_, index) => ({ name: `a-${index}`, description: 'تحليل السوق.' })),
  ));
  assert.equal(decision.hold, false);
  assert.ok(decision.reasonCodes.includes('NO_COUNTRY_SCRIPT_PROFILE'));
});


test('search worker applies the consistency guard before processing a page and quarantines the query', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const guard = source.indexOf('assessQueryResultConsistency(country, distinctExtracted)');
  const loop = source.indexOf('for (const [index, raw] of (queryResultHold ? [] : distinctExtracted).entries())');
  const hold = source.indexOf('holdQueryForResultConsistency(queryId!');
  assert.ok(guard >= 0, 'consistency guard must be wired into the search worker');
  assert.ok(loop > guard, 'the guard must run before the channel processing loop');
  assert.ok(hold >= 0, 'the worker must quarantine the query on a hold');
  assert.match(source, /createContinuation: queryResultHold \? false/);
});
