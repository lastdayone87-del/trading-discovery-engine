import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeHttpError } from './youtube';

test('reads modern google.rpc ErrorInfo rate-limit reasons',async()=>{
  const response=new Response(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[{reason:'RATE_LIMIT_EXCEEDED'}]}}),{status:429,headers:{'content-type':'application/json'}});
  const error=await youtubeHttpError(response) as Error&{status:number;quotaExceeded:boolean;providerReasons:string[]};
  assert.equal(error.status,429);
  assert.equal(error.quotaExceeded,false);
  assert.deepEqual(error.providerReasons,['RATE_LIMIT_EXCEEDED']);
  assert.match(error.message,/429 RESOURCE_EXHAUSTED \(RATE_LIMIT_EXCEEDED\)/);
});
