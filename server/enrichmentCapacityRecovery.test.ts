import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMUNITY_CAPACITY_RETRY_LEASE_MS, reconcileCommunityAcquisitionRecovery } from './communityRecovery';

test('quota-only ENRICH_CHANNEL terminal failure is reopened without spending retry budget', async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const db = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('SELECT c.channel_id')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    }
  };

  await reconcileCommunityAcquisitionRecovery(
    async () => db,
    async () => null,
    async () => undefined,
    20,
    Date.now() + 120_000
  );

  const activeRefresh = queries.find(q => q.sql.includes("type='ENRICH_CHANNEL'") && q.sql.includes("status IN('PENDING','PROCESSING')"));
  assert.ok(activeRefresh, 'active enrichment quota deferrals should renew before the generic age ceiling');
  assert.equal(activeRefresh?.values?.[1], String(COMMUNITY_CAPACITY_RETRY_LEASE_MS));

  const terminalRecovery = queries.find(q => q.sql.includes('WITH recovered AS') && q.sql.includes("j.type='ENRICH_CHANNEL'"));
  assert.ok(terminalRecovery, 'quota-terminalized enrichment jobs should be restored to pending');
  assert.match(String(terminalRecovery?.values?.[0]), /OPERATIONALLY_BLOCKED_RETRY_REQUIRED/);
  assert.match(String(terminalRecovery?.values?.[0]), /ENRICHMENT YouTube quota allocation is exhausted/);
  assert.match(terminalRecovery!.sql, /attempts=GREATEST\(0,j\.attempts-1\)/);
  assert.match(terminalRecovery!.sql, /scan_status='ENRICHMENT_PENDING'/);
  assert.match(terminalRecovery!.sql, /trading_status NOT IN\('NON_TRADING','HUMAN_REJECTED'\)/);
});
