import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './dbCore';
import { reconcileCommunityWorkProjection } from './communityAcquisitionWorkLedger';
import { buildPhase0UrlWorkLedgerReport } from './phase0UrlWorkLedgerReport';

// These tests insert ledger and observation fixtures, so they are opt-in and
// only run in the dedicated Phase 0 URL-ledger workflow against its scratch
// database.
const enabled = Boolean(process.env.PHASE0_URL_LEDGER_TEST_DATABASE_URL);
const maybe = enabled ? test : test.skip;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

maybe('migration 166 enforces lifecycle constraints and freshness', async t => {
  const db = await getDb();
  const channelId = `UCphase0ledger-${uniqueSuffix()}`;
  const workKey = `phase0-ledger-schema-${uniqueSuffix()}`;
  t.after(async () => {
    await db.query(`DELETE FROM community_acquisition_url_state WHERE channel_id=$1`, [channelId]);
  });

  const table = await db.query(`SELECT to_regclass('public.community_acquisition_url_state') AS oid`);
  assert.ok(table.rows[0]?.oid, 'migration 166 must create the ledger table');

  const inserted = await db.query(
    `INSERT INTO community_acquisition_url_state(
       work_key,channel_id,url,normalized_url,surface
     ) VALUES($1,$2,'https://example.com/links','https://example.com/links','CREATOR_WEBSITES')
     RETURNING state,never_executed,attempts,max_attempts,terminal_evidence,updated_at`,
    [workKey, channelId],
  );
  assert.equal(inserted.rows[0].state, 'PENDING');
  assert.equal(inserted.rows[0].never_executed, true);
  assert.equal(inserted.rows[0].attempts, 0);
  assert.equal(inserted.rows[0].max_attempts, 5);
  assert.deepEqual(inserted.rows[0].terminal_evidence, {});

  await assert.rejects(
    db.query(
      `INSERT INTO community_acquisition_url_state(
         work_key,channel_id,url,normalized_url,surface,state
       ) VALUES($1,$2,'https://example.com/bad','https://example.com/bad','SOCIAL_PROFILES','NOT_A_STATE')`,
      [`phase0-ledger-bad-${uniqueSuffix()}`, channelId],
    ),
    /community_acquisition_url_state_state_check/,
  );

  await assert.rejects(
    db.query(
      `INSERT INTO community_acquisition_url_state(
         work_key,channel_id,url,normalized_url,surface
       ) VALUES($1,$2,'https://example.com/links','https://example.com/links','CREATOR_WEBSITES')`,
      [`phase0-ledger-dupe-${uniqueSuffix()}`, channelId],
    ),
    /duplicate key value violates unique constraint/,
  );

  const before = inserted.rows[0].updated_at;
  await db.query(`SELECT pg_sleep(0.02)`);
  const updated = await db.query(
    `UPDATE community_acquisition_url_state
        SET state='RESOLVED',terminal_reason='FOUND'
      WHERE work_key=$1
      RETURNING updated_at`,
    [workKey],
  );
  assert.ok(
    new Date(updated.rows[0].updated_at).getTime() > new Date(before).getTime(),
    'the touch trigger must advance updated_at with clock time',
  );
});

