import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_ASSIST_POLICY_VERSION,
  MAX_LLM_CALLS_PER_INSPECTION,
  MAX_LLM_INPUT_CHARS,
  evaluateLlmAssistGate,
  isLlmAssistEnabled,
  validateLlmDecision,
  type LlmAssistInput,
} from './llmAssist';

const INPUT: LlmAssistInput = {
  task: 'AMBIGUOUS_NAVIGATION',
  candidateUrls: ['https://example.com/join', 'https://example.com/about'],
  evidenceSpans: ['members gather on our join page every Friday', 'about our trading desk'],
  baseline: 'https://example.com/join',
  contextUrl: 'https://example.com/',
};

const validDecision = {
  task: 'AMBIGUOUS_NAVIGATION' as const,
  selectedUrl: 'https://example.com/join',
  citedEvidence: ['members gather on our join page every Friday'],
  confidence: 0.8,
  rationale: 'Anchor text matches the membership pattern observed on the hub.',
};

test('valid bounded decisions pass with no reason codes', () => {
  assert.deepEqual(validateLlmDecision(INPUT, validDecision), { valid: true, reasonCodes: [] });
  assert.deepEqual(
    validateLlmDecision(INPUT, { ...validDecision, selectedUrl: null, citedEvidence: [] }),
    { valid: true, reasonCodes: [] },
    'abstention with no claims is valid',
  );
});

test('invented URLs are rejected even when plausible', () => {
  assert.deepEqual(
    validateLlmDecision(INPUT, { ...validDecision, selectedUrl: 'https://example.com/secret-vip-room' }),
    { valid: false, reasonCodes: ['INVENTED_URL'] },
  );
  assert.deepEqual(
    validateLlmDecision(INPUT, { ...validDecision, selectedUrl: 'https://evil.example.net/join' }),
    { valid: false, reasonCodes: ['INVENTED_URL'] },
  );
  assert.deepEqual(
    validateLlmDecision(INPUT, { ...validDecision, selectedUrl: 'not a url' }),
    { valid: false, reasonCodes: ['INVENTED_URL'] },
  );
});

test('ungrounded evidence, bad confidence, and missing rationale are rejected', () => {
  assert.ok(validateLlmDecision(INPUT, { ...validDecision, citedEvidence: ['the moon is made of cheese'] }).reasonCodes.includes('UNGROUNDED_EVIDENCE'));
  assert.ok(validateLlmDecision(INPUT, { ...validDecision, citedEvidence: 'oops' as never }).reasonCodes.includes('EVIDENCE_MISSING'));
  for (const confidence of [NaN, -0.1, 2, 'high' as never]) {
    assert.ok(
      validateLlmDecision(INPUT, { ...validDecision, confidence: confidence as number }).reasonCodes.includes('CONFIDENCE_INVALID'),
      `confidence ${String(confidence)} rejected`,
    );
  }
  assert.ok(validateLlmDecision(INPUT, { ...validDecision, rationale: '  ' }).reasonCodes.includes('RATIONALE_MISSING'));
  assert.ok(validateLlmDecision(INPUT, { ...validDecision, task: 'EVIDENCE_INTERPRETATION' }).reasonCodes.includes('TASK_MISMATCH'));
  assert.deepEqual(validateLlmDecision(INPUT, null).reasonCodes, ['DECISION_MISSING']);
});

test('gateway stays closed unless enabled, allowlisted, and within budgets', () => {
  const open = { enabled: true, allowlistedTasks: ['AMBIGUOUS_NAVIGATION' as const], task: 'AMBIGUOUS_NAVIGATION' as const, callsUsed: 0, inputChars: 100 };
  assert.deepEqual(evaluateLlmAssistGate(open), { allowed: true, reasonCodes: [] });
  assert.ok(!evaluateLlmAssistGate({ ...open, enabled: false }).allowed, 'disabled gateway');
  assert.ok(!evaluateLlmAssistGate({ ...open, allowlistedTasks: [] }).allowed, 'non-allowlisted task');
  assert.ok(!evaluateLlmAssistGate({ ...open, callsUsed: MAX_LLM_CALLS_PER_INSPECTION }).allowed, 'call budget');
  assert.ok(!evaluateLlmAssistGate({ ...open, inputChars: MAX_LLM_INPUT_CHARS + 1 }).allowed, 'input budget');
});

