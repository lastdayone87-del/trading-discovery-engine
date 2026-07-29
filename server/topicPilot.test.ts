import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pilotProposalKey, validatePilotControl } from './topicPilot';

test('pilot proposal identity is deterministic and cohort scoped',()=>{
  const p={queryId:7,country:' Japan ',blockStart:'2026-07-29T10:00:00Z'};
  assert.equal(pilotProposalKey(p),pilotProposalKey({...p,country:'japan'}));
  assert.notEqual(pilotProposalKey(p),pilotProposalKey({...p,blockStart:'2026-07-29T11:00:00Z'}));
});

test('canary is fail closed and budget bounded',()=>{
  assert.throws(()=>validatePilotControl({mode:'CANARY',killSwitch:false,dailyYoutubeCap:0,totalYoutubeCap:100}));
  assert.throws(()=>validatePilotControl({dailyYoutubeCap:-1}));
  assert.deepEqual(validatePilotControl({mode:'SHADOW',killSwitch:true,dailyYoutubeCap:0,totalYoutubeCap:0}),{mode:'SHADOW',killSwitch:true,dailyYoutubeCap:0,totalYoutubeCap:0});
});

test('phase 6 migration is expand first with leases, exclusive cohorts, and hard caps',()=>{
  const sql=readFileSync(new URL('./db/migrations/021_restart_safe_topic_pilot.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE)\b/i);
  assert.match(sql,/research_controller_checkpoints/);
  assert.match(sql,/EXCLUDE USING gist/);
  assert.match(sql,/idx_frontier_attempt_one_active/);
  assert.match(sql,/kill_switch BOOLEAN NOT NULL DEFAULT true/);
  assert.match(sql,/daily_youtube_cap INTEGER NOT NULL DEFAULT 0/);
});
