import { randomUUID } from 'node:crypto';
import { getDb } from '../server/db';
import { REPLAY_FEATURE_VERSION, REPLAY_POLICY_VERSION } from '../server/replayMeasurement';
import { REVIEW_REASON_CATALOG_VERSION } from '../server/reviewReasons';

const channelName = (process.env.REVIEW_PROBE_CHANNEL_NAME || '').trim();
if (!channelName) throw new Error('REVIEW_PROBE_CHANNEL_NAME is required.');

type StepResult = { step: string; ok: boolean; code?: string; message?: string };
const report: { channelName: string; readPersistedState: boolean; durableWrites: false; rolledBack: true; schema: Record<string, boolean>; steps: StepResult[] } = {
  channelName,
  readPersistedState: true,
  durableWrites: false,
  rolledBack: true,
  schema: {},
  steps: []
};

const db = await getDb();
const client = await db.connect();
let began = false;
try {
  const columns = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='channel_review_decisions'
      AND column_name IN ('reason_code','reason_catalog_version','reason_other_text')
  `);
  const present = new Set(columns.rows.map((row: { column_name: string }) => row.column_name));
  for (const name of ['reason_code','reason_catalog_version','reason_other_text']) report.schema[name] = present.has(name);

  const lookup = await client.query(`
    SELECT r.*, c.channel_name, to_jsonb(c) AS channel_snapshot
    FROM channel_reviews r JOIN channels c USING(channel_id)
    WHERE lower(c.channel_name)=lower($1) AND r.state='PENDING'
    ORDER BY r.pending_since ASC LIMIT 1
  `,[channelName]);
  if (!lookup.rowCount) throw new Error('No pending review row found for the requested channel.');
  const row = lookup.rows[0];
  const nextVersion = Number(row.review_version) + 1;
  const evidence = {...row.evidence_snapshot, decision_channel: row.channel_snapshot, decided_at: new Date().toISOString(), review_reason: {code:'NOT_TRADING_CREATOR',label:'Not actually a trading creator',version:REVIEW_REASON_CATALOG_VERSION}};
  const idempotencyKey = `rollback-probe:${row.channel_id}:${randomUUID()}`;

  await client.query('BEGIN'); began = true;
  const run = async (step: string, fn: () => Promise<unknown>) => {
    try { await fn(); report.steps.push({step,ok:true}); }
    catch (error:any) {
      report.steps.push({step,ok:false,code:error?.code ? String(error.code) : undefined,message:error instanceof Error ? error.message : String(error)});
      throw error;
    }
  };

  await run('update-channel-reject-status', () => client.query(`UPDATE channels SET trading_status='HUMAN_REJECTED',scan_status='SKIPPED_NON_TRADING',discord_status='NON_TRADING',updated_at=now() WHERE channel_id=$1`,[row.channel_id]));
  await run('cancel-active-jobs', () => client.query(`UPDATE jobs SET status='FAILED',last_error='Rollback-only human rejection probe',locked_by=NULL,locked_at=NULL,updated_at=now() WHERE status IN ('PENDING','PROCESSING') AND payload->>'channelId'=$1`,[row.channel_id]));
  await run('insert-review-decision', () => client.query(`INSERT INTO channel_review_decisions(channel_id,decision,previous_status,resulting_status,reviewer,reason,notes,review_version,evidence_snapshot,idempotency_key,reason_code,reason_catalog_version,reason_other_text) VALUES($1,'REJECT',$2,'REJECTED','rollback-probe','Not actually a trading creator',NULL,$3,$4,$5,'NOT_TRADING_CREATOR',$6,NULL)`,[row.channel_id,row.state,nextVersion,JSON.stringify(evidence),idempotencyKey,REVIEW_REASON_CATALOG_VERSION]));

  const lineage = await client.query(`SELECT s.query_run_id,s.query_id,r.job_id,r.country,r.retrieval_lane FROM channel_sightings s JOIN query_runs r ON r.id=s.query_run_id WHERE s.channel_id=$1 ORDER BY s.observed_at DESC LIMIT 1`,[row.channel_id]);
  const origin = lineage.rows[0];
  await run('insert-review-outcome-event', () => client.query(`INSERT INTO outcome_events(event_key,subject_type,subject_id,event_type,event_version,source_event_key,query_id,query_run_id,job_id,country,retrieval_lane,verification_status,policy_version,feature_version,event_time,payload) VALUES($1,'CHANNEL',$2,'REVIEW_VERIFIED',1,$3,$4,$5,$6,$7,$8,'VERIFIED',$9,$10,now(),$11)`,[`rollback-probe:${row.channel_id}:${randomUUID()}`,row.channel_id,origin?`query-run:${origin.query_run_id}:selected:v1`:null,origin?.query_id||null,origin?.query_run_id||null,origin?.job_id||null,origin?.country||row.channel_snapshot?.country||null,origin?.retrieval_lane||null,REPLAY_POLICY_VERSION,REPLAY_FEATURE_VERSION,JSON.stringify({action:'REJECT',previousStatus:row.state,resultingStatus:'REJECTED',reviewVersion:nextVersion,reasonCode:'NOT_TRADING_CREATOR'})]));
  await run('update-review-row', () => client.query(`UPDATE channel_reviews SET state='REJECTED',review_version=$2,evidence_snapshot=$3,decided_at=now(),updated_at=now() WHERE channel_id=$1`,[row.channel_id,nextVersion,JSON.stringify(evidence)]));
} catch (error:any) {
  if (!report.steps.some(step => step.ok === false)) report.steps.push({step:'preflight',ok:false,code:error?.code ? String(error.code) : undefined,message:error instanceof Error ? error.message : String(error)});
} finally {
  if (began) await client.query('ROLLBACK').catch(()=>undefined);
  client.release();
}

console.log(JSON.stringify(report,null,2));
if (report.steps.some(step => !step.ok)) process.exitCode = 2;
