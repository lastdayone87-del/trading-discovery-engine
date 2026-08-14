from pathlib import Path

# Rename the unmerged incident-recovery migration so active/new code no longer
# carries Provider2 terminology. Historical 088/089 rollback migrations remain.
old_migration = Path('server/db/migrations/091_recover_provider2_false_negatives.sql')
new_migration = Path('server/db/migrations/091_recover_incident_false_negatives.sql')
if old_migration.exists():
    old_migration.rename(new_migration)
if not new_migration.exists():
    raise SystemExit('migration 091 not found')
s = new_migration.read_text()
s = s.replace('-- Bounded recovery for machine NON_TRADING decisions made while Provider #2 was\n-- active in autonomous discovery. This deliberately does NOT weaken the\n', '-- Bounded recovery for suspicious machine NON_TRADING decisions made during\n-- the incident window. This deliberately does NOT weaken the\n')
s = s.replace('-- Provider #2 production window:\n', '-- Incident window:\n')
s = s.replace("'PROVIDER2_FALSE_NEGATIVE_RESCAN'", "'CLASSIFICATION_FALSE_NEGATIVE_RESCAN'")
s = s.replace("'incidentRecovery', 'provider2_false_negative_v1'", "'incidentRecovery', 'classification_false_negative_v1'")
s = s.replace("'provider2-false-negative-recovery-v1:'", "'classification-false-negative-recovery-v1:'")
new_migration.write_text(s)

p = Path('server/operationalMaintenanceWorkers.ts')
s = p.read_text()
s = s.replace('const PROVIDER2_RECOVERY_JOB =', 'const FALSE_NEGATIVE_RECOVERY_JOB =')
s = s.replace("'PROVIDER2_FALSE_NEGATIVE_RESCAN'", "'CLASSIFICATION_FALSE_NEGATIVE_RESCAN'")
s = s.replace('function startProvider2RecoveryWorker', 'function startFalseNegativeRecoveryWorker')
s = s.replace('[PROVIDER2_RECOVERY_JOB]', '[FALSE_NEGATIVE_RECOVERY_JOB]')
s = s.replace('Provider2 recovery job is missing channelId.', 'False-negative recovery job is missing channelId.')
s = s.replace('Provider2 false-negative recovery tick failed:', 'False-negative recovery tick failed:')
s = s.replace('startProvider2RecoveryWorker(`provider2_recovery_${process.pid}_0`);', 'startFalseNegativeRecoveryWorker(`false_negative_recovery_${process.pid}_0`);')
s = s.replace('PROVIDER2_RECOVERY_JOB];', 'FALSE_NEGATIVE_RECOVERY_JOB];')
if 'PROVIDER2_' in s or 'Provider2' in s or 'provider2_' in s:
    raise SystemExit('active recovery worker still contains Provider2 terminology')
p.write_text(s)

p = Path('server/operationalMaintenanceWorkers.test.ts')
s = p.read_text()
s = s.replace("test('Provider2 false-negative recovery reserves quota before claiming its custom job'", "test('false-negative recovery reserves quota before claiming its custom job'")
s = s.replace("claimNextJob(workerId, [PROVIDER2_RECOVERY_JOB])", "claimNextJob(workerId, [FALSE_NEGATIVE_RECOVERY_JOB])")
s = s.replace("/PROVIDER2_RECOVERY_JOB = 'PROVIDER2_FALSE_NEGATIVE_RESCAN'/", "/FALSE_NEGATIVE_RECOVERY_JOB = 'CLASSIFICATION_FALSE_NEGATIVE_RESCAN'/")
s = s.replace("test('Provider2 recovery maps wrapped upstream failures back to transient infrastructure retries'", "test('false-negative recovery maps wrapped upstream failures back to transient infrastructure retries'")
p.write_text(s)

p = Path('src/components/QueueMonitor.tsx')
s = p.read_text()
s = s.replace('Expected near 1 with official enrichment; telemetry-window estimate.', 'Stage 1 normally costs 101 official units; stage 2 normally costs 202. Telemetry-window estimate.')
s = s.replace('Provider-call telemetry only; zero-cost YouTube Data API calls excluded.', 'Official provider-call telemetry for enrichment operations.')
if 'YouTube.js' in s or 'youtube_js' in s or 'hybrid-enrichment-channel-details' in s:
    raise SystemExit('retired provider telemetry remains in QueueMonitor')
p.write_text(s)

# Extend the removal contract to ensure active runtime/dashboard no longer carry
# the retired provider terminology, while historical rollback migrations remain.
p = Path('server/provider2Removal.contract.test.ts')
s = p.read_text()
if "operationalMaintenanceWorkers" not in s:
    anchor = "const queueMonitor = readFileSync(new URL('../src/components/QueueMonitor.tsx', import.meta.url), 'utf8');"
    s = s.replace(anchor, anchor + "\nconst operationalMaintenanceWorkers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');", 1)
if "active maintenance runtime is provider-neutral" not in s:
    s += r'''

test('active maintenance runtime is provider-neutral', () => {
  assert.doesNotMatch(operationalMaintenanceWorkers, /PROVIDER2_|Provider2|provider2_/);
  assert.match(operationalMaintenanceWorkers, /CLASSIFICATION_FALSE_NEGATIVE_RESCAN/);
});
'''
p.write_text(s)
