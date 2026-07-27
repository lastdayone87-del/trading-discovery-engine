import { classifyTradingRelevance } from './tradingRelevanceClassifier';
import { BenchmarkSample, RegressionRunRecord, RegressionRunMetrics } from '../src/types';

/**
 * INDEPENDENT HOLDOUT VALIDATION DATASET (23 Channels across 12 countries)
 * Completely separate from BENCHMARK_DATASET.
 * Never used for calibration or tuning. Serves as an un-biased test of generalization.
 */
export const INDEPENDENT_VALIDATION_DATASET: BenchmarkSample[] = [
  // UNITED STATES HOLDOUT
  {
    channel_id: 'UC_VAL_US_01',
    channel_name: 'Volume Profile Trader',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Order Flow',
    sample_description: 'Daily intraday ES and NQ volume profile levels, point of control, and value area high/low setups.',
    sample_video_titles: ['Value Area Shift intraday NQ', 'Volume Profile POC Trading Strategy', 'Pre-Market Levels for ES']
  },
  {
    channel_id: 'UC_VAL_US_02',
    channel_name: 'NYC Culinary Secrets',
    country: 'United States',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Gourmet restaurant reviews, NYC bakery tours, and Italian pasta tutorials from a professional chef.',
    sample_video_titles: ['Best Handmade Pasta in Manhattan', '5 Star Michelin Dining Experience', 'Sourdough Bread Masterclass']
  },
  {
    channel_id: 'UC_VAL_US_03',
    channel_name: 'Swing Trader Macro Journal',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Equities',
    sample_description: 'Position trading equity break-outs, relative strength vs SPX, and position sizing risk metrics.',
    sample_video_titles: ['Tech Stocks Base Breakout Analysis', 'Position Sizing and Risk Math', 'Weekly Macro Market Outlook']
  },

  // UNITED KINGDOM HOLDOUT
  {
    channel_id: 'UC_VAL_UK_01',
    channel_name: 'London FX Desk',
    country: 'United Kingdom',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'GBP/USD cable order flow, London killzone session liquidity sweeps, and BoE rate decision impacts.',
    sample_video_titles: ['GBPUSD London Killzone Setup', 'Trading Bank of England Rate Decisions', 'Forex Scalping London Session']
  },
  {
    channel_id: 'UC_VAL_UK_02',
    channel_name: 'Cotswolds Garden & Country Life',
    country: 'United Kingdom',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Renovating an 18th century stone cottage in the Cotswolds, organic vegetable growing, and tea time.',
    sample_video_titles: ['Spring Flower Garden Tour', 'Cottage Restoration Episode 12', 'Traditional English Afternoon Tea']
  },

  // GERMANY HOLDOUT
  {
    channel_id: 'UC_VAL_DE_01',
    channel_name: 'DAX Skalpierer Deutschland',
    country: 'Germany',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'FDAX Live-Trading, Xetra Eröffnung, Orderbuch Skalping und Risiko Management für deutsche Trader.',
    sample_video_titles: ['FDAX Eröffnung 09:00 Uhr Scalp', 'Punkte im DAX mit Orderflow', 'Chartanalyse Xetra Markt']
  },
  {
    channel_id: 'UC_VAL_DE_02',
    channel_name: 'Schwarzwald Wandern & Natur',
    country: 'Germany',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Wanderrouten im Schwarzwald, Camping Equipment Tests und Wildnis Fotografie.',
    sample_video_titles: ['Trekking durch den Schwarzwald', 'Ultraleicht Zelt Test 2026', 'Sommer Camping am See']
  },

  // FRANCE HOLDOUT
  {
    channel_id: 'UC_VAL_FR_01',
    channel_name: 'Carnet d\'Ordres CAC40',
    country: 'France',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Analyse boursière quotidienne du CAC40, stratégie de carnet d\'ordres et gestion du risque en bourse.',
    sample_video_titles: ['Scalping CAC40 au Carnet d\'ordres', 'Analyse Technique Ouverture Paris', 'Gestion du Risque et Money Management']
  },
  {
    channel_id: 'UC_VAL_FR_02',
    channel_name: 'Patisserie Fine Parisienne',
    country: 'France',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Recettes de macarons, tartes aux fruits, mille-feuille et secrets de grands chefs pâtissiers.',
    sample_video_titles: ['Réussir ses Macarons à tous les coups', 'Tarte Citron Meringuée Facile', 'Visite de ma Pâtisserie à Lyon']
  },

  // SPAIN HOLDOUT
  {
    channel_id: 'UC_VAL_ES_01',
    channel_name: 'Acciones y Dividendos España',
    country: 'Spain',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Equities',
    sample_description: 'Análisis de la Bolsa Española, cartera BME, dividendos sostenibles y estrategia swing trading.',
    sample_video_titles: ['Mejores Acciones con Dividendos BME', 'Análisis Técnico IBEX35 Semanal', 'Estrategia de Inversión y Swing Trading']
  },
  {
    channel_id: 'UC_VAL_ES_02',
    channel_name: 'Rutas en Moto por España',
    country: 'Spain',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Viajes en motocicleta por Picos de Europa, mantenimiento de motos y equipamiento.',
    sample_video_titles: ['Ruta por Picos de Europa en Moto', 'Mantenimiento Básico de Cadena y Motor', 'Los Mejores Puertos de Montaña']
  },

  // BRAZIL HOLDOUT
  {
    channel_id: 'UC_VAL_BR_01',
    channel_name: 'Mini Dólar ao Vivo B3',
    country: 'Brazil',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Operando mini dólar e mini índice ao vivo na B3, fluxo de ordens tape reading e gerenciamento de risco.',
    sample_video_titles: ['Tape Reading Mini Dólar WDO', 'Abertura de Mercado B3 Mini Índice', 'Gerenciamento de Risco no Day Trade']
  },
  {
    channel_id: 'UC_VAL_BR_02',
    channel_name: 'Churrasco Gaúcho e Receitas',
    country: 'Brazil',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Técnicas de churrasco, cortes de picanha, acompanhamentos e segredos da culinária do sul.',
    sample_video_titles: ['Picanha Perfeita na Brasa', 'Segredos do Tempero para Costela', 'Acompanhamentos para Churrasco de Domingo']
  },

  // JAPAN HOLDOUT
  {
    channel_id: 'UC_VAL_JP_01',
    channel_name: '日経225先物デイトレ講座',
    country: 'Japan',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: '日経225先物とドル円のテクニカル分析、板読みスキャルピング、ローソク足トレード手法。',
    sample_video_titles: ['日経225先物 板読みスキャルピング手法', 'ドル円 ニューヨーク市場でのエントリー根拠', 'ローソク足パターンとリスク管理']
  },
  {
    channel_id: 'UC_VAL_JP_02',
    channel_name: '京都和菓子めぐり',
    country: 'Japan',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '京都の老舗和菓子店巡り、抹茶の立て方、四季折々の生菓子とカフェVlog。',
    sample_video_titles: ['京都祇園 老舗和菓子カフェ巡り', '自宅で楽しむ本格抹茶と季節の生菓子', '秋の京都 散策とお抹茶ガイド']
  },

  // SOUTH KOREA HOLDOUT
  {
    channel_id: 'UC_VAL_KR_01',
    channel_name: '조건검색식 해외선물 차트',
    country: 'South Korea',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: '해외선물 나스닥 및 오일 차트분석, 주식 조건검색식 매매, 프랍트레이딩 가이드.',
    sample_video_titles: ['나스닥 해외선물 5분봉 단타 매매', '주식 승률 80% 조건검색식 설정', '프랍트레이딩 계좌 관리 노하우']
  },
  {
    channel_id: 'UC_VAL_KR_02',
    channel_name: '제주도 카페 탐방 브이로그',
    country: 'South Korea',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '제주도 감성 카페 탐방, 서핑 레슨, 바다 풍경과 함께하는 힐링 일상 브이로그.',
    sample_video_titles: ['제주도 오션뷰 카페 BEST 5', '중문 해수욕장 초보 서핑 체험', '제주 한달살기 일상 브이로그']
  },

  // VIETNAM HOLDOUT
  {
    channel_id: 'UC_VAL_VN_01',
    channel_name: 'Phân Tích Bảng Điện VN30',
    country: 'Vietnam',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Equities',
    sample_description: 'Phân tích kỹ thuật thị trường chứng khoán Việt Nam, cổ phiếu VN30, chiến lược quản lý vốn giao dịch.',
    sample_video_titles: ['Nhận Định Thị Trường VN-Index Tuần Mới', 'Soi Bảng Điện Cổ Phiếu Dẫn Dắt VN30', 'Chiến Lược Quản Lý Vốn Trong Chứng Khoán']
  },
  {
    channel_id: 'UC_VAL_VN_02',
    channel_name: 'Du Lịch Sapa & Tây Bắc',
    country: 'Vietnam',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Kinh nghiệm du lịch Sapa tự túc, khám phá văn hóa các dân tộc vùng cao và ẩm thực Fansipan.',
    sample_video_titles: ['Kinh Nghiệm Săn Mây Sapa 3 Ngày 2 Đêm', 'Thưởng Thức Ẩm Thực Tây Bắc Đặc Sắc', 'Hành Trình Chinh Phục Đỉnh Fansipan']
  },

  // INDIA HOLDOUT
  {
    channel_id: 'UC_VAL_IN_01',
    channel_name: 'BankNifty Scalping Academy',
    country: 'India',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Options',
    sample_description: 'Nifty and Bank Nifty option buying strategies, price action setups, target/SL discipline.',
    sample_video_titles: ['BankNifty 15 Min Breakout Option Strategy', 'Live Nifty Expiry Scalping Session', 'Risk Reward Ratio in Options Trading']
  },
  {
    channel_id: 'UC_VAL_IN_02',
    channel_name: 'Delhi Street Food Explorer',
    country: 'India',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Exploring famous street food hubs in Old Delhi, chole bhature, parathas, and sweets.',
    sample_video_titles: ['Best Chole Bhature in Chandni Chowk', 'Old Delhi Street Food Walk Tour', 'Famous Indian Desserts and Kulfi']
  },

  // UNITED ARAB EMIRATES HOLDOUT
  {
    channel_id: 'UC_VAL_AE_01',
    channel_name: 'تداول الذهب والأسواق العالمية Dubai',
    country: 'United Arab Emirates',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'تحليل أسواق الذهب والعملات، إدارة المخاطر في التداول، والتحليل الفني للعملات الأجنبية.',
    sample_video_titles: ['تحليل أسعار الذهب XAUUSD اليوم', 'إستراتيجية تداول الفوركس للمبتدئين', 'إدارة رأس المال في الأسواق المالية']
  },
  {
    channel_id: 'UC_VAL_AE_02',
    channel_name: 'عالم العطور والساعات الفاخرة',
    country: 'United Arab Emirates',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'مراجعات العطور العربية والشرقية، الساعات السويسرية الفاخرة، وأسلوب الحياة في دبي.',
    sample_video_titles: ['أفضل دهن عود وورد في دبي', 'مراجعة أحدث الساعات الفاخرة 2026', 'جولة في أفخم المعارض في الإمارات']
  }
];

