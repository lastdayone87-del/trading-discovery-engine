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
  'group', 'private', 'trading room', 'trading floor', 'chat', 'club',
  'signal', 'signals', 'academy', 'mastermind', 'mentor',
  'whop', 'skool', 'circle', 'patreon',
  // German
  'beitreten', 'mitglied', 'mitglieder', 'gemeinschaft', 'gruppe', 'privat',
  'signale', 'zugang', 'community',
  // French
  'communauté', 'communaute', 'rejoindre', 'adhérer', 'adherer', 'membre', 'membres', 'groupe',
  'privé', 'prive', 'signaux', 'accès', 'acces', 'salon',
  // Dutch
  'gemeenschap', 'lid worden', 'leden', 'groep', 'privé', 'prive',
  'signalen', 'toegang',
  // Danish
  'fællesskab', 'faellesskab', 'deltag', 'medlem', 'medlemmer', 'gruppe',
  'signaler', 'adgang',
  // Norwegian
  'fellesskap', 'bli med', 'medlem', 'medlemmer', 'gruppe', 'signaler',
  'tilgang',
  // Swedish
  'gemenskap', 'gå med', 'ga med', 'medlem', 'medlemmar', 'grupp',
  'signaler', 'åtkomst', 'atkomst',
  // Arabic
  'ديسكورد', 'مجتمع', 'انضم', 'عضو', 'أعضاء', 'مجموعة', 'خاص', 'دردشة',
  'إشارات', 'وصول',
  // Chinese
  '社区', '社群', '加入', '会员', '成员', '群组', '私密', '聊天', '信号', '访问',
  // Irish
  'pobal', 'comhphobal', 'páirt a ghlacadh', 'pairt a ghlacadh', 'ball',
  'baill', 'grúpa', 'grupa', 'príobháideach', 'priobhaideach', 'comhrá',
  'comhra', 'comharthaí', 'comharthai', 'rochtain',
  // Luxembourgish
  'communautéit', 'communautit', 'matmaachen', 'member', 'memberen',
  'grupp', 'privat', 'signaler', 'zougang',
  // Extra high-volume languages
  'comunidad', 'unirse', 'miembro', 'grupo', 'privado', 'señales', 'senales',
  'acceso', 'comunidade', 'entrar', 'membro', 'privado', 'sinais', 'acesso',
  'comunità', 'comunita', 'unisciti', 'membro', 'gruppo', 'privato',
  'segnali', 'accesso', 'コミュニティ', '参加', 'メンバー', 'グループ',
  'プライベート', 'チャット', 'シグナル', 'アクセス',
];

export const MULTILINGUAL_WEAK_COMMUNITY_TERMS: readonly string[] = [
  // English
  'links', 'social', 'contact', 'about', 'resources', 'support',
  // German
  'links', 'kontakt', 'über uns', 'uber uns', 'ressourcen', 'hilfe',
  // French
  'liens', 'contact', 'à propos', 'a propos', 'ressources', 'aide',
  // Dutch
  'links', 'contact', 'over ons', 'bronnen', 'hulp',
  // Danish
  'links', 'kontakt', 'om os', 'ressourcer', 'hjælp', 'hjaelp',
  // Norwegian
  'lenker', 'kontakt', 'om oss', 'ressurser', 'hjelp',
  // Swedish
  'länkar', 'lankar', 'kontakt', 'om oss', 'resurser', 'hjälp', 'hjalp',
  // Arabic
  'روابط', 'اتصل', 'حول', 'موارد', 'دعم',
  // Chinese
  '链接', '联系', '关于', '资源', '支持',
  // Irish
  'naisc', 'teagmháil', 'teagmhail', 'fúinn', 'fuinn', 'acmhainní', 'acmhainni', 'tacaíocht', 'tacaiocht',
  // Luxembourgish
  'linken', 'kontakt', 'iwwer eis', 'ressourcen', 'ënnerstëtzung', 'ennerstetzung',
  // Extra
  'enlaces', 'contacto', 'sobre nosotros', 'recursos', 'ayuda',
  'links', 'contato', 'sobre', 'recursos', 'ajuda',
  'link', 'contatto', 'chi siamo', 'risorse', 'supporto',
  'リンク', 'お問い合わせ', '概要', 'リソース', 'サポート',
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(terms: readonly string[]): RegExp {
  // De-duplicate and sort longest-first so multi-word phrases win over their
  // single-word substrings (e.g. "trading room" before "room").
  const unique = [...new Set(terms.map(term => term.trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return new RegExp(`(?:${unique.map(escapeRegex).join('|')})`, 'i');
}

export const MULTILINGUAL_STRONG_COMMUNITY_EVIDENCE = termRegex(MULTILINGUAL_STRONG_COMMUNITY_TERMS);
export const MULTILINGUAL_WEAK_COMMUNITY_EVIDENCE = termRegex(MULTILINGUAL_WEAK_COMMUNITY_TERMS);

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
