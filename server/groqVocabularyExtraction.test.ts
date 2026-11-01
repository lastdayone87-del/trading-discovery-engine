import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredGroqRoutes,
  groqKeySlotNumber,
  groqOrgIdForSlot,
  groqOrgCooldownRemainingMs,
  groqRateLimitCooldownMs,
  groqTimeoutMs,
  groqVocabularyAggregateMs,
  groqVocabularyMinIntervalMs,
  resetGroqCooldownForTests,
  resetGroqVocabularyPacingForTests,
  runGroqTextCompletion,
  withGroqOrgPacingSlot,
} from './evidenceEngine/providers/GroqSemanticProvider';
import { ProviderCallError, type ProviderCallEvent } from './providerResilience';
import { isAdmissibleParsed, extractVocabularyFromCreator } from './queryIntelligence';
import { buildNoveltyBaseline } from './terminologyIntelligence';
import { getDb } from './db';

const GROQ_ENV_PATTERN = /^GROQ_/;

function saveGroqEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (GROQ_ENV_PATTERN.test(name)) saved[name] = process.env[name];
  }
  return saved;
}

function clearGroqEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (GROQ_ENV_PATTERN.test(name)) delete process.env[name];
  }
}

function restoreGroqEnv(saved: Record<string, string | undefined>): void {
  clearGroqEnv();
  for (const [name, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[name] = value;
  }
}

function withEnv(vars: Record<string, string>, label: string): void {
  clearGroqEnv();
  resetGroqCooldownForTests();
  resetGroqVocabularyPacingForTests();
  process.env.GROQ_ORG_ID = label;
  for (const [name, value] of Object.entries(vars)) process.env[name] = value;
}

const envelope = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

const stubFetch = (handler: (url: any, init?: any) => Promise<Response>) => handler as typeof fetch;

test('route discovery is unbounded: gaps, duplicates, empties, and malformed names', () => {
  const saved = saveGroqEnv();
  try {
    withEnv(
      {
        GROQ_API_KEY: 'k1',
        GROQ_API_KEY_2: 'k2',
        GROQ_API_KEY_3: '',
        GROQ_API_KEY_4: 'k2',
        GROQ_API_KEY_5: 'k5',
        GROQ_API_KEY_7: 'k7',
        GROQ_API_KEY_0: 'bad',
        GROQ_API_KEY_X: 'bad',
        GROQ_API_KEY_EXTRA: 'bad',
        GROQ_ORG_ID_7: 'org-seven',
      },
      'test-discovery'
    );
    const routes = configuredGroqRoutes();
    // More keys than any fixed limit, with a numbering gap: all discovered.
    assert.deepEqual(routes.map(route => route.key), ['k1', 'k2', 'k5', 'k7']);
    assert.deepEqual(routes.map(route => route.id), ['groq-1', 'groq-2', 'groq-3', 'groq-4']);
    // Org labels follow slot numbers without a cap (slot 7 labeled);
    // unlabeled slots stay independent orgs by design.
    assert.deepEqual(
      routes.map(route => route.orgId),
      ['test-discovery', 'slot-2', 'slot-5', 'org-seven']
    );
    assert.equal(groqOrgIdForSlot(process.env, 7), 'org-seven');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
  }
});

test('rotation takes effect without code changes or restart', () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'old-key' }, 'org-rotate');
    assert.deepEqual(configuredGroqRoutes().map(route => route.key), ['old-key']);
    withEnv({ GROQ_API_KEY_3: 'new-key' }, 'org-rotate');
    assert.deepEqual(configuredGroqRoutes().map(route => route.key), ['new-key']);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
  }
});

