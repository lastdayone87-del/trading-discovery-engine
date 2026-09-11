import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MULTILINGUAL_CANDIDATE_MODEL,
  GeminiSemanticProvider,
  type SemanticModelClient
} from './GeminiSemanticProvider';
import { ProviderCallError } from '../../providerResilience';

const input = {
  channel_id: 'channel-1',
  channel_name: 'Example creator',
  description: 'Creator-level description with enough context for semantic classification.',
  video_titles: ['Example recent video', 'Another recent video'],
  video_descriptions: ['Description one', 'Description two'],
  country: 'United States'
} as any;

const unrelatedResult = {
  label: 'UNRELATED',
  confidence: 96,
  supportedLanguage: true,
  reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
  explanation: 'The creator focuses on sports commentary rather than trading.',
  concepts: ['sports commentary'],
  languages: [{ language: 'en', script: 'Latin', confidence: 100, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }]
};

function withModelOverrides(candidate: string | undefined, adjudicator: string | undefined) {
  const previousCandidate = process.env.MULTILINGUAL_CANDIDATE_MODEL;
  const previousAdjudicator = process.env.MULTILINGUAL_ADJUDICATOR_MODEL;
  if (candidate === undefined) delete process.env.MULTILINGUAL_CANDIDATE_MODEL;
  else process.env.MULTILINGUAL_CANDIDATE_MODEL = candidate;
  if (adjudicator === undefined) delete process.env.MULTILINGUAL_ADJUDICATOR_MODEL;
  else process.env.MULTILINGUAL_ADJUDICATOR_MODEL = adjudicator;
  return () => {
    if (previousCandidate === undefined) delete process.env.MULTILINGUAL_CANDIDATE_MODEL;
    else process.env.MULTILINGUAL_CANDIDATE_MODEL = previousCandidate;
    if (previousAdjudicator === undefined) delete process.env.MULTILINGUAL_ADJUDICATOR_MODEL;
    else process.env.MULTILINGUAL_ADJUDICATOR_MODEL = previousAdjudicator;
  };
}

test('candidate model 404 retries once with explicitly configured adjudicator model and preserves fallback provenance', async () => {
  const restore = withModelOverrides('gemini-unavailable-test-model', 'gemini-3.6-flash');
  try {
    const calls: string[] = [];
    const client: SemanticModelClient = {
      async classify(_prompt, model) {
        calls.push(model);
        if (calls.length === 1) throw new ProviderCallError('model unavailable', 'PERMANENT_INPUT', false, { status: 404 });
        return unrelatedResult;
      }
    };
    const provider = new GeminiSemanticProvider(client);
    const items = await provider.collectEvidence(input, {} as any);
    assert.deepEqual(calls, ['gemini-unavailable-test-model', 'gemini-3.6-flash']);
    assert.equal(items[0].polarity, 'NEGATIVE');
    assert.equal(items[0].category, 'IRRELEVANT_DOMAIN');
    assert.equal(items[0].provenance?.semantic?.modelVersion, 'gemini-3.6-flash');
    assert.ok(items[0].provenance?.semantic?.reasonCodes?.includes('SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'));
  } finally {
    restore();
  }
});

test('non-404 permanent failures do not invoke fallback model', async () => {
  const restore = withModelOverrides(undefined, undefined);
  try {
    const calls: string[] = [];
    const client: SemanticModelClient = {
      async classify(_prompt, model) {
        calls.push(model);
        throw new ProviderCallError('invalid request', 'PERMANENT_INPUT', false, { status: 400 });
      }
    };
    const provider = new GeminiSemanticProvider(client);
    await assert.rejects(provider.collectEvidence(input, {} as any), (error: any) => error?.status === 400);
    assert.deepEqual(calls, [DEFAULT_MULTILINGUAL_CANDIDATE_MODEL]);
  } finally {
    restore();
  }
});


test('configured Gemini routes are ordered, non-empty, and deduplicated without exposing values',async()=>{
  const {configuredGeminiRoutes}=await import('./GeminiSemanticProvider');
  const routes=configuredGeminiRoutes({GEMINI_API_KEY:'a',GEMINI_API_KEY_2:'b',GEMINI_API_KEY_3:'a',GEMINI_API_KEY_4:'',GEMINI_API_KEY_5:'e',GEMINI_API_KEY_20:'z'});
  assert.deepEqual(routes.map(route=>route.id),['gemini-1','gemini-2','gemini-5','gemini-20']);
  assert.deepEqual(routes.map(route=>route.key),['a','b','e','z']);
});

