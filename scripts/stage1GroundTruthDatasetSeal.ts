import { mkdirSync, writeFileSync } from 'node:fs';
import {
  inspectStage1GroundTruthSeal,
  sealStage1GroundTruthDataset,
  type Stage1GroundTruthSealDefinition
} from '../server/candidateAdmission/stage1GroundTruthSealer';

const args = new Set(process.argv.slice(2));
const seal = args.has('--seal');
const cutoffAt = process.env.STAGE1_CUTOFF_AT || new Date().toISOString();
const definition: Stage1GroundTruthSealDefinition = {
  datasetKey: process.env.STAGE1_DATASET_KEY || 'stage1-independent-ground-truth',
  cutoffAt,
  minimumPerClass: Number(process.env.STAGE1_MINIMUM_PER_CLASS || 30)
};

const report = seal
  ? await sealStage1GroundTruthDataset({
      definition,
      actor: process.env.STAGE1_SEAL_ACTOR || 'github-actions',
      confirmation: process.env.STAGE1_SEAL_CONFIRMATION || ''
    })
  : await inspectStage1GroundTruthSeal(definition);

mkdirSync('stage1-output', { recursive: true });
const path = seal
  ? 'stage1-output/stage1-ground-truth-seal-result.json'
  : 'stage1-output/stage1-ground-truth-seal-preview.json';
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