test('rotated keys are used by extraction calls, not just discovery', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'old-key' }, 'org-rotate-call');
    const seen: string[] = [];
    const deps = {
      fetchImpl: stubFetch(async (_url: any, init?: any) => {
        seen.push(String(init?.headers?.Authorization || ''));
        return envelope('{"terminology":[],"instruments":[],"phrases":[],"formats":[]}');
      }),
      emit: async () => undefined,
      persistedCooldownExpiryMs: async () => undefined,
      minIntervalMs: 0,
    };
    await runGroqTextCompletion({ prompt: 'extract' }, deps);
    assert.deepEqual(seen, ['Bearer old-key']);
    // Rotate mid-process: the next extraction uses the new key with no restart.
    withEnv({ GROQ_API_KEY_3: 'new-key' }, 'org-rotate-call');
    await runGroqTextCompletion({ prompt: 'extract' }, deps);
    assert.deepEqual(seen, ['Bearer old-key', 'Bearer new-key']);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('german extraction succeeds verbatim without invention', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-de' }, 'org-de');
    const content = JSON.stringify({
      terminology: ['Börsenanalyse', 'Saisonalität'],
      instruments: ['DAX'],
      phrases: [],
      formats: [],
    });
    let fetches = 0;
    const events: ProviderCallEvent[] = [];
    const text = await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async () => {
          fetches++;
          return envelope(content);
        }),
        emit: async event => {
          events.push(event);
        },
        persistedCooldownExpiryMs: async () => undefined,
        minIntervalMs: 0,
      }
    );
    assert.equal(text, content);
    assert.equal(fetches, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].provider, 'groq');
    assert.equal(events[0].operation, 'vocabulary-extraction');
    assert.equal(events[0].status, 'SUCCESS');
    // Key material never reaches telemetry.
    assert.ok(!JSON.stringify(events).includes('test-key-de'));
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('french extraction succeeds; instrument terms pass through verbatim for downstream gating', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-fr' }, 'org-fr');
    const content = JSON.stringify({
      terminology: ['Analyse Technique'],
      instruments: ['ES'],
      phrases: ['places boursières'],
      formats: [],
    });
    const text = await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async () => envelope(content)),
        emit: async () => undefined,
        persistedCooldownExpiryMs: async () => undefined,
        minIntervalMs: 0,
      }
    );
    assert.equal(text, content);
    // The adapter never invents or drops terms: DAX/ES-style instruments flow
    // to the novelty gate, which bars them from trial (covered downstream).
    const parsed = JSON.parse(text as string) as { terminology: string[]; instruments: string[] };
    assert.deepEqual(parsed.instruments, ['ES']);
    assert.ok(parsed.terminology.includes('Analyse Technique'));
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('malformed provider output is retryable-transient, never a false success', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-malformed' }, 'org-malformed');
    const events: ProviderCallEvent[] = [];
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => new Response('not json at all {{{', { status: 200 })),
          emit: async event => {
            events.push(event);
          },
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
        }
      ),
      (error: unknown) => error instanceof ProviderCallError && error.errorClass === 'TRANSIENT' && error.retryable
    );
    assert.ok(events.every(event => event.status !== 'SUCCESS'));
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('malformed content breaks failover instead of burning quota', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-mc1', GROQ_API_KEY_2: 'test-key-mc2' }, 'org-mc');
    let fetches = 0;
    const events: ProviderCallEvent[] = [];
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => {
            fetches++;
            return envelope('{invalid json,,,}');
          }),
          emit: async event => {
            events.push(event);
          },
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
        }
      ),
      // Complete-but-malformed content repeats identically at temperature 0,
      // so it is non-retryable: failover breaks toward Gemini immediately.
      (error: unknown) => error instanceof ProviderCallError && !error.retryable
    );
    assert.equal(fetches, 1);
    assert.ok(events.every(event => event.status !== 'SUCCESS'));
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('hung telemetry writes never stall extraction', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-emit' }, 'org-emit');
    const started = Date.now();
    const text = await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async () =>
          envelope('{"terminology":[],"instruments":[],"phrases":[],"formats":[]}')
        ),
        emit: () => new Promise<void>(() => undefined),
        emitBudgetMs: 50,
        persistedCooldownExpiryMs: async () => undefined,
        minIntervalMs: 0,
      }
    );
    // The completion result is delivered despite the never-settling telemetry
    // write, once the emit budget elapses — not when (or whether) the write
    // resolves.
    assert.equal(typeof text, 'string');
    assert.ok(Date.now() - started < 3000, 'hung emit stalled the completion');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('telemetry failures never mask the provider error', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-emit2' }, 'org-emit2');
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(
            async () =>
              new Response(JSON.stringify({ error: { message: 'Service overloaded', code: 503 } }), { status: 503 })
          ),
          emit: async () => {
            throw new Error('telemetry sink down');
          },
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
        }
      ),
      // The real provider failure surfaces; the failing telemetry write is
      // dropped instead of replacing it.
      (error: unknown) =>
        error instanceof ProviderCallError &&
        error.errorClass === 'TRANSIENT' &&
        !String((error as Error).message).includes('telemetry')
    );
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('provider text is ledgered before content validation, including rejected and malformed output', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-ledger' }, 'org-ledger');
    const rejected = '{"terminology":[]}';
    const seenRejected: string[] = [];
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => envelope(rejected)),
          emit: async () => undefined,
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
          validateContent: () => false,
          onResponseText: text => seenRejected.push(text),
        }
      )
    );
    assert.deepEqual(seenRejected, [rejected], 'a content-rejected response is still billable output');

    const malformed = 'this is not json';
    const seenMalformed: string[] = [];
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => envelope(malformed)),
          emit: async () => undefined,
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
          onResponseText: text => seenMalformed.push(text),
        }
      )
    );
    assert.deepEqual(seenMalformed, [malformed], 'malformed content still consumed provider output');

    const accepted = '{"terminology":["Charttechnik"]}';
    const seenAccepted: string[] = [];
    const text = await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async () => envelope(accepted)),
        emit: async () => undefined,
        persistedCooldownExpiryMs: async () => undefined,
        minIntervalMs: 0,
        validateContent: () => true,
        onResponseText: value => seenAccepted.push(value),
      }
    );
    assert.equal(text, accepted);
    assert.deepEqual(seenAccepted, [accepted]);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('empty message content is transient; auth-shaped failures never crash', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-empty' }, 'org-empty');
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => envelope('')),
          emit: async () => undefined,
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
        }
      ),
      (error: unknown) => error instanceof ProviderCallError && error.errorClass === 'TRANSIENT'
    );
    withEnv({ GROQ_API_KEY: 'test-key-auth' }, 'org-auth');
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(
            async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
          ),
          emit: async () => undefined,
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
        }
      ),
      (error: unknown) => error instanceof ProviderCallError && error.retryable
    );
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('deadline expiry surfaces TIMEOUT', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-timeout' }, 'org-timeout');
    let fetches = 0;
    const started = Date.now();
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(
            (_url: any, init?: any) =>
              new Promise<Response>((_resolve, reject) => {
                fetches++;
                init?.signal?.addEventListener('abort', () =>
                  reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
                );
              })
          ),
          emit: async () => undefined,
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
          timeoutMs: 60,
        }
      ),
      (error: unknown) => error instanceof ProviderCallError && error.errorClass === 'TIMEOUT'
    );
    // The hanging fetch was actually attempted and the timeout followed the
    // configured 60ms wait — not an immediate rejection before trying.
    assert.equal(fetches, 1);
    assert.ok(Date.now() - started >= 40, 'timeout fired before the configured wait');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('429 fails over to the next key and cools only the exhausted org', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-one', GROQ_API_KEY_2: 'test-key-two' }, 'unused-label');
    process.env.GROQ_ORG_ID = 'org-one';
    process.env.GROQ_ORG_ID_2 = 'org-two';
    const seen: string[] = [];
    const events: ProviderCallEvent[] = [];
    const text = await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async (_url: any, init?: any) => {
          const auth = String(init?.headers?.Authorization || '');
          seen.push(auth);
          if (auth === 'Bearer test-key-one') {
            return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 });
          }
          return envelope('{"terminology":["Saisonalität"],"instruments":[],"phrases":[],"formats":[]}');
        }),
        emit: async event => {
          events.push(event);
        },
        persistedCooldownExpiryMs: async () => undefined,
        minIntervalMs: 0,
      }
    );
    assert.ok((text as string).includes('Saisonalität'));
    assert.deepEqual(seen, ['Bearer test-key-one', 'Bearer test-key-two']);
    assert.deepEqual(
      events.map(event => event.status),
      ['RATE_LIMITED', 'SUCCESS']
    );
    // Only the exhausted org cools; the healthy key stays selectable.
    assert.ok(groqOrgCooldownRemainingMs('org-one') > 0);
    assert.equal(groqOrgCooldownRemainingMs('org-two'), 0);
    assert.ok(!JSON.stringify(events).includes('test-key-one'));
    assert.ok(!JSON.stringify(events).includes('test-key-two'));
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('all keys rate-limited throws without re-hitting cooling keys', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-a', GROQ_API_KEY_2: 'test-key-b' }, 'org-all');
    let fetches = 0;
    const failing = {
      fetchImpl: stubFetch(async () => {
        fetches++;
        return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 });
      }),
      emit: async () => undefined,
      persistedCooldownExpiryMs: async () => undefined,
      minIntervalMs: 0,
    };
    await assert.rejects(runGroqTextCompletion({ prompt: 'extract' }, failing), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT');
      assert.ok(
        ((error as { providerReasons?: string[] }).providerReasons || []).includes('GROQ_RATE_LIMITED')
      );
      return true;
    });
    const fetchesAfterFailure = fetches;
    assert.ok(fetchesAfterFailure >= 1);
    // Cooling keys are short-circuited, not re-hit: the second call throws
    // from the cooldown sentinel with zero additional fetches.
    await assert.rejects(runGroqTextCompletion({ prompt: 'extract' }, failing), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError && error.errorClass === 'RATE_LIMIT');
      return true;
    });
    assert.equal(fetches, fetchesAfterFailure);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('no configured keys fails closed without any fetch', async () => {
  const saved = saveGroqEnv();
  try {
    clearGroqEnv();
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
    let fetches = 0;
    const text = await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async () => {
          fetches++;
          return envelope('{}');
        }),
        emit: async () => undefined,
        persistedCooldownExpiryMs: async () => undefined,
        minIntervalMs: 0,
      }
    );
    assert.equal(text, undefined);
    assert.equal(fetches, 0);
  } finally {
    restoreGroqEnv(saved);
  }
});

