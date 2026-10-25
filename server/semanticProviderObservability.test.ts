import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GeminiSemanticProvider } from './evidenceEngine/providers/GeminiSemanticProvider';
import { GeminiFreeSemanticProvider } from './evidenceEngine/providers/GeminiFreeSemanticProvider';
import { GroqSemanticProvider } from './evidenceEngine/providers/GroqSemanticProvider';

const input = {
  channel_id: 'channel-1',
  channel_name: 'Example creator',
  description: 'Creator-level description with enough context for semantic classification.',
  video_titles: ['Example recent video'],
  video_descriptions: ['Description one'],
  job_id: 'job-observability-1',
  run_id: 'run-observability-1',
} as any;

const unrelatedResult = {
  label: 'UNRELATED',
  confidence: 96,
  supportedLanguage: true,
  reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
  explanation: 'Sports commentary rather than trading.',
  concepts: ['sports commentary'],
  languages: [{ language: 'en', script: 'Latin', confidence: 100, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }],
};

test('every semantic provider forwards job and run attribution to its model client', async () => {
  for (const Provider of [GeminiSemanticProvider, GeminiFreeSemanticProvider, GroqSemanticProvider]) {
    const seen: unknown[] = [];
    const client = {
      async classify(_prompt: string, _model: string, observability?: unknown) {
        seen.push(observability);
        return unrelatedResult;
      },
    };
    const provider = new Provider(client as any);
    await provider.collectEvidence(input, {} as any);
    assert.deepEqual(seen[0], { jobId: 'job-observability-1', runId: 'run-observability-1' }, Provider.name);
  }
});

test('semantic provider ledger events carry jobId and runId on every provider family', () => {
  const sources = [
    'evidenceEngine/providers/GeminiSemanticProvider.ts',
    'evidenceEngine/providers/GeminiFreeSemanticProvider.ts',
    'evidenceEngine/providers/GroqSemanticProvider.ts',
  ];
  for (const relative of sources) {
    const source = readFileSync(new URL(`./${relative}`, import.meta.url), 'utf8');
    assert.match(source, /jobId: observability\?\.jobId, runId: observability\?\.runId/, relative);
    // The paid provider declares the shared type; the other two import it.
    assert.match(source, /(?:interface|type) SemanticObservabilityContext/, relative);
  }
});

test('the ingestion pipeline maps the active job/run onto the classifier input', () => {
  const pipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  assert.match(pipeline, /job_id:options\?\.jobId\|\|candidate\.discoveryJobId,run_id:options\?\.runId\|\|candidate\.queryRunId/);
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /processChannelThroughPipeline\(enriched[\s\S]{0,240}jobId:job\.id/);
  assert.match(queue, /processDiscoveredChannel\(candidate[\s\S]{0,240}jobId: job\.id/);
});
