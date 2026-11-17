import type { RawChannelInput } from './types';
import {
  defaultClient,
  type SemanticModelClient,
} from './providers/GeminiSemanticProvider';

export type PrecisionCategory = 'MARKET_INSTITUTION' | 'HYPE' | 'FINANCIAL_NEWS' | 'UNRELATED';

export interface PrecisionGuardResult {
  category: PrecisionCategory;
  source: 'DETERMINISTIC' | 'ADJUDICATOR';
  confidence?: number;
  reasonCodes: string[];
  explanation?: string;
}

export interface PrecisionGuardOptions {
  enabled?: boolean;
  adjudicator?: (input: RawChannelInput, firstLabel: string) => Promise<PrecisionGuardResult | null>;
  client?: SemanticModelClient | null;
}

const PRECISION_CATEGORIES: ReadonlySet<string> = new Set([
  'MARKET_INSTITUTION', 'HYPE', 'FINANCIAL_NEWS', 'UNRELATED',
]);

/**
 * The adjudicator runs only on first-pass relevant channels that survive the
 * deterministic prefilter. It is a separate, conservative model call with its
 * own quota budget; it must never share the candidate classifier's budget.
 */
export const DEFAULT_CATEGORY_ADJUDICATOR_MODEL = 'gemini-3.1-flash-lite';

const EDUCATION = /\b(?:course|learn|learning|education|educational|academy|training|tutorial|guide|lesson|mentor|coaching|explained|how to|strategy|strategies|analysis|backtest)\b/iu;
const FINANCE = /\b(?:trading|trade|trader|forex|fx|stock|stocks|equity|equities|crypto|bitcoin|btc|eth|ethereum|xauusd|market|markets|finance|financial|broker|exchange|portfolio|etf|gold|silver|nasdaq|futures?|options?|fund|wealth|invest|investing|investment|bourse|aktien|acciones|ações|bolsa|investir|investieren|inversión|investimento)\b/iu;
const NON_FINANCE = /\b(?:art|candle|candles|car|cars|comedy|drama|religion|church|god|sports?|football|cricket|fitness|gym|health|software|tutorial|travel|beauty|makeup|music|song|game|gaming|food|recipe|wedding|jewelry|jewellery|design|agency|sales|business|marketing|shop|artist)\b/giu;
const NEWS = /\b(?:news|headlines?|updates?|commentary|interviews?|market recap|daily briefing)\b/iu;
// Analysis intended to inform trading/investing decisions is trading content,
// not news. These terms prevent the news rule from downgrading analysis-only
// channels that happen to mention news or updates in their bio.
const TRADING_ANALYSIS_TERMS = /\b(?:technical analysis|market analysis|analisi tecnica|analyse technique|análisis técnico|analysis|charts?|price action|market structure|support|resistance|trends?|scenarios?|setups?|entries|key levels|levels|trade ideas?|forecast|forecasts|分析|分析技術)\b/iu;
const EDUCATION_TERMS = /\b(?:course|learn|learning|education|educational|academy|training|tutorial|guide|lesson|mentor|coaching|explained|how to)\b/iu;
// Explicit teaching/branding terms only. "Strategy" or "analysis" appear in
// almost every signal-seller bio and must not exempt a signal-first channel.
const EXPLICIT_EDUCATION_TERMS = /\b(?:course|learn|learning|education|educational|academy|training|tutorial|guide|lesson|mentor|coaching)\b/iu;

function decodeEntities(value: unknown): string {
  return String(value || '')
    // Mathematical/stylized Unicode letters are common in trading titles and
    // must not hide finance words from the high-precision checks.
    .normalize('NFKC')
    .replace(/&amp;/giu, '&')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&quot;/giu, '"')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&nbsp;/giu, ' ');
}

function normalizedInput(input: RawChannelInput): { name: string; bio: string; all: string; videoTitles: string[] } {
  const name = decodeEntities(input.channel_name);
  const bio = decodeEntities(input.description);
  const videoTitles = (input.videos?.map(video => video.title) || input.video_titles || []).map(decodeEntities).filter(Boolean);
  return { name, bio, all: `${name} ${bio} ${videoTitles.join(' ')}`.toLocaleLowerCase('en'), videoTitles };
}

/**
 * High-precision only. This guard is allowed to downgrade a first-pass
 * relevant category, never to upgrade. Weak or broad keywords are omitted on
 * purpose: the conservative adjudicator handles anything not unambiguous.
 */
