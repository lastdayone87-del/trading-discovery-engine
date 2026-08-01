import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceBasedTradingEngine } from './index';
import type { RawChannelInput } from './types';
import { ChannelMetadataProvider } from './providers/ChannelMetadataProvider';
import { VideoMetadataProvider } from './providers/VideoMetadataProvider';
import { CountryKnowledgeProvider } from './providers/CountryKnowledgeProvider';
import { ExternalLinkProvider } from './providers/ExternalLinkProvider';
import { MultilingualContextProvider } from './providers/MultilingualContextProvider';
import { getLayeredKnowledgeContext } from './knowledgePacks';
import { SUPPORTED_CLASSIFICATION_COUNTRIES } from './multilingualTerminology';

const engine = new EvidenceBasedTradingEngine([
  new ChannelMetadataProvider(),
  new VideoMetadataProvider(),
  new CountryKnowledgeProvider(),
  new ExternalLinkProvider(),
  new MultilingualContextProvider()
]);

const educatorCases: Array<{ language: string; country: string; description: string; titles: string[] }> = [
  { language: 'English (US)', country: 'United States', description: 'Step by step trading lessons with position sizing, risk per trade and order flow.', titles: ['NQ trade setup and stop loss review', 'Backtesting a market structure strategy'] },
  { language: 'English (UK)', country: 'United Kingdom', description: 'Trading education covering risk per trade and London session execution.', titles: ['FTSE trade setup and position sizing', 'GBPUSD strategy breakdown'] },
  { language: 'English (Australia)', country: 'Australia', description: 'Educational ASX and futures channel teaching position sizing and trade review.', titles: ['ASX 200 trade setup', 'AUDUSD risk management lesson'] },
  { language: 'English (Canada)', country: 'Canada', description: 'Canadian market educator documenting entries, stop loss and trading journal reviews.', titles: ['TSX trade setup review', 'USDCAD position sizing lesson'] },
  { language: 'German', country: 'Germany', description: 'Trading lernen mit Markttechnik, Positionsgröße und Risiko pro Trade.', titles: ['DAX Trade Analyse und Stop Loss', 'Strategie Backtest mit Chartanalyse'] },
  { language: 'French', country: 'France', description: 'Formation trading avec gestion du risque et journal de trading.', titles: ['Plan de trading CAC40', "Carnet d'ordres et point d’entrée"] },
  { language: 'Spanish', country: 'Spain', description: 'Curso de trading con gestión de riesgo y diario de trading.', titles: ['Plan de trading IBEX 35', 'Análisis de operaciones y punto de entrada'] },
  { language: 'Italian', country: 'Italy', description: 'Corso di trading con gestione del rischio e diario di trading.', titles: ['Piano di trading FTSE MIB', 'Analisi delle operazioni e punto di ingresso'] },
  { language: 'Dutch', country: 'Netherlands', description: 'Leren traden met risicomanagement en een tradingdagboek.', titles: ['AEX handelsplan en instappunt', 'Technische analyse van het orderboek'] },
  { language: 'Japanese', country: 'Japan', description: '資金管理と損切りを重視するトレード講座。', titles: ['日経225 エントリーポイントとトレード日誌', '板読みとテクニカル分析の手法解説'] }
];

for (const example of educatorCases) {
  test(`confirms authentic ${example.language} trading education`, async () => {
    const decision = await engine.evaluateChannel({ channel_name: `${example.country} trading educator`, description: example.description, video_titles: example.titles, country: example.country });
    assert.equal(decision.status, 'TRADING_CONFIRMED');
    assert.ok(decision.positiveEvidence.some(item => item.source === 'multilingual_context'));
    assert.ok(decision.mathematicalJustification.includes('DECISION: VERIFIED_TRADING'));
  });
}

test('classifies a locally verified real German YouTube channel with traceable evidence', async () => {
  // Captured from the checked-in YouTube About page (about_channel.html), including
  // its real channel ID, canonical URL, official country, description, and upload title.
  const input: RawChannelInput = {
    channel_id: 'UCYTE8Y6z35_AfaeJLIz2LQA',
    channel_name: 'Trading Strategie Analyse',
    description: 'Ich teste Trading Strategien 100x ehrlich & transparent. Danach optimieren wir die Strategien auf Basis harter Daten. Strategien für Forex, Krypto oder Aktien. Die Informationen dienen ausschließlich zu Bildungszwecken.',
    video_titles: ['Trading Challenge: AAPL 15min - Kaufen oder Verkaufen?', 'Trading Challenge: USOIL 4h - Kaufen oder Verkaufen?'],
    country: 'Germany',
    location_tag: 'Germany',
    external_links: ['https://analyse.trading/impressum'],
  };
  const decision = await engine.evaluateChannel(input);
  assert.equal(decision.status, 'TRADING_CONFIRMED');
  assert.equal(input.channel_id, 'UCYTE8Y6z35_AfaeJLIz2LQA');
  assert.equal(`https://www.youtube.com/channel/${input.channel_id}`, 'https://www.youtube.com/channel/UCYTE8Y6z35_AfaeJLIz2LQA');
  assert.ok(decision.positiveEvidence.length > 0);
});

const adjacentCases = [
  { label: 'general finance', description: 'Personal finance, saving money, passive income and retirement planning.', titles: ['My long term dividend portfolio'] },
  { label: 'business news', description: 'Daily business news and company earnings news.', titles: ['Economic headlines and market news bulletin'] },
  { label: 'crypto hype', description: 'The next Bitcoin crypto gem with guaranteed profit.', titles: ['This 100x crypto moonshot will make you rich'] },
  { label: 'motivation', description: 'Millionaire mindset and financial freedom motivation.', titles: ['Success motivation for the ultimate hustle mindset'] }
];

for (const example of adjacentCases) {
  test(`does not confirm English ${example.label} content as trading education`, async () => {
    const decision = await engine.evaluateChannel({ channel_name: 'Finance Media', description: example.description, video_titles: example.titles, country: 'United States' });
    assert.notEqual(decision.status, 'TRADING_CONFIRMED');
    assert.ok(decision.negativeEvidence.some(item => item.source === 'multilingual_context'));
  });
}

test('classification knowledge covers every production country', () => {
  assert.deepEqual([...SUPPORTED_CLASSIFICATION_COUNTRIES], ['United States', 'United Kingdom', 'Germany', 'France', 'Spain', 'Netherlands', 'Italy', 'Australia', 'Canada', 'Japan', 'Switzerland', 'Denmark', 'Sweden', 'United Arab Emirates', 'Singapore', 'New Zealand', 'Belgium', 'Luxembourg', 'Ireland']);
  assert.equal(getLayeredKnowledgeContext('Brazil').countryKnowledge, undefined);
  assert.equal(getLayeredKnowledgeContext('India').countryKnowledge, undefined);
});
