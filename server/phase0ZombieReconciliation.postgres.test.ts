import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './dbCore';
import { buildPhase0ZombieReconciliationReport } from './phase0ZombieReconciliation';

// The suite inserts jobs/channels/ledger fixtures, so it is opt-in and only
// runs against the dedicated scratch database configured by the workflow.
const dedicatedDatabaseUrl = process.env.PHASE0_ZOMBIE_TEST_DATABASE_URL;
if (dedicatedDatabaseUrl) process.env.DATABASE_URL = dedicatedDatabaseUrl;
const enabled = Boolean(dedicatedDatabaseUrl);
const maybe = enabled ? test : test.skip;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface ChannelFixture {
  channelId: string;
  discordStatus?: string;
  discordValidationStatus?: string;
}

async function insertChannel(db: any, fixture: ChannelFixture): Promise<void> {
  await db.query(
    `INSERT INTO channels(
       channel_id,channel_name,youtube_url,country,country_status,discord_status,
       scan_status,discovery_source,first_seen,trading_status,discord_validation_status
     ) VALUES($1,$2,$3,'Germany','CONFIRMED',$4,'ENRICHING','automated_query',now(),
              'UNCERTAIN',$5)
     ON CONFLICT (channel_id) DO UPDATE
       SET discord_status=EXCLUDED.discord_status,
           discord_validation_status=EXCLUDED.discord_validation_status`,
    [
      fixture.channelId,
      `Channel ${fixture.channelId}`,
      `https://youtube.test/${fixture.channelId}`,
      fixture.discordStatus || 'NOT_FOUND',
      fixture.discordValidationStatus || 'NOT_STARTED',
    ],
  );
}

async function insertRetryJob(
  db: any,
  args: {
    channelId: string;
    idempotencyKey: string;
    status?: string;
    retryObservedAt?: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO jobs(type,payload,status,priority,max_attempts,run_after,idempotency_key)
     VALUES('RETRY_COMMUNITY_ACQUISITION',$1::jsonb,$2,1000000000,5,
            now()-interval '1 minute',$3)`,
    [
      JSON.stringify({
        channelId: args.channelId,
        retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
        retryLifecycleVersion: 2,
        retryObservedAt: args.retryObservedAt || '2026-10-02T00:00:00.000Z',
        reconciliationStatus: 'NONE',
      }),
      args.status || 'PENDING',
      args.idempotencyKey,
    ],
  );
}

async function insertObservation(
  db: any,
  args: {
    channelId: string;
    key: string;
    surface: string;
    required: boolean;
    retryable: boolean;
    observedAt: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO external_acquisition_observations(
       observation_key,channel_id,requested_url,outcome,retryable,failure_class,
       detail,provenance,policy_version,observed_at
     ) VALUES($1,$2,'https://fixture.example/links','ACQUISITION_FAILED',$3,
              'NETWORK_FAILURE','zombie fixture',$4::jsonb,'phase0-zombie-test-v1',$5::timestamptz)`,
    [
      args.key,
      args.channelId,
      args.retryable,
      JSON.stringify({
        provider: 'external-link',
        surface: args.surface,
        required: args.required,
        crawlerTelemetry: { mode: 'STATIC', pagesInspected: 1 },
      }),
      args.observedAt,
    ],
  );
}

