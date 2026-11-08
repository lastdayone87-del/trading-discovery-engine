import { normalizeMatchToken } from './textMatching';

/**
 * Scoped claim polarity.
 *
 * Deterministic providers historically matched a substring anywhere in a
 * creator-owned document. That makes a disclaimer ("No guaranteed profits")
 * indistinguishable from an asserted claim ("Guaranteed profits"), and it makes
 * "I don't trade" look like positive trading evidence. This module resolves the
 * polarity of an individual term occurrence within its sentence/clause, using
 * bounded before/after windows, contrastive-clause boundaries, negation cues,
 * disclaimer frames, quotation/attribution frames, and hypothetical markers.
 *
 * The module is deliberately pure and dependency-free. Callers decide whether a
 * non-ASSERTED match is suppressed (zero weight) or merely annotated.
 */
export const CLAIM_POLARITY_VERSION = 'claim-polarity-v1';

export type ClaimPolarity =
  | 'ASSERTED'
  | 'NEGATED'
  | 'DISCLAIMER'
  | 'QUOTED'
  | 'HYPOTHETICAL'
  | 'UNCERTAIN';

export interface ScopedTermMatch {
  term: string;
  start: number;
  end: number;
  polarity: ClaimPolarity;
  cue?: string;
  confidence: number;
}

type LanguageCode =
  | 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl'
  | 'da' | 'sv' | 'no' | 'ar' | 'zh' | 'ms' | 'ja';

const NEGATION_CUES: Record<LanguageCode, string[]> = {
  en: ['no', 'not', 'never', 'without', 'zero', 'none', 'nobody', 'nothing', "don't", 'doesn\'t', 'didn\'t', "isn't", "aren't", "won't", "can't", 'cannot', 'neither', 'nor'],
  de: ['kein', 'keine', 'keinen', 'keinem', 'keiner', 'nicht', 'nie', 'niemals', 'ohne', 'niemand', 'nichts'],
  fr: ['pas', 'aucun', 'aucune', 'sans', 'ne', "n'", 'jamais', 'non', 'personne', 'rien'],
  es: ['no', 'sin', 'nunca', 'jamás', 'nadie', 'ni', 'ningún', 'ninguna', 'nada'],
  it: ['non', 'senza', 'mai', 'nessun', 'nessuna', 'niente', 'nulla', 'neppure', 'nemmeno'],
  nl: ['geen', 'niet', 'nooit', 'zonder', 'niemand', 'niets'],
  da: ['ingen', 'intet', 'ikke', 'aldrig', 'uden'],
  sv: ['ingen', 'inget', 'inte', 'aldrig', 'utan'],
  no: ['ingen', 'intet', 'ikke', 'aldri', 'uten'],
  ar: ['لا', 'ليس', 'ليست', 'بدون', 'أبدا', 'أبداً', 'لن'],
  zh: ['不是', '不', '没有', '無', '无', '从未', '從未', '绝不', '絕不'],
  ms: ['tidak', 'bukan', 'jangan', 'tanpa', 'tiada'],
  ja: ['ない', 'ません', 'なし', '無し', '決して', '绝不', 'ではない'],
};

const HYPOTHETICAL_CUES: Record<LanguageCode, string[]> = {
  // Bare conditionals ("if", "when", "si", "se", "wenn") are ordinary creator
  // framing ("If you want to learn day trading"). Only explicit hypothetical
  // frames qualify.
  en: ['imagine', 'suppose', 'supposing', 'what if', 'hypothetically', 'pretend', 'would', 'could', 'might'],
  de: ['stell dir vor', 'angenommen', 'würde', 'könnte'],
  fr: ['imaginez', 'imagine', 'supposons', 'pourrait', 'serait', 'peut-être'],
  es: ['imagina', 'supongamos', 'podría', 'sería', 'quizás', 'tal vez'],
  it: ['immagina', 'supponiamo', 'potrebbe', 'sarebbe', 'forse'],
  nl: ['stel je voor', 'veronderstel', 'zou', 'zou kunnen', 'misschien'],
  da: ['forestil dig', 'antag', 'ville', 'kunne', 'måske'],
  sv: ['föreställ dig', 'anta', 'skulle', 'kunde', 'kanske'],
  no: ['forestill deg', 'anta', 'ville', 'kunne', 'kanskje'],
  ar: ['إذا', 'لو', 'تخيل', 'قد', 'ربما'],
  zh: ['如果', '假如', '想象', '可能', '也许', '也許'],
  ms: ['bayangkan', 'mungkin', 'andaikan'],
  ja: ['想像', 'かもしれない', 'だろう'],
};

