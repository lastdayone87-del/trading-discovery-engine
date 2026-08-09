import { getDb } from '../server/db';
import { runCreatorReadinessShadow } from '../server/creatorIntelligence/readiness';

const cutoffAt = process.env.CREATOR_READINESS_CUTOFF || new Date().toISOString();
const windowDays = Number(process.env.CREATOR_READINESS_WINDOW_DAYS || '30');
const result = await runCreatorReadinessShadow(cutoffAt, windowDays);
console.log(JSON.stringify(result, null, 2));
await (await getDb()).end();
