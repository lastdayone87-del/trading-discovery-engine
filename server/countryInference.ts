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
}

export interface CountryInferenceInput {
  officialCountry?: string;
  channelName?: string;
  aboutBio?: string;
  officialWebsiteLinks?: string[];
  verifiedSocialLinks?: string[];
  videoTitles?: string[];
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
  'NATIVE_LANGUAGE'
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
  ao:'Angola', lk:'Sri Lanka'
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
  return signals.find(signal => text.includes(signal.toLocaleLowerCase('en'))) || null;
}

function addTextEvidence(evidence: CountryInferenceEvidence[], source: CountryEvidenceSource, priority: number, confidence: number, text: string, key: keyof typeof COUNTRY_SIGNALS[string], reason: string): void {
  for (const [country, signals] of Object.entries(COUNTRY_SIGNALS)) {
    const match = includesSignal(text, signals[key]);
    if (match) evidence.push({ source, priority, detectedCountry: country, confidence, matchedValue: match, reasoning: `${reason}: '${match}' indicates ${country}.` });
  }
}

function hostname(link: string): string {
  try { return new URL(link).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Perform country assessment separating discovery context from creator-level evidence.
 * Structurally guarantees DISCOVERY_CONTEXT can NEVER populate detectedCreatorCountry or trigger REJECTED.
 */
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
    evidence.push({ source: 'OFFICIAL_YOUTUBE_METADATA', priority: 1, detectedCountry: country, confidence: 100, matchedValue: official, reasoning: `YouTube's official channel country field identifies ${country}.` });
  }

  const bioText = `${input.channelName || ''} ${input.aboutBio || ''}`.toLocaleLowerCase('en');
  addTextEvidence(evidence, 'CHANNEL_ABOUT_BIO', 2, 92, bioText, 'bio', 'Channel About/Bio location');

  // Match explicit domicile phrases (e.g. "based in Nigeria", "located in Kenya", "trader from Ghana")
  for (const item of exclusions) {
    const name = item.country_name.toLocaleLowerCase('en');
    if (name.length < 3) continue;
    const domicileRegex = new RegExp(`\\b(?:based in|located in|living in|trader from|from|trader in)\\s+${name}\\b|\\b${name}\\s+(?:based|trader|forex trader|crypto trader)\\b`, 'i');
    const match = bioText.match(domicileRegex);
    if (match && !evidence.some(e => e.source === 'CHANNEL_ABOUT_BIO' && normalizeCountryName(e.detectedCountry) === normalizeCountryName(item.country_name))) {
      evidence.push({
        source: 'CHANNEL_ABOUT_BIO',
        priority: 2,
        detectedCountry: canonicalCountry(item.country_name),
        confidence: 92,
        matchedValue: match[0],
        reasoning: `Channel About/Bio location: '${match[0]}' indicates ${canonicalCountry(item.country_name)}.`
      });
    }
  }

  for (const link of input.officialWebsiteLinks || []) {
    const host = hostname(link);
    if (!host || SOCIAL_HOSTS.some(social => host === social || host.endsWith(`.${social}`))) continue;
    for (const [country, signals] of Object.entries(COUNTRY_SIGNALS)) {
      const match = signals.tlds.find(tld => host.endsWith(tld));
      if (match) evidence.push({ source: 'OFFICIAL_WEBSITE_DOMAIN', priority: 3, detectedCountry: country, confidence: 90, matchedValue: host, reasoning: `Official website hostname '${host}' uses the ${match} country domain for ${country}.` });
    }
  }

  for (const link of input.verifiedSocialLinks || []) {
    const host = hostname(link);
    if (!SOCIAL_HOSTS.some(social => host === social || host.endsWith(`.${social}`))) continue;
    addTextEvidence(evidence, 'VERIFIED_SOCIAL_LINK', 4, 82, link.toLocaleLowerCase('en'), 'social', `Verified social profile ${host}`);
  }

  const content = `${input.aboutBio || ''} ${(input.videoTitles || []).join(' ')}`.toLocaleLowerCase('en');
  addTextEvidence(evidence, 'EXCHANGE_REFERENCE', 5, 78, content, 'exchanges', 'Regional exchange reference');
  addTextEvidence(evidence, 'BROKER_REFERENCE', 6, 72, content, 'brokers', 'Regional broker reference');
  addTextEvidence(evidence, 'PHONE_NUMBER', 7, 68, content, 'phones', 'International phone prefix');
  addTextEvidence(evidence, 'PHYSICAL_ADDRESS', 8, 64, content, 'addresses', 'Physical address or city');

  for (const [country, signals] of Object.entries(COUNTRY_SIGNALS)) {
    const matches = signals.language.filter(signal => content.includes(signal.toLocaleLowerCase('en')));
    if (matches.length >= 2) {
      evidence.push({
        source: 'NATIVE_LANGUAGE',
        priority: 9,
        detectedCountry: country,
        confidence: Math.min(58, 48 + matches.length * 2),
        matchedValue: matches.slice(0, 3).join(', '),
        reasoning: `Multiple native-language market terms indicate ${country}: ${matches.slice(0, 3).join(', ')}.`
      });
    }
  }
  for (const vocab of vocabularies) {
    const terms = [...(vocab.native_trading_terminology || []), ...(vocab.local_market_phrases || [])].map(term => term.toLocaleLowerCase('en')).filter(term => term.length >= 4);
    const matches = terms.filter(term => content.includes(term));
    if (matches.length >= 2 && !evidence.some(item => item.source === 'NATIVE_LANGUAGE' && normalizeCountryName(item.detectedCountry) === normalizeCountryName(vocab.country))) {
      evidence.push({ source: 'NATIVE_LANGUAGE', priority: 9, detectedCountry: vocab.country, confidence: 52, matchedValue: matches.slice(0, 3).join(', '), reasoning: `Multiple curated native market terms indicate ${vocab.country}: ${matches.slice(0, 3).join(', ')}.` });
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
      reasoning: `Discovery context suggests ${discoveryCountry}; no creator-level attribution is implied.`
    });
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
  const gateDisposition: GateDisposition = countryStatus === 'CONFIRMED' || countryStatus === 'LIKELY' ? 'ALLOW_NORMAL' : 'CONTINUE_CRAWLING';
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
