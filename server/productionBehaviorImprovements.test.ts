import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inferChannelCountry } from './countryInference';
import { channelListingSearchParams } from '../src/channelListingQuery';
import { routePolicyInventory } from './operatorAuth';

test('official ISO country metadata canonicalizes before exclusion policy',()=>{
  const result=inferChannelCountry({officialCountry:'NG'},[{country_name:'Nigeria',reason:'excluded'}]);
  assert.equal(result.detectedCountry,'Nigeria'); assert.equal(result.status,'REJECTED');
});

test('country enrichment consumes brandingSettings and distinguishes metadata states',()=>{
  const source=fs.readFileSync(new URL('./youtube.ts',import.meta.url),'utf8');
  assert.match(source,/brandingSettings\?\.channel\?\.country/);
  assert.match(source,/AVAILABLE_NOT_DECLARED/); assert.match(source,/UNAVAILABLE/);
});

test('dashboard migration provides listing and activity indexes',()=>{
  const migration=fs.readFileSync(new URL('./db\/migrations\/033_country_activity_dashboard.sql',import.meta.url),'utf8');
  assert.match(migration,/idx_channels_active_listing/); assert.match(migration,/idx_channels_activity_priority/);
});

test('page and revision requests share one complete filter serialization',()=>{
  const params=channelListingSearchParams({search:'alpha',country:'Germany',countryStatus:'CONFIRMED',tradingStatus:'TRADING_CONFIRMED',discordStatus:'ACTIVE',scanStatus:'COMPLETED'},true);
  assert.deepEqual([...params.entries()],[['include_rejected','true'],['diagnostics_only','true'],['search','alpha'],['country','Germany'],['country_status','CONFIRMED'],['trading_status','TRADING_CONFIRMED'],['discord_status','ACTIVE'],['scan_status','COMPLETED']]);
});

test('dashboard summary and revision endpoints are operator-authorized',()=>{
  const read=routePolicyInventory.find(item=>item.action==='administration.read');
  assert.ok(read); assert.match('/api/channels-revision',new RegExp(read.pattern)); assert.match('/api/dashboard/summary',new RegExp(read.pattern));
});
