import { CountryKnowledgePack, LanguageKnowledge, LayeredKnowledgeContext } from './types';

// ============================================================================
// 1. GLOBAL KNOWLEDGE PACK (Universal Financial Market Terms)
// ============================================================================
export const GLOBAL_INSTRUMENTS = [
  'nq', 'es', 'ym', 'rty', 'dax', 'ftse', 'cac40', 'nikkei', 'nifty', 'sensex', 'spx', 'ndx', 'vix',
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
  'trader mindset', 'market analysis', 'daily bias', 'premarket analysis', 'trade setup', 'trading strategy',
  'crypto yield', 'yield farming', 'portefeuille', 'pea', 'dividendos', 'criptomonedas'
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
  pt: {
    languageCode: 'pt',
    languageName: 'Portuguese',
    positiveTerms: ['bolsa de valores', 'mini indice', 'mini dolar', 'b3', 'mesa proprietaria', 'analise tecnica', 'ações e dividendos', 'day trade ao vivo', 'operando mini indice'],
    negativeTerms: ['jogos', 'receitas', 'maquiagem', 'futebol', 'cozinha'],
    commonPhrases: ['operando mini indice', 'day trade ao vivo', 'analise b3', 'ações e dividendos b3']
  },
  ja: {
    languageCode: 'ja',
    languageName: 'Japanese',
    positiveTerms: ['FXトレード', '株式投資', '日経225', 'テクニカル分析', 'チャート分析', 'プロップファーム', 'ドル円', 'デイトレード', '暗号資産', 'スマートマネー', '株主優待', '高配当株'],
    negativeTerms: ['ゲーム実況', 'メイク', '料理', 'アニメ'],
    commonPhrases: ['日経225チャート分析', 'FX初心者講座', 'リアルタイムトレード', 'ドル円 デイトレード']
  },
  ko: {
    languageCode: 'ko',
    languageName: 'Korean',
    positiveTerms: ['주식매매', '해외선물', '코스피', '나스닥매매', '차트분석', '프랍트레이딩', '조건검색식', '단타', '선물 차트분석', '외환선물', '비트코인 선물'],
    negativeTerms: ['게임방송', '먹방', '뷰티', '일상브이로그'],
    commonPhrases: ['해외선물 나스닥 매매', '주식 차트 분석', '실전 트레이딩', '조건검색식 단타']
  },
  vi: {
    languageCode: 'vi',
    languageName: 'Vietnamese',
    positiveTerms: ['chúng khoán', 'chungkhoan', 'giao dịch forex', 'phân tích kỹ thuật', 'quản lý vốn', 'quy fonde', 'chứng khoán', 'bảng điện tử'],
    negativeTerms: ['ẩm thực', 'am thuc', 'du lịch', 'liên quân', 'gameplay'],
    commonPhrases: ['phân tích vn-index', 'chiến lược giao dịch vàng', 'học forex cơ bản']
  },
  pl: {
    languageCode: 'pl',
    languageName: 'Polish',
    positiveTerms: ['gpw warszawa', 'wig20', 'inwestowanie', 'analiza techniczna', 'polska prop firm', 'spółki z gpw'],
    negativeTerms: ['gry komputerowe', 'przepisy kulinarne', 'vlogi'],
    commonPhrases: ['analiza gpw wig20', 'handel na forexie', 'poradnik inwestowania']
  },
  hi: {
    languageCode: 'hi',
    languageName: 'Hindi',
    positiveTerms: ['share market hindi', 'nifty option trading', 'banknifty scalp', 'technical analysis hindi', 'candlestick hindi', 'trading strategy hindi'],
    negativeTerms: ['smartphone unboxing', 'gaming hindi', 'cricket highlights'],
    commonPhrases: ['nifty banknifty live', 'share market for beginners', 'option trading hindi']
  },
  ar: {
    languageCode: 'ar',
    languageName: 'Arabic',
    positiveTerms: ['تداول', 'فوركس', 'الأسهم', 'التحليل الفني', 'سوق المال', 'تداول العملات', 'شركة تمويل', 'بروب فيرم', 'تداول دبي'],
    negativeTerms: ['العاب', 'طبخ', 'عطور'],
    commonPhrases: ['تحليل سوق الأسهم', 'تداول الفوركس للمبتدئين']
  },
  nl: {
    languageCode: 'nl',
    languageName: 'Dutch',
    positiveTerms: ['beurs', 'beursanalyse', 'aex', 'aex-index', 'technische analyse', 'handelen in opties', 'beleggen', 'daghandel', 'marktanalyse', 'aandelen', 'beursvideos', 'optiestrategie', 'ochtendupdate', 'beursnieuws', 'beleggingsforum'],
    negativeTerms: ['voetbal', 'recepten', 'amsterdam vlog', 'gaming', 'make-up', 'vlog'],
    commonPhrases: ['opening amsterdamse beurs', 'weekoverzicht beurs', 'analyse van de dag', 'beurs update']
  }
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
  'Brazil': {
    countryName: 'Brazil',
    primaryLanguage: 'pt',
    regionalExchanges: ['B3', 'Bolsa do Brasil'],
    localBrokers: ['XP Investimentos', 'BTG Pactual', 'Clear Corretora', 'Rico'],
    popularInstruments: ['Mini Índice', 'Mini Dólar', 'B3', 'PETR4', 'VALE3'],
    localPropFirms: ['Mesa Proprietária', 'Atom Educacional', 'FlixTrading'],
    nativeTradingTerminology: ['Operando mini índice', 'Day trade ao vivo', 'Ações e dividendos B3', 'Análise B3'],
    regionalNegativeTerms: ['Futebol', 'Receitas rápidas', 'Cozinha', 'Carnaval']
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
  'South Korea': {
    countryName: 'South Korea',
    primaryLanguage: 'ko',
    regionalExchanges: ['KRX', 'Korea Exchange', 'KOSPI', 'KOSDAQ'],
    localBrokers: ['Kiwoom Securities', 'Samsung Securities', 'NH Investment'],
    popularInstruments: ['해외선물', '나스닥', 'KOSPI 200', 'USD/KRW'],
    localPropFirms: ['프랍트레이딩', 'FTMO Korea'],
    nativeTradingTerminology: ['해외선물 나스닥', '국내주식 단타', '조건검색식', '차트분석', '비트코인 선물'],
    regionalNegativeTerms: ['게임방송', '먹방', 'K-pop vlogs']
  },
  'Vietnam': {
    countryName: 'Vietnam',
    primaryLanguage: 'vi',
    regionalExchanges: ['HOSE', 'HNX', 'UPCoM'],
    localBrokers: ['VPS Securities', 'SSI Securities', 'VNDirect', 'TCBS'],
    popularInstruments: ['VN30', 'VN-Index', 'Gold XAUUSD', 'EURUSD'],
    localPropFirms: ['Quỹ FTMO', 'Quỹ Topstep Việt Nam'],
    nativeTradingTerminology: ['Bảng điện tử', 'Khớp lệnh', 'Thị trường chứng khoán', 'Kháng cự hỗ trợ'],
    regionalNegativeTerms: ['Ẩm thực đường phố', 'Game Liên Quân', 'ẩm thực']
  },
  'Poland': {
    countryName: 'Poland',
    primaryLanguage: 'pl',
    regionalExchanges: ['GPW', 'Giełda Papierów Wartościowych w Warszawie'],
    localBrokers: ['XTB Polska', 'DM BOŚ', 'mBank Brokerage'],
    popularInstruments: ['WIG20', 'MWIG40', 'EURUSD', 'USDPLN'],
    localPropFirms: ['Polska Prop Firm', 'FTMO Poland'],
    nativeTradingTerminology: ['Otwarcie GPW', 'Społki z GPW', 'Dźwignia finansowa', 'Analiza świecowa'],
    regionalNegativeTerms: ['Szlak w Tatrach', 'Gotowanie w domu']
  },
  'India': {
    countryName: 'India',
    primaryLanguage: 'hi',
    regionalExchanges: ['NSE', 'BSE'],
    localBrokers: ['Zerodha', 'Groww', 'Angel One', 'Upstox'],
    popularInstruments: ['Nifty', 'Bank Nifty', 'Finnifty', 'Sensex'],
    localPropFirms: ['FTMO India'],
    nativeTradingTerminology: ['Nifty option trading', 'Banknifty scalp', 'Share market hindi', 'Candlestick pattern'],
    regionalNegativeTerms: ['Cricket match highlights', 'Bollywood news', 'Smartphone unboxing']
  },
  'Mexico': {
    countryName: 'Mexico',
    primaryLanguage: 'es',
    regionalExchanges: ['BMV', 'Bolsa Mexicana de Valores'],
    localBrokers: ['GBM+', 'Interactive Brokers Mexico'],
    popularInstruments: ['IPC', 'USDMXN'],
    localPropFirms: ['PropFirm Mexico'],
    nativeTradingTerminology: ['Apertura BMV', 'Analisis de mercado MX'],
    regionalNegativeTerms: ['Lucha libre', 'Deportes MX', 'Comida mexicana']
  },
  'United Arab Emirates': {
    countryName: 'United Arab Emirates',
    primaryLanguage: 'ar',
    regionalExchanges: ['DFM', 'ADX', 'Nasdaq Dubai'],
    localBrokers: ['ADSS', 'Century Financial', 'CFI Dubai'],
    popularInstruments: ['Gold', 'Oil', 'EURUSD', 'US500'],
    localPropFirms: ['FTMO Dubai', 'Prop Firm Dubai'],
    nativeTradingTerminology: ['تداول العملات', 'التحليل الفني', 'سوق دبي المالي', 'Prop Firm Dubai'],
    regionalNegativeTerms: ['Desert safari', 'Arabic perfumes', 'Real estate off plan']
  },
  'Singapore': {
    countryName: 'Singapore',
    primaryLanguage: 'en',
    regionalExchanges: ['SGX', 'Singapore Exchange'],
    localBrokers: ['DBS Vickers', 'Tiger Brokers SG', 'Moomoo SG'],
    popularInstruments: ['STI', 'US Equities', 'FX'],
    localPropFirms: ['FTMO SG'],
    nativeTradingTerminology: ['SGX market update', 'US stock options SG'],
    regionalNegativeTerms: ['Hawker food guide', 'Singapore vlogs']
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
  'South Africa': {
    countryName: 'South Africa',
    primaryLanguage: 'en',
    regionalExchanges: ['JSE', 'Johannesburg Stock Exchange'],
    localBrokers: ['EasyEquities', 'IG South Africa', 'Standard Bank Webtrader'],
    popularInstruments: ['JSE', 'ALSI', 'USDZAR', 'Gold'],
    localPropFirms: ['FTMO ZA', 'Funding Pips ZA'],
    nativeTradingTerminology: ['JSE trading', 'rand trading', 'USDZAR analysis', 'South Africa trading'],
    regionalNegativeTerms: ['Safari vlog', 'Braai recipes', 'Springboks highlights']
  }
};

/**
 * Resolve Layered Knowledge Context: Global → Language → Country
 */
export function getLayeredKnowledgeContext(countryName?: string): LayeredKnowledgeContext {
  const cName = countryName && countryName !== 'UNKNOWN' ? countryName : 'UNKNOWN';
  const countryPack = COUNTRY_KNOWLEDGE_PACKS[cName] || (cName === 'UNKNOWN' ? undefined : COUNTRY_KNOWLEDGE_PACKS['United States']);
  const langCode = countryPack?.primaryLanguage || 'en';
  const languagePack = LANGUAGE_KNOWLEDGE_PACKS[langCode] || LANGUAGE_KNOWLEDGE_PACKS['en'];

  return {
    globalInstruments: GLOBAL_INSTRUMENTS,
    globalPlatformsPropFirms: GLOBAL_PLATFORMS_BROKERS_PROPFIRMS,
    globalAdvancedConcepts: GLOBAL_ADVANCED_CONCEPTS,
    globalNegativeTerms: GLOBAL_NEGATIVE_TERMS,
    languageKnowledge: languagePack,
    countryKnowledge: countryPack
  };
}
