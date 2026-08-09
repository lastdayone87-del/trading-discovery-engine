import 'dotenv/config';
import { inspectPhaseBHistoryReadiness } from '../server/phaseBHistoryReadiness';

const report = await inspectPhaseBHistoryReadiness();
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 2;