test('rate-limited Gemini route failure surfaces without cross-route burst',async()=>{
  // Gemini rate limits are project-level: failing over to another key after a
  // 429 would multiply the burst, so the failover rethrows immediately and the
  // shared cooldown (not another key) absorbs the pressure.
  const {runGeminiRouteFailover}=await import('./GeminiSemanticProvider');
  const calls:string[]=[];
  const thrown=new ProviderCallError('rate pressure','RATE_LIMIT',true,{status:429});
  const caught=await runGeminiRouteFailover([{id:'gemini-1',key:'hidden-a'},{id:'gemini-2',key:'hidden-b'}],async route=>{
    calls.push(route.id);
    throw thrown;
  }).then(()=>null,(error:any)=>error);
  // Identity: the original 429 (status + provider metadata) must reach the
  // caller untouched so cooldown persistence and diagnostics keep working.
  assert.equal(caught,thrown);
  assert.equal((caught as ProviderCallError).status,429);
  assert.deepEqual(calls,['gemini-1']);
});

test('transient transport failure still advances to the next authorized route',async()=>{
  const {runGeminiRouteFailover}=await import('./GeminiSemanticProvider');
  const calls:string[]=[];
  const result=await runGeminiRouteFailover([{id:'gemini-1',key:'hidden-a'},{id:'gemini-2',key:'hidden-b'}],async route=>{
    calls.push(route.id);
    if(route.id==='gemini-1')throw new ProviderCallError('connection reset','TRANSIENT',true);
    return {route:route.id};
  });
  assert.deepEqual(calls,['gemini-1','gemini-2']);
  assert.deepEqual(result,{route:'gemini-2'});
});

test('non-retryable Gemini route failure does not spill into another route',async()=>{
  const {runGeminiRouteFailover}=await import('./GeminiSemanticProvider');
  const calls:string[]=[];
  await assert.rejects(runGeminiRouteFailover([{id:'gemini-1',key:'hidden-a'},{id:'gemini-2',key:'hidden-b'}],async route=>{
    calls.push(route.id);
    throw new ProviderCallError('invalid request','PERMANENT_INPUT',false,{status:400});
  }), (error:any)=>error?.status===400);
  assert.deepEqual(calls,['gemini-1']);
});

test('gemini account labels default to slot-unique accounts; explicit labels honored', async () => {
  const { configuredGeminiRoutes, geminiOrgIdForSlot, geminiRouteOrg } = await import('./GeminiSemanticProvider');
  assert.equal(geminiOrgIdForSlot({} as any, 1), 'slot-1');
  assert.equal(geminiOrgIdForSlot({} as any, 2), 'slot-2');
  assert.equal(geminiOrgIdForSlot({ GEMINI_ORG_ID: 'proj-a' } as any, 1), 'proj-a');
  assert.equal(geminiOrgIdForSlot({ GEMINI_ORG_ID_3: 'proj-a' } as any, 3), 'proj-a');
  const routes = configuredGeminiRoutes({ GEMINI_API_KEY: 'a', GEMINI_API_KEY_2: 'b' } as any);
  assert.deepEqual(routes.map(route => route.orgId), ['slot-1', 'slot-2']);
  const shared = configuredGeminiRoutes({ GEMINI_API_KEY: 'a', GEMINI_API_KEY_2: 'b', GEMINI_ORG_ID: 'p', GEMINI_ORG_ID_2: 'p' } as any);
  assert.deepEqual(shared.map(route => route.orgId), ['p', 'p']);
  assert.equal(geminiRouteOrg({}), 'shared');
  assert.equal(geminiRouteOrg({ orgId: 'p' }), 'p');
});

test('429 on one gemini account fails over to the next healthy account', async () => {
  const { runGeminiRouteFailover } = await import('./GeminiSemanticProvider');
  const calls: string[] = [];
  const result = await runGeminiRouteFailover(
    [
      { id: 'gemini-1', key: 'hidden-a', orgId: 'slot-1' },
      { id: 'gemini-2', key: 'hidden-b', orgId: 'slot-2' },
    ],
    async route => {
      calls.push(route.id);
      if (route.id === 'gemini-1') throw new ProviderCallError('rate pressure', 'RATE_LIMIT', true, { status: 429 });
      return { route: route.id };
    },
  );
  assert.deepEqual(calls, ['gemini-1', 'gemini-2']);
  assert.deepEqual(result, { route: 'gemini-2' });
});

