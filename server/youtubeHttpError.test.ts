import test from 'node:test';
import assert from 'node:assert/strict';
import { readYouTubeJsonObject, youtubeHttpError } from './youtube';
import { ProviderCallError } from './providerResilience';

test('reads modern google.rpc ErrorInfo rate-limit reasons',async()=>{
  const response=new Response(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[{reason:'RATE_LIMIT_EXCEEDED'}]}}),{status:429,headers:{'content-type':'application/json'}});
  const error=await youtubeHttpError(response) as Error&{status:number;quotaExceeded:boolean;providerReasons:string[]};
  assert.equal(error.status,429);
  assert.equal(error.quotaExceeded,false);
  assert.deepEqual(error.providerReasons,['RATE_LIMIT_EXCEEDED']);
  assert.match(error.message,/429 RESOURCE_EXHAUSTED \(RATE_LIMIT_EXCEEDED\)/);
});

test('rejects successful plain-text upstream bodies as retryable provider failures',async()=>{
  const response=new Response('upstream error',{status:200,headers:{'content-type':'text/plain'}});
  await assert.rejects(()=>readYouTubeJsonObject(response,'recent-videos-search'),(error:unknown)=>{
    assert.ok(error instanceof ProviderCallError);
    assert.equal((error as ProviderCallError).errorClass,'TRANSIENT');
    assert.equal((error as ProviderCallError).retryable,true);
    assert.equal((error as ProviderCallError).status,200);
    assert.match((error as Error).message,/non-JSON/);
    return true;
  });
});

test('rejects malformed JSON bodies without exposing a SyntaxError',async()=>{
  const response=new Response('upstream error',{status:200,headers:{'content-type':'application/json'}});
  await assert.rejects(()=>readYouTubeJsonObject(response,'video-details'),(error:unknown)=>{
    assert.ok(error instanceof ProviderCallError);
    assert.match((error as Error).message,/invalid JSON/);
    assert.equal((error as ProviderCallError).retryable,true);
    return true;
  });
});

test('rejects an HTTP-200 provider error envelope',async()=>{
  const response=new Response(JSON.stringify({error:{status:'UNAVAILABLE'}}),{status:200,headers:{'content-type':'application/json'}});
  await assert.rejects(()=>readYouTubeJsonObject(response,'recent-videos-search'),/provider error payload/);
});

test('rejects a schema-less JSON body instead of treating it as empty results',async()=>{
  const response=new Response(JSON.stringify({message:'upstream error'}),{status:200,headers:{'content-type':'application/json'}});
  await assert.rejects(()=>readYouTubeJsonObject(response,'video-details'),/without an items array/);
});

test('accepts a valid JSON object from the YouTube provider',async()=>{
  const response=new Response(JSON.stringify({items:[{id:'video-1'}]}),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
  const payload=await readYouTubeJsonObject<{items:Array<{id:string}>}>(response,'recent-videos-search');
  assert.equal(payload.items[0].id,'video-1');
});
