import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mapCreatorActivity, projectCreatorOutcome, type CreatorOutcomeProjectionSource } from './shadowProjection';

const at='2026-08-01T00:00:00.000Z';
const source=(patch:Partial<CreatorOutcomeProjectionSource>={}):CreatorOutcomeProjectionSource=>({queryRunId:'00000000-0000-0000-0000-000000000001',queryId:1,query:'DAX Analyse',country:'Germany',retrievalLane:'VIDEO',searchOrdering:'RELEVANCE',channelId:'channel-1',wasKnown:false,persisted:true,countryOutcome:'CONFIRMED',tradingOutcome:'UNCERTAIN',sightingObservedAt:at,sourceEventKeys:['query-run:1:channel:1'],providerUnits:100,reviewUnits:0,...patch});

test('projection is deterministic and gives no creator credit without canonical creator identity',()=>{const first=projectCreatorOutcome(source({classificationStatus:'TRADING_CONFIRMED'}),at),second=projectCreatorOutcome(source({classificationStatus:'TRADING_CONFIRMED'}),at);assert.deepEqual(first,second);assert.equal(first.outcome.outcomeType,'NEW_VERIFIED_CREATOR');assert.equal(first.outcome.verifiedCreatorCredit,false);assert.equal(first.outcome.incremental,false);});

test('approved creator identity and active evidence are required for active creator credit',()=>{const projected=projectCreatorOutcome(source({classificationStatus:'TRADING_CONFIRMED',canonicalCreatorId:'00000000-0000-0000-0000-000000000002',activityBand:'VERY_ACTIVE',activityObservedAt:at}),at);assert.equal(projected.outcome.verifiedCreatorCredit,true);assert.equal(projected.outcome.activeCreatorCredit,true);assert.equal(projected.outcome.incremental,true);});

test('review decisions supersede provisional classification and produce terminal outcomes',()=>{const rejected=projectCreatorOutcome(source({classificationStatus:'TRADING_CONFIRMED',reviewDecision:'REJECT',reviewDecisionId:'review-1',reviewDecidedAt:at,reviewUnits:1}),at);assert.equal(rejected.outcome.outcomeType,'HUMAN_REJECTED');assert.equal(rejected.outcome.maturity,'TERMINAL');assert.equal(rejected.outcome.verifiedCreatorCredit,false);});

test('country rejection is terminal to creator qualification and enrichment raises maturity only',()=>{const wrong=projectCreatorOutcome(source({countryOutcome:'REJECTED',classificationStatus:'TRADING_CONFIRMED',enrichmentStage:2}),at);assert.equal(wrong.outcome.outcomeType,'COUNTRY_REJECTED');assert.equal(wrong.outcome.maturity,'ENRICHED');assert.equal(wrong.outcome.verifiedCreatorCredit,false);});

test('activity mapping is explicit and conservative',()=>{assert.equal(mapCreatorActivity(source({activityBand:'OCCASIONAL'})).status,'RECENTLY_ACTIVE');assert.equal(mapCreatorActivity(source({activityBand:'DORMANT'})).status,'DORMANT');assert.equal(mapCreatorActivity(source({activityBand:undefined})).status,'UNKNOWN');});

test('Phase 1 migration is additive, immutable, disabled, and shadow-only',()=>{const sql=readFileSync(new URL('../db/migrations/070_creator_outcome_shadow_projection.sql',import.meta.url),'utf8');for(const table of ['creator_outcome_projection_control','creator_outcome_projection_runs','creator_outcome_records','creator_outcome_source_events'])assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));assert.match(sql,/enabled BOOLEAN NOT NULL DEFAULT false/);assert.match(sql,/CHECK\(mode='SHADOW'\)/);assert.match(sql,/reject_immutable_event_mutation/);assert.doesNotMatch(sql,/DROP TABLE|DROP COLUMN|TRUNCATE/i);});

test('Phase 1 projection is not wired into production entry points',()=>{for(const file of ['../../server.ts','../autonomousDiscovery.ts','../queueManager.ts','../queryIntelligence.ts']){const text=readFileSync(new URL(file,import.meta.url),'utf8');assert.doesNotMatch(text,/projectShadowCreatorOutcomes|creator_outcome_records/);}});
