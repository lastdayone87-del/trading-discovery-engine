import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyTradingRelevanceDetailed} from './tradingRelevanceClassifier';
import {evaluateRetrievalSpecificity} from './retrievalSpecificity';
import {evaluateClassificationStages} from './evidenceEngine/stagedClassification';
import type {EvidenceCollectionReport,EvidenceItem} from './evidenceEngine';

test('field-aware production boundary preserves structured and aligned evidence',async()=>{
  const result=await classifyTradingRelevanceDetailed({channel_id:'c1',channel_name:' Order Flow Lab ',description:'About',country:'United States',
    videos:[{id:'v1',title:'NQ setup',description:'first description',published_at:'2026-01-01',language:'en'},{id:'v2',title:'Risk review',description:'second description',published_at:'2026-01-02',language:'en'}],
    playlists:[{id:'p1',name:'Trade reviews',description:'Execution archive'}],transcript_excerpts:[{video_id:'v1',text:'My stop loss and entry'}],
    detected_languages:[{language:'en',confidence:99,field:'video_title'}],external_link_details:[{url:'https://tradingview.com/x',domain:'tradingview.com'}],
    pinned_comment:'Risk rules',activity_metadata:{activity_band:'ACTIVE'},enrichment_stage:2});
  assert.equal(result.input.channel_name,'Order Flow Lab');
  assert.deepEqual(result.input.video_descriptions,['first description','second description']);
  assert.equal(result.input.videos?.[1].id,'v2');assert.equal(result.input.playlists?.[0].id,'p1');assert.equal(result.input.transcript_excerpts?.[0].video_id,'v1');
});

test('retrieval specificity is semantic and language independent',()=>{
  assert.equal(evaluateRetrievalSpecificity({semanticClass:'INSTRUMENT',governed:true}).eligibility,'STANDALONE');
  assert.equal(evaluateRetrievalSpecificity({semanticClass:'SESSION',governed:true}).eligibility,'MODIFIER_ONLY');
  assert.equal(evaluateRetrievalSpecificity({semanticClass:'TOPIC',governed:true,proven:true,validated:true,independentSources:2}).eligibility,'MODIFIER_ONLY');
  assert.equal(evaluateRetrievalSpecificity({semanticClass:'CONCEPT',governed:true,proven:true,validated:true,independentSources:2}).eligibility,'STANDALONE');
});

test('corroboration counts independent documents but not duplicate lexical emissions',()=>{
  const collection:EvidenceCollectionReport={sufficiency:'SUFFICIENT',sparseMetadata:false,degraded:false,fieldsPresent:['video_titles'],reasonCodes:[],providers:[]};
  const item=(id:string,index:number):EvidenceItem=>({id,source:'video_metadata',polarity:'POSITIVE',category:'METHODOLOGY_CONCEPT',fact:id,rawMatches:['order flow'],confidence:90,reliability:'HIGH',reliabilityMultiplier:.85,rawWeight:10,finalWeight:8.5,timestamp:'2026-01-01',provenance:{provider:'video_metadata',type:'method',matchedTerm:'order flow',sourceRef:`v${index}`,fields:[{field:'video_title',index,sourceId:`v${index}`}]}});
  assert.equal(evaluateClassificationStages({channel_name:'A',description:''},[item('a',0),item('b',1)],collection).lifecycleAction,'CONFIRM');
  assert.equal(evaluateClassificationStages({channel_name:'A',description:''},[item('a',0),item('duplicate',0)],collection).lifecycleAction,'REVIEW');
});
