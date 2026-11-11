import { reconcileClassificationResolutionGaps } from '../server/classificationResolutionRecovery';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const includeLegacy = process.argv.includes('--include-legacy');
  const limit = Number(arg('--limit') || 200);
  const cutoff = includeLegacy ? '1970-01-01T00:00:00.000Z' : arg('--cutoff');
  const result = await reconcileClassificationResolutionGaps({
    dryRun: !apply,
    includeLegacy,
    limit,
    cutoff,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.error('DRY RUN ONLY. Re-run with --apply after explicit production approval.');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
