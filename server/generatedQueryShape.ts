/**
 * Shape policy for provider-generated native search phrases.
 *
 * Most languages use whitespace-delimited words, so the bounded contract is
 * 2-6 tokens. Japanese, Chinese, and Korean searches are commonly written as
 * one unspaced surface; splitting on whitespace would reject every valid
 * phrase. For a single unspaced surface, use a bounded character count
 * instead. Script compatibility and trading semantics remain separate gates.
 */
export interface GeneratedQueryShape {
  tokens: number;
  characters: number;
  unspaced: boolean;
  bounded: boolean;
}

const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function generatedQueryShape(term: string): GeneratedQueryShape {
  const normalized = String(term || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const tokens = normalized ? normalized.split(/\s+/u).filter(Boolean).length : 0;
  const characters = [...normalized].filter(character => /[\p{L}\p{N}]/u.test(character)).length;
  const unspaced = UNSPACED_SCRIPT.test(normalized);
  const bounded = unspaced && tokens === 1
    ? characters >= 2 && characters <= 20
    : tokens >= 2 && tokens <= 6;
  return { tokens, characters, unspaced, bounded };
}
