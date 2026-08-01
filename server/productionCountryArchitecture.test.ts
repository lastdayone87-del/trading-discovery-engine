import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionCountryArchitecture } from './productionCountryArchitecture';
import { getLayeredKnowledgeContext } from './evidenceEngine/knowledgePacks';
import { MultilingualContextProvider } from './evidenceEngine/providers/MultilingualContextProvider';

test('production startup invariant proves every country is registered end to end', () => {
  assert.doesNotThrow(assertProductionCountryArchitecture);
});

test('multilingual countries evaluate every configured deterministic language pack', async () => {
  const provider = new MultilingualContextProvider();
  const fixtures = [
    ['Switzerland', 'Formation trading avec gestion du risque et point d’entrée'],
    ['Belgium', 'Trading lernen mit Positionsgröße und Risiko pro Trade'],
    ['Singapore', '股票交易需要风险管理和止损'],
    ['United Arab Emirates', 'خطة التداول تشمل إدارة المخاطر ووقف الخسارة']
  ] as const;
  for (const [country, description] of fixtures) {
    const context = getLayeredKnowledgeContext(country);
    const evidence = await provider.collectEvidence({ channel_name: country, description }, context);
    assert.ok(evidence.some(item => item.polarity === 'POSITIVE'), `${country} multilingual evidence`);
  }
});
