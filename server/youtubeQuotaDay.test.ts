import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';

const db = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('YouTube quota day follows America/Los_Angeles rather than UTC', () => {
  assert.equal(getYouTubeQuotaDay(new Date('2026-08-14T05:30:00Z')), '2026-08-13');
  assert.equal(getYouTubeQuotaDay(new Date('2026-08-14T07:01:00Z')), '2026-08-14');
  assert.equal(getYouTubeQuotaDay(new Date('2026-01-15T07:30:00Z')), '2026-01-14');
  assert.equal(getYouTubeQuotaDay(new Date('2026-01-15T08:01:00Z')), '2026-01-15');
});

test('quota tracker reads and admissions use the same Pacific quota-day helper', () => {
  assert.match(db, /import \{ getYouTubeQuotaDay \} from '\.\/youtubeQuotaDay';/);
  assert.match(db, /getQuota\(\)[\s\S]*const today=getYouTubeQuotaDay\(\)/);
  assert.match(db, /tryReserveQuota[\s\S]*const quotaDay = getYouTubeQuotaDay\(\)/);
  assert.doesNotMatch(db, /const today=new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/);
  assert.doesNotMatch(db, /const quotaDay = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});
