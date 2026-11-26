import { domainToUnicode } from 'node:url';

/**
 * Central multilingual community lexicon.
 *
 * One source of truth for static navigation scoring, cross-origin destination
 * admission, rendered control matching, and relevance hints. The crawler
 * supports 17 countries; English-only matching was measured missing 12/13
 * non-English CTA fixtures and all 10 supported non-English languages.
 *
 * Terms are literal phrases, not word stems. `strong` terms justify opening an
 * unknown cross-origin host; `weak` terms only order known/same-origin links
 * and must never open an arbitrary host by themselves.
 */

export const MULTILINGUAL_STRONG_COMMUNITY_TERMS: readonly string[] = [
  // English / platform identities
  'discord', 'community', 'join', 'member', 'members', 'membership', 'vip',
  'group', 'private', 'trading room', 'trading floor', 'trading club', 'chat',
  'signal', 'signals', 'academy', 'mastermind', 'mentor', 'invite', 'invites',
  'whop', 'skool', 'circle', 'patreon',
  // German
  'beitreten', 'mitglied', 'mitglieder', 'gemeinschaft', 'gruppe', 'privat',
  'signale', 'community',
  // French
  'communauté', 'communaute', 'rejoindre', 'adhérer', 'adherer', 'membre', 'membres', 'groupe',
  'privé', 'prive', 'signaux', 'salon',
  // Dutch
  'gemeenschap', 'lid worden', 'leden', 'groep', 'privé', 'prive',
  'signalen',
  // Danish
  'fællesskab', 'faellesskab', 'deltag', 'medlem', 'medlemmer', 'gruppe',
  'signaler',
  // Norwegian
  'fellesskap', 'bli med', 'medlem', 'medlemmer', 'gruppe', 'signaler',
  // Swedish
  'gemenskap', 'gå med', 'ga med', 'medlem', 'medlemmar', 'grupp',
  'signaler',
  // Arabic
  'ديسكورد', 'مجتمع', 'انضم', 'عضو', 'أعضاء', 'مجموعة', 'خاص', 'دردشة',
  'إشارات',
  // Chinese
  '社区', '社群', '加入', '会员', '成员', '群组', '私密', '聊天', '信号',
  // Irish
  'pobal', 'comhphobal', 'páirt a ghlacadh', 'pairt a ghlacadh',
  'grúpa', 'grupa', 'príobháideach', 'priobhaideach', 'comhrá',
  'comhra', 'comharthaí', 'comharthai',
  // Luxembourgish
  'communautéit', 'communautit', 'matmaachen', 'member', 'memberen',
  'grupp', 'privat', 'signaler',
  // Extra high-volume languages
  'comunidad', 'unirse', 'miembro', 'grupo', 'privado', 'señales', 'senales',
  'comunidade', 'membro', 'privado', 'sinais',
  'comunità', 'comunita', 'unisciti', 'membro', 'gruppo', 'privato',
  'segnali', 'コミュニティ', '参加', 'メンバー', 'グループ',
  'プライベート', 'チャット', 'シグナル',
];

