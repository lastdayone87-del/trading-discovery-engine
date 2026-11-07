import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SEMANTIC_BATCH_PROMPT_VERSION,
  SemanticBatchScheduler,
  buildSemanticBatchPrompt,
  parseSemanticBatchResponse,
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

test('batch config is opt-in, clamps 5-10 safely, and keeps a bounded window', () => {
  assert.deepEqual(semanticBatchConfig({} as any), { enabled: false, maxSize: 8, windowMs: 1200 });
  assert.deepEqual(semanticBatchConfig({ SEMANTIC_BATCH_CLASSIFICATION_ENABLED: 'true', SEMANTIC_BATCH_MAX_SIZE: '99', SEMANTIC_BATCH_WINDOW_MS: '99999' } as any), { enabled: true, maxSize: 10, windowMs: 10_000 });
  assert.deepEqual(semanticBatchConfig({ SEMANTIC_BATCH_CLASSIFICATION_ENABLED: 'true', SEMANTIC_BATCH_MAX_SIZE: '1' } as any), { enabled: true, maxSize: 2, windowMs: 1200 });
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

test('independent submissions are coalesced into one provider call', async () => {
  const clock = fakeClock();
  const calls: Array<{ prompt: string; model: string }> = [];
  const client = clientWith(async (prompt, model) => {
    calls.push({ prompt, model });
    return { results: [{ label: 'ACTIVE_TRADING', citations: [] }, { label: 'UNRELATED', citations: [] }] };
  });
  const scheduler = new SemanticBatchScheduler({
    config: { enabled: true, maxSize: 8, windowMs: 10 },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const first = scheduler.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  const second = scheduler.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1' });
  assert.equal(calls.length, 0);
  clock.runAll();
  const results = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /BATCH_CLASSIFICATION/);
  assert.equal((results[0] as any).label, 'ACTIVE_TRADING');
  assert.equal((results[1] as any).label, 'UNRELATED');
});

test('a missing batch item falls back to a single call for that channel only', async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const client = clientWith(async (prompt) => {
    calls.push(prompt);
    if (prompt.includes('BATCH_CLASSIFICATION')) return { results: [{ label: 'ACTIVE_TRADING', citations: [] }] };
    return { label: 'FALLBACK_SINGLE', citations: [] };
  });
  const scheduler = new SemanticBatchScheduler({
    config: { enabled: true, maxSize: 8, windowMs: 10 },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const first = scheduler.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  const second = scheduler.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1' });
  clock.runAll();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal((a as any).label, 'ACTIVE_TRADING');
  assert.equal((b as any).label, 'FALLBACK_SINGLE');
});

test('a whole-batch provider failure rejects every request without per-channel retry storm', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error('provider down');
  });
  const scheduler = new SemanticBatchScheduler({
    config: { enabled: true, maxSize: 8, windowMs: 10 },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const first = scheduler.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  const second = scheduler.submit({ client, prompt: '{"channel_name":"B"}', model: 'm1' });
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
    return { label: 'A', citations: [] };
  });
  const scheduler = new SemanticBatchScheduler({
    config: { enabled: true, maxSize: 8, windowMs: 10 },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const controller = new AbortController();
  const pending = scheduler.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1', signal: controller.signal });
  controller.abort(new Error('caller gone'));
  clock.runAll();
  await assert.rejects(pending, /caller gone/);
  assert.equal(calls, 0);
});

test('disabled batching is a byte-for-byte direct provider call', async () => {
  const seen: string[] = [];
  const client = clientWith(async prompt => {
    seen.push(prompt);
    return { label: 'A', citations: [] };
  });
  const scheduler = new SemanticBatchScheduler({ config: { enabled: false, maxSize: 8, windowMs: 10 } });
  const result = await scheduler.submit({ client, prompt: '{"channel_name":"A"}', model: 'm1' });
  assert.equal((result as any).label, 'A');
  assert.deepEqual(seen, ['{"channel_name":"A"}']);
});

test('all production semantic providers route candidate calls through the batch entry point', () => {
  for (const file of [
    'server/evidenceEngine/providers/GeminiSemanticProvider.ts',
    'server/evidenceEngine/providers/GroqSemanticProvider.ts',
    'server/evidenceEngine/providers/GeminiFreeSemanticProvider.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /classifySemanticPrompt\(\{ client, prompt: candidatePrompt/, `${file} must batch candidate calls`);
  }
});
