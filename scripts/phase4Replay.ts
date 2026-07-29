import { randomUUID } from 'node:crypto';
import { getDb, getReplayReport } from '../server/db';
import { REPLAY_FEATURE_VERSION, REPLAY_POLICY_VERSION, stableChecksum } from '../server/replayMeasurement';

const to=process.env.REPLAY_TO||new Date().toISOString();
const from=process.env.REPLAY_FROM||new Date(Date.parse(to)-24*60*60*1000).toISOString();
const dataset=process.env.REPLAY_DATASET_VERSION||'benchmark-v1';
const tolerance=Number(process.env.REPLAY_TOLERANCE||'0');
const started=new Date().toISOString();
const report=await getReplayReport(from,to,tolerance);
const db=await getDb();
const datasetChecksum=stableChecksum({window:report.window,replayChecksum:report.replay.checksum,policyVersion:REPLAY_POLICY_VERSION,featureVersion:REPLAY_FEATURE_VERSION});
await db.query(`INSERT INTO benchmark_datasets(version,artifact_checksum,policy_version,feature_version,acceptance_tolerance,frozen_at,metadata) VALUES($1,$2,$3,$4,$5,now(),$6) ON CONFLICT(version) DO NOTHING`,[dataset,datasetChecksum,REPLAY_POLICY_VERSION,REPLAY_FEATURE_VERSION,tolerance,JSON.stringify({window:report.window,eventCount:report.replay.eventCount})]);
const configurationChecksum=stableChecksum({dataset,tolerance,from,to,policyVersion:REPLAY_POLICY_VERSION,featureVersion:REPLAY_FEATURE_VERSION});
await db.query(`INSERT INTO replay_runs(id,dataset_version,code_version,configuration_checksum,status,window_start,window_end,report,started_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,[randomUUID(),dataset,process.env.GIT_COMMIT||'development',configurationChecksum,report.reconciliation.pass?'PASS':'FAIL',from,to,JSON.stringify(report),started]);
console.log(JSON.stringify({...report,datasetVersion:dataset,datasetChecksum,configurationChecksum},null,2));
await db.end();
