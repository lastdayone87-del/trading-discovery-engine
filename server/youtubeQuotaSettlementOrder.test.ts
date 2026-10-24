import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('./youtubeRequestScheduler.ts', import.meta.url), 'utf8');

test('every successful YouTube response is accounted before its body is parsed', () => {
  const lines = youtube.split('\n');
  let prefix = '';
  let checked = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    prefix += `${line}\n`;
    if (!line.includes('readYouTubeJsonObject(')) continue;
    // The exported reader itself is not a call site.
    if (line.includes('export async function readYouTubeJsonObject')) continue;
    const readAt = line.indexOf('readYouTubeJsonObject(');
    const readAbsolute = prefix.length - line.length + readAt;
    // The account must belong to the fetch immediately preceding this read,
    // not to an earlier provider call in the same function.
    const fetchAbsolute = prefix.lastIndexOf('youtubeFetch(');
    assert.ok(fetchAbsolute >= 0, `line ${index + 1} parses without a preceding provider fetch`);
    const accountAbsolute = prefix.lastIndexOf('accountYouTubeQuotaResponse(');
    assert.ok(
      accountAbsolute > fetchAbsolute && accountAbsolute < readAbsolute,
      `line ${index + 1} parses a successful response before accounting; a malformed body would strand its reservation`
    );
    checked += 1;
  }
  assert.ok(checked >= 10, `expected to check every reader call site, checked ${checked}`);
});

test('an optional video-details rejection cannot discard paid search descriptions', () => {
  const start = youtube.indexOf('export async function fetchRecentVideoDescriptionsWithIds');
  const end = youtube.indexOf('/** Accounts one successful provider response', start);
  assert.ok(start >= 0 && end > start, 'recent-video description function boundary must remain discoverable');
  const recent = youtube.slice(start, end);
  const followUp = recent.slice(recent.indexOf('if (videoIds.length > 0)'), recent.indexOf('if (searchItems.length > 0) return searchItems;'));
  assert.match(followUp, /try\s*\{[\s\S]*'video-details'[\s\S]*accountYouTubeQuotaResponse\(vRes, 1\)[\s\S]*\} catch \(error\)/);
  assert.match(followUp, /isYouTubeQuotaAccountingError\(error\)\) throw error/);
  assert.match(followUp, /!isYouTubeKeyCapError\(error\)/);
  assert.match(recent, /if \(searchItems\.length > 0\) return searchItems;/);
});

test('a quota-reserved 429 is tagged and never replayed by the scheduler', () => {
  const fetchStart = youtube.indexOf('async function youtubeFetch');
  const fetchEnd = youtube.indexOf('/** Preserve both legacy', fetchStart);
  assert.ok(fetchStart >= 0 && fetchEnd > fetchStart, 'youtubeFetch boundary must remain discoverable');
  const fetchBlock = youtube.slice(fetchStart, fetchEnd);
  assert.match(
    fetchBlock,
    /runtimeRateLimited&&capReservation&&error&&typeof error==='object'\)\{\s*Object\.assign\(error,\{youtubeQuotaReservationRetryBounded:true\}\)/,
    'a 429 carrying a live reservation must be marked bounded'
  );
  const retryCheck = scheduler.slice(
    scheduler.indexOf("this.noteRuntimeRateLimit(details, actualSpacingMs, request.priority, request.trace);"),
    scheduler.indexOf('const maxRetries = this.runtimeRetryLimit();')
  );
  assert.match(retryCheck, /quotaReservationRetryBounded\(error\)/);
  assert.match(retryCheck, /request\.reject\(error\)/);
  assert.match(scheduler, /function quotaReservationRetryBounded\([\s\S]*youtubeQuotaReservationRetryBounded === true[\s\S]*candidate\.cause/);
});
