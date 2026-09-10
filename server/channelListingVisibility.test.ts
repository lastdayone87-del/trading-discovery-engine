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
  assert.equal(result.scope, 'DIAGNOSTICS_ONLY:ELIGIBLE_OPERATOR_VISIBLE_CHANNELS');
});

test('explicit NON_TRADING and SKIPPED_EXCLUDED filters opt into their stored slices', () => {
  const nonTrading = buildChannelListingWhere(serving, { ...baseFilters, tradingStatus: 'NON_TRADING' });
  assert.match(nonTrading.where, /NOT \(country_status <> 'REJECTED'\)/);
  assert.match(nonTrading.where, /trading_status=\$1/);
  assert.deepEqual(nonTrading.values, ['NON_TRADING']);
  assert.equal(nonTrading.scope, 'DIAGNOSTICS_ONLY:ELIGIBLE_OPERATOR_VISIBLE_CHANNELS');
  const skipped = buildChannelListingWhere(serving, { ...baseFilters, scanStatus: 'SKIPPED_EXCLUDED' });
  assert.match(skipped.where, /NOT \(country_status <> 'REJECTED'\)/);
  assert.match(skipped.where, /scan_status=\$1/);
  assert.deepEqual(skipped.values, ['SKIPPED_EXCLUDED']);
});

test('combined excluded-status filters intersect on the rejected corpus', () => {
  const result = buildChannelListingWhere(serving, {
    ...baseFilters,
    countryStatus: 'REJECTED',
    tradingStatus: 'NON_TRADING',
  });
  assert.match(result.where, /NOT \(country_status <> 'REJECTED'\)/);
  assert.match(result.where, /country_status=\$1/);
  assert.match(result.where, /trading_status=\$2/);
  assert.deepEqual(result.values, ['REJECTED', 'NON_TRADING']);
});

test('diagnostic slices skip the low-audience exclusion like the diagnostics view', () => {
  const result = buildChannelListingWhere(serving, { ...baseFilters, tradingStatus: 'NON_TRADING' });
  assert.doesNotMatch(result.where, /SKIPPED_LOW_AUDIENCE/);
  const normal = buildChannelListingWhere(serving, baseFilters);
  assert.match(normal.where, /scan_status <> 'SKIPPED_LOW_AUDIENCE'/);
});

test('default scope names the serving corpus instead of claiming all stored rows', () => {
  assert.equal(buildChannelListingWhere(serving, baseFilters).scope, 'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS');
  assert.equal(
    buildChannelListingWhere(serving, { ...baseFilters, diagnosticsOnly: true }).scope,
    'DIAGNOSTICS_ONLY:ELIGIBLE_OPERATOR_VISIBLE_CHANNELS'
  );
  assert.equal(
    buildChannelListingWhere(serving, { ...baseFilters, includeRejected: true }).scope,
    'ALL_CHANNELS'
  );
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