test('same-account gemini 429 never spills into the shared pool', async () => {
  const { runGeminiRouteFailover } = await import('./GeminiSemanticProvider');
  const calls: string[] = [];
  const thrown = new ProviderCallError('rate pressure', 'RATE_LIMIT', true, { status: 429 });
  const caught = await runGeminiRouteFailover(
    [
      { id: 'gemini-1', key: 'hidden-a', orgId: 'proj-a' },
      { id: 'gemini-2', key: 'hidden-b', orgId: 'proj-a' },
    ],
    async route => {
      calls.push(route.id);
      throw thrown;
    },
  ).then(() => null, (error: any) => error);
  assert.equal(caught, thrown);
  assert.deepEqual(calls, ['gemini-1']);
});

test('gemini 429 carries its route for per-account retry scheduling', async () => {
  const { runGeminiRouteFailover } = await import('./GeminiSemanticProvider');
  const calls: string[] = [];
  const caught = await runGeminiRouteFailover(
    [{ id: 'gemini-2', key: 'hidden-b', orgId: 'slot-2' }],
    async route => {
      calls.push(route.id);
      throw Object.assign(new ProviderCallError('rate pressure', 'RATE_LIMIT', true, { status: 429 }), { geminiRoute: route.id });
    },
  ).then(() => null, (error: any) => error);
  assert.equal((caught as any)?.geminiRoute, 'gemini-2');
  assert.deepEqual(calls, ['gemini-2']);
});

test('A1 → A2 → B never retries the exhausted same-account sibling', async () => {
  const { runGeminiRouteFailover } = await import('./GeminiSemanticProvider');
  const calls: string[] = [];
  const result = await runGeminiRouteFailover(
    [
      { id: 'gemini-1', key: 'hidden-a', orgId: 'proj-a' },
      { id: 'gemini-2', key: 'hidden-b', orgId: 'proj-a' },
      { id: 'gemini-3', key: 'hidden-c', orgId: 'proj-b' },
    ],
    async route => {
      calls.push(route.id);
      if (route.id !== 'gemini-3') throw new ProviderCallError('rate pressure', 'RATE_LIMIT', true, { status: 429 });
      return { route: route.id };
    },
  );
  assert.deepEqual(calls, ['gemini-1', 'gemini-3']);
  assert.deepEqual(result, { route: 'gemini-3' });
});

test('error-carried account identity skips that account even from another route', async () => {
  const { runGeminiRouteFailover } = await import('./GeminiSemanticProvider');
  const calls: string[] = [];
  const thrown = Object.assign(new ProviderCallError('rate pressure', 'RATE_LIMIT', true, { status: 429 }), { geminiOrg: 'proj-b' });
  const caught = await runGeminiRouteFailover(
    [
      { id: 'gemini-1', key: 'hidden-a', orgId: 'proj-a' },
      { id: 'gemini-2', key: 'hidden-b', orgId: 'proj-b' },
    ],
    async route => {
      calls.push(route.id);
      if (route.id === 'gemini-1') throw thrown;
      return { route: route.id };
    },
  ).then(() => null, (error: any) => error);
  // The sidecar blames proj-b while gemini-1 is already tried: no eligible
  // account remains, so the original error surfaces without spending a fetch
  // against the blamed account.
  assert.equal(caught, thrown);
  assert.deepEqual(calls, ['gemini-1']);
});

test('paid semantic defaults are the proven 3.6-flash models on every route', async () => {
  const { DEFAULT_MULTILINGUAL_CANDIDATE_MODEL, DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL } = await import('./GeminiSemanticProvider');
  assert.equal(DEFAULT_MULTILINGUAL_CANDIDATE_MODEL, 'gemini-3.6-flash');
  assert.equal(DEFAULT_MULTILINGUAL_ADJUDICATOR_MODEL, 'gemini-3.6-flash');
});

