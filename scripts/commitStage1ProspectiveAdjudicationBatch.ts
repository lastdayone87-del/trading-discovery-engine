import { mkdir, writeFile } from 'node:fs/promises';
import {
  commitStage1ProspectiveAdjudication,
  inspectStage1ProspectiveAdjudicationCandidate,
  STAGE1_PROSPECTIVE_ADJUDICATION_CONFIRMATION
} from '../server/candidateAdmission/stage1ProspectiveAdjudication';
import {
  parseStage1BatchAdjudicationEntries,
  STAGE1_BATCH_ADJUDICATION_CONFIRMATION
} from '../server/candidateAdmission/stage1ProspectiveAdjudicationBatch';

const raw = String(process.env.STAGE1_BATCH_ADJUDICATIONS || '').trim();
const reviewer = String(process.env.STAGE1_ADJUDICATION_REVIEWER || 'github-actions').trim();
const confirmation = String(process.env.STAGE1_BATCH_ADJUDICATION_CONFIRMATION || '').trim();

if (confirmation !== STAGE1_BATCH_ADJUDICATION_CONFIRMATION) throw new Error('EXPLICIT_BATCH_CONFIRMATION_REQUIRED');
if (!reviewer) throw new Error('REVIEWER_REQUIRED');

const entries = parseStage1BatchAdjudicationEntries(raw);
const preflight = [] as Array<{
  entry: (typeof entries)[number];
  channelId: string;
  channelName: string;
  action: 'COMMIT' | 'SKIP_ALREADY_COMMITTED';
}>;

for (const entry of entries) {
  const candidate = await inspectStage1ProspectiveAdjudicationCandidate(entry.channel);
  if (candidate.readiness === 'INDEPENDENT_LABEL_ALREADY_EXISTS') {
    if (candidate.existing_label !== entry.label) {
      throw new Error(`BATCH_CONFLICTING_EXISTING_LABEL:${candidate.channel_id}:${candidate.existing_label}:${entry.label}`);
    }
    preflight.push({ entry, channelId: candidate.channel_id, channelName: candidate.channel_name, action: 'SKIP_ALREADY_COMMITTED' });
    continue;
  }
  if (candidate.readiness !== 'READY_FOR_INDEPENDENT_ADJUDICATION') {
    throw new Error(`BATCH_ENTRY_NOT_READY:${candidate.channel_id}:${candidate.readiness}`);
  }
  preflight.push({ entry, channelId: candidate.channel_id, channelName: candidate.channel_name, action: 'COMMIT' });
}

const committed = [] as unknown[];
const skipped = [] as unknown[];
for (const item of preflight) {
  if (item.action === 'SKIP_ALREADY_COMMITTED') {
    skipped.push({ channelId: item.channelId, channelName: item.channelName, label: item.entry.label, reason: 'MATCHING_INDEPENDENT_LABEL_ALREADY_EXISTS' });
    continue;
  }
  committed.push(await commitStage1ProspectiveAdjudication({
    channel: item.channelId,
    label: item.entry.label,
    creatorType: item.entry.creatorType,
    reasonCodes: item.entry.reasonCodes,
    reviewer,
    notes: item.entry.notes,
    confirmation: STAGE1_PROSPECTIVE_ADJUDICATION_CONFIRMATION
  }));
}

const result = {
  reportType: 'STAGE1_PROSPECTIVE_INDEPENDENT_ADJUDICATION_BATCH',
  servingAuthority: false,
  operationalStateMutation: false,
  humanDecisionRequired: true,
  requested: entries.length,
  committedCount: committed.length,
  skippedCount: skipped.length,
  committed,
  skipped
};

await mkdir('stage1-output', { recursive: true });
await writeFile('stage1-output/stage1-prospective-adjudication-batch-result.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
