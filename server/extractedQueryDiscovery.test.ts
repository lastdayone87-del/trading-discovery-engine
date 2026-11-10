import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessExtractedQueryCandidate,
  deriveDeterministicQueryCandidates,
  assessLlmQueryCandidates,
  normalizeExtractedCandidate,
} from './extractedQueryDiscovery';
import { containsReviewedNativePhrase } from './terminologySearchability';

const video = (text: string) => [{ kind: 'VIDEO_TITLE' as const, index: 0, text }];

test('real title examples split and shorten into trading search candidates', () => {
  const weekly = deriveDeterministicQueryCandidates({
    sources: video('Weekly trade analysis - Christmas rally starts now! (Seasonality mini...)'),
    country: 'United States', language: 'en',
  });
  assert.ok(weekly.some(candidate => candidate.candidateText.toLowerCase() === 'weekly trade analysis'));
  assert.ok(weekly.every(candidate => !/christmas rally/i.test(candidate.candidateText)));

  const gold = deriveDeterministicQueryCandidates({
    sources: video('GOLD TRADE RECAP + 5% PLAN DO EXECUTE'),
    country: 'United States', language: 'en',
  });
  assert.ok(gold.some(candidate => candidate.candidateText === 'GOLD TRADE RECAP'));
  assert.ok(gold.every(candidate => !/5%|PLAN DO EXECUTE/i.test(candidate.candidateText)));

  const qqq = deriveDeterministicQueryCandidates({
    sources: video('How to Time QQQ Entries with Volume Profile + GEX'),
    country: 'United States', language: 'en',
  });
  assert.ok(qqq.some(candidate => /QQQ Entries with Volume Profile/i.test(candidate.candidateText)));
  assert.ok(qqq.every(candidate => !/^GEX$/i.test(candidate.candidateText)));

  const belgium = deriveDeterministicQueryCandidates({
    sources: video('LIVE: GRATIS Crypto & Aandelen Analyse België! | Bitcoin of Aandelen?'),
    country: 'Belgium', language: 'nl',
  });
  assert.ok(belgium.some(candidate => /Crypto Aandelen Analyse België/i.test(candidate.candidateText)));
  assert.ok(belgium.some(candidate => /Aandelen Analyse België/i.test(candidate.candidateText)));
  assert.ok(belgium.some(candidate => /Bitcoin of Aandelen/i.test(candidate.candidateText)));
  assert.ok(belgium.every(candidate => candidate.language === 'nl'));
});

test('nuisance-only titles and promo fragments are rejected before the ledger', () => {
  const clickbait = deriveDeterministicQueryCandidates({
    sources: video("Uh oh, is Crypto about to BLOW UP? (You've Been Warned)"),
    country: 'United States', language: 'en',
  });
  assert.deepEqual(clickbait, []);

  assert.equal(assessExtractedQueryCandidate({
    text: 'SUBSCRIBE LIKE BUTTON', country: 'United States', language: 'en',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: 'SUBSCRIBE LIKE BUTTON',
  }), null);
  assert.equal(assessExtractedQueryCandidate({
    text: '🔴', country: 'United States', language: 'en',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: '🔴',
  }), null);
  assert.equal(assessExtractedQueryCandidate({
    text: 'ES', country: 'United States', language: 'en',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: 'ES',
  }), null);
  const shortReasons: string[] = [];
  deriveDeterministicQueryCandidates({
    sources: video('ES'), country: 'United States', language: 'en',
    onRejected: candidate => shortReasons.push(...candidate.reasons),
  });
  assert.ok(shortReasons.includes('NO_QUERY_WINDOW'));
  // Genuine finance phrases and numeric levels are not promotional noise.
  assert.ok(assessExtractedQueryCandidate({
    text: 'risk free rate strategy', country: 'United States', language: 'en',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: 'risk free rate strategy',
  }));
  assert.ok(assessExtractedQueryCandidate({
    text: '1.5 extension trading strategy', country: 'United States', language: 'en',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: '1.5 extension trading strategy',
  }));
  assert.ok(assessExtractedQueryCandidate({
    text: 'short selling strategy', country: 'United States', language: 'en',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: 'short selling strategy',
  }));
  assert.equal(assessExtractedQueryCandidate({
    text: 'Follow for trading signals', country: 'United States', language: 'en',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: 'Follow for trading signals',
  }), null);
  assert.equal(assessExtractedQueryCandidate({
    text: 'Reel DAX trading analysis', country: 'Germany', language: 'de',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: 'Reel DAX trading analysis',
  }), null);
  assert.equal(assessExtractedQueryCandidate({
    text: 'DAX Analyse 12/05', country: 'Germany', language: 'de',
    sourceKind: 'VIDEO_TITLE', sourceIndex: 0, sourceTitle: 'DAX Analyse 12/05',
  }), null);
});

