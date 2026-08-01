import type { LayeredKnowledgeContext, RawChannelInput } from './types';
import { textMatchesTerm } from './utils/textMatching';

export const SUPPORTED_CLASSIFICATION_COUNTRIES = [
  'United States', 'United Kingdom', 'Germany', 'France', 'Spain',
  'Netherlands', 'Italy', 'Australia', 'Canada', 'Japan', 'Switzerland',
  'Denmark', 'Sweden', 'United Arab Emirates', 'Singapore', 'New Zealand',
  'Belgium', 'Luxembourg', 'Ireland'
] as const;

export interface MultilingualClassificationPack {
  languageCode: 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'ja' | 'da' | 'sv' | 'ar';
  executionTerms: string[];
  educationalTerms: string[];
  businessNewsTerms: string[];
  genericFinanceTerms: string[];
  hypeTerms: string[];
  motivationTerms: string[];
}

export const MULTILINGUAL_CLASSIFICATION_PACKS: Record<MultilingualClassificationPack['languageCode'], MultilingualClassificationPack> = {
  en: {
    languageCode: 'en',
    executionTerms: ['trade setup', 'entry and stop loss', 'position sizing', 'risk per trade', 'order flow', 'market structure', 'backtesting', 'trade review', 'trading journal'],
    educationalTerms: ['step by step trading', 'trading lesson', 'strategy breakdown', 'how i manage risk', 'chart analysis', 'live execution'],
    businessNewsTerms: ['business news', 'company earnings news', 'economic headlines', 'market news bulletin'],
    genericFinanceTerms: ['personal finance', 'saving money', 'passive income', 'dividend portfolio', 'long term investing', 'retirement planning'],
    hypeTerms: ['100x crypto', 'next bitcoin', 'guaranteed profit', 'crypto gem', 'moonshot', 'get rich quick'],
    motivationTerms: ['millionaire mindset', 'success motivation', 'financial freedom motivation', 'hustle motivation']
  },
  de: {
    languageCode: 'de',
    executionTerms: ['trade einstieg', 'stop loss', 'positionsgröße', 'risiko pro trade', 'markttechnik', 'orderflow', 'trading journal', 'strategie backtest'],
    educationalTerms: ['trading lernen', 'strategie erklärt', 'chartanalyse', 'trade analyse', 'fehleranalyse', 'trading ausbildung'],
    businessNewsTerms: ['wirtschaftsnachrichten', 'unternehmensnachrichten', 'börse aktuell nachrichten'],
    genericFinanceTerms: ['finanzielle freiheit', 'passives einkommen', 'dividenden depot', 'etf sparplan', 'altersvorsorge'],
    hypeTerms: ['krypto 100x', 'garantierter gewinn', 'nächster bitcoin', 'schnell reich'],
    motivationTerms: ['erfolgs mindset', 'millionär mindset', 'motivation zum erfolg']
  },
  fr: {
    languageCode: 'fr',
    executionTerms: ['plan de trading', 'gestion du risque', 'journal de trading', 'carnet d’ordres', "carnet d'ordres", 'point d’entrée', 'stop loss', 'backtest stratégie'],
    educationalTerms: ['formation trading', 'stratégie expliquée', 'analyse de trade', 'analyse technique', 'cours de trading'],
    businessNewsTerms: ['actualité économique', 'actualités des entreprises', 'journal économique'],
    genericFinanceTerms: ['finances personnelles', 'revenus passifs', 'portefeuille dividendes', 'investissement long terme', 'gestion de patrimoine'],
    hypeTerms: ['crypto x100', 'gain garanti', 'prochaine pépite crypto', 'devenir riche vite'],
    motivationTerms: ['mentalité de millionnaire', 'motivation réussite', 'liberté financière motivation']
  },
  es: {
    languageCode: 'es',
    executionTerms: ['plan de trading', 'gestión de riesgo', 'diario de trading', 'punto de entrada', 'stop loss', 'flujo de órdenes', 'backtest de estrategia'],
    educationalTerms: ['curso de trading', 'estrategia explicada', 'análisis de operaciones', 'análisis técnico', 'clase de trading'],
    businessNewsTerms: ['noticias económicas', 'noticias empresariales', 'informativo bursátil'],
    genericFinanceTerms: ['finanzas personales', 'ingresos pasivos', 'cartera de dividendos', 'inversión a largo plazo', 'ahorro e inversión'],
    hypeTerms: ['cripto x100', 'ganancia garantizada', 'próxima gema cripto', 'hazte rico rápido'],
    motivationTerms: ['mentalidad millonaria', 'motivación para el éxito', 'libertad financiera motivación']
  },
  it: {
    languageCode: 'it',
    executionTerms: ['piano di trading', 'gestione del rischio', 'diario di trading', 'punto di ingresso', 'stop loss', 'book ordini', 'backtest strategia'],
    educationalTerms: ['corso di trading', 'strategia spiegata', 'analisi delle operazioni', 'analisi tecnica', 'lezione di trading'],
    businessNewsTerms: ['notizie economiche', 'notizie aziendali', 'telegiornale economico'],
    genericFinanceTerms: ['finanza personale', 'rendita passiva', 'portafoglio dividendi', 'investimento a lungo termine', 'piano pensione'],
    hypeTerms: ['crypto x100', 'profitto garantito', 'prossima gemma crypto', 'diventa ricco subito'],
    motivationTerms: ['mentalità da milionario', 'motivazione al successo', 'libertà finanziaria motivazione']
  },
  nl: {
    languageCode: 'nl',
    executionTerms: ['handelsplan', 'risicomanagement', 'tradingdagboek', 'instappunt', 'stop loss', 'orderboek', 'strategie backtest'],
    educationalTerms: ['leren traden', 'strategie uitgelegd', 'trade analyse', 'technische analyse', 'trading cursus'],
    businessNewsTerms: ['economisch nieuws', 'bedrijfsnieuws', 'financieel journaal'],
    genericFinanceTerms: ['persoonlijke financiën', 'passief inkomen', 'dividendportefeuille', 'lange termijn beleggen', 'pensioenbeleggen'],
    hypeTerms: ['crypto 100x', 'gegarandeerde winst', 'volgende crypto parel', 'snel rijk'],
    motivationTerms: ['miljonairsmentaliteit', 'succesmotivatie', 'financiële vrijheid motivatie']
  },
  da: {
    languageCode: 'da', executionTerms: ['handelsplan', 'risikostyring', 'indgangspunkt', 'stop loss', 'aktiehandel', 'strategi backtest'], educationalTerms: ['lær trading', 'teknisk analyse', 'handelsstrategi'], businessNewsTerms: ['erhvervsnyheder', 'markedsnyheder'], genericFinanceTerms: ['privatøkonomi', 'passiv indkomst', 'langsigtet investering'], hypeTerms: ['garanteret gevinst', 'bliv rig hurtigt'], motivationTerms: ['millionær tankegang']
  },
  sv: {
    languageCode: 'sv', executionTerms: ['handelsplan', 'riskhantering', 'ingångspunkt', 'stop loss', 'aktiehandel', 'strategi backtest'], educationalTerms: ['lär dig trading', 'teknisk analys', 'handelsstrategi'], businessNewsTerms: ['ekonominyheter', 'marknadsnyheter'], genericFinanceTerms: ['privatekonomi', 'passiv inkomst', 'långsiktigt sparande'], hypeTerms: ['garanterad vinst', 'bli rik snabbt'], motivationTerms: ['miljonärstänkande']
  },
  ar: {
    languageCode: 'ar', executionTerms: ['خطة التداول', 'إدارة المخاطر', 'نقطة الدخول', 'وقف الخسارة', 'تداول الأسهم'], educationalTerms: ['تعليم التداول', 'تحليل فني', 'استراتيجية التداول'], businessNewsTerms: ['أخبار اقتصادية', 'أخبار السوق'], genericFinanceTerms: ['التمويل الشخصي', 'دخل سلبي', 'استثمار طويل الأجل'], hypeTerms: ['ربح مضمون', 'ثراء سريع'], motivationTerms: ['عقلية المليونير']
  },
  ja: {
    languageCode: 'ja',
    executionTerms: ['エントリーポイント', '損切り', '資金管理', 'トレード日誌', '板読み', '注文フロー', 'ストラテジー検証'],
    educationalTerms: ['トレード講座', '手法解説', 'トレード振り返り', 'テクニカル分析', '初心者向けfx'],
    businessNewsTerms: ['経済ニュース', '企業ニュース', 'マーケットニュース速報'],
    genericFinanceTerms: ['家計管理', '資産形成', '配当金生活', '長期投資', '投資信託'],
    hypeTerms: ['仮想通貨100倍', '必ず儲かる', '次のビットコイン', '億り人確実'],
    motivationTerms: ['億万長者マインド', '成功者マインド', 'モチベーション動画']
  }
};