maybe('the read-only report projects and reconciles a fixture backlog', async t => {
  const db = await getDb();
  const suffix = uniqueSuffix();
  const channelId = `UCphase0ledger-report-${suffix}`;
  const jobKey = `phase0-ledger-report-job-${suffix}`;
  // external_acquisition_observations is append-only by design, so fixtures are
  // never deleted. Assertions compare against a pre-insert baseline, which also
  // makes the test safe to rerun against a non-empty scratch database.
  t.after(async () => {
    await db.query(`DELETE FROM community_acquisition_url_state WHERE channel_id=$1`, [channelId]);
    await db.query(`DELETE FROM jobs WHERE payload->>'channelId'=$1`, [channelId]);
  });

  const baseline = await buildPhase0UrlWorkLedgerReport(db, { windowDays: 1, maxDeltaPct: 5 });

  await db.query(
    `INSERT INTO jobs(type,payload,status,priority,max_attempts,run_after,idempotency_key)
     VALUES('RETRY_COMMUNITY_ACQUISITION',$1::jsonb,'PENDING',1000000000,5,now()-interval '1 minute',$2)`,
    [JSON.stringify({ channelId, retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE' }), jobKey],
  );

  const observations = [
    {
      key: `phase0-ledger-found-${suffix}`,
      url: 'https://found.example/links',
      outcome: 'FOUND',
      retryable: false,
      failureClass: null,
      surface: 'CREATOR_WEBSITES',
      telemetry: { mode: 'STATIC', pagesInspected: 3, requestsStarted: 0, requestsFinished: 0 },
    },
    {
      key: `phase0-ledger-never-${suffix}`,
      url: 'https://never.example/bio',
      outcome: 'ACQUISITION_FAILED',
      retryable: true,
      failureClass: 'NETWORK_FAILURE',
      surface: 'SOCIAL_PROFILES',
      telemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 5, requestsFinished: 0 },
    },
    {
      key: `phase0-ledger-static-${suffix}`,
      url: 'https://static.example/',
      outcome: 'ACQUISITION_FAILED',
      retryable: true,
      failureClass: 'NETWORK_FAILURE',
      surface: 'CREATOR_WEBSITES',
      telemetry: { mode: 'STATIC', pagesInspected: 2, requestsStarted: 0, requestsFinished: 0 },
    },
  ];

  for (const observation of observations) {
    await db.query(
      `INSERT INTO external_acquisition_observations(
         observation_key,channel_id,requested_url,outcome,retryable,failure_class,
         detail,provenance,policy_version,observed_at
       ) VALUES($1,$2,$3,$4,$5,$6,'fixture',$7::jsonb,'phase0-ledger-test-v1',now())`,
      [
        observation.key,
        channelId,
        observation.url,
        observation.outcome,
        observation.retryable,
        observation.failureClass,
        JSON.stringify({
          provider: 'external-link',
          surface: observation.surface,
          required: true,
          crawlerTelemetry: observation.telemetry,
        }),
      ],
    );
  }

  const report = await buildPhase0UrlWorkLedgerReport(db, {
    windowDays: 1,
    maxDeltaPct: 5,
    includeRows: true,
  });

  assert.equal(report.schema.ledgerTablePresent, true);
  assert.ok(report.batches.pendingChannels >= 1);
  assert.ok(report.rows, 'includeRows must return the projection rows');

  const rows = report.rows.filter(row => row.channelId === channelId);
  assert.equal(rows.length, 3);
  const byUrl = new Map(rows.map(row => [row.normalizedUrl, row]));
  assert.equal(byUrl.get('https://found.example/links')?.state, 'RESOLVED');
  assert.equal(byUrl.get('https://found.example/links')?.neverExecuted, false);
  assert.equal(byUrl.get('https://found.example/links')?.neverBrowserExecuted, true);
  assert.equal(byUrl.get('https://never.example/bio')?.state, 'PENDING');
  assert.equal(byUrl.get('https://never.example/bio')?.neverExecuted, true);
  assert.equal(byUrl.get('https://never.example/bio')?.attempts, 0);
  assert.equal(byUrl.get('https://static.example/')?.state, 'PENDING');
  assert.equal(byUrl.get('https://static.example/')?.neverExecuted, false);
  assert.equal(byUrl.get('https://static.example/')?.neverBrowserExecuted, true);

  // The SQL telemetry bound and the TypeScript projection must agree on the
  // fixture rows: two retryable URLs, both never browser-executed.
  const retryableDelta = report.projection.retryableRows - baseline.projection.retryableRows;
  const retryableNeverBrowserDelta = report.projection.retryableNeverBrowserExecutedRows
    - baseline.projection.retryableNeverBrowserExecutedRows;
  const telemetryRetryableDelta = report.telemetry.retryableRows - baseline.telemetry.retryableRows;
  const telemetryNeverBrowserDelta = report.telemetry.neverBrowserExecutedRows
    - baseline.telemetry.neverBrowserExecutedRows;
  assert.equal(retryableDelta, 2);
  assert.equal(retryableNeverBrowserDelta, 2);
  assert.equal(telemetryRetryableDelta, 2);
  assert.equal(telemetryNeverBrowserDelta, 2);

  const reconciled = reconcileCommunityWorkProjection(
    {
      retryableRows: retryableDelta,
      neverBrowserExecutedRows: retryableNeverBrowserDelta,
      retryableNeverBrowserExecutedRows: retryableNeverBrowserDelta,
    },
    {
      retryableRows: telemetryRetryableDelta,
      neverBrowserExecutedRows: telemetryNeverBrowserDelta,
    },
  );
  assert.equal(reconciled.retryableWithinFivePercent, true);
  assert.equal(reconciled.neverExecutedWithinFivePercent, true);
});
