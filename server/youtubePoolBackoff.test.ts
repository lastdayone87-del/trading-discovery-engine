import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaExceeded, YouTubePoolBackoff, YouTubePoolExhaustedError } from './youtubePoolBackoff';

const fixture = () => {
  let now = 1_000; const logs: string[] = [];
  const pool = new YouTubePoolBackoff({initialBackoffMs:100,maxBackoffMs:400,now:()=>now,log:(_level,message)=>logs.push(message)});
  return {pool,logs,advance:(ms:number)=>{now+=ms}};
};

test('complete pool exhaustion suspends acquisition and emits one transition event',()=>{const f=fixture();f.pool.beginAcquisition();f.pool.reportFailure(true);assert.throws(()=>f.pool.beginAcquisition(),YouTubePoolExhaustedError);f.pool.reportFailure(true);assert.equal(f.logs.filter(x=>x.includes('suspended')).length,1)});
test('one lightweight probe is admitted after backoff',()=>{const f=fixture();f.pool.reportFailure(true);f.advance(100);f.pool.beginAcquisition();assert.throws(()=>f.pool.beginAcquisition(),YouTubePoolExhaustedError)});
test('repeated quota exhaustion extends backoff',()=>{const f=fixture();f.pool.reportFailure(true);assert.equal(f.pool.getRetryAt(),1100);f.advance(100);f.pool.beginAcquisition();f.pool.reportFailure(true);assert.equal(f.pool.getRetryAt(),1300);f.advance(200);f.pool.beginAcquisition();f.pool.reportFailure(true);assert.equal(f.pool.getRetryAt(),1700)});
test('an indeterminate failed probe stays bounded instead of retrying continuously',()=>{const f=fixture();f.pool.reportFailure(true);f.advance(100);f.pool.beginAcquisition();f.pool.reportFailure(false);assert.equal(f.pool.getRetryAt(),1300);assert.throws(()=>f.pool.beginAcquisition(),YouTubePoolExhaustedError)});
test('normal recovery closes the breaker and logs one resume event',()=>{const f=fixture();f.pool.reportFailure(true);f.advance(100);f.pool.beginAcquisition();f.pool.reportSuccess();f.pool.beginAcquisition();assert.equal(f.logs.filter(x=>x.includes('resumed')).length,1)});
test('quota reason detection follows wrapped provider errors without treating generic failures as exhaustion',()=>{const quota=Object.assign(new Error('Provider rate limit reached.'),{cause:Object.assign(new Error('YouTube HTTP 403 (quotaExceeded)'),{quotaExceeded:true})});assert.equal(isQuotaExceeded(quota),true);assert.equal(isQuotaExceeded(Object.assign(new Error('YouTube HTTP 503'),{status:503})),false)});
