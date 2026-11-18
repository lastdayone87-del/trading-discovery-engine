import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeCommunityWorkForChannel } from './communityAcquisitionWorkStore';

test('materialize preserves required work and optional multi-invite recall rows', async () => {
  const inserts: any[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM external_acquisition_observations')) {
        return {
          rows: [
            {
              id: '1',
              channel_id: 'UC-ledger',
              requested_url: 'https://required.example/join',
              outcome: 'ACQUISITION_FAILED',
              retryable: true,
              failure_class: 'NETWORK_FAILURE',
              observed_at: '2026-11-01T00:00:00.000Z',
              provenance: {
                surface: 'CREATOR_WEBSITES',
                required: true,
                crawlerTelemetry: { mode: 'RENDERED', pagesInspected: 1, requestsFinished: 1 },
              },
            },
            {
              id: '2',
              channel_id: 'UC-ledger',
              requested_url: 'https://optional.example/community',
              outcome: 'ACQUISITION_FAILED',
              retryable: true,
              failure_class: 'TIMEOUT',
              observed_at: '2026-11-01T00:01:00.000Z',
              provenance: {
                surface: 'CREATOR_WEBSITES',
                required: false,
                crawlerTelemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 1 },
              },
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO community_acquisition_url_state')) {
        inserts.push(JSON.parse(String(params?.[0] || '[]')));
        return { rows: [], rowCount: 2 };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };

  const result = await materializeCommunityWorkForChannel('UC-ledger', { db });
  assert.equal(result.projected, 2);
  assert.equal(inserts.length, 1);
  const rows = inserts[0];
  assert.equal(rows.length, 2);
  const required = rows.find((row: any) => row.url.includes('required.example'));
  const recall = rows.find((row: any) => row.url.includes('optional.example'));
  assert.equal(required.required, true);
  assert.equal(required.recall, false);
  assert.equal(required.priority, 100);
  assert.equal(required.state, 'PENDING');
  assert.equal(recall.required, false);
  assert.equal(recall.recall, true);
  assert.equal(recall.priority, 10);
  assert.equal(recall.state, 'PENDING');
});