test('ambiguous single words do not turn everyday titles into searches', () => {
  for (const title of ['Day in the Life', 'Movie Review Tonight', 'Customer Support Tips']) {
    const rejected: string[] = [];
    const accepted = deriveDeterministicQueryCandidates({
      sources: video(title), country: 'United States', language: 'en',
      onRejected: candidate => rejected.push(...candidate.reasons),
    });
    assert.deepEqual(accepted, [], title);
    assert.ok(rejected.includes('NO_TRADING_INTENT'), `${title}: ${rejected.join(',')}`);
  }
  const useful = deriveDeterministicQueryCandidates({
    sources: video('Volume Profile and Price Action'),
    country: 'United States', language: 'en',
  });
  assert.ok(useful.some(candidate => /Volume Profile/i.test(candidate.candidateText)));
});

test('LLM grounding uses word boundaries, not substrings inside other words', () => {
  const reasons: string[] = [];
  const accepted = assessLlmQueryCandidates({
    queries: ['order flow'],
    sources: video('disorder flow trading setup'),
    country: 'United States', language: 'en',
    onRejected: candidate => reasons.push(...candidate.reasons),
  });
  assert.deepEqual(accepted, []);
  assert.ok(reasons.includes('NOT_LITERAL_SOURCE'));
});

test('emoji and hashtag-only sources leave a nuisance audit row', () => {
  const rejected = [] as Array<{ candidateText: string; reasons: string[]; candidateKey: string }>;
  const accepted = deriveDeterministicQueryCandidates({
    sources: video('🔴 #trading'),
    country: 'United States', language: 'en',
    onRejected: candidate => rejected.push(candidate),
  });
  assert.deepEqual(accepted, []);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].candidateKey.startsWith('nuisance:'));
  assert.deepEqual(rejected[0].reasons, ['NO_TEXT']);
});

test('native-language unspaced candidates and playlist context are supported', () => {
  const japanese = deriveDeterministicQueryCandidates({
    sources: video('日足と4時間足が逆向きなら見送る|ETHの見方'),
    country: 'Japan', language: 'ja',
  });
  assert.ok(japanese.some(candidate => candidate.candidateText.includes('ETHの見方')));

  const playlist = deriveDeterministicQueryCandidates({
    sources: [
      { kind: 'PLAYLIST_TITLE', index: 0, text: 'Live FOREX TRADING LESSONS' },
      { kind: 'PLAYLIST_DESCRIPTION', index: 0, text: 'A complete price action trading course.' },
    ],
    country: 'United Kingdom', language: 'en',
  });
  assert.ok(playlist.some(candidate => /FOREX TRADING LESSONS/i.test(candidate.candidateText)));
});


test('genuine terminology such as Footprint Trading DAX survives extraction', () => {
  const candidates = deriveDeterministicQueryCandidates({
    sources: video('Footprint Trading DAX: Orderflow setup for the open'),
    country: 'Germany', language: 'de',
  });
  assert.ok(candidates.some(candidate => /Footprint Trading DAX/i.test(candidate.candidateText)));
  const france = deriveDeterministicQueryCandidates({
    sources: video('STRATEGIE DE TRADING SUR LE NASDAQ'),
    country: 'France', language: 'fr',
  });
  assert.ok(france.some(candidate => /STRATEGIE DE TRADING/i.test(candidate.candidateText)));
  const spain = deriveDeterministicQueryCandidates({
    sources: video('ESTRATEGIA DE TRADING EN EL IBEX 35'),
    country: 'Spain', language: 'es',
  });
  assert.ok(spain.some(candidate => /ESTRATEGIA DE TRADING/i.test(candidate.candidateText)));
});

test('rejected candidates carry stable reasons for the LCB', () => {
  const rejected: string[] = [];
  const accepted = deriveDeterministicQueryCandidates({
    sources: video('GOLD TRADE RECAP + 5% PLAN DO EXECUTE'),
    country: 'United States', language: 'en',
    onRejected: candidate => rejected.push(...candidate.reasons),
  });
  assert.ok(accepted.length > 0);
  assert.ok(rejected.length > 0);
  assert.ok(rejected.every(reason => /^[A-Z0-9_]+$/.test(reason)), rejected.join(','));

  const clickbaitRejected: string[] = [];
  deriveDeterministicQueryCandidates({
    sources: video("Uh oh, is Crypto about to BLOW UP? (You've Been Warned)"),
    country: 'United States', language: 'en',
    onRejected: candidate => clickbaitRejected.push(...candidate.reasons),
  });
  assert.ok(clickbaitRejected.includes('CLICKBAIT'));

  const llmRejected: string[] = [];
  assessLlmQueryCandidates({
    queries: ['Subscribe and like', 'Weekly trade analysis'],
    sources: video('Weekly trade analysis and market outlook'),
    country: 'United States', language: 'en',
    onRejected: candidate => llmRejected.push(...candidate.reasons),
  });
  assert.ok(llmRejected.includes('PROMO'));
});

