import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredGroqRoutes,
  groqKeySlotNumber,
  groqOrgIdForSlot,
  groqOrgCooldownRemainingMs,
  reserveGroqVocabularyStart,
  resetGroqCooldownForTests,
  resetGroqVocabularyPacingForTests,
  runGroqTextCompletion,
} from './evidenceEngine/providers/GroqSemanticProvider';
import { ProviderCallError, type ProviderCallEvent } from './providerResilience';
import { hasUsableVocabularyArrays, extractVocabularyFromCreator } from './queryIntelligence';
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
    const hanging = stubFetch(
      (_url: any, init?: any) =>
        new Promise<Response>((_resolve, reject) => {
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
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('content without a JSON object fails over instead of succeeding', async () => {
  const saved = saveGroqEnv();
  try {
    withEnv({ GROQ_API_KEY: 'test-key-c1', GROQ_API_KEY_2: 'test-key-c2' }, 'org-content');
    process.env.GROQ_ORG_ID = 'org-c1';
    process.env.GROQ_ORG_ID_2 = 'org-c2';
    const events: ProviderCallEvent[] = [];
    const text = await runGroqTextCompletion(
      { prompt: 'extract' },
      {
        fetchImpl: stubFetch(async (_url: any, init?: any) => {
          const auth = String(init?.headers?.Authorization || '');
          if (auth === 'Bearer test-key-c1') return envelope('just some prose, no object');
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
    assert.ok(events.every(event => event.status !== 'SUCCESS' || String(event.requestMetadata?.groqRoute) === 'groq-2'));
    assert.ok(events.some(event => event.status === 'TRANSIENT_ERROR'));
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
    assert.ok(starts[1] - starts[0] >= 70, 'concurrent starts bunched');
    assert.ok(starts[2] - starts[1] >= 70, 'concurrent starts bunched');
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});

test('independent orgs pace independently', async () => {
  const t0 = Date.now();
  const now = () => Date.now();
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  await Promise.all([
    reserveGroqVocabularyStart('test-org-x', 150, now, sleep),
    reserveGroqVocabularyStart('test-org-y', 150, now, sleep),
  ]);
  assert.ok(Date.now() - t0 < 120, 'independent orgs waited on each other');
  resetGroqVocabularyPacingForTests('test-org-x');
  resetGroqVocabularyPacingForTests('test-org-y');
  const t1 = Date.now();
  await reserveGroqVocabularyStart('test-org-x', 150, now, sleep);
  await reserveGroqVocabularyStart('test-org-x', 150, now, sleep);
  assert.ok(Date.now() - t1 >= 120, 'same-org starts were not spaced');
  resetGroqVocabularyPacingForTests('test-org-x');
});

test('usability gate accepts shapes, rejects non-vocabulary JSON', () => {
  assert.equal(hasUsableVocabularyArrays(undefined), false);
  assert.equal(hasUsableVocabularyArrays({}), false);
  assert.equal(hasUsableVocabularyArrays({ foo: 1 } as any), false);
  assert.equal(hasUsableVocabularyArrays({ terminology: 'DAX' }), false);
  assert.equal(hasUsableVocabularyArrays({ terminology: [] }), false);
  assert.equal(hasUsableVocabularyArrays({ terminology: [42, null] }), false);
  assert.equal(hasUsableVocabularyArrays({ instruments: ['ES'] }), true);
  assert.equal(hasUsableVocabularyArrays({ terminology: ['DAX', 42] }), true);
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
    globalThis.fetch = stubFetch(async () =>
      envelope(JSON.stringify({
        terminology: ['Saisonalität'],
        instruments: ['DAX'],
        phrases: [],
        formats: [],
      }))
    ) as typeof fetch;
    const suffix = `e2e${Date.now().toString(36)}${process.pid}`;
    const channelId = `GROQ_E2E_${suffix}`;
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,quality_score,trading_status)
       VALUES($1,'Probe Wxy Kanal',$2,'Germany','CONFIRMED','UNKNOWN','PENDING','groq-e2e',now(),90,'TRADING_CONFIRMED')`,
      [channelId, `https://youtube.com/channel/${channelId}`]
    );
    const channel = await db.query(`SELECT * FROM channels WHERE channel_id=$1`, [channelId]).then(r => r.rows[0]);
    await extractVocabularyFromCreator(
      channel, ['Saisonalität Heute', 'DAX Analyse'], '', false, undefined, undefined
    );
    const rows = (await db.query(
      `SELECT t.canonical_term, o.evidence->>'extractor' AS extractor
       FROM terminology_observations o JOIN canonical_trading_terms t ON t.id=o.canonical_term_id
       WHERE o.source_channel_id=$1 ORDER BY 1`,
      [channelId]
    )).rows as Array<{ canonical_term: string; extractor: string }>;
    const ai = rows.find(row => row.canonical_term === `saisonalität` || row.canonical_term.includes('Saisonalität'));
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
    await extractVocabularyFromCreator(channel, ['Morgenstimmung'], '', false, undefined, undefined);
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
    assert.ok(starts[1] - starts[0] >= 70, 'ledger stall let starts bunch');
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
    const hangingLedger = async () => new Promise<undefined>(() => undefined);
    const started = Date.now();
    await assert.rejects(
      runGroqTextCompletion(
        { prompt: 'extract' },
        {
          fetchImpl: stubFetch(async () => envelope('{}')),
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
  } finally {
    restoreGroqEnv(saved);
    resetGroqCooldownForTests();
    resetGroqVocabularyPacingForTests();
  }
});