export function deterministicCategoryGuard(input: RawChannelInput): PrecisionGuardResult | null {
  const { name, bio, all, videoTitles } = normalizedInput(input);
  const nameAndBio = `${name} ${bio}`.toLocaleLowerCase('en');

  // HYPE: explicit signals/VIP/promo products. Require a real signal offer:
  // "stress-free" or a free community is not a signal product.
  const signalOffer = /\b(?:free|vip)\s+(?:trading\s+)?signals?\b/iu.test(nameAndBio)
    || (/\b(?:vip|free)\s+(?:telegram|whatsapp|discord)\b/iu.test(nameAndBio) && /\bsignals?\b/iu.test(nameAndBio))
    || /\bsignals?\s+(?:group|channel|service|vip)\b/iu.test(nameAndBio);
  if (signalOffer) {
    return { category: 'HYPE', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_HYPE_VIP_SIGNALS'] };
  }
  if (/\b(?:live trading signals|real[- ]time signals|price action signals|accurate signals)\b/iu.test(all)) {
    return { category: 'HYPE', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_HYPE_SIGNALS'] };
  }
  if (/\b(?:100x|presale|pre-sale|memecoin)\b/iu.test(nameAndBio)
    && /\b(?:promo|telegram|bonus|affiliate|presale)\b/iu.test(nameAndBio)) {
    return { category: 'HYPE', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_HYPE_PROMOTION'] };
  }
  if (/\b(?:official agency|promo agency|cryptopromo)\b/iu.test(nameAndBio)) {
    return { category: 'HYPE', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_HYPE_PROMO_AGENCY'] };
  }
  // A signal-first brand is HYPE unless the brand itself is explicitly an
  // academy/course. Bios almost always contain an "educational purposes"
  // disclaimer, so only the name is safe to inspect here.
  if (/\bsignals?\b/iu.test(name) && !EXPLICIT_EDUCATION_TERMS.test(name)) {
    return { category: 'HYPE', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_HYPE_SIGNAL_CHANNEL'] };
  }
  if (/\btradingreels?\b/iu.test(all)
    && /\b(?:motivation|reels?)\b/iu.test(all)
    && !/\b(?:order flow|bookmap|footprint|live|strategy|strategies)\b/iu.test(all)) {
    return { category: 'HYPE', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_HYPE_REELS'] };
  }

  // MARKET_INSTITUTION: commercial financial product/service/venue.
  if (/\b(?:stock pick service|daily stock pick)\b/iu.test(nameAndBio)) {
    return { category: 'MARKET_INSTITUTION', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_INSTITUTION_STOCK_PICK_SERVICE'] };
  }
  if (/\b(?:prop firm|prop trading|proprietary trading firm)\b/iu.test(nameAndBio)
    && !/\b(?:teach|teacher|education|educational|mentor|mentorship|course|learn|lesson|strategy|strategies)\b/iu.test(nameAndBio)) {
    return { category: 'MARKET_INSTITUTION', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_INSTITUTION_PROP_FIRM'] };
  }
  if (/\bcuentas? (?:son )?simuladas?\b/iu.test(nameAndBio)
    && /\b(?:programas?|recompensas?)\b/iu.test(nameAndBio)) {
    return { category: 'MARKET_INSTITUTION', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_INSTITUTION_SIMULATED_PROGRAMS'] };
  }
  if (/\b(?:automated trading software|autotrader|trading software|trading platform)\b/iu.test(nameAndBio)
    && /\b(?:software|platform|system|service|vendor)\b/iu.test(nameAndBio)) {
    return { category: 'MARKET_INSTITUTION', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_INSTITUTION_TRADING_SOFTWARE'] };
  }
  if (/\b(?:investor events|masterclasses?|conferences?|congress?|beleggersfair)\b/iu.test(nameAndBio)
    && /\b(?:platform|events?|masterclasses?|congress?|fair)\b/iu.test(nameAndBio)) {
    return { category: 'MARKET_INSTITUTION', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_INSTITUTION_EVENTS_PLATFORM'] };
  }
  if (/\b(?:ai narrates|panel completo|quantiva\.live)\b/iu.test(nameAndBio)) {
    return { category: 'MARKET_INSTITUTION', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_INSTITUTION_DATA_PLATFORM'] };
  }

  // FINANCIAL_NEWS: explicit news product, not an educator that publishes updates.
  if (/\bnews\b/iu.test(nameAndBio)
    && /\b(?:daily|updates?|financial market|headlines?)\b/iu.test(nameAndBio)
    && !EDUCATION_TERMS.test(nameAndBio)
    && !TRADING_ANALYSIS_TERMS.test(nameAndBio)) {
    return { category: 'FINANCIAL_NEWS', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_NEWS_PRODUCT'] };
  }

  // UNRELATED: non-financial primary identity, with no finance in the bio and
  // at most one financial video title. This avoids penalising non-English
  // educators whose bio is sparse.
  if (videoTitles.length >= 1 && !FINANCE.test(nameAndBio) && !EDUCATION_TERMS.test(nameAndBio)) {
    const financeTitles = videoTitles.filter(title => FINANCE.test(title)).length;
    const nonFinanceBio = (nameAndBio.match(NON_FINANCE) || []).length;
    const newsTitles = videoTitles.filter(title => NEWS.test(title)).length;
    const liveTitles = videoTitles.filter(title => /\b(?:live|trade recap|setup|entry|exit|signal)\b/iu.test(title)).length;
    if (financeTitles <= 1 && nonFinanceBio >= 2) {
      return { category: 'UNRELATED', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_UNRELATED_PRIMARY_FOCUS'] };
    }
    if (financeTitles <= 1 && newsTitles >= 3 && liveTitles === 0) {
      return { category: 'FINANCIAL_NEWS', source: 'DETERMINISTIC', reasonCodes: ['PRECISION_NEWS_PRIMARY_FOCUS'] };
    }
  }

  return null;
}

const ADJUDICATOR_EXAMPLES: Array<[string, string]> = [
  ['Cali Bourse — PEA/CTO portfolio, weekly market sentiment, company publications', 'KEEP_RELEVANT'],
  ['Thomas R. Trading — gold/silver/bitcoin chart analysis and technical outlooks', 'KEEP_RELEVANT'],
  ['Mark Roussin CPA — stock investing, portfolio and options education', 'KEEP_RELEVANT'],
  ['Verified Investing Extra — trader education, behind-the-chart explainers and interviews', 'KEEP_RELEVANT'],
  ['Altraviz Trading — trading lernen, chart analysis, risk management education', 'KEEP_RELEVANT'],
  ['Trading Algorítmico en Python — algorithmic trading and backtesting education', 'KEEP_RELEVANT'],
  ['Mr AlanForex — Forex trading robot reviews, optimization and education', 'KEEP_RELEVANT'],
  ['Trading Secrets — stock market education, penny stocks and long-term investing', 'KEEP_RELEVANT'],
  ['The Philosophical Trader — trading psychology, discipline and trade reviews', 'KEEP_RELEVANT'],
  ['FX Market Pulse — Forex and gold analysis, price action and risk education', 'KEEP_RELEVANT'],
  ['Crypto Saint TA — ETH liquidity and market structure analysis', 'KEEP_RELEVANT'],
  ['Forex & Crypto Live — live real-time signals using Diamond Algo', 'HYPE'],
  ['Adam Gold Signals — VIP Telegram signals, 90% accuracy, broker referral', 'HYPE'],
  ['Golden Waves — live trading signals, free gifts and broker promotions', 'HYPE'],
  ['Price Action Signals — price action signals only', 'HYPE'],
  ['shashwat01 — trading reels and motivation, no structured education', 'HYPE'],
  ['Tradespoon — daily stock pick service and proprietary quant system', 'MARKET_INSTITUTION'],
  ['Emerge Profit — prop firm with simulated accounts and reward programs', 'MARKET_INSTITUTION'],
  ['12TradePro Com — automated trading software and NinjaTrader systems', 'MARKET_INSTITUTION'],
  ['Quantiva — AI market narration platform and live data product', 'MARKET_INSTITUTION'],
  ['BeursInside — investor events, masterclasses, conferences and platform', 'MARKET_INSTITUTION'],
  ['CryptoDexWorld — crypto promo agency, 100x memecoin reviews and presales', 'HYPE'],
  ['Vanski Trades — art, candles, shop relaunch; one day-trading video', 'UNRELATED'],
  ['Emilio Gallardo — sales career training; one trading strategy video', 'UNRELATED'],
  ['BasedClips — crypto news clips and commentary', 'FINANCIAL_NEWS'],
  ['JezzaBTC — daily crypto technical analysis, news and financial market updates', 'KEEP_RELEVANT'],
  ['madDogzz — recurring XAUUSD live trading sessions plus comedy and motivation shorts', 'KEEP_RELEVANT'],
  ['forex_sumit_27 — daily live XAUUSD execution and market analysis, no signal product', 'KEEP_RELEVANT'],
  ['A channel named for signals that distributes entries and setups with light analysis', 'HYPE'],
  ['A design-career vlog whose trading uploads are a minority of the channel', 'UNRELATED'],
  ['A UI/UX design and coding vlog that occasionally posts forex trade recaps', 'UNRELATED'],
  ['A teacher who sells a watchlist or alerts but whose videos are structured lessons', 'KEEP_RELEVANT'],
  ['Weekly gold forecast plus a VIP analysis service', 'KEEP_RELEVANT'],
  ['Daily crypto price-prediction channel', 'KEEP_RELEVANT'],
  ['Broker comparison, fee and regulation reviews', 'FINANCIAL_NEWS'],
  ['Independent trader with an affiliate link to a charting tool', 'KEEP_RELEVANT'],
  ['Active trader offering account management alongside trade recaps', 'KEEP_RELEVANT'],
  ['Coach or mentor publishing weekly forex analysis and lessons', 'KEEP_RELEVANT'],
  ['Teacher sharing free lessons plus a free signals group', 'KEEP_RELEVANT'],
  ['Oxford Chart / Ermes Group — technical analysis of NASDAQ, Dow, S&P, gold and EUR/USD with levels and scenarios', 'KEEP_RELEVANT'],
  ['Alpha Market TV — crypto technical analysis with charts, key levels, trends, support/resistance and price scenarios', 'KEEP_RELEVANT'],
  ['Stock & Commodity Hub — stock price targets, technical/fundamental analysis, IPO updates and investment insights', 'KEEP_RELEVANT'],
  ['Forex-Sun — forex market analysis and trading ideas from two traders', 'KEEP_RELEVANT'],
  ['TiaBTC — Bitcoin technical analysis with support levels and trade scenarios', 'KEEP_RELEVANT'],
  ['A channel that republishes crypto news clips and headlines with no original analysis', 'FINANCIAL_NEWS'],
  ['Market event reporting: CPI/FOMC headlines and company announcements without trade analysis', 'FINANCIAL_NEWS'],
];

export function buildCategoryAdjudicatorPrompt(input: RawChannelInput, firstLabel: string): string {
  const { name, bio, videoTitles } = normalizedInput(input);
  const lines = [
    'You are a conservative precision adjudicator for YouTube channel categories.',
    'The first-pass classifier already marked this channel as trading-relevant.',
    'Your only job is to decide whether the channel is CLEARLY a non-relevant commercial institution, promo/hype channel, news/media channel, or unrelated channel.',
    'If the channel is a genuine trading educator, investing educator, or active trading creator, return KEEP_RELEVANT.',
    'When uncertain, return KEEP_RELEVANT. Do not downgrade a genuine educator.',
    'Return JSON only with keys label, confidence (0-100), explanation.',
    'Allowed labels: MARKET_INSTITUTION, HYPE, FINANCIAL_NEWS, UNRELATED, KEEP_RELEVANT',
    '',
    'Downgrade only when the PRIMARY product is clearly one of:',
    '- MARKET_INSTITUTION: broker, exchange, bank, prop firm, fund, asset manager, data/software platform, trading-robot vendor, stock-pick service, or events/conference platform.',
    '- HYPE: VIP/free signals, guaranteed returns, 100x/memecoin/presale promotion, affiliate-first promotion, or trading motivation/reels without structured education.',
    '- FINANCIAL_NEWS: reporting market events, company announcements, economic developments, or financial headlines as the primary product, without original trading/investment analysis or actionable trade ideas. News clips and broker-comparison media also qualify.',
    '- UNRELATED: primary content is non-financial (art, cars, comedy, drama, religion, sports, fitness, tech tutorials, travel, beauty, etc.).',
    'Keep relevant when the creator teaches or produces trading method, market or technical analysis, psychology, platform use, risk management, stock portfolios, ETFs, dividends, valuation, company analysis, or long-term investing. Analysis-only and forecast-style trading channels qualify even without step-by-step lessons. This holds even if the videos discuss brokers, review software, or sell a course, watchlist, alerts, or a paid community.',
    'Teaching algorithmic trading, backtesting, or how to use a trading platform is trading education; only a vendor selling the software/platform is MARKET_INSTITUTION.',
    'Free educational content is not HYPE. HYPE requires VIP/free signals, guaranteed returns, 100x/memecoin/presale promotion, or affiliate-first promotion.',
    'Recurring live trading sessions, trade recaps, or a public trading journey are active trading, not HYPE or UNRELATED, even when the channel also posts motivation or comedy shorts.',
    'Live execution and market analysis without selling signals is active trading; HYPE requires signals or promotional returns to be the primary product.',
    'If the bio identifies a non-financial primary profession (software, design, fitness, sales, art, etc.) and trading is only a minority of uploads, return UNRELATED; the channel identity matters more than a minority block of trading recaps.',
    'A channel named for signals, or one that primarily distributes entries and setups, is HYPE even if it also provides analysis. Education teaches method; signals distribute trades.',
    'A channel that teaches trading and also offers a free study or signals group is still education when its videos are lessons.',
    'Market or technical analysis intended to inform trading decisions is trading content, even when it is analysis-only, forecast-style, or does not provide step-by-step lessons: charts, price action, market structure, support/resistance, trends, scenarios, setups, and trade ideas all qualify.',
    'FINANCIAL_NEWS only when the primary product is reporting market events, company announcements, economic developments, or financial headlines without primarily producing trading or investment analysis, trade ideas, or analysis intended to inform trading decisions.',
    'A broker comparison, review, or research site is FINANCIAL_NEWS, not education.',
    'An independent trader who uses affiliate links or promotes a tool, or who offers account management or mentorship, remains active trading or education when the videos are trade recaps, backtests, or lessons. Only the official institution channel, or a channel whose primary product is the tool or managed account, is MARKET_INSTITUTION.',
    'A free Telegram or Discord community is not HYPE by itself; HYPE requires a signals or promotional-returns product to be the primary offer.',
    '',
    'Examples:',
    ...ADJUDICATOR_EXAMPLES.map(([text, label]) => `- ${text} => ${label}`),
    '',
    `First-pass label: ${firstLabel}`,
    `Channel name: ${name}`,
    `Channel bio: ${bio.slice(0, 1800)}`,
  ];
  if (videoTitles.length) {
    lines.push('Recent video titles:');
    for (const title of videoTitles.slice(0, 10)) lines.push(`- ${title.slice(0, 240)}`);
  }
  lines.push('Return JSON only.');
  return lines.join('\n');
}

export async function adjudicateCategory(
  input: RawChannelInput,
  firstLabel: string,
  options: { client?: SemanticModelClient | null } = {},
): Promise<PrecisionGuardResult | null> {
  const client = options.client === undefined ? defaultClient() : options.client;
  if (!client) return null;
  const model = process.env.CONTENT_CATEGORY_ADJUDICATOR_MODEL || DEFAULT_CATEGORY_ADJUDICATOR_MODEL;
  try {
    const value = await client.classify(buildCategoryAdjudicatorPrompt(input, firstLabel), model);
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const label = String(raw.label || '').toUpperCase();
    if (label === 'KEEP_RELEVANT' || label === 'AMBIGUOUS') return null;
    if (!PRECISION_CATEGORIES.has(label)) return null;
    const rawConfidence = Number(raw.confidence);
    // Providers may return a 0..1 probability or a 0..100 percentage. Accept
    // both scales so a correctly confident downgrade is never discarded.
    const confidence = Number.isFinite(rawConfidence)
      ? (rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence)
      : Number.NaN;
    if (!Number.isFinite(confidence) || confidence < 70) return null;
    return {
      category: label as PrecisionCategory,
      source: 'ADJUDICATOR',
      confidence,
      reasonCodes: ['PRECISION_ADJUDICATOR_DOWNGRADE', `PRECISION_CATEGORY_${label}`],
      explanation: String(raw.explanation || '').slice(0, 500),
    };
  } catch {
    // A precision guard must never create review debt or block a genuine
    // educator because the adjudicator is unavailable.
    return null;
  }
}

export async function applyCategoryPrecisionGuard(
  input: RawChannelInput,
  firstLabel: string | undefined,
  options: PrecisionGuardOptions = {},
): Promise<PrecisionGuardResult | null> {
  if (!firstLabel) return null;
  if (!['ACTIVE_TRADING', 'TRADING_EDUCATION', 'INVESTING_EDUCATION'].includes(firstLabel)) return null;
  const enabled = options.enabled ?? process.env.CONTENT_CATEGORY_PRECISION_GUARD_ENABLED !== 'false';
  if (!enabled) return null;
  const deterministic = deterministicCategoryGuard(input);
  if (deterministic) return deterministic;
  if (options.adjudicator) return options.adjudicator(input, firstLabel);
  return adjudicateCategory(input, firstLabel, { client: options.client });
}
