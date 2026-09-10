import type { CountryMetadataStatus, CountryStatus, CountryVocabulary, ExcludedCountry } from '../src/types';
import { normalizeCountryName } from './countryExclusionRules';

export type CountryEvidenceSource =
  | 'OFFICIAL_YOUTUBE_METADATA'
  | 'CHANNEL_ABOUT_BIO'
  | 'OFFICIAL_WEBSITE_DOMAIN'
  | 'VERIFIED_SOCIAL_LINK'
  | 'EXCHANGE_REFERENCE'
  | 'BROKER_REFERENCE'
  | 'PHONE_NUMBER'
  | 'PHYSICAL_ADDRESS'
  | 'NATIVE_LANGUAGE'
  | 'AGGREGATED_CONTENT_LANGUAGE'
  | 'DISCOVERY_CONTEXT'
  | 'EXCLUSION_POLICY';

export type CountryEvidenceAvailability =
  | 'NOT_REQUESTED'
  | 'AVAILABLE_DECLARED'
  | 'AVAILABLE_NOT_DECLARED'
  | 'UNAVAILABLE';

export type GateDisposition =
  | 'ALLOW_NORMAL'
  | 'CONTINUE_CRAWLING'
  | 'NEEDS_REVIEW'
  | 'REJECT_EXCLUDED';

export interface CountryInferenceEvidence {
  source: CountryEvidenceSource;
  priority: number;
  detectedCountry: string;
  confidence: number;
  reasoning: string;
  matchedValue?: string;
  matchedContext?: string;
  /**
   * Candidate creator countries for aggregated-language evidence (Urdu,
   * Bengali). Single-country languages omit this field. Recorded so
   * policy-edit reconciliation can match rows by set membership when an
   * exclusion is removed.
   */
  candidateCountries?: string[];
  /**
   * Provenance boundary: the exact creator-level input field that produced
   * this evidence. P2 CHANNEL_ABOUT_BIO evidence must only ever carry
   * 'channelName' | 'description' | 'socialBios'. Exchange references,
   * discovery context, video metadata, website content, and crawler trail
   * prose must never appear here.
   */
  sourceField?: string;
}

export interface CountryInferenceInput {
  officialCountry?: string;
  channelName?: string;
  aboutBio?: string;
  /**
   * Creator social-profile biography texts. Matched as P2 creator-country
   * evidence with sourceField 'socialBios', independently from channelName
   * and description so every P2 item is auditable to its exact field.
   * NOTE: currently unpopulated by production ingestion/revalidation — no
   * existing source provides social-profile biography prose (channel links
   * are URLs, not bios; fetching them would be a new acquisition system).
   * The typed provenance boundary is ready for future wiring; until then
   * P2 rests on channelName + description only. Never substitute trail
   * prose, video metadata, or discovery context here.
   */
  socialBios?: string[];
  officialWebsiteLinks?: string[];
  verifiedSocialLinks?: string[];
  videoTitles?: string[];
  /**
   * Already-fetched creator-written video descriptions (up to 10 recent).
   * Used ONLY by the aggregated-content-language voter below — never joined
   * into bio text, never matched by P2/P5–P8 matchers. Titles stay excluded
   * (retrieval-selected, circular). Empty at pre-enrichment Gate 1, so
   * behavior there is unchanged.
   */
  videoDescriptions?: string[];
  /**
   * Provenance gate for the aggregated-content-language voter. True ONLY when
   * the descriptions are an authoritative recent-channel sample (channel
   * enrichment recent-uploads fetch or live revalidation fetch).
   * Search-selected / retrieval-selected snippets, playlist-adapter
   * observations, and any other discovery-selected subsets are
   * non-authoritative and can never vote, so a query-biased subset cannot
   * manufacture a language majority. Titles stay excluded regardless.
   */
  videoDescriptionsAuthoritative?: boolean;
  /**
   * Already-fetched playlist names/descriptions (stage 2+). Corroboration
   * veto only: a playlist voting a different eligible language voids
   * dominance, but playlists can never create a rejection on their own.
   */
  playlists?: Array<{ name?: string; description?: string }>;
  discoveryCountry?: string;
  metadataStatus?: CountryMetadataStatus;
}

export interface CountryAssessment {
  discoveryCountry: string | null;
  detectedCreatorCountry: string | null;
  countryEvidence: CountryInferenceEvidence[];
  countryStatus: CountryStatus;
  evidenceAvailability: CountryEvidenceAvailability;
  gateDisposition: GateDisposition;
  confidence: number;
  reasoning: string;
  decisiveEvidence: CountryInferenceEvidence[];
  rejectionReason?: string;
}

export interface CountryInferenceResult extends CountryAssessment {
  detectedCountry: string | null; // Backwards compatibility alias for detectedCreatorCountry
  status: CountryStatus; // Backwards compatibility alias for countryStatus
  evidence: CountryInferenceEvidence[]; // Backwards compatibility alias for countryEvidence
}

const CREATOR_EVIDENCE_SOURCES: Set<CountryEvidenceSource> = new Set([
  'OFFICIAL_YOUTUBE_METADATA',
  'CHANNEL_ABOUT_BIO',
  'OFFICIAL_WEBSITE_DOMAIN',
  'VERIFIED_SOCIAL_LINK',
  'EXCHANGE_REFERENCE',
  'BROKER_REFERENCE',
  'PHONE_NUMBER',
  'PHYSICAL_ADDRESS',
  'NATIVE_LANGUAGE',
  'AGGREGATED_CONTENT_LANGUAGE'
]);

const COUNTRY_ALIASES: Record<string, string> = {
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
};

