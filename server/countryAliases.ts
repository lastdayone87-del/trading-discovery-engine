/**
 * Canonical country aliases shared by country inference and exclusion
 * matching. The map is a leaf module (no imports) so both consumers can use
 * one identity vocabulary without creating an import cycle.
 *
 * Keys are normalized spellings (see `normalizeCountryName`); values are the
 * canonical country names used by `COUNTRY_SIGNALS` and the exclusion list.
 */
export const COUNTRY_ALIASES: Record<string, string> = {
  us: 'United States', usa: 'United States', 'united states of america': 'United States',
  gb: 'United Kingdom', uk: 'United Kingdom', 'great britain': 'United Kingdom',
  de: 'Germany', fr: 'France', es: 'Spain', br: 'Brazil', ru: 'Russia', in: 'India',
  jp: 'Japan', kr: 'South Korea', tr: 'Turkey', sa: 'Saudi Arabia', ae: 'United Arab Emirates',
  nl: 'Netherlands', it: 'Italy', ca: 'Canada', au: 'Australia', mx: 'Mexico', ch: 'Switzerland', dk: 'Denmark', se: 'Sweden', sg: 'Singapore', nz: 'New Zealand', be: 'Belgium', lu: 'Luxembourg', ie: 'Ireland'
  ,ng:'Nigeria', pk:'Pakistan', bd:'Bangladesh', np:'Nepal', ke:'Kenya', za:'South Africa', gh:'Ghana',
  eg:'Egypt', ma:'Morocco', ph:'Philippines', vn:'Vietnam', id:'Indonesia'
  ,dz:'Algeria', tn:'Tunisia', et:'Ethiopia', tz:'Tanzania', ug:'Uganda', sn:'Senegal', cm:'Cameroon',
  zw:'Zimbabwe', zm:'Zambia', rw:'Rwanda', ci:'Ivory Coast', mz:'Mozambique', mg:'Madagascar', sd:'Sudan',
  ao:'Angola', lk:'Sri Lanka', cz:'Czechia', czech:'Czechia', 'czech republic':'Czechia'
  ,no:'Norway', norge:'Norway'
};

/** Canonical target for an alias spelling, or null when the value is not an alias. */
export function countryAliasTarget(normalized: string): string | null {
  return COUNTRY_ALIASES[normalized] ?? null;
}
