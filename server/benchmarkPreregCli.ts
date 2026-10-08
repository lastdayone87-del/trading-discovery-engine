import { resolve } from 'node:path';
import {
  BENCHMARK_PREREG_V1_SPEC,
  BENCHMARK_PREREG_V2_SPEC,
} from './benchmarkPreregV1';

export interface BenchmarkCliArgs {
  mode: 'plan' | 'execute';
  outDir: string;
  force: boolean;
  specVersion: string;
}

/** Resolve a CLI spec alias to its full spec version string. Pure. */
export function resolveCliSpecVersion(raw: string): string {
  if (raw === 'v1') return BENCHMARK_PREREG_V1_SPEC.specVersion;
  if (raw === 'v2') return BENCHMARK_PREREG_V2_SPEC.specVersion;
  return raw;
}

/**
 * Argument parsing extracted import-safe for unit testing: throws
 * BENCHMARK_PREREG_USAGE errors instead of exiting (the runner maps them to
 * usageError to preserve exact CLI behavior). Defaults to the v1 spec, so
 * existing v1 commands behave byte-identically.
 */
export function parseBenchmarkArgs(argv: string[]): BenchmarkCliArgs {
  const fail = (message: string): never => {
    throw new Error(`BENCHMARK_PREREG_USAGE: ${message}`);
  };
  let mode: 'plan' | 'execute' = 'plan';
  let outDir = '';
  let force = false;
  let specVersion = BENCHMARK_PREREG_V1_SPEC.specVersion;
  for (const arg of argv) {
    if (arg === '--execute') mode = 'execute';
    else if (arg === '--plan') mode = 'plan';
    else if (arg === '--force') force = true;
    else if (arg.startsWith('--out=')) outDir = arg.slice('--out='.length);
    else if (arg === '--out') outDir = argv[argv.indexOf(arg) + 1] || '';
    else if (arg.startsWith('--spec-version=')) specVersion = resolveCliSpecVersion(arg.slice('--spec-version='.length));
    else if (arg.startsWith('--')) fail(`Unknown flag ${arg}`);
  }
  if (!outDir) fail('Missing required --out <dir>');
  return { mode, outDir: resolve(outDir), force, specVersion };
}
