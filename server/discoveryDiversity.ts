/** Country-scoped batch diversity keys: same intent/term in another country is a distinct surface. */
const normalizeKeyPart = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

export function discoveryDiversityKeys(country: string, intent: string, primaryTerm: string): {
  intentKey: string;
  primaryTermKey: string;
} {
  const countryKey = normalizeKeyPart(country);
  return {
    intentKey: `${countryKey}::${normalizeKeyPart(intent)}`,
    primaryTermKey: `${countryKey}::${normalizeKeyPart(primaryTerm)}`,
  };
}
