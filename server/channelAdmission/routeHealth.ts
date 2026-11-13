import { configuredGeminiRoutes, geminiRouteOrg } from '../evidenceEngine/providers/GeminiSemanticProvider';
import { configuredGroqRoutes, groqOrgCooldownRemainingMs, groqRouteOrg } from '../evidenceEngine/providers/GroqSemanticProvider';
import { isGeminiOrgCooldownActive, isGroqOrgCooldownActive } from '../providerResilience';

export function allRoutesCoolingDown(perRouteCooling: boolean[]): boolean {
  return perRouteCooling.length === 0 || perRouteCooling.every(Boolean);
}

export function groqFallbackCoolingDown(persistedCooldownActive: boolean, localCooldownRemainingMs: number): boolean {
  return persistedCooldownActive || localCooldownRemainingMs > 0;
}

/**
 * A configured route is usable only when it exists and is not cooling. An
 * unconfigured provider is unavailable, not healthy.
 */
export function judgeRoutePoolHealthy(
  configured: { gemini: boolean; groq: boolean },
  cooling: { gemini: boolean; groq: boolean },
): boolean {
  return (configured.gemini && !cooling.gemini) || (configured.groq && !cooling.groq);
}

/**
 * Preflight for the semantic-admission judge. Deterministic admission does not
 * need this check; ambiguous candidates call it before reserving model budget
 * so a cooling/unconfigured provider pool defers without a wasted call.
 */
export async function admissionSemanticRouteAvailable(): Promise<boolean> {
  const geminiRoutes = configuredGeminiRoutes();
  const groqRoutes = configuredGroqRoutes();
  if (geminiRoutes.length === 0 && groqRoutes.length === 0) return false;
  const [geminiCooling, groqCooling] = await Promise.all([
    geminiRoutes.length > 0
      ? allRoutesCoolingDown(await Promise.all(geminiRoutes.map(route => isGeminiOrgCooldownActive(geminiRouteOrg(route)))))
      : true,
    groqRoutes.length > 0
      ? allRoutesCoolingDown(await Promise.all(groqRoutes.map(async route => groqFallbackCoolingDown(
        await isGroqOrgCooldownActive(groqRouteOrg(route)),
        groqOrgCooldownRemainingMs(groqRouteOrg(route)),
      ))))
      : true,
  ]);
  return judgeRoutePoolHealthy(
    { gemini: geminiRoutes.length > 0, groq: groqRoutes.length > 0 },
    { gemini: geminiCooling, groq: groqCooling },
  );
}
