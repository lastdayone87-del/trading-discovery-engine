import 'dotenv/config';
import { inspectPhaseBObservationCompleteness } from '../server/phaseBObservationOutbox';

const report = await inspectPhaseBObservationCompleteness();
console.log(JSON.stringify(report, null, 2));
if (!report.complete) process.exitCode = 2;