const CRITICISM_CUE = /\b(?:scam(?:mers?|med)?|fake|fraud(?:ulent)?|beware|avoid|myth|debunk(?:ed|ing)?|so-called|snake\s*oil|too\s*good\s*to\s*be\s*true|misleading|lies?|red\s*flags?)\b/iu;
const ATTRIBUTION_CUE = /\b(?:they|these|those|gurus?|scammers?|courses?|sellers?|promoters?|influencers?)\b[^.!?;\n]{0,48}\b(?:say|says|promise|promises|promised|claim|claims|claimed|sell|sells|teach|teaches)\b/iu;
// Criticism/quotation framing only neutralizes claim-like language. "Avoid
// fake breakouts with order flow" is asserted education, not a quoted hype
// claim about order flow.
const CLAIM_LIKE_TERM = /\b(?:guaranteed?|profits?|returns?|gains?|rich|wealth|money|gems?|moonshots?|100x|bitcoin|crypto|signals?|courses?|mentors?|hype|wins?)\b/iu;
const POST_NEGATION = /^\s*(?:[?!.,:;\-–—]+\s*)?(?:no|nope|not|never|false|myth|wrong|incorrect|pas|non|nein|kein|inte|ikke|aldrig|nunca|mai)\b/iu;
const POST_DENIAL = /\b(?:is|are|was|were)\s+(?:a\s+)?(?:myth|lie|false|not\s+true|incorrect|wrong)\b/iu;
const ASSERTIVE_NEGATION_FRAME = /\b(?:no\s+(?:bs|b\.s\.|nonsense|fluff|hype|shortcuts?)|zero\s+to\s+(?:hero|pro|funded|profit))\b/iu;
const POST_CRITICISM = /(?:\b(?:is|are|was|were|sounds?|seems?)\s+(?:a\s+|an\s+)?(?:scam|fraud|myth|lie|red\s*flag|fake|misleading)\b|\b(?:red\s*flags?|too\s*good\s*to\s*be\s*true)\b)/iu;
const CONTRAST_CUE = /(?:\b(?:but|however|yet|although|though|whereas|nevertheless|nonetheless|mais|aber|pero|però|ma|doch|men|maar|mas)\b|(?:но|但|但是|しかし))/iu;
// `and` only starts a new clause when it introduces a new predicate/subject;
// noun coordination ("stocks and crypto") stays inside the negation scope.
const COORDINATION_CUE = /\b(?:and|&)\s+(?=(?:i|we|you|they|he|she|it)\b|(?:teach|learn|trade|show|share|explain|post|upload|run|make|offer|provide|help|cover|analy[sz]e|review|discuss|focus|talk|stream|prefer)\b)/iu;
const POST_HYPOTHETICAL = /^\s*(?:could|would|might|may|hypothetically|in\s+theory)\b/iu;