maybe('the zombie dry-run classifies evidence-backed closures and every skip reason', async t => {
  const db = await getDb();
  const client = await db.connect();
  const suffix = uniqueSuffix();
  const channelIds: string[] = [];
  const channel = (name: string) => `UCzombie-${name}-${suffix}`;

  t.after(async () => {
    if (channelIds.length === 0) return;
    await db.query(`DELETE FROM community_acquisition_url_state WHERE channel_id = ANY($1::text[])`, [channelIds]);
    await db.query(`DELETE FROM jobs WHERE payload->>'channelId' = ANY($1::text[])`, [channelIds]);
    await db.query(`DELETE FROM channels WHERE channel_id = ANY($1::text[])`, [channelIds]);
  });

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    const fixtures: Array<{
      name: string;
      discordStatus?: string;
      discordValidationStatus?: string;
      jobStatus?: string;
      retryObservedAt?: string;
      observations?: Array<{
        surface: string;
        required: boolean;
        retryable: boolean;
        observedAt: string;
      }>;
      ledgerStates?: string[];
    }> = [
      {
        name: 'close-terminal',
        discordValidationStatus: 'SUCCEEDED',
        // An optional newer failure is not required work and cannot block.
        observations: [
          { surface: 'CREATOR_WEBSITES', required: false, retryable: true, observedAt: '2026-10-04T00:00:00.000Z' },
        ],
      },
      {
        name: 'close-ledger',
        ledgerStates: ['RESOLVED', 'EXHAUSTED'],
        // An upstream (non-community) failure cannot block community closure.
        observations: [
          { surface: 'UPSTREAM_YOUTUBE', required: true, retryable: true, observedAt: '2026-10-04T00:00:00.000Z' },
        ],
      },
      {
        name: 'skip-fresh',
        discordStatus: 'FOUND',
        observations: [
          { surface: 'CREATOR_WEBSITES', required: true, retryable: true, observedAt: '2026-10-03T00:00:00.000Z' },
        ],
      },
      {
        name: 'skip-processing',
        discordValidationStatus: 'COMPLETED',
        jobStatus: 'PROCESSING',
      },
      { name: 'skip-open' },
      {
        name: 'skip-active-ledger',
        discordValidationStatus: 'SUCCEEDED',
        ledgerStates: ['PENDING', 'RESOLVED'],
      },
      {
        name: 'skip-missing-epoch',
        discordValidationStatus: 'SUCCEEDED',
        retryObservedAt: 'not-a-date',
      },
    ];

    for (const fixture of fixtures) {
      const channelId = channel(fixture.name);
      channelIds.push(channelId);
      await insertChannel(db, {
        channelId,
        discordStatus: fixture.discordStatus,
        discordValidationStatus: fixture.discordValidationStatus,
      });
      await insertRetryJob(db, {
        channelId,
        idempotencyKey: `zombie-${fixture.name}-${suffix}`,
        status: fixture.jobStatus,
        retryObservedAt: fixture.retryObservedAt,
      });
      for (const [index, observation] of (fixture.observations || []).entries()) {
        await insertObservation(db, {
          channelId,
          key: `zombie-${fixture.name}-${index}-${suffix}`,
          ...observation,
        });
      }
      for (const [index, state] of (fixture.ledgerStates || []).entries()) {
        await db.query(
          `INSERT INTO community_acquisition_url_state(
             work_key,channel_id,url,normalized_url,surface,state
           ) VALUES($1,$2,$3,$3,'CREATOR_WEBSITES',$4)`,
          [
            `zombie-${fixture.name}-${index}-${suffix}`,
            channelId,
            `https://fixture.example/${fixture.name}/${index}`,
            state,
          ],
        );
      }
    }

    const report = await buildPhase0ZombieReconciliationReport(client, {
      maxJobs: 5_000,
      includeRows: true,
    });
    await client.query('COMMIT');

    const rows = [...report.proposals, ...(report.skippedRows || [])]
      .filter(row => row.channelId.startsWith(`UCzombie-`))
      .filter(row => row.channelId.endsWith(suffix));
    const byChannel = new Map(rows.map(row => [row.channelId, row]));
    const decision = (name: string) => {
      const row = byChannel.get(channel(name));
      assert.ok(row, `missing decision for ${name}`);
      return [row.decision, row.reason];
    };

    assert.deepEqual(decision('close-terminal'), ['PROPOSE_CLOSE', 'CHANNEL_TERMINAL']);
    assert.deepEqual(decision('close-ledger'), ['PROPOSE_CLOSE', 'LEDGER_ALL_TERMINAL']);
    assert.deepEqual(decision('skip-fresh'), ['SKIP', 'NEWER_RETRYABLE_OBSERVATION']);
    assert.deepEqual(decision('skip-processing'), ['SKIP', 'PROCESSING_ACTIVE']);
    assert.deepEqual(decision('skip-open'), ['SKIP', 'CHANNEL_NOT_TERMINAL']);
    assert.deepEqual(decision('skip-active-ledger'), ['SKIP', 'LEDGER_ACTIVE_WORK']);
    assert.deepEqual(decision('skip-missing-epoch'), ['SKIP', 'MISSING_RETRY_OBSERVED_AT']);

    // The ledger is empty in Phase 0 prod, but this scratch database has both
    // fixture rows and possibly rows from other tests. The report must always
    // classify with the same evidence, and every examined job must land in
    // exactly one partition.
    assert.equal(
      report.summary.proposedClosures + report.summary.skipped,
      report.population.examined,
    );
    const closeLedger = byChannel.get(channel('close-ledger'));
    assert.equal(closeLedger?.ledgerRows, 2);
    assert.equal(closeLedger?.ledgerTerminalRows, 2);
    assert.equal(closeLedger?.ledgerActiveRows, 0);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});
