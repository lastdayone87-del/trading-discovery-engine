import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../server/db';
import { getStage2CanaryControlState } from '../server/release5/stage2CanaryControlPlane';

const OUTPUT_DIR = path.join(process.cwd(), 'stage2-output');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'stage2-canary-production-readiness.json');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const db = await getDb();
  const control = await getStage2CanaryControlState();

  const [migrationResult, subjectResult, eventResult] = await Promise.all([
    db.query(`SELECT version,name,applied_at FROM schema_migrations WHERE version=84`),
    db.query(`SELECT COUNT(*)::int AS count FROM stage2_rate_pressure_canary_subjects WHERE canary_generation=$1`, [control.generation]),
    db.query(`SELECT COUNT(*)::int AS count FROM stage2_rate_pressure_canary_events WHERE event_type='MODE_CHANGE' AND mode='CANARY'`)
  ]);

  const migration = migrationResult.rows[0] ?? null;
  const currentGenerationTreatmentSubjects = Number(subjectResult.rows[0]?.count ?? 0);
  const historicalCanaryEnableEvents = Number(eventResult.rows[0]?.count ?? 0);

  const checks = {
    migration084Applied: Boolean(migration),
    persistedModeOff: control.mode === 'OFF',
    noCurrentGenerationTreatmentSubjects: currentGenerationTreatmentSubjects === 0,
    noHistoricalCanaryEnableEvents: historicalCanaryEnableEvents === 0,
    automaticEnableForbidden: control.automaticEnableForbidden === true,
    defaultModeOff: control.defaultMode === 'OFF'
  };

  const ready = Object.values(checks).every(Boolean);
  const report = {
    reportType: 'STAGE2_CANARY_PRODUCTION_READINESS',
    version: 'stage2-canary-production-readiness-v1',
    readinessStatus: ready ? 'READY_FOR_SEPARATE_MANUAL_ACTIVATION_AUTHORIZATION' : 'BLOCKED',
    generatedAt: new Date().toISOString(),
    servingAuthority: false,
    productionActivation: false,
    mutatesCanaryControlState: false,
    migration: migration ? { version: Number(migration.version), name: String(migration.name), appliedAt: migration.applied_at } : null,
    control: {
      settingKey: control.settingKey,
      mode: control.mode,
      generation: control.generation,
      automaticEnableForbidden: control.automaticEnableForbidden,
      defaultMode: control.defaultMode,
      updatedAt: control.updatedAt
    },
    observations: {
      currentGenerationTreatmentSubjects,
      historicalCanaryEnableEvents
    },
    checks,
    nextAction: ready ? 'REQUEST_EXPLICIT_MANUAL_CANARY_ACTIVATION_AUTHORIZATION' : 'REPAIR_PRODUCTION_READINESS_BLOCKERS'
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (!ready) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
