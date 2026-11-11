import { reconcileClassificationResolutionGaps } from '../server/classificationResolutionRecovery';
import { getDb } from '../server/db';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const dryRunFlag = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply') && !dryRunFlag;
  const includeLegacy = process.argv.includes('--include-legacy');
  const rawLimit = arg('--limit');
  const parsedLimit = rawLimit === undefined ? 200 : Number(rawLimit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) throw new Error('--limit must be an integer between 1 and 200.');
  const cutoff = includeLegacy ? '1970-01-01T00:00:00.000Z' : arg('--cutoff');
  if (apply && cutoff && !includeLegacy) throw new Error('--cutoff requires --include-legacy for a mutating run.');
  const result = await reconcileClassificationResolutionGaps({
    dryRun: !apply,
    includeLegacy,
    limit: parsedLimit,
    cutoff,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.error('DRY RUN ONLY. Re-run with --apply after explicit production approval.');
  }
  const db = await getDb();
  await db.end().catch(() => undefined);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
