import { getDb } from '../server/db';
import {
  evaluateAdmissionQuarantineRecovery,
  type AdmissionQuarantineRecoveryRow,
} from '../server/queryAdmissionQuarantineRecovery';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const db = await getDb();
  const result = await db.query(
    `SELECT id, query, country, status, collection,
            COALESCE(quality_channels_found,0)::int AS quality_channels_found,
            COALESCE(unique_channels_found,0)::int AS unique_channels_found,
            COALESCE(times_executed,0)::int AS times_executed,
            generation_metadata->'queryHold' AS query_hold
       FROM query_library
      WHERE generation_metadata->'queryHold'->>'source'='semantic-admission'
        AND generation_metadata->'queryHold'->'reasonCodes' ? 'ADMISSION_REJECTED_SHARE_HIGH'
      ORDER BY quality_channels_found DESC, unique_channels_found DESC, id`,
  );
  const rows: AdmissionQuarantineRecoveryRow[] = result.rows.map((row: any) => ({
    id: Number(row.id),
    query: String(row.query || ''),
    country: String(row.country || ''),
    status: String(row.status || ''),
    collection: String(row.collection || ''),
    qualityChannelsFound: Number(row.quality_channels_found || 0),
    uniqueChannelsFound: Number(row.unique_channels_found || 0),
    timesExecuted: Number(row.times_executed || 0),
    queryHold: row.query_hold || null,
  }));
  let restorable = 0;
  let restored = 0;
  for (const row of rows) {
    const decision = evaluateAdmissionQuarantineRecovery(row);
    if (decision.restore) restorable++;
    console.log(JSON.stringify({
      event: 'admission_quarantine_review',
      apply,
      ...row,
      restore: decision.restore,
      restoreCollection: decision.collection,
      reason: decision.reason,
    }));
    if (!apply || !decision.restore || !decision.collection) continue;
    const update = await db.query(
      `UPDATE query_library
          SET status='ACTIVE',
              collection=$2,
              generation_metadata=COALESCE(generation_metadata,'{}'::jsonb)-'queryHold'
        WHERE id=$1
          AND status='REJECTED'
          AND generation_metadata->'queryHold'=$3::jsonb
          AND generation_metadata->'queryHold'->>'source'='semantic-admission'
          AND generation_metadata->'queryHold'->'reasonCodes' ? 'ADMISSION_REJECTED_SHARE_HIGH'`,
      [row.id, decision.collection, JSON.stringify(row.queryHold)],
    );
    restored += update.rowCount || 0;
  }
  console.log(JSON.stringify({
    event: 'admission_quarantine_recovery_complete',
    apply,
    reviewed: rows.length,
    restorable,
    restored,
    skippedNoYield: rows.length - restorable,
    skippedChanged: apply ? restorable - restored : 0,
    timestamp: new Date().toISOString(),
  }));
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