test('candidate classification uses the 2.5 default when no model env is set', async () => {
  const restore = withModelOverrides(undefined, undefined);
  const savedAdjudication = process.env.MULTILINGUAL_ADJUDICATION_ENABLED;
  delete process.env.MULTILINGUAL_ADJUDICATION_ENABLED;
  try {
    const models: string[] = [];
    const client: SemanticModelClient = { classify: async (_prompt, model) => { models.push(model); return unrelatedResult; } };
    const provider = new GeminiSemanticProvider(client);
    await provider.collectEvidence(input, {} as any);
    assert.deepEqual(models, ['gemini-3.6-flash']);
  } finally {
    restore();
    if (savedAdjudication === undefined) delete process.env.MULTILINGUAL_ADJUDICATION_ENABLED;
    else process.env.MULTILINGUAL_ADJUDICATION_ENABLED = savedAdjudication;
  }
});

test('explicit model env still wins; the key never determines the model', async () => {
  const restore = withModelOverrides('custom-candidate', 'custom-adjudicator');
  try {
    const models: string[] = [];
    const client: SemanticModelClient = { classify: async (_prompt, model) => { models.push(model); return unrelatedResult; } };
    const provider = new GeminiSemanticProvider(client);
    await provider.collectEvidence(input, {} as any);
    assert.deepEqual(models, ['custom-candidate']);
  } finally {
    restore();
  }
});

test('adjudication second pass uses the configured adjudicator model', async () => {
  const restore = withModelOverrides(undefined, 'custom-adjudicator');
  process.env.MULTILINGUAL_ADJUDICATION_ENABLED = 'true';
  try {
    const models: string[] = [];
    const low = { ...unrelatedResult, confidence: 10 };
    const client: SemanticModelClient = { classify: async (_prompt, model) => { models.push(model); return low; } };
    const provider = new GeminiSemanticProvider(client);
    await provider.collectEvidence(input, {} as any);
    assert.deepEqual(models, ['gemini-3.6-flash', 'custom-adjudicator']);
  } finally {
    restore();
    delete process.env.MULTILINGUAL_ADJUDICATION_ENABLED;
  }
});

test('key failover threads one model value across routes', async () => {
  const { runGeminiRouteFailover } = await import('./GeminiSemanticProvider');
  const seen: Array<[string, string]> = [];
  const model = 'gemini-2.5-flash-lite';
  const result = await runGeminiRouteFailover(
    [
      { id: 'gemini-1', key: 'hidden-a', orgId: 'slot-1' },
      { id: 'gemini-2', key: 'hidden-b', orgId: 'slot-2' },
    ],
    async route => {
      seen.push([route.id, model]);
      if (route.id === 'gemini-1') throw new ProviderCallError('connection reset', 'TRANSIENT', true);
      return { route: route.id, model };
    },
  );
  assert.deepEqual(seen, [['gemini-1', model], ['gemini-2', model]]);
  assert.deepEqual(result, { route: 'gemini-2', model });
});

test('cooling shared account is skipped before any API path: A1/A2 cooling, B served', async () => {
  const { runGeminiRouteFailover } = await import('./GeminiSemanticProvider');
  const calls: string[] = [];
  const result = await runGeminiRouteFailover(
    [
      { id: 'gemini-1', key: 'hidden-a', orgId: 'proj-a' },
      { id: 'gemini-2', key: 'hidden-b', orgId: 'proj-a' },
      { id: 'gemini-3', key: 'hidden-c', orgId: 'proj-b' },
    ],
    async route => {
      calls.push(route.id);
      return { route: route.id };
    },
    { isOrgCooling: orgId => orgId === 'proj-a' },
  );
  assert.deepEqual(calls, ['gemini-3']);
  assert.deepEqual(result, { route: 'gemini-3' });
});

test('resolveCoolingGeminiOrgs maps persisted windows to a cooling set, failing open', async () => {
  const { resolveCoolingGeminiOrgs } = await import('./GeminiSemanticProvider');
  const now = Date.now();
  assert.deepEqual(
    [...await resolveCoolingGeminiOrgs(['proj-a', 'proj-b'], async org => (org === 'proj-a' ? now + 60_000 : undefined), now)],
    ['proj-a']
  );
  assert.deepEqual(
    [...await resolveCoolingGeminiOrgs(['proj-a'], async () => { throw new Error('ledger down'); }, now)],
    []
  );
});
