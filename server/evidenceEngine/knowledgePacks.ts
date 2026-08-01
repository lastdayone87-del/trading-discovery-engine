import { CountryKnowledgePack, LanguageKnowledge, LayeredKnowledgeContext } from './types';
import { SUPPORTED_CLASSIFICATION_COUNTRIES } from './multilingualTerminology';

// ============================================================================
// 1. GLOBAL KNOWLEDGE PACK (Universal Financial Market Terms)
// ============================================================================
export const GLOBAL_INSTRUMENTS = [
  'nq', 'es', 'ym', 'rty', 'dax', 'ftse', 'cac40', 'nikkei', 'spx', 'ndx', 'vix',
  'eurusd', 'gbpusd', 'usdjpy', 'audusd', 'usdcad', 'usdchf', 'nzdusd', 'xauusd', 'xagusd', 'cl', 'ng', 'btc', 'eth', 'sol',
  'futures', 'forex', 'options', '0dte', 'perpetual futures', 'leverage', 'equities', 'bonds', 'treasuries', 'stocks', 'crypto', 'defi'
];

export const GLOBAL_PLATFORMS_BROKERS_PROPFIRMS = [
  'ninjatrader', 'sierra chart', 'quantower', 'tradingview', 'metatrader', 'mt4', 'mt5', 'tradovate',
  'topstep', 'apex trader funding', 'apex', 'ftmo', 'funding pips', 'myfundedfx', 'the funded trader', 'fundednext',
  'interactive brokers', 'thinkorswim', 'tastytrade', 'robinhood', 'binance', 'bybit', 'mexc', 'okx', 'kraken'
];

export const GLOBAL_ADVANCED_CONCEPTS = [
  'order flow', 'dom', 'depth of market', 'footprint chart', 'delta divergence', 'volume profile', 'poc',
  'ict', 'smart money concepts', 'smc', 'fair value gap', 'fvg', 'order block', 'liquidity sweep', 'break of structure',
  'price action', 'market structure', 'scalping', 'swing trading', 'day trading', 'position sizing', 'risk management',
  'backtesting', 'trading journal', 'technical analysis', 'chart patterns', 'candlestick', 'trading psychology',
  'trader mindset', 'market analysis', 'daily bias', 'premarket analysis', 'trade setup', 'trading strategy'
];

export const GLOBAL_NEGATIVE_TERMS = [
  'minecraft', 'roblox', 'fortnite', 'cs:go', 'cs2', 'rocket league', 'steam market', 'call of duty', 'warzone',
  'gta', 'gaming', 'walkthrough', 'gameplay', 'vlog', 'makeup', 'beauty', 'fashion', 'cooking', 'recipe',
  'unboxing', 'toy', 'asmr', 'music video', 'cover song', 'kpop', 'anime', 'workout', 'fitness', 'travel vlog',
  'travel', 'travel guide', 'tourist', 'tourism', 'city tour', 'hotel review', 'food vlog', 'canal tour', 'bike tour',
  'vacation', 'trip', 'travels', 'sightseeing', 'backpacking', 'vlogger', 'walking tour', 'guidebook',
  'pokemon cards', 'yugioh', 'dropshipping', 'amazon fba', 'real estate investing', 'property investing',
  'baking', 'pâtisserie', 'garten', 'pflanzen', 'padel', 'flamenco', 'lucha libre', 'cricket match', 'futebol',
  'desert safari', 'oud oils', 'hawker food', 'outdoor hockey', 'surfing beach', 'lifestyle'
];

