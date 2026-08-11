import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toStage1HumanReviewSheet } from './stage1ProspectiveWorklist';

test('human review sheet stays prediction-blind and leaves judgment fields empty', () => {
  const [row] = toStage1HumanReviewSheet([{
    channel_id: 'channel-1',
    channel_name: 'Example Creator',
    youtube_url: 'https://youtube.com/channel/channel-1',
    country: 'US',
    assigned_at: '2026-08-11T00:00:00Z',
    diagnostic_at: '2026-08-11T00:01:00Z'
  }]);
  assert.deepEqual(row, {
    channel: 'Example Creator',
    channel_id: 'channel-1',
    youtube_url: 'https://youtube.com/channel/channel-1',
    country: 'US',
    human_label: '',
    creator_type: '',
    reason_codes: []
  });
  assert.equal('trading_status' in row, false);
  assert.equal('confidence' in row, false);
});

test('worklist query requires prospective lineage and excludes prior independent labels', () => {
  const source = readFileSync(new URL('./stage1ProspectiveWorklist.ts', import.meta.url), 'utf8');
  assert.match(source, /policy_key=\$1/);
  assert.match(source, /production_classification_diagnostics/);
  assert.match(source, /creator_focus_classification_snapshots/);
  assert.match(source, /evidence_coverage_snapshots/);
  assert.match(source, /NOT EXISTS/);
  assert.match(source, /provenance IN \('HUMAN_REVIEW','ADJUDICATION'\)/);
  assert.doesNotMatch(source, /SELECT[^;]*trading_status/is);
});
