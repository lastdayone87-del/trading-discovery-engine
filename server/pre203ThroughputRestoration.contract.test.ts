import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
const scheduler = readFileSync(new URL('./youtubeRequestScheduler.ts', import.meta.url), 'utf8');
const db = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
const maintenance = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');

// Restoration target: recover pre-#203 responsiveness while preserving all
// official-only, quota-accounting and rate-limit safety added afterwards.

test('normal search/enrichment admission is not multiplied by full key-pool size', () => {
  assert.doesNotMatch(queueManager, /enrichmentReservationUnits\s*=\s*enrichmentQuotaUnits\s*\*\s*Math\.max\(1,getYouTubeKeyPool\(\)\.length\)/);
  assert.doesNotMatch(queueManager, /providerReservationUnits\s*=\s*providerQuotaUnits\s*\*\s*Math\.max\(1,getYouTubeKeyPool\(\)\.length\)/);
  assert.match(queueManager, /topUpQuotaReservation/);
});

test('official youtube retries preserve paid expensive steps instead of replaying them', () => {
  assert.match(youtube, /let uploadsCheckpoint/);
  assert.match(youtube, /if\s*\(!uploadsCheckpoint\)/);
  assert.match(youtube, /uploadsCheckpoint\s*=/);
});

test('shared youtube scheduler supports priority and exposes cooldown state', () => {
  assert.match(scheduler, /priority/i);
  assert.match(scheduler, /rateLimit|backoff/i);
  assert.match(scheduler, /cooldown|nextStartAt|getState|isRateLimited/i);
});

test('transient retries are provider-aware and bounded by wall-clock age', () => {
  assert.match(db, /retryAfterMs|retryAt/);
  assert.match(db, /first.*failure|retry.*age|max.*retry|transient.*since/i);
  assert.doesNotMatch(db, /scheduled=.*now\+5\*60_000/);
});

test('incident recovery is explicitly background-only behind production work', () => {
  assert.match(maintenance, /isRecoveryAdmissionOpen/);
  assert.match(maintenance, /productionBacklog\s*<=\s*RECOVERY_MAX_PRODUCTION_BACKLOG/);
  assert.match(maintenance, /youtubeRequestScheduler\.isRateLimited\(\)/);
});

test('manual and autonomous official searches use the same per-attempt quota contract', () => {
  assert.match(queueManager, /MANUAL_SEARCH_PAGE/);
  assert.match(queueManager, /AUTONOMOUS_QUERY_PAGE/);
  assert.match(queueManager, /100/);
});