test('pacing spaces starts under the free-tier envelope', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-pace' }, 'org-pace');
    const deps = {
      fetchImpl: stubFetch(async () => envelope('{}')),
      emit: async () => undefined,
      persistedCooldownExpiryMs: async () => undefined,
      minIntervalMs: 60,
    };
    const started = Date.now();
    await runGroqTextCompletion({ prompt: 'a' }, deps);
    await runGroqTextCompletion({ prompt: 'b' }, deps);
    assert.ok(Date.now() - started >= 50, 'second start was not paced');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('high-numbered slots are discovered without a maximum', () => {
  const saved = saveGroqEnv();
  try {
    withEnv(
      {
        GROQ_API_KEY: 'h1',
        GROQ_API_KEY_2: 'h2',
        GROQ_API_KEY_10: 'h10',
        GROQ_API_KEY_12: 'h12',
        GROQ_API_KEY_19: 'h19',
        GROQ_API_KEY_20: 'h20',
        GROQ_API_KEY_100: 'h100',
      },
      'org-high'
    );
    assert.equal(groqKeySlotNumber('GROQ_API_KEY'), 1);
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_2'), 2);
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_12'), 12);
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_100'), 100);
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_0'), null);
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_1'), null);
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_X'), null);
    // Leading-zero suffixes are rejected so diagnostics (which check the
    // canonical name) can never miss a loaded key.
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_02'), null);
    assert.equal(groqKeySlotNumber('GROQ_API_KEY_007'), null);
    const routes = configuredGroqRoutes();
    assert.deepEqual(routes.map(route => route.key), ['h1', 'h2', 'h10', 'h12', 'h19', 'h20', 'h100']);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
  }
});

test('configured candidate model override reaches the request', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-model' }, 'org-model');
    process.env.GROQ_CANDIDATE_MODEL = 'test-model-override';
    let requestedModel = '';
    await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async (_url: any, init?: any) => {
          requestedModel = String(JSON.parse(String(init?.body))?.model || '');
          return envelope('{"terminology":[],"instruments":[],"phrases":[],"formats":[]}');
        }),
        emit: async () => undefined,
        persistedCooldownExpiryMs: async () => undefined,
        minIntervalMs: 0,
      }
    );
    assert.equal(requestedModel, 'test-model-override');
  } finally {
    delete process.env.GROQ_CANDIDATE_MODEL;
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('aggregate deadline bounds multi-route failover', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-agg1', GROQ_API_KEY_2: 'test-key-agg2' }, 'org-agg');
    let fetches = 0;
    const hanging = stubFetch(
      (_url: any, init?: any) =>
        new Promise<Response>((_resolve, reject) => {
          fetches++;
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
          );
        })
    );
    const started = Date.now();
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: hanging,
          emit: async () => undefined,
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
          timeoutMs: 5000,
          aggregateMs: 250,
        }
      ),
      (error: unknown) => error instanceof ProviderCallError && error.retryable
    );
    // Two 5s route timeouts must not each run: the aggregate bounds everything.
    assert.ok(Date.now() - started < 3000, 'failover exceeded the aggregate budget');
    // ...but the bound must come from waiting out the budget with real
    // attempts in flight, not from rejecting before trying.
    assert.ok(fetches >= 1, 'no route was attempted before the aggregate fired');
    assert.ok(Date.now() - started >= 150, 'aggregate fired before its budget elapsed');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('content without a JSON object breaks failover instead of succeeding', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-c1', GROQ_API_KEY_2: 'test-key-c2' }, 'org-content');
    process.env.GROQ_ORG_ID = 'org-c1';
    process.env.GROQ_ORG_ID_2 = 'org-c2';
    let fetches = 0;
    const events: ProviderCallEvent[] = [];
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => {
            fetches++;
            return envelope('just some prose, no object');
          }),
          emit: async event => {
            events.push(event);
          },
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
        }
      ),
      // Braceless content repeats identically, so it breaks failover
      // immediately toward Gemini instead of burning the second org.
      (error: unknown) => error instanceof ProviderCallError && !error.retryable
    );
    assert.equal(fetches, 1);
    assert.ok(events.every(event => event.status !== 'SUCCESS'));
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('concurrent same-org calls space out atomically', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-conc' }, 'org-conc');
    const starts: number[] = [];
    const deps = {
      fetchImpl: stubFetch(async () => {
        starts.push(Date.now());
        return envelope('{}');
      }),
      emit: async () => undefined,
      persistedCooldownExpiryMs: async () => undefined,
      minIntervalMs: 100,
    };
    await Promise.all([
      runGroqTextCompletion({ prompt: 'a' }, deps),
      runGroqTextCompletion({ prompt: 'b' }, deps),
      runGroqTextCompletion({ prompt: 'c' }, deps),
    ]);
    starts.sort((a, b) => a - b);
    assert.equal(starts.length, 3);
    // Timers fire late, never materially early: 90ms rejects a limiter that
    // spaces only 75ms apart while allowing ordinary scheduling granularity.
    assert.ok(starts[1] - starts[0] >= 90, 'concurrent starts bunched');
    assert.ok(starts[2] - starts[1] >= 90, 'concurrent starts bunched');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('independent orgs pace independently without wall-clock timing', async () => {
  resetGroqVocabularyPacingForTests();
  try {
    let nowMs = 1000;
    const now = () => nowMs;
    const sleep = async (ms: number): Promise<void> => {
      nowMs += ms;
    };
    // Interleaved reservations across orgs proceed without waiting.
    const completed: string[] = [];
    await Promise.all([
      withGroqOrgPacingSlot('org-fake-x', 150, now, sleep, async () => { completed.push('x1'); }),
      withGroqOrgPacingSlot('org-fake-y', 150, now, sleep, async () => { completed.push('y1'); }),
    ]);
    assert.deepEqual(completed.sort(), ['x1', 'y1']);
    // Same org serializes with the interval applied on the fake clock.
    const order: string[] = [];
    await withGroqOrgPacingSlot('org-fake-z', 150, now, sleep, async () => { order.push(`z1@${nowMs}`); });
    await withGroqOrgPacingSlot('org-fake-z', 150, now, sleep, async () => { order.push(`z2@${nowMs}`); });
    assert.deepEqual(order, ['z1@1000', 'z2@1150']);
  } finally {
    resetGroqVocabularyPacingForTests();
  }
});

const admissibilitySources = [{ kind: 'VIDEO_TITLE', index: 0, text: 'Saisonalität Heute DAX Analyse' }] as unknown as Parameters<
  typeof isAdmissibleParsed
>[1]['sources'];

function admissibilityContext(
  overrides?: Partial<Parameters<typeof isAdmissibleParsed>[1]>
): Parameters<typeof isAdmissibleParsed>[1] {
  return {
    sources: admissibilitySources,
    baseline: buildNoveltyBaseline({
      country: 'Germany',
      vocab: {
        country: 'Germany',
        languages: ['de'],
        native_trading_terminology: [],
        popular_instruments: [],
        local_market_phrases: [],
        common_content_format_names: [],
      },
      vocabOk: true,
      existingTerms: [],
      existingOk: true,
    }),
    language: undefined,
    ruleObserved: new Set<string>(),
    ...overrides,
  };
}

test('admissibility gate requires admission-passable candidates', () => {
  const ctx = admissibilityContext();
  assert.equal(isAdmissibleParsed(undefined, ctx), false);
  assert.equal(isAdmissibleParsed({}, ctx), false);
  assert.equal(isAdmissibleParsed({ foo: 1 } as any, ctx), false);
  assert.equal(isAdmissibleParsed({ terminology: 'DAX' }, ctx), false);
  assert.equal(isAdmissibleParsed({ terminology: [] }, ctx), false);
  assert.equal(isAdmissibleParsed({ terminology: [42, null] }, ctx), false);
  // Not literally present: classifier rejects as non-literal.
  assert.equal(isAdmissibleParsed({ terminology: ['NonexistentTermXYZ'] }, ctx), false);
  // Too short for admission.
  assert.equal(isAdmissibleParsed({ terminology: ['a'] }, ctx), false);
  // Overlong: observeTerminologyDetailed would reject without throwing.
  // (Dedicated source: the overlong candidate must still be literal so the
  // test exercises the length bound, not the literal check.)
  const longTerm = `Saisonalität ${'x'.repeat(80)}`;
  const longSources = [{ kind: 'VIDEO_TITLE', index: 0, text: `${longTerm} Heute` }] as unknown as Parameters<
    typeof isAdmissibleParsed
  >[1]['sources'];
  assert.equal(
    isAdmissibleParsed({ terminology: [longTerm] }, admissibilityContext({ sources: longSources })),
    false
  );
  // Genuinely admissible: literal, bounded, no spam, novel.
  assert.equal(isAdmissibleParsed({ terminology: ['Saisonalität'] }, ctx), true);
  assert.equal(isAdmissibleParsed({ instruments: ['DAX'] }, ctx), true);
  assert.equal(isAdmissibleParsed({ terminology: ['DAX', 42] }, ctx), true);
  // Rule-excluded instruments cannot suppress fallback on their own.
  assert.equal(
    isAdmissibleParsed({ instruments: ['DAX'] }, admissibilityContext({ ruleObserved: new Set(['dax']) })),
    false
  );
  // Already-known terms still admit (observations reinforce evidence);
  // novelty gates trial entry downstream, never admission.
  assert.equal(
    isAdmissibleParsed({ terminology: ['Saisonalität'] }, admissibilityContext({
      baseline: buildNoveltyBaseline({
        country: 'Germany',
        vocab: {
          country: 'Germany',
          languages: ['de'],
          native_trading_terminology: [],
          popular_instruments: [],
          local_market_phrases: [],
          common_content_format_names: [],
        },
        vocabOk: true,
        existingTerms: ['Saisonalität'],
        existingOk: true,
      }),
    })),
    true
  );
  // Broken baseline fails closed, exactly as admission does.
  assert.equal(
    isAdmissibleParsed({ terminology: ['Saisonalität'] }, admissibilityContext({
      baseline: buildNoveltyBaseline({
        country: 'Germany',
        vocab: undefined,
        vocabOk: false,
        existingTerms: [],
        existingOk: true,
      }),
    })),
    false
  );
});

test('spam candidates do not suppress fallback', () => {
  const sources = [{ kind: 'VIDEO_TITLE', index: 0, text: 'gratis Signale Gruppe beitreten' }] as unknown as Parameters<
    typeof isAdmissibleParsed
  >[1]['sources'];
  assert.equal(
    isAdmissibleParsed({ terminology: ['gratis Signale Gruppe'] }, admissibilityContext({ sources })),
    false
  );
});

test('auth failures are transient and never arm rate-limit cooldowns', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-auth2' }, 'org-auth-pin');
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(
            async () => new Response(JSON.stringify({ error: { message: 'Invalid API key', code: 401 } }), { status: 401 })
          ),
          emit: async () => undefined,
          persistedCooldownExpiryMs: async () => undefined,
          minIntervalMs: 0,
        }
      ),
      (error: unknown) => {
        // 401 is not quota pressure: TRANSIENT (retryable), never RATE_LIMIT.
        assert.ok(error instanceof ProviderCallError && error.errorClass === 'TRANSIENT');
        return true;
      }
    );
    assert.equal(groqOrgCooldownRemainingMs('org-auth-pin'), 0);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