const COUNTRY_SIGNALS: Record<string, {
  bio: string[]; tlds: string[]; social: string[]; exchanges: string[]; brokers: string[];
  phones: string[]; addresses: string[]; language: string[];
}> = {
  'United States': { bio: ['united states', 'american trader', 'based in usa'], tlds: ['.us'], social: ['usa', 'newyork'], exchanges: ['nyse', 'nasdaq', 'cme group'], brokers: ['thinkorswim', 'tradestation'], phones: ['+1'], addresses: ['new york', 'chicago', 'california'], language: [] },
  'United Kingdom': { bio: ['united kingdom', 'british trader', 'based in london'], tlds: ['.uk', '.co.uk'], social: ['uktrader', 'london'], exchanges: ['london stock exchange', 'ftse 100', 'lse'], brokers: ['hargreaves lansdown', 'ig uk'], phones: ['+44'], addresses: ['london', 'manchester', 'birmingham'], language: [] },
  Germany: { bio: ['germany', 'deutschland', 'deutscher trader'], tlds: ['.de'], social: ['deutschland', 'berlin'], exchanges: ['xetra', 'börse frankfurt', 'dax 40', 'fdax'], brokers: ['flatex', 'comdirect'], phones: ['+49'], addresses: ['berlin', 'frankfurt', 'münchen', 'munich'], language: ['börse', 'börsenanalyse', 'marktanalyse', 'handel', 'handelsstrategie'] },
  France: { bio: ['france', 'trader français', 'basé à paris'], tlds: ['.fr'], social: ['france', 'paris'], exchanges: ['euronext paris', 'cac 40'], brokers: ['boursorama', 'fortuneo'], phones: ['+33'], addresses: ['paris', 'lyon', 'marseille'], language: ['marché', 'bourse', 'analyse technique', 'séance', 'hebdomadaire'] },
  Spain: { bio: ['spain', 'españa', 'trader español'], tlds: ['.es'], social: ['españa', 'madrid'], exchanges: ['bolsa de madrid', 'ibex 35'], brokers: ['renta 4', 'bankinter broker'], phones: ['+34'], addresses: ['madrid', 'barcelona', 'valencia'], language: ['análisis bursátil', 'mercado', 'intradía', 'sesión', 'bolsa'] },
  Brazil: { bio: ['brazil', 'brasil', 'trader brasileiro'], tlds: ['.br', '.com.br'], social: ['brasil', 'saopaulo'], exchanges: ['b3 bolsa', 'bovespa', 'ibovespa'], brokers: ['xp investimentos', 'clear corretora', 'rico investimentos'], phones: ['+55'], addresses: ['são paulo', 'rio de janeiro', 'brasilia'], language: ['mercado financeiro', 'análise técnica', 'operações', 'ações', 'day trade brasil'] },
  Russia: { bio: ['russia', 'россия', 'российский трейдер'], tlds: ['.ru'], social: ['россия', 'moscow'], exchanges: ['московская биржа', 'moex', 'индекс ртс'], brokers: ['тинькофф инвестиции', 'бкс брокер'], phones: ['+7'], addresses: ['москва', 'санкт-петербург', 'moscow'], language: ['трейдинг', 'рынок', 'биржа', 'технический анализ', 'акции'] },
  India: { bio: ['india', 'भारत', 'indian trader'], tlds: ['.in', '.co.in'], social: ['india', 'mumbai'], exchanges: ['nse india', 'bse india', 'nifty 50', 'sensex'], brokers: ['zerodha', 'upstox', 'groww'], phones: ['+91'], addresses: ['mumbai', 'delhi', 'bengaluru', 'bangalore'], language: ['शेयर बाजार', 'ट्रेडिंग', 'निफ्टी', 'बाजार', 'तकनीकी विश्लेषण'] },
  Japan: { bio: ['japan', '日本', '日本人トレーダー'], tlds: ['.jp'], social: ['japan', 'tokyo'], exchanges: ['東京証券取引所', 'topix', 'nikkei 225'], brokers: ['楽天証券', 'sbi証券'], phones: ['+81'], addresses: ['東京', '大阪', 'tokyo'], language: ['株式', '相場', 'トレード', 'テクニカル分析', '日経平均'] },
  'South Korea': { bio: ['south korea', '대한민국', '한국 트레이더'], tlds: ['.kr', '.co.kr'], social: ['korea', 'seoul'], exchanges: ['한국거래소', 'krx', 'kospi'], brokers: ['키움증권', '미래에셋증권'], phones: ['+82'], addresses: ['서울', '부산', 'seoul'], language: ['주식', '시장', '트레이딩', '기술적 분석', '코스피'] },
  Turkey: { bio: ['turkey', 'türkiye', 'türk trader'], tlds: ['.tr', '.com.tr'], social: ['turkiye', 'istanbul'], exchanges: ['borsa istanbul', 'bist 100'], brokers: ['midas', 'iş yatırım'], phones: ['+90'], addresses: ['istanbul', 'ankara', 'izmir'], language: ['borsa', 'piyasa', 'teknik analiz', 'hisse', 'işlem stratejisi'] },
  Netherlands: { bio: ['netherlands', 'nederland', 'dutch trader'], tlds: ['.nl'], social: ['nederland', 'amsterdam'], exchanges: ['euronext amsterdam', 'aex index'], brokers: ['degiro', 'binck'], phones: ['+31'], addresses: ['amsterdam', 'rotterdam', 'utrecht'], language: ['beurs', 'handelen', 'marktanalyse', 'aandelen', 'opties'] },
  Italy: { bio: ['italy', 'italia', 'trader italiano'], tlds: ['.it'], social: ['italia', 'milano'], exchanges: ['borsa italiana', 'ftse mib'], brokers: ['fineco', 'directa sim'], phones: ['+39'], addresses: ['milano', 'roma', 'torino'], language: ['borsa', 'mercati', 'analisi tecnica', 'azioni', 'trading italiano'] },
  Australia: { bio: ['australia', 'australian trader', 'aussie trader'], tlds: ['.au', '.com.au'], social: ['australia', 'sydney'], exchanges: ['australian securities exchange', 'asx 200'], brokers: ['commsec', 'selfwealth'], phones: ['+61'], addresses: ['sydney', 'melbourne', 'brisbane'], language: [] },
  Canada: { bio: ['canada', 'canadian trader'], tlds: ['.ca'], social: ['canada', 'toronto'], exchanges: ['toronto stock exchange', 'tsx'], brokers: ['questrade', 'wealthsimple'], phones: ['+1'], addresses: ['toronto', 'vancouver', 'montreal'], language: [] },
  'Saudi Arabia': { bio: ['saudi arabia', 'السعودية', 'متداول سعودي'], tlds: ['.sa', '.com.sa'], social: ['saudi', 'riyadh'], exchanges: ['تداول السعودية', 'tadawul', 'tasi'], brokers: ['دراية المالية', 'الراجحي المالية'], phones: ['+966'], addresses: ['الرياض', 'جدة', 'riyadh'], language: ['تداول', 'السوق', 'الأسهم', 'تحليل فني', 'استثمار'] },

  Switzerland: { bio: ['switzerland', 'schweiz', 'suisse', 'svizzera'], tlds: ['.ch'], social: ['switzerland', 'zurich'], exchanges: ['six swiss exchange', 'swiss market index', 'smi'], brokers: ['swissquote'], phones: ['+41'], addresses: ['zurich', 'zürich', 'geneva', 'genève'], language: ['börsenanalyse schweiz', 'smi analyse'] },
  Denmark: { bio: ['denmark', 'danmark', 'dansk trader'], tlds: ['.dk'], social: ['danmark', 'copenhagen'], exchanges: ['nasdaq copenhagen', 'omxc25'], brokers: ['saxo bank'], phones: ['+45'], addresses: ['copenhagen', 'københavn'], language: ['aktiehandel', 'teknisk analyse', 'børsanalyse'] },
  Sweden: { bio: ['sweden', 'sverige', 'svensk trader'], tlds: ['.se'], social: ['sverige', 'stockholm'], exchanges: ['nasdaq stockholm', 'omxs30'], brokers: ['avanza'], phones: ['+46'], addresses: ['stockholm', 'göteborg'], language: ['aktiehandel', 'teknisk analys', 'börsanalys'] },
  Singapore: { bio: ['singapore', 'singapore trader'], tlds: ['.sg', '.com.sg'], social: ['singapore'], exchanges: ['singapore exchange', 'sgx', 'straits times index'], brokers: ['dbs vickers'], phones: ['+65'], addresses: ['singapore'], language: ['股票交易', '技术分析', 'pasaran saham'] },
  'New Zealand': { bio: ['new zealand', 'kiwi trader'], tlds: ['.nz', '.co.nz'], social: ['newzealand', 'auckland'], exchanges: ['new zealand exchange', 'nzx 50'], brokers: ['sharesies'], phones: ['+64'], addresses: ['auckland', 'wellington'], language: [] },
  Belgium: { bio: ['belgium', 'belgië', 'belgique'], tlds: ['.be'], social: ['belgium', 'brussels'], exchanges: ['euronext brussels', 'bel 20'], brokers: ['bolero', 'keytrade'], phones: ['+32'], addresses: ['brussels', 'bruxelles', 'antwerp'], language: ['beursanalyse belgië', 'analyse boursière belge'] },
  Luxembourg: { bio: ['luxembourg', 'lëtzebuerg'], tlds: ['.lu'], social: ['luxembourg'], exchanges: ['luxembourg stock exchange', 'luxx'], brokers: ['bgl bnp paribas'], phones: ['+352'], addresses: ['luxembourg'], language: ['bourse de luxembourg', 'luxemburger börse'] },
  Ireland: { bio: ['ireland', 'irish trader', 'éire'], tlds: ['.ie'], social: ['ireland', 'dublin'], exchanges: ['euronext dublin', 'iseq 20'], brokers: ['davy select', 'goodbody'], phones: ['+353'], addresses: ['dublin', 'cork'], language: ['trádáil scaireanna'] },
  Czechia: { bio: ['czechia', 'czech republic', 'česká republika', 'ceska republika', 'czech trader', 'based in prague'], tlds: ['.cz'], social: ['czechia', 'praha'], exchanges: ['prague stock exchange', 'px index'], brokers: ['fio banka', 'xtb'], phones: ['+420'], addresses: ['praha', 'prague', 'brno'], language: ['akcie', 'obchodování', 'burza cenných papírů', 'technická analýza'] },
  'United Arab Emirates': { bio: ['united arab emirates', 'الإمارات', 'dubai trader'], tlds: ['.ae'], social: ['dubai', 'uae'], exchanges: ['dubai financial market', 'abu dhabi securities exchange', 'dfm'], brokers: ['sarwa', 'adss'], phones: ['+971'], addresses: ['دبي', 'أبوظبي', 'dubai', 'abu dhabi'], language: ['تداول', 'السوق', 'الأسهم', 'تحليل فني', 'استثمار'] },
  Nigeria: { bio: ['nigeria', 'nigerian trader', 'based in nigeria', 'trader in nigeria', 'naija trader', 'naija'], tlds: ['.ng', '.com.ng'], social: ['nigeria', 'lagos'], exchanges: ['nigerian exchange', 'ngx'], brokers: ['meristem', 'cardinalstone'], phones: ['+234'], addresses: ['lagos', 'abuja'], language: ['naira', 'forex nigeria'] },
  Pakistan: { bio: ['pakistan', 'pakistani trader', 'based in pakistan', 'trader in pakistan'], tlds: ['.pk', '.com.pk'], social: ['pakistan', 'karachi'], exchanges: ['pakistan stock exchange', 'psx'], brokers: ['k trade', 'arif habib'], phones: ['+92'], addresses: ['karachi', 'lahore', 'islamabad'], language: ['اردو ٹریڈنگ', 'پاکستان اسٹاک'] },
  Bangladesh: { bio: ['bangladesh', 'bangladeshi trader', 'based in bangladesh', 'trader in bangladesh'], tlds: ['.bd', '.com.bd'], social: ['bangladesh', 'dhaka'], exchanges: ['dhaka stock exchange', 'dse bd'], brokers: ['lanka bangla securities'], phones: ['+880'], addresses: ['dhaka', 'chittagong'], language: ['শেয়ার বাজার', 'ট্রেডিং'] },
  Nepal: { bio: ['nepal', 'nepali trader', 'based in nepal'], tlds: ['.np', '.com.np'], social: ['nepal', 'kathmandu'], exchanges: ['nepal stock exchange', 'nepse'], brokers: [], phones: ['+977'], addresses: ['kathmandu', 'pokhara'], language: ['शेयर बजार', 'नेप्से'] },
  Kenya: { bio: ['kenya', 'kenyan trader', 'based in kenya'], tlds: ['.ke', '.co.ke'], social: ['kenya', 'nairobi'], exchanges: ['nairobi securities exchange', 'nse kenya'], brokers: ['dyer and blair'], phones: ['+254'], addresses: ['nairobi', 'mombasa'], language: ['kenya stocks', 'soko la hisa'] },
  'South Africa': { bio: ['south africa', 'south african trader', 'based in south africa'], tlds: ['.za', '.co.za'], social: ['southafrica', 'johannesburg'], exchanges: ['johannesburg stock exchange', 'jse'], brokers: ['easyequities'], phones: ['+27'], addresses: ['johannesburg', 'cape town', 'durban'], language: ['rand', 'aandelemark'] },
  Ghana: { bio: ['ghana', 'ghanaian trader', 'based in ghana'], tlds: ['.gh', '.com.gh'], social: ['ghana', 'accra'], exchanges: ['ghana stock exchange', 'gse ghana'], brokers: [], phones: ['+233'], addresses: ['accra', 'kumasi'], language: ['ghana stocks', 'cedi'] },
  Egypt: { bio: ['egypt', 'egyptian trader', 'based in egypt', 'متداول مصري'], tlds: ['.eg', '.com.eg'], social: ['egypt', 'cairo'], exchanges: ['egyptian exchange', 'egx'], brokers: ['mubasher'], phones: ['+20'], addresses: ['cairo', 'القاهرة', 'alexandria'], language: ['البورصة المصرية', 'الأسهم المصرية'] },
  Morocco: { bio: ['morocco', 'moroccan trader', 'based in morocco', 'متداول مغربي'], tlds: ['.ma', '.co.ma'], social: ['morocco', 'casablanca'], exchanges: ['casablanca stock exchange', 'casablanca bourse'], brokers: [], phones: ['+212'], addresses: ['casablanca', 'rabat'], language: ['بورصة الدار البيضاء', 'الأسهم المغربية'] },
  Philippines: { bio: ['philippines', 'filipino trader', 'based in philippines'], tlds: ['.ph', '.com.ph'], social: ['philippines', 'manila'], exchanges: ['philippine stock exchange', 'psei'], brokers: ['col financial'], phones: ['+63'], addresses: ['manila', 'cebu'], language: ['pamilihan ng stock', 'trading pilipinas'] },
  Vietnam: { bio: ['vietnam', 'vietnamese trader', 'based in vietnam'], tlds: ['.vn', '.com.vn'], social: ['vietnam', 'hanoi'], exchanges: ['ho chi minh stock exchange', 'hose'], brokers: ['ssi securities'], phones: ['+84'], addresses: ['hanoi', 'ho chi minh'], language: ['chứng khoán', 'phân tích kỹ thuật'] },
  Indonesia: { bio: ['indonesia', 'indonesian trader', 'based in indonesia'], tlds: ['.id', '.co.id'], social: ['indonesia', 'jakarta'], exchanges: ['indonesia stock exchange', 'idx'], brokers: ['ajaib', 'mirae asset sekuritas'], phones: ['+62'], addresses: ['jakarta', 'surabaya'], language: ['pasar saham', 'analisis teknikal'] },
  Algeria: { bio: ['algeria', 'algerian trader', 'based in algeria'], tlds: ['.dz'], social: ['algeria'], exchanges: [], brokers: [], phones: ['+213'], addresses: ['algiers'], language: [] },
  Tunisia: { bio: ['tunisia', 'tunisian trader', 'based in tunisia'], tlds: ['.tn'], social: ['tunisia'], exchanges: [], brokers: [], phones: ['+216'], addresses: ['tunis'], language: [] },
  Ethiopia: { bio: ['ethiopia', 'ethiopian trader', 'based in ethiopia'], tlds: ['.et'], social: ['ethiopia'], exchanges: [], brokers: [], phones: ['+251'], addresses: ['addis ababa'], language: [] },
  Tanzania: { bio: ['tanzania', 'tanzanian trader', 'based in tanzania'], tlds: ['.tz'], social: ['tanzania'], exchanges: [], brokers: [], phones: ['+255'], addresses: ['dar es salaam'], language: [] },
  Uganda: { bio: ['uganda', 'ugandan trader', 'based in uganda'], tlds: ['.ug'], social: ['uganda'], exchanges: [], brokers: [], phones: ['+256'], addresses: ['kampala'], language: [] },
  Senegal: { bio: ['senegal', 'senegalese trader', 'based in senegal'], tlds: ['.sn'], social: ['senegal'], exchanges: [], brokers: [], phones: ['+221'], addresses: ['dakar'], language: [] },
  Cameroon: { bio: ['cameroon', 'cameroonian trader', 'based in cameroon'], tlds: ['.cm'], social: ['cameroon'], exchanges: [], brokers: [], phones: ['+237'], addresses: ['yaounde', 'douala'], language: [] },
  Zimbabwe: { bio: ['zimbabwe', 'zimbabwean trader', 'based in zimbabwe'], tlds: ['.zw'], social: ['zimbabwe'], exchanges: [], brokers: [], phones: ['+263'], addresses: ['harare'], language: [] },
  Zambia: { bio: ['zambia', 'zambian trader', 'based in zambia'], tlds: ['.zm'], social: ['zambia'], exchanges: [], brokers: [], phones: ['+260'], addresses: ['lusaka'], language: [] },
  Rwanda: { bio: ['rwanda', 'rwandan trader', 'based in rwanda'], tlds: ['.rw'], social: ['rwanda'], exchanges: [], brokers: [], phones: ['+250'], addresses: ['kigali'], language: [] },
  'Ivory Coast': { bio: ['ivory coast', "côte d'ivoire", 'based in ivory coast'], tlds: ['.ci'], social: ['ivorycoast'], exchanges: [], brokers: [], phones: ['+225'], addresses: ['abidjan'], language: [] },
  Mozambique: { bio: ['mozambique', 'mozambican trader', 'based in mozambique'], tlds: ['.mz'], social: ['mozambique'], exchanges: [], brokers: [], phones: ['+258'], addresses: ['maputo'], language: [] },
  Madagascar: { bio: ['madagascar', 'malagasy trader', 'based in madagascar'], tlds: ['.mg'], social: ['madagascar'], exchanges: [], brokers: [], phones: ['+261'], addresses: ['antananarivo'], language: [] },
  Sudan: { bio: ['sudan', 'sudanese trader', 'based in sudan'], tlds: ['.sd'], social: ['sudan'], exchanges: [], brokers: [], phones: ['+249'], addresses: ['khartoum'], language: [] },
  Angola: { bio: ['angola', 'angolan trader', 'based in angola'], tlds: ['.ao'], social: ['angola'], exchanges: [], brokers: [], phones: ['+244'], addresses: ['luanda'], language: [] },
  'Sri Lanka': { bio: ['sri lanka', 'sri lankan trader', 'based in sri lanka'], tlds: ['.lk'], social: ['srilanka'], exchanges: ['colombo stock exchange'], brokers: [], phones: ['+94'], addresses: ['colombo'], language: [] }
};

