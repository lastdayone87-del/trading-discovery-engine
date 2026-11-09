import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isNuisanceVocabularySurface } from './terminologySearchability';

test('legacy vocabulary quarantine targets emoji, hashtag and numeric surfaces only', () => {
  for (const term of ['🔴', '#trading', '#daytrading', '🚨', '011', '12345']) {
    assert.equal(isNuisanceVocabularySurface(term), true, term);
  }
  for (const term of ['ES', 'LIVE', 'Gold', 'Footprint Trading DAX', 'analyse technique']) {
    assert.equal(isNuisanceVocabularySurface(term), false, term);
  }
});

test('migration 173 downgrades nuisance trust-tier-2 vocabulary without deleting evidence', () => {
  const sql = readFileSync(new URL('./db/migrations/173_quarantine_invalid_extracted_vocabulary.sql', import.meta.url), 'utf8');
  assert.match(sql, /UPDATE extracted_trading_vocabulary/);
  assert.match(sql, /SET trust_tier = 3/);
  assert.match(sql, /validation_count = 0/);
  assert.match(sql, /term !~ '\[\[:alpha:\]\]'/);
  assert.match(sql, /term LIKE '#%'/);
  assert.match(sql, /term LIKE '@%'/);
  assert.match(sql, /term ~ '\^\[0-9\]\+\$'/);
  assert.doesNotMatch(sql, /DELETE FROM extracted_trading_vocabulary/i);
});
