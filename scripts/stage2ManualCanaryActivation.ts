import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { getStage2CanaryControlState, setStage2CanaryMode } from '../server/release5/stage2CanaryControlPlane';

const REQUIRED_CONFIRMATION = 'AUTHORIZE_STAGE2_5_PERCENT_CANARY_MAX_50';

async function main() {
  const confirmation = process.env.STAGE2_CANARY_CONFIRMATION ?? '';
  const actor = (process.env.STAGE2_CANARY_ACTOR ?? '').trim();
  const reason = (process.env.STAGE2_CANARY_REASON ?? '').trim();
  const expectedGeneration = Number(process.env.STAGE2_CANARY_EXPECTED_GENERATION ?? 'NaN');

  if (confirmation !== REQUIRED_CONFIRMATION) throw new Error('STAGE2_EXPLICIT_ACTIVATION_CONFIRMATION_REQUIRED');
  if (!actor || !reason) throw new Error('STAGE2_ACTIVATION_ACTOR_AND_REASON_REQUIRED');
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('STAGE2_VALID_EXPECTED_GENERATION_REQUIRED');

  const before = await getStage2CanaryControlState();
  if (before.mode !== 'OFF') throw new Error(`STAGE2_CANARY_MUST_START_OFF:${before.mode}`);
  if (before.generation !== expectedGeneration) throw new Error(`STAGE2_EXPECTED_GENERATION_MISMATCH:${before.generation}`);

  const changed = await setStage2CanaryMode('CANARY', {
    actor,
    reason,
    manualApproval: true,
    expectedGeneration
  });
  const after = await getStage2CanaryControlState();
  if (after.mode !== 'CANARY' || after.generation !== expectedGeneration + 1) throw new Error('STAGE2_ACTIVATION_POSTCONDITION_FAILED');

  const report = {
    reportType: 'STAGE2_EXPLICIT_MANUAL_CANARY_ACTIVATION',
    version: 'stage2-explicit-manual-canary-activation-v1',
    activatedAt: new Date().toISOString(),
    authorization: { explicit: true, confirmation: REQUIRED_CONFIRMATION, actor, reason },
    envelope: { allocationBasisPoints: 500, allocationPercent: 5, maximumTreatmentSubjects: 50, automaticRampForbidden: true },
    before,
    changed,
    after,
    nextAction: 'BEGIN_BOUNDED_CANARY_OBSERVATION'
  };

  const outDir = path.resolve('stage2-output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'stage2-canary-activation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
