import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './dbCore';
import { buildPhase0UrlWorkLedgerReport } from './phase0UrlWorkLedgerReport';

// These tests insert ledger and observation fixtures. The opt-in variable also
// selects the connection: enabling the suite must never insert into whatever
// DATABASE_URL happened to be inherited from the shell.
const dedicatedDatabaseUrl = process.env.PHASE0_URL_LEDGER_TEST_DATABASE_URL;
if (dedicatedDatabaseUrl) process.env.DATABASE_URL = dedicatedDatabaseUrl;
const enabled = Boolean(dedicatedDatabaseUrl);
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
     RETURNING state,never_executed,attempts,max_attempts,retryable,browser_executed,terminal_evidence,updated_at`,
    [workKey, channelId],
  );
  assert.equal(inserted.rows[0].state, 'PENDING');
  assert.equal(inserted.rows[0].never_executed, true);
  assert.equal(inserted.rows[0].attempts, 0);
  assert.equal(inserted.rows[0].max_attempts, 5);
  assert.equal(inserted.rows[0].retryable, false);
  assert.equal(inserted.rows[0].browser_executed, false);
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

  await assert.rejects(
    db.query(
      `INSERT INTO community_acquisition_url_state(
         work_key,channel_id,url,normalized_url,surface,never_executed,browser_executed
       ) VALUES($1,$2,'https://example.com/impossible','https://example.com/impossible','CREATOR_WEBSITES',TRUE,TRUE)`,
      [`phase0-ledger-impossible-${uniqueSuffix()}`, channelId],
    ),
    /community_url_state_browser_executed_check/,
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
  const client = await db.connect();
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

  let baseline!: Awaited<ReturnType<typeof buildPhase0UrlWorkLedgerReport>>;
  let report!: Awaited<ReturnType<typeof buildPhase0UrlWorkLedgerReport>>;
  try {
    // One snapshot freezes the external pending-channel population. Fixtures
    // inserted below are visible through our own writes but unrelated retry
    // completions cannot change the baseline or the reconciliation report.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    baseline = await buildPhase0UrlWorkLedgerReport(client, { windowDays: 1, maxDeltaPct: 5 });

    await client.query(
      `INSERT INTO jobs(type,payload,status,priority,max_attempts,run_after,idempotency_key)
       VALUES('RETRY_COMMUNITY_ACQUISITION',$1::jsonb,'PENDING',1000000000,5,now()-interval '1 minute',$2)`,
      [JSON.stringify({ channelId, retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE' }), jobKey],
    );

    const observations: Array<{
      key: string;
      url: string;
      outcome: string;
      retryable: boolean;
      failureClass: string | null;
      required: boolean;
      observedAt?: string;
      telemetry: Record<string, unknown>;
    }> = [
      {
        key: `phase0-ledger-found-${suffix}`,
        url: 'https://found.example/links',
        outcome: 'FOUND',
        retryable: false,
        failureClass: null,
        required: true,
        telemetry: { mode: 'STATIC', pagesInspected: 3, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-never-${suffix}`,
        url: 'https://never.example/bio',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        telemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 5, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-static-${suffix}`,
        url: 'https://static.example/',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        telemetry: { mode: 'STATIC', pagesInspected: 2, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-recovered-static-${suffix}`,
        url: 'https://recovered.example/',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        observedAt: `now() - interval '2 minutes'`,
        telemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-recovered-found-${suffix}`,
        url: 'https://recovered.example/',
        outcome: 'FOUND',
        retryable: false,
        failureClass: null,
        required: true,
        observedAt: `now() - interval '1 minute'`,
        telemetry: { mode: 'RENDERED', pagesInspected: 2, requestsStarted: 2, requestsFinished: 2 },
      },
      {
        key: `phase0-ledger-superseded-found-${suffix}`,
        url: 'https://superseded.example/',
        outcome: 'FOUND',
        retryable: false,
        failureClass: null,
        required: true,
        observedAt: `now() - interval '2 hours'`,
        telemetry: { mode: 'STATIC', pagesInspected: 3, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-superseded-failure-${suffix}`,
        url: 'https://superseded.example/',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        telemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 1, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-static-gap-${suffix}`,
        url: 'https://static-gap.example/',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: true,
        failureClass: 'STATIC_BUDGET_GAP',
        required: false,
        telemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-recovered-gap-partial-${suffix}`,
        url: 'https://recovered-gap.example/',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: true,
        failureClass: 'STATIC_BUDGET_GAP',
        required: false,
        observedAt: `now() - interval '2 minutes'`,
        telemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-recovered-gap-found-${suffix}`,
        url: 'https://recovered-gap.example/',
        outcome: 'FOUND',
        retryable: false,
        failureClass: null,
        required: false,
        observedAt: `now() - interval '1 minute'`,
        telemetry: { mode: 'RENDERED', pagesInspected: 2, requestsStarted: 2, requestsFinished: 2 },
      },
      {
        key: `phase0-ledger-found-gap-${suffix}`,
        url: 'https://found-gap.example/',
        outcome: 'FOUND',
        retryable: true,
        failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP',
        required: true,
        telemetry: { mode: 'STATIC', pagesInspected: 2, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-mixed-clean-${suffix}`,
        url: 'https://mixed-signal.example/',
        outcome: 'INSPECTED_NO_MATCH',
        retryable: false,
        failureClass: null,
        required: false,
        observedAt: `now() - interval '1 minute'`,
        telemetry: { mode: 'STATIC', pagesInspected: 2, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-mixed-failure-${suffix}`,
        url: 'https://mixed-signal.example/',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        observedAt: `now() - interval '2 minutes'`,
        telemetry: { mode: 'RENDERED', pagesInspected: 0, requestsStarted: 1, requestsFinished: 1 },
      },
      {
        key: `phase0-ledger-oversized-${suffix}`,
        url: 'https://oversized.example/',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        telemetry: {
          mode: 'RENDERED',
          pagesInspected: 0,
          requestsStarted: 0,
          requestsFinished: '999999999999999999999999999',
        },
      },
      {
        key: `phase0-ledger-optional-${suffix}`,
        url: 'https://optional.example/',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: false,
        telemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-auxiliary-${suffix}`,
        url: 'https://calendly.com/phase0-fixture/30min',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        telemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
      },
      {
        key: `phase0-ledger-inadmissible-${suffix}`,
        url: 'https://fixture.example/assets/logo.png',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'NETWORK_FAILURE',
        required: true,
        telemetry: { mode: 'STATIC', pagesInspected: 1, requestsStarted: 0, requestsFinished: 0 },
      },
    ];

    for (const observation of observations) {
      await client.query(
        `INSERT INTO external_acquisition_observations(
           observation_key,channel_id,requested_url,outcome,retryable,failure_class,
           detail,provenance,policy_version,observed_at
         ) VALUES($1,$2,$3,$4,$5,$6,'fixture',$7::jsonb,'phase0-ledger-test-v1',
                  ${observation.observedAt || 'now()'})`,
        [
          observation.key,
          channelId,
          observation.url,
          observation.outcome,
          observation.retryable,
          observation.failureClass,
          JSON.stringify({
            provider: 'external-link',
            surface: observation.url.includes('/bio') ? 'SOCIAL_PROFILES' : 'CREATOR_WEBSITES',
            required: observation.required,
            crawlerTelemetry: observation.telemetry,
          }),
        ],
      );
    }

    report = await buildPhase0UrlWorkLedgerReport(client, {
      windowDays: 1,
      maxDeltaPct: 5,
      includeRows: true,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  assert.equal(report.schema.ledgerTablePresent, true);
  assert.ok(report.batches.pendingChannels >= 1);
  assert.ok(report.rows, 'includeRows must return the projection rows');

  const rows = report.rows.filter(row => row.channelId === channelId);
  assert.equal(rows.length, 12, 'optional observations never create a work row by themselves');
  const byUrl = new Map(rows.map(row => [row.normalizedUrl, row]));
  assert.equal(byUrl.get('https://found.example/links')?.state, 'RESOLVED');
  assert.equal(byUrl.get('https://found.example/links')?.neverExecuted, false);
  assert.equal(byUrl.get('https://found.example/links')?.neverBrowserExecuted, true);
  assert.equal(byUrl.get('https://never.example/bio')?.state, 'PENDING');
  assert.equal(byUrl.get('https://never.example/bio')?.neverExecuted, true);
  assert.equal(byUrl.get('https://never.example/bio')?.attempts, 1);
  assert.equal(byUrl.get('https://never.example/bio')?.retryOwned, true);
  assert.equal(byUrl.get('https://static.example/')?.state, 'PENDING');
  assert.equal(byUrl.get('https://static.example/')?.neverExecuted, false);
  assert.equal(byUrl.get('https://static.example/')?.neverBrowserExecuted, true);
  assert.equal(byUrl.get('https://recovered.example/')?.state, 'RESOLVED');
  assert.equal(byUrl.get('https://recovered.example/')?.retryOwned, false);
  assert.equal(byUrl.get('https://recovered.example/')?.neverBrowserExecuted, false);
  assert.equal(byUrl.get('https://recovered.example/')?.attempts, 2);
  // A two-hour-old success must not hide the current failure.
  assert.equal(byUrl.get('https://superseded.example/')?.state, 'PENDING');
  assert.equal(byUrl.get('https://superseded.example/')?.lastOutcome, 'ACQUISITION_FAILED');
  assert.equal(byUrl.get('https://superseded.example/')?.retryOwned, true);
  assert.equal(byUrl.get('https://superseded.example/')?.attempts, 2);
  assert.equal(byUrl.get('https://superseded.example/')?.neverExecuted, false);
  // The narrow static-budget-gap exception is real retry work even though the
  // seed is not required for the channel outcome.
  assert.equal(byUrl.get('https://static-gap.example/')?.state, 'PENDING');
  assert.equal(byUrl.get('https://static-gap.example/')?.retryOwned, true);
  assert.equal(byUrl.get('https://static-gap.example/')?.attempts, 1);
  // Optional recovery evidence for an admitted static-gap URL must resolve it.
  assert.equal(byUrl.get('https://recovered-gap.example/')?.state, 'RESOLVED');
  assert.equal(byUrl.get('https://recovered-gap.example/')?.lastOutcome, 'FOUND');
  assert.equal(byUrl.get('https://recovered-gap.example/')?.retryOwned, false);
  assert.equal(byUrl.get('https://recovered-gap.example/')?.attempts, 2);
  assert.equal(byUrl.get('https://recovered-gap.example/')?.neverExecuted, false);
  assert.equal(byUrl.get('https://recovered-gap.example/')?.neverBrowserExecuted, false);
  // The latest inspection keeps the required browser failure even though an
  // optional static clean is more recent: required results dominate optional
  // notes, exactly as production's effectiveAcquisitionOutcomes does.
  assert.equal(byUrl.get('https://mixed-signal.example/')?.state, 'PENDING');
  assert.equal(byUrl.get('https://mixed-signal.example/')?.lastOutcome, 'ACQUISITION_FAILED');
  assert.equal(byUrl.get('https://mixed-signal.example/')?.retryOwned, true);
  assert.equal(byUrl.get('https://mixed-signal.example/')?.attempts, 2);
  assert.equal(byUrl.get('https://mixed-signal.example/')?.neverExecuted, false);
  assert.equal(byUrl.get('https://mixed-signal.example/')?.neverBrowserExecuted, false);
  // A FOUND row with an outstanding bounded gap is still retry work, so it
  // must stay PENDING and claimable instead of resolving the row.
  assert.equal(byUrl.get('https://found-gap.example/')?.state, 'PENDING');
  assert.equal(byUrl.get('https://found-gap.example/')?.lastOutcome, 'FOUND');
  assert.equal(byUrl.get('https://found-gap.example/')?.retryOwned, true);
  assert.equal(byUrl.get('https://found-gap.example/')?.attempts, 1);
  assert.equal(byUrl.get('https://found-gap.example/')?.neverExecuted, false);
  assert.equal(byUrl.get('https://found-gap.example/')?.neverBrowserExecuted, true);
  assert.equal(byUrl.get('https://oversized.example/')?.state, 'PENDING');
  assert.equal(byUrl.get('https://oversized.example/')?.neverExecuted, true);
  assert.equal(byUrl.get('https://oversized.example/')?.neverBrowserExecuted, true);
  assert.equal(byUrl.get('https://optional.example/'), undefined);
  // Auxiliary commerce/booking URLs and URLs rejected by the crawl admission
  // gate create admitted work rows but never own retry. The telemetry bound
  // must reach the same conclusion via the shared predicate.
  assert.equal(byUrl.get('https://calendly.com/phase0-fixture/30min')?.retryOwned, false);
  assert.equal(byUrl.get('https://fixture.example/assets/logo.png')?.retryOwned, false);

  // The SQL telemetry bound and the TypeScript projection must agree on the
  // fixture rows: seven effective retry owners, six never browser-executed.
  // `recovered.example` has a retryable static failure plus a rendered success
  // in the same inspection, so it is not retry-owned but must count as
  // browser-executed. `mixed-signal.example` keeps its required browser
  // failure, so it is retry-owned but not never-executed.
  const retryableDelta = report.projection.retryableRows - baseline.projection.retryableRows;
  const retryableNeverBrowserDelta = report.projection.retryableNeverBrowserExecutedRows
    - baseline.projection.retryableNeverBrowserExecutedRows;
  const telemetryRetryableDelta = report.telemetry.retryableRows - baseline.telemetry.retryableRows;
  const telemetryNeverBrowserDelta = report.telemetry.neverBrowserExecutedRows
    - baseline.telemetry.neverBrowserExecutedRows;
  assert.equal(retryableDelta, 7);
  assert.equal(retryableNeverBrowserDelta, 6);
  assert.equal(telemetryRetryableDelta, 7);
  assert.equal(telemetryNeverBrowserDelta, 6);

  // The report must expose its own reconciliation, not just a recomputed copy.
  assert.equal(report.reconciliation.projectionRetryableRows, report.projection.retryableRows);
  assert.equal(report.reconciliation.telemetryRetryableRows, report.telemetry.retryableRows);
  assert.equal(
    report.reconciliation.projectionRetryableNeverBrowserExecutedRows,
    report.projection.retryableNeverBrowserExecutedRows,
  );
  assert.equal(
    report.reconciliation.retryableDelta,
    report.projection.retryableRows - report.telemetry.retryableRows,
  );
  assert.equal(
    report.reconciliation.neverExecutedDelta,
    report.projection.retryableNeverBrowserExecutedRows - report.telemetry.neverBrowserExecutedRows,
  );
  // Adding balanced fixture rows must not move the projection-vs-telemetry
  // delta, regardless of the surrounding backlog in the scratch database.
  assert.equal(
    report.reconciliation.retryableDelta,
    baseline.reconciliation.retryableDelta,
    'fixture additions preserve the retryable projection-vs-telemetry delta',
  );
  assert.equal(
    report.reconciliation.neverExecutedDelta,
    baseline.reconciliation.neverExecutedDelta,
    'fixture additions preserve the never-browser-executed delta',
  );
});
