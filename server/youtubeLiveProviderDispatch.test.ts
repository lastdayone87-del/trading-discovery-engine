import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { selectYouTubeDispatchProviderIndex } from './youtube';

test('dispatch provider selection keeps a healthy selected key', () => {
  const keys=['key-a','key-b','key-c'];
  assert.equal(selectYouTubeDispatchProviderIndex(keys,'key-b',key=>key!=='key-a'),1);
});

test('dispatch provider selection reselects a currently healthy key when the queued key cooled', () => {
  const keys=['key-a','key-b','key-c'];
  const eligible=new Set(['key-c']);
  assert.equal(selectYouTubeDispatchProviderIndex(keys,'key-a',key=>eligible.has(key)),2);
  eligible.delete('key-c');
  eligible.add('key-a');
  assert.equal(selectYouTubeDispatchProviderIndex(keys,'key-b',key=>eligible.has(key)),0);
});

test('youtubeFetch performs live reselection inside scheduler dispatch and rebuilds the provider URL', () => {
  const source=fs.readFileSync(new URL('./youtube.ts',import.meta.url),'utf8');
  const schedulerStart=source.indexOf('youtubeRequestScheduler.run(()=>{');
  const selection=source.indexOf('selectYouTubeDispatchProviderIndex(livePool,providerKey)',schedulerStart);
  const rewrite=source.indexOf("rebuiltUrl.searchParams.set('key',dispatchedProviderKey)",selection);
  const outbound=source.indexOf('fetch(dispatchedUrl,{signal})',rewrite);
  assert.ok(schedulerStart>=0&&selection>schedulerStart&&rewrite>selection&&outbound>rewrite);
  assert.match(source,/recordProviderFailure\(key: string, error: unknown\)[\s\S]*providerKey/);
  const readerStart=source.indexOf('export async function readYouTubeJsonObject');
  const reader=source.slice(readerStart,source.indexOf('/** A request-rate limit',readerStart));
  const youtubeFetch=source.slice(source.indexOf('async function youtubeFetch'),source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  assert.doesNotMatch(youtubeFetch,/activeKeyIndex=dispatchIndex/);
  assert.doesNotMatch(youtubeFetch,/youtubeProviderCooldown\.succeeded\(dispatchedProviderKey\)/);
  assert.match(reader,/youtubeProviderCooldown\.succeeded\(context\.providerKey,context\.providerFailureGeneration\)/);
  assert.match(youtubeFetch,/dispatchFailureGeneration=dispatchedProviderKey\?youtubeProviderCooldown\.failureGeneration\(dispatchedProviderKey\):undefined/);
  assert.match(reader,/validatedIndex=validatedPool\.indexOf\(context\.providerKey\)/);
  assert.match(reader,/if\(validatedIndex>=0\)activeKeyIndex=advanceYouTubeRotation\(validatedPool\.length,validatedIndex\)/);
});

test('featured-channel inspection fails over across healthy keys', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function fetchYouTubeFeaturedChannels');
  const end = source.indexOf('/** One bounded playlistItems call', start);
  assert.ok(start >= 0 && end > start, 'featured-channel function must remain discoverable');
  const block = source.slice(start, end);
  assert.match(block, /for \(let attempt = 0; attempt < providerIndexes\.length; attempt\+\+\)/);
  assert.match(block, /youtubeFetch\(url, 'featured-channel-sections'[^)]*apiKey\)/);
  assert.match(block, /recordProviderFailure\(apiKey, error\)/);
  assert.match(block, /attempt === providerIndexes\.length - 1/);
  assert.match(block, /throwIfAllProvidersCoolingDown\(keys\)/);
  assert.doesNotMatch(block, /const index = availableKeyIndexes\(keys\)\[0\]/);
});

test('featured and playlist inspections never refetch after an accounted response', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  for (const [startMarker, endMarker] of [
    ['export async function fetchYouTubeFeaturedChannels', '/** One bounded playlistItems call'],
    ['export async function fetchYouTubePlaylistChannels', '/**\n * Retrieves all valid YouTube API keys'],
  ]) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${startMarker} boundary must remain discoverable`);
    const block = source.slice(start, end);
    assert.match(block, /let responseAccounted\s*=\s*false;/);
    const account = block.indexOf('await accountYouTubeQuotaResponse(');
    const markAccounted = block.slice(account).search(/responseAccounted\s*=\s*true;/) + account;
    const guardMatch = block.slice(markAccounted).match(/if\s*\(\s*responseAccounted\s*\|\|/);
    const guard = guardMatch ? markAccounted + guardMatch.index! : -1;
    assert.ok(account >= 0 && markAccounted > account && guard > markAccounted,
      `${startMarker} must surface a post-accounting parse failure instead of failing over`);
  }
});

test('pre-dispatch abort releases the exact enforced lease before throwing', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  const abortCheck = youtubeFetch.indexOf('if(signal.aborted)');
  const fetchCall = youtubeFetch.indexOf('response=await fetch(dispatchedUrl');
  assert.ok(abortCheck >= 0 && fetchCall > abortCheck, 'abort check must precede dispatch');
  const block = youtubeFetch.slice(abortCheck, fetchCall);
  assert.match(block, /settleKeyCapReservation\(pool,capReservation\)/);
  assert.match(block, /throw preDispatchAbortError\(signal\)/);
  assert.match(youtubeFetch, /assertKeyCapReservationDayCurrent\(capReservation, new Date\(\)\)[\s\S]*settleKeyCapReservation/);
});

test('youtubeFetch gates dispatch on suspension hydration and captures generation before fetch', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  // Workers start before DB readiness: dispatch must await the shared
  // hydration promise so a restart cannot reprobe a durably suspended key.
  const gate = youtubeFetch.indexOf('await ensureYouTubeSuspensionHydration()');
  const timeoutRead = youtubeFetch.indexOf('getAppSetting');
  assert.ok(gate >= 0 && gate < timeoutRead, 'hydration gate must precede all dispatch work');
  // The failure generation must predate the request: a suspension landing
  // mid-flight has to compare stale when the response is validated.
  const genCapture = youtubeFetch.indexOf('dispatchFailureGeneration=dispatchedProviderKey?youtubeProviderCooldown.failureGeneration(dispatchedProviderKey):undefined');
  const fetchCall = youtubeFetch.indexOf('response=await fetch(dispatchedUrl');
  assert.ok(genCapture >= 0 && fetchCall > genCapture, 'generation must be captured before fetch resolves');
  assert.match(youtubeFetch, /providerFailureGeneration:dispatchFailureGeneration/);
  assert.doesNotMatch(youtubeFetch, /providerFailureGeneration=dispatchedProviderKey\?youtubeProviderCooldown\.failureGeneration/);
});
