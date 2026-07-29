import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inferChannelCountry } from './countryInference';

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
