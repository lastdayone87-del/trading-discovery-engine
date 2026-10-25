import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideJobFailure } from './dbCore';
import { YouTubePermanentInputError, isYouTubePermanentInputError } from './youtubeKeyHealth';

const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');

function functionBlock(startMarker: string, endMarker?: string): string {
  const start = youtube.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} must remain discoverable`);
  const end = endMarker ? youtube.indexOf(endMarker, start) : youtube.length;
  assert.ok(end > start, `${startMarker} block boundary must remain discoverable`);
  return youtube.slice(start, end);
}

test('permanent-input marker survives provider error wrapping', () => {
  const raw = Object.assign(new Error('YouTube HTTP 404 (playlistNotFound)'), {
    status: 404,
    providerReasons: ['playlistNotFound'],
  });
  const permanent = new YouTubePermanentInputError('channel-uploads', raw);
  assert.equal(permanent.code, 'YOUTUBE_PERMANENT_INPUT');
  assert.equal(permanent.status, 404);
  assert.deepEqual(permanent.providerReasons, ['playlistNotFound']);
  assert.equal(isYouTubePermanentInputError(permanent), true);
  // executeProviderCall wraps the original error in a ProviderCallError whose
  // cause chain still carries the marker.
  assert.equal(isYouTubePermanentInputError({ name: 'ProviderCallError', cause: permanent }), true);
  assert.equal(isYouTubePermanentInputError(new Error('YouTube HTTP 404')), false);
  assert.equal(isYouTubePermanentInputError({ status: 404, providerReasons: ['invalidPageToken'] }), false);
  assert.equal(isYouTubePermanentInputError({ status: 429 }), false);
});

test('permanent invalid input fails the job without consuming retries', () => {
  const permanent = new YouTubePermanentInputError(
    'channel-uploads',
    Object.assign(new Error('YouTube HTTP 404 (playlistNotFound)'), { status: 404, providerReasons: ['playlistNotFound'] }),
  );
  assert.deepEqual(decideJobFailure(permanent, 1, 5), { disposition: 'FAILED' });
  // The same marker behind the provider wrapper is still terminal.
  assert.deepEqual(decideJobFailure({ name: 'ProviderCallError', cause: permanent }, 1, 5), { disposition: 'FAILED' });
  // A stale page token is retryable input, not a permanently invalid request.
  assert.equal(
    decideJobFailure({ status: 400, providerReasons: ['invalidPageToken'] }, 1, 5).disposition,
    'RETRYING',
  );
  // A 429 remains a rate-limit signal handled by the retry path.
  assert.notEqual(decideJobFailure({ status: 429, retryable: true }, 1, 5).disposition, 'FAILED');
});

test('youtubeFetch classifies permanent input only after excluding every key-level failure', () => {
  const fetchBlock = functionBlock('async function youtubeFetch', 'export type YouTubeAdditionalQuotaCallback');
  assert.match(
    fetchBlock,
    /const permanentInput=isYouTubeInputFailure\(error\)&&!isYouTubePageTokenFailure\(error\)\s*&&!consumerSuspended&&!isInvalidApiKey\(error\)&&!isQuotaExceeded\(error\)&&!runtimeRateLimited;/,
  );
  const release = fetchBlock.indexOf('if(permanentInput){');
  const permanentThrow = fetchBlock.indexOf('new YouTubePermanentInputError(operation,error)', release);
  const branch = fetchBlock.slice(release, permanentThrow);
  assert.ok(release >= 0 && permanentThrow > release, 'permanent input must surface after classification');
  // Google charges at least one unit even for invalid requests, so the branch
  // must not release the dispatch leases as if the request were free.
  assert.doesNotMatch(branch, /settleKeyCapReservation|releaseProbeReservationSafe/);
  assert.match(branch, /charges at least one unit/);
});

test('every official key loop stops rotating on permanent input', () => {
  const loops: Array<[string, string | undefined]> = [
    ['export async function fetchYouTubeFeaturedChannels', '/** One bounded playlistItems call'],
    ['export async function fetchYouTubePlaylistChannels', '/**\n * Retrieves all valid YouTube API keys'],
    ['export async function resolveYouTubeLocatorAuthoritatively', 'export interface YouTubeChannelPage'],
    ['export async function searchYouTubeChannelPage', '/**\n * Fetches recent video titles'],
    ['export async function fetchRecentVideoDescriptionsWithIds', '/** Accounts one successful provider response'],
    ['export async function fetchYouTubeChannelEnrichment', '/** One-unit basic metadata hydration used when country or subscriber evidence is missing. */'],
    ['export async function fetchYouTubeChannelCountryMetadata', undefined],
  ];
  for (const [start, end] of loops) {
    const block = functionBlock(start, end);
    assert.match(block, /isYouTubePermanentInputError\(/, `${start} must stop key rotation on permanent input`);
  }
});
