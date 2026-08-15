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
  assert.match(reader,/youtubeProviderCooldown\.succeeded\(context\.providerKey\)/);
  assert.match(reader,/validatedIndex=validatedPool\.indexOf\(context\.providerKey\)/);
  assert.match(reader,/if\(validatedIndex>=0\)activeKeyIndex=validatedIndex/);
});
