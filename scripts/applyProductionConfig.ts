import { writeFileSync } from 'node:fs';
import { loadProductionConfig, type ProductionConfigManifest } from '../server/productionConfig';

interface Options {
  config: string;
  apply: boolean;
  envOut: string;
}

function parseArgs(argv: string[]): Options {
  const value = (name: string, fallback: string): string => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  };
  return {
    config: value('config', 'config/production.json'),
    apply: argv.includes('--apply'),
    envOut: value('env-out', 'config/production.env.generated'),
  };
}

function envLine(key: string, value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `${key}="${escaped}"`;
}

function renderEnvFile(manifest: ProductionConfigManifest): string {
  const lines = [
    '# Generated from config/production.json. Non-secret runtime values only.',
    '# Import these into the deployment environment; secrets must come from',
    '# Coolify\'s encrypted environment or a secret manager.',
    '#',
    '# Operational state such as discovery pause and queue controls is not',
    '# part of this file; preserve it via the application database backup.',
    '',
  ];
  for (const [key, value] of Object.entries(manifest.environment)) {
    if (value === null) {
      lines.push(`# ${key} must remain unset (no override)`);
    } else {
      lines.push(envLine(key, value));
    }
  }
  lines.push('');
  return lines.join('\n');
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadProductionConfig(options.config);

  if (!options.apply) {
    for (const [key, value] of Object.entries(manifest.environment)) {
      console.log(value === null
        ? `plan env: ${key} must remain unset`
        : `plan env: ${key}=${value}`);
    }
    console.log('\nDry run only. Re-run with --apply to write the non-secret env file.');
    return 0;
  }

  writeFileSync(options.envOut, renderEnvFile(manifest), { encoding: 'utf8', mode: 0o600 });
  console.log(`Wrote ${options.envOut} (non-secret runtime values only, mode 600).`);
  console.log('Import the values into the deployment environment, then run:');
  console.log('  npm run config:verify');
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`Production config apply failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
