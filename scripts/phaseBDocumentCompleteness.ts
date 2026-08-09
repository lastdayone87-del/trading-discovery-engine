import 'dotenv/config';
import { inspectPhaseBDocumentCompleteness } from '../server/phaseBDocumentCompleteness';

const windowStart = process.env.PHASE_B_WINDOW_START;
const cutoffAt = process.env.PHASE_B_CUTOFF_AT;
if (!windowStart || !cutoffAt) throw new Error('PHASE_B_WINDOW_START and PHASE_B_CUTOFF_AT are required');
const report = await inspectPhaseBDocumentCompleteness({ windowStart, cutoffAt });
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 2;
