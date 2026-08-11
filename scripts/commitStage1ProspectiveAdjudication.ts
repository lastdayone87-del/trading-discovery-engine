import { mkdir, writeFile } from 'node:fs/promises';
import { commitStage1ProspectiveAdjudication } from '../server/candidateAdmission/stage1ProspectiveAdjudication';
import type { CreatorType } from '../server/decisionEvaluation';

const channel = String(process.env.STAGE1_ADJUDICATION_CHANNEL || '').trim();
const label = String(process.env.STAGE1_ADJUDICATION_LABEL || '').trim().toUpperCase();
const creatorType = String(process.env.STAGE1_ADJUDICATION_CREATOR_TYPE || '').trim() as CreatorType;
const reasonCodes = String(process.env.STAGE1_ADJUDICATION_REASON_CODES || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const reviewer = String(process.env.STAGE1_ADJUDICATION_REVIEWER || 'github-actions').trim();
const notes = String(process.env.STAGE1_ADJUDICATION_NOTES || '').trim();
const confirmation = String(process.env.STAGE1_ADJUDICATION_CONFIRMATION || '').trim();

if (!channel) throw new Error('STAGE1_ADJUDICATION_CHANNEL is required.');
if (label !== 'TRADING_CONFIRMED' && label !== 'NON_TRADING') throw new Error('STAGE1_ADJUDICATION_LABEL must be TRADING_CONFIRMED or NON_TRADING.');

const result = await commitStage1ProspectiveAdjudication({
  channel,
  label,
  creatorType,
  reasonCodes,
  reviewer,
  notes: notes || undefined,
  confirmation
});

await mkdir('stage1-output', { recursive: true });
await writeFile('stage1-output/stage1-prospective-adjudication-result.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
