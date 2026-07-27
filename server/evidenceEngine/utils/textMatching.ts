/**
 * Robust Text Matching Utility for Evidence Engine
 * Handles word boundary matching for English/European tickers/words
 * and substring matching for CJK (Chinese, Japanese, Korean) and special phrases.
 */

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Check if string contains CJK (Chinese, Japanese, Korean) characters
function hasCJK(text: string): boolean {
  return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]/.test(text);
}

/**
 * Safely checks if `text` contains `term` matching full word boundaries for short alphanumeric terms (like ES, NQ, CL, NG, B3),
 * while supporting substring matches for CJK characters and multi-word phrases.
 */
export function textMatchesTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase().trim();

  if (lowerTerm.length === 0) return false;

  // 1. If term is CJK or contains spaces/symbols, substring check is appropriate
  if (hasCJK(lowerTerm) || lowerTerm.includes(' ') || lowerTerm.includes('-') || lowerTerm.includes('/') || lowerTerm.includes('*')) {
    return lowerText.includes(lowerTerm);
  }

  // 2. For short single-word alphanumeric terms (e.g. "ng", "es", "cl", "ym", "btc"), enforce word boundary
  if (lowerTerm.length <= 4) {
    const regex = new RegExp(`\\b${escapeRegExp(lowerTerm)}\\b`, 'i');
    return regex.test(lowerText);
  }

  // 3. For longer terms without spaces, use word boundary or substring
  const regex = new RegExp(`\\b${escapeRegExp(lowerTerm)}\\b`, 'i');
  return regex.test(lowerText) || lowerText.includes(lowerTerm);
}
