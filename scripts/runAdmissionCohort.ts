/**
 * Read-only admission cohort runner.
 *
 * Selects a reproducible stratified sample from the preserved 890-row result
 * file, fetches fresh public YouTube evidence without API keys (InnerTube about
 * page + channel RSS), runs the deterministic-first admission stage, and
 * optionally runs the semantic fallback when Gemini/Groq keys are configured.
 *
 * It never writes candidates, decisions, channels, settings or jobs.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { Innertube } from 'youtubei.js';
import { evaluateDeterministicAdmission } from '../server/channelAdmission/deterministic';
import { decideAdmission, normalizeSemanticJudgment } from '../server/channelAdmission/policy';
import { buildAdmissionPrompt, isSemanticDecisionFailure, needsSecondJudge, type AdmissionJudge } from '../server/channelAdmission/semanticJudge';
import type { AdmissionEvidence, SemanticJudgment } from '../server/channelAdmission/types';
import {
  DEFAULT_MULTILINGUAL_CANDIDATE_MODEL,
  defaultClient as geminiDefaultClient,
} from '../server/evidenceEngine/providers/GeminiSemanticProvider';
import {
  DEFAULT_GEMINI_FREE_CANDIDATE_MODEL,
  defaultClient as geminiFreeDefaultClient,
} from '../server/evidenceEngine/providers/GeminiFreeSemanticProvider';
import {
  DEFAULT_GROQ_CANDIDATE_MODEL,
  defaultClient as groqDefaultClient,
} from '../server/evidenceEngine/providers/GroqSemanticProvider';
import type { SemanticModelClient } from '../server/evidenceEngine/providers/GeminiSemanticProvider';

interface PreservedResult {
  channelId: string;
  channelName: string;
  decision: string;
  status: string;
  reasonCodes?: string[];
}

type CohortGroup = 'trading' | 'unrelated' | 'ambiguous' | 'held';

const GROUP_ORDER: CohortGroup[] = ['trading', 'unrelated', 'ambiguous', 'held'];

function argValue(name: string): string | undefined {
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function callJudgeWithPacing(
  judge: AdmissionJudge,
  evidence: AdmissionEvidence,
  role: 'PRIMARY' | 'SECOND',
  delayMs: number,
  retries: number,
): Promise<SemanticJudgment> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const judgment = await judge.judge(evidence, role);
      await sleep(delayMs);
      return judgment;
    } catch (error) {
      lastError = error;
      if (isSemanticDecisionFailure(error)) throw error;
      const retryAfter = Number((error as { retryAfterMs?: unknown })?.retryAfterMs || 0);
      const waitMs = Math.min(120_000, Math.max(delayMs, retryAfter));
      // One delay per failure: preserve provider pressure before either the
      // retry or the next candidate starts.
      await sleep(waitMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ADMISSION_SEMANTIC_UNAVAILABLE');
}

function argNumber(name: string, fallback: number): number {
  const value = Number(argValue(name));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function argNonNegative(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_${name.replace(/-/g, '_').toUpperCase()}`);
  return Math.floor(value);
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function textBetween(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function groupOf(row: PreservedResult): CohortGroup | null {
  if (row.decision === 'ADMIT') return 'trading';
  if (row.decision === 'REJECT_UNRELATED') return 'unrelated';
  if (row.decision === 'ADMIT_AMBIGUOUS') return 'ambiguous';
  if (row.decision === 'HOLD_MISSING_EVIDENCE') return 'held';
  return null;
}

function selectCohort(rows: PreservedResult[], counts: Record<CohortGroup, number>, seed: string): Array<{ group: CohortGroup; row: PreservedResult }> {
  const buckets = new Map<CohortGroup, PreservedResult[]>();
  for (const group of GROUP_ORDER) buckets.set(group, []);
  for (const row of rows) {
    const group = groupOf(row);
    if (group) buckets.get(group)!.push(row);
  }
  const selected: Array<{ group: CohortGroup; row: PreservedResult }> = [];
  const seen = new Set<string>();
  for (const group of GROUP_ORDER) {
    const uniqueBucket = [...new Map(buckets.get(group)!.map(row => [row.channelId, row])).values()];
    const bucket = uniqueBucket
      .filter(row => !seen.has(row.channelId))
      .sort((a, b) => sha(`${seed}:${a.channelId}`).localeCompare(sha(`${seed}:${b.channelId}`)));
    for (const row of bucket.slice(0, counts[group])) {
      seen.add(row.channelId);
      selected.push({ group, row });
    }
  }
  return selected;
}

function youtubeUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

async function fetchRssVideos(channelId: string): Promise<AdmissionEvidence['videos']> {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(match => match[1]);
  return entries.map(entry => {
    const title = textBetween(entry, 'title');
    const description = textBetween(entry, 'media:description');
    const publishedAt = textBetween(entry, 'published') || undefined;
    return { title, description, publishedAt };
  }).filter(video => video.title.trim().length > 0).slice(0, 15);
}

interface ChannelAbout {
  name?: string;
  description: string;
  links: string[];
  country?: string;
  subscriberCount?: string;
}

function normalizeLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const links: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item)) links.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    for (const key of ['url', 'link', 'target', 'canonical_url']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
        links.push(candidate);
        break;
      }
    }
  }
  return [...new Set(links)];
}

async function collectKeylessEvidence(input: {
  channelId: string;
  channelName: string;
  session: Innertube;
}): Promise<AdmissionEvidence> {
  const { channelId, channelName, session } = input;
  const about: ChannelAbout = { description: '', links: [] };
  let resolvedName = channelName;
  try {
    const channel: any = await session.getChannel(channelId);
    resolvedName = String(channel?.metadata?.title || channelName || '');
    try {
      const aboutInfo: any = await channel.getAbout();
      const metadata = aboutInfo?.metadata || {};
      about.description = String(metadata.description || '').trim();
      about.links = normalizeLinks(metadata.links);
      about.country = metadata.country ? String(metadata.country).trim().toUpperCase() : undefined;
      about.subscriberCount = metadata.subscriber_count ? String(metadata.subscriber_count) : undefined;
    } catch {
      // About is optional; RSS video evidence below is still authoritative.
    }
  } catch {
    // Keep the manifest name and continue to RSS.
  }

  let videos: AdmissionEvidence['videos'] = [];
  let rssFailure: string | undefined;
  try {
    videos = await fetchRssVideos(channelId);
  } catch (error) {
    rssFailure = error instanceof Error ? error.message : String(error);
  }

  const complete = !rssFailure && (about.description.length > 0 || videos.length > 0);
  return {
    channelId,
    channelName: resolvedName,
    youtubeUrl: youtubeUrl(channelId),
    description: about.description,
    links: about.links,
    country: about.country,
    subscriberCount: about.subscriberCount,
    videos,
    matchedDocument: undefined,
    source: 'automated_query',
    targetCountry: 'UNKNOWN',
    evidenceCoverage: complete ? 'COMPLETE' : 'PARTIAL',
    fetchedAt: new Date().toISOString(),
    failureReason: rssFailure
      ? (complete ? `RSS_UNAVAILABLE:${rssFailure}` : rssFailure)
      : (complete ? undefined : 'NO_CREATOR_TEXT_AVAILABLE'),
  };
}

class CohortJudge implements AdmissionJudge {
  constructor(
    private readonly clients: Array<{ client: SemanticModelClient; model: string; provider?: 'gemini_semantic' | 'gemini_free_semantic' | 'groq_semantic' }>,
  ) {}

  async judge(evidence: AdmissionEvidence, role: 'PRIMARY' | 'SECOND'): Promise<SemanticJudgment> {
    const ordered = role === 'PRIMARY' ? this.clients : [...this.clients].reverse();
    let lastError: unknown;
    for (const attempt of ordered) {
      try {
        const raw = await attempt.client.classify(buildAdmissionPrompt(evidence, role), attempt.model, {});
        const normalized = normalizeSemanticJudgment(raw, attempt.model);
        if (!normalized) throw new Error('ADMISSION_SEMANTIC_INVALID_OUTPUT');
        if (attempt.provider) normalized.provider = attempt.provider;
        return normalized;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('ADMISSION_SEMANTIC_UNAVAILABLE');
  }
}

function semanticClientsAllowedToWriteTelemetry(): boolean {
  const raw = String(process.env.DATABASE_URL || '');
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Provider clients append call events through getDb(), which can apply
  // migrations. Only permit that against an explicitly disposable/local test
  // database; never let a read-only cohort assessment touch production.
  if (['host', 'hostaddr', 'port', 'dbname', 'user', 'password'].some(key => url.searchParams.has(key))) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, '')).toLowerCase();
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const named = /(^|[-_.])(staging|stage|test|disposable|e2e)([-_.]|$)/i.test(database)
    || /(^|[-_.])(staging|stage|test|disposable|e2e)([-_.]|$)/i.test(host);
  if (!local && !named) return false;
  return (process.env.NODE_ENV === 'test' || process.env.COHORT_ALLOW_SEMANTIC_DB_WRITES === 'true');
}

function configuredJudge(): CohortJudge | null {
  if (!semanticClientsAllowedToWriteTelemetry()) return null;
  const requested = String(process.env.COHORT_SEMANTIC_PROVIDER || 'auto').trim().toLowerCase();
  if (!['auto', 'gemini', 'gemini-free', 'groq'].includes(requested)) {
    throw new Error('INVALID_COHORT_SEMANTIC_PROVIDER');
  }
  const clients: Array<{ client: SemanticModelClient; model: string; provider?: 'gemini_semantic' | 'gemini_free_semantic' | 'groq_semantic' }> = [];
  if (requested === 'auto' || requested === 'gemini') {
    const gemini = geminiDefaultClient();
    if (gemini) clients.push({ client: gemini, model: process.env.ADMISSION_PRIMARY_MODEL || DEFAULT_MULTILINGUAL_CANDIDATE_MODEL, provider: 'gemini_semantic' });
  }
  if (requested === 'auto' || requested === 'gemini-free') {
    const geminiFree = geminiFreeDefaultClient();
    if (geminiFree) clients.push({ client: geminiFree, model: process.env.GEMINI_FREE_CANDIDATE_MODEL || DEFAULT_GEMINI_FREE_CANDIDATE_MODEL, provider: 'gemini_free_semantic' });
  }
  if (requested === 'auto' || requested === 'groq') {
    const groq = groqDefaultClient();
    if (groq) clients.push({ client: groq, model: process.env.ADMISSION_SECONDARY_MODEL || DEFAULT_GROQ_CANDIDATE_MODEL, provider: 'groq_semantic' });
  }
  return clients.length ? new CohortJudge(clients) : null;
}

function resultFromPolicy(evidence: AdmissionEvidence, policy: ReturnType<typeof decideAdmission>, source: 'SEMANTIC'): Record<string, unknown> {
  return {
    source,
    decision: policy.decision,
    status: policy.status,
    reasonCodes: policy.reasonCodes,
    admitted: policy.admitted,
    rejected: policy.rejected,
    review: policy.review === true,
    ambiguous: policy.ambiguous,
    citationsValid: policy.citationsValid,
    independentUnrelatedCitations: policy.independentUnrelatedCitations,
    independentTradingCitations: policy.independentTradingCitations,
  };
}

async function evaluateOne(input: {
  group: CohortGroup;
  row: PreservedResult;
  session?: Innertube;
  judge: CohortJudge | null;
  evidenceOverride?: AdmissionEvidence;
  aiDelayMs: number;
  aiRetries: number;
}): Promise<Record<string, unknown>> {
  const evidence = input.evidenceOverride || await collectKeylessEvidence({
    channelId: input.row.channelId,
    channelName: input.row.channelName,
    session: input.session!,
  });
  const base = {
    event: 'admission_cohort_result',
    group: input.group,
    prior: { decision: input.row.decision, status: input.row.status, reasonCodes: input.row.reasonCodes || [] },
    channel: {
      channelId: evidence.channelId,
      channelName: evidence.channelName,
      youtubeUrl: evidence.youtubeUrl,
      country: evidence.country || null,
      subscriberCount: evidence.subscriberCount || null,
    },
    evidence: {
      coverage: evidence.evidenceCoverage,
      failureReason: evidence.failureReason || null,
      description: evidence.description,
      links: evidence.links,
      videos: evidence.videos,
    },
  };
  if (evidence.evidenceCoverage !== 'COMPLETE') {
    return {
      ...base,
      deterministic: null,
      final: {
        decision: 'HOLD_MISSING_EVIDENCE',
        status: 'WAITING_EVIDENCE',
        reasonCodes: ['EVIDENCE_INCOMPLETE', evidence.failureReason || 'EVIDENCE_PARTIAL'],
        source: 'EVIDENCE',
      },
    };
  }

  const deterministic = await evaluateDeterministicAdmission(evidence);
  const deterministicSummary = {
    outcome: deterministic.outcome,
    route: deterministic.route,
    confidence: deterministic.confidence,
    reasonCodes: deterministic.reasonCodes,
    citations: deterministic.citations,
  };
  if (deterministic.outcome === 'PASS' && deterministic.judgment) {
    return {
      ...base,
      deterministic: deterministicSummary,
      final: {
        source: 'DETERMINISTIC',
        decision: 'ADMIT',
        status: 'ADMITTED',
        reasonCodes: deterministic.reasonCodes,
        admitted: true,
        rejected: false,
        review: false,
        ambiguous: false,
        citationsValid: deterministic.citations.length > 0,
        citations: deterministic.citations,
        judgment: deterministic.judgment,
      },
    };
  }
  if (deterministic.outcome === 'REJECT' && deterministic.judgment) {
    return {
      ...base,
      deterministic: deterministicSummary,
      final: {
        source: 'DETERMINISTIC',
        decision: 'REJECT_UNRELATED',
        status: 'REJECTED_UNRELATED',
        reasonCodes: deterministic.reasonCodes,
        admitted: false,
        rejected: true,
        review: false,
        ambiguous: false,
        citationsValid: true,
        citations: deterministic.citations,
        judgment: deterministic.judgment,
      },
    };
  }

  if (!input.judge) {
    return {
      ...base,
      deterministic: deterministicSummary,
      final: {
        source: 'NONE',
        decision: 'AI_UNAVAILABLE',
        status: 'AI_UNAVAILABLE',
        reasonCodes: ['NO_SEMANTIC_PROVIDER_CONFIGURED', ...deterministic.reasonCodes],
        admitted: false,
        rejected: false,
        review: false,
        ambiguous: true,
      },
    };
  }

  let judgment: SemanticJudgment | undefined;
  let decisionFailure: string | undefined;
  for (let attempt = 0; attempt < 3 && !judgment; attempt += 1) {
    try {
      judgment = await callJudgeWithPacing(input.judge, evidence, 'PRIMARY', input.aiDelayMs, input.aiRetries);
    } catch (error) {
      if (isSemanticDecisionFailure(error)) {
        decisionFailure = error instanceof Error ? error.message : String(error);
        continue;
      }
      return {
        ...base,
        deterministic: deterministicSummary,
        final: {
          source: 'SEMANTIC',
          decision: 'PROVIDER_DEFERRED',
          status: 'PROVIDER_DEFERRED',
          reasonCodes: ['PROVIDER_RETRY_WITHOUT_ATTEMPT', 'SEMANTIC_UNAVAILABLE_RETRY', error instanceof Error ? error.message : String(error)],
          admitted: false,
          rejected: false,
          review: false,
          ambiguous: true,
        },
      };
    }
  }
  if (!judgment) {
    return {
      ...base,
      deterministic: deterministicSummary,
      final: {
        source: 'SEMANTIC',
        decision: 'NEEDS_REVIEW',
        status: 'NEEDS_REVIEW',
        reasonCodes: ['SEMANTIC_UNRESOLVED_NEEDS_REVIEW', decisionFailure || 'ADMISSION_SEMANTIC_INVALID_OUTPUT'],
        admitted: false,
        rejected: false,
        review: true,
        ambiguous: false,
      },
    };
  }

  let secondJudgment: SemanticJudgment | undefined;
  if (needsSecondJudge(judgment, evidence)) {
    try {
      secondJudgment = await callJudgeWithPacing(input.judge, evidence, 'SECOND', input.aiDelayMs, input.aiRetries);
    } catch (error) {
      console.warn(`[cohort] second judge unavailable for ${evidence.channelId}:`, error instanceof Error ? error.message : error);
    }
  }
  const policy = decideAdmission({ evidence, judgment, secondJudgment });
  const effective = policy.effectiveRole === 'SECOND' && secondJudgment ? secondJudgment : judgment;
  return {
    ...base,
    deterministic: deterministicSummary,
    final: {
      ...resultFromPolicy(evidence, policy, 'SEMANTIC'),
      citations: effective.citations,
      judgment: effective,
      secondJudgment: secondJudgment || null,
    },
  };
}

async function main(): Promise<void> {
  const manifest = argValue('manifest') || '/tmp/opencode/admission-890-partial.jsonl';
  const output = argValue('out') || '/tmp/opencode/admission-cohort-60.jsonl';
  const blind = argValue('blind') || '/tmp/opencode/admission-cohort-60-blind.jsonl';
  const seed = argValue('seed') || 'admission-cohort-v1';
  const collectOnly = process.argv.includes('--collect-only');
  const resume = process.argv.includes('--resume');
  const semanticConcurrency = Math.max(1, Math.min(4, argNumber('semantic-concurrency', 1)));
  const counts: Record<CohortGroup, number> = {
    trading: argNumber('trading', 20),
    unrelated: argNumber('unrelated', 20),
    ambiguous: argNumber('ambiguous', 10),
    held: argNumber('held', 10),
  };
  const requestedConcurrency = Math.max(1, Math.min(4, argNumber('concurrency', 2)));
  const aiDelayMs = argNonNegative('ai-delay-ms', 0);
  const aiRetries = argNonNegative('ai-retries', 0);
  const fromEvidence = argValue('from-evidence');
  const rows = readFileSync(manifest, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as PreservedResult);
  const cohort: Array<{ group: CohortGroup; row: PreservedResult; evidence?: AdmissionEvidence }> = fromEvidence
    ? readFileSync(fromEvidence, 'utf8').trim().split('\n').filter(Boolean).map(line => {
      const saved = JSON.parse(line) as any;
      return {
        group: saved.group as CohortGroup,
        row: {
          channelId: saved.channel?.channelId,
          channelName: saved.channel?.channelName,
          decision: saved.prior?.decision,
          status: saved.prior?.status,
          reasonCodes: saved.prior?.reasonCodes || [],
        } as PreservedResult,
        evidence: saved.evidence ? {
          channelId: saved.channel.channelId,
          channelName: saved.channel.channelName,
          youtubeUrl: saved.channel.youtubeUrl,
          description: saved.evidence.description || '',
          links: saved.evidence.links || [],
          country: saved.channel.country || saved.evidence.country || undefined,
          subscriberCount: saved.channel.subscriberCount || saved.evidence.subscriberCount || undefined,
          videos: saved.evidence.videos || [],
          source: 'automated_query',
          targetCountry: 'UNKNOWN',
          evidenceCoverage: saved.evidence.evidenceCoverage || saved.evidence.coverage || 'PARTIAL',
          failureReason: saved.evidence.failureReason || undefined,
          fetchedAt: new Date().toISOString(),
        } : undefined,
      };
    }) as Array<{ group: CohortGroup; row: PreservedResult; evidence?: AdmissionEvidence }>
    : selectCohort(rows, counts, seed);
  const judge = collectOnly ? null : configuredJudge();
  // Semantic calls share a provider quota. Serialize them whenever pacing is
  // configured so two workers cannot burst the same organization.
  const concurrency = judge ? semanticConcurrency : requestedConcurrency;
  console.log(JSON.stringify({
    event: 'admission_cohort_start',
    manifest,
    selected: cohort.length,
    counts,
    seed,
    concurrency,
    semanticAvailable: Boolean(judge),
    collectOnly,
    resume,
    semanticConcurrency,
    aiDelayMs,
    aiRetries,
    fromEvidence: fromEvidence || null,
    groups: GROUP_ORDER.reduce((acc, group) => ({ ...acc, [group]: cohort.filter(item => item.group === group).length }), {}),
    timestamp: new Date().toISOString(),
  }));

  const existingResults: Array<Record<string, unknown>> = [];
  if (resume && existsSync(output)) {
    for (const line of readFileSync(output, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        existingResults.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A killed process may leave one partial trailing line. Ignore it and
        // re-evaluate that channel; every complete line is durable.
      }
    }
  } else {
    for (const path of [output, blind]) {
      if (existsSync(path)) rmSync(path);
      writeFileSync(path, '');
    }
  }
  const completedIds = new Set(existingResults.map(result => (result.channel as any)?.channelId).filter(Boolean));
  const pending = cohort.filter(item => !completedIds.has(item.row.channelId));
  if (resume) {
    console.log(JSON.stringify({
      event: 'admission_cohort_resume',
      existing: existingResults.length,
      pending: pending.length,
      output,
      timestamp: new Date().toISOString(),
    }));
  }

  let cursor = 0;
  let completed = existingResults.length;
  const results: Array<Record<string, unknown>> = [...existingResults];
  const workers = Array.from({ length: concurrency }, async () => {
    const session = fromEvidence ? undefined : await Innertube.create({ retrieve_player: false } as any);
    for (;;) {
      const index = cursor++;
      if (index >= pending.length) return;
      const item = pending[index];
      let result: Record<string, unknown>;
      try {
        result = collectOnly
          ? {
            event: 'admission_cohort_evidence',
            group: item.group,
            prior: { decision: item.row.decision, status: item.row.status, reasonCodes: item.row.reasonCodes || [] },
            channel: {
              channelId: item.row.channelId,
              channelName: item.row.channelName,
              youtubeUrl: youtubeUrl(item.row.channelId),
            },
            evidence: await collectKeylessEvidence({
              channelId: item.row.channelId,
              channelName: item.row.channelName,
              session: session!,
            }),
          }
          : await evaluateOne({
          group: item.group,
          row: item.row,
          session,
          judge,
          evidenceOverride: item.evidence,
          aiDelayMs,
          aiRetries,
        });
      } catch (error) {
        result = {
          event: 'admission_cohort_result',
          group: item.group,
          prior: item.row,
          channel: { channelId: item.row.channelId, channelName: item.row.channelName, youtubeUrl: youtubeUrl(item.row.channelId) },
          evidence: null,
          deterministic: null,
          final: {
            decision: 'COHORT_FETCH_FAILED',
            status: 'COHORT_FETCH_FAILED',
            reasonCodes: [error instanceof Error ? error.message : String(error)],
          },
        };
      }
      results.push(result);
      appendFileSync(output, `${JSON.stringify(result)}\n`);
      const evidence = result.evidence as any;
      const final = result.final as any;
      appendFileSync(blind, `${JSON.stringify({
        channelId: item.row.channelId,
        channelName: item.row.channelName,
        youtubeUrl: youtubeUrl(item.row.channelId),
        description: evidence?.description || '',
        links: evidence?.links || [],
        videos: evidence?.videos || [],
        coverage: evidence?.evidenceCoverage || evidence?.coverage || 'UNKNOWN',
      })}\n`);
      completed += 1;
      console.log(JSON.stringify({
        event: 'admission_cohort_progress',
        completed,
        total: cohort.length,
        channelId: item.row.channelId,
        channelName: item.row.channelName,
        group: item.group,
        prior: item.row.decision,
        deterministic: (result.deterministic as any)?.outcome || null,
        final: final?.decision || null,
      }));
    }
  });
  await Promise.all(workers);
  const usableDecisions = results.filter(result => {
    const decision = (result.final as any)?.decision;
    return ['ADMIT', 'ADMIT_AMBIGUOUS', 'REJECT_UNRELATED'].includes(decision);
  }).length;
  console.log(JSON.stringify({
    event: 'admission_cohort_complete',
    output,
    blind,
    completed,
    usableDecisions,
    timestamp: new Date().toISOString(),
  }));
  if (!collectOnly && (results.length === 0 || usableDecisions === 0)) {
    console.error('Admission cohort produced no usable admission decisions.');
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Admission cohort runner failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
