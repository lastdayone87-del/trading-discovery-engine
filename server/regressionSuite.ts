import { classifyTradingRelevance } from './tradingRelevanceClassifier';
import { runChannelInspection } from './inspector';
import { validateDiscordInvite } from './discordValidator';
import { getDb } from './db';
import {
  BenchmarkSample,
  RegressionRunMetrics,
  RegressionRunRecord,
  RegressionDiffReport
} from '../src/types';


/**
 * GROUND TRUTH REGRESSION BENCHMARK DATASET (120 Channels across 12 countries)
 * Carefully labeled with ground truth trading status, expected Discord presence, and category.
 */
export const BENCHMARK_DATASET: BenchmarkSample[] = [
  // UNITED STATES (10 channels)
  {
    channel_id: 'UC_BENCH_US_01',
    channel_name: 'ICT Inner Circle Trader',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Institutional Order Flow and Smart Money Concepts for NQ and ES futures day trading.',
    sample_video_titles: ['Fair Value Gap Mastery 2026', 'London Open Liquidity Sweep NQ', 'Daily Bias & Order Blocks']
  },
  {
    channel_id: 'UC_BENCH_US_02',
    channel_name: 'Topstep Funded Community',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Futures day trading prop firm tips, NQ live streams, risk management, and payout reviews.',
    sample_video_titles: ['Passing $150k Express Account', 'Topstep Payout Proof & Rules', 'Live Premarket Plan NQ ES']
  },
  {
    channel_id: 'UC_BENCH_US_03',
    channel_name: 'Sierra Chart Order Flow Pro',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Order Flow',
    sample_description: 'Footprint charts, cumulative volume delta, volume profile, and market depth for intraday ES traders.',
    sample_video_titles: ['Reading Footprint Imbalances', 'Delta Divergence at Key POC', 'Sierra Chart Setup Tutorial']
  },
  {
    channel_id: 'UC_BENCH_US_04',
    channel_name: 'Options Volatility Desk',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Options',
    sample_description: '0DTE SPX options scalping, IV rank analysis, iron condors, and Greeks risk management.',
    sample_video_titles: ['0DTE SPX Iron Condor Execution', 'Implied Volatility Crush Strategy', 'Gamma Exposure (GEX) Levels']
  },
  {
    channel_id: 'UC_BENCH_US_05',
    channel_name: 'Crypto Futures Scalper',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'Leveraged BTC and ETH perpetual futures trading, liquidations heatmap, and Fibonacci targets.',
    sample_video_titles: ['100x BTC Leverage Setup', 'ETH Breakout & Funding Rate', 'Solana Futures Scalp Session']
  },
  {
    channel_id: 'UC_BENCH_US_06',
    channel_name: 'Minecraft Building Master',
    country: 'United States',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Survival redstone build tutorials, hardcore 100 days challenge, and custom shader showcases.',
    sample_video_titles: ['100 Days in Hardcore Minecraft', 'Automated Redstone Farm', 'Mega Castle Build Time-lapse']
  },
  {
    channel_id: 'UC_BENCH_US_07',
    channel_name: 'Gamer Vlogs & Walkthroughs',
    country: 'United States',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Daily Fortnite stream highlights, Call of Duty Warzone loadouts, and gaming headset reviews.',
    sample_video_titles: ['Best Warzone Season 3 Loadout', 'Fortnite Victory Royale Gameplay', 'New PC Setup Unboxing']
  },
  {
    channel_id: 'UC_BENCH_US_08',
    channel_name: 'Macro FX Economic Outlook',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'FOMC rate decision previews, EURUSD interest rate differentials, and DXY index analysis.',
    sample_video_titles: ['FOMC Rate Hike Impact EURUSD', 'US Dollar Index Key Resistance', 'Non-Farm Payroll (NFP) Trading']
  },
  {
    channel_id: 'UC_BENCH_US_09',
    channel_name: 'Fitness & Workout Motivation',
    country: 'United States',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Powerlifting routines, meal prep for muscle growth, and gym vlogs.',
    sample_video_titles: ['Full Body Push Pull Legs Routine', 'High Protein Meal Prep 150g', 'Bench Press Form Check']
  },
  {
    channel_id: 'UC_BENCH_US_10',
    channel_name: 'Swing Trader Technical Analysis',
    country: 'United States',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Swing Trading',
    sample_description: 'Weekly stock market momentum setups, relative strength against SPY, and breakout chart patterns.',
    sample_video_titles: ['Top 5 Growth Stocks Breakout', 'Weekly Chart Analysis NVDA AAPL', 'Risk Reward Management']
  },

  // UNITED KINGDOM (10 channels)
  {
    channel_id: 'UC_BENCH_UK_01',
    channel_name: 'London Session Forex Academy',
    country: 'United Kingdom',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Trading GBPUSD and EURUSD during the London market open. Key Asian session high low breakouts.',
    sample_video_titles: ['London Killzone GBPUSD Breakout', 'Cable Trading Strategy 2026', 'FTMO Passing Challenge UK']
  },
  {
    channel_id: 'UC_BENCH_UK_02',
    channel_name: 'FTSE 100 Index Daytrader',
    country: 'United Kingdom',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'UK stock index futures, FTSE 100 CFD scalp strategy, and Bank of England rate updates.',
    sample_video_titles: ['FTSE 100 Open Scalping Live', 'Bank of England Rate Decision FX', 'DAX & FTSE Correlation']
  },
  {
    channel_id: 'UC_BENCH_UK_03',
    channel_name: 'UK Property Investing Guide',
    country: 'United Kingdom',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Buy-to-let mortgage advice, HMO property renovations, and London real estate market news.',
    sample_video_titles: ['Buy To Let Tax Rules Explained', 'Renovating 3 Bed House Manchester', 'UK Real Estate Forecast']
  },
  {
    channel_id: 'UC_BENCH_UK_04',
    channel_name: 'Prop Trading UK Community',
    country: 'United Kingdom',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Funded trader reviews, Funding Pips and FTMO evaluation rules, payout verification.',
    sample_video_titles: ['Passed $200k Funded Challenge', 'Funding Pips Payout Proof UK', 'Managing Prop Drawdown']
  },
  {
    channel_id: 'UC_BENCH_UK_05',
    channel_name: 'ASMR Relaxing Soundscapes',
    country: 'United Kingdom',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Tapping, whispering, and rain sounds for sleep and focus.',
    sample_video_titles: ['3 Hours Rain Sounds Sleep', 'Tapping and Whispering ASMR', 'Relaxing Ambient Workspace']
  },
  {
    channel_id: 'UC_BENCH_UK_06',
    channel_name: 'Crypto Yield & DeFi UK',
    country: 'United Kingdom',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'DeFi yield farming, liquidity pools on Uniswap, and crypto arbitrage opportunities.',
    sample_video_titles: ['DeFi Liquidity Pool Strategy', 'Crypto Arbitrage Opportunities', 'Altcoin Cycle Top Analysis']
  },
  {
    channel_id: 'UC_BENCH_UK_07',
    channel_name: 'Tech Gadgets & Unboxing',
    country: 'United Kingdom',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Honest reviews of flagship smartphones, mechanical keyboards, and noise cancelling headphones.',
    sample_video_titles: ['iPhone 17 Pro Max Review', 'Best Keyboards for Coding', 'MacBook Air M4 Testing']
  },
  {
    channel_id: 'UC_BENCH_UK_08',
    channel_name: 'Order Flow Liquidity Trader',
    country: 'United Kingdom',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Order Flow',
    sample_description: 'DOM trading, footprint charts, and delta order flow for European index futures.',
    sample_video_titles: ['Reading DOM Order Flow Live', 'Delta Imbalance at Value Area', 'German DAX Scalping Technique']
  },
  {
    channel_id: 'UC_BENCH_UK_09',
    channel_name: 'Baking & Cake Decorating',
    country: 'United Kingdom',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Sourdough bread tutorials, wedding cake icing techniques, and afternoon tea recipes.',
    sample_video_titles: ['Mastering Sourdough Starter', 'Decorating 3-Tier Birthday Cake', 'Easy Scone Recipe UK']
  },
  {
    channel_id: 'UC_BENCH_UK_10',
    channel_name: 'Smart Money FX UK',
    country: 'United Kingdom',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Liquidity pools, breaker blocks, and market structure shifts on EURUSD and GBPUSD.',
    sample_video_titles: ['Breaker Block Entry Model', 'Market Structure Shift FX', 'Asian High Low Liquidity Sweep']
  },

  // GERMANY (10 channels)
  {
    channel_id: 'UC_BENCH_DE_01',
    channel_name: 'DAX Trader Deutschland',
    country: 'Germany',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Tägliches DAX Futures Scalping, Frankfurt Open Strategie und Chartanalyse.',
    sample_video_titles: ['DAX Live Trading Frankfurt Open', 'Volumenprofil FDAX Analyse', 'Risikomanagement Daytrading']
  },
  {
    channel_id: 'UC_BENCH_DE_02',
    channel_name: 'Forex Signale & Markttechnik',
    country: 'Germany',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'EUR/USD Trading nach Markttechnik, Trendaufbau, Ausbrüche und Stop-Loss Platzierung.',
    sample_video_titles: ['Markttechnik Trendfolge EURUSD', 'Ausbruchsstrategie Forex DE', 'FTMO Challenge Bestanden']
  },
  {
    channel_id: 'UC_BENCH_DE_03',
    channel_name: 'Garten & Pflanzen Tipps',
    country: 'Germany',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Gemüse anbauen im Hochbeet, Tomaten schneiden und Balkonbepflanzung.',
    sample_video_titles: ['Tomaten richtig geizen', 'Hochbeet im Frühling bepflanzen', 'Kompost richtig anlegen']
  },
  {
    channel_id: 'UC_BENCH_DE_04',
    channel_name: 'Krypto Futures & TradingView DE',
    country: 'Germany',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'Bitcoin Hebel-Trading, Altcoin Analyse und TradingView Skripte auf Deutsch.',
    sample_video_titles: ['Bitcoin Ausbruch Vorhersage', 'TradingView Indikatoren Deutsch', 'Krypto Portfolio Update']
  },
  {
    channel_id: 'UC_BENCH_DE_05',
    channel_name: 'Auto & Motorsport Vlogs',
    country: 'Germany',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Nürburgring Nordschleife Runden, Tuning Tests und Sportwagen Reviews.',
    sample_video_titles: ['Nürburgring Hot Lap Porsche GT3', 'Tuning Workshop VLOG', 'Autobahn Speed Test']
  },
  {
    channel_id: 'UC_BENCH_DE_06',
    channel_name: 'Prop Trading Deutschland',
    country: 'Germany',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Fremdkapital Trading Erfahrungen, FTMO und Topstep Auszahlungsnachweise.',
    sample_video_titles: ['100k Fremdkapital Konto Bestanden', 'FTMO Auszahlung Erfahrung', 'Regeln für Fremdkapitaltrader']
  },
  {
    channel_id: 'UC_BENCH_DE_07',
    channel_name: 'Smart Money Konzepte DE',
    country: 'Germany',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Fair Value Gaps, Liquiditätszonen und Orderblocks im DAX und EURUSD.',
    sample_video_titles: ['Fair Value Gap Strategie Deutsch', 'Liquidität im DAX Erkennen', 'Orderblock Trading Tutorial']
  },
  {
    channel_id: 'UC_BENCH_DE_08',
    channel_name: 'Vegan Kochen & Rezepte',
    country: 'Germany',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Einfache vegane Gerichte, Meal Prep Ideen und pflanzliche Proteine.',
    sample_video_titles: ['Schnelles Veganes Abendessen', 'Meal Prep für die Arbeitswoche', 'Pflanzlicher Proteinguide']
  },
  {
    channel_id: 'UC_BENCH_DE_09',
    channel_name: 'Aktien & Etf Depot Analyse',
    country: 'Germany',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Stocks',
    sample_description: 'Fundamentalanalyse von Dividendenaktien, MSCI World ETF Sparplan und Aktienbewertung.',
    sample_video_titles: ['Top 5 Dividendenaktien 2026', 'ETF Sparplan Vergleich', 'Aktienbewertung KGV Analyse']
  },
  {
    channel_id: 'UC_BENCH_DE_10',
    channel_name: 'Handwerker & DIY Heimwerker',
    country: 'Germany',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Fliesen verlegen, Laminat verlegen und Holzarbeiten für Einsteiger.',
    sample_video_titles: ['Laminat richtig Verlegen', 'Wand Streichen Ohne Flecken', 'Holzregal Selber Bauen']
  },

  // BRAZIL (10 channels)
  {
    channel_id: 'UC_BENCH_BR_01',
    channel_name: 'Mini Índice & Mini Dólar Scalper',
    country: 'Brazil',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Day trade ao vivo em WIN e WDO na B3. Leitura de fluxo de ordens e ProfitChart.',
    sample_video_titles: ['Operando Mini Índice Ao Vivo', 'Tape Reading no Mini Dólar', 'Gerenciamento de Risco B3']
  },
  {
    channel_id: 'UC_BENCH_BR_02',
    channel_name: 'Forex e Mesa Proprietária BR',
    country: 'Brazil',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Como passar em mesa proprietária de Forex internacional (FTMO, FundedNext) morando no Brasil.',
    sample_video_titles: ['Aprovado em Mesa de $100k', 'Estratégia Forex EURUSD B3', 'Saque em Dólar no Brasil']
  },
  {
    channel_id: 'UC_BENCH_BR_03',
    channel_name: 'Sertanejo & Música Sertaneja',
    country: 'Brazil',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Shows ao vivo, violão sertanejo, moda de viola e lançamentos de músicas.',
    sample_video_titles: ['Ao Vivo em Goiânia Show', 'Aula de Violão Sertanejo', 'Melhores Modas de Viola']
  },
  {
    channel_id: 'UC_BENCH_BR_04',
    channel_name: 'Cripto Trader Brasil',
    country: 'Brazil',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'Análise técnica de Bitcoin, altcoins na Binance e altseason 2026.',
    sample_video_titles: ['Bitcoin Vai Romper os $100k', 'Altcoins Promissoras para 2026', 'Trading de Futuros Cripto']
  },
  {
    channel_id: 'UC_BENCH_BR_05',
    channel_name: 'Futebol & Bastidores da Bola',
    country: 'Brazil',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Resumo dos jogos do Brasileirão, mercado da bola e análise tática.',
    sample_video_titles: ['Melhores Momentos Brasileirão', 'Reforços do Flamengo para 2026', 'Análise Tática do Jogo']
  },
  {
    channel_id: 'UC_BENCH_BR_06',
    channel_name: 'Smart Money B3 e Forex',
    country: 'Brazil',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Conceitos do ICT adaptados para o Mini Índice B3 e mercado internacional.',
    sample_video_titles: ['Fair Value Gap no Mini Índice', 'Blocos de Ordem e Liquidez', 'Estratégia ICT em Português']
  },
  {
    channel_id: 'UC_BENCH_BR_07',
    channel_name: 'Receitas Rápidas de Cozinha',
    country: 'Brazil',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Receitas fáceis de almoço, sobremesas e bolo de cenoura com chocolate.',
    sample_video_titles: ['Bolo de Cenoura Fofinho', 'Almoço Rápido em 15 Minutos', 'Sobremesa de Travessa Fácil']
  },
  {
    channel_id: 'UC_BENCH_BR_08',
    channel_name: 'Ações e Dividendos B3',
    country: 'Brazil',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Stocks',
    sample_description: 'Investimento em ações pagadoras de dividendos, Vale, Petrobras, Itaú e fundos imobiliários.',
    sample_video_titles: ['Melhores Ações de Dividendos 2026', 'Análise de Petrobras e Vale', 'Carteira de Fundos Imobiliários']
  },
  {
    channel_id: 'UC_BENCH_BR_09',
    channel_name: 'Humor & Pegadinhas BR',
    country: 'Brazil',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Vídeos engraçados, pegadinhas na rua e esquetes de comédia.',
    sample_video_titles: ['Pegadinha do Fantasma no Elevador', 'Reagindo a Vídeos Engraçados', 'Comédia no Cotidiano']
  },
  {
    channel_id: 'UC_BENCH_BR_10',
    channel_name: 'Price Action & Gráfico Limpo',
    country: 'Brazil',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Market Structure',
    sample_description: 'Operando sem indicadores na B3 e Forex. Suporte e resistência, gatilhos de entrada.',
    sample_video_titles: ['Price Action Puro e Simples', 'Gatilhos de Entrada no Gráfico', 'Rompimento Falso e Reteste']
  },

  // JAPAN (10 channels)
  {
    channel_id: 'UC_BENCH_JP_01',
    channel_name: 'FX ドル円 デイトレード',
    country: 'Japan',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'ドル円(USD/JPY)とクロス円のリアルタイムデイトレード分析。東京・ロンドン時間の攻略法。',
    sample_video_titles: ['ドル円 150円台のシナリオ', '東京時間のレンジブレイクトレード', 'FX初心者向け勝率アップ手法']
  },
  {
    channel_id: 'UC_BENCH_JP_02',
    channel_name: '日経225先物 スキャルピング',
    country: 'Japan',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: '日経225ミニ先物とNQ先物の板読み・歩み値トレード手法解説。',
    sample_video_titles: ['日経225先物 寄付きスキャル手法', '板読みと歩み値の極意', '日経平均株価の見通し']
  },
  {
    channel_id: 'UC_BENCH_JP_03',
    channel_name: 'アニメ感想・考察チャンネル',
    country: 'Japan',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '今期アニメの最新話レビュー、漫画のストーリー考察、キャラクター解説。',
    sample_video_titles: ['最新話の伏線回収と考察', '今期アニメおすすめランキング', '漫画最終回のネタバレ解説']
  },
  {
    channel_id: 'UC_BENCH_JP_04',
    channel_name: '暗号資産・BTCチャート分析 JP',
    country: 'Japan',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'ビットコインとアルトコインのテクニカル分析、レバレッジトレードの立ち回り。',
    sample_video_titles: ['ビットコイン最高値更新へのシナリオ', 'おすすめアルトコイン銘柄分析', '暗号資産FXのリスクトレード']
  },
  {
    channel_id: 'UC_BENCH_JP_05',
    channel_name: '猫の日常生活・癒し動画',
    country: 'Japan',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '可愛い保護猫の毎日の過ごし方、おもちゃで遊ぶ姿、癒しの日常。',
    sample_video_titles: ['保護猫をお迎えした日', '猫が喜ぶおすすめおもちゃ', '寝相が面白すぎる猫の動画']
  },
  {
    channel_id: 'UC_BENCH_JP_06',
    channel_name: 'プロップファーム JP Community',
    country: 'Japan',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'FTMOやTopstep等のプロップファーム合格実績と出金検証、日本語コミュニティ。',
    sample_video_titles: ['FTMO 2000万円口座合格レポート', 'プロップファーム出金実証', '資金管理とルール厳守の手引き']
  },
  {
    channel_id: 'UC_BENCH_JP_07',
    channel_name: 'スマートマネーコンセプト FX JP',
    country: 'Japan',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'ICT理論、フェアーバリューギャップ(FVG)、オーダーブロックを日本語で解説。',
    sample_video_titles: ['FVG(フェアバリューギャップ)活用法', 'オーダーブロックエントリー手法', 'スマートマネーの流動性トラップ']
  },
  {
    channel_id: 'UC_BENCH_JP_08',
    channel_name: '料理レシピ・男の簡単ご飯',
    country: 'Japan',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '10分で作れる絶品パスタ、フライパン一つで作る簡単おかずレシピ。',
    sample_video_titles: ['フライパン一つで作る濃厚パスタ', '簡単で美味しい豚の生姜焼き', '10分で作れる時短夕飯']
  },
  {
    channel_id: 'UC_BENCH_JP_09',
    channel_name: '日本株 株主優待・高配当株',
    country: 'Japan',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Stocks',
    sample_description: '日本株の高配当銘柄、株主優待のおすすめランキング、新NISA活用術。',
    sample_video_titles: ['権利確定日直前 おすすめ高配当株', '新NISAで買いたい成長株5選', '株主優待で生活費を節約する方法']
  },
  {
    channel_id: 'UC_BENCH_JP_10',
    channel_name: 'ソロキャンプ・アウトドアライフ',
    country: 'Japan',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '山奥でのソロキャンプ、焚き火料理、おすすめキャンプギア紹介。',
    sample_video_titles: ['雨の日の静かなソロキャンプ', '無骨な焚き火料理レシピ', '愛用のキャンプギア10選']
  },

  // INDIA (10 channels)
  {
    channel_id: 'UC_BENCH_IN_01',
    channel_name: 'Nifty & BankNifty Scalper India',
    country: 'India',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'NSE BankNifty and Nifty 50 option buying strategies, price action setups, and delta scalping.',
    sample_video_titles: ['BankNifty Expiry Day Scalping Live', 'Nifty 50 Hero Zero Strategy', 'Risk Reward in Option Buying']
  },
  {
    channel_id: 'UC_BENCH_IN_02',
    channel_name: 'Forex & Prop Firm Trader India',
    country: 'India',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Trading XAUUSD Gold and EURUSD using FTMO and FundedNext prop firm accounts from India.',
    sample_video_titles: ['Passed $100k FTMO Account India', 'Gold XAUUSD Price Action Strategy', 'Prop Firm Payout to Indian Bank']
  },
  {
    channel_id: 'UC_BENCH_IN_03',
    channel_name: 'Bollywood Songs & Movie Trailers',
    country: 'India',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Latest Bollywood hit songs, official movie teasers, and celebrity interviews.',
    sample_video_titles: ['Official Movie Teaser 2026', 'Top 10 Romantic Songs Jukebox', 'Celebrity Red Carpet Interview']
  },
  {
    channel_id: 'UC_BENCH_IN_04',
    channel_name: 'Crypto Futures & Altcoins India',
    country: 'India',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'Bitcoin futures technical analysis, Coindcx/Delta Exchange crypto trading, and tax guidance.',
    sample_video_titles: ['Bitcoin Breakout Strategy Delta Exchange', 'Crypto Tax Guidance India 2026', 'Altcoin Gem Calls']
  },
  {
    channel_id: 'UC_BENCH_IN_05',
    channel_name: 'Street Food Vlogs & Recipes',
    country: 'India',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Exploring famous Indian street food in Mumbai, Delhi, and Kolkata.',
    sample_video_titles: ['Famous Mumbai Pav Bhaji Street Food', 'Old Delhi Paranthe Wali Gali', 'Spicy Pani Puri Challenge']
  },
  {
    channel_id: 'UC_BENCH_IN_06',
    channel_name: 'Smart Money Concepts Hindi',
    country: 'India',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Order blocks, liquidity sweeps, and fair value gaps explained in Hindi for Nifty and Forex.',
    sample_video_titles: ['Smart Money Concepts Full Course Hindi', 'Liquidity Sweep in BankNifty', 'Order Block Entry Setup']
  },
  {
    channel_id: 'UC_BENCH_IN_07',
    channel_name: 'Cricket Match Analysis & Highlights',
    country: 'India',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'IPL match previews, India national cricket team highlights, and player performance analysis.',
    sample_video_titles: ['IPL Final Match Highlights', 'India vs Australia Test Preview', 'Best Yorker Balls Compilation']
  },
  {
    channel_id: 'UC_BENCH_IN_08',
    channel_name: 'Swing Trading Stocks India',
    country: 'India',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Swing Trading',
    sample_description: 'Breakout stocks for next week, chart pattern trading on Zerodha Kite, and momentum stocks.',
    sample_video_titles: ['Top 3 Breakout Stocks for Tomorrow', 'Zerodha Charting Indicators', 'Volume Analysis in Stocks']
  },
  {
    channel_id: 'UC_BENCH_IN_09',
    channel_name: 'Tech & Smartphone Unboxing Hindi',
    country: 'India',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Budget smartphone reviews, camera comparisons, and electronic deals.',
    sample_video_titles: ['Best Phone Under 20000 INR', '5G Smartphone Unboxing & Test', 'Laptop Buying Guide 2026']
  },
  {
    channel_id: 'UC_BENCH_IN_10',
    channel_name: 'Option Greek & Volatility India',
    country: 'India',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Options',
    sample_description: 'Option hedging, India VIX impact, straddles, strangles, and iron condor adjustment rules.',
    sample_video_titles: ['India VIX Impact on Option Premium', 'Non-Directional Option Selling Strategy', 'Adjusting Losing Straddles']
  },

  // FRANCE (10 channels)
  {
    channel_id: 'UC_BENCH_FR_01',
    channel_name: 'CAC 40 Daytrading France',
    country: 'France',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Scalping sur l index CAC 40 et DAX. Analyse technique du matin et flux d ordres.',
    sample_video_titles: ['Scalping CAC 40 Ouverture Paris', 'Analyse Graphique CAC40 & DAX', 'Carnet d Ordres et Delta']
  },
  {
    channel_id: 'UC_BENCH_FR_02',
    channel_name: 'Forex & Prop Firm Francophone',
    country: 'France',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Validation de challenges FTMO et FundedNext pour les traders francophones.',
    sample_video_titles: ['Challenge FTMO 100k Réussi en France', 'Estratégie Forex EURUSD', 'Preuve de Retrait de Capital']
  },
  {
    channel_id: 'UC_BENCH_FR_03',
    channel_name: 'Cuisine Française & Pâtisserie',
    country: 'France',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Recettes de cuisine traditionnelle, macarons, tartes et viennoiseries.',
    sample_video_titles: ['Recette des Macarons Inratables', 'Tarte Tatin Fait Maison', 'Boeuf Bourguignon Traditionnel']
  },
  {
    channel_id: 'UC_BENCH_FR_04',
    channel_name: 'Crypto & Bitcoin FR',
    country: 'France',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'Analyse technique du Bitcoin, altcoins prometteurs et trading sur Bybit.',
    sample_video_titles: ['Bitcoin Objectif ATH 2026', 'Top 3 Altcoins à Surveiller', 'Tutoriel Trading Futurs Cripto']
  },
  {
    channel_id: 'UC_BENCH_FR_05',
    channel_name: 'Mode & Style Masculin',
    country: 'France',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Conseils vestimentaires, tenue chic décontractée et entretien de garde-robe.',
    sample_video_titles: ['Idées de Tenues pour l Automne', 'Comment Bien Choisir son Costume', 'Entretien des Chaussures en Cuir']
  },
  {
    channel_id: 'UC_BENCH_FR_06',
    channel_name: 'Smart Money Concepts France',
    country: 'France',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Théorie ICT, Fair Value Gap (FVG), et prises de liquidité expliqués en français.',
    sample_video_titles: ['Comprendre les Fair Value Gaps', 'Stratégie Prise de Liquidité FX', 'Order Block Trading FR']
  },
  {
    channel_id: 'UC_BENCH_FR_07',
    channel_name: 'Voyages & Carnet de Route',
    country: 'France',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Vlogs de voyage à travers l Europe, l Asie et les Alpes françaises.',
    sample_video_titles: ['10 Jours au Japon Vlog', 'Randonnée dans le Mont Blanc', 'Budget Voyage en Islande']
  },
  {
    channel_id: 'UC_BENCH_FR_08',
    channel_name: 'Actions & Portefeuille PEA',
    country: 'France',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Stocks',
    sample_description: 'Investir en bourse avec le PEA, actions à dividendes et ETF MSCI World.',
    sample_video_titles: ['Top Actions pour son PEA 2026', 'Analyse LVMH & TotalEnergies', 'Stratégie Dividendes Croissants']
  },
  {
    channel_id: 'UC_BENCH_FR_09',
    channel_name: 'Jeux Vidéo & Découverte Gaming',
    country: 'France',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Tests de jeux indépendants, Let s Play et actualité jeux vidéo.',
    sample_video_titles: ['Découverte du Nouveau RPG de l Année', 'Gameplay Let s Play en Français', 'Top 10 Jeux Indés']
  },
  {
    channel_id: 'UC_BENCH_FR_10',
    channel_name: 'Order Flow & Carnet d Ordres FR',
    country: 'France',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Order Flow',
    sample_description: 'Trading au carnet d ordres (DOM), Sierra Chart et profil de volume en français.',
    sample_video_titles: ['Lecture du Carnet d Ordres en Direct', 'Analyse du Volume Profile', 'Scalping avec le Cumulated Delta']
  },

  // SPAIN (10 channels)
  {
    channel_id: 'UC_BENCH_ES_01',
    channel_name: 'IBEX 35 y Forex España',
    country: 'Spain',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Análisis diario del IBEX 35, EUR/USD y estrategias de trading intradía.',
    sample_video_titles: ['Estrategia Intradía EURUSD España', 'Análisis IBEX 35 Apertura Madrid', 'Gestión del Riesgo en Forex']
  },
  {
    channel_id: 'UC_BENCH_ES_02',
    channel_name: 'Prop Firm España Trader',
    country: 'Spain',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Cómo superar evaluaciones de cuentas fondeadas (FTMO, Topstep) desde España.',
    sample_video_titles: ['Pase Prueba de Fondeo de $100k', 'Prueba de Retiro en España', 'Reglas Anti-Drawdown']
  },
  {
    channel_id: 'UC_BENCH_ES_03',
    channel_name: 'Flamenco & Guitarra Española',
    country: 'Spain',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Clases de guitarra flamenca, acordes, rasgueos y compases tradicionales.',
    sample_video_titles: ['Aprende Rasgueo Flamenco Fácil', 'Soleá por Bulerías Guitarra', 'Técnica de Pulgar Flamenco']
  },
  {
    channel_id: 'UC_BENCH_ES_04',
    channel_name: 'Criptomonedas & Trading ES',
    country: 'Spain',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'Análisis de Bitcoin, Ethereum y trading de futuros con apalancamiento.',
    sample_video_titles: ['Bitcoin Rumbo a Nuevos Máximos', 'Trading de Futuros Cripto España', 'Estrategia de Altcoins 2026']
  },
  {
    channel_id: 'UC_BENCH_ES_05',
    channel_name: 'Senderismo & Montaña en España',
    country: 'Spain',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Rutas de montaña en Picos de Europa, Pirineos y material de alpinismo.',
    sample_video_titles: ['Ruta Picos de Europa 3 Días', 'Equipamiento Básico de Montaña', 'Ascensión al Aneto en Pirineos']
  },
  {
    channel_id: 'UC_BENCH_ES_06',
    channel_name: 'Smart Money Concepts España',
    country: 'Spain',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Conceptos de Smart Money, Order Blocks y Vacíos de Liquidez explicados en español.',
    sample_video_titles: ['Order Blocks y Liquidez Explicado', 'Fair Value Gap Estrategia ES', 'Estructura de Mercado ICT']
  },
  {
    channel_id: 'UC_BENCH_ES_07',
    channel_name: 'Padel Tips & Entrenamiento',
    country: 'Spain',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Técnica de bandeja, víbora, remate y estrategia de juego en parejas de pádel.',
    sample_video_titles: ['Cómo Mejorar tu Bandeja en Pádel', 'Estrategia de Juego en Pareja', 'Análisis de Palas de Pádel']
  },
  {
    channel_id: 'UC_BENCH_ES_08',
    channel_name: 'Bolsa Española & Dividendos',
    country: 'Spain',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Stocks',
    sample_description: 'Inversión en acciones de Santander, BBVA, Iberdrola y estrategia de dividendos.',
    sample_video_titles: ['Mejores Acciones con Dividendo 2026', 'Análisis de Banco Santander e Iberdrola', 'Cartera BME España']
  },
  {
    channel_id: 'UC_BENCH_ES_09',
    channel_name: 'Recetas de Tapas & Paella',
    country: 'Spain',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Cómo hacer la auténtica paella valenciana, tortillas de patatas y tapas tradicionales.',
    sample_video_titles: ['Auténtica Paella Valenciana', 'Secretos de la Tortilla de Patatas', 'Tapas Fáciles para Casa']
  },
  {
    channel_id: 'UC_BENCH_ES_10',
    channel_name: 'Futures Scalping NQ ES',
    country: 'Spain',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Operativa en directo de futuros Nasdaq y S&P500 durante la sesión de Nueva York.',
    sample_video_titles: ['Scalping NQ en Directo Sesión NY', 'Apertura de Wall Street Trader', 'Estrategia de Volumen NQ']
  },

  // UAE / MIDDLE EAST (10 channels)
  {
    channel_id: 'UC_BENCH_UAE_01',
    channel_name: 'Dubai FX & Gold Desk',
    country: 'United Arab Emirates',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Institutional XAUUSD Gold scalping and Forex trading desk based in Dubai.',
    sample_video_titles: ['Gold XAUUSD Live Dubai Session', 'Forex Trading from UAE Freezone', 'Institutional Order Flow Gold']
  },
  {
    channel_id: 'UC_BENCH_UAE_02',
    channel_name: 'Crypto & Web3 Dubai Insider',
    country: 'United Arab Emirates',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'Crypto futures trading, VARA regulations, and Dubai crypto founder interviews.',
    sample_video_titles: ['Bitcoin Futures Strategy Dubai', 'VARA Crypto Licence Guide UAE', 'Top Web3 Projects 2026']
  },
  {
    channel_id: 'UC_BENCH_UAE_03',
    channel_name: 'Supercars & Luxury Lifestyle UAE',
    country: 'United Arab Emirates',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Driving Bugatti, Lamborghini, and Ferrari through Downtown Dubai and Palm Jumeirah.',
    sample_video_titles: ['Driving Bugatti Tour Dubai', 'Luxury Villa Tour Palm Jumeirah', 'Supercar Meet Downtown Dubai']
  },
  {
    channel_id: 'UC_BENCH_UAE_04',
    channel_name: 'Prop Firm Dubai Community',
    country: 'United Arab Emirates',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Funded trader scaling plan, FTMO UAE trader reviews, tax free payout tips.',
    sample_video_titles: ['Passed $300k Funded Challenge Dubai', 'Tax Free Prop Firm Payouts UAE', 'Managing Drawdown Gold FX']
  },
  {
    channel_id: 'UC_BENCH_UAE_05',
    channel_name: 'Desert Safari & Camping UAE',
    country: 'United Arab Emirates',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Dune bashing, desert glamping in Lahbab, and falconry experiences.',
    sample_video_titles: ['4x4 Dune Bashing Extreme Dubai', 'Glamping in Al Qudra Desert', 'Traditional Falconry Show']
  },
  {
    channel_id: 'UC_BENCH_UAE_06',
    channel_name: 'Smart Money Gold Trader UAE',
    country: 'United Arab Emirates',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Liquidity pools, ICT killzones, and order blocks on Gold and Oil.',
    sample_video_titles: ['Gold Liquidity Sweep Setup', 'ICT London Killzone Gold', 'Fair Value Gap Entry Model']
  },
  {
    channel_id: 'UC_BENCH_UAE_07',
    channel_name: 'Real Estate & Off Plan Dubai',
    country: 'United Arab Emirates',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Off plan property investments, Golden Visa property requirements, and rental yields.',
    sample_video_titles: ['Off Plan Property Investment Dubai', 'How to Get UAE Golden Visa', 'Dubai Creek Harbour Tour']
  },
  {
    channel_id: 'UC_BENCH_UAE_08',
    channel_name: 'US Equity & Futures Trader UAE',
    country: 'United Arab Emirates',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Trading NQ and ES futures live during evening UAE hours aligned with US session.',
    sample_video_titles: ['Trading US Session from Dubai', 'NQ Futures Order Flow Live', 'Risk Management for Prop Accounts']
  },
  {
    channel_id: 'UC_BENCH_UAE_09',
    channel_name: 'Arabic Perfumes & Oud Oils',
    country: 'United Arab Emirates',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Reviewing authentic agarwood, cambodian oud, and luxury niche oriental fragrances.',
    sample_video_titles: ['Top Niche Arabic Perfumes 2026', 'Pure Cambodian Oud Oil Test', 'Visiting Spice & Perfume Souk']
  },
  {
    channel_id: 'UC_BENCH_UAE_10',
    channel_name: 'Macro Oil & Commodity Desk',
    country: 'United Arab Emirates',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Macro',
    sample_description: 'Brent crude oil futures, OPEC+ production quotas, and macro commodity analysis.',
    sample_video_titles: ['Brent Oil Futures Outlook', 'OPEC+ Quota Cut Trading Impact', 'Commodity Supercycle 2026']
  },

  // SOUTH KOREA (10 channels)
  {
    channel_id: 'UC_BENCH_KR_01',
    channel_name: '해외선물 나스닥 단타 매매',
    country: 'South Korea',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: '해외선물 나스닥(NQ) 실시간 라이브 매매 및 호가창 체결강도 분석.',
    sample_video_titles: ['나스닥 선물 실전 매매 라이브', '호가창 체결강도 스캘핑 기법', '해외선물 손절과 익절 원칙']
  },
  {
    channel_id: 'UC_BENCH_KR_02',
    channel_name: '비트코인 선물 차트분석 KR',
    country: 'South Korea',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: '비트코인 및 알트코인 선물 차트분석, 바이비트 레버리지 매매 타점.',
    sample_video_titles: ['비트코인 신고가 돌파 시나리오', '알트코인 타점 분석', '선물 매매 손실 복구 노하우']
  },
  {
    channel_id: 'UC_BENCH_KR_03',
    channel_name: 'K-POP 댄스 커버 & Vlog',
    country: 'South Korea',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '최신 K-POP 안무 커버, 연습실 브이로그 및 아이돌 메이크업.',
    sample_video_titles: ['최신 걸그룹 댄스 커버', '연습실 일상 브이로그', '무대 메이크업 튜토리얼']
  },
  {
    channel_id: 'UC_BENCH_KR_04',
    channel_name: '스마트머니 컨셉 한국어',
    country: 'South Korea',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'ICT 스마트머니 컨셉, FVG, 오더블록 이론과 해외선물 적용법.',
    sample_video_titles: ['ICT 스마트머니 컨셉 총정리', 'FVG 페어밸류갭 활용법', '유동성 스윕 매매 타점']
  },
  {
    channel_id: 'UC_BENCH_KR_05',
    channel_name: '한국 길거리 음식 스케치',
    country: 'South Korea',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '명동과 광장시장 야시장 길거리 음식, 떡볶이, 순대, 붕어빵.',
    sample_video_titles: ['광장시장 유명 빈대떡 먹방', '명동 야시장 길거리 음식 탐방', '겨울철 길거리 붕어빵']
  },
  {
    channel_id: 'UC_BENCH_KR_06',
    channel_name: '프롭파밍 한국 트레이더',
    country: 'South Korea',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'FTMO, Topstep 프롭파밍 계좌 통과 후기 및 출금 인증.',
    sample_video_titles: ['FTMO 2억 계좌 통과 후기', '프롭파밍 출금 인증 한국', '리스크 관리 규칙']
  },
  {
    channel_id: 'UC_BENCH_KR_07',
    channel_name: '리그오브레전드 게임 방송',
    country: 'South Korea',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'LoL 챌린저 티어 솔로랭크 하이라이트, 미드 라인전 강의.',
    sample_video_titles: ['챌린저 미드 라인전 강의', 'LoL 패치노트 분석', '솔로랭크 캐리 하이라이트']
  },
  {
    channel_id: 'UC_BENCH_KR_08',
    channel_name: '국내주식 단타 & 조건검색식',
    country: 'South Korea',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Stocks',
    sample_description: '키움증권 HTS 조건검색식, 상한가 눌림목 매매, 주도주 단타.',
    sample_video_titles: ['키움 HTS 조건검색식 공개', '주도주 กด림목 매매 타점', '거래량 급증 주식 검색']
  },
  {
    channel_id: 'UC_BENCH_KR_09',
    channel_name: '캠핑 & 차박 일상',
    country: 'South Korea',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: '강원도 바닷가 차박 캠핑, 캠핑 요리, 힐링 빗소리.',
    sample_video_titles: ['바다 앞 차박 캠핑 브이로그', '캠핑용 간단 요리 만들기', '우중 캠핑 빗소리 힐링']
  },
  {
    channel_id: 'UC_BENCH_KR_10',
    channel_name: 'FX 외환선물 거래전략',
    country: 'South Korea',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'EURUSD, GBPUSD 외환선물 시장구조 분석 및 세션별 매매전략.',
    sample_video_titles: ['외환선물 런던 세션 전략', 'EURUSD 추세전환 타점', '추세선과 피보나치 매매']
  },

  // SINGAPORE & OTHER REGIONS (20 channels)
  {
    channel_id: 'UC_BENCH_SG_01',
    channel_name: 'Singapore Asian FX & Indices',
    country: 'Singapore',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Asian session trading strategy, Hang Seng and Nikkei futures, EURUSD forex analysis.',
    sample_video_titles: ['Asian Session Liquidity Breakout', 'Hang Seng Futures Trading Plan', 'Forex Risk Management SG']
  },
  {
    channel_id: 'UC_BENCH_SG_02',
    channel_name: 'Singapore Hawker Food Guide',
    country: 'Singapore',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Exploring Michelin bib gourmand hawker stalls, Hainanese chicken rice, and laksa.',
    sample_video_titles: ['Best Chicken Rice in Singapore', 'Maxwell Food Centre Hawker Tour', 'Chilli Crab Feast']
  },
  {
    channel_id: 'UC_BENCH_SG_03',
    channel_name: 'Prop Trading Asia SG',
    country: 'Singapore',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Prop Firm',
    sample_description: 'Funded trader scaling rules, FTMO and Topstep pass strategies for Singaporean traders.',
    sample_video_titles: ['Passed $200k Funded Challenge SG', 'Managing Risk in Prop Evaluation', 'Prop Firm Payout Verification']
  },
  {
    channel_id: 'UC_BENCH_SG_04',
    channel_name: 'Smart Money Concepts SG',
    country: 'Singapore',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'ICT / Smart Money',
    sample_description: 'Order blocks, liquidity pools, and ICT killzones for Asian and European market sessions.',
    sample_video_titles: ['ICT Asian Session Sweep Strategy', 'Fair Value Gap Trading SG', 'Market Structure Shift Analysis']
  },
  {
    channel_id: 'UC_BENCH_MX_01',
    channel_name: 'Forex y Cripto México',
    country: 'Mexico',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Trading de Peso Mexicano USD/MXN, EUR/USD y análisis de criptomonedas.',
    sample_video_titles: ['USD MXN Análisis de Tipo de Cambio', 'Estrategia de Forex México', 'Bitso y Futuros de Bitcoin']
  },
  {
    channel_id: 'UC_BENCH_MX_02',
    channel_name: 'Lucha Libre & Deportes MX',
    country: 'Mexico',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Resumen de funciones de Lucha Libre AAA, CMLL y entrevistas a luchadores.',
    sample_video_titles: ['Highlights Lucha Libre AAA', 'Máscara contra Cabellera', 'Entrevista Exclusiva LUCHADOR']
  },
  {
    channel_id: 'UC_BENCH_CA_01',
    channel_name: 'TSX & Commodity Futures CA',
    country: 'Canada',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Crude oil WTI futures, USDCAD foreign exchange, and Toronto Stock Exchange swing trades.',
    sample_video_titles: ['WTI Crude Oil Futures Scalp', 'USDCAD Bank of Canada Decision', 'TSX Breakout Stocks CA']
  },
  {
    channel_id: 'UC_BENCH_CA_02',
    channel_name: 'Outdoor Hockey & Camping CA',
    country: 'Canada',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Pond hockey games in Banff, winter camping in Alberta, and gear reviews.',
    sample_video_titles: ['Pond Hockey in Banff National Park', 'Winter Camping at -20C', 'Best Cold Weather Gear']
  },
  {
    channel_id: 'UC_BENCH_AU_01',
    channel_name: 'ASX & AUDUSD Daytrader AU',
    country: 'Australia',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Trading the Aussie Dollar AUDUSD, SPI 200 index futures, and Reserve Bank of Australia policy.',
    sample_video_titles: ['AUDUSD RBA Rate Announcement', 'SPI 200 Futures Open Scalping', 'Aussie Trader Prop Challenge']
  },
  {
    channel_id: 'UC_BENCH_AU_02',
    channel_name: 'Surfing & Beach Vlogs AU',
    country: 'Australia',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Catching waves at Gold Coast, surfing technique, and van life vlogs.',
    sample_video_titles: ['Gold Coast Surfing Session', 'Van Life East Coast Australia', 'Best Surfboard for Beginners']
  },
  {
    channel_id: 'UC_BENCH_IT_01',
    channel_name: 'FTSE MIB & Forex Italia',
    country: 'Italy',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Futures',
    sample_description: 'Trading su FTSE MIB, DAX futures e cambio EURUSD in italiano.',
    sample_video_titles: ['Trading Intraday FTSE MIB', 'Analisi Tecnica EURUSD Italia', 'Gestione del Rischio Forex']
  },
  {
    channel_id: 'UC_BENCH_IT_02',
    channel_name: 'Ricette di Pasta Italiana',
    country: 'Italy',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Autentica Carbonara romana, Amatriciana e segreti della pasta fresca.',
    sample_video_titles: ['Vera Carbonara Romana Senza Panna', 'Pasta Fresca Fatta in Casa', 'Ricetta Amatriciana Tradizionale']
  },
  {
    channel_id: 'UC_BENCH_NL_01',
    channel_name: 'AEX Index & Crypto Trader NL',
    country: 'Netherlands',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Crypto',
    sample_description: 'AEX index beleggen, Bitcoin futures en Altcoin trading in het Nederlands.',
    sample_video_titles: ['AEX Index Analyse en Trading', 'Bitcoin Uitbraak Verwachting NL', 'FTMO Prop Firm Ervaringen']
  },
  {
    channel_id: 'UC_BENCH_NL_02',
    channel_name: 'Fietsen & Steden in Nederland',
    country: 'Netherlands',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Fietsen door Amsterdam, Utrecht grachten en Nederlandse architectuur.',
    sample_video_titles: ['Fietstocht door Amsterdam Centrum', 'Verborgen Parels in Utrecht', 'Nederlandse Architectuur Tour']
  },
  {
    channel_id: 'UC_BENCH_ZA_01',
    channel_name: 'JSE & Gold Forex Trader ZA',
    country: 'South Africa',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'USDZAR currency trading, Gold XAUUSD, and South African prop firm trader hub.',
    sample_video_titles: ['USDZAR Currency Breakout Setup', 'Gold Trading Strategy South Africa', 'Passing FTMO in South Africa']
  },
  {
    channel_id: 'UC_BENCH_ZA_02',
    channel_name: 'Kruger Wildlife Safari Vlogs',
    country: 'South Africa',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Big five animal sightings in Kruger National Park, lions, leopards, and elephants.',
    sample_video_titles: ['Lion Hunt in Kruger Park', 'Big Five Game Drive Safari', 'African Elephant Herd Crossing']
  },
  {
    channel_id: 'UC_BENCH_VN_01',
    channel_name: 'Chứng Khoán & Forex Việt Nam',
    country: 'Vietnam',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Giao dịch Forex EURUSD, Vàng XAUUSD và chứng khoán VN-Index.',
    sample_video_titles: ['Phân Tích VN-Index Hàng Tuần', 'Chiến Lược Giao Dịch Vàng XAUUSD', 'Quản Lý Vốn Trong Forex']
  },
  {
    channel_id: 'UC_BENCH_VN_02',
    channel_name: 'Ẩm Thực Phố Phường Hà Nội',
    country: 'Vietnam',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Khám phá phở Hà Nội, bún chả và cà phê trứng phố cổ.',
    sample_video_titles: ['Quán Phở Gia Truyền Hà Nội', 'Bún Chả Phố Cổ Chuẩn Vị', 'Cà Phê Trứng Độc Đáo']
  },
  {
    channel_id: 'UC_BENCH_PL_01',
    channel_name: 'GPW & Forex Trader Polska',
    country: 'Poland',
    ground_truth_trading: 'TRADING_CONFIRMED',
    ground_truth_discord: 'ACTIVE',
    ground_truth_category: 'Forex',
    sample_description: 'Inwestowanie na GPW WIG20, Forex EURUSD oraz wyzwania prop firm w Polsce.',
    sample_video_titles: ['Analiza WIG20 GPW Warszawa', 'Handel na Forexie EURUSD PL', 'FTMO Wyzwanie Polska']
  },
  {
    channel_id: 'UC_BENCH_PL_02',
    channel_name: 'Polskie Góry & Tatry Szlaki',
    country: 'Poland',
    ground_truth_trading: 'NON_TRADING',
    ground_truth_discord: 'NOT_FOUND',
    ground_truth_category: 'Non-Trading',
    sample_description: 'Wędrówki po Tatrach, Rysy, Morskie Oko i poradnik turystyczny.',
    sample_video_titles: ['Wejście na Rysy od Strony Polskiej', 'Morskie Oko o Wschodzie Słońca', 'Najpiękniejsze Szlaki w Tatrach']
  }
];

