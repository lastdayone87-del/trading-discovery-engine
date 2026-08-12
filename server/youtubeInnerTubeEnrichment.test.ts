import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInnerTubeChannelEnrichment } from './youtubeInnerTubeEnrichment';

test('collects recent videos descriptions and playlists',async()=>{
  const client:any={
    getChannel:async()=>({has_videos:true,has_playlists:true,getVideos:async()=>({videos:[{id:'v1',title:'EURUSD setup',published:'2 days ago'},{id:'v2',title:'Risk management',published:'3 weeks ago'}],has_continuation:false}),getPlaylists:async()=>({playlists:[{id:'p1',title:'Trading education'}]})}),
    getBasicInfo:async(id:string)=>({basic_info:{title:id==='v1'?'EURUSD setup':'Risk management',short_description:`description ${id}`}})
  };
  const result=await fetchInnerTubeChannelEnrichment('UC123',{includePlaylists:true,maxVideos:10,detailVideos:10},client);
  assert.equal(result.videos.length,2);
  assert.match(result.videos[0].description||'',/description v1/);
  assert.ok(result.videos[0].published_at);
  assert.equal(result.playlists[0].name,'Trading education');
});

test('preserves feed evidence if a detail lookup fails',async()=>{
  let details=0;
  const client:any={getChannel:async()=>({getVideos:async()=>({videos:[{id:'v1',title:'One',published:'today'},{id:'v2',title:'Two',published:'yesterday'}]})}),getBasicInfo:async(id:string)=>{details++;if(id==='v1')throw new Error('temporary');return {basic_info:{short_description:'two'}};}};
  const result=await fetchInnerTubeChannelEnrichment('UC123',{detailVideos:2},client);
  assert.equal(details,2);
  assert.equal(result.videos[0].title,'One');
  assert.equal(result.videos[1].description,'two');
});

test('empty upload feed is a successful evidence acquisition result',async()=>{
  const client:any={getChannel:async()=>({has_videos:false,videos:[]}),getBasicInfo:async()=>{throw new Error('should not run');}};
  const result=await fetchInnerTubeChannelEnrichment('UCempty',{},client);
  assert.deepEqual(result.videos,[]);
  assert.equal(result.detailCalls,0);
});