const e2eDatabaseUrl = process.env.PHASE10_POSTGRES_URL;

function configureE2eTls(databaseUrl: string): void {
  if (/^postgres(ql)?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)([:/]|$)/i.test(databaseUrl)) {
    process.env.PGSSL = 'disable';
  } else {
    delete process.env.PGSSL;
  }
}

test('groq-only extraction persists GROQ provenance end to end', {
  skip: e2eDatabaseUrl ? false : 'PHASE10_POSTGRES_URL is required for extraction e2e coverage'
}, async () => {
  process.env.DATABASE_URL = e2eDatabaseUrl!;
  configureE2eTls(e2eDatabaseUrl!);
  const db = await getDb();
  const saved = saveGroqEnv();
  const savedGemini = process.env.GEMINI_API_KEY;
  const realFetch = globalThis.fetch;
  try {
    // Groq-only configuration: a Groq key, no Gemini key.
    withEnv({ GROQ_API_KEY: 'test-e2e-key' }, 'org-e2e');
    delete process.env.GEMINI_API_KEY;
    const suffix = `e2e${Date.now().toString(36)}${process.pid}`;
    const channelId = `GROQ_E2E_${suffix}`;
    // Suffix-scoped candidate terms: reruns against the same database start
    // from identical novelty state instead of tripping over terms persisted
    // by the previous run.
    const wedgedTerm = `Saisonalität ${suffix}`;
    globalThis.fetch = stubFetch(async () =>
      envelope(JSON.stringify({
        terminology: [wedgedTerm],
        instruments: ['DAX'],
        phrases: [],
        formats: [],
      }))
    ) as typeof fetch;
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,'Probe Wxy Kanal',$2,'Germany','CONFIRMED','UNKNOWN','PENDING','groq-e2e',now(),90,'TRADING_CONFIRMED')`,
      [channelId, `https://youtube.com/channel/${channelId}`]
    );
    const channel = await db.query(`SELECT * FROM channels WHERE channel_id=$1`, [channelId]).then(r => r.rows[0]);
    await extractVocabularyFromCreator(
      channel, [`${wedgedTerm} Heute`, 'DAX Analyse'], '', false, undefined, undefined, undefined,
      { isKillSwitchActive: async () => false } // pin control state: e2e must not read live operator settings
    );
    const rows = (await db.query(
      `SELECT t.canonical_term, o.evidence->>'extractor' AS extractor
       FROM terminology_observations o JOIN canonical_trading_terms t ON t.id=o.canonical_term_id
       WHERE o.source_channel_id=$1 ORDER BY 1`,
      [channelId]
    )).rows as Array<{ canonical_term: string; extractor: string }>;
    const ai = rows.find(row => row.canonical_term.includes(wedgedTerm));
    assert.ok(ai, `no AI observation persisted: ${JSON.stringify(rows)}`);
    assert.equal(ai.extractor, 'GROQ');
    const dax = rows.filter(row => row.canonical_term.toLowerCase() === 'dax');
    assert.equal(dax.length, 1);
    assert.equal(dax[0].extractor, 'KNOWN_INSTRUMENT_V1');
  } finally {
    globalThis.fetch = realFetch;
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGemini;
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('unusable groq output yields no observations without crashing', {
  skip: e2eDatabaseUrl ? false : 'PHASE10_POSTGRES_URL is required for extraction e2e coverage'
}, async () => {
  process.env.DATABASE_URL = e2eDatabaseUrl!;
  configureE2eTls(e2eDatabaseUrl!);
  const db = await getDb();
  const saved = saveGroqEnv();
  const savedGemini = process.env.GEMINI_API_KEY;
  const realFetch = globalThis.fetch;
  try {
    withEnv({ GROQ_API_KEY: 'test-e2e-key2' }, 'org-e2e2');
    delete process.env.GEMINI_API_KEY;
    let groqFetches = 0;
    globalThis.fetch = stubFetch(async () => {
      groqFetches++;
      return envelope(JSON.stringify({ foo: 1 }));
    }) as typeof fetch;
    const suffix = `e2u${Date.now().toString(36)}${process.pid}`;
    const channelId = `GROQ_E2U_${suffix}`;
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,'Wxy Kanal Beobachter',$2,'Germany','CONFIRMED','UNKNOWN','PENDING','groq-e2e',now(),90,'TRADING_CONFIRMED')`,
      [channelId, `https://youtube.com/channel/${channelId}`]
    );
    const channel = await db.query(`SELECT * FROM channels WHERE channel_id=$1`, [channelId]).then(r => r.rows[0]);
    await extractVocabularyFromCreator(channel, ['Morgenstimmung'], '', false, undefined, undefined, undefined,
      { isKillSwitchActive: async () => false }); // pin control state: e2e must not read live operator settings
    const count = await db.query(`SELECT count(*)::int n FROM terminology_observations WHERE source_channel_id=$1`, [channelId]);
    assert.equal(Number(count.rows[0]?.n), 0);
    // The Groq attempt genuinely ran and declined (leaving parsed unset for
    // Gemini fallback): this is not a vacuous skip. Live Gemini-fallback
    // verification needs provider keys and is documented as a gap.
    assert.ok(groqFetches >= 1, 'groq extraction never ran');
  } finally {
    globalThis.fetch = realFetch;
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGemini;
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('declined groq output invokes the gemini fallback end to end', {
  skip: e2eDatabaseUrl ? false : 'PHASE10_POSTGRES_URL is required for extraction e2e coverage'
}, async () => {
  process.env.DATABASE_URL = e2eDatabaseUrl!;
  configureE2eTls(e2eDatabaseUrl!);
  const db = await getDb();
  const saved = saveGroqEnv();
  const savedGemini = process.env.GEMINI_API_KEY;
  const realFetch = globalThis.fetch;
  try {
    withEnv({ GROQ_API_KEY: 'test-e2e-key3' }, 'org-e2e3');
    // Fake Gemini key: getAIClient constructs a client object without network
    // I/O; all HTTP goes through the stubbed global fetch below.
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const suffix = `e2f${Date.now().toString(36)}${process.pid}`;
    const channelId = `GROQ_E2F_${suffix}`;
    const fallbackTerm = `Saisonalität ${suffix}`;
    let groqFetches = 0;
    let geminiFetches = 0;
    globalThis.fetch = stubFetch(async (url: any) => {
      const target = String(url?.url || url || '');
      if (target.includes('googleapis')) {
        geminiFetches++;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ terminology: [fallbackTerm], instruments: [], phrases: [], formats: [] }) }], role: 'model' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      groqFetches++;
      return envelope(JSON.stringify({ terminology: ['gratis Signale Gruppe'] }));
    }) as typeof fetch;
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,'Wxy Kanal Beobachter',$2,'Germany','CONFIRMED','UNKNOWN','PENDING','groq-e2e',now(),90,'TRADING_CONFIRMED')`,
      [channelId, `https://youtube.com/channel/${channelId}`]
    );
    const channel = await db.query(`SELECT * FROM channels WHERE channel_id=$1`, [channelId]).then(r => r.rows[0]);
    await extractVocabularyFromCreator(
      channel, ['gratis Signale Gruppe beitreten', `${fallbackTerm} Heute`], '', false, undefined, undefined, undefined,
      { isKillSwitchActive: async () => false } // pin control state: e2e must not read live operator settings
    );
    // Groq ran and its spam-only output was declined (no vacuous skip)...
    assert.ok(groqFetches >= 1, 'groq extraction never ran');
    // ...and the Gemini fallback was actually invoked and persisted.
    assert.ok(geminiFetches >= 1, 'gemini fallback never ran');
    const rows = (await db.query(
      `SELECT t.canonical_term, o.evidence->>'extractor' AS extractor
       FROM terminology_observations o JOIN canonical_trading_terms t ON t.id=o.canonical_term_id
       WHERE o.source_channel_id=$1 ORDER BY 1`,
      [channelId]
    )).rows as Array<{ canonical_term: string; extractor: string }>;
    const ai = rows.find(row => row.canonical_term.includes(fallbackTerm));
    assert.ok(ai, `no fallback observation persisted: ${JSON.stringify(rows)}`);
    assert.equal(ai.extractor, 'GEMINI');
  } finally {
    globalThis.fetch = realFetch;
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGemini;
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('paced-then-expired attempts skip the fetch', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-exp' }, 'org-exp');
    let fetches = 0;
    const deps = {
      fetchImpl: stubFetch(async () => {
        fetches++;
        return envelope('{}');
      }),
      emit: async () => undefined,
      persistedCooldownExpiryMs: async () => undefined,
      minIntervalMs: 300,
      aggregateMs: 10000,
    };
    await runGroqTextCompletion({ prompt: 'a' }, deps);
    assert.equal(fetches, 1);
    // Second start must wait out the interval, by which time its own
    // 100ms aggregate has expired: it throws without fetching.
    await assert.rejects(
      runGroqTextCompletion({ prompt: 'b' }, { ...deps, aggregateMs: 100 }),
      (error: unknown) => error instanceof ProviderCallError
    );
    assert.equal(fetches, 1);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('slow ledger lookups do not bunch same-org starts', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-bunch' }, 'org-bunch');
    const starts: number[] = [];
    const slowLedger = async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      return undefined;
    };
    const deps = {
      fetchImpl: stubFetch(async () => {
        starts.push(Date.now());
        return envelope('{}');
      }),
      emit: async () => undefined,
      persistedCooldownExpiryMs: slowLedger,
      minIntervalMs: 100,
    };
    await Promise.all([
      runGroqTextCompletion({ prompt: 'a' }, deps),
      runGroqTextCompletion({ prompt: 'b' }, deps),
    ]);
    starts.sort((a, b) => a - b);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 90, 'ledger stall let starts bunch');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('hung ledger lookups stay within the aggregate bound', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-hung' }, 'org-hung');
    let ledgerInvoked = false;
    let fetches = 0;
    const hangingLedger = async () => {
      ledgerInvoked = true;
      return new Promise<undefined>(() => undefined);
    };
    const started = Date.now();
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => {
            fetches++;
            return envelope('{}');
          }),
          emit: async () => undefined,
          persistedCooldownExpiryMs: hangingLedger,
          minIntervalMs: 0,
          timeoutMs: 5000,
          aggregateMs: 200,
        }
      ),
      (error: unknown) => error instanceof ProviderCallError
    );
    assert.ok(Date.now() - started < 3000, 'hung ledger outlived the bound');
    // The bound must come from waiting out the budget with the lookup
    // genuinely in flight — not from rejecting before trying it.
    assert.ok(ledgerInvoked, 'ledger lookup never ran');
    assert.ok(Date.now() - started >= 100, 'bound fired before its budget elapsed');
    assert.equal(fetches, 0);
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('absurd timeout configs clamp instead of firing immediately', async () => {
  assert.equal(groqVocabularyAggregateMs({ GROQ_VOCABULARY_AGGREGATE_TIMEOUT_MS: '99999999999999' }), 2147483647);
  assert.equal(groqTimeoutMs({ GROQ_PROVIDER_TIMEOUT_MS: '99999999999999' }), 2147483647);
  assert.equal(groqVocabularyMinIntervalMs({ GROQ_VOCABULARY_MIN_INTERVAL_MS: '99999999999999' }), 2147483647);
  assert.equal(groqRateLimitCooldownMs({ GROQ_RATE_LIMIT_COOLDOWN_MS: '99999999999999' }), 2147483647);
  // Sane values pass through untouched.
  assert.equal(groqVocabularyAggregateMs({}), 120000);
  assert.equal(groqVocabularyMinIntervalMs({}), 2500);
});
