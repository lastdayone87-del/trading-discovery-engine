import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStage1BatchAdjudicationEntries,
  STAGE1_BATCH_ADJUDICATION_CONFIRMATION,
  STAGE1_BATCH_ADJUDICATION_MAX_ENTRIES
} from './stage1ProspectiveAdjudicationBatch';

test('parses normalized batch adjudication entries', () => {
  const rows = parseStage1BatchAdjudicationEntries(JSON.stringify([
    {
      channel: ' Day Trading with Matt ',
      label: 'trading_confirmed',
      creator_type: 'ACTIVE_TRADING_CREATOR',
      reason_codes: ['TRADING_PRIMARY_FOCUS', 'TRADING_PRIMARY_FOCUS'],
      notes: ' reviewed '
    },
    {
      channel: 'Non Trading Example',
      label: 'NON_TRADING',
      creatorType: 'UNRELATED_OTHER',
      reasonCodes: 'UNRELATED_PRIMARY_FOCUS,NO_TRADING_EDUCATION'
    }
  ]));

  assert.equal(rows.length, 2);
  assert.equal(rows[0].channel, 'Day Trading with Matt');
  assert.equal(rows[0].label, 'TRADING_CONFIRMED');
  assert.equal(rows[0].creatorType, 'ACTIVE_TRADING_CREATOR');
  assert.deepEqual(rows[0].reasonCodes, ['TRADING_PRIMARY_FOCUS']);
  assert.equal(rows[0].notes, 'reviewed');
  assert.deepEqual(rows[1].reasonCodes, ['UNRELATED_PRIMARY_FOCUS', 'NO_TRADING_EDUCATION']);
});

test('rejects duplicate selectors and invalid inputs before any persistence path runs', () => {
  const duplicate = JSON.stringify([
    { channel: 'Creator A', label: 'TRADING_CONFIRMED', creator_type: 'TRADING_EDUCATOR', reason_codes: ['A'] },
    { channel: 'creator a', label: 'NON_TRADING', creator_type: 'UNRELATED_OTHER', reason_codes: ['B'] }
  ]);
  assert.throws(() => parseStage1BatchAdjudicationEntries(duplicate), /BATCH_DUPLICATE_CHANNEL/);
  assert.throws(() => parseStage1BatchAdjudicationEntries('not json'), /BATCH_JSON_INVALID/);
  assert.throws(() => parseStage1BatchAdjudicationEntries('[]'), /BATCH_ENTRIES_REQUIRED/);
});

test('caps the governed batch size and exposes an explicit batch confirmation token', () => {
  const tooMany = Array.from({ length: STAGE1_BATCH_ADJUDICATION_MAX_ENTRIES + 1 }, (_, index) => ({
    channel: `channel-${index}`,
    label: 'NON_TRADING',
    creator_type: 'UNRELATED_OTHER',
    reason_codes: ['UNRELATED_PRIMARY_FOCUS']
  }));
  assert.throws(() => parseStage1BatchAdjudicationEntries(JSON.stringify(tooMany)), /BATCH_TOO_LARGE/);
  assert.equal(STAGE1_BATCH_ADJUDICATION_CONFIRMATION, 'COMMIT_STAGE1_PROSPECTIVE_ADJUDICATION_BATCH');
});
