/**
 * P5 OSINT adapters (EXPERIMENTAL testability, disabled by default).
 * Two enumerated adapters (broker interviews, event speakers) as OsintAdapter
 * stubs returning [] until per-source prerequisites are satisfied:
 * ToS/legal review, registry CANARY, explicit enabled=true, caps.
 * Lead-gen only: observations resolve to YouTube entities + verify downstream.
 * Brave DIRECT_YOUTUBE remains SHADOW (stages, returns channels:[]) — no change.
 * Classification: framework = CORE; each adapter's value = EXPERIMENTAL (E);
 * caps/timeouts = C; assignment/margins = B/D.
 */
import type { ExternalOsintObservationInput, OsintAdapter } from './externalOsint';

export const OSINT_ADAPTERS_VERSION = 'osint-adapters-v1';

export interface OsintAdapterGate {
  tosReviewed: boolean;
  registryCanary: boolean;
  explicitlyEnabled: boolean;
}

/** Fail-closed gate: all three must be true or adapter must not fetch. */
export function isOsintAdapterPermitted(gate: OsintAdapterGate): boolean {
  return gate.tosReviewed && gate.registryCanary && gate.explicitlyEnabled;
}

function stubAdapter(sourceId: string, sourceFamily: OsintAdapter['sourceFamily']): OsintAdapter {
  return {
    sourceId,
    sourceFamily,
    timeoutMs: 10000,
    maxRequests: 20,
    maxCost: 0,
    retry: { attempts: 1, backoffMs: 500 },
    async fetch(_signal: AbortSignal): Promise<ExternalOsintObservationInput[]> {
      // Stub: no network until gate passes in a future experiment runner.
      // Runner MUST check isOsintAdapterPermitted before calling fetch.
      return [];
    },
  };
}

/** Broker interview pages (EDUCATOR_DIRECTORY). Disabled stub. */
export const brokerInterviewAdapter: OsintAdapter = stubAdapter('broker-interviews-stub', 'EDUCATOR_DIRECTORY');

/** Event speaker lists (PUBLICATION). Disabled stub. */
export const eventSpeakerAdapter: OsintAdapter = stubAdapter('event-speakers-stub', 'PUBLICATION');

export const P5_OSINT_ADAPTERS: OsintAdapter[] = [brokerInterviewAdapter, eventSpeakerAdapter];

/**
 * Keyed adapter registry (contract stubs pre-registered by sourceId).
 * A registry entry is identity only — it never implies ToS review, CANARY
 * status, or enablement. Those remain explicit per-run gate inputs because
 * no owning authority for them exists yet (see prerequisites below).
 */
const osintAdapterRegistry = new Map<string, OsintAdapter>();
for (const adapter of P5_OSINT_ADAPTERS) {
  osintAdapterRegistry.set(adapter.sourceId.trim().toLowerCase(), adapter);
}

export function registerOsintAdapter(adapter: OsintAdapter): void {
  if (!adapter || typeof adapter.sourceId !== 'string' || !adapter.sourceId.trim() || typeof adapter.fetch !== 'function') {
    throw new Error('OSINT_ADAPTER_REGISTRATION_INVALID');
  }
  const key = adapter.sourceId.trim().toLowerCase();
  // Source identity is append-only: silently replacing a registered adapter
  // (including the pre-registered contract stubs) would let one source
  // masquerade as another. Duplicates are rejected deterministically; there
  // is no implicit replacement path and none is required by any contract.
  if (osintAdapterRegistry.has(key)) {
    throw new Error('OSINT_ADAPTER_DUPLICATE_SOURCE_ID');
  }
  osintAdapterRegistry.set(key, adapter);
}

export function resolveOsintAdapter(sourceId: string): OsintAdapter | null {
  if (typeof sourceId !== 'string' || !sourceId.trim()) return null;
  return osintAdapterRegistry.get(sourceId.trim().toLowerCase()) ?? null;
}
