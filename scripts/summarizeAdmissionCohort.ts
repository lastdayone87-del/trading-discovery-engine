/**
 * Read-only summarizer for admission cohorts.
 *
 * Supports both label formats:
 *   * the original 60-channel object fixture (`{ _meta, labels: { channelId: { label, note } } }`)
 *   * sealed JSONL review labels (`{ channelId, label, language, note, ... }`)
 *
 * Metrics are calculated only for independently reviewed channels and only for
 * rows with a terminal admission decision. AMBIGUOUS / UNKNOWN_EVIDENCE labels
 * are never scored. Precision/recall/specificity/accuracy use Wilson 95%
 * intervals; F1 uses a deterministic percentile bootstrap.
 *
 * Usage:
 *   npx tsx scripts/summarizeAdmissionCohort.ts \
 *     --results=/tmp/opencode/fresh-200-results.jsonl \
 *     --labels=/tmp/opencode/fresh-200-labels.jsonl \
 *     --seal=/tmp/opencode/fresh-200-label-seal.json \
 *     --json-out=/tmp/opencode/fresh-200-summary.json \
 *     --md-out=/tmp/opencode/fresh-200-summary.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

function argValue(name: string): string | undefined {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

type Label = 'TRADING' | 'FINANCE_ADJACENT' | 'UNRELATED' | 'AMBIGUOUS' | 'UNKNOWN_EVIDENCE';
type TerminalDecision = 'ADMIT' | 'ADMIT_AMBIGUOUS' | 'REJECT_UNRELATED';
interface ReviewLabel { channelId: string; label: Label; language?: string; note?: string; index?: number }
interface Row {
  channelId: string;
  channelName: string;
  group?: string;
  prior?: string;
  decision: string;
  deterministic?: string;
  label: Label;
  language: string;
  note?: string;
  positive: boolean;
}
interface Confusion { tp: number; fp: number; fn: number; tn: number; decided: number; undecided: number }
interface Interval { low: number; high: number; n: number }

const expectedAdmit = new Set<Label>(['TRADING', 'FINANCE_ADJACENT']);
const unresolvedLabels = new Set<Label>(['AMBIGUOUS', 'UNKNOWN_EVIDENCE']);
const terminal = new Set<string>(['ADMIT', 'ADMIT_AMBIGUOUS', 'REJECT_UNRELATED']);
const iterations = Math.max(200, Number(argValue('bootstrap') || 10_000));
const seed = argValue('seed') || 'admission-cohort-bootstrap-v1';
const resultsPath = argValue('results') || '/tmp/opencode/admission-cohort-60.jsonl';
const labelsPath = argValue('labels') || argValue('ground-truth') || 'scripts/fixtures/admission-cohort-60-ground-truth.json';
const sealPath = argValue('seal');
const correctionsPath = argValue('corrections');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function loadReview(path: string): { labels: ReviewLabel[]; meta: Record<string, unknown> | null } {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) fail(`Review label file is empty: ${path}`);
  // A JSONL file also begins with '{'. Only use the whole-document branch when
  // parsing succeeds AND the document actually has a labels object.
  let document: { _meta?: Record<string, unknown>; labels?: Record<string, { label: Label; note?: string; language?: string }> } | null = null;
  try {
    const parsed = JSON.parse(raw) as typeof document;
    if (parsed && typeof parsed === 'object' && parsed.labels) document = parsed;
  } catch {
    // Not a single JSON document; fall through to JSONL.
  }
  if (document?.labels) {
    return {
      meta: document._meta || null,
      labels: Object.entries(document.labels).map(([channelId, value]) => ({ channelId, label: value.label, note: value.note, language: value.language })),
    };
  }
  const labels = raw.split('\n').filter(Boolean).map((line, index) => {
    let value: ReviewLabel;
    try {
      value = JSON.parse(line) as ReviewLabel;
    } catch {
      fail(`Invalid review label JSON on line ${index + 1} of ${path}`);
    }
    if (!value.channelId || !value.label) fail(`Invalid review label on line ${index + 1} of ${path}`);
    return value;
  });
  return { labels, meta: null };
}

const review = loadReview(labelsPath);
const labelById = new Map<string, ReviewLabel>();
for (const label of review.labels) {
  if (labelById.has(label.channelId)) fail(`Duplicate review label for ${label.channelId}`);
  labelById.set(label.channelId, label);
}

let sealReport: Record<string, unknown> | null = null;
if (sealPath) {
  const seal = JSON.parse(readFileSync(sealPath, 'utf8')) as { sealedAt?: string; files?: Record<string, { sha256?: string; bytes?: number }> };
  const labelsHash = sha256File(labelsPath);
  const expected = seal.files?.[basename(labelsPath)]?.sha256;
  if (!expected) fail(`Seal ${sealPath} does not contain a hash for ${basename(labelsPath)}`);
  if (expected !== labelsHash) fail(`Sealed review labels changed: expected ${expected}, got ${labelsHash}`);
  const evidencePath = argValue('evidence');
  if (evidencePath) {
    const evidenceHash = sha256File(evidencePath);
    const expectedEvidence = seal.files?.[basename(evidencePath)]?.sha256;
    if (!expectedEvidence) fail(`Seal ${sealPath} does not contain a hash for ${basename(evidencePath)}`);
    if (expectedEvidence !== evidenceHash) fail(`Sealed evidence changed: expected ${expectedEvidence}, got ${evidenceHash}`);
  }
  sealReport = { path: sealPath, sealedAt: seal.sealedAt || null, labelsSha256: labelsHash, verified: true };
}

const rawRows = readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as any);
if (rawRows.length === 0) fail(`No admission results in ${resultsPath}`);
const rows: Row[] = rawRows.map(raw => {
  const channelId = String(raw.channel?.channelId || '');
  const reviewed = labelById.get(channelId);
  const label = (reviewed?.label || 'UNKNOWN_EVIDENCE') as Label;
  return {
    channelId,
    channelName: String(raw.channel?.channelName || channelId),
    group: raw.group,
    prior: raw.prior?.decision,
    decision: String(raw.final?.decision || 'NONE'),
    deterministic: raw.deterministic?.outcome,
    label,
    language: reviewed?.language || 'UNKNOWN',
    note: reviewed?.note,
    positive: expectedAdmit.has(label),
  };
});

const missing = rows.filter(row => !labelById.has(row.channelId)).map(row => `${row.channelName} (${row.channelId})`);
if (missing.length) fail(`Review labels are missing for ${missing.length} result channel(s): ${missing.join(', ')}`);
const unresolved = rows.filter(row => unresolvedLabels.has(row.label));
const scored = rows.filter(row => !unresolvedLabels.has(row.label));

function confusion(
  actualPositive: (row: Row) => boolean,
  predictedPositive: (row: Row) => boolean,
  scope: Row[] = scored,
): Confusion {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0; let undecided = 0;
  for (const row of scope) {
    if (!terminal.has(row.decision)) { undecided += 1; continue; }
    const actual = actualPositive(row);
    const predicted = predictedPositive(row);
    if (actual && predicted) tp += 1;
    else if (actual) fn += 1;
    else if (predicted) fp += 1;
    else tn += 1;
  }
  return { tp, fp, fn, tn, decided: tp + fp + fn + tn, undecided };
}

const anyAdmit = (row: Row) => row.decision === 'ADMIT' || row.decision === 'ADMIT_AMBIGUOUS';
const strictAdmit = (row: Row) => row.decision === 'ADMIT';

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function wilson(successes: number, total: number, z = 1.96): Interval | null {
  if (total <= 0) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin), n: total };
}

function f1From(c: Confusion): number | null {
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  if (precision === null || recall === null || precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

function mulberry32(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedNumber(value: string): number {
  const digest = createHash('sha256').update(value).digest();
  return digest.readUInt32LE(0);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function bootstrapF1(
  actualPositive: (row: Row) => boolean,
  predictedPositive: (row: Row) => boolean,
  scope: Row[],
  key: string,
): Interval | null {
  const usable = scope.filter(row => terminal.has(row.decision));
  if (usable.length === 0) return null;
  const random = mulberry32(seedNumber(`${seed}:${key}:${scope.length}`));
  const values: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let tp = 0; let fp = 0; let fn = 0; let tn = 0;
    for (let j = 0; j < usable.length; j += 1) {
      const row = usable[Math.floor(random() * usable.length)];
      const actual = actualPositive(row);
      const predicted = predictedPositive(row);
      if (actual && predicted) tp += 1;
      else if (actual) fn += 1;
      else if (predicted) fp += 1;
      else tn += 1;
    }
    const value = f1From({ tp, fp, fn, tn, decided: usable.length, undecided: 0 });
    if (value !== null) values.push(value);
  }
  const low = percentile(values, 0.025);
  const high = percentile(values, 0.975);
  if (low === null || high === null) return null;
  return { low, high, n: usable.length };
}

function metrics(
  actualPositive: (row: Row) => boolean,
  predictedPositive: (row: Row) => boolean,
  scope: Row[] = scored,
  key = 'overall',
) {
  const c = confusion(actualPositive, predictedPositive, scope);
  const decidedRows = scope.filter(row => terminal.has(row.decision));
  const admittedRows = decidedRows.filter(row => anyAdmit(row));
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  const f1 = f1From(c);
  const specificity = ratio(c.tn, c.tn + c.fp);
  const accuracy = ratio(c.tp + c.tn, c.decided);
  return {
    n: scope.length,
    scored: scope.length - scope.filter(row => unresolvedLabels.has(row.label)).length,
    decided: c.decided,
    undecided: c.undecided,
    coverage: scope.length ? c.decided / scope.length : null,
    confusion: c,
    precision,
    precisionCI: wilson(c.tp, c.tp + c.fp),
    recall,
    recallCI: wilson(c.tp, c.tp + c.fn),
    f1,
    f1CI: bootstrapF1(actualPositive, predictedPositive, scope, key),
    specificity,
    specificityCI: wilson(c.tn, c.tn + c.fp),
    accuracy,
    accuracyCI: wilson(c.tp + c.tn, c.decided),
    admitRate: decidedRows.length ? admittedRows.length / decidedRows.length : null,
    admitRateCI: wilson(admittedRows.length, decidedRows.length),
  };
}

function round(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(6));
}

function compactMetric(value: ReturnType<typeof metrics>) {
  return {
    ...value,
    precision: round(value.precision),
    recall: round(value.recall),
    f1: round(value.f1),
    specificity: round(value.specificity),
    accuracy: round(value.accuracy),
    admitRate: round(value.admitRate),
    coverage: round(value.coverage),
    precisionCI: value.precisionCI ? { low: round(value.precisionCI.low), high: round(value.precisionCI.high), n: value.precisionCI.n } : null,
    recallCI: value.recallCI ? { low: round(value.recallCI.low), high: round(value.recallCI.high), n: value.recallCI.n } : null,
    f1CI: value.f1CI ? { low: round(value.f1CI.low), high: round(value.f1CI.high), n: value.f1CI.n } : null,
    specificityCI: value.specificityCI ? { low: round(value.specificityCI.low), high: round(value.specificityCI.high), n: value.specificityCI.n } : null,
    accuracyCI: value.accuracyCI ? { low: round(value.accuracyCI.low), high: round(value.accuracyCI.high), n: value.accuracyCI.n } : null,
    admitRateCI: value.admitRateCI ? { low: round(value.admitRateCI.low), high: round(value.admitRateCI.high), n: value.admitRateCI.n } : null,
  };
}

function groupBy(
  scope: Row[],
  key: (row: Row) => string,
  actualPositive: (row: Row, group: string) => boolean = row => row.positive,
  predictedPositive: (row: Row, group: string) => boolean = row => anyAdmit(row),
): Record<string, ReturnType<typeof metrics>> {
  const groups = new Map<string, Row[]>();
  for (const row of scope) {
    const value = key(row) || 'UNKNOWN';
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)!.push(row);
  }
  return Object.fromEntries([...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, group]) => [name, compactMetric(metrics(
      row => actualPositive(row, name),
      row => predictedPositive(row, name),
      group,
      `${name}`,
    ))]));
}

const any = compactMetric(metrics(row => row.positive, anyAdmit, scored, 'overall'));
const strict = compactMetric(metrics(row => row.positive, strictAdmit, scored, 'strict'));
const deterministicRows = scored.filter(row => row.deterministic === 'PASS' || row.deterministic === 'REJECT');
const deterministicMetrics = (() => {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0, decided: 0, undecided: 0 };
  for (const row of deterministicRows) {
    const predictedPositive = row.deterministic === 'PASS';
    if (row.positive && predictedPositive) c.tp += 1;
    else if (row.positive) c.fn += 1;
    else if (predictedPositive) c.fp += 1;
    else c.tn += 1;
    c.decided += 1;
  }
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  return {
    n: scored.length,
    decided: c.decided,
    coverage: scored.length ? c.decided / scored.length : null,
    confusion: c,
    precision: round(precision),
    precisionCI: wilson(c.tp, c.tp + c.fp),
    recall: round(recall),
    recallCI: wilson(c.tp, c.tp + c.fn),
    f1: round(f1From(c)),
    specificity: round(ratio(c.tn, c.tn + c.fp)),
  };
})();

const decisions = rows.reduce((acc, row) => ({ ...acc, [row.decision]: (acc[row.decision] || 0) + 1 }), {} as Record<string, number>);
const labels = scored.reduce((acc, row) => ({ ...acc, [row.label]: (acc[row.label] || 0) + 1 }), {} as Record<string, number>);
const languages = scored.reduce((acc, row) => ({ ...acc, [row.language]: (acc[row.language] || 0) + 1 }), {} as Record<string, number>);
const errors = scored
  .filter(row => terminal.has(row.decision) && ((row.positive && !anyAdmit(row)) || (!row.positive && anyAdmit(row))))
  .map(row => ({
    channelId: row.channelId,
    channelName: row.channelName,
    language: row.language,
    label: row.label,
    decision: row.decision,
    deterministic: row.deterministic || null,
    prior: row.prior || null,
    note: row.note || null,
    error: row.positive ? 'FALSE_NEGATIVE' : 'FALSE_POSITIVE',
  }));

const report = {
  event: 'admission_cohort_summary',
  resultsPath,
  labelsPath,
  seal: sealReport,
  labelProvenance: review.meta,
  corrections: correctionsPath ? JSON.parse(readFileSync(correctionsPath, 'utf8')) : null,
  total: rows.length,
  scored: scored.length,
  unresolvedLabels: unresolved.length,
  labels,
  languages,
  decisions,
  positiveClass: 'TRADING + FINANCE_ADJACENT',
  negativeClass: 'UNRELATED',
  pendingPolicy: 'Rows without ADMIT/ADMIT_AMBIGUOUS/REJECT_UNRELATED are excluded from precision/recall/F1 and reported as undecided.',
  finalAnyAdmit: any,
  finalStrictAdmit: strict,
  deterministic: deterministicMetrics,
  byCategory: groupBy(
    scored,
    row => row.label,
    (row, category) => category === 'UNRELATED' ? row.label === 'UNRELATED' : row.label === category,
    (row, category) => category === 'UNRELATED' ? row.decision === 'REJECT_UNRELATED' : anyAdmit(row),
  ),
  byLanguage: groupBy(scored, row => row.language),
  byPriorGroup: groupBy(scored, row => row.prior || row.group || 'UNKNOWN'),
  errors,
  generatedAt: new Date().toISOString(),
};

const json = JSON.stringify(report, null, 2);
console.log(json);
const jsonOut = argValue('json-out');
if (jsonOut) writeFileSync(jsonOut, `${json}\n`);

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}
function ci(value: Interval | null | undefined): string {
  return value ? `${(value.low * 100).toFixed(1)}–${(value.high * 100).toFixed(1)}%` : 'n/a';
}
function table(title: string, groups: Record<string, ReturnType<typeof metrics>>): string {
  const lines = [`### ${title}`, '', '| Group | n | Decided | Admit rate (95% CI) | Precision (95% CI) | Recall (95% CI) | F1 (95% CI) | Correct rate |', '|---|---:|---:|---|---|---|---|---:|'];
  for (const [name, value] of Object.entries(groups)) {
    lines.push(`| ${name} | ${value.n} | ${value.decided} | ${pct(value.admitRate)} (${ci(value.admitRateCI)}) | ${pct(value.precision)} (${ci(value.precisionCI)}) | ${pct(value.recall)} (${ci(value.recallCI)}) | ${pct(value.f1)} (${ci(value.f1CI)}) | ${pct(value.accuracy)} |`);
  }
  return `${lines.join('\n')}\n`;
}
const md = [
  '# Admission cohort validation summary',
  '',
  `- Results: \`${resultsPath}\``,
  `- Labels: \`${labelsPath}\``,
  `- Sealed: ${sealReport ? `yes (${String(sealReport.sealedAt)})` : 'no'}`,
  `- Channels: ${rows.length}; scored: ${scored.length}; unresolved labels: ${unresolved.length}`,
  `- Labels: ${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(', ')}`,
  '',
  '## Headline metrics (admit = ADMIT + ADMIT_AMBIGUOUS)',
  '',
  `- Precision: **${pct(any.precision)}** (95% CI ${ci(any.precisionCI)})`,
  `- Recall: **${pct(any.recall)}** (95% CI ${ci(any.recallCI)})`,
  `- F1: **${pct(any.f1)}** (95% bootstrap CI ${ci(any.f1CI)})`,
  `- Reject recall (specificity): **${pct(any.specificity)}** (95% CI ${ci(any.specificityCI)})`,
  `- Accuracy among decided: **${pct(any.accuracy)}** (95% CI ${ci(any.accuracyCI)})`,
  `- Decided: ${any.decided}/${any.n}; undecided/pending: ${any.undecided}`,
  '',
  '## Confusion matrix',
  '',
  '| | Predicted admit | Predicted reject |',
  '|---|---:|---:|',
  `| Actually trading/finance | TP ${any.confusion.tp} | FN ${any.confusion.fn} |`,
  `| Actually unrelated | FP ${any.confusion.fp} | TN ${any.confusion.tn} |`,
  '',
  `## Strict ADMIT-only operating point`,
  '',
  `- Precision: ${pct(strict.precision)} (95% CI ${ci(strict.precisionCI)})`,
  `- Recall: ${pct(strict.recall)} (95% CI ${ci(strict.recallCI)})`,
  `- F1: ${pct(strict.f1)} (95% bootstrap CI ${ci(strict.f1CI)})`,
  `- Decided: ${strict.decided}/${strict.n}`,
  '',
  table('By category (review label)', report.byCategory),
  table('By language', report.byLanguage),
  table('By prior outcome group', report.byPriorGroup),
  '## Misclassifications',
  '',
  errors.length
    ? ['| Channel | Language | Label | Decision | Error | Note |', '|---|---|---|---|---|---|', ...errors.map(e => `| ${e.channelName} | ${e.language} | ${e.label} | ${e.decision} | ${e.error} | ${(e.note || '').replace(/\|/g, '/')} |`)].join('\n')
    : 'None.',
  '',
].join('\n');
const mdOut = argValue('md-out');
if (mdOut) writeFileSync(mdOut, md);
