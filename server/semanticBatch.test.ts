import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SEMANTIC_BATCH_WINDOW_MS,
  SEMANTIC_BATCH_PROMPT_VERSION,
  SemanticBatchScheduler,
  buildSemanticBatchPrompt,
  isSemanticBatchContainerUsable,
  parseSemanticBatchResponse,
  resetSemanticBatchSchedulerForTests,
  semanticBatchConfig,
} from './evidenceEngine/semanticBatch';
import type { SemanticModelClient } from './evidenceEngine/providers/GeminiSemanticProvider';

function fakeClock() {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    setTimeoutFn: (callback: () => void) => {
      callbacks.push(callback);
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => undefined,
    runAll() {
      while (callbacks.length) callbacks.shift()!();
    },
  };
}

const clientWith = (classify: SemanticModelClient['classify']): SemanticModelClient => ({ batchGroup: 'test', classify });

/** Structurally complete semantic result, as the real parser requires. */
function semanticResult(label: string, citationField = 'channel_title') {
  return {
    label,
    confidence: 88,
    supportedLanguage: true,
    reasonCodes: ['TEST'],
    explanation: `Result for ${label}.`,
    concepts: ['risk'],
    languages: [],
    citations: [{ field: citationField, index: 0 }],
  };
}

function scheduler(clock: ReturnType<typeof fakeClock>) {
  return new SemanticBatchScheduler({
    config: { enabled: true, maxSize: 8, windowMs: 10 },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
}

test('batch config is opt-in, clamps the size safely, and keeps a stage-0-bounded window', () => {
  assert.deepEqual(semanticBatchConfig({} as any), { enabled: false, maxSize: 8, windowMs: 400 });
  assert.equal(DEFAULT_SEMANTIC_BATCH_WINDOW_MS, 400);
  assert.deepEqual(semanticBatchConfig({ SEMANTIC_BATCH_CLASSIFICATION_ENABLED: 'true', SEMANTIC_BATCH_MAX_SIZE: '99', SEMANTIC_BATCH_WINDOW_MS: '99999' } as any), { enabled: true, maxSize: 10, windowMs: 10_000 });
  assert.deepEqual(semanticBatchConfig({ SEMANTIC_BATCH_CLASSIFICATION_ENABLED: 'true', SEMANTIC_BATCH_MAX_SIZE: '1' } as any), { enabled: true, maxSize: 2, windowMs: 400 });
  assert.deepEqual(semanticBatchConfig({ SEMANTIC_BATCH_WINDOW_MS: 'not-a-number' } as any), { enabled: false, maxSize: 8, windowMs: 400 });
});

test('batch prompt declares an array schema with one independent request per channel', () => {
  const prompt = JSON.parse(buildSemanticBatchPrompt([
    JSON.stringify({ task: 'CANDIDATE', channel_name: 'A' }),
    JSON.stringify({ task: 'CANDIDATE', channel_name: 'B' }),
  ]));
  assert.equal(prompt.task, 'BATCH_CLASSIFICATION');
  assert.equal(prompt.promptVersion, SEMANTIC_BATCH_PROMPT_VERSION);
  assert.equal(prompt.inputs.length, 2);
  assert.equal(prompt.inputs[0].index, 0);
  assert.equal(prompt.inputs[1].request.channel_name, 'B');
  assert.ok(prompt.instructions.some((instruction: string) => /exactly one result object per input/.test(instruction)));
  assert.ok(prompt.instructions.some((instruction: string) => /Never merge evidence/.test(instruction)));
});

test('batch response aligns by explicit index and leaves missing entries undefined', () => {
  const parsed = parseSemanticBatchResponse({ results: [{ index: 1, label: 'B' }, { index: 0, label: 'A' }] }, 3);
  assert.equal((parsed[0] as any)?.label, 'A');
  assert.equal((parsed[1] as any)?.label, 'B');
  assert.equal(parsed[2], undefined);
  assert.deepEqual(parseSemanticBatchResponse(null, 2), [undefined, undefined]);
});

test('only a non-empty array container is usable as a whole batch response', () => {
  assert.equal(isSemanticBatchContainerUsable({ results: [semanticResult('UNRELATED')] }), true);
  assert.equal(isSemanticBatchContainerUsable([semanticResult('UNRELATED')]), true);
  assert.equal(isSemanticBatchContainerUsable(null), false);
  assert.equal(isSemanticBatchContainerUsable({ results: [] }), false);
  assert.equal(isSemanticBatchContainerUsable({ results: 'none' }), false);
  assert.equal(isSemanticBatchContainerUsable({ verdict: 'UNRELATED' }), false);
});

test('independent submissions are coalesced into one provider call', async () => {
  const clock = fakeClock();
  const calls: Array<{ prompt: string; model: string; options?: { batchSize?: number } }> = [];
  const client = clientWith(async (prompt, model, _observability, _signal, options) => {
    calls.push({ prompt, model, options });
    return { results: [semanticResult('ACTIVE_TRADING', 'video_title'), semanticResult('UNRELATED')] };
  });
  const instance = scheduler(clock);
  const first = instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  const second = instance.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1' });
  assert.equal(calls.length, 0);
  clock.runAll();
  const results = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.batchSize, 2);
  assert.match(calls[0].prompt, /BATCH_CLASSIFICATION/);
  assert.equal((results[0] as any).label, 'ACTIVE_TRADING');
  assert.equal((results[1] as any).label, 'UNRELATED');
});

test('a malformed individual item falls back to a single call for that channel only', async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const client = clientWith(async prompt => {
    calls.push(prompt);
    if (prompt.includes('BATCH_CLASSIFICATION')) {
      return { results: [semanticResult('ACTIVE_TRADING'), { label: 'UNRELATED' }] };
    }
    return semanticResult('UNRELATED');
  });
  const instance = scheduler(clock);
  const first = instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  const second = instance.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1' });
  clock.runAll();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal((a as any).label, 'ACTIVE_TRADING');
  assert.equal((b as any).label, 'UNRELATED');
});

