import assert from 'node:assert/strict';
import test from 'node:test';
import { getDb } from './dbCore';
import { recordAcquisitionLaneEvent } from './acquisitionLaneTelemetry';
import type { AcquisitionLaneSignals } from './acquisitionLaneTaxonomy';
import {
  buildCrawlThroughputReport,
  crawlThroughputWindowStart,
} from './crawlThroughputReport';

// This suite writes to the append-only lane table, so it is opt-in and uses a
// dedicated scratch connection. Every fixture is inserted inside a transaction
// that is rolled back; the append-only trigger intentionally rejects DELETE.
const dedicatedDatabaseUrl = process.env.PHASE2_CRAWL_REPORT_TEST_DATABASE_URL;
if (dedicatedDatabaseUrl) process.env.DATABASE_URL = dedicatedDatabaseUrl;
const enabled = Boolean(dedicatedDatabaseUrl);
const maybe = enabled ? test : test.skip;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function signals(): AcquisitionLaneSignals {
  return {
    observations: 1,
    effectiveObservations: 1,
    requiredObservations: 1,
    foundObservations: 1,
    failedObservations: 0,
    partialObservations: 0,
    inspectedNoMatchObservations: 0,
    retryOwningObservations: 0,
    infrastructureFailureObservations: 0,
    conclusiveBlockObservations: 0,
    processedObservations: 1,
  };
}

maybe('the durable writer and report work together on the append-only table', async () => {
  const db = await getDb();
  const client = await db.connect();
  const suffix = uniqueSuffix();
  // Capture one timestamp before the inserts so a UTC-hour rollover cannot
  // move the fixtures outside the one-hour report window mid-test.
  const now = new Date();
  const channelIds = [
    `UCphase2-report-discovery-a-${suffix}`,
    `UCphase2-report-discovery-b-${suffix}`,
    `UCphase2-report-retry-${suffix}`,
  ];
  try {
    await client.query('BEGIN');

    const fixtures = [
      { lane: 'DISCOVERY', jobType: 'ENRICH_CHANNEL', channelId: channelIds[0], gateWaitMs: 500 },
      { lane: 'DISCOVERY', jobType: 'ENRICH_CHANNEL', channelId: channelIds[1], gateWaitMs: 1500 },
      { lane: 'RETRY', jobType: 'RETRY_COMMUNITY_ACQUISITION', channelId: channelIds[2], gateWaitMs: undefined },
    ] as const;

    for (const fixture of fixtures) {
      const written = await recordAcquisitionLaneEvent({
        attribution: {
          lane: fixture.lane,
          jobType: fixture.jobType,
          jobId: `job-${suffix}`,
          channelId: fixture.channelId,
          slicePass: 1,
        },
        outcome: 'ACQUIRED',
        summary: {
          pagesInspected: 2,
          requestsStarted: 3,
          renderedCrawls: 1,
          renderedCrawlStartedAt: [now.toISOString()],
          ...(fixture.gateWaitMs !== undefined ? { gateWaitMs: fixture.gateWaitMs } : {}),
          workRemaining: 0,
          signals: signals(),
        },
        observedAt: now.toISOString(),
      }, {
        enabled: () => true,
        query: (sql, values) => client.query(sql, values),
      });
      assert.equal(written, true, `writer must persist ${fixture.channelId}`);
    }

    const windowStart = crawlThroughputWindowStart(now, 1);
    const result = await client.query(
      `SELECT observed_at, lane, outcome, gate_wait_ms,
              pages_inspected, requests_started, capacity_event, detail, channel_id
         FROM acquisition_lane_events
        WHERE observed_at >= $1
        ORDER BY observed_at`,
      [windowStart.toISOString()],
    );
    // Other production-like fixtures may exist in a shared scratch database;
    // restrict the report input to this transaction's channel IDs.
    const rows = result.rows.filter(row => channelIds.includes(String(row.channel_id)));
    assert.equal(rows.length, 3);
    assert.ok(
      rows.every(row => Array.isArray(row.detail?.renderedCrawlStartedAt)
        && row.detail.renderedCrawlStartedAt.length === 1),
      'the writer must persist the per-crawl admission timestamp array',
    );

    const report = buildCrawlThroughputReport(rows, { windowHours: 1, now });
    assert.equal(report.totals.inspectionPasses, 3);
    assert.equal(report.totals.browserCrawls, 3);
    assert.equal(report.totals.discoveryBrowserCrawls, 2);
    assert.equal(report.gates.discoverySharePct, 66.67);
    assert.deepEqual(report.totals.gateWait, {
      samples: 2,
      averageMs: 1000,
      maxMs: 1500,
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
