import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyCoverageStats, evaluateSleep, frontierScore, lifecycleDecisionKey, reduceCoverage, replayCoverage } from './coverageLifecycle';

const a={outcomeKey:'a',cellKey:'jp-ja-search-fresh-high',observedAt:'2026-07-29T01:00:00Z',distinctResults:10,newCreators:1,duplicateResults:9,verifiedCreators:1,providerCost:100,delayedBacklog:0};
const b={...a,outcomeKey:'b',observedAt:'2026-07-29T02:00:00Z',newCreators:0,verifiedCreators:0};

test('coverage replay is retry-idempotent and order invariant',()=>{
  assert.deepEqual(replayCoverage([a,b,a]),replayCoverage([b,a]));
  assert.equal(replayCoverage([a,b]).get(a.cellKey)?.evidenceCount,2);
});
test('coverage reducer rejects invalid facts and retains event-time bounds',()=>{
  assert.throws(()=>reduceCoverage(emptyCoverageStats(),{...a,providerCost:-1}));
  const value=reduceCoverage(reduceCoverage(emptyCoverageStats(),b),a);assert.equal(value.firstObservedAt,new Date(a.observedAt).toISOString());assert.equal(value.lastObservedAt,new Date(b.observedAt).toISOString());
});
test('frontier scoring is cost aware and bounded',()=>{assert.equal(frontierScore({expectedCoverage:2,informationGain:1,freshnessValue:1,expectedCost:2}),2);assert.equal(frontierScore({expectedCoverage:2,informationGain:1,freshnessValue:1,expectedCost:0}),0);});
test('sleep requires every approved predicate including delayed backlog',()=>{
  const ready={evidenceCount:20,minimumEvidence:20,bestFrontierUpperBound:.1,costAwareThreshold:.2,rediscoveryRate:.9,minimumRediscoveryRate:.8,uncoveredReachableCells:0,highInformationActions:0,delayedBacklog:1,maximumDelayedBacklog:1};
  assert.equal(evaluateSleep(ready).shouldSleep,true);assert.equal(evaluateSleep({...ready,delayedBacklog:2}).shouldSleep,false);assert.equal(evaluateSleep({...ready,uncoveredReachableCells:1}).shouldSleep,false);
});
test('lifecycle keys are deterministic and decisions versioned',()=>{const x={from:'SLEEPING',to:'ACTIVE',reason:'operator nomination',trigger:'HUMAN_NOMINATION'};assert.equal(lifecycleDecisionKey(x),lifecycleDecisionKey(x));assert.notEqual(lifecycleDecisionKey(x),lifecycleDecisionKey({...x,trigger:'SCHEDULED_PROBE'}));});
test('phase 7 migration is additive, immutable, replayable, and capped',()=>{const sql=readFileSync(new URL('./db/migrations/022_coverage_lifecycle.sql',import.meta.url),'utf8');assert.doesNotMatch(sql,/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE)\b/i);assert.match(sql,/research_coverage_statistics/);assert.match(sql,/research_coverage_projection_events/);assert.match(sql,/research_lifecycle_events_immutable/);assert.match(sql,/provider_cost_cap INTEGER NOT NULL DEFAULT 0/);assert.match(sql,/absolute ecosystem recall percentage/);});