test('non-Latin native scripts pass intent and preserve their script', () => {
  const tamil = deriveDeterministicQueryCandidates({
    sources: video('தங்கம் விலை பகுப்பாய்வு'),
    country: 'Singapore', language: 'ta',
  });
  assert.ok(tamil.length > 0);
  assert.ok(tamil.every(candidate => candidate.language === 'ta' && candidate.script === 'Taml'));

  const chinese = deriveDeterministicQueryCandidates({
    sources: video('比特币交易策略入门 | 新加坡股市分析'),
    country: 'Singapore', language: 'zh',
  });
  assert.ok(chinese.some(candidate => candidate.candidateText === '比特币交易策略入门'));
  assert.ok(chinese.every(candidate => candidate.language === 'zh' && candidate.script === 'Hani'));

  const shortJapanese = deriveDeterministicQueryCandidates({
    sources: video('板読み'),
    country: 'Japan', language: 'ja',
  });
  assert.ok(shortJapanese.some(candidate => candidate.candidateText === '板読み'));

  const kanjiOnly = deriveDeterministicQueryCandidates({
    sources: video('日経225先物'),
    country: 'Japan', language: 'ja',
  });
  assert.ok(kanjiOnly.some(candidate => candidate.candidateText === '日経225先物'));
  const orderBook = deriveDeterministicQueryCandidates({
    sources: video('板情報'),
    country: 'Japan', language: 'ja',
  });
  assert.ok(orderBook.some(candidate => candidate.candidateText === '板情報'));
  const mixedTrading = deriveDeterministicQueryCandidates({
    sources: video('TRADINGの見方'),
    country: 'Japan', language: 'ja',
  });
  assert.ok(mixedTrading.some(candidate => candidate.candidateText === 'TRADINGの見方'));
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('Silverstone race day'),
      country: 'United Kingdom', language: 'en',
    }),
    [],
  );
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('Cryptography course'),
      country: 'United Kingdom', language: 'en',
    }),
    [],
  );
  const dax40 = deriveDeterministicQueryCandidates({
    sources: video('DAX40 Analyse'),
    country: 'Germany', language: 'de',
  });
  assert.ok(dax40.some(candidate => candidate.candidateText === 'DAX40 Analyse'));
  const nasdaq100 = deriveDeterministicQueryCandidates({
    sources: video('NASDAQ100 Analyse'),
    country: 'United States', language: 'en',
  });
  assert.ok(nasdaq100.some(candidate => candidate.candidateText === 'NASDAQ100 Analyse'));
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('Delta2024 Airlines'),
      country: 'United States', language: 'en',
    }),
    [],
  );
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('Apex Legends gameplay'),
      country: 'United States', language: 'en',
    }),
    [],
  );
  const dutch = deriveDeterministicQueryCandidates({
    sources: video('opties handelen'),
    country: 'Netherlands', language: 'nl',
  });
  assert.ok(dutch.some(candidate => candidate.candidateText === 'opties handelen'));
  assert.equal(containsReviewedNativePhrase('opties handelen'), true);
  assert.equal(containsReviewedNativePhrase('opties handelenx'), false);
  for (const title of ['高配当株', '株主優待']) {
    assert.ok(
      deriveDeterministicQueryCandidates({
        sources: video(title), country: 'Japan', language: 'ja',
      }).some(candidate => candidate.candidateText === title),
      title,
    );
  }

  const offTopic = deriveDeterministicQueryCandidates({
    sources: video('木板安装教程'),
    country: 'Singapore', language: 'zh',
  });
  assert.deepEqual(offTopic, []);
  for (const title of ['老板的日常', '株式会社の日常', '人生戦略', '注文の多い料理店']) {
    assert.deepEqual(
      deriveDeterministicQueryCandidates({
        sources: video(title), country: 'Japan', language: 'ja',
      }),
      [],
      title,
    );
  }
});

