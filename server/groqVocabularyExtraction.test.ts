import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredGroqRoutes,
  groqOrgIdForSlot,
  groqOrgCooldownRemainingMs,
  resetGroqCooldownForTests,
  resetGroqVocabularyPacingForTests,
  runGroqTextCompletion,
} from './evidenceEngine/providers/GroqSemanticProvider';
import { ProviderCallError, type ProviderCallEvent } from './providerResilience';

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
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(
            (_url: any, init?: any) =>
              new Promise<Response>((_resolve, reject) => {
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
