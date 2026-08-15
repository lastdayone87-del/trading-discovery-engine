import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isQuotaExceeded, YouTubePoolBackoff, YouTubePoolExhaustedError } from './youtubePoolBackoff';

const fixture = () => {
  let now = 1_000; const logs: string[] = [];
  const pool = new YouTubePoolBackoff({initialBackoffMs:100,maxBackoffMs:400,now:()=>now,log:(_level,message)=>logs.push(message)});
  return {pool,logs,advance:(ms:number)=>{now+=ms}};
};

function exhaust(pool: YouTubePoolBackoff): void {
  const acquisition=pool.beginAcquisition();
  acquisition.providerFailed('QUOTA_EXHAUSTED');
  acquisition.release();
}

test('complete pool exhaustion suspends acquisition and emits one transition event',()=>{const f=fixture();exhaust(f.pool);assert.throws(()=>f.pool.beginAcquisition(),YouTubePoolExhaustedError);assert.equal(f.logs.filter(x=>x.includes('suspended')).length,1)});
test('one lightweight probe is admitted after backoff',()=>{const f=fixture();exhaust(f.pool);f.advance(100);const probe=f.pool.beginAcquisition();assert.throws(()=>f.pool.beginAcquisition(),YouTubePoolExhaustedError);probe.release()});
test('repeated quota exhaustion extends backoff',()=>{const f=fixture();exhaust(f.pool);assert.equal(f.pool.getRetryAt(),1100);f.advance(100);const first=f.pool.beginAcquisition();first.providerFailed('QUOTA_EXHAUSTED');assert.equal(f.pool.getRetryAt(),1300);f.advance(200);const second=f.pool.beginAcquisition();second.providerFailed('QUOTA_EXHAUSTED');assert.equal(f.pool.getRetryAt(),1700)});
test('an indeterminate failed probe stays bounded instead of retrying continuously',()=>{const f=fixture();exhaust(f.pool);f.advance(100);const probe=f.pool.beginAcquisition();probe.providerFailed('INDETERMINATE');assert.equal(f.pool.getRetryAt(),1300);assert.throws(()=>f.pool.beginAcquisition(),YouTubePoolExhaustedError)});
test('recovery after quota reset closes the breaker and logs one resume event',()=>{const f=fixture();exhaust(f.pool);f.advance(100);const probe=f.pool.beginAcquisition();probe.providerSucceeded();probe.release();const normal=f.pool.beginAcquisition();normal.release();assert.equal(f.logs.filter(x=>x.includes('resumed')).length,1)});

test('stale concurrent failure cannot reopen the breaker after successful recovery',()=>{const f=fixture();const stale=f.pool.beginAcquisition();exhaust(f.pool);f.advance(100);const probe=f.pool.beginAcquisition();probe.providerSucceeded();stale.providerFailed('QUOTA_EXHAUSTED');stale.release();const current=f.pool.beginAcquisition();current.release();assert.equal(f.pool.getRetryAt(),0)});

test('generation-based stale failure rejection also handles mixed closed-state concurrency',()=>{const f=fixture();const slowFailure=f.pool.beginAcquisition();const success=f.pool.beginAcquisition();assert.equal(slowFailure.generation,success.generation);success.providerSucceeded();slowFailure.providerFailed('QUOTA_EXHAUSTED');slowFailure.release();const next=f.pool.beginAcquisition();assert.ok(next.generation>success.generation);next.release();assert.equal(f.pool.getRetryAt(),0)});

test('releasing an unreported probe guarantees another probe can run',()=>{const f=fixture();exhaust(f.pool);f.advance(100);const abandoned=f.pool.beginAcquisition();abandoned.release();const replacement=f.pool.beginAcquisition();replacement.providerSucceeded();replacement.release();assert.equal(f.pool.getRetryAt(),0)});

test('successful provider outcome is not reversed by downstream database or JSON failures',()=>{for(const downstreamError of [new Error('database unavailable'),new SyntaxError('invalid JSON')]){const f=fixture();exhaust(f.pool);f.advance(100);const probe=f.pool.beginAcquisition();try{probe.providerSucceeded();throw downstreamError}catch{}finally{probe.release()}const normal=f.pool.beginAcquisition();normal.release();assert.equal(f.pool.getRetryAt(),0)}});

test('YouTube acquisition reports provider success only after validated JSON and uses provider-aware dispatch',()=>{
  const source=fs.readFileSync(new URL('./youtube.ts',import.meta.url),'utf8');
  const fetchStart=source.indexOf('async function youtubeFetch');
  const readerStart=source.indexOf('export async function readYouTubeJsonObject');
  assert.ok(fetchStart>=0&&readerStart>fetchStart);
  const fetchBlock=source.slice(fetchStart,readerStart);
  const readerEnd=source.indexOf('/** A request-rate limit',readerStart);
  const readerBlock=source.slice(readerStart,readerEnd);

  assert.doesNotMatch(fetchBlock,/providerSucceeded\(\)/);
  assert.match(readerBlock,/context\?\.acquisition\?\.providerSucceeded\(\)/);
  assert.match(readerBlock,/youtubeProviderCooldown\.succeeded\(context\.providerKey\)/);
  assert.match(readerBlock,/if\s*\(!Array\.isArray\(object\.items\)\)[\s\S]*context\?\.acquisition\?\.providerSucceeded\(\)/);

  const calls=[...source.matchAll(/youtubeFetch\(([^\n]+)\)/g)]
    .filter(match=>!match[1].includes('url:string'))
    .map(match=>match[1]);
  assert.ok(calls.length>=9);
  for(const args of calls){
    assert.match(args,/acquisition/);
    assert.match(args,/keys\[index\]|keyPool\[index\]|apiKey/);
  }
});

test('quota reason detection follows wrapped provider errors without treating generic failures as exhaustion',()=>{const quota=Object.assign(new Error('Provider rate limit reached.'),{cause:Object.assign(new Error('YouTube HTTP 403 (quotaExceeded)'),{quotaExceeded:true})});assert.equal(isQuotaExceeded(quota),true);assert.equal(isQuotaExceeded(Object.assign(new Error('YouTube HTTP 503'),{status:503})),false)});