test('ordinary Japanese phrases are rejected while trading terminology remains eligible', () => {
  for (const title of ['投資詐欺', '株主総会', '金利が上がる', '相場がいい', '今日の天気', '株式会社の日常']) {
    assert.deepEqual(
      deriveDeterministicQueryCandidates({
        sources: video(title), country: 'Japan', language: 'ja',
      }),
      [],
      title,
    );
  }
  for (const title of ['車のオプション', 'オプション設定']) {
    assert.deepEqual(
      deriveDeterministicQueryCandidates({
        sources: video(title), country: 'Japan', language: 'ja',
      }),
      [],
      title,
    );
  }
  for (const title of ['日経225先物', '板情報', '高配当株', 'ビットコイン投資', 'オプション取引', 'デイトレード', 'テクニカル分析', '金利見通し', '相場分析']) {
    assert.ok(
      deriveDeterministicQueryCandidates({
        sources: video(title), country: 'Japan', language: 'ja',
      }).some(candidate => candidate.candidateText === title),
      title,
    );
  }
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('금요일'), country: 'South Korea', language: 'ko',
    }),
    [],
  );
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('주식회사'), country: 'South Korea', language: 'ko',
    }),
    [],
  );
  assert.ok(
    deriveDeterministicQueryCandidates({
      sources: video('금값'), country: 'South Korea', language: 'ko',
    }).some(candidate => candidate.candidateText === '금값'),
  );
  assert.ok(
    deriveDeterministicQueryCandidates({
      sources: video('주식 시장'), country: 'South Korea', language: 'ko',
    }).some(candidate => candidate.candidateText === '주식 시장'),
  );
  assert.ok(
    deriveDeterministicQueryCandidates({
      sources: video('أسعار الذهب'), country: 'United Arab Emirates', language: 'ar',
    }).some(candidate => candidate.candidateText === 'أسعار الذهب'),
  );
  assert.ok(
    deriveDeterministicQueryCandidates({
      sources: video('للتداول اليوم'), country: 'United Arab Emirates', language: 'ar',
    }).some(candidate => candidate.candidateText === 'للتداول اليوم'),
  );
  assert.ok(
    deriveDeterministicQueryCandidates({
      sources: video('تداولات اليوم'), country: 'United Arab Emirates', language: 'ar',
    }).some(candidate => candidate.candidateText === 'تداولات اليوم'),
  );
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('التسوق في دبي'), country: 'United Arab Emirates', language: 'ar',
    }),
    [],
  );
  assert.deepEqual(
    deriveDeterministicQueryCandidates({
      sources: video('ذهبنا إلى دبي'), country: 'United Arab Emirates', language: 'ar',
    }),
    [],
  );
  for (const title of ['주식거래', '주식시장']) {
    assert.ok(
      deriveDeterministicQueryCandidates({
        sources: video(title), country: 'South Korea', language: 'ko',
      }).some(candidate => candidate.candidateText === title),
      title,
    );
  }
  assert.ok(
    deriveDeterministicQueryCandidates({
      sources: video('சந்தையில் வர்த்தகம்'), country: 'Singapore', language: 'ta',
    }).some(candidate => candidate.candidateText === 'சந்தையில் வர்த்தகம்'),
  );
});

test('trailing prepositions are trimmed without discarding the trading phrase', () => {
  const german = deriveDeterministicQueryCandidates({
    sources: video('Technische Analyse für'),
    country: 'Germany', language: 'de',
  });
  assert.ok(german.some(candidate => candidate.candidateText === 'Technische Analyse'));
  assert.ok(german.every(candidate => !/\bfür$/iu.test(candidate.candidateText)));

  const middle = deriveDeterministicQueryCandidates({
    sources: video('Orderflow für DAX'),
    country: 'Germany', language: 'de',
  });
  assert.ok(middle.some(candidate => candidate.candidateText === 'Orderflow für DAX'));

  assert.ok(
    deriveDeterministicQueryCandidates({
      sources: video('Footprint Trading DAX'),
      country: 'Germany', language: 'de',
    }).some(candidate => candidate.candidateText === 'Footprint Trading DAX'),
  );
});

test('LLM candidates use the same deterministic gate and duplicates merge', () => {
  const sources = video('Weekly trade analysis');
  const reasons: string[] = [];
  const llm = assessLlmQueryCandidates({
    queries: ['Weekly trade analysis', 'Subscribe and like', '🔴', 'Dealer gamma roadmap'],
    sources,
    country: 'United States',
    language: 'en',
    onRejected: candidate => reasons.push(...candidate.reasons),
  });
  assert.equal(llm.length, 1);
  assert.equal(llm[0].candidateText, 'Weekly trade analysis');
  assert.ok(reasons.includes('NOT_LITERAL_SOURCE'), reasons.join(','));
  const deterministic = deriveDeterministicQueryCandidates({ sources, country: 'United States', language: 'en' });
  assert.ok(deterministic.some(candidate => candidate.candidateKey === llm[0].candidateKey));
  assert.equal(normalizeExtractedCandidate('  Weekly   trade analysis!  '), 'Weekly trade analysis');
  assert.equal(normalizeExtractedCandidate('🔴 Gold 🔥 Trading Analysis'), 'Gold Trading Analysis');
});