test('assistance stays disabled by default and versions its policy', async () => {
  assert.equal(await isLlmAssistEnabled(async () => 'false'), false);
  assert.equal(await isLlmAssistEnabled(async () => 'true'), true);
  assert.match(LLM_ASSIST_POLICY_VERSION, /^llm-assist-v\d+$/);
});

test('orchestrator gates before calling, validates after, and never throws', async () => {
  const { executeLlmAssistTask } = await import('./llmAssist');
  const budget: { enabled: boolean; allowlistedTasks: ('AMBIGUOUS_NAVIGATION')[]; callsUsed: number; inputChars: number } = {
    enabled: true,
    allowlistedTasks: ['AMBIGUOUS_NAVIGATION'],
    callsUsed: 0,
    inputChars: 100,
  };
  let calls = 0;
  const gated = await executeLlmAssistTask(
    INPUT,
    { completeDecision: async () => { calls += 1; return validDecision; } },
    { ...budget, enabled: false }
  );
  assert.equal(gated.outcome, 'FALLBACK');
  assert.deepEqual(gated.reasonCodes, ['GATEWAY_DISABLED']);
  assert.equal(calls, 0);
  const noClient = await executeLlmAssistTask(INPUT, null, { ...budget, allowlistedTasks: [...budget.allowlistedTasks] });
  assert.equal(noClient.outcome, 'FALLBACK');
  assert.deepEqual(noClient.reasonCodes, ['NO_PROVIDER_CLIENT']);
  assert.equal(noClient.decision.selectedUrl, null);
  const applied = await executeLlmAssistTask(
    INPUT,
    { completeDecision: async () => validDecision },
    { ...budget, allowlistedTasks: [...budget.allowlistedTasks] }
  );
  assert.equal(applied.outcome, 'APPLIED');
  assert.deepEqual(applied.decision, validDecision);
  assert.equal(applied.audit.outcome, 'APPLIED');
  const invented = await executeLlmAssistTask(
    INPUT,
    { completeDecision: async () => ({ ...validDecision, selectedUrl: 'https://example.com/secret-vip-room' }) },
    { ...budget, allowlistedTasks: [...budget.allowlistedTasks] }
  );
  assert.equal(invented.outcome, 'REJECTED');
  assert.deepEqual(invented.reasonCodes, ['INVENTED_URL']);
  assert.equal(invented.decision.selectedUrl, null);
  const exploded = await executeLlmAssistTask(
    INPUT,
    {
      completeDecision: async () => {
        throw new Error('provider down');
      },
    },
    { ...budget, allowlistedTasks: [...budget.allowlistedTasks] }
  );
  assert.equal(exploded.outcome, 'FALLBACK');
  assert.ok(exploded.reasonCodes[0].startsWith('PROVIDER_ERROR:'));
});

test('null/undefined provider responses fall back safely with audit intact', async () => {
  const { executeLlmAssistTask } = await import('./llmAssist');
  const budget = {
    enabled: true,
    allowlistedTasks: ['AMBIGUOUS_NAVIGATION'] as ('AMBIGUOUS_NAVIGATION')[],
    callsUsed: 0,
    inputChars: 100,
  };
  for (const empty of [null, undefined]) {
    const result = await executeLlmAssistTask(
      {
        task: 'AMBIGUOUS_NAVIGATION',
        candidateUrls: ['https://example.com/join'],
        evidenceSpans: ['members gather here'],
        baseline: 'https://example.com/join',
        contextUrl: 'https://example.com/',
      },
      { completeDecision: async () => empty as never },
      { ...budget, allowlistedTasks: [...budget.allowlistedTasks] }
    );
    assert.equal(result.outcome, 'FALLBACK');
    assert.deepEqual(result.reasonCodes, ['PROVIDER_EMPTY_RESPONSE']);
    assert.equal(result.decision.selectedUrl, null);
    assert.equal(result.audit.outcome, 'FALLBACK');
    assert.deepEqual(result.audit.reasonCodes, ['PROVIDER_EMPTY_RESPONSE']);
    assert.equal(result.audit.task, 'AMBIGUOUS_NAVIGATION');
  }
});