export function completeChannelText(input: RawChannelInput): string {
  return [input.channel_name, input.description, ...(input.video_titles || []), ...(input.video_descriptions || []), input.location_tag, ...(input.external_links || [])].filter(Boolean).join(' ');
}

export function matchedTerms(text: string, terms: string[]): string[] {
  return terms.filter(term => textMatchesTerm(text, term));
}

export function isTradingFocusedText(text: string, context: LayeredKnowledgeContext): boolean {
  const languageCode = (context.languageKnowledge?.languageCode || 'en') as keyof typeof MULTILINGUAL_CLASSIFICATION_PACKS;
  const pack = MULTILINGUAL_CLASSIFICATION_PACKS[languageCode] || MULTILINGUAL_CLASSIFICATION_PACKS.en;
  const hasExecution = matchedTerms(text, pack.executionTerms).length > 0;
  const hasEducation = matchedTerms(text, pack.educationalTerms).length > 0;
  const hasMethodology = context.globalAdvancedConcepts.some(term => textMatchesTerm(text, term));
  const hasPlatform = context.globalPlatformsPropFirms.some(term => textMatchesTerm(text, term));
  const instruments = [...context.globalInstruments, ...(context.countryKnowledge?.popularInstruments || [])];
  const hasInstrument = instruments.some(term => textMatchesTerm(text, term));
  return hasExecution || hasEducation || hasMethodology || hasPlatform || (hasInstrument && (hasExecution || hasEducation));
}