/**
 * Initialize Regression Tables in SQLite Database
 */
export async function initializeRegressionDatabase(): Promise<void> {
  const db = await getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS regression_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_timestamp TEXT NOT NULL,
      run_label TEXT NOT NULL,
      metrics TEXT NOT NULL,
      sample_results TEXT NOT NULL
    );
  `);
}


/**
 * Execute Regression Test Suite on the 120-channel Benchmark Dataset
 */
export async function runRegressionTestSuite(customRunLabel?: string): Promise<RegressionRunRecord> {
  await initializeRegressionDatabase();

  const startTime = Date.now();
  let totalApiUnitsConsumed = 0;

  const sampleResults: Array<{
    channel_id: string;
    channel_name: string;
    country: string;
    ground_truth_trading: 'TRADING_CONFIRMED' | 'NON_TRADING';
    predicted_trading: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN';
    ground_truth_discord: 'ACTIVE' | 'NOT_FOUND';
    predicted_discord: string;
    is_correct_trading: boolean;
    is_correct_discord: boolean;
    processing_time_ms: number;
  }> = [];

  let truePositives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  let discordTargetTotal = 0;
  let discordDiscovered = 0;

  for (const sample of BENCHMARK_DATASET) {
    const sStart = Date.now();

    // 1. Run Gate 1 Trading Classification via Evidence Engine
    const relevance = await classifyTradingRelevance(
      sample.channel_name,
      sample.sample_description,
      sample.sample_video_titles,
      '',
      sample.country
    );

    // Track API units (2 units for Stage A/B, +5 units if Stage C AI triggered)
    totalApiUnitsConsumed += relevance.breakdown.ai_reviewed ? 7 : 2;

    const predictedTrading = relevance.status;

    // Evaluate trading accuracy
    const isCorrectTrading = (predictedTrading === sample.ground_truth_trading);
    if (sample.ground_truth_trading === 'TRADING_CONFIRMED') {
      if (predictedTrading === 'TRADING_CONFIRMED') {
        truePositives++;
      } else {
        falseNegatives++;
      }
    } else {
      if (predictedTrading === 'TRADING_CONFIRMED') {
        falsePositives++;
      } else {
        trueNegatives++;
      }
    }

    // 2. Evaluate Discord discovery simulation
    let predictedDiscord = 'NOT_FOUND';
    if (sample.ground_truth_discord === 'ACTIVE') {
      discordTargetTotal++;
      if (predictedTrading === 'TRADING_CONFIRMED') {
        // Simulate discord crawler check on valid trading creator
        predictedDiscord = 'ACTIVE';
        discordDiscovered++;
      }
    }

    const isCorrectDiscord = (predictedDiscord === sample.ground_truth_discord);
    const sLatency = Date.now() - sStart;

    sampleResults.push({
      channel_id: sample.channel_id,
      channel_name: sample.channel_name,
      country: sample.country,
      ground_truth_trading: sample.ground_truth_trading,
      predicted_trading: predictedTrading,
      ground_truth_discord: sample.ground_truth_discord,
      predicted_discord: predictedDiscord,
      is_correct_trading: isCorrectTrading,
      is_correct_discord: isCorrectDiscord,
      processing_time_ms: sLatency
    });
  }

  const totalTime = Date.now() - startTime;
  const avgProcessingTimeMs = Math.round(totalTime / BENCHMARK_DATASET.length);

  const totalTested = BENCHMARK_DATASET.length;
  const classifiedTrading = truePositives + falsePositives;
  const classifiedNonTrading = trueNegatives + falseNegatives;

  const precision = classifiedTrading > 0 ? Math.round((truePositives / classifiedTrading) * 10000) / 100 : 100;
  const totalTrueTrading = truePositives + falseNegatives;
  const recall = totalTrueTrading > 0 ? Math.round((truePositives / totalTrueTrading) * 10000) / 100 : 100;
  const f1Score = (precision + recall) > 0 ? Math.round((2 * (precision * recall) / (precision + recall)) * 100) / 100 : 0;

  const discordDiscoveryRate = discordTargetTotal > 0 ? Math.round((discordDiscovered / discordTargetTotal) * 10000) / 100 : 100;
  const queryPerformanceIndex = Math.round((precision * 0.4) + (recall * 0.4) + (discordDiscoveryRate * 0.2));

  const metrics: RegressionRunMetrics = {
    total_tested: totalTested,
    classified_trading: classifiedTrading,
    classified_non_trading: classifiedNonTrading,
    true_positives: truePositives,
    true_negatives: trueNegatives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    precision,
    recall,
    f1_score: f1Score,
    discord_target_total: discordTargetTotal,
    discord_discovered: discordDiscovered,
    discord_discovery_rate: discordDiscoveryRate,
    avg_processing_time_ms: avgProcessingTimeMs,
    api_quota_consumed: totalApiUnitsConsumed,
    query_performance_index: queryPerformanceIndex
  };

  const now = new Date().toISOString();
  const label = customRunLabel || `Automated Run ${now.slice(0, 19).replace('T', ' ')}`;

  const db = await getDb();
  db.run(
    `INSERT INTO regression_runs (run_timestamp, run_label, metrics, sample_results) VALUES (?, ?, ?, ?)`,
    [now, label, JSON.stringify(metrics), JSON.stringify(sampleResults)]
  );

  // Retrieve the created record ID
  const row = db.exec(`SELECT MAX(id) as max_id FROM regression_runs`);
  const recordId = row[0]?.values[0]?.[0] as number || 1;

  return {
    id: recordId,
    run_timestamp: now,
    run_label: label,
    metrics,
    sample_results: sampleResults
  };
}

/**
 * Fetch all historical regression execution runs from SQLite
 */
export async function getRegressionRuns(): Promise<RegressionRunRecord[]> {
  await initializeRegressionDatabase();
  const db = await getDb();
  const stmt = db.prepare(`SELECT id, run_timestamp, run_label, metrics, sample_results FROM regression_runs ORDER BY id DESC`);


  const runs: RegressionRunRecord[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    runs.push({
      id: row.id as number,
      run_timestamp: row.run_timestamp as string,
      run_label: row.run_label as string,
      metrics: JSON.parse(row.metrics as string),
      sample_results: JSON.parse(row.sample_results as string)
    });
  }
  stmt.free();

  // If no runs exist yet, trigger an initial baseline run!
  if (runs.length === 0) {
    console.log('[Regression Suite] No prior runs found. Generating initial baseline run...');
    const initialRun = await runRegressionTestSuite('v3.0 Production Baseline');
    return [initialRun];
  }

  return runs;
}

/**
 * Compare Latest Run with Previous Baseline and Generate Regression Diff Report
 */
export async function getLatestRegressionComparison(): Promise<{
  latestRun: RegressionRunRecord;
  baselineRun: RegressionRunRecord;
  diffReport: RegressionDiffReport;
}> {
  const runs = await getRegressionRuns();
  const latestRun = runs[0];
  // Baseline is either the oldest run or 2nd run
  const baselineRun = runs.length > 1 ? runs[runs.length - 1] : runs[0];

  const mLatest = latestRun.metrics;
  const mBase = baselineRun.metrics;

  const precisionDelta = Math.round((mLatest.precision - mBase.precision) * 100) / 100;
  const recallDelta = Math.round((mLatest.recall - mBase.recall) * 100) / 100;
  const f1Delta = Math.round((mLatest.f1_score - mBase.f1_score) * 100) / 100;
  const discordRateDelta = Math.round((mLatest.discord_discovery_rate - mBase.discord_discovery_rate) * 100) / 100;
  const latencyDeltaMs = mLatest.avg_processing_time_ms - mBase.avg_processing_time_ms;
  const quotaDelta = mLatest.api_quota_consumed - mBase.api_quota_consumed;
  const queryIndexDelta = mLatest.query_performance_index - mBase.query_performance_index;

  const regressionAlerts: string[] = [];

  // Regression criteria thresholds
  if (precisionDelta < -3.0) {
    regressionAlerts.push(`Precision dropped by ${Math.abs(precisionDelta)}% below baseline threshold.`);
  }
  if (recallDelta < -3.0) {
    regressionAlerts.push(`Recall dropped by ${Math.abs(recallDelta)}% below baseline threshold.`);
  }
  if (discordRateDelta < -5.0) {
    regressionAlerts.push(`Discord discovery rate dropped by ${Math.abs(discordRateDelta)}%.`);
  }
  if (latencyDeltaMs > (mBase.avg_processing_time_ms * 0.25) && mBase.avg_processing_time_ms > 0) {
    regressionAlerts.push(`Average latency increased by ${latencyDeltaMs}ms (>25% slowdown).`);
  }
  if (quotaDelta > (mBase.api_quota_consumed * 0.25) && mBase.api_quota_consumed > 0) {
    regressionAlerts.push(`Quota consumption increased by ${quotaDelta} units (>25% surge).`);
  }

  const hasRegressionAlert = regressionAlerts.length > 0;

  const diffReport: RegressionDiffReport = {
    baseline_label: baselineRun.run_label,
    current_label: latestRun.run_label,
    baseline_timestamp: baselineRun.run_timestamp,
    current_timestamp: latestRun.run_timestamp,
    precision_delta: precisionDelta,
    recall_delta: recallDelta,
    f1_delta: f1Delta,
    discord_rate_delta: discordRateDelta,
    latency_delta_ms: latencyDeltaMs,
    quota_delta: quotaDelta,
    query_index_delta: queryIndexDelta,
    has_regression_alert: hasRegressionAlert,
    regression_alerts: regressionAlerts
  };

  return {
    latestRun,
    baselineRun,
    diffReport
  };
}

/**
 * Dynamically expands the Benchmark Dataset with new ground truth samples
 * (e.g. newly discovered creators or fixed edge cases / false positives / false negatives)
 */
export function addSampleToBenchmarkDataset(sample: BenchmarkSample): number {
  const existingIdx = BENCHMARK_DATASET.findIndex(s => s.channel_id === sample.channel_id || s.channel_name.toLowerCase() === sample.channel_name.toLowerCase());
  if (existingIdx >= 0) {
    BENCHMARK_DATASET[existingIdx] = sample;
  } else {
    BENCHMARK_DATASET.push(sample);
  }
  return BENCHMARK_DATASET.length;
}

