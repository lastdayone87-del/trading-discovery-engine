import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ADMISSION_PRIMARY_MODEL,
  DEFAULT_ADMISSION_SECONDARY_MODEL,
  resolveAdmissionPrimaryModel,
  resolveAdmissionSecondaryModel,
} from './admissionModels';

test('admission primary default is the measured flash-lite model', () => {
  assert.equal(DEFAULT_ADMISSION_PRIMARY_MODEL, 'gemini-flash-lite-latest');
});

test('admission secondary fallback is independent of the Groq classification default', () => {
  assert.equal(DEFAULT_ADMISSION_SECONDARY_MODEL, 'openai/gpt-oss-120b');
});

test('admission model resolvers prefer runtime overrides', () => {
  assert.equal(resolveAdmissionPrimaryModel({}), 'gemini-flash-lite-latest');
  assert.equal(resolveAdmissionSecondaryModel({}), 'openai/gpt-oss-120b');
  assert.equal(resolveAdmissionPrimaryModel({ ADMISSION_PRIMARY_MODEL: 'custom-primary' }), 'custom-primary');
  assert.equal(resolveAdmissionSecondaryModel({ ADMISSION_SECONDARY_MODEL: 'custom-secondary' }), 'custom-secondary');
});