export const MULTILINGUAL_WEAK_COMMUNITY_TERMS: readonly string[] = [
  // English
  'links', 'social', 'contact', 'about', 'resources', 'support', 'access', 'club',
  // German
  'links', 'kontakt', 'über uns', 'uber uns', 'ressourcen', 'hilfe', 'zugang',
  // French
  'liens', 'contact', 'à propos', 'a propos', 'ressources', 'aide', 'accès', 'acces',
  // Dutch
  'links', 'contact', 'over ons', 'bronnen', 'hulp', 'toegang',
  // Danish
  'links', 'kontakt', 'om os', 'ressourcer', 'hjælp', 'hjaelp', 'adgang',
  // Norwegian
  'lenker', 'kontakt', 'om oss', 'ressurser', 'hjelp', 'tilgang',
  // Swedish
  'länkar', 'lankar', 'kontakt', 'om oss', 'resurser', 'hjälp', 'hjalp',
  'åtkomst', 'atkomst',
  // Arabic
  'روابط', 'اتصل', 'حول', 'موارد', 'دعم', 'وصول',
  // Chinese
  '链接', '联系', '关于', '资源', '支持', '访问',
  // Irish
  'naisc', 'teagmháil', 'teagmhail', 'fúinn', 'fuinn', 'acmhainní', 'acmhainni', 'tacaíocht', 'tacaiocht',
  'ball', 'baill', 'rochtain',
  // Luxembourgish
  'linken', 'kontakt', 'iwwer eis', 'ressourcen', 'ënnerstëtzung', 'ennerstetzung', 'zougang',
  // Extra
  'enlaces', 'contacto', 'sobre nosotros', 'recursos', 'ayuda', 'acceso',
  'links', 'contato', 'sobre', 'recursos', 'ajuda', 'acesso', 'entrar',
  'link', 'contatto', 'chi siamo', 'risorse', 'supporto', 'accesso',
  'リンク', 'お問い合わせ', '概要', 'リソース', 'サポート', 'アクセス',
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LATIN_TERM = /^[\p{Script=Latin}\p{N}\s'’\-_.&]+$/u;

function termPattern(term: string): string {
  const escaped = escapeRegex(term);
  // Non-Latin scripts use no word boundaries: CJK terms are not
  // space-delimited and Arabic commonly attaches prefixes/suffixes.
  if (!LATIN_TERM.test(term)) return escaped;
  // Start boundary prevents ordinary English words from matching inside
  // larger ones (`remember` -> member, `football` -> ball, `chatgpt` -> chat).
  // A small suffix set keeps common inflections (joining, members, clubs)
  // without opening arbitrary substrings. Property escapes cover accents.
  return `(?<![\\p{L}\\p{N}])${escaped}(?:s|es|ed|ing)?(?![\\p{L}\\p{N}])`;
}

function termRegex(terms: readonly string[]): RegExp {
  // De-duplicate and sort longest-first so multi-word phrases win over their
  // single-word substrings (e.g. "trading room" before "room").
  const unique = [...new Set(terms.map(term => term.trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return new RegExp(`(?:${unique.map(termPattern).join('|')})`, 'iu');
}

export const MULTILINGUAL_STRONG_COMMUNITY_EVIDENCE = termRegex(MULTILINGUAL_STRONG_COMMUNITY_TERMS);
export const MULTILINGUAL_WEAK_COMMUNITY_EVIDENCE = termRegex(MULTILINGUAL_WEAK_COMMUNITY_TERMS);

/** URL-slug evidence. Path segments concatenate words (`/vipintraders`,
 * `/tradingroom`), so token-boundary anchor matching alone misses them. Kept
 * to distinctive community terms; generic prose words stay out. */
/** Decode percent-encoded path text for lexicon matching. Malformed escapes
 * fall back to the raw value; this never performs a network or filesystem
 * operation. */
export function decodeCommunityUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Decode only the hostname and pathname of an absolute URL. Query/fragment
 * text is never community evidence: encoded redirect or tracking parameters
 * must not make an unrelated destination look like a community page. */
export function decodeCommunityUrlPath(value: string): string {
  try {
    // A base accepts relative references from rendered-control callers while
    // still discarding their query/fragment text.
    const parsed = new URL(value, 'https://placeholder.invalid');
    let host = parsed.hostname;
    try { host = domainToUnicode(host); } catch { /* keep punycode */ }
    return `${decodeCommunityUrl(host)} ${decodeCommunityUrl(parsed.pathname)}`;
  } catch {
    return decodeCommunityUrl(value.split(/[?#]/, 1)[0]);
  }
}

export const communityUrlEvidence = decodeCommunityUrlPath;

export const MULTILINGUAL_URL_COMMUNITY_EVIDENCE = new RegExp(
  '(?:^|[/._-])(?:'
  + '(?:discord|community|join|invites?|vip|trading[-_ ]?(?:room|floor|club)|signals?|skool|whop|circle|patreon|comunidad|comunidade|communaut[eé]|gemeinschaft|gemeenschap|fellesskap|gemenskap|pobal|comhphobal|communautéit|comunità)'
  + '|(?:members?|groups?|priv(?:ate|é|e)|club)(?![a-z])'
  + ')',
  'i',
);

/**
 * Rendered control hints: strong multilingual terms plus the original weak
 * set. The broader weak lexicon is intentionally NOT used here: adding
 * generic terms such as `resources`/`support` changes click-skip and enqueue
 * semantics for ordinary site chrome. Kept as one regex because Playwright
 * serializes `.source` into the page.
 */
export const MULTILINGUAL_CONTROL_HINTS = termRegex([
  ...MULTILINGUAL_STRONG_COMMUNITY_TERMS,
  'links', 'link', 'social', 'contact', 'about',
  'premium', 'paid', 'subscribe', 'subscription', 'signals', 'mentor', 'access',
]);

/** Ordered path/anchor hints for the static community-navigation score. */
export const MULTILINGUAL_PATH_HINTS: readonly string[] = [
  ...new Set([
    ...MULTILINGUAL_STRONG_COMMUNITY_TERMS,
    ...MULTILINGUAL_WEAK_COMMUNITY_TERMS,
  ]),
];

/** True when text carries strong community evidence in any supported language. */
export function hasMultilingualStrongCommunityEvidence(text: string): boolean {
  return MULTILINGUAL_STRONG_COMMUNITY_EVIDENCE.test(String(text || ''));
}

/** True when text carries weak community evidence in any supported language. */
export function hasMultilingualWeakCommunityEvidence(text: string): boolean {
  return MULTILINGUAL_WEAK_COMMUNITY_EVIDENCE.test(String(text || ''));
}
