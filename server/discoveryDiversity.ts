/** Country-scoped batch diversity keys: same intent/term in another country is a distinct surface. */
export function discoveryDiversityKeys(country: string, intent: string, primaryTerm: string): {
  intentKey: string;
  primaryTermKey: string;
} {
  const key = country.normalize('NFKC').trim().toLocaleLowerCase('en');
  return {
    intentKey: `${key}::${intent}`,
    primaryTermKey: `${key}::${primaryTerm}`,
  };
}
