import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelListingWhere } from './db';

const serving = { predicate: "country_status <> 'REJECTED'", scope: 'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS' };
const baseFilters = { includeRejected: false, diagnosticsOnly: false };

test('default listing positively applies the operator-visible predicate', () => {
  const result = buildChannelListingWhere(serving, baseFilters);
  assert.match(result.where, /\(country_status <> 'REJECTED'\)/);
  assert.deepEqual(result.values, []);
});

test('explicit REJECTED status selection opts into the rejected corpus', () => {
  const result = buildChannelListingWhere(serving, {
    ...baseFilters,
    search: 'alpha',
    countryStatus: 'REJECTED',
  });
  // Deliberate opt-in (the dashboard exposes REJECTED as a status filter):
  // reads the rejected complement instead of returning an empty view.
  assert.match(result.where, /NOT \(country_status <> 'REJECTED'\)/);
  assert.match(result.where, /country_status=\$2/);
  assert.deepEqual(result.values, ['alpha', 'REJECTED']);
});

test('diagnostics-only returns the rejected complement', () => {
  const result = buildChannelListingWhere(serving, { ...baseFilters, diagnosticsOnly: true });
  assert.match(result.where, /NOT \(country_status <> 'REJECTED'\)/);
});

test('includeRejected alone remains the explicit all-channel escape hatch', () => {
  const result = buildChannelListingWhere(serving, { ...baseFilters, includeRejected: true });
  assert.ok(result.where.startsWith('TRUE'));
  assert.doesNotMatch(result.where, /country_status <> 'REJECTED'/);
  assert.doesNotMatch(result.where, /scan_status <> 'SKIPPED_LOW_AUDIENCE'/);
});
