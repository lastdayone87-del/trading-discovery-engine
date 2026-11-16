import { DEFAULT_ADMISSION_PRIMARY_MODEL, DEFAULT_ADMISSION_SECONDARY_MODEL } from '../server/channelAdmission/admissionModels';
import {
  DEFAULT_GROQ_CANDIDATE_MODEL,
  DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL,
  DEFAULT_MULTILINGUAL_CANDIDATE_MODEL,
} from '../server/evidenceEngine/modelDefaults';
import {
  checkCodeDefault,
  checkRequiredSecrets,
  checkSecretGroups,
  compareEnvironment,
  loadProductionConfig,
  summarizeChecks,
  type ConfigCheck,
} from '../server/productionConfig';

interface Options {
  config: string;
  skipSecrets: boolean;
  json: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const value = (name: string, fallback: string): string => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  };
  return {
    config: value('config', 'config/production.json'),
    skipSecrets: argv.includes('--skip-secrets'),
    json: argv.includes('--json'),
    verbose: argv.includes('--verbose'),
  };
}

function printChecks(checks: ConfigCheck[], verbose: boolean): void {
  const failures = checks.filter(check => !check.ok);
  const shown = verbose ? checks : failures;
  for (const check of shown) {
    const status = check.ok ? 'OK  ' : 'FAIL';
    console.log(`${status} ${check.source}:${check.key} expected=${check.expected ?? '<unset>'} actual=${check.actual ?? '<unset>'}`);
  }
  if (!verbose && failures.length > 0) {
    console.log(`\n${failures.length} mismatch(es). Re-run with --verbose to see all ${checks.length} checks.`);
  }
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadProductionConfig(options.config);
  const checks: ConfigCheck[] = [
    ...compareEnvironment(manifest, process.env),
    checkCodeDefault(
      'ADMISSION_PRIMARY_MODEL',
      manifest.environment.ADMISSION_PRIMARY_MODEL ?? null,
      DEFAULT_ADMISSION_PRIMARY_MODEL,
    ),
    checkCodeDefault(
      'MULTILINGUAL_CANDIDATE_MODEL',
      manifest.environment.MULTILINGUAL_CANDIDATE_MODEL ?? null,
      DEFAULT_MULTILINGUAL_CANDIDATE_MODEL,
    ),
    checkCodeDefault(
      'MULTILINGUAL_ADJUDICATOR_MODEL',
      manifest.environment.MULTILINGUAL_ADJUDICATOR_MODEL ?? null,
      DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL,
    ),
    checkCodeDefault(
      'GROQ_CANDIDATE_MODEL',
      manifest.environment.GROQ_CANDIDATE_MODEL ?? null,
      DEFAULT_GROQ_CANDIDATE_MODEL,
    ),
    checkCodeDefault(
      'ADMISSION_SECONDARY_MODEL(default)',
      'openai/gpt-oss-120b',
      DEFAULT_ADMISSION_SECONDARY_MODEL,
    ),
  ];
  if (!options.skipSecrets) {
    checks.push(...checkSecretGroups(manifest, process.env));
    checks.push(...checkRequiredSecrets(manifest, process.env));
  }

  const summary = summarizeChecks(checks);
  if (options.json) {
    console.log(JSON.stringify({ summary, checks }, null, 2));
  } else {
    printChecks(checks, options.verbose);
    console.log(`\nProduction runtime config: ${summary.ok ? 'OK' : 'DRIFT'} (${summary.checks} checks, ${summary.failures} failures)`);
  }
  return summary.ok ? 0 : 1;
}

try {
  // Prefer an exit code over process.exit() so piped/JSON output is flushed.
  process.exitCode = main();
} catch (error) {
  console.error(`Production config verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