// ============================================================================
// 2. LANGUAGE KNOWLEDGE PACKS
// ============================================================================
export const LANGUAGE_KNOWLEDGE_PACKS: Record<string, LanguageKnowledge> = {
  en: {
    languageCode: 'en',
    languageName: 'English',
    positiveTerms: ['trading', 'trader', 'market analysis', 'trade setup', 'charting', 'live trading', 'daily bias', 'day trading', 'scalping', 'swing trading', 'price action', 'risk management', 'trading psychology', 'crypto yield', 'defi'],
    negativeTerms: ['gameplay', 'unboxing', 'makeup', 'asmr', 'vlog', 'lifestyle'],
    commonPhrases: ['daily premarket analysis', 'live day trading', 'weekly market outlook', 'trading strategy']
  },
  de: {
    languageCode: 'de',
    languageName: 'German',
    positiveTerms: ['boerse', 'aktien', 'boersenhandel', 'dax analyse', 'fremdkapital', 'tageshandel', 'chartanalyse', 'trading deutschland', 'boersenbrief'],
    negativeTerms: ['videospiel', 'let\'s play', 'rezepte', 'mode', 'garten', 'pflanzen', 'kochen'],
    commonPhrases: ['dax live analyse', 'aktien fuer anfanger', 'fremdkapital trading']
  },
  fr: {
    languageCode: 'fr',
    languageName: 'French',
    positiveTerms: ['bourse', 'analyse technique', 'gagner en bourse', 'propfirm france', 'cac40', 'trading fr', 'analyse boursiere', 'carnet d\'ordres', 'pea', 'portefeuille'],
    negativeTerms: ['jeu video', 'recette de cuisine', 'maquillage', 'pâtisserie', 'mode masculin', 'mode', 'style masculin'],
    commonPhrases: ['analyse cac40 live', 'trading pour debutant', 'formation bourse', 'portefeuille pea']
  },
  es: {
    languageCode: 'es',
    languageName: 'Spanish',
    positiveTerms: ['bolsa de valores', 'trading en espanol', 'analisis tecnico', 'mercado financiero', 'cuentas fondeadas', 'velas japonesas', 'operativa en vivo', 'acciones y dividendos', 'criptomonedas', 'bolsa española', 'dividendos'],
    negativeTerms: ['videojuegos', 'recetas de cocina', 'maquillaje', 'flamenco', 'padel', 'lucha libre'],
    commonPhrases: ['analisis diario de bolsa', 'trading para principiantes', 'estrategia de trading']
  },
  it: {
    languageCode: 'it',
    languageName: 'Italian',
    positiveTerms: ['borsa italiana', 'analisi tecnica', 'ftse mib', 'trading italia', 'conto prop firm', 'azioni italia', 'mercati finanziari'],
    negativeTerms: ['videogiochi', 'ricette', 'trucco', 'pasta italiana'],
    commonPhrases: ['analisi ftse mib', 'corso di trading', 'trading dal vivo']
  },
  ja: {
    languageCode: 'ja',
    languageName: 'Japanese',
    positiveTerms: ['FXトレード', '株式投資', '日経225', 'テクニカル分析', 'チャート分析', 'プロップファーム', 'ドル円', 'デイトレード', '暗号資産', 'スマートマネー', '株主優待', '高配当株'],
    negativeTerms: ['ゲーム実況', 'メイク', '料理', 'アニメ'],
    commonPhrases: ['日経225チャート分析', 'FX初心者講座', 'リアルタイムトレード', 'ドル円 デイトレード']
  },
  nl: {
    languageCode: 'nl',
    languageName: 'Dutch',
    positiveTerms: ['beurs', 'beursanalyse', 'aex', 'aex-index', 'technische analyse', 'handelen in opties', 'beleggen', 'daghandel', 'marktanalyse', 'aandelen', 'beursvideos', 'optiestrategie', 'ochtendupdate', 'beursnieuws', 'beleggingsforum'],
    negativeTerms: ['voetbal', 'recepten', 'amsterdam vlog', 'gaming', 'make-up', 'vlog'],
    commonPhrases: ['opening amsterdamse beurs', 'weekoverzicht beurs', 'analyse van de dag', 'beurs update']
  },
  da: { languageCode: 'da', languageName: 'Danish', positiveTerms: ['aktiehandel', 'teknisk analyse', 'børsanalyse', 'risikostyring'], negativeTerms: ['gaming', 'madopskrift', 'fodbold'], commonPhrases: ['daglig markedsanalyse', 'handelsstrategi'] },
  sv: { languageCode: 'sv', languageName: 'Swedish', positiveTerms: ['aktiehandel', 'teknisk analys', 'börsanalys', 'riskhantering'], negativeTerms: ['gaming', 'matrecept', 'fotboll'], commonPhrases: ['daglig marknadsanalys', 'handelsstrategi'] },
  ar: { languageCode: 'ar', languageName: 'Arabic', positiveTerms: ['تداول الأسهم', 'تحليل فني', 'إدارة المخاطر', 'خطة التداول'], negativeTerms: ['ألعاب', 'طبخ', 'سياحة'], commonPhrases: ['تحليل السوق اليومي', 'استراتيجية التداول'] }
};