const DISCLAIMER_PATTERNS: RegExp[] = [
  /\b(?:no|not|never|without)\s+(?:financial|investment|trading|tax)\s+advice\b/iu,
  /\bnot\s+(?:a\s+)?(?:financial|investment|trading|tax)\s+advice\b/iu,
  /\bpast\s+performance\b/iu,
  /\brisk\s+of\s+(?:loss|ruin|capital\s+loss)\b/iu,
  /\bfor\s+educational\s+purposes?\s+only\b/iu,
  /\beducational\s+purposes?\s+only\b/iu,
  /\bno\s+hype\b/iu,
  /\b(?:don'?t|do\s+not|never)\s+sell\s+(?:courses?|signals?|mentoring)\b/iu,
  /\b(?:no|without|zero)\s+(?:guaranteed\s+)?(?:profits?|returns?|gains?|wins?)\b/iu,
  /\bnot\s+(?:guaranteed|a\s+guarantee)\b/iu,
  /\bkein(?:e|en|em|er)?\s+(?:anlageberatung|garantie|garantierten?)\b/iu,
  /\bnicht\s+(?:garantiert|finanzberatung)\b/iu,
  /\bpas\s+(?:de\s+)?(?:conseil|garantie|gain)\b/iu,
  /\baucun(?:e)?\s+(?:conseil|garantie|gain)\b/iu,
  /\bsin\s+(?:asesoramiento|garantía|ganancias)\b/iu,
  /\bno\s+es\s+(?:asesoramiento|garantía)\b/iu,
  /\bnon\s+è\s+(?:consulenza|garanzia)\b/iu,
  /\bnessun(?:a)?\s+(?:consulenza|garanzia|profitto)\b/iu,
  /\bgeen\s+(?:financieel\s+advies|garantie|winst)\b/iu,
  /\bikke\s+(?:finansiel\s+rådgivning|garanti)\b/iu,
  /\bing(?:en)?\s+(?:garanti|finansiell\s+rådgivning)\b/iu,
  /(?<![\p{L}\p{N}])(?:لا|ليس)\s+(?:نصيحة|ضمان|ربح)(?![\p{L}\p{N}])/u,
  /(?:不是|没有|無|无)\s*(?:投资建议|投資建議|保证|保證|盈利)/u,
  /(?<![\p{L}\p{N}])(?:担保|保証|保證)\s*(?:は|が)?\s*(?:ありません|ない|なし)/u,
  /(?:过去|過去)?的表现(?:并|並)?不代表(?:未来|未來)?(?:收益|表现|表現)?/u,
  /\bbukan\s+(?:nasihat|jaminan)\b/iu,
  /(?:投資助言ではありません|必ず儲かることはありません|保証はありません)/u,
];

const DISCLAIMER_GLOBAL_PATTERNS = DISCLAIMER_PATTERNS.map(pattern =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
);

function normalizeWithApostrophes(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

function hasCJK(value: string): boolean {
  return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\u1100-\u11ff\u3130-\u318f]/u.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cueRegex(cues: string[]): RegExp | null {
  if (!cues.length) return null;
  // CJK/Arabic cues are matched as literals; Latin phrase cues get word
  // boundaries so "no" cannot match inside "notable".
  const sources = cues.map(cue => {
    const escaped = escapeRegExp(cue);
    if (/^[\x00-\x7F\s'-]+$/.test(cue)) {
      // French elision ("n'est") attaches the cue directly to a letter.
      if (/['’]$/.test(cue)) return `(?<![\\p{L}\\p{N}])${escaped}(?=\\p{L})`;
      return `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
    }
    return escaped;
  });
  return new RegExp(sources.join('|'), 'iu');
}

const CUE_REGEX_CACHE = new Map<string, RegExp | null>();

function languageKeys(text: string, language?: string): LanguageCode[] {
  const explicit = String(language || '').toLowerCase().split(/[-_]/)[0] as LanguageCode;
  if (explicit && NEGATION_CUES[explicit]) return [explicit];
  if (/[\u0600-\u06ff]/u.test(text)) return ['ar'];
  if (/[\u3040-\u30ff]/u.test(text)) return ['ja'];
  if (/[\u4e00-\u9fff]/u.test(text)) return ['zh'];
  // Latin-script text without a language hint: check every Latin cue pack.
  return ['en', 'de', 'fr', 'es', 'it', 'nl', 'da', 'sv', 'no', 'ms'];
}

function combinedCueRegex(
  text: string,
  language: string | undefined,
  table: Record<LanguageCode, string[]>,
): RegExp | null {
  const keys = languageKeys(text, language);
  const kind = table === NEGATION_CUES ? 'neg' : table === HYPOTHETICAL_CUES ? 'hyp' : 'other';
  const cacheKey = `${kind}:${keys.join(',')}`;
  const cached = CUE_REGEX_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const cues = [...new Set(keys.flatMap(code => table[code] || []))];
  const regex = cueRegex(cues);
  CUE_REGEX_CACHE.set(cacheKey, regex);
  return regex;
}

interface ClauseBounds { start: number; end: number }

/**
 * Sentence/clause bounds. Punctuation and line breaks end a clause; contrastive
 * conjunctions start a new one, so "No shortcuts, but guaranteed profits"
 * cannot let the first clause's negation suppress the second clause's claim.
 */
function clauseBounds(text: string, start: number, end: number): ClauseBounds {
  let left = start;
  while (left > 0 && !/[.!?;,\n:]/.test(text[left - 1])) left--;
  const before = text.slice(left, start);
  const splitAt = (regex: RegExp): number => {
    const matches = [...before.matchAll(new RegExp(regex.source, 'giu'))];
    const last = matches[matches.length - 1];
    return last && last.index !== undefined ? left + last.index + last[0].length : left;
  };
  left = Math.max(splitAt(CONTRAST_CUE), splitAt(COORDINATION_CUE));
  let right = end;
  while (right < text.length && !/[.!?;,\n:]/.test(text[right])) right++;
  return { start: left, end: right };
}

function closestCue(regex: RegExp, window: string): string | undefined {
  const matches = [...window.matchAll(new RegExp(regex.source, 'giu'))];
  return matches.length ? matches[matches.length - 1][0] : undefined;
}

function findOverlappingDisclaimer(
  text: string,
  start: number,
  end: number,
): string | undefined {
  for (const pattern of DISCLAIMER_GLOBAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;
      if (matchStart >= end) break;
      // Only the term that is part of the disclaimer frame is neutralized.
      // "No guaranteed profits. I teach order flow." must not suppress the
      // second sentence's trading evidence.
      if (matchStart < end && matchEnd > start) return match[0];
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return undefined;
}

function isInsideQuotes(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 2), start);
  // The matched term can be a prefix of the quoted word ("guaranteed profit"
  // inside "guaranteed profits"), so allow a short suffix before the closing
  // quotation mark.
  const after = text.slice(end, Math.min(text.length, end + 8));
  return /["“”'‘’]\s*$/u.test(before) && /^[\p{L}\p{N}]{0,4}\s*["“”'‘’]/u.test(after);
}

/**
 * Resolve the polarity of one term span. The returned cue is diagnostic only.
 */
export function classifyClaimPolarity(
  text: string,
  start: number,
  end: number,
  language?: string,
): { polarity: ClaimPolarity; cue?: string; confidence: number } {
  if (!text || start < 0 || end <= start) return { polarity: 'UNCERTAIN', confidence: 0.2 };
  const normalized = normalizeWithApostrophes(text);
  const bounds = clauseBounds(normalized, start, end);
  // Negation must be close to the term it scopes. A whole-clause window makes
  // "This channel is not financial advice; here is my trading strategy" suppress
  // the strategy term in a different clause, and a 140-character window makes
  // an early negation swallow every later claim in the same sentence.
  const before = normalized.slice(Math.max(bounds.start, start - 80), start);
  const afterClause = normalized.slice(end, Math.min(bounds.end, end + 80));
  const afterImmediate = normalized.slice(end, Math.min(normalized.length, end + 32));
  const sameClauseAfter = normalized.slice(end, Math.min(bounds.end, end + 40));
  const nearbyWindow = normalized.slice(Math.max(0, start - 180), Math.min(normalized.length, end + 180));

  // An explicit disclaimer frame outranks a bare negation cue: "No guaranteed
  // profits" is a warning, not an asserted promise. It only applies when the
  // matched term is actually part of that frame.
  const disclaimer = findOverlappingDisclaimer(normalized, start, end);
  if (disclaimer) return { polarity: 'DISCLAIMER', cue: disclaimer, confidence: 0.95 };

  // Post-negation: "Guaranteed profits? No." The answer must be in the same
  // clause, or immediately after a question/exclamation; a period starts a
  // new sentence and must not let "Day trading. Not financial advice." negate
  // the earlier claim.
  if (POST_NEGATION.test(sameClauseAfter)) {
    return { polarity: 'NEGATED', cue: sameClauseAfter.trim().slice(0, 24), confidence: 0.9 };
  }
  if (/^[\p{L}\p{N}]{0,4}\s*[?!]\s*(?:no|nope|not|never|false|myth|wrong|incorrect|pas|non|nein|kein|inte|ikke|aldrig|nunca|mai)(?:\s*[.!?,]|$)/iu.test(afterImmediate)) {
    return { polarity: 'NEGATED', cue: afterImmediate.trim().slice(0, 24), confidence: 0.9 };
  }
  if (POST_DENIAL.test(afterClause)) {
    return { polarity: 'NEGATED', cue: closestCue(POST_DENIAL, afterClause), confidence: 0.9 };
  }

  // Quoted criticism: "Scam gurus promise guaranteed profits". Quotation marks
  // alone are not enough; a criticism/attribution frame must be present and the
  // matched term must be claim-like ("order flow" after "avoid fake breakouts"
  // is asserted education, not quoted hype).
  const termLooksLikeClaim = CLAIM_LIKE_TERM.test(normalized.slice(start, end));
  const quotationFrame = CRITICISM_CUE.test(nearbyWindow) || ATTRIBUTION_CUE.test(nearbyWindow);
  const attributionBefore = ATTRIBUTION_CUE.test(before);
  const criticismBefore = CRITICISM_CUE.test(before);
  if (quotationFrame && (attributionBefore || (termLooksLikeClaim && criticismBefore))) {
    const cue = (ATTRIBUTION_CUE.exec(before) || CRITICISM_CUE.exec(before) || [undefined])[0];
    return { polarity: 'QUOTED', cue, confidence: 0.88 };
  }
  if (isInsideQuotes(normalized, start, end)
    && (ATTRIBUTION_CUE.test(nearbyWindow) || (termLooksLikeClaim && CRITICISM_CUE.test(nearbyWindow)))) {
    const cue = (ATTRIBUTION_CUE.exec(nearbyWindow) || CRITICISM_CUE.exec(nearbyWindow) || [undefined])[0];
    return { polarity: 'QUOTED', cue, confidence: 0.85 };
  }
  // Post-term criticism: "Guaranteed profits are a red flag" is criticism of
  // the claim, not an asserted promise. Require a predicate that describes the
  // term, not any later criticism of another subject.
  if (termLooksLikeClaim && POST_CRITICISM.test(afterClause)) {
    return { polarity: 'QUOTED', cue: closestCue(POST_CRITICISM, afterClause), confidence: 0.84 };
  }

  const negation = combinedCueRegex(before, language, NEGATION_CUES);
  if (negation) {
    const cue = closestCue(negation, before);
    // "not only X" asserts X; do not treat it as negation.
    if (cue && /\bnot\s+only\s*$/iu.test(before)) {
      return { polarity: 'ASSERTED', confidence: 0.6 };
    }
    // "No BS Forex", "Zero to Hero Forex" are assertive creator framing, not
    // denials of the trading claim that follows. Only skip the cue when the
    // cue itself sits inside the assertive frame.
    const assertiveFrame = ASSERTIVE_NEGATION_FRAME.exec(before);
    const cueIndex = cue ? before.lastIndexOf(cue) : -1;
    if (cue && assertiveFrame && cueIndex < assertiveFrame.index + assertiveFrame[0].length) {
      // fall through to hypothetical/assertion
    } else if (cue) {
      return { polarity: 'NEGATED', cue, confidence: 0.9 };
    }
  }

  const hypothetical = combinedCueRegex(before, language, HYPOTHETICAL_CUES);
  if (hypothetical) {
    const cue = closestCue(hypothetical, before);
    if (cue) return { polarity: 'HYPOTHETICAL', cue, confidence: 0.8 };
  }
  // Post-term hypotheticals must describe the matched activity: "Trading
  // could happen" is hypothetical, while "I teach day trading so you could
  // learn" is an asserted teaching claim.
  if (POST_HYPOTHETICAL.test(afterClause)) {
    return { polarity: 'HYPOTHETICAL', cue: afterClause.trim().slice(0, 24), confidence: 0.75 };
  }

  // A negation cue after a contrastive conjunction applies to the other clause,
  // not this one; clauseBounds already split there. If no cue survives, the
  // term is an asserted claim.
  return { polarity: 'ASSERTED', confidence: 0.9 };
}

const TERM_PATTERN_CACHE = new Map<string, RegExp>();

function termPattern(term: string): RegExp {
  const cached = TERM_PATTERN_CACHE.get(term);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  const escaped = escapeRegExp(term);
  let pattern: RegExp;
  if (hasCJK(term) || /[\s\-/*]/u.test(term)) {
    pattern = new RegExp(escaped, 'giu');
  } else if (term.length <= 4) {
    pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  } else {
    pattern = new RegExp(escaped, 'giu');
  }
  TERM_PATTERN_CACHE.set(term, pattern);
  return pattern;
}

/**
 * Find every occurrence of the supplied terms and classify its polarity.
 * Offsets refer to the NFKC/apostrophe-normalized text. The original term
 * spelling is returned for display and provenance.
 */
export function findScopedTermMatches(
  text: string,
  terms: string[],
  language?: string,
): ScopedTermMatch[] {
  const source = normalizeWithApostrophes(String(text || ''));
  if (!source) return [];
  const haystack = source;
  const matches: ScopedTermMatch[] = [];
  const seen = new Set<string>();
  for (const rawTerm of terms) {
    const term = normalizeWithApostrophes(String(rawTerm || '')).trim();
    if (!term) continue;
    const normalizedTerm = term.toLocaleLowerCase('en');
    const pattern = termPattern(normalizedTerm);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(haystack)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (end <= start) {
        pattern.lastIndex += 1;
        continue;
      }
      const key = `${start}:${end}:${normalizeMatchToken(term)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const polarity = classifyClaimPolarity(source, start, end, language);
      matches.push({ term: String(rawTerm), start, end, ...polarity });
    }
  }
  return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Terms with at least one ASSERTED occurrence, preserving first-seen spelling. */
export function affirmedTerms(text: string, terms: string[], language?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of findScopedTermMatches(text, terms, language)) {
    if (match.polarity !== 'ASSERTED') continue;
    const key = normalizeMatchToken(match.term);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match.term);
  }
  return out;
}

export function hasAffirmedTerm(text: string, terms: string[], language?: string): boolean {
  return findScopedTermMatches(text, terms, language).some(match => match.polarity === 'ASSERTED');
}
