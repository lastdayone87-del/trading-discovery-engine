import { CountryVocabulary, ExcludedCountry } from '../types';

export const INITIAL_COUNTRY_VOCABULARIES: CountryVocabulary[] = [
  {
    country: 'United States',
    languages: ['English'],
    native_trading_terminology: [
      'NQ futures',
      'ES futures',
      'premarket analysis',
      'order flow',
      'market structure',
      'prop firm trading',
      'ICT concepts',
      'SMC',
      'smart money',
      'volume profile',
      'delta divergence',
      'fair value gap',
      'liquidity sweep'
    ],
    popular_instruments: ['NQ', 'ES', 'S&P 500', 'Nasdaq', 'EURUSD', 'BTC', 'ETH', 'Gold'],
    local_market_phrases: ['New York open', 'payout proof', 'topstep evaluation', 'apex trader funding'],
    common_content_format_names: ['Morning prep', 'Pre market breakdown', 'Live trading journal', 'Weekly outlook']
  },
  {
    country: 'Germany',
    languages: ['German'],
    native_trading_terminology: [
      'DAX Analyse',
      'DAX Trading',
      'Börsenanalyse',
      'Trading Journal',
      'Technische Analyse',
      'Futures Handel',
      'Orderflow Trading',
      'Marktstruktur',
      'Xetra DAX',
      'Handelsstrategie'
    ],
    popular_instruments: ['DAX 40', 'FDAX', 'EURUSD', 'Bund Futures'],
    local_market_phrases: ['Börse Frankfurt', 'Eröffnung Live', 'Marktrückblick'],
    common_content_format_names: ['Morgenbriefing', 'Tagesanalyse', 'Marktausblick']
  },
  {
    country: 'France',
    languages: ['French'],
    native_trading_terminology: [
      'analyse marché',
      'CAC 40 trading',
      'journal trading',
      'price action trading',
      'analyse technique',
      'structure du marché',
      'carnet d ordre',
      'flux d ordres',
      'prop firm france'
    ],
    popular_instruments: ['CAC 40', 'EURUSD', 'Gold', 'Nasdaq'],
    local_market_phrases: ['Ouverture Bourse de Paris', 'Briefing du matin'],
    common_content_format_names: ['Analyse hebdomadaire', 'Debriefing marché', 'Revue de presse boursière']
  },
  {
    country: 'Spain',
    languages: ['Spanish'],
    native_trading_terminology: [
      'análisis bursátil',
      'trading intradía',
      'mercados financieros',
      'análisis técnico',
      'futuros trading',
      'estructura de mercado',
      'flujo de ordenes',
      'oferta y demanda',
      'conceptos SMC'
    ],
    popular_instruments: ['IBEX 35', 'EURUSD', 'Nasdaq', 'Bitcoin'],
    local_market_phrases: ['Apertura de mercado', 'Sesión de Nueva York', 'Prueba de fondeo'],
    common_content_format_names: ['Resumen semanal', 'Bitácora de trading', 'Análisis en directo']
  },
  {
    country: 'United Kingdom',
    languages: ['English'],
    native_trading_terminology: [
      'FTSE trading',
      'spread betting',
      'London session',
      'price action',
      'indices trading',
      'order flow UK',
      'prop trading London',
      'ICT killzones'
    ],
    popular_instruments: ['FTSE 100', 'GBPUSD', 'Brent Crude', 'Gold'],
    local_market_phrases: ['London open', 'FTSE analysis', 'LSE market update'],
    common_content_format_names: ['Morning briefing', 'Weekly trade breakdown', 'London session recap']
  },
  {
    country: 'Netherlands',
    languages: ['Dutch'],
    native_trading_terminology: [
      'beurs analyse',
      'AEX trading',
      'technische analyse',
      'handelen in opties',
      'marktanalyse',
      'beleggen en trading',
      'daghandel strategie'
    ],
    popular_instruments: ['AEX', 'EURUSD', 'ASML', 'Shell'],
    local_market_phrases: ['Opening Amsterdamse beurs', 'Ochtendupdate'],
    common_content_format_names: ['Weekoverzicht beurs', 'Analyse van de dag']
  },
  {
    country: 'Italy',
    languages: ['Italian'],
    native_trading_terminology: [
      'analisi tecnica',
      'trading sul FTSE MIB',
      'mercati finanziari',
      'strategie di trading',
      'volumi e order flow',
      'analisi ciclica'
    ],
    popular_instruments: ['FTSE MIB', 'BTP Futures', 'EURUSD', 'Gold'],
    local_market_phrases: ['Apertura Piazza Affari', 'Report di borsa'],
    common_content_format_names: ['Previsioni di mercato', 'Diario di trading']
  },
  {
    country: 'Australia',
    languages: ['English'],
    native_trading_terminology: [
      'ASX trading',
      'ASX analysis',
      'commodities trading',
      'AUD pairs',
      'Sydney session',
      'Asian killzone',
      'mining stocks trading'
    ],
    popular_instruments: ['ASX 200', 'AUDUSD', 'Gold', 'Iron Ore'],
    local_market_phrases: ['Sydney open', 'ASX market wrap', 'RBA rate decision trading'],
    common_content_format_names: ['Daily ASX review', 'Weekly forex breakdown']
  },
  {
    country: 'Canada',
    languages: ['English', 'French'],
    native_trading_terminology: [
      'TSX trading',
      'Canadian markets',
      'oil trading Canada',
      'premarket TSX',
      'cad forex trading',
      'resource stocks trading'
    ],
    popular_instruments: ['TSX 60', 'WTI Crude', 'USDCAD', 'Gold'],
    local_market_phrases: ['Toronto open', 'Bank of Canada rate decision'],
    common_content_format_names: ['Morning TSX prep', 'Energy sector update']
  },
  {
    country: 'Japan',
    languages: ['Japanese'],
    native_trading_terminology: [
      '日経225先物',
      'ドル円トレード',
      'テクニカル分析',
      'ローソク足チャート',
      '板読みトレード',
      'デイトレード手法',
      '東京セッション',
      '注文住宅FX'
    ],
    popular_instruments: ['Nikkei 225', 'USDJPY', 'JGB Futures', 'Gold'],
    local_market_phrases: ['東京市場オープン', '前場振り返り', '日経平均株価解説'],
    common_content_format_names: ['毎朝の相場分析', 'トレード日記', '週刊相場展望']
  },
  { country: 'Switzerland', languages: ['German', 'French', 'Italian'], native_trading_terminology: ['SMI Analyse', 'Börsenanalyse Schweiz', 'analyse technique suisse', 'analisi tecnica svizzera', 'Devisenhandel'], popular_instruments: ['SMI', 'Swiss Market Index', 'USDCHF', 'CHF'], local_market_phrases: ['SIX Swiss Exchange', 'SNB Zinsentscheid', 'Börsenöffnung Zürich'], common_content_format_names: ['Schweizer Marktupdate', 'Analyse hebdomadaire'] },
  { country: 'Denmark', languages: ['Danish'], native_trading_terminology: ['aktiehandel', 'teknisk analyse', 'børsanalyse', 'daytrading', 'handelsstrategi'], popular_instruments: ['OMXC25', 'Novo Nordisk', 'EURDKK'], local_market_phrases: ['Nasdaq Copenhagen', 'Københavns Fondsbørs'], common_content_format_names: ['markedsanalyse', 'ugens aktier'] },
  { country: 'Sweden', languages: ['Swedish'], native_trading_terminology: ['aktiehandel', 'teknisk analys', 'börsanalys', 'daytrading', 'handelsstrategi'], popular_instruments: ['OMXS30', 'SEK', 'Investor AB'], local_market_phrases: ['Nasdaq Stockholm', 'Stockholmsbörsen'], common_content_format_names: ['morgonanalys', 'veckans aktier'] },
  { country: 'United Arab Emirates', languages: ['Arabic', 'English'], native_trading_terminology: ['تداول الأسهم', 'تحليل فني', 'إدارة المخاطر', 'سوق دبي المالي', 'Abu Dhabi trading'], popular_instruments: ['DFM General Index', 'FTSE ADX', 'Gold', 'AED'], local_market_phrases: ['سوق دبي المالي', 'سوق أبوظبي للأوراق المالية', 'Dubai market open'], common_content_format_names: ['تحليل السوق اليومي', 'UAE market outlook'] },
  { country: 'Singapore', languages: ['English', 'Mandarin Chinese', 'Malay', 'Tamil'], native_trading_terminology: ['SGX trading', 'technical analysis Singapore', '股票交易', '技术分析', 'pasaran saham'], popular_instruments: ['Straits Times Index', 'SGX FTSE China A50', 'USDSGD'], local_market_phrases: ['Singapore Exchange open', 'MAS policy decision'], common_content_format_names: ['Singapore market outlook', '盘前分析'] },
  { country: 'New Zealand', languages: ['English', 'Māori'], native_trading_terminology: ['NZX trading', 'technical analysis NZ', 'share trading New Zealand', 'forex trading NZ'], popular_instruments: ['NZX 50', 'NZDUSD', 'Dairy Futures'], local_market_phrases: ['NZX market open', 'RBNZ rate decision'], common_content_format_names: ['NZX market wrap', 'weekly forex outlook'] },
  { country: 'Belgium', languages: ['Dutch', 'French', 'German'], native_trading_terminology: ['beursanalyse België', 'technische analyse', 'analyse boursière belge', 'handel in aandelen'], popular_instruments: ['BEL 20', 'EURUSD', 'Euronext Brussels'], local_market_phrases: ['Brusselse beurs', 'Bourse de Bruxelles'], common_content_format_names: ['marktupdate', 'analyse hebdomadaire'] },
  { country: 'Luxembourg', languages: ['Luxembourgish', 'French', 'German'], native_trading_terminology: ['Bourse Luxembourg', 'analyse technique', 'Börsenanalyse', 'Aktienhandel'], popular_instruments: ['LuxX Index', 'EURUSD', 'Eurobonds'], local_market_phrases: ['Bourse de Luxembourg', 'Luxemburger Börse'], common_content_format_names: ['marché hebdomadaire', 'Maartupdate'] },
  { country: 'Ireland', languages: ['English', 'Irish'], native_trading_terminology: ['Irish stock trading', 'technical analysis Ireland', 'forex trading Ireland', 'trádáil scaireanna'], popular_instruments: ['ISEQ 20', 'EURUSD', 'Irish equities'], local_market_phrases: ['Euronext Dublin', 'Dublin market open'], common_content_format_names: ['Irish market wrap', 'weekly trading outlook'] },
];

