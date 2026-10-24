/**
 * Stable policy identity for the adaptive discovery pilot. Kept in a tiny
 * dependency-free module so allocator and database gates can bind evidence to
 * the same policy revision without importing the pilot's database layer.
 */
export const ADAPTIVE_PILOT_POLICY_VERSION = 'adaptive-country-pilot-v1';
