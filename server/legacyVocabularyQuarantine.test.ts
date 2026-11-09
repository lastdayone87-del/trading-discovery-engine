import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isNuisanceVocabularySurface } from './terminologySearchability';
import { saveExtractedTerm } from './db';

test('legacy vocabulary quarantine targets emoji, hashtag and numeric surfaces only', () => {
  for (const term of ['🔴', '#trading', '#daytrading', '🚨', '011', '12345', '@trader', '＃trading', 'crypto#trading', '\u200B#forex']) {
    assert.equal(isNuisanceVocabularySurface(term), true, term);
  }
  for (const term of ['ES', 'LIVE', 'Gold', 'Ｇｏｌｄ', 'Footprint Trading DAX', 'analyse technique']) {
    assert.equal(isNuisanceVocabularySurface(term), false, term);
  }
});

test('migration 173 downgrades nuisance trust-tier-2 vocabulary without deleting evidence', () => {
  const sql = readFileSync(new URL('./db/migrations/173_quarantine_invalid_extracted_vocabulary.sql', import.meta.url), 'utf8');
  assert.match(sql, /UPDATE extracted_trading_vocabulary/);
  assert.match(sql, /WHERE trust_tier = 2/);
  assert.match(sql, /SET trust_tier = 3/);
  assert.match(sql, /validation_count = 0/);
  assert.match(sql, /normalize\(term, NFKC\)/);
  assert.match(sql, /term_norm ~ '\[#@\]'/);
  assert.match(sql, /term_norm ~ '\^\[0-9\]\+\$'/);
  assert.doesNotMatch(sql, /term LIKE/);
  
  assert.doesNotMatch(sql, /DELETE FROM extracted_trading_vocabulary/i);
});


test('direct saveExtractedTerm also skips nuisance shapes before touching the database', async () => {
  const explodingRunner = { query: async () => { throw new Error('should not query'); } };
  await saveExtractedTerm('United States', '12345', 'terminology', undefined, explodingRunner);
});