export const INITIAL_EXCLUDED_COUNTRIES: ExcludedCountry[] = [
  { country_name: 'South Africa', reason: 'African Region Exclusion' },
  { country_name: 'Nigeria', reason: 'African Region Exclusion' },
  { country_name: 'Kenya', reason: 'African Region Exclusion' },
  { country_name: 'Ghana', reason: 'African Region Exclusion' },
  { country_name: 'Egypt', reason: 'African Region Exclusion' },
  { country_name: 'Morocco', reason: 'African Region Exclusion' },
  { country_name: 'Algeria', reason: 'African Region Exclusion' },
  { country_name: 'Tunisia', reason: 'African Region Exclusion' },
  { country_name: 'Ethiopia', reason: 'African Region Exclusion' },
  { country_name: 'Tanzania', reason: 'African Region Exclusion' },
  { country_name: 'Uganda', reason: 'African Region Exclusion' },
  { country_name: 'Senegal', reason: 'African Region Exclusion' },
  { country_name: 'Cameroon', reason: 'African Region Exclusion' },
  { country_name: 'Zimbabwe', reason: 'African Region Exclusion' },
  { country_name: 'Zambia', reason: 'African Region Exclusion' },
  { country_name: 'Rwanda', reason: 'African Region Exclusion' },
  { country_name: 'Ivory Coast', reason: 'African Region Exclusion' },
  { country_name: 'Mozambique', reason: 'African Region Exclusion' },
  { country_name: 'Madagascar', reason: 'African Region Exclusion' },
  { country_name: 'Sudan', reason: 'African Region Exclusion' },
  { country_name: 'Angola', reason: 'African Region Exclusion' },
  { country_name: 'India', reason: 'South Asian High-Spam Exclusion' },
  { country_name: 'Bangladesh', reason: 'South Asian Exclusion' },
  { country_name: 'Pakistan', reason: 'South Asian Exclusion' },
  { country_name: 'Nepal', reason: 'South Asian Exclusion' },
  { country_name: 'Sri Lanka', reason: 'South Asian Exclusion' },
  { country_name: 'Philippines', reason: 'Southeast Asian Non-Target Exclusion' },
  { country_name: 'Vietnam', reason: 'Southeast Asian Non-Target Exclusion' },
  { country_name: 'Indonesia', reason: 'Southeast Asian Non-Target Exclusion' }
];
