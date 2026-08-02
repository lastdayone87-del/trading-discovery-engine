import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalEvidenceCorpus, validateEvidenceProvenance } from './canonicalEvidencePlane';
import { EvidenceBasedTradingEngine } from './index';
import { ChannelMetadataProvider } from './providers/ChannelMetadataProvider';
import { CountryKnowledgeProvider } from './providers/CountryKnowledgeProvider';
import { MultilingualContextProvider } from './providers/MultilingualContextProvider';
import { VideoMetadataProvider } from './providers/VideoMetadataProvider';
import { evaluateUnifiedDecisionPolicy } from './decisionPolicy';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

test('canonical plane projects every supported evidence surface with stable attribution',()=>{
  const input={channel_id:'c1',channel_name:'Trader',description:'bio',videos:[{id:'v1',title:'setup',description:'risk',published_at:'2026-01-01'}],playlists:[{id:'p1',name:'Lessons',description:'course'}],transcript_excerpts:[{video_id:'v1',text:'entry and stop'}],external_link_details:[{label:'Charts',url:'https://tradingview.com',domain:'tradingview.com'}],visual_evidence:[{source_ref:'v1:frame',description:'chart with order entry',model_provenance:'m1'}],location_tag:'Paris',discord_invite:'https://discord.gg/traders',pinned_comment:'risk rules',activity_metadata:{uploads_last_30_days:2}};
  const a=buildCanonicalEvidenceCorpus(input),b=buildCanonicalEvidenceCorpus(input);
  assert.deepEqual(a,b);assert.deepEqual(new Set(a.map(document=>document.field)),new Set(['channel_title','channel_bio','video_title','video_description','playlist_name','playlist_description','transcript_excerpt','external_link_label','external_link_domain','visual_evidence','location','discord_invite','pinned_comment','activity_metadata']));
  assert.ok(a.every(document=>document.id&&document.sourceFamilyId));assert.equal(a.find(document=>document.field==='video_title')?.sourceFamilyId,a.find(document=>document.field==='transcript_excerpt')?.sourceFamilyId);
});

test('content language routing confirms independently recurring French practice without a country default',async()=>{
  const engine=new EvidenceBasedTradingEngine([new ChannelMetadataProvider(),new VideoMetadataProvider(),new CountryKnowledgeProvider(),new MultilingualContextProvider()]);
  const decision=await engine.evaluateChannel({channel_id:'multi-fr',channel_name:'Marchés en direct',description:'Apprendre avec une méthode documentée.',country:'UNKNOWN',videos:[{id:'v1',title:'Plan de trading et point d’entrée'},{id:'v2',title:'Gestion du risque et journal de trading'}]});
  assert.equal(decision.status,'TRADING_CONFIRMED');assert.equal(decision.stagedClassification?.lifecycleAction,'CONFIRM');assert.ok(decision.decisionPolicy);assert.ok((decision.decisionPolicy?.coverageConfidence||0)>=65);
  assert.equal(validateEvidenceProvenance([...decision.positiveEvidence,...decision.negativeEvidence]).length,0);
});

test('selective policy preserves abstention and affirmative-negative safety',()=>{
  const collection:EvidenceCollectionReport={sufficiency:'SUFFICIENT',sparseMetadata:false,degraded:false,fieldsPresent:['channel_name'],reasonCodes:[],providers:[]};
  const item=(polarity:'POSITIVE'|'NEGATIVE',weight:number):EvidenceItem=>({id:polarity,source:'channel_metadata',polarity,category:polarity==='POSITIVE'?'METHODOLOGY_CONCEPT':'IRRELEVANT_DOMAIN',fact:polarity,rawMatches:['x'],confidence:90,reliability:'HIGH',reliabilityMultiplier:.85,rawWeight:Math.abs(weight),finalWeight:weight,provenance:{provider:'channel_metadata',type:'test',matchedTerm:'x',sourceRef:'test',fields:[{field:'channel_bio',sourceId:'d1',sourceFamilyId:'f1'}]},timestamp:'2026-01-01T00:00:00Z'});
  assert.equal(evaluateUnifiedDecisionPolicy({evidence:[item('POSITIVE',40)],collection,lifecycleAction:'REVIEW',minimumPositiveWeight:15,minimumTradingScore:65}).status,'UNCERTAIN');
  assert.equal(evaluateUnifiedDecisionPolicy({evidence:[item('NEGATIVE',-30)],collection,lifecycleAction:'REJECT',minimumPositiveWeight:15,minimumTradingScore:65}).status,'NON_TRADING');
  assert.equal(evaluateUnifiedDecisionPolicy({evidence:[],collection:{...collection,sufficiency:'INSUFFICIENT'},lifecycleAction:'ENRICH',minimumPositiveWeight:15,minimumTradingScore:65}).status,'UNCERTAIN');
});