// ============================================================================
// 3. COUNTRY KNOWLEDGE PACKS (Local exchanges, brokers, phrases)
// ============================================================================
export const COUNTRY_KNOWLEDGE_PACKS: Record<string, CountryKnowledgePack> = {
  'United States': {
    countryName: 'United States',
    primaryLanguage: 'en',
    regionalExchanges: ['NYSE', 'NASDAQ', 'CME', 'CBOT', 'NYMEX', 'CBOE'],
    localBrokers: ['Interactive Brokers', 'TD Ameritrade', 'Schwab', 'E*TRADE', 'Fidelity', 'Tradovate'],
    popularInstruments: ['NQ', 'ES', 'SPX', '0DTE', 'CL', 'Gold'],
    localPropFirms: ['Topstep', 'Apex Trader Funding', 'Take Profit Trader', 'UProfit'],
    nativeTradingTerminology: ['Premarket highs', 'Opening bell', 'FOMC rate decision', 'NFP report', 'VWAP bounce'],
    regionalNegativeTerms: ['College vlog', 'NBA highlights', 'NFL reaction']
  },
  'United Kingdom': {
    countryName: 'United Kingdom',
    primaryLanguage: 'en',
    regionalExchanges: ['LSE', 'London Stock Exchange', 'ICE Futures Europe'],
    localBrokers: ['IG Index', 'CMC Markets', 'City Index', 'Trading 212', 'Saxobank'],
    popularInstruments: ['FTSE', 'FTSE 100', 'Cable', 'GBPUSD', 'EURGBP', 'DeFi', 'Yield'],
    localPropFirms: ['FTMO UK', 'Funding Pips', 'Alpha Capital Group'],
    nativeTradingTerminology: ['London session open', 'Spread betting', 'ISA portfolio', 'BoE rate decision', 'Crypto yield'],
    regionalNegativeTerms: ['Premier League fan TV', 'Pub crawl vlog', 'Property investing']
  },
  'Germany': {
    countryName: 'Germany',
    primaryLanguage: 'de',
    regionalExchanges: ['Xetra', 'Frankfurt Stock Exchange', 'Eurex'],
    localBrokers: ['Consorsbank', 'Comdirect', 'Trade Republic', 'Flatex', 'XTB Germany'],
    popularInstruments: ['DAX', 'FDAX', 'DAX40', 'EURUSD', 'Bund Futures'],
    localPropFirms: ['FTMO DACH', 'Fremdkapital Firmen'],
    nativeTradingTerminology: ['DAX eröffnung', 'Xetra schlusskurs', 'Chartanalyse deutsch', 'Tagesrading'],
    regionalNegativeTerms: ['Bundesliga reaction', 'Auto bahn vlog', 'Garten', 'Pflanzen', 'Rezepte']
  },
  'France': {
    countryName: 'France',
    primaryLanguage: 'fr',
    regionalExchanges: ['Euronext Paris', 'MATIF'],
    localBrokers: ['Boursorama', 'Bourse Direct', 'Degiro France', 'XTB France'],
    popularInstruments: ['CAC40', 'FCAC', 'EURUSD', 'Euronext Wheat', 'PEA'],
    localPropFirms: ['PropFirm France', 'FTMO France'],
    nativeTradingTerminology: ['Ouverture CAC40', 'Analyse boursiere', 'Scalping CAC', 'Carnet d\'ordres', 'Portefeuille PEA'],
    regionalNegativeTerms: ['Recette crepe', 'Visite Paris vlog', 'Pâtisserie', 'Cuisine', 'Mode', 'Style masculin']
  },
  'Spain': {
    countryName: 'Spain',
    primaryLanguage: 'es',
    regionalExchanges: ['BME', 'Bolsa de Madrid', 'MEFF'],
    localBrokers: ['Interactive Brokers Spain', 'Renta 4', 'XTB Spain', 'Self Bank'],
    popularInstruments: ['IBEX35', 'EURUSD', 'Wall Street Espanol', 'Criptomonedas'],
    localPropFirms: ['Fondo de Fondeo', 'PropFirm Espana'],
    nativeTradingTerminology: ['Apertura IBEX', 'Analisis tecnico espanol', 'Velas japonesas', 'Operativa en vivo', 'Bolsa Española'],
    regionalNegativeTerms: ['La Liga resumen', 'Receta paella', 'Flamenco', 'Padel', 'Tapas']
  },
  'Italy': {
    countryName: 'Italy',
    primaryLanguage: 'it',
    regionalExchanges: ['Borsa Italiana', 'Euronext Milan'],
    localBrokers: ['FinecoBank', 'Directa', 'DEGIRO Italia'],
    popularInstruments: ['FTSE MIB', 'BTP Futures', 'EURUSD'],
    localPropFirms: ['FTMO Italy', 'Prop Trading Italia'],
    nativeTradingTerminology: ['Apertura Piazza Affari', 'Analisi tecnica Borsa Italiana', 'Titoli azionari'],
    regionalNegativeTerms: ['Ricette di pasta', 'Cucina italiana', 'Turismo']
  },
  'Japan': {
    countryName: 'Japan',
    primaryLanguage: 'ja',
    regionalExchanges: ['TSE', 'Tokyo Stock Exchange', 'JPX', 'Osaka Exchange'],
    localBrokers: ['SBI Securities', 'Rakuten Securities', 'GMO Click Securities', 'DMM FX'],
    popularInstruments: ['Nikkei 225', 'NK225', 'USDJPY', 'JGB Futures'],
    localPropFirms: ['Fintokei Japan', 'FTMO Japan'],
    nativeTradingTerminology: ['東京市場', '日経平均', '為替介入', 'ローソク足', '板情報', 'ドル円 デイトレード', 'スマートマネーコンセプト', '株主優待'],
    regionalNegativeTerms: ['アニメ感想', 'ゲーム実況', 'スマート家電']
  },
  'Canada': {
    countryName: 'Canada',
    primaryLanguage: 'en',
    regionalExchanges: ['TSX', 'TSX Venture', 'MX'],
    localBrokers: ['Questrade', 'Wealthsimple', 'TD Direct Investing'],
    popularInstruments: ['TSX 60', 'USDCAD', 'Crude Oil', 'Gold'],
    localPropFirms: ['Apex Canada', 'Topstep Canada'],
    nativeTradingTerminology: ['TSX open', 'USDCAD analysis'],
    regionalNegativeTerms: ['Outdoor hockey', 'Camping Canada']
  },
  'Australia': {
    countryName: 'Australia',
    primaryLanguage: 'en',
    regionalExchanges: ['ASX', 'Australian Securities Exchange'],
    localBrokers: ['CommSec', 'CMC Markets AU', 'Stake'],
    popularInstruments: ['ASX 200', 'AUDUSD', 'SPI 200'],
    localPropFirms: ['Funding Pips AU', 'FTMO Australia'],
    nativeTradingTerminology: ['ASX open', 'AUDUSD daily bias'],
    regionalNegativeTerms: ['Surfing vlogs', 'Beach camping AU']
  },
  'Netherlands': {
    countryName: 'Netherlands',
    primaryLanguage: 'nl',
    regionalExchanges: ['AEX', 'Euronext Amsterdam'],
    localBrokers: ['DEGIRO', 'Interactive Brokers NL', 'Lynx', 'Saxo NL'],
    popularInstruments: ['AEX', 'ASML', 'Shell', 'EURUSD', 'Opties'],
    localPropFirms: ['FTMO NL', 'Funding Pips NL'],
    nativeTradingTerminology: ['beurs analyse', 'AEX trading', 'technische analyse', 'handelen in opties', 'marktanalyse', 'beleggen en trading', 'daghandel strategie', 'beursvideos'],
    regionalNegativeTerms: ['Voetbal', 'Amsterdam vlog', 'Recepten']
  },
  'Switzerland': { countryName: 'Switzerland', primaryLanguage: 'de', regionalExchanges: ['SIX Swiss Exchange'], localBrokers: ['Swissquote', 'Saxo Switzerland'], popularInstruments: ['SMI', 'USDCHF'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['Börsenanalyse Schweiz', 'SMI Analyse'], regionalNegativeTerms: ['Swiss travel vlog'] },
  'Denmark': { countryName: 'Denmark', primaryLanguage: 'da', regionalExchanges: ['Nasdaq Copenhagen'], localBrokers: ['Saxo Bank', 'Nordnet Denmark'], popularInstruments: ['OMXC25', 'EURDKK'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['aktiehandel', 'teknisk analyse'], regionalNegativeTerms: ['Danish football'] },
  'Sweden': { countryName: 'Sweden', primaryLanguage: 'sv', regionalExchanges: ['Nasdaq Stockholm'], localBrokers: ['Avanza', 'Nordnet Sweden'], popularInstruments: ['OMXS30', 'SEK'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['aktiehandel', 'teknisk analys'], regionalNegativeTerms: ['Swedish hockey'] },
  'United Arab Emirates': { countryName: 'United Arab Emirates', primaryLanguage: 'ar', regionalExchanges: ['Dubai Financial Market', 'ADX'], localBrokers: ['Sarwa', 'ADSS'], popularInstruments: ['DFM General Index', 'FTSE ADX'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['تداول الأسهم', 'تحليل فني'], regionalNegativeTerms: ['desert safari'] },
  'Singapore': { countryName: 'Singapore', primaryLanguage: 'en', regionalExchanges: ['Singapore Exchange', 'SGX'], localBrokers: ['DBS Vickers', 'Phillip Securities'], popularInstruments: ['Straits Times Index', 'USDSGD'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['SGX trading', 'Singapore market open'], regionalNegativeTerms: ['hawker food'] },
  'New Zealand': { countryName: 'New Zealand', primaryLanguage: 'en', regionalExchanges: ['NZX'], localBrokers: ['Sharesies', 'Jarden'], popularInstruments: ['NZX 50', 'NZDUSD'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['NZX trading', 'RBNZ rate decision'], regionalNegativeTerms: ['rugby highlights'] },
  'Belgium': { countryName: 'Belgium', primaryLanguage: 'nl', regionalExchanges: ['Euronext Brussels'], localBrokers: ['Bolero', 'Keytrade Bank'], popularInstruments: ['BEL 20', 'EURUSD'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['beursanalyse België', 'analyse boursière belge'], regionalNegativeTerms: ['Belgian travel vlog'] },
  'Luxembourg': { countryName: 'Luxembourg', primaryLanguage: 'fr', regionalExchanges: ['Luxembourg Stock Exchange'], localBrokers: ['Swissquote Luxembourg', 'BGL BNP Paribas'], popularInstruments: ['LuxX', 'Eurobonds'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['Bourse de Luxembourg', 'Börsenanalyse'], regionalNegativeTerms: ['Luxembourg tourism'] },
  'Ireland': { countryName: 'Ireland', primaryLanguage: 'en', regionalExchanges: ['Euronext Dublin'], localBrokers: ['Davy Select', 'Goodbody'], popularInstruments: ['ISEQ 20', 'EURUSD'], localPropFirms: ['FTMO'], nativeTradingTerminology: ['Irish stock trading', 'Euronext Dublin'], regionalNegativeTerms: ['Irish travel vlog'] }
};

/** Resolve classification knowledge for every supported production discovery country. */
export function getLayeredKnowledgeContext(countryName?: string): LayeredKnowledgeContext {
  const cName = countryName && countryName !== 'UNKNOWN' ? countryName : 'UNKNOWN';
  const supported = (SUPPORTED_CLASSIFICATION_COUNTRIES as readonly string[]).includes(cName);
  const countryPack = supported ? COUNTRY_KNOWLEDGE_PACKS[cName] : undefined;
  const langCode = countryPack?.primaryLanguage || 'en';
  const languagePack = LANGUAGE_KNOWLEDGE_PACKS[langCode] || LANGUAGE_KNOWLEDGE_PACKS.en;
  return {
    globalInstruments: GLOBAL_INSTRUMENTS,
    globalPlatformsPropFirms: GLOBAL_PLATFORMS_BROKERS_PROPFIRMS,
    globalAdvancedConcepts: GLOBAL_ADVANCED_CONCEPTS,
    globalNegativeTerms: GLOBAL_NEGATIVE_TERMS,
    languageKnowledge: languagePack,
    countryKnowledge: countryPack
  };
}