const SOCIAL_HOSTS = ['instagram.com', 'x.com', 'twitter.com', 'facebook.com', 'linkedin.com', 'tiktok.com'];

export function canonicalCountry(value: string): string {
  const normalized = normalizeCountryName(value);
  return COUNTRY_ALIASES[normalized] || Object.keys(COUNTRY_SIGNALS).find(country => normalizeCountryName(country) === normalized) || value.trim();
}

/** Returns the authoritative two-letter alias for a canonical country identity, when configured. */
export function countryIsoAlias(value: string): string | null {
  const canonical = canonicalCountry(value);
  const alias = Object.entries(COUNTRY_ALIASES).find(([key, country]) =>
    key.length === 2 && canonicalCountry(country) === canonical
  )?.[0];
  return alias ? alias.toUpperCase() : null;
}

function includesSignal(text: string, signals: string[]): string | null {
  return signals.find(signal => {
    const lower = signal.toLocaleLowerCase('en');
    // Short acronyms (e.g. jse/lse/tsx/smi/hose) must match on token
    // boundaries. Raw substring matching turns ordinary words into false
    // creator-country evidence ('jsem', Czech for "I am", is not the
    // Johannesburg exchange; 'false'/'pulse'/'else' is not the London
    // exchange; 'those' is not the Ho Chi Minh exchange; 'smith' is not the
    // Swiss Market Index). Longer phrases keep substring behavior.
    if (/^[a-z]{2,4}$/.test(lower)) {
      return new RegExp(`(?<![\\p{L}\\p{N}_])${lower}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
    }
    return text.includes(lower);
  }) || null;
}

function matchWindow(text: string, match: string, radius = 80): string {
  const index = text.toLocaleLowerCase('en').indexOf(match.toLocaleLowerCase('en'));
  if (index < 0) return '';
  return text.slice(Math.max(0, index - radius), index + match.length + radius).replace(/\s+/g, ' ').trim();
}

function addTextEvidence(evidence: CountryInferenceEvidence[], source: CountryEvidenceSource, priority: number, confidence: number, text: string, key: keyof typeof COUNTRY_SIGNALS[string], reason: string, sourceField?: string): void {
  for (const [country, signals] of Object.entries(COUNTRY_SIGNALS)) {
    const match = includesSignal(text, signals[key]);
    if (match) evidence.push({ source, priority, detectedCountry: country, confidence, matchedValue: match, matchedContext: matchWindow(text, match), ...(sourceField ? { sourceField } : {}), reasoning: `${reason}: '${match}' indicates ${country}.` });
  }
}

function hostname(link: string): string {
  try { return new URL(link).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Perform country assessment separating discovery context from creator-level evidence.
 * Structurally guarantees DISCOVERY_CONTEXT can NEVER populate detectedCreatorCountry or trigger REJECTED.
 */
/**
 * Approved aggregated-language definitions: dominant content language →
 * candidate creator countries plus the deterministic signals that identify
 * the language in one video description. A language is listed only when
 * every strongly-associated country is on the excluded-country list
 * (single-country languages, or multi-country languages whose members are
 * all excluded). Worldwide or ambiguous languages (English, French, Spanish,
 * Portuguese, Arabic, Bahasa) are deliberately absent and can never vote.
 *
 * Data-driven by design: supporting an additional excluded-country language
 * means adding one entry here — no per-language code branches exist. A new
 * entry whose signals overlap an existing language degrades both to
 * abstention (see voteVideoDescriptionLanguage), so overlapping signals must
 * ship with distinguishing signals or stay out.
 */
export interface AggregatedLanguageDefinition {
  countries: string[];
  /** Unicode scripts whose presence votes (use only for scripts unique to excluded-country languages). */
  scripts?: string[];
  /** Distinctive characters with a minimum count (e.g. Vietnamese diacritics). */
  diacritics?: { chars: string; threshold: number };
  /** High-precision phrases; ANY single hit votes. */
  phraseKeywords?: string[];
  /** Function words; require minHits DISTINCT word-boundary hits to vote. */
  wordKeywords?: { words: string[]; minHits: number };
  /**
   * Arabic-script gate: when set, the 'Arabic' script votes only with one of
   * these marker characters present (Arabic script alone is worldwide and
   * shared vocabulary would misattribute e.g. Arabic news content).
   */
  arabicMarkers?: string;
  /**
   * Generic conjunction guard: when true, a scripts-only match abstains — at
   * least one non-script signal group must also match. For scripts shared
   * across languages (e.g. Devanagari), the script identifies the script
   * family only; a language-specific corroborating signal is required before
   * any country attribution. Data-driven (no per-language code branches).
   */
  scriptNeedsCorroboration?: boolean;
  /**
   * Generic whole-word vetoes evaluated for any language: ANY hit makes one
   * description abstain from this language. Used to separate closely-related
   * languages sharing a script (e.g. Nepali-specific markers veto Hindi so
   * Devanagari content is never misattributed by default). Precision-first:
   * when in doubt the voter abstains rather than guessing.
   */
  vetoWords?: string[];
}

export const AGGREGATED_CONTENT_LANGUAGES: Record<string, AggregatedLanguageDefinition> = {
  Vietnamese: {
    countries: ['Vietnam'],
    // Vietnamese-specific characters ONLY: đ/Đ, ă/Ă, ơ/Ơ, ư/Ư and the
    // U+1EA0–U+1EF9 precomposed tone vowels (Vietnamese-only codepoints).
    // Shared Latin diacritics such as â/ê/ô/Â/Ê/Ô also occur naturally in
    // French and other languages, so they are deliberately excluded here:
    // ordinary French text must abstain, never vote Vietnamese.
    diacritics: { chars: 'đĐăĂơƠưƯẠ-ỹ', threshold: 3 },
    phraseKeywords: ['chứng khoán', 'phân tích kỹ thuật', 'giao dịch', 'thị trường', 'cổ phiếu', 'đầu tư']
  },
  Tagalog: {
    countries: ['Philippines'],
    wordKeywords: { words: ['ang', 'ng', 'mga', 'nang', 'ito', 'niya', 'kanila', 'natin', 'huwag', 'araw'], minHits: 2 }
  },
  Hindi: {
    // Devanagari is shared by Hindi, Marathi, Nepali and others, so the
    // script alone NEVER votes (scriptNeedsCorroboration). Hindi-specific
    // function words must corroborate, and Nepali-specific markers veto, so
    // Nepali content abstains instead of misattributing to India. The
    // approved Hindi → India mapping is retained; only the evidence bar is
    // language-specific now. Nepal is deliberately NOT added to the candidate
    // set: the objective is to distinguish Hindi from Nepali, not to blur
    // them into one set.
    countries: ['India'],
    scripts: ['Devanagari'],
    scriptNeedsCorroboration: true,
    wordKeywords: { words: ['है', 'हैं', 'हूँ', 'था', 'थी', 'थे', 'यह', 'ये', 'वह', 'वे', 'क्या', 'मैं', 'हम', 'मुझे', 'नहीं', 'वाला', 'वाले', 'वाली', 'करना', 'करता', 'करते', 'होगा', 'होगी', 'चाहिए', 'सकते', 'सकता'], minHits: 2 },
    vetoWords: ['छ', 'छन्', 'छैन', 'होइन', 'थियो', 'थिइन्', 'नेप्से', 'लागि', 'बाट', 'तपाईं', 'तपाई', 'हामी', 'गरेको', 'भएको', 'हुने']
  },
  Bengali: {
    // Bengali script is unique to Bengali/Assamese (Bangladesh/India, excluded).
    countries: ['Bangladesh', 'India'],
    scripts: ['Bengali']
  },
  Urdu: {
    countries: ['Pakistan', 'India'],
    scripts: ['Arabic'],
    arabicMarkers: '\u0688\u0679\u0691\u06be\u06c1\u06d2'
  }
};

/** Minimum usable (non-empty) descriptions for a language rejection. */
export const AGGREGATED_LANGUAGE_MIN_USABLE = 8;
/** Minimum dominant-language share of usable descriptions. */
export const AGGREGATED_LANGUAGE_MIN_SHARE = 0.8;

function countPatternMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Single-video language vote over one creator-written description. Returns
 * the approved language key or null (abstain). Generic over
 * AGGREGATED_CONTENT_LANGUAGES: every defined signal group can vote, veto
 * words suppress attribution for any language, and a video matching more
 * than one eligible language abstains rather than guessing. Deterministic,
 * no libraries. Precision-first: shared/ambiguous signals abstain.
 */
export function voteVideoDescriptionLanguage(text: string): string | null {
  const value = (text || '').trim();
  if (!value) return null;
  const lower = value.toLocaleLowerCase('en');
  // \p{Mark} stays inside tokens so dependent vowel signs never shatter
  // Indic words (Devanagari है must remain one token, not 'ह' + fragment).
  // Latin tokenization is unaffected.
  const tokens = new Set(lower.split(/[^\p{Letter}\p{Number}\p{Mark}]+/u).filter(Boolean));
  const votes = new Set<string>();
  for (const [language, definition] of Object.entries(AGGREGATED_CONTENT_LANGUAGES)) {
    // Generic veto: a closely-related language's markers suppress this
    // language so shared-script content is never misattributed by default.
    if (definition.vetoWords?.some(word => tokens.has(word.toLocaleLowerCase('en')))) continue;
    const groupVotes = { script: false, chars: false, phrase: false, words: false };
    if (definition.scripts) {
      groupVotes.script = definition.scripts.some(script => {
        if (script === 'Arabic' && definition.arabicMarkers) {
          return new RegExp(`\\p{Script=${script}}`, 'u').test(value) &&
            new RegExp(`[${definition.arabicMarkers}]`).test(value);
        }
        return new RegExp(`\\p{Script=${script}}`, 'u').test(value);
      });
    }
    if (definition.diacritics) {
      groupVotes.chars = countPatternMatches(value, new RegExp(`[${definition.diacritics.chars}]`, 'g')) >= definition.diacritics.threshold;
    }
    if (definition.phraseKeywords) {
      groupVotes.phrase = definition.phraseKeywords.some(keyword => lower.includes(keyword));
    }
    if (definition.wordKeywords) {
      groupVotes.words = definition.wordKeywords.words.filter(keyword => tokens.has(keyword)).length >= definition.wordKeywords.minHits;
    }
    if (!groupVotes.script && !groupVotes.chars && !groupVotes.phrase && !groupVotes.words) continue;
    // Shared-script guard: the script alone identifies the script family,
    // not the language — without a corroborating language-specific signal
    // the description abstains instead of guessing.
    if (definition.scriptNeedsCorroboration && groupVotes.script && !groupVotes.chars && !groupVotes.phrase && !groupVotes.words) continue;
    votes.add(language);
  }
  if (votes.size !== 1) return null;
  return [...votes][0];
}

export interface AggregatedContentLanguage {
  language: string;
  countries: string[];
  usable: number;
  votes: number;
  share: number;
  confidence: number;
}

/**
 * Aggregates per-video language votes over already-fetched descriptions.
 * Returns null unless ALL high-confidence conditions hold: ≥8 usable
 * descriptions, ≥80% share for a single winner, no second eligible language
 * with ≥2 votes, and no playlist corroboration veto. Playlists can only veto
 * (a playlist voting a different eligible language voids dominance), never
 * decide. Pure function — no I/O, no quota.
 */
export function aggregateContentLanguage(
  descriptions: string[],
  playlists: Array<{ name?: string; description?: string }> = []
): AggregatedContentLanguage | null {
  const usableTexts = (descriptions || []).map(text => (text || '').trim()).filter(Boolean).slice(0, 10);
  if (usableTexts.length < AGGREGATED_LANGUAGE_MIN_USABLE) return null;
  const tally = new Map<string, number>();
  for (const text of usableTexts) {
    const vote = voteVideoDescriptionLanguage(text);
    if (vote) tally.set(vote, (tally.get(vote) || 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [language, votes] = ranked[0];
  const share = votes / usableTexts.length;
  if (share < AGGREGATED_LANGUAGE_MIN_SHARE) return null;
  if (ranked.length > 1 && ranked[1][1] >= 2) return null;
  const playlistTexts = (playlists || [])
    .flatMap(item => [item?.name || '', item?.description || ''])
    .filter(text => text.trim());
  for (const text of playlistTexts) {
    const vote = voteVideoDescriptionLanguage(text);
    if (vote && vote !== language) return null;
  }
  const spec = AGGREGATED_CONTENT_LANGUAGES[language];
  if (!spec) return null;
  return {
    language,
    countries: [...spec.countries],
    usable: usableTexts.length,
    votes,
    share,
    confidence: share === 1 ? 90 : 86
  };
}

export function assessChannelCountry(
  input: CountryInferenceInput,
  exclusions: ExcludedCountry[] = [],
  vocabularies: CountryVocabulary[] = []
): CountryAssessment {
  const evidence: CountryInferenceEvidence[] = [];
  const discoveryCountry = input.discoveryCountry?.trim() ? canonicalCountry(input.discoveryCountry) : null;
  const evidenceAvailability: CountryEvidenceAvailability = input.metadataStatus || 'NOT_REQUESTED';

  const official = input.officialCountry?.trim();
  if (official) {
    const country = canonicalCountry(official);
    evidence.push({ source: 'OFFICIAL_YOUTUBE_METADATA', priority: 1, detectedCountry: country, confidence: 100, matchedValue: official, sourceField: 'locationTag', reasoning: `YouTube's official channel country field identifies ${country}.` });
  }

  // P2 provenance boundary: creator-country bio evidence is matched per
  // legitimate creator-level field — channelName, description (aboutBio),
  // socialBios[] — and every item records which field produced it. Exchange
  // references, discovery context, video metadata, website content, and
  // crawler trail prose are never P2 inputs, so they cannot become
  // creator-country proof no matter what country names they mention.
  const bioFields: Array<{ sourceField: 'channelName' | 'description' | 'socialBios'; text: string }> = [
    { sourceField: 'channelName', text: (input.channelName || '').toLocaleLowerCase('en') },
    { sourceField: 'description', text: (input.aboutBio || '').toLocaleLowerCase('en') },
    ...((input.socialBios || []).map(bio => ({ sourceField: 'socialBios' as const, text: bio.toLocaleLowerCase('en') }))),
  ];
  for (const field of bioFields) {
    if (!field.text.trim()) continue;
    addTextEvidence(evidence, 'CHANNEL_ABOUT_BIO', 2, 92, field.text, 'bio', 'Channel About/Bio location', field.sourceField);
  }

  // Match explicit domicile phrases (e.g. "based in Nigeria", "located in Kenya", "trader from Ghana")
  for (const item of exclusions) {
    const name = item.country_name.toLocaleLowerCase('en');
    if (name.length < 3) continue;
    const domicileRegex = new RegExp(`\\b(?:based in|located in|living in|trader from|from|trader in)\\s+${name}\\b|\\b${name}\\s+(?:based|trader|forex trader|crypto trader)\\b`, 'i');
    for (const field of bioFields) {
      if (!field.text.trim()) continue;
      const match = field.text.match(domicileRegex);
      if (match && !evidence.some(e => e.source === 'CHANNEL_ABOUT_BIO' && normalizeCountryName(e.detectedCountry) === normalizeCountryName(item.country_name))) {
        evidence.push({
          source: 'CHANNEL_ABOUT_BIO',
          priority: 2,
          detectedCountry: canonicalCountry(item.country_name),
          confidence: 92,
          matchedValue: match[0],
          matchedContext: matchWindow(field.text, match[0]),
          sourceField: field.sourceField,
          reasoning: `Channel About/Bio location: '${match[0]}' indicates ${canonicalCountry(item.country_name)}.`
        });
      }
    }
  }

  for (const link of input.officialWebsiteLinks || []) {
    const host = hostname(link);
    if (!host || SOCIAL_HOSTS.some(social => host === social || host.endsWith(`.${social}`))) continue;
    for (const [country, signals] of Object.entries(COUNTRY_SIGNALS)) {
      const match = signals.tlds.find(tld => host.endsWith(tld));
      if (match) evidence.push({ source: 'OFFICIAL_WEBSITE_DOMAIN', priority: 3, detectedCountry: country, confidence: 90, matchedValue: host, sourceField: 'officialWebsiteLinks', reasoning: `Official website hostname '${host}' uses the ${match} country domain for ${country}.` });
    }
  }

  for (const link of input.verifiedSocialLinks || []) {
    const host = hostname(link);
    if (!SOCIAL_HOSTS.some(social => host === social || host.endsWith(`.${social}`))) continue;
    addTextEvidence(evidence, 'VERIFIED_SOCIAL_LINK', 4, 82, link.toLocaleLowerCase('en'), 'social', `Verified social profile ${host}`, 'verifiedSocialLinks');
  }

  // Indirect signals scan the full creator text (description, social bios,
  // video titles). They can never become P2 creator-country proof — that
  // boundary is enforced by source allowlisting at selection time — but their
  // coverage must not shrink when social bios travel in a separate field.
  const content = `${input.aboutBio || ''} ${(input.socialBios || []).join(' ')} ${(input.videoTitles || []).join(' ')}`.toLocaleLowerCase('en');
  const contentField = 'aboutBio/socialBios/videoTitles';
  addTextEvidence(evidence, 'EXCHANGE_REFERENCE', 5, 78, content, 'exchanges', 'Regional exchange reference', contentField);
  addTextEvidence(evidence, 'BROKER_REFERENCE', 6, 72, content, 'brokers', 'Regional broker reference', contentField);
  addTextEvidence(evidence, 'PHONE_NUMBER', 7, 68, content, 'phones', 'International phone prefix', contentField);
  addTextEvidence(evidence, 'PHYSICAL_ADDRESS', 8, 64, content, 'addresses', 'Physical address or city', contentField);

  for (const [country, signals] of Object.entries(COUNTRY_SIGNALS)) {
    const matches = signals.language.filter(signal => content.includes(signal.toLocaleLowerCase('en')));
    if (matches.length >= 2) {
      evidence.push({
        source: 'NATIVE_LANGUAGE',
        priority: 9,
        detectedCountry: country,
        confidence: Math.min(58, 48 + matches.length * 2),
        matchedValue: matches.slice(0, 3).join(', '),
        matchedContext: matchWindow(content, matches[0]),
        sourceField: contentField,
        reasoning: `Multiple native-language market terms indicate ${country}: ${matches.slice(0, 3).join(', ')}.`
      });
    }
  }
  for (const vocab of vocabularies) {
    const terms = [...(vocab.native_trading_terminology || []), ...(vocab.local_market_phrases || [])].map(term => term.toLocaleLowerCase('en')).filter(term => term.length >= 4);
    const matches = terms.filter(term => content.includes(term));
    if (matches.length >= 2 && !evidence.some(item => item.source === 'NATIVE_LANGUAGE' && normalizeCountryName(item.detectedCountry) === normalizeCountryName(vocab.country))) {
      evidence.push({ source: 'NATIVE_LANGUAGE', priority: 9, detectedCountry: vocab.country, confidence: 52, matchedValue: matches.slice(0, 3).join(', '), matchedContext: matchWindow(content, matches[0]), sourceField: contentField, reasoning: `Multiple curated native market terms indicate ${vocab.country}: ${matches.slice(0, 3).join(', ')}.` });
    }
  }

  // Provenance logging ONLY: DISCOVERY_CONTEXT is recorded in evidence list for traceability
  if (discoveryCountry) {
    evidence.push({
      source: 'DISCOVERY_CONTEXT',
      priority: 10,
      detectedCountry: discoveryCountry,
      confidence: 25,
      matchedValue: input.discoveryCountry,
      sourceField: 'discoveryCountry',
      reasoning: `Discovery context suggests ${discoveryCountry}; no creator-level attribution is implied.`
    });
  }

  // AGGREGATED_CONTENT_LANGUAGE (P3): dominant creator-written language across
  // already-fetched video descriptions. Evaluated only when no P1/P2 evidence
  // exists (those tiers outrank unconditionally, so a conclusive bio or
  // official country skips this path entirely) AND the descriptions carry an
  // authoritative recent-channel provenance flag (see
  // videoDescriptionsAuthoritative). Search-selected / retrieval-selected
  // snippets can never vote, no matter how dominant they look.
  //
  // The linked website plays NO role here — it must not select from a
  // multi-country set, nor enable, confirm, or block the language decision: a
  // website could be an affiliate, broker, or unrelated third party. A valid
  // language signal therefore decides on its own, website agreement or
  // disagreement notwithstanding. Website evidence remains in the audit trail
  // below but is excluded from this decision by construction.
  if (!evidence.some(item => item.source === 'OFFICIAL_YOUTUBE_METADATA' || item.source === 'CHANNEL_ABOUT_BIO')) {
    if (input.videoDescriptionsAuthoritative === true) {
      const aggregated = aggregateContentLanguage(input.videoDescriptions || [], input.playlists || []);
      if (aggregated) {
        const isLiveExcluded = (country: string): boolean =>
          exclusions.some(item => normalizeCountryName(item.country_name) === normalizeCountryName(country));
        // Language-only rejection requires every candidate country currently
        // excluded. If any set member is not excluded, emit nothing.
        if (aggregated.countries.every(isLiveExcluded)) {
          const representative = [...aggregated.countries].sort((a, b) => a.localeCompare(b))[0];
          const firstVoting = (input.videoDescriptions || []).map(text => (text || '').trim()).filter(Boolean)
            .find(text => voteVideoDescriptionLanguage(text) === aggregated.language) || '';
          const setLabel = `candidate countries [${aggregated.countries.join(', ')}]`;
          const languageItem: CountryInferenceEvidence = {
            source: 'AGGREGATED_CONTENT_LANGUAGE' as const,
            priority: 3,
            detectedCountry: representative,
            confidence: aggregated.confidence,
            ...(aggregated.countries.length > 1 ? { candidateCountries: [...aggregated.countries] } : {}),
            matchedValue: `${aggregated.votes}/${aggregated.usable} ${aggregated.language}`,
            matchedContext: firstVoting.slice(0, 160),
            sourceField: 'videoDescriptions',
            reasoning: `${aggregated.votes}/${aggregated.usable} recent video descriptions in ${aggregated.language} (${setLabel}, all currently excluded).`
          };
          const policy: CountryInferenceEvidence = {
            source: 'EXCLUSION_POLICY',
            priority: 0,
            detectedCountry: representative,
            confidence: aggregated.confidence,
            reasoning: `${representative} is excluded by policy: ${(exclusions.find(item => normalizeCountryName(item.country_name) === normalizeCountryName(representative))?.reason) || 'Excluded by policy'}.`
          };
          return {
            discoveryCountry,
            detectedCreatorCountry: representative,
            countryEvidence: [policy, languageItem, ...evidence],
            countryStatus: 'REJECTED',
            evidenceAvailability,
            gateDisposition: 'REJECT_EXCLUDED',
            confidence: aggregated.confidence,
            reasoning: policy.reasoning,
            decisiveEvidence: [languageItem],
            rejectionReason: policy.reasoning
          };
        }
        // Map invalid under the live list: fall through with no language item.
      }
    }
  }

  // STRICT CREATOR EVIDENCE ALLOWLIST:
  // Filter evidence down exclusively to sources allowed to attribute creator domicile.
  const creatorEvidence = evidence.filter(item => CREATOR_EVIDENCE_SOURCES.has(item.source));

  if (creatorEvidence.length === 0) {
    return {
      discoveryCountry,
      detectedCreatorCountry: null,
      countryEvidence: evidence,
      countryStatus: 'UNCERTAIN',
      evidenceAvailability,
      gateDisposition: 'CONTINUE_CRAWLING',
      confidence: 0,
      reasoning: 'No creator-level country evidence was available.',
      decisiveEvidence: []
    };
  }

  const decisivePriority = Math.min(...creatorEvidence.map(item => item.priority));
  const decisiveEvidence = creatorEvidence.filter(item => item.priority === decisivePriority);
  const countryScores = new Map<string, number>();
  decisiveEvidence.forEach(item => countryScores.set(item.detectedCountry, Math.max(countryScores.get(item.detectedCountry) || 0, item.confidence)));
  const ranked = [...countryScores.entries()].sort((a, b) => b[1] - a[1]);
  const [detectedCreatorCountry, topConfidence] = ranked[0];
  const conflict = ranked.length > 1 && ranked[1][1] === topConfidence;
  const confidence = conflict ? Math.min(49, topConfidence) : topConfidence;
  const excluded = exclusions.find(item => normalizeCountryName(item.country_name) === normalizeCountryName(detectedCreatorCountry));
  const exclusionAuthority = decisiveEvidence.every(item => item.detectedCountry === detectedCreatorCountry) &&
    decisivePriority <= 3 && topConfidence >= 85 && !conflict;

  if (excluded && exclusionAuthority) {
    const policy: CountryInferenceEvidence = {
      source: 'EXCLUSION_POLICY',
      priority: 0,
      detectedCountry: detectedCreatorCountry,
      confidence: topConfidence,
      reasoning: `${detectedCreatorCountry} is excluded by policy: ${excluded.reason}.`
    };
    return {
      discoveryCountry,
      detectedCreatorCountry,
      countryEvidence: [policy, ...evidence],
      countryStatus: 'REJECTED',
      evidenceAvailability,
      gateDisposition: 'REJECT_EXCLUDED',
      confidence: topConfidence,
      reasoning: policy.reasoning,
      decisiveEvidence,
      rejectionReason: policy.reasoning
    };
  }

  const countryStatus: CountryStatus = conflict ? 'UNCERTAIN' : confidence >= 85 ? 'CONFIRMED' : confidence >= 60 ? 'LIKELY' : 'UNCERTAIN';
  const gateDisposition: GateDisposition = conflict ? 'NEEDS_REVIEW' : countryStatus === 'CONFIRMED' || countryStatus === 'LIKELY' ? 'ALLOW_NORMAL' : 'CONTINUE_CRAWLING';
  const reasoning = conflict
    ? `Conflicting ${decisiveEvidence[0].source} evidence prevents a reliable country decision.`
    : `${decisiveEvidence[0].source} is the highest-priority available source and identifies ${detectedCreatorCountry}.`;

  return {
    discoveryCountry,
    detectedCreatorCountry,
    countryEvidence: evidence.sort((a, b) => a.priority - b.priority),
    countryStatus,
    evidenceAvailability,
    gateDisposition,
    confidence,
    reasoning,
    decisiveEvidence
  };
}

export function inferChannelCountry(
  input: CountryInferenceInput,
  exclusions: ExcludedCountry[] = [],
  vocabularies: CountryVocabulary[] = []
): CountryInferenceResult {
  const assessment = assessChannelCountry(input, exclusions, vocabularies);
  return {
    ...assessment,
    detectedCountry: assessment.detectedCreatorCountry,
    status: assessment.countryStatus,
    evidence: assessment.countryEvidence
  };
}
