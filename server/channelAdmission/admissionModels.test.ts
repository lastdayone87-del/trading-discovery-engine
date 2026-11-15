import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ADMISSION_PRIMARY_MODEL } from './admissionModels';

test('admission primary default is the measured flash-lite model', () => {
  assert.equal(DEFAULT_ADMISSION_PRIMARY_MODEL, 'gemini-flash-lite-latest');
});
