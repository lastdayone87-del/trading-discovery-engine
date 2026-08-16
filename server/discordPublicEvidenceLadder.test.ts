import assert from 'node:assert/strict';
import test from 'node:test';
import {validateDiscordInvite} from './discordValidator';

const noopEmit=async()=>{};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

const invite=(overrides:any={})=>({
  code:'room',
  approximate_member_count:100,
  approximate_presence_count:10,
  guild:{id:'guild-1',name:'General Community',description:'',features:[],...overrides.guild},
  channel:{name:'general'},
  ...overrides
});

test('uses welcome-screen descriptions from invite metadata before extra requests',async()=>{
  let calls=0;
  const result=await validateDiscordInvite('room',{
    fetchImpl:async()=>{calls++;return json(invite({guild:{id:'guild-1',name:'General Community',description:'',welcome_screen:{description:'Welcome',welcome_channels:[{description:'Futures order flow trade room'}]}}}));},
    emitProviderEvent:noopEmit as any
  });
  assert.equal(result.relevanceStatus,'TRADING_RELEVANT');
  assert.equal(result.inviteUrl,'https://discord.gg/room');
  assert.equal(calls,1);
  assert.equal(result.evidenceCoverage?.inviteWelcomeScreen,'PRESENT');
  assert.equal(result.evidenceCoverage?.publicEvidenceRequests,0);
});

test('live ambiguous invite is enriched by public welcome screen without repeating invite lookup',async()=>{
  const urls:string[]=[];
  const result=await validateDiscordInvite('room',{
    fetchImpl:async(input:any)=>{
      const url=String(input);urls.push(url);
      if(url.includes('/invites/'))return json(invite());
      if(url.includes('/welcome-screen'))return json({description:'Trading education',welcome_channels:[{description:'Price action and risk management'}]});
      throw new Error(`unexpected ${url}`);
    },
    emitProviderEvent:noopEmit as any,
    publicEvidenceMaxRequests:2
  });
  assert.equal(result.relevanceStatus,'TRADING_RELEVANT');
  assert.equal(urls.filter(url=>url.includes('/invites/')).length,1);
  assert.equal(urls.filter(url=>url.includes('/welcome-screen')).length,1);
  assert.equal(result.evidenceCoverage?.publicWelcomeScreen,'COMPLETED');
});

test('falls through to public widget when welcome screen is unavailable',async()=>{
  const urls:string[]=[];
  const result=await validateDiscordInvite('room',{
    fetchImpl:async(input:any)=>{
      const url=String(input);urls.push(url);
      if(url.includes('/invites/'))return json(invite());
      if(url.includes('/welcome-screen'))return json({message:'not enabled'},404);
      if(url.includes('/widget.json'))return json({id:'guild-1',name:'General Community',channels:[{id:'1',name:'futures-trading-floor'}],members:[],presence_count:5});
      throw new Error(`unexpected ${url}`);
    },
    emitProviderEvent:noopEmit as any,
    publicEvidenceMaxRequests:2
  });
  assert.equal(result.relevanceStatus,'TRADING_RELEVANT');
  assert.equal(result.evidenceCoverage?.publicWelcomeScreen,'UNAVAILABLE');
  assert.equal(result.evidenceCoverage?.publicWidget,'COMPLETED');
  assert.equal(urls.filter(url=>url.includes('/invites/')).length,1);
});

test('unavailable public evidence preserves ACTIVE liveness and semantic uncertainty',async()=>{
  const urls:string[]=[];
  const result=await validateDiscordInvite('room',{
    fetchImpl:async(input:any)=>{
      const url=String(input);urls.push(url);
      if(url.includes('/invites/'))return json(invite());
      return json({message:'not available'},403);
    },
    emitProviderEvent:noopEmit as any,
    publicEvidenceMaxRequests:2
  });
  assert.equal(result.livenessStatus,'ACTIVE');
  assert.equal(result.relevanceStatus,'UNCERTAIN');
  assert.equal(result.validationStatus,'SUCCEEDED');
  assert.equal(result.retryable,false);
  assert.equal(result.evidenceCoverage?.publicWelcomeScreen,'UNAVAILABLE');
  assert.equal(result.evidenceCoverage?.publicWidget,'UNAVAILABLE');
  assert.equal(urls.filter(url=>url.includes('/invites/')).length,1);
  assert.match(result.relevanceReason||'',/coverage\(/i);
});

test('explicit unrelated native evidence stops enrichment and remains non-trading',async()=>{
  let calls=0;
  const result=await validateDiscordInvite('room',{
    fetchImpl:async()=>{calls++;return json(invite({guild:{id:'guild-1',name:'Minecraft Gaming Community',description:''}}));},
    emitProviderEvent:noopEmit as any
  });
  assert.equal(result.relevanceStatus,'NON_TRADING');
  assert.equal(calls,1);
  assert.equal(result.evidenceCoverage?.publicEvidenceRequests,0);
});
