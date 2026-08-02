import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractCreatorRelationships, graphExperimentAssignment } from './persistentResearchPhase2';

const channel='UC1234567890123456789012';

test('relationship extraction is source-span bound, typed, deduplicated and fan-out limited',()=>{const text=`Featured channel ${channel}; guest collaboration with @Market-Mentor and again @Market-Mentor`;const all=extractCreatorRelationships(text,10);assert.equal(all.find(item=>item.targetValue===channel)?.relationshipType,'FEATURES');assert.equal(all.find(item=>item.targetValue==='@Market-Mentor')?.relationshipType,'COLLABORATES_WITH');assert.equal(all.filter(item=>item.targetValue==='@Market-Mentor').length,1);assert.ok(all.every(item=>item.startOffset>=0&&item.endOffset>item.startOffset));assert.equal(extractCreatorRelationships(`${text} @one @two`,1).length,1);});

test('graph experiment assignment is deterministic and records the selected-arm propensity',()=>{const first=graphExperimentAssignment('candidate-a',4000),again=graphExperimentAssignment('candidate-a',4000);assert.deepEqual(first,again);assert.ok(first.arm==='GRAPH'||first.arm==='SEARCH_CONTROL');assert.equal(first.propensityBasisPoints,first.arm==='GRAPH'?4000:6000);assert.throws(()=>graphExperimentAssignment('x',0),/INVALID_GRAPH_EXPERIMENT_ALLOCATION/);});

test('phase two migration is additive, bounded and makes experiment facts immutable',()=>{const sql=fs.readFileSync(new URL('./db/migrations/047_persistent_research_phase2_graph.sql',import.meta.url),'utf8');assert.match(sql,/creator_relationship_candidates/);assert.match(sql,/graph_search_experiment_assignments/);assert.match(sql,/graph_search_experiment_outcomes/);assert.match(sql,/reject_immutable_event_mutation/);assert.doesNotMatch(sql,/DROP TABLE|DROP COLUMN|TRUNCATE/i);});

test('phase two controller wires producers, resolver, temporal edges, controls and parent links',()=>{const controller=fs.readFileSync(new URL('./persistentResearchController.ts',import.meta.url),'utf8'),domain=fs.readFileSync(new URL('./persistentResearch.ts',import.meta.url),'utf8');for(const token of ['generateCreatorRelationshipActions','finalizeCreatorRelationshipActions','generateStaleFrontierRefreshActions','recordTemporalRelationship','SEARCH_CONTROL','relationshipOutcomes'])assert.match(controller,new RegExp(token));for(const type of ['INSPECT_FEATURED_CHANNELS','INSPECT_COLLABORATOR','RESOLVE_EXTERNAL_ENTITY','REFRESH_STALE_FRONTIER'])assert.match(domain,new RegExp(type));assert.match(domain,/parent_link_id/);});
