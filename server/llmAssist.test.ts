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
