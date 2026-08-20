import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {providerSnapshot,YOUTUBE_SEARCH_PROVIDER,executeAllocatedRetrievalPage} from './providerAwareRetrieval';

test('current production provider contract preserves official YouTube semantics',()=>{
 assert.deepEqual(YOUTUBE_SEARCH_PROVIDER,{providerKey:'youtube-search',retrievalSurface:'YOUTUBE_NATIVE',capability:'SEARCH_YOUTUBE',costDomain:'YOUTUBE_DATA_API',continuationOwner:'PHASE_9'});
 assert.equal(providerSnapshot(undefined),YOUTUBE_SEARCH_PROVIDER);
});

test('unknown provider and mid-run lineage changes fail closed before execution',async()=>{
 assert.throws(()=>providerSnapshot({...YOUTUBE_SEARCH_PROVIDER,providerKey:'arbitrary'} as any),/INVALID_PROVIDER_ALLOCATION_SNAPSHOT/);
 await assert.rejects(executeAllocatedRetrievalPage({provider:{...YOUTUBE_SEARCH_PROVIDER,capability:'OTHER'} as any,query:'x',country:'US',lane:'VIDEO',cursor:null,ordering:'RELEVANCE'}),/UNREGISTERED_OR_MISMATCHED/);
});

test('migration is additive, backfills official-only history and protects lineage',()=>{
 const sql=readFileSync(new URL('./db/migrations/111_provider_aware_phase8_phase9.sql',import.meta.url),'utf8');
 for(const field of ['provider_key','retrieval_surface','provider_capability','cost_domain','provider_reservation_id','provider_eligibility_snapshot','continuation_owner'])assert.match(sql,new RegExp(field));
 assert.match(sql,/WHERE provider_key IS NULL/);assert.match(sql,/IMMUTABLE_PROVIDER_ALLOCATION_LINEAGE/);
 assert.doesNotMatch(sql,/DROP TABLE|DROP COLUMN|TRUNCATE/i);
});

test('Phase 8 registry validation and Phase 9 governed dispatch are wired',()=>{
 const allocator=readFileSync(new URL('./discoveryFrontierAllocator.ts',import.meta.url),'utf8');
 const queue=readFileSync(new URL('./queueManager.ts',import.meta.url),'utf8');
 assert.match(allocator,/discovery_provider_registry[\s\S]*FOR SHARE/);assert.match(allocator,/provider_eligibility_snapshot/);
 assert.match(queue,/executeAllocatedRetrievalPage/);assert.match(queue,/PHASE9_PROVIDER_LINEAGE_MISMATCH/);
});
