import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runChannelInspection} from './inspector';

test('channel-link trail counts distinct Discord invites and exposes all retained codes',async()=>{
  const result=await runChannelInspection({channelId:'c1',channelName:'Creator',channelBio:'bio',channelLinks:['https://discord.gg/same','https://discord.com/invite/same','https://discord.gg/other'],videoDescriptions:[]});
  const step=result.steps.find(item=>item.step==='EXTERNAL_LINKS');
  assert.equal(step?.status,'FOUND');
  assert.match(step?.details||'',/2 distinct direct Discord candidate\(s\) retained/);
  assert.deepEqual(step?.detectedInvites?.sort(),['other','same']);
});

test('post-enrichment no-independent-hypothesis path is reviewable, never silently completed',()=>{
  const source=readFileSync('server/ingestionPipeline.ts','utf8');
  const start=source.indexOf("if (currentStage > 0 && !independentHypothesis)");
  const end=source.indexOf('const legacyAction',start);
  const block=source.slice(start,end);
  assert.match(block,/trading_status='NEEDS_REVIEW'/);
  assert.match(block,/scan_status='NEEDS_REVIEW'/);
  assert.match(block,/tradingStatus:'NEEDS_REVIEW'/);
});
