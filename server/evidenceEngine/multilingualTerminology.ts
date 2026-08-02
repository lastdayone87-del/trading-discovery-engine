import type { LayeredKnowledgeContext, RawChannelInput } from './types';
import { textMatchesTerm } from './utils/textMatching';
import { SUPPORTED_PRODUCTION_COUNTRIES } from '../../src/data/initial_countries';

/** Backward-compatible export backed by the single production-country registry. */
export const SUPPORTED_CLASSIFICATION_COUNTRIES = SUPPORTED_PRODUCTION_COUNTRIES;

export interface MultilingualClassificationPack {
  languageCode: 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'ja' | 'da' | 'sv' | 'ar' | 'zh' | 'ms';
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
  zh: {
    languageCode: 'zh', executionTerms: ['交易计划', '风险管理', '入场点', '止损', '股票交易', '策略回测'], educationalTerms: ['交易教学', '技术分析', '交易策略'], businessNewsTerms: ['财经新闻', '市场新闻'], genericFinanceTerms: ['个人理财', '被动收入', '长期投资'], hypeTerms: ['保证盈利', '快速致富'], motivationTerms: ['百万富翁思维']
  },
  ms: {
    languageCode: 'ms', executionTerms: ['pelan dagangan', 'pengurusan risiko', 'titik masuk', 'henti rugi', 'dagangan saham'], educationalTerms: ['belajar berdagang', 'analisis teknikal', 'strategi dagangan'], businessNewsTerms: ['berita ekonomi', 'berita pasaran'], genericFinanceTerms: ['kewangan peribadi', 'pendapatan pasif', 'pelaburan jangka panjang'], hypeTerms: ['untung dijamin', 'cepat kaya'], motivationTerms: ['minda jutawan']
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
  return (input.evidence_corpus?.map(document=>document.text) || [input.channel_name, input.description, ...(input.video_titles || []), ...(input.video_descriptions || []), input.location_tag, ...(input.external_links || [])]).filter(Boolean).join(' ');
}

/** Select languages from actual field content and declared field hints, not country alone. */
export function contentLanguagePacks(input:RawChannelInput,context:LayeredKnowledgeContext):MultilingualClassificationPack[]{
  const text=completeChannelText(input),hinted=new Set([...(input.detected_languages||[]).filter(item=>(item.confidence??100)>=50).map(item=>item.language.toLocaleLowerCase('und').split('-')[0]),...(input.evidence_corpus||[]).map(item=>item.language?.toLocaleLowerCase('und').split('-')[0]).filter((x):x is string=>Boolean(x))]);
  const configured=(context.languageKnowledgePacks||[context.languageKnowledge]).map(item=>item?.languageCode).filter((x):x is string=>Boolean(x));
  const contentMatched=Object.values(MULTILINGUAL_CLASSIFICATION_PACKS).filter(pack=>[...pack.executionTerms,...pack.educationalTerms,...pack.businessNewsTerms,...pack.genericFinanceTerms,...pack.hypeTerms,...pack.motivationTerms].some(term=>textMatchesTerm(text,term))).map(pack=>pack.languageCode);
  const codes=[...new Set([...configured,...hinted,...contentMatched])];
  return codes.map(code=>MULTILINGUAL_CLASSIFICATION_PACKS[code as keyof typeof MULTILINGUAL_CLASSIFICATION_PACKS]).filter((pack):pack is MultilingualClassificationPack=>Boolean(pack));
}

export function matchedTerms(text: string, terms: string[]): string[] {
  return terms.filter(term => textMatchesTerm(text, term));
}

export function isTradingFocusedText(text: string, context: LayeredKnowledgeContext): boolean {
  const languagePacks = contentLanguagePacks({channel_name:'',description:text},context);
  const hasExecution = languagePacks.some(pack => matchedTerms(text, pack.executionTerms).length > 0);
  const hasEducation = languagePacks.some(pack => matchedTerms(text, pack.educationalTerms).length > 0);
  const hasMethodology = context.globalAdvancedConcepts.some(term => textMatchesTerm(text, term));
  const hasPlatform = context.globalPlatformsPropFirms.some(term => textMatchesTerm(text, term));
  const instruments = [...context.globalInstruments, ...(context.countryKnowledge?.popularInstruments || [])];
  const hasInstrument = instruments.some(term => textMatchesTerm(text, term));
  return hasExecution || hasEducation || hasMethodology || hasPlatform || (hasInstrument && (hasExecution || hasEducation));
}
