import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAdaptiveShadow, type AdaptiveTerm } from './adaptiveTradingClassifier';
import type { VerificationDecision } from './evidenceEngine';
import fs from 'node:fs';
import path from 'node:path';

const production=(status:'TRADING_CONFIRMED'|'NON_TRADING'|'UNCERTAIN'):VerificationDecision=>({status,confidenceScore:50,category:'General Trading',multiVideoConsistencyRatio:.5,positiveEvidence:[],negativeEvidence:[],totalPositiveWeight:0,totalNegativeWeight:0,countryContextUsed:{country:'US',language:'English',matchedTerms:[],matchedNegativeTerms:[]},versions:{evidenceEngineVersion:'p',decisionEngineVersion:'p',scoringEngineVersion:'p',knowledgePackVersion:'p',geminiModelVersion:'p'},mathematicalJustification:'fixture',timestamp:'2026-01-01T00:00:00Z'});
const term=(id:string,literal:string):AdaptiveTerm=>({surfaceId:`s-${id}`,conceptId:`c-${id}`,literal,normalized:literal.toLowerCase(),conceptClass:'STRATEGY',origin:'HUMAN_APPROVED_TERMINOLOGY',catalogVersion:'7'});

test('learned terminology without governance contributes no adaptive evidence',()=>{
  const r=classifyAdaptiveShadow({channel_name:'Delta scalping',description:'',country:'US'},production('UNCERTAIN'),[]);
  assert.equal(r.status,'UNCERTAIN');assert.equal(r.evidence.length,0);assert.ok(r.reasonCodes.includes('NO_GOVERNED_ADAPTIVE_EVIDENCE'));
});

test('one governed concept cannot bypass conservative corroboration',()=>{
  const r=classifyAdaptiveShadow({channel_name:'Delta scalping',description:'',video_titles:['Delta scalping setup'],country:'US'},production('UNCERTAIN'),[term('1','delta scalping')]);
  assert.notEqual(r.status,'TRADING_CONFIRMED');
});

test('production non-trading decision vetoes an adaptive confirmation',()=>{
  const terms=[term('1','delta scalping'),term('2','footprint chart'),term('3','order flow')];
  const r=classifyAdaptiveShadow({channel_name:'Delta scalping and order flow',description:'footprint chart',video_titles:['Delta scalping footprint chart order flow'],country:'US'},production('NON_TRADING'),terms,new Set(terms.map(t=>t.conceptId)));
  assert.notEqual(r.status,'TRADING_CONFIRMED');
});

test('shadow observers are detached from ingestion and review transactions',()=>{
  const ingestion=fs.readFileSync(path.join(process.cwd(),'server/ingestionPipeline.ts'),'utf8');
  const reviews=fs.readFileSync(path.join(process.cwd(),'server/reviewStore.ts'),'utf8');
  assert.match(ingestion,/void runAndRecordAdaptiveShadow/);assert.doesNotMatch(ingestion,/await runAndRecordAdaptiveShadow/);
  assert.match(reviews,/await client\.query\('COMMIT'\);[\s\S]*void recordAdaptiveShadowLabel/);
  assert.doesNotMatch(reviews,/await recordAdaptiveShadowLabel/);
});