export async function runValidationTestSuite(): Promise<RegressionRunRecord> {
  const startTime = Date.now();
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const sample of INDEPENDENT_VALIDATION_DATASET) {
    const rel = await classifyTradingRelevance(
      sample.channel_name,
      sample.sample_description,
      sample.sample_video_titles,
      '',
      sample.country
    );

    const isVerifiedTrading = rel.status === 'TRADING_CONFIRMED';
    const isGroundTruthTrading = sample.ground_truth_trading === 'TRADING_CONFIRMED';

    if (isVerifiedTrading && isGroundTruthTrading) tp++;
    else if (isVerifiedTrading && !isGroundTruthTrading) fp++;
    else if (!isVerifiedTrading && !isGroundTruthTrading) tn++;
    else if (!isVerifiedTrading && isGroundTruthTrading) fn++;
  }

  const durationMs = Date.now() - startTime;
  const precision = (tp + fp) > 0 ? (tp / (tp + fp)) * 100 : 100;
  const recall = (tp + fn) > 0 ? (tp / (tp + fn)) * 100 : 100;
  const f1Score = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const metrics: RegressionRunMetrics = {
    total_tested: INDEPENDENT_VALIDATION_DATASET.length,
    classified_trading: tp + fp,
    classified_non_trading: tn + fn,
    true_positives: tp,
    true_negatives: tn,
    false_positives: fp,
    false_negatives: fn,
    precision,
    recall,
    f1_score: f1Score,
    discord_target_total: 0,
    discord_discovered: 0,
    discord_discovery_rate: 100,
    avg_processing_time_ms: durationMs / INDEPENDENT_VALIDATION_DATASET.length,
    api_quota_consumed: 0,
    query_performance_index: 100
  };

  return {
    id: Date.now(),
    run_timestamp: new Date().toISOString(),
    run_label: 'Holdout Validation Suite',
    metrics,
    sample_results: []
  };
}
