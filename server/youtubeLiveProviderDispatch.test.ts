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
  const schedulerStart=source.indexOf('return await youtubeRequestScheduler.run(()=>{');
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