test('a malformed whole-batch container fails the batch instead of issuing N+1 calls', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = clientWith(async prompt => {
    calls += 1;
    return prompt.includes('BATCH_CLASSIFICATION') ? { verdict: 'UNRELATED' } : semanticResult('UNRELATED');
  });
  const instance = scheduler(clock);
  const first = instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  const second = instance.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1' });
  clock.runAll();
  await assert.rejects(first, /not a usable result container/);
  await assert.rejects(second, /not a usable result container/);
  assert.equal(calls, 1);
});

test('a whole-batch provider failure rejects every request without per-channel retry storm', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error('provider down');
  });
  const instance = scheduler(clock);
  const first = instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  const second = instance.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1' });
  clock.runAll();
  await assert.rejects(first, /provider down/);
  await assert.rejects(second, /provider down/);
  assert.equal(calls, 1);
});

test('an aborted queued request never reaches the provider', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return semanticResult('UNRELATED');
  });
  const instance = scheduler(clock);
  const controller = new AbortController();
  const pending = instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1', signal: controller.signal });
  controller.abort(new Error('caller gone'));
  clock.runAll();
  await assert.rejects(pending, /caller gone/);
  assert.equal(calls, 0);
});

test('cancelling the scheduler settles queued work and clears its timer', async () => {
  const clock = fakeClock();
  const client = clientWith(async () => semanticResult('UNRELATED'));
  const instance = scheduler(clock);
  const pending = instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  instance.cancel(new Error('reconfigured'));
  await assert.rejects(pending, /reconfigured/);
  clock.runAll();
  assert.equal(clock.callbacks.length, 0);
});

test('mixed attribution carries bounded member IDs on the single ledger row', async () => {
  const clock = fakeClock();
  let seen: any;
  const client = clientWith(async (_prompt, _model, observability) => {
    seen = observability;
    return { results: [semanticResult('ACTIVE_TRADING'), semanticResult('UNRELATED')] };
  });
  const instance = scheduler(clock);
  const first = instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1', observability: { jobId: 'job-a', runId: 'run-a' } });
  const second = instance.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1', observability: { jobId: 'job-b', runId: 'run-b' } });
  clock.runAll();
  await Promise.all([first, second]);
  assert.equal(seen.jobId, undefined);
  assert.equal(seen.requestMetadata.semanticBatchSize, '2');
  assert.equal(seen.requestMetadata.semanticBatchJobIds, 'job-a,job-b');
  assert.equal(seen.requestMetadata.semanticBatchRunIds, 'run-a,run-b');
});

test('disabled batching is a byte-for-byte direct provider call', async () => {
  const seen: string[] = [];
  const client = clientWith(async prompt => {
    seen.push(prompt);
    return semanticResult('UNRELATED');
  });
  const instance = new SemanticBatchScheduler({ config: { enabled: false, maxSize: 8, windowMs: 10 } });
  const result = await instance.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  assert.equal((result as any).label, 'UNRELATED');
  assert.deepEqual(seen, ['{"channel_name":"A"}']);
});

test('resetting the process-wide scheduler leaves no orphaned flush', async () => {
  resetSemanticBatchSchedulerForTests();
  assert.doesNotThrow(() => resetSemanticBatchSchedulerForTests());
});

test('all production semantic providers route candidate and repair calls through the batch entry point', () => {
  for (const file of [
    'server/evidenceEngine/providers/GeminiSemanticProvider.ts',
    'server/evidenceEngine/providers/GroqSemanticProvider.ts',
    'server/evidenceEngine/providers/GeminiFreeSemanticProvider.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /classifySemanticPrompt\(\{ client, prompt: candidatePrompt/, `${file} must batch candidate calls`);
  }
  const groq = readFileSync('server/evidenceEngine/providers/GroqSemanticProvider.ts', 'utf8');
  assert.match(groq, /classifySemanticPrompt\(\{ client, prompt: buildCitationRepairPrompt/, 'Groq citation repair must use the batch-aware entry point');
});
