# Semantic Calibration: Ambiguous-Cohort Manual Inspection Dossier

> Status: EVIDENCE ONLY. These results are NOT sufficient to approve a production provider switch.
> No production code, routing, config, or database state was changed to produce this report.

## Methodology

- Cohort: 37 unique channels with UNCERTAIN trading status and >=50-char bios, no human review decision on record (34 discord UNCERTAIN, 3 NOT_FOUND, 0 ACTIVE).
- Prompts: production-exact — built by running the repo provider with a capturing client, so both candidates received byte-identical prompts to production Gemini traffic (temperature 0, JSON mode, CANDIDATE tier; adjudication tier dormant under default config).
- Candidates: openai/gpt-oss-120b and qwen/qwen3.6-27b via Groq, response_format json_object, max 800 output tokens, reasoning minimized. 40/40 valid JSON each, 0 transport errors in the re-run pass.
- Ground truth: NONE in-cohort (0 human decisions; historical Gemini semantic evidence present for only 7/37, 0 abstentions — the provider is mostly absent, not abstaining). Discord state is the only independent signal and cannot confirm trading focus.
- Key finding up front: verdict agreement 36/37 trading-positive with 1 disagreement; median confidence >90 with no confirmatory evidence of any kind. The single shared abstention from the earlier pass proved non-deterministic on re-run (oss flipped AMBIGUOUS 60 -> INVESTING_EDUCATION 65 at temperature 0).

## Limitations and missing ground truth

1. No human labels in-cohort: precision/recall/abstention metrics are unmeasurable here.
2. Discord absence does not imply non-trading (3 NOT_FOUND channels classified trading-positive by both models at 85-95 confidence — weak counter-signal only).
3. Incumbent comparison permanently thin (28 extractable labels across the full 120, UNRELATED-skewed).
4. Nondeterminism observed at temperature 0 — repeated runs can flip edge cases.

---
## 1. Both models classify as trading (36 channels)
### UC-AvjBlw3ONbGymujqg2agg
Channel: J-Trader [UC-AvjBlw3ONbGymujqg2agg] | country: Brazil
youtube: https://www.youtube.com/channel/UC-AvjBlw3ONbGymujqg2agg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Forex, Day trade, Forex ao vivo, compra e venda de índices, operações reais de Forex, EURUSD, GBPUSD, NZDUSD, USDCAD, USDCHF, USDJPY, GOLD, US30, GER30, HK50, etc...

Qualquer  informação neste vídeo não é um conselho de investimento, 
cada operação é de responsabilidade única e exclusiva do investidor.
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=11108 tokens=394/324
  reasonCodes=["RC_LANG_DETECTED", "RC_CONTENT_TRADING"] concepts=["Forex", "Day Trading", "Currency Pairs", "Indices", "Gold"] languages=["pt"]
  explanation: The channel focuses on live Forex and day‑trade operations, listing currency pairs, indices and commodities. The bio explicitly states that the content is not investment advice and that each trade is the investor's responsibility, which matches the definition of active trading content.
  citations: [{"field": "channel_title", "text": "J-Trader"}, {"field": "channel_bio", "text": "Forex, Day trade, Forex ao vivo, compra e venda de \u00edndices, opera\u00e7\u00f5es reais de Forex, EURUSD, GBPUSD, NZDUSD, USDCAD, USDCHF, USDJPY, GOLD, US30, GER30, HK50, etc..."}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2189 tokens=317/252
  reasonCodes=["channel_title", "channel_bio"] concepts=["Day Trading", "Forex", "Live Trading", "Currency Pairs", "Indices"] languages=["pt-BR"]
  explanation: The channel title 'J-Trader' and the bio explicitly mention 'Day trade', 'Forex ao vivo' (Live Forex), and 'operações reais' (real operations) involving specific currency pairs and indices. This indicates a focus on active trading activities rather than general education or news.
  citations: [{"field": "channel_title", "text": "J-Trader"}, {"field": "channel_bio", "text": "Forex, Day trade, Forex ao vivo, compra e venda de \u00edndices, opera\u00e7\u00f5es reais de Forex"}]

### UC-QaySvHBNyHpcetvl9blZg
Channel: Matrix-Gufran [UC-QaySvHBNyHpcetvl9blZg] | country: None
youtube: https://www.youtube.com/channel/UC-QaySvHBNyHpcetvl9blZg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Subscribe to trade smarter.
Trading SMC and institutional liquidity.

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=92 supportedLanguage=True latencyMs=2583 tokens=327/277
  reasonCodes=["KEYWORDS_TRADING", "FOCUS_TRADE"] concepts=["trading", "SMC", "institutional liquidity"] languages=["en"]
  explanation: The channel bio explicitly encourages viewers to "trade smarter" and mentions "Trading SMC and institutional liquidity," indicating a primary focus on active trading activities rather than education, news, or personal finance.
  citations: [{"field": "channel_title", "text": "Matrix-Gufran"}, {"field": "channel_bio", "text": "Subscribe to trade smarter.\nTrading SMC and institutional liquidity.\n"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=8385 tokens=244/250
  reasonCodes=["channel_title", "channel_bio"] concepts=["SMC", "institutional liquidity", "trading education"] languages=["en"]
  explanation: The channel title 'Matrix-Gufran' combined with the bio 'Subscribe to trade smarter' and 'Trading SMC and institutional liquidity' indicates a focus on teaching specific trading methodologies (Smart Money Concepts) rather than providing real-time news or personal finance advice. The imperative 'trade smarter' suggests an educational intent aimed at improving the viewer's trading skills.
  citations: [{"field": "channel_title", "text": "Matrix-Gufran"}, {"field": "channel_bio", "text": "Subscribe to trade smarter.\nTrading SMC and institutional liquidity.\n"}]

### UC0TazU_QrHENAodJWSJNj5A
Channel: Wesley Emeraldgate [UC0TazU_QrHENAodJWSJNj5A] | country: United States
youtube: https://www.youtube.com/channel/UC0TazU_QrHENAodJWSJNj5A
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Run.  Eat..  TRADE...  Repeat....

*Futures trading involves significant risk and may not be suitable for all investors. You could lose more than your initial investment. All content from Wesley Emeraldgate is for educational and entertainment purposes and not financial advice.*

*The Links below are affiliate links, meaning if you make a purchase: i benefit financially.

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=3348 tokens=395/257
  reasonCodes=["KEYWORDS", "DISCLAIMER", "CONTENT_FOCUS"] concepts=["Futures Trading", "Risk Disclosure", "Affiliate Links"] languages=["en"]
  explanation: The channel title is a personal name and the bio emphasizes futures trading, risk warnings, and educational/entertainment purpose, indicating a focus on teaching about trading rather than personal active trading or news.
  citations: ["channel_title", "channel_bio"]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2009 tokens=311/259
  reasonCodes=["EXPLICIT_TRADING_FOCUS", "EDUCATIONAL_DISCLAIMER_PRESENT"] concepts=["Futures Trading", "Active Trading", "Risk Disclosure", "Affiliate Marketing"] languages=["en"]
  explanation: The channel bio explicitly states 'TRADE' as a core activity and includes a specific disclaimer regarding 'Futures trading' risks. While it mentions educational purposes, the primary focus indicated by the tagline and the specific asset class mentioned (futures) aligns with active trading content rather than general investing education or personal finance.
  citations: [{"field": "channel_bio", "quote": "Run. Eat.. TRADE... Repeat...."}, {"field": "channel_bio", "quote": "Futures trading involves significant risk and may not be suitable for all investors."}]

### UC1g5UkVWxEvzp9FvUSRqT5w
Channel: 1n5ight Trading [UC1g5UkVWxEvzp9FvUSRqT5w] | country: None
youtube: https://www.youtube.com/channel/UC1g5UkVWxEvzp9FvUSRqT5w
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=COMPLETED
bio: I trade the ES Live 3 times a week - am still learning to trade but follow along my progress! 
gemini_history: [{"at": "2026-09-06T15:28:11.157Z", "label": "ACTIVE_TRADING", "conf": 84, "codes": ["DAY_TRADING_FOCUS", "FUTURES_TRADING", "LIVE_TRADING_SESSIONS"], "model": "gemini-3.6-flash"}]
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=1726 tokens=336/258
  reasonCodes=["RC1"] concepts=["trading", "E-mini S&P", "live trading", "progress tracking"] languages=["en"]
  explanation: The channel title and bio describe the creator actively trading the E-mini S&P (ES) live multiple times per week and inviting viewers to follow their progress, which aligns with the ACTIVE_TRADING taxonomy.
  citations: [{"field": "channel_title", "text": "1n5ight Trading"}, {"field": "channel_bio", "text": "I trade the ES Live 3 times a week - am still learning to trade but follow along my progress!"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=6866 tokens=253/283
  reasonCodes=["EXPLICIT_TRADING_ACTIVITY", "LIVE_TRADING_MENTION", "SPECIFIC_ASSET_CLASS"] concepts=["Active Trading", "Futures Trading", "ES Futures", "Live Trading"] languages=["en"]
  explanation: The channel title '1n5ight Trading' and the bio explicitly state 'I trade the ES Live 3 times a week'. The mention of trading 'ES' (E-mini S&P 500 futures) live indicates active participation in financial markets rather than just education or news. Although the creator mentions 'still learning', the primary focus is on the act of trading itself.
  citations: [{"field": "channel_title", "text": "1n5ight Trading"}, {"field": "channel_bio", "text": "I trade the ES Live 3 times a week - am still learning to trade but follow along my progress!"}]

### UC59cnQrM0sDTqxa49NiP2hQ
Channel: EnvxyTrades [UC59cnQrM0sDTqxa49NiP2hQ] | country: Canada
youtube: https://www.youtube.com/channel/UC59cnQrM0sDTqxa49NiP2hQ
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: I work with ICT concepts every day and trade PO3 setups
focusing on consistency and smart execution

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=92 supportedLanguage=True latencyMs=2127 tokens=333/299
  reasonCodes=["KEYWORDS", "CONTENT_ANALYSIS"] concepts=["ICT concepts", "PO3 setups", "consistency", "smart execution"] languages=["en"]
  explanation: The channel title and bio reference daily work with ICT concepts and trading PO3 setups, emphasizing consistency and smart execution, which indicates the creator is actively engaged in trading activities.
  citations: [{"ref": {"field": "channel_title"}, "text": "EnvxyTrades"}, {"ref": {"field": "channel_bio"}, "text": "I work with ICT concepts every day and trade PO3 setups focusing on consistency and smart execution"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=2172 tokens=251/264
  reasonCodes=["MENTION_OF_TRADING_CONCEPTS", "FOCUS_ON_EXECUTION_AND_CONSISTENCY", "EDUCATIONAL_TONE"] concepts=["ICT concepts", "PO3 setups", "Trading consistency", "Smart execution"] languages=["en"]
  explanation: The channel bio explicitly mentions working with 'ICT concepts' (Inner Circle Trader, a well-known trading education methodology) and 'PO3 setups' (a specific technical analysis pattern). The focus on 'consistency' and 'smart execution' suggests an educational or mentorship approach to trading rather than just reporting news or personal finance advice. The content is centered on teaching or sharing specific trading strategies.
  citations: [{"field": "channel_bio", "text": "I work with ICT concepts every day and trade PO3 setups focusing on consistency and smart execution"}]

### UC7pWncc0Xbmx9zOQQ7S8haw
Channel: It's Trading Star [UC7pWncc0Xbmx9zOQQ7S8haw] | country: Germany
youtube: https://www.youtube.com/channel/UC7pWncc0Xbmx9zOQQ7S8haw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Futures prop trading tutorials — platform setups, 
evaluation tips and funded account guides.

Get a Lucid account (40% off) → lucidtrading.com/ref/ITS
Code: ITS

Get Tradecopia (30% off) → tradecopia.com/signup?via=ITS  
Code: ITS

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2108 tokens=382/299
  reasonCodes=["LANG_EN", "CONTENT_ACTIVE_TRADING"] concepts=["prop trading", "futures", "platform setup", "funded accounts", "evaluation tips"] languages=["en"]
  explanation: The channel title and bio describe futures prop trading tutorials, platform setups, evaluation tips, and funded account guides, which are directly related to active trading activities.
  citations: [{"ref": {"field": "channel_title"}, "text": "It's Trading Star"}, {"ref": {"field": "channel_bio"}, "text": "Futures prop trading tutorials \u2014 platform setups, evaluation tips and funded account guides."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1483 tokens=303/256
  reasonCodes=["channel_bio_contains_tutorials", "channel_bio_contains_guides", "channel_title_indicates_trading_focus"] concepts=["prop trading", "futures", "tutorials", "platform setups", "funded accounts"] languages=["en"]
  explanation: The channel bio explicitly states 'Futures prop trading tutorials' and 'funded account guides,' which clearly indicates an educational focus on teaching trading strategies and platform usage. While it contains affiliate links, the primary content described is instructional.
  citations: [{"field": "channel_title", "text": "It's Trading Star"}, {"field": "channel_bio", "text": "Futures prop trading tutorials \u2014 platform setups, \nevaluation tips and funded account guides."}]

### UC9I-Bp8IkupKSN_jW2l0FDg
Channel: ASAP FX [UC9I-Bp8IkupKSN_jW2l0FDg] | country: None
youtube: https://www.youtube.com/channel/UC9I-Bp8IkupKSN_jW2l0FDg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: 
Educative videos and strategies on how to trade Forex, Synthetic indices, and Crypto like a pro.

Telegram: @asapchapter

Join our telegram community 
Telegram ……..   https://t.me/+-x3s8jARIYg3MGI0


gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=85 supportedLanguage=True latencyMs=9233 tokens=374/316
  reasonCodes=["R1", "R3"] concepts=["Forex", "Synthetic indices", "Cryptocurrency", "Trading strategies"] languages=["en"]
  explanation: The channel explicitly offers educative videos and strategies for trading Forex, synthetic indices, and crypto, indicating a focus on active trading rather than purely educational content.
  citations: [{"ref": {"field": "channel_title"}, "text": "ASAP FX"}, {"ref": {"field": "channel_bio"}, "text": "Educative videos and strategies on how to trade Forex, Synthetic indices, and Crypto like a pro."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1883 tokens=291/256
  reasonCodes=["EXPLICIT_EDUCATIONAL_CLAIM", "STRATEGY_FOCUS", "COMMUNITY_BUILDING"] concepts=["Forex Trading", "Synthetic Indices", "Cryptocurrency Trading", "Trading Strategies", "Financial Education"] languages=["en"]
  explanation: The channel bio explicitly states that it provides 'Educative videos and strategies' on trading Forex, Synthetic indices, and Crypto. The phrase 'like a pro' suggests a focus on skill acquisition and educational content rather than just news reporting or active trade signals. The inclusion of a Telegram community link further supports the model of an educational or mentorship-based channel.
  citations: [{"field": "channel_bio", "text": "Educative videos and strategies on how to trade Forex, Synthetic indices, and Crypto like a pro."}]

### UC9glknREHQbaxs2XDFPTmtw
Channel: Genius Trading Masterclass - Raphael Palmdale [UC9glknREHQbaxs2XDFPTmtw] | country: Germany
youtube: https://www.youtube.com/channel/UC9glknREHQbaxs2XDFPTmtw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Herzlich willkommen auf meinem Kanal! Ich bin Raphael, Gründer und das Brain hinter der Genius Trading Masterclass und der GTFX Optimizer AI Hedging Engine.

Seit meinem 16. Lebensjahr (über 14 Jahre Börsenerfahrung!) habe ich manuell getradet und seit 2019 weltweit Tradern geholfen, profitabel zu werden. Jetzt setze ich mein Know‑how in einem vollautomatisierten System um – mit spektakulären Ergebnissen!

Dein nächster Schritt:
👉 Schau auf unserer Webseite vorbei: [www.gtfx-optimizer.ai]
👉 Melde dich für deine kostenlose 7‑Tage‑Testphase an
👉 Überzeuge dich selbst von unserer KI‑Performance

Abonniere den Kanal, aktiviere die Glocke 🔔 und verpasse keine Insights zu automatisiertem Trading, Hedging‑Strategien und den Erfolgsstorys unserer Nutzer. Viel Spaß und viel Gewinn!

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=1603 tokens=528/228
  reasonCodes=["LANG_DETECTED", "CONTENT_ANALYSIS"] concepts=["trading education", "AI hedging", "automated trading", "masterclass"] languages=["de"]
  explanation: The channel promotes a trading masterclass, an AI hedging engine, and offers educational resources for traders, indicating a focus on teaching investing strategies rather than personal finance or news.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1855 tokens=466/352
  reasonCodes=["CHANNEL_TITLE_INDICATES_EDUCATION", "BIO_EMPHASIZES_TEACHING_AND_MENTORSHIP", "PRODUCT_IS_EDUCATIONAL_COURSE"] concepts=["Trading Masterclass", "Automated Trading", "Hedging Strategies", "Profitable Trading", "AI Trading Engine"] languages=["de"]
  explanation: The channel title 'Genius Trading Masterclass' explicitly indicates an educational format. The channel bio confirms this by stating the creator has helped traders worldwide become profitable since 2019 and offers a 'Masterclass'. While the content promotes an automated trading tool (GTFX Optimizer AI), the primary framing of the channel and the creator's role is that of an educator and mentor sharing knowledge and strategies, which fits the INVESTING_EDUCATION category. It is not merely financial news or personal finance advice, but structured trading education.
  citations: ["channel_title: Genius Trading Masterclass - Raphael Palmdale", "channel_bio: Ich bin Raphael, Gr\u00fcnder und das Brain hinter der Genius Trading Masterclass", "channel_bio: seit 2019 weltweit Tradern geholfen, profitabel zu werden", "channel_bio: Insights zu automatisiertem Trading, Hedging-Strategien"]

### UCA9gY6bF-uyQ_C7oZYhYxjQ
Channel: Alpha Intelligence Indicators [UCA9gY6bF-uyQ_C7oZYhYxjQ] | country: United States
youtube: https://www.youtube.com/channel/UCA9gY6bF-uyQ_C7oZYhYxjQ
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Alpha Intelligence has built something the trading world has never seen before.

For the first time, institutional-grade market intelligence — the exact tools, levels, and structures that professional trading firms use — is available directly on TradingView. No Bloomberg terminal. No six-figure data subscriptions. No guesswork.

Our indicators work on every chart, every asset, every timeframe, 24 hours a day, 365 days a year. Stocks, futures, forex, crypto — it doesn't matter. The math doesn't change. The edge doesn't change. And once you see it, you can't unsee it.

Alpha Intelligence removes emotion from your trading. No more second-guessing entries.

Our toolkit shows you exactly what the market is doing and exactly where it matters — so you can make decisions based on data, not feelings.

This is the most advanced institutional trading toolkit ever built for TradingView. And it's available right now for a fraction of what professional traders pay for inferior tools.

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2010 tokens=517/209
  reasonCodes=["R1"] concepts=["trading indicators", "market intelligence", "institutional-grade tools", "real-time analysis"] languages=["en"]
  explanation: The channel promotes proprietary trading indicators and tools for active market participants, emphasizing real‑time decision making and institutional‑grade analytics, which aligns with active trading content.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2077 tokens=442/434
  reasonCodes=["channel_title", "channel_bio"] concepts=["TradingView indicators", "Institutional trading tools", "Active trading strategies", "Market entries and exits", "Technical analysis", "Forex, Crypto, Stocks, Futures"] languages=["en"]
  explanation: The content explicitly promotes 'Alpha Intelligence Indicators' as a tool for active trading on TradingView. The channel bio emphasizes 'institutional-grade market intelligence,' 'professional trading firms,' and removing emotion from 'trading.' It lists specific asset classes traded actively (stocks, futures, forex, crypto) and focuses on execution-related concepts like 'entries,' 'levels,' and 'structures.' The primary intent is to sell tools for active market participation rather than general financial education, news, or long-term investing.
  citations: [{"field": "channel_title", "text": "Alpha Intelligence Indicators"}, {"field": "channel_bio", "text": "Alpha Intelligence has built something the trading world has never seen before. For the first time, institutional-grade market intelligence \u2014 the exact tools, levels, and structures that professional trading firms use \u2014 is available directly on TradingView."}, {"field": "channel_bio", "text": "Our indicators work on every chart, every asset, every timeframe, 24 hours a day, 365 days 

### UCDKHCNF-3FUl5YStk9oyTkA
Channel: Smart Liquidity [UCDKHCNF-3FUl5YStk9oyTkA] | country: None
youtube: https://www.youtube.com/channel/UCDKHCNF-3FUl5YStk9oyTkA
status: trading=TRADING_CONFIRMED scan=COMPLETED discord=NOT_FOUND validation=COMPLETED
bio: 📈 Trade the Trap
🧠 Master the Move Before It Happens
🎥 Smart Money Setups
gemini_history: [{"at": "2026-08-31T04:50:10.774Z", "label": "ACTIVE_TRADING", "conf": 64, "codes": ["CHANNEL_NAME_FINANCIAL"], "model": "gemini-3.6-flash"}]
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=92 supportedLanguage=True latencyMs=2284 tokens=334/297
  reasonCodes=["LANG_EN", "CONTENT_TRADING"] concepts=["trading", "liquidity", "smart money"] languages=["en"]
  explanation: The channel title and bio use English terms focused on trading strategies and smart money setups, indicating the creator is actively engaged in trading rather than education or news.
  citations: [{"ref": {"field": "channel_title"}, "text": "Smart Liquidity"}, {"ref": {"field": "channel_bio"}, "text": "\ud83d\udcc8 Trade the Trap\n\ud83e\udde0 Master the Move Before It Happens\n\ud83c\udfa5 Smart Money Setups"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=1545 tokens=254/187
  reasonCodes=["channel_title", "channel_bio"] concepts=["liquidity", "trading strategies", "smart money concepts", "market setups"] languages=["en"]
  explanation: The channel title 'Smart Liquidity' and bio phrases like 'Trade the Trap', 'Master the Move', and 'Smart Money Setups' strongly indicate a focus on active trading strategies, technical analysis, and market manipulation tactics rather than long-term investing or general financial news.
  citations: ["channel_title", "channel_bio"]

### UCJi1zk66BkvEKNywHS33myQ
Channel: Market Navigator [UCJi1zk66BkvEKNywHS33myQ] | country: United States
youtube: https://www.youtube.com/channel/UCJi1zk66BkvEKNywHS33myQ
status: trading=TRADING_CONFIRMED scan=COMPLETED discord=NOT_FOUND validation=COMPLETED
bio: Welcome to your one-stop shop for trading knowledge!

I dive deep into the world of Crypto, Forex, and Stocks, providing analysis and insights to help you navigate the markets.  Learn about hot coins to hold, trading strategies, and general market updates.

Hit subscribe to level up your trading game!

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=85 supportedLanguage=True latencyMs=2245 tokens=377/249
  reasonCodes=["LANG_EN", "CONTENT_TRADING"] concepts=["Crypto", "Forex", "Stocks", "Trading Strategies", "Market Updates"] languages=["en"]
  explanation: The channel title and bio are in English and describe providing analysis, strategies, and market updates for crypto, forex, and stocks, indicating active trading focus rather than pure education or news.
  citations: ["channel_title", "channel_bio"]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1875 tokens=294/346
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "STRATEGY_FOCUS", "KNOWLEDGE_SHARING"] concepts=["Trading Strategies", "Market Analysis", "Crypto Education", "Forex Education", "Stock Market Insights"] languages=["en"]
  explanation: The channel bio explicitly states it is a 'one-stop shop for trading knowledge' and aims to help users 'level up your trading game.' It focuses on providing analysis, insights, and trading strategies for Crypto, Forex, and Stocks, which aligns with educating the audience on how to trade rather than just reporting news or promoting specific assets for hype.
  citations: [{"field": "channel_bio", "quote": "Welcome to your one-stop shop for trading knowledge!"}, {"field": "channel_bio", "quote": "providing analysis and insights to help you navigate the markets."}, {"field": "channel_bio", "quote": "Learn about hot coins to hold, trading strategies, and general market updates."}, {"field": "channel_bio", "quote": "Hit subscribe to level up your trading game!"}]

### UCQZadZvikfk314GqoG4NsVw
Channel: MichalDML [UCQZadZvikfk314GqoG4NsVw] | country: PL
youtube: https://www.youtube.com/channel/UCQZadZvikfk314GqoG4NsVw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Logika Wykresu:  Trading na podstawie "znaków" pozostawionych przez dużych graczy. Moje osobiste podejście do rynku forex na podstawie poziomów DML ( opartych na kontraktach futures )
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2544 tokens=368/273
  reasonCodes=["RC1"] concepts=["forex trading", "DML levels", "futures contracts", "market signals"] languages=["pl"]
  explanation: The channel description discusses a personal approach to forex market trading using DML levels derived from futures contracts, indicating active participation in trading rather than education or news.
  citations: [{"field": "channel_title", "text": "MichalDML"}, {"field": "channel_bio", "text": "Logika Wykresu:  Trading na podstawie \"znak\u00f3w\" pozostawionych przez du\u017cych graczy. Moje osobiste podej\u015bcie do rynku forex na podstawie poziom\u00f3w DML ( opartych na kontraktach futures )"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1978 tokens=280/222
  reasonCodes=["EXPLICIT_METHOD_DESCRIPTION", "EDUCATIONAL_INTENT"] concepts=["Forex Trading", "Technical Analysis", "Smart Money Concepts", "DML Levels", "Futures Contracts"] languages=["pl"]
  explanation: The channel bio explicitly describes a specific trading methodology ('Logika Wykresu' / Chart Logic) based on signs left by large players and DML levels. It frames this as a 'personal approach' to the forex market, which indicates an intent to teach or share a specific analytical framework rather than just reporting news or providing general financial advice. The focus is on the mechanics of trading analysis.
  citations: ["channel_bio"]

### UCRI2v10i5V-t8LdlhxWAQhg
Channel: Wallst Sophia [UCRI2v10i5V-t8LdlhxWAQhg] | country: United States
youtube: https://www.youtube.com/channel/UCRI2v10i5V-t8LdlhxWAQhg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Profitable day trader of 5 years.  Built my freedom through structure, timing, and discipline. Now showing others how.


gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=2052 tokens=341/286
  reasonCodes=["LANG_EN", "FOCUS_EDU"] concepts=["day trading", "trading education", "financial discipline"] languages=["en"]
  explanation: The channel title and bio describe a day trader with 5 years of experience who now teaches others how to trade, indicating the creator's primary focus is on educating viewers about investing and trading strategies.
  citations: [{"field": "channel_title", "text": "Wallst Sophia"}, {"field": "channel_bio", "text": "Profitable day trader of 5 years. Built my freedom through structure, timing, and discipline. Now showing others how."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1571 tokens=259/237
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "TRADING_EXPERTISE_CLAIM"] concepts=["Day Trading", "Trading Education", "Discipline", "Structure", "Timing"] languages=["en"]
  explanation: The channel bio explicitly states the creator is a 'Profitable day trader' who is 'Now showing others how.' This indicates the primary focus is teaching or educating viewers on trading strategies, structure, and discipline, rather than just reporting news or providing personal finance advice for general savings.
  citations: [{"field": "channel_bio", "quote": "Profitable day trader of 5 years. Built my freedom through structure, timing, and discipline. Now showing others how."}]

### UCTHo6Ti1yBf37mViX_969pg
Channel: Alex G Wealth [UCTHo6Ti1yBf37mViX_969pg] | country: None
youtube: https://www.youtube.com/channel/UCTHo6Ti1yBf37mViX_969pg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Master the money game and create true wealth or you will never be financially free. 
@fxalexg__


gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=85 supportedLanguage=True latencyMs=2281 tokens=338/204
  reasonCodes=["RC1"] concepts=["wealth creation", "financial freedom", "investing education"] languages=["en"]
  explanation: The channel title and bio focus on teaching viewers how to 'master the money game' and 'create true wealth', which aligns with content aimed at educating about investing and wealth building rather than active trading or news.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=1889 tokens=255/292
  reasonCodes=["EDUCATIONAL_INTENT", "WEALTH_BUILDING_FOCUS", "FINANCIAL_LITERACY"] concepts=["wealth creation", "financial freedom", "money management", "forex trading"] languages=["en"]
  explanation: The channel title 'Alex G Wealth' and the bio 'Master the money game and create true wealth' indicate a focus on teaching financial strategies and wealth creation. The phrase 'Master the money game' suggests an educational approach to finance rather than just reporting news or providing real-time trading signals. The mention of '@fxalexg__' hints at Forex trading, but the primary framing is about mastering concepts to achieve financial freedom, which aligns with investing education.
  citations: [{"field": "channel_title", "text": "Alex G Wealth"}, {"field": "channel_bio", "text": "Master the money game and create true wealth or you will never be financially free."}]

### UCTNVqbbOPd4rvOu2xVoGoiQ
Channel: Money With Marc Nance [UCTNVqbbOPd4rvOu2xVoGoiQ] | country: United States
youtube: https://www.youtube.com/channel/UCTNVqbbOPd4rvOu2xVoGoiQ
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio:  Our channel is dedicated to helping beginner and experienced investors understand the markets through technical analysis, price action, market trends, trading strategies, and breaking financial news.

Whether you're interested in day trading, swing trading, long-term investing, options trading, ETFs, IPOs, or the latest stock market updates, you'll find educational videos designed to help you make more informed trading decisions. We cover market-moving events including Federal Reserve announcements, inflation reports, earnings season, economic data, and major news impacting the U.S. stock market and global financial markets.

Disclaimer: The information provided on this channel is for educational and informational purposes only and should not be considered financial or investment advice. Always conduct your own research and consult a qualified financial advisor before making investment decisions.

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=96 supportedLanguage=True latencyMs=2025 tokens=469/313
  reasonCodes=["R1", "R3"] concepts=["technical analysis", "price action", "market trends", "trading strategies", "day trading", "swing trading", "long\u2011term investing", "options trading", "ETFs", "IPOs", "financial news"] languages=["en"]
  explanation: The channel explicitly states its purpose is to educate beginner and experienced investors on market analysis, trading strategies, and financial news, which aligns with the INVESTING_EDUCATION taxonomy. While it mentions day and swing trading, the primary focus is instructional rather than promoting active trading as a service.
  citations: [{"field": "channel_title", "text": "Money With Marc Nance"}, {"field": "channel_bio", "text": "Our channel is dedicated to helping beginner and experienced investors understand the markets through technical analysis, price action, market trends, trading strategies, and breaking financial news..."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=2059 tokens=389/225
  reasonCodes=["EXPLICIT_EDUCATIONAL_PURPOSE", "TECHNICAL_ANALYSIS_FOCUS", "STRATEGY_INSTRUCTION"] concepts=["technical analysis", "price action", "trading strategies", "day trading", "swing trading", "options trading", "financial education"] languages=["en"]
  explanation: The channel bio explicitly states its dedication to helping investors 'understand the markets' and provides 'educational videos designed to help you make more informed trading decisions.' It lists specific educational topics such as technical analysis, price action, and trading strategies, alongside a disclaimer that the content is for educational purposes only.
  citations: ["channel_bio"]

### UCTUyVAYoz6lRY_p7PQlKgnw
Channel: Cofiatrading [UCTUyVAYoz6lRY_p7PQlKgnw] | country: France
youtube: https://www.youtube.com/channel/UCTUyVAYoz6lRY_p7PQlKgnw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=COMPLETED
bio: COFIATRADING transforme l’order flow, le Volume Profile et un moteur H1 NAS100 évalué avec coûts simulés inclus en décisions compréhensibles — du contexte à l’invalidation, puis au suivi.

🧠 Analyses NAS100 et débriefs
📊 Setups expliqués avec niveaux et logique
🎓 Academy pour construire une méthode
📡 FREE, VIP et progression documentée du signal à l’exécution
🎬 KAANVERSE : l’équipe et les concepts mis en scène

Notre standard : montrer ce qui est mesuré, distinguer le benchmark historique de la livraison réelle et documenter chaque étape.

Commencer → https://cofiatrading.com/edge

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=85 supportedLanguage=True latencyMs=7514 tokens=463/250
  reasonCodes=["LANGUAGE_DETECTED", "CONTENT_FOCUS"] concepts=["order flow", "Volume Profile", "NAS100", "trading setups", "signal execution"] languages=["fr"]
  explanation: The channel describes real‑time order‑flow analysis, Volume Profile, NAS100 setups, and signals for execution, indicating a focus on active trading rather than purely educational content.
  citations: ["channel_title", "channel_bio"]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1827 tokens=392/262
  reasonCodes=["EXPLICIT_EDUCATIONAL_OFFER", "METHODOLOGY_FOCUS", "STRUCTURED_LEARNING_PATH"] concepts=["Order Flow", "Volume Profile", "NAS100 Trading", "Trading Methodology", "Academy", "Signal Execution", "Risk Management"] languages=["fr"]
  explanation: The channel explicitly offers an 'Academy' to help users 'build a method' and provides 'explained setups with levels and logic.' While it mentions trading signals and VIP services, the primary framing is educational, focusing on transforming complex concepts like order flow and volume profile into 'understandable decisions' and documenting the progression from signal to execution. The emphasis on 'debriefs' and 'logic' further supports an educational intent over pure hype or simple news reporting.
  citations: ["channel_bio"]

### UCTWJaiJJtPrQVhMBOYtwDag
Channel: StockTigerLive [UCTWJaiJJtPrQVhMBOYtwDag] | country: United States
youtube: https://www.youtube.com/channel/UCTWJaiJJtPrQVhMBOYtwDag
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=FAILED_OPERATIONAL
candidate_locator: https://discord.gg/hEKF2y5NK
bio: 🎯 Welcome to StockTiger Channel — Live Pre-Market Futures Trading
This is the official channel for StockTiger, where we go live during the pre-market to tackle the NQ futures market with precision and speed.

Join our real-time scalping sessions looking to catch early volatility, and trade prop firm accounts with discipline and strategy. Whether you're here to learn or ride the momentum, this channel brings you the energy and insights of a live trading floor — raw, real, and fast-paced.

🔍 What you’ll find here:
• Live pre-market trading sessions
• Real-time analysis and trade breakdowns
• Behind-the-scenes look at prop firm trading
• Insights, setups, and nonstop market action

📌 For educational and entertainment purposes only. Not financial advice.

🔥 Subscribe before the bell rings!

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2595 tokens=485/250
  reasonCodes=["LANGUAGE_ENGLISH", "CONTENT_ACTIVE_TRADING"] concepts=["pre\u2011market futures", "scalping", "prop\u2011firm trading"] languages=["en"]
  explanation: The channel title and bio describe live pre‑market futures trading sessions, real‑time scalping, and prop‑firm trading, indicating the creator focuses on actively executing trades rather than education or news.
  citations: [{"field": "channel_title", "text": "StockTigerLive"}, {"field": "channel_bio", "text": "Live Pre-Market Futures Trading... Live pre\u2011market trading sessions... Real\u2011time analysis and trade breakdowns..."}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2373 tokens=412/385
  reasonCodes=["LIVE_TRADING_SESSIONS", "REAL_TIME_EXECUTION", "SCALPING_STRATEGY", "FUTURES_MARKET_FOCUS"] concepts=["Live Trading", "Pre-Market Futures", "NQ Futures", "Scalping", "Prop Firm Trading", "Real-Time Analysis"] languages=["en"]
  explanation: The content explicitly describes live pre-market futures trading, real-time scalping sessions, and active participation in the NQ futures market. While it mentions educational purposes, the primary focus is on the execution and observation of live trades rather than theoretical instruction.
  citations: [{"field": "channel_bio", "quote": "Live Pre-Market Futures Trading"}, {"field": "channel_bio", "quote": "tackle the NQ futures market with precision and speed"}, {"field": "channel_bio", "quote": "Join our real-time scalping sessions"}, {"field": "channel_bio", "quote": "trade prop firm accounts with discipline and strategy"}, {"field": "channel_bio", "quote": "Live pre-market trading sessions"}, {"field": "channel_bio", "quote": "Real-time analysis and trade breakdowns"}]

### UCU5fb5s-P48lC043U2E6r2Q
Channel: Scalp Trading Lab [UCU5fb5s-P48lC043U2E6r2Q] | country: United States
youtube: https://www.youtube.com/channel/UCU5fb5s-P48lC043U2E6r2Q
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: New video every week!!

SIGNALS! longest winning streak 16 weeks.
📈 SIGNALS GROUP: https://scalptradinglab.co/
📲 FREE TELEGRAM: https://t.me/scalptradingLabb
♥️ MY INSTGRAM: https://www.instagram.com/fx.jordang/

SUBSCRIBE AND LIKE FOR MORE ❤️
SUSCRIBE FOR MORE ❤️

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2533 tokens=403/280
  reasonCodes=["LANGUAGE_DETECTED", "CONTENT_FOCUS"] concepts=["scalp trading", "trading signals", "financial markets"] languages=["en"]
  explanation: The channel title and bio are in English and explicitly promote scalp trading signals and weekly videos for active traders, indicating a focus on active trading rather than education or news.
  citations: [{"field": "channel_title", "text": "Scalp Trading Lab"}, {"field": "channel_bio", "text": "SIGNALS! longest winning streak 16 weeks.\n\ud83d\udcc8 SIGNALS GROUP: https://scalptradinglab.co/"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=1876 tokens=323/315
  reasonCodes=["CHANNEL_TITLE_INDICATOR", "BIO_SIGNALS_PROMOTION", "TRADING_COMMUNITY_LINKS"] concepts=["Scalping", "Trading Signals", "Forex/CFD Trading", "Winning Streak"] languages=["en"]
  explanation: The channel title 'Scalp Trading Lab' explicitly references scalping, a specific active trading strategy. The channel bio promotes 'SIGNALS' with a claim of a 'winning streak,' which is characteristic of active trading services rather than general education or news. It provides links to a signals group and a Telegram channel, further indicating a focus on providing actionable trading alerts for immediate execution.
  citations: [{"field": "channel_title", "text": "Scalp Trading Lab"}, {"field": "channel_bio", "text": "SIGNALS! longest winning streak 16 weeks."}, {"field": "channel_bio", "text": "\ud83d\udcc8 SIGNALS GROUP: https://scalptradinglab.co/"}]

### UCWfHQCvrJ7m07KE1CbJm42A
Channel: Nick Shawn [UCWfHQCvrJ7m07KE1CbJm42A] | country: United States
youtube: https://www.youtube.com/channel/UCWfHQCvrJ7m07KE1CbJm42A
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Nearly a decade of trading forex, stocks, and crypto. Most people lose money trading, because it's so risky, and they don't know the most optimal way to go about learning how to trade. I'm here to help you become one of 1% that actually makes money trading. It's not easy, but it's worth it.
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=3405 tokens=377/259
  reasonCodes=["RC1"] concepts=["forex", "stocks", "crypto", "trading education", "risk management"] languages=["en"]
  explanation: The creator describes a decade of experience trading forex, stocks, and crypto and focuses on teaching others how to trade profitably, which aligns with investing education rather than active trading or news.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1542 tokens=299/224
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "TRADING_FOCUS"] concepts=["Trading Education", "Forex", "Stocks", "Crypto", "Risk Management", "Mentorship"] languages=["en"]
  explanation: The channel bio explicitly states the creator's goal is to help viewers learn how to trade ('optimal way to go about learning how to trade') and become profitable ('one of 1% that actually makes money'). While it mentions active trading instruments (forex, stocks, crypto), the primary focus described is on education and mentorship rather than real-time market commentary or news.
  citations: ["channel_bio"]

### UCWwE0ARKbB44kKyEjM362YQ
Channel: Tengkolok Trading [UCWwE0ARKbB44kKyEjM362YQ] | country: MY
youtube: https://www.youtube.com/channel/UCWwE0ARKbB44kKyEjM362YQ
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Follow Official Telegram Tengkolok Trading untuk info yang pantas.
https://t.me/tengkoloktrading




gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=85 supportedLanguage=True latencyMs=2480 tokens=342/295
  reasonCodes=["LANG_DETECTED", "KEYWORD_TRADING", "CONTENT_FOCUS"] concepts=["trading", "financial markets"] languages=["ms"]
  explanation: The channel title and bio contain the term "Trading" and are written in Malay, indicating a focus on active trading activities and related information.
  citations: [{"ref": "channel_title"}, {"ref": "channel_bio"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=1543 tokens=258/184
  reasonCodes=["CHANNEL_TITLE_INDICATOR", "BIO_CALL_TO_ACTION"] concepts=["Trading", "Telegram Signals", "Real-time Information"] languages=["ms"]
  explanation: The channel title 'Tengkolok Trading' explicitly mentions trading. The bio directs users to a Telegram group for 'info yang pantas' (timely/relevant info), which is characteristic of active trading signals or real-time market updates rather than general education or news.
  citations: ["channel_title", "channel_bio"]

### UCXqdAaH2Jc2aGJCUUQiAk-w
Channel: Guillaume Lidy - Trading Talk [UCXqdAaH2Jc2aGJCUUQiAk-w] | country: France
youtube: https://www.youtube.com/channel/UCXqdAaH2Jc2aGJCUUQiAk-w
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Trader depuis plus de 12 ans. Ex trader live pour WH SelfInvest Luxembourg.
Spécialisé sur le trading open US avec des outils orderflow.

Fondateur de l'écosystème Trader Elite. Un environnement de qualité professionnel.
Conçu pour devenir indépendant et rentable sur les marchés.

#trading #scalping #daytrading #swingtrading #money #lifestyle #pourtoi #foryou

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=9796 tokens=410/277
  reasonCodes=["LANGUAGE_DETECTED", "CONTENT_FOCUS"] concepts=["trading", "orderflow", "scalping", "daytrading", "swingtrading"] languages=["fr"]
  explanation: The channel title and bio are in French and describe a professional trader with 12+ years experience, focusing on active trading strategies (orderflow, scalping, day trading, swing trading). This indicates the creator’s primary focus is active trading rather than education, news, or personal finance.
  citations: ["channel_title", "channel_bio"]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=2169 tokens=328/260
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "PROFESSIONAL_TRADING_FOCUS", "COMMUNITY_BUILDING"] concepts=["Trading Education", "Orderflow Analysis", "Professional Trading Environment", "Market Independence", "Scalping", "Day Trading", "Swing Trading"] languages=["French"]
  explanation: The channel bio explicitly states the founder is a trader with over 12 years of experience and specializes in US open trading using orderflow tools. Crucially, it mentions founding the 'Trader Elite' ecosystem, described as a professional environment 'designed to become independent and profitable on the markets.' This indicates a primary focus on teaching, mentoring, or providing resources for others to learn trading, which fits the definition of Investing Education rather than just active trading or news.
  citations: ["channel_bio"]

### UCaQDMEJKxaqSIW7bU2W_O1Q
Channel: Nitro Trades [UCaQDMEJKxaqSIW7bU2W_O1Q] | country: None
youtube: https://www.youtube.com/channel/UCaQDMEJKxaqSIW7bU2W_O1Q
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=SUCCEEDED
candidate_locator: https://discord.gg/platinum
bio: Full Time Trader Of Over 7 Years | Small Caps, Options, Futures | Check Out My Other Socials!
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2262 tokens=335/265
  reasonCodes=["KEYWORDS_TRADING_EXPERIENCE", "CHANNEL_TITLE"] concepts=["trading", "small caps", "options", "futures"] languages=["en"]
  explanation: The channel title and bio indicate the creator is a full‑time trader with 7+ years of experience, mentioning specific trading activities (small caps, options, futures). This points to active trading content rather than education or news.
  citations: [{"field": "channel_title", "text": "Nitro Trades"}, {"field": "channel_bio", "text": "Full Time Trader Of Over 7 Years | Small Caps, Options, Futures | Check Out My Other Socials!"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=2260 tokens=252/278
  reasonCodes=["EXPLICIT_ROLE_CLAIM", "INSTRUMENT_SPECIFICITY", "FREQUENCY_INDICATOR"] concepts=["Active Trading", "Full-Time Trader", "Small Caps", "Options", "Futures"] languages=["en"]
  explanation: The channel title 'Nitro Trades' and the bio explicitly stating 'Full Time Trader' with a 7-year history indicate a focus on active trading. The mention of specific instruments like 'Small Caps, Options, Futures' further confirms this classification, as these are typical vehicles for active trading strategies rather than long-term investing or general financial news.
  citations: [{"field": "channel_title", "text": "Nitro Trades"}, {"field": "channel_bio", "text": "Full Time Trader Of Over 7 Years | Small Caps, Options, Futures | Check Out My Other Socials!"}]

### UCdOCF9FGLYwgM1rm5iC3gAw
Channel: Andrea Ragazzo [UCdOCF9FGLYwgM1rm5iC3gAw] | country: Italy
youtube: https://www.youtube.com/channel/UCdOCF9FGLYwgM1rm5iC3gAw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Day Trading per 6+ anni. Il mio obiettivo è quello di condividere il mio viaggio attraverso il trading, Quindi benvenuto 🙂 
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=90 supportedLanguage=True latencyMs=2111 tokens=342/260
  reasonCodes=["R1"] concepts=["Day Trading", "Personal Trading Journey"] languages=["Italian"]
  explanation: The creator explicitly states they have been day trading for over 6 years and aims to share their personal trading journey, indicating active participation in trading rather than merely educating or reporting news.
  citations: [{"field": "channel_title", "text": "Andrea Ragazzo"}, {"field": "channel_bio", "text": "Day Trading per 6+ anni. Il mio obiettivo \u00e8 quello di condividere il mio viaggio attraverso il trading, Quindi benvenuto \ud83d\ude42"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1746 tokens=255/237
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "EXPERIENCE_BASED_SHARING"] concepts=["Day Trading", "Trading Journey", "Knowledge Sharing"] languages=["it"]
  explanation: The channel bio explicitly states the creator's goal is to 'share my journey through trading' ('condividere il mio viaggio attraverso il trading'). While the creator has experience in 'Day Trading', the stated purpose of the content is sharing knowledge and experience, which aligns with investing education rather than just reporting news or providing real-time trade signals.
  citations: [{"field": "channel_bio", "quote": "Day Trading per 6+ anni. Il mio obiettivo \u00e8 quello di condividere il mio viaggio attraverso il trading"}]

### UCdn5LVcTN6Oj49Gcb1ZYJXA
Channel: The go giver @finance - trading - investment [UCdn5LVcTN6Oj49Gcb1ZYJXA] | country: None
youtube: https://www.youtube.com/channel/UCdn5LVcTN6Oj49Gcb1ZYJXA
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: 💜 Telegram: https://t.me/+oaR_4pmyme1lNGM1
- Share the meaningful knowledge about forex, cryptocurrency, stock.
- Share knowledge of finance.
- Share other things about this beautiful life.

🐦 Twitter: https://twitter.com/GiverTheGo68

💜 Telegram: https://t.me/+oaR_4pmyme1lNGM1

👍FB: https://www.facebook.com/the.go.giver.finance

🌐Website: https://the-go-giver.com/

Tiktok: https://www.tiktok.com/@thegogiver

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=85 supportedLanguage=True latencyMs=2028 tokens=453/270
  reasonCodes=["LANG_EN", "CONTENT_EDU"] concepts=["finance education", "investment knowledge", "forex", "cryptocurrency", "stock market"] languages=["en"]
  explanation: The channel title and bio indicate the creator focuses on sharing knowledge about forex, cryptocurrency, and stocks, which aligns with educational content rather than personal trading activity or news reporting.
  citations: [{"field": "channel_title", "text": "The go giver @finance - trading - investment"}, {"field": "channel_bio", "text": "Share the meaningful knowledge about forex, cryptocurrency, stock. Share knowledge of finance."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=2013 tokens=376/223
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "MULTI_ASSET_COVERAGE"] concepts=["forex", "cryptocurrency", "stock", "finance", "knowledge sharing"] languages=["en"]
  explanation: The channel bio explicitly states the intent to 'Share the meaningful knowledge about forex, cryptocurrency, stock' and 'Share knowledge of finance.' While the title mentions 'trading,' the primary focus described in the bio is educational ('knowledge'), covering multiple asset classes (forex, crypto, stocks). This aligns best with INVESTING_EDUCATION rather than active trading signals or news.
  citations: ["channel_title", "channel_bio"]

### UClHeKS_KxcniH4Tl46s_sqg
Channel: WYLD | Will [UClHeKS_KxcniH4Tl46s_sqg] | country: United States
youtube: https://www.youtube.com/channel/UClHeKS_KxcniH4Tl46s_sqg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Denver | 8 fig trader 
Creator of the "4P model"
Mentorship below
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=85 supportedLanguage=True latencyMs=3331 tokens=333/295
  reasonCodes=["R1", "R3"] concepts=["trading", "mentorship", "4P model", "8-figure income"] languages=["en"]
  explanation: The creator describes themselves as an "8 fig trader" and offers mentorship, indicating a primary focus on personal active trading activities rather than broader education or news.
  citations: [{"field": "channel_title", "text": "wyldwill"}, {"field": "channel_bio", "text": "Denver | 8 fig trader \nCreator of the \"4P model\"\nMentorship below"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=85 supportedLanguage=True latencyMs=1779 tokens=252/201
  reasonCodes=["MENTORSHIP_OFFER", "PROPRIETARY_MODEL", "TRADER_IDENTITY"] concepts=["trading mentorship", "proprietary trading model", "high-net-worth trader"] languages=["en"]
  explanation: The channel bio explicitly identifies the creator as a 'trader' and the 'Creator of the 4P model', while offering 'Mentorship'. This indicates a focus on teaching trading strategies and educating followers, which aligns with Investing Education rather than just active trading logs or news.
  citations: ["channel_bio"]

### UClZ0010gHaJQW3N2Ytkq3mA
Channel: Hamza Hilal [UClZ0010gHaJQW3N2Ytkq3mA] | country: France
youtube: https://www.youtube.com/channel/UClZ0010gHaJQW3N2Ytkq3mA
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Hamza, Passionné et travaillant dans le milieu des marchés financiers. Le partage de la connaissance/expérience ne me rendra pas moins riche, pourquoi donc les garder pour moi ? 

Casser la chaîne de pauvreté d’une famille commence toujours par une personne, j’ai décidé que ce soit moi. 

Message à mes petits enfants : si vous lisez cette description, sachez que je me suis battu et je me bats encore pour atteindre la prospérité. Préservez celle-ci pour les prochaines générations !! 

Contact : hamzaa.pro53@gmail.com
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=1930 tokens=434/262
  reasonCodes=["R1", "R3", "R5"] concepts=["financial markets", "knowledge sharing", "personal wealth", "prosperity", "financial education"] languages=["fr"]
  explanation: The channel title is a personal name, but the bio explicitly states the creator works in financial markets and aims to share knowledge and experience to help others achieve prosperity. This aligns with the definition of investing education, focusing on teaching financial concepts and personal wealth building rather than active trading signals or news reporting.
  citations: [{"field": "channel_bio", "text": "Hamza, Passionn\u00e9 et travaillant dans le milieu des march\u00e9s financiers. Le partage de la connaissance/exp\u00e9rience..."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=1877 tokens=353/376
  reasonCodes=["explicit_intent_sharing_knowledge", "professional_background_financial_markets", "educational_mission_statement"] concepts=["financial markets", "knowledge sharing", "experience sharing", "financial literacy", "wealth building", "breaking cycle of poverty"] languages=["fr"]
  explanation: The channel bio explicitly states that the creator works in the financial markets ('travaillant dans le milieu des marchés financiers') and focuses on sharing knowledge and experience ('Le partage de la connaissance/expérience'). The phrase 'Le partage de la connaissance/expérience ne me rendra pas moins riche' (Sharing knowledge/experience does not make me less rich) is a common trope in educational content creation, indicating an intent to teach or inform rather than just trade or provide news. The mention of breaking the cycle of poverty and achieving prosperity further supports a focus on financial literacy and education for long-term wealth building.
  citations: [{"field": "channel_bio", "text": "Hamza, Passionn\u00e9 et travaillant dans le milieu des march\u00e9s financiers. Le partage de la connaissance/exp\u00e9rience ne me rendra pas moins riche, pourquoi donc les garder pour moi ?"}, {"field": "channel_bio", "text": "Casser la cha\u00eene de pauvret\u00e9 d\u2019une famille commence toujours par une personne, j\u2019ai d\u00e9cid\u00e9 que ce soit moi."}]

### UCnL8G3-Se9VJD1im-hctFsg
Channel: Sully's Advice [UCnL8G3-Se9VJD1im-hctFsg] | country: United Kingdom
youtube: https://www.youtube.com/channel/UCnL8G3-Se9VJD1im-hctFsg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=COMPLETED
bio: Helping struggling traders make their first withdrawal.

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=85 supportedLanguage=True latencyMs=11048 tokens=323/228
  reasonCodes=["R1"] concepts=["trading", "withdrawal", "advice"] languages=["en"]
  explanation: The channel title and bio focus on providing advice to traders to achieve their first withdrawal, indicating a primary focus on active trading support rather than broader education or news.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=4239 tokens=241/223
  reasonCodes=["channel_title_indicates_advice", "channel_bio_targets_traders", "focus_on_skill_development"] concepts=["trading education", "mentorship", "trading success", "withdrawal strategies"] languages=["en"]
  explanation: The channel title 'Sully's Advice' combined with the bio 'Helping struggling traders make their first withdrawal' clearly indicates a focus on educating and mentoring traders. The goal of helping users achieve a 'first withdrawal' implies teaching strategies, risk management, or platform navigation to succeed in trading, which falls under investing education rather than just news or hype.
  citations: ["channel_title", "channel_bio"]

### UCrWnQ0Almp3ykdVSRB9Rnkw
Channel: AutoTraderForexClubEA [UCrWnQ0Almp3ykdVSRB9Rnkw] | country: Italy
youtube: https://www.youtube.com/channel/UCrWnQ0Almp3ykdVSRB9Rnkw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: AutoTraderForexClub sviluppa software proprietari per il trading automatico, con focus su logiche ICT e modelli AI / ONNX.

Il nostro ecosistema RAPTOR nasce attorno a un principio preciso: operatività a trade singolo, selezione, gestione del rischio e controllo del processo.

Sul canale trovi contenuti dedicati a:

ICT RAPTOR AI CORE, PLUS e PRIME
logiche operative e gestione delle posizioni
AI / ONNX applicata ai mercati
cronistorie, test e risultati documentati
analisi delle strategie ICT

Niente lifestyle.
Niente promesse facili.
Solo tecnologia, processo e trasparenza.

RAPTOR AI ECOSYSTEM
Single-trade execution.
Proprietary AI / ONNX models.
1,300+ verified trader feedback.

Scopri di più su AutoTraderForexClub e sull’intero ecosistema RAPTOR.

Il trading comporta rischio. Le performance passate, simulate o mostrate nei contenuti non garantiscono risultati futuri.

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=92 supportedLanguage=True latencyMs=3882 tokens=542/249
  reasonCodes=["R1", "R3"] concepts=["automated trading", "forex", "AI models", "risk management", "single\u2011trade execution"] languages=["it"]
  explanation: The channel title and bio describe proprietary software for automated forex trading, focusing on ICT logic, AI/ONNX models, risk management, and single‑trade execution. This indicates the creator's primary focus is on providing tools and knowledge for active trading rather than education, news, personal finance, hype, or unrelated content.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=2457 tokens=449/271
  reasonCodes=["FOCUS_ON_STRATEGY_AND_RISK", "TECHNICAL_EDUCATION", "TRANSPARENCY_AND_TESTING"] concepts=["ICT Trading Methodology", "Risk Management", "AI in Trading", "ONNX Models", "Strategy Analysis", "Backtesting/Verification"] languages=["it"]
  explanation: The content focuses on educating viewers about specific trading methodologies (ICT), risk management, and the technical application of AI/ONNX models in trading. It explicitly states 'Niente lifestyle' (No lifestyle) and emphasizes 'processo e trasparenza' (process and transparency), along with 'analisi delle strategie' (strategy analysis) and 'test e risultati documentati' (documented tests and results). This aligns with providing educational value and technical insight rather than just promoting a product for hype or providing real-time news.
  citations: ["channel_bio"]

### UCs9RVDGdBEdnPb_vTZVk9dA
Channel: QT Futures [UCs9RVDGdBEdnPb_vTZVk9dA] | country: None
youtube: https://www.youtube.com/channel/UCs9RVDGdBEdnPb_vTZVk9dA
status: trading=TRADING_CONFIRMED scan=COMPLETED discord=NOT_FOUND validation=COMPLETED
bio: Trading Futures every day using my custom indicator EllE
gemini_history: [{"at": "2026-08-28T07:33:19.612Z", "label": "ACTIVE_TRADING", "conf": 84, "codes": ["DAY_TRADING_STRATEGY", "FUTURES_TRADING", "TECHNICAL_INDICATORS"], "model": "gemini-3.6-flash"}]
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=1813 tokens=321/254
  reasonCodes=["KEYWORD_TRADING", "CUSTOM_INDICATOR"] concepts=["Futures Trading", "Custom Indicator"] languages=["en"]
  explanation: The channel title and bio describe daily futures trading using a custom indicator, indicating the creator focuses on active trading activities.
  citations: [{"ref": {"field": "channel_title"}, "text": "QT Futures"}, {"ref": {"field": "channel_bio"}, "text": "Trading Futures every day using my custom indicator EllE"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=4212 tokens=238/230
  reasonCodes=["channel_title", "channel_bio"] concepts=["Futures Trading", "Technical Analysis", "Custom Indicators", "Day Trading"] languages=["en"]
  explanation: The channel title 'QT Futures' and the bio 'Trading Futures every day using my custom indicator EllE' explicitly describe the daily execution of futures trades using specific technical tools. This indicates a focus on active trading strategies rather than general education, news, or personal finance.
  citations: [{"field": "channel_title", "text": "QT Futures"}, {"field": "channel_bio", "text": "Trading Futures every day using my custom indicator EllE"}]

### UCu_6nOA9sC0GTbaSWi3nBSw
Channel: Wyckoff SMI / LearnCrypto [UCu_6nOA9sC0GTbaSWi3nBSw] | country: United States
youtube: https://www.youtube.com/channel/UCu_6nOA9sC0GTbaSWi3nBSw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Welcome to the Official Wyckoff SMI / LearnCrypto YouTube Channel! Discover successful technical trading with insights from Richard D. Wyckoff.

📚 Explore Proven Methods: Dive into Richard D. Wyckoff's techniques through our online platform.

📈 Elevate Your Trading: Empowering technical traders for 93 years. Join a skilled community.

⚙️ Exclusive Indicators: Access invaluable market insights developed by Wyckoff SMI.

⚠️ Informed Trading: We provide knowledge, not advice. Understand risks before trading.

🔍 Uncover Insights: Engaging content on trends, psychology, and more. Don't miss updates.

Join us to master technical trading! 🚀
#wyckoffsmi #learncrypto #stocks #crypto

gemini_history: [{"at": "2026-09-06T07:37:11.562Z", "label": "ACTIVE_TRADING", "conf": 84, "codes": ["TECHNICAL_ANALYSIS", "TRADING_STRATEGIES"], "model": "gemini-3.6-flash"}]
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=92 supportedLanguage=True latencyMs=2917 tokens=484/300
  reasonCodes=["CONTENT_FOCUS_ANALYSIS", "LANGUAGE_DETECTION"] concepts=["technical analysis", "Wyckoff method", "stock trading", "cryptocurrency", "trading education"] languages=["en"]
  explanation: The channel title and bio describe teaching technical trading methods based on Richard D. Wyckoff, offering educational content on stocks and crypto. The emphasis is on learning and mastering trading techniques rather than active trading or news reporting.
  citations: [{"field": "channel_title", "text": "Wyckoff SMI / LearnCrypto"}, {"field": "channel_bio", "text": "Welcome to the Official Wyckoff SMI / LearnCrypto YouTube Channel! Discover successful technical trading with insights from Richard D. Wyckoff..."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=2959 tokens=412/212
  reasonCodes=["channel_title", "channel_bio"] concepts=["Technical Analysis", "Wyckoff Method", "Trading Education", "Crypto Trading", "Stock Trading"] languages=["en"]
  explanation: The channel title 'Wyckoff SMI / LearnCrypto' and the bio explicitly state the purpose is to 'Discover successful technical trading' and 'Explore Proven Methods' based on Richard D. Wyckoff's techniques. The content focuses on empowering traders with knowledge, insights, and educational resources rather than providing real-time news or direct financial advice.
  citations: ["channel_title", "channel_bio"]

### UCvJZEG5x-DVYZKTz--pS39w
Channel: FX Evolution - Trading Academy [UCvJZEG5x-DVYZKTz--pS39w] | country: Australia
youtube: https://www.youtube.com/channel/UCvJZEG5x-DVYZKTz--pS39w
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=SUCCEEDED
candidate_locator: https://discord.gg/MEc9UX99S4
bio: Own your future. Learn to read the markets - Institutional insights for retail traders.
Founded in 2010 by fund managers and private traders, FXE Trading Academy is a leading trading education channel focused on technical analysis of stocks, ETFs, options and crypto. 
We've helped 20,000+ traders learn how to read charts, understand macro, and make sense of what markets are actually doing.
What you'll find here:• Daily market breakdowns and chart walkthroughs• Macro explainers ahead of CPI, FOMC, earnings, and other key events• Beginner-to-advanced trading education rooted in technical analysis
New videos every weekday. Subscribe and turn the bell on to never miss a breakdown.
Website: fxevolution.com 
FREE live training session: https://www.fxevolution.com/live-course
Free weekly email newsletter: https://www.fxevolution.com/newsletter 
Courses: fxevolution.com/store
Business enquiries: support@fxevolution.com
General information only. Not personal financial advice. AFSL 246705.

gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=2138 tokens=531/219
  reasonCodes=["EDU_01", "FOCUS_02"] concepts=["trading education", "technical analysis", "market breakdowns", "macro explainers", "courses"] languages=["en"]
  explanation: The channel title and bio describe a trading academy that provides technical analysis education, market breakdowns, macro explainers, and courses for retail traders. The focus is on teaching how to read markets rather than promoting active trading or personal finance advice.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=98 supportedLanguage=True latencyMs=1872 tokens=460/255
  reasonCodes=["EXPLICIT_EDUCATION_FOCUS", "COURSE_OFFERINGS", "TECHNICAL_ANALYSIS_INSTRUCTION"] concepts=["Trading Education", "Technical Analysis", "Market Breakdowns", "Chart Reading", "Macro Economics", "Stocks", "ETFs", "Options", "Crypto"] languages=["en"]
  explanation: The channel title 'FX Evolution - Trading Academy' and the bio explicitly state it is a 'leading trading education channel'. The content focuses on teaching technical analysis, reading charts, and understanding macroeconomic events through daily breakdowns, courses, and live training sessions. While it covers financial markets, the primary intent is educational rather than providing direct financial advice or news reporting.
  citations: ["channel_title", "channel_bio"]

### UCvNdn1tAit6gKHRgZODVFAw
Channel: Pips Masterclass [UCvNdn1tAit6gKHRgZODVFAw] | country: None
youtube: https://www.youtube.com/channel/UCvNdn1tAit6gKHRgZODVFAw
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: I help traders understand the hidden patterns and tactics used by large market players, so they can make informed decisions with clarity and confidence. If you’ve only learned the typical retail approach, you may be missing the bigger picture. My goal is to give you the skills to think independently and trade with purpose.


gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1795 tokens=375/321
  reasonCodes=["RC1"] concepts=["trading education", "market patterns", "retail vs institutional strategies"] languages=["en"]
  explanation: The channel title and bio describe teaching traders about market patterns and tactics, which aligns with providing investing education rather than active trading or news.
  citations: [{"ref": {"field": "channel_title"}, "text": "Pips Masterclass"}, {"ref": {"field": "channel_bio"}, "text": "I help traders understand the hidden patterns and tactics used by large market players, so they can make informed decisions with clarity and confidence. If you\u2019ve only learned the typical retail approach, you may be missing the bigger picture. My goal is to give you the skills to think independently and trade with purpose."}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1835 tokens=292/293
  reasonCodes=["channel_title_indicates_education", "channel_bio_focuses_on_skill_building", "explicit_mention_of_helping_traders_understand"] concepts=["trading education", "market analysis", "skill development", "institutional trading tactics"] languages=["en"]
  explanation: The channel title 'Pips Masterclass' strongly suggests an educational format. The channel bio explicitly states the goal is to 'help traders understand' market patterns and tactics, aiming to provide 'skills' for independent thinking. This focus on teaching methodology and understanding market mechanics aligns with investing education rather than just providing news or active trade signals.
  citations: [{"field": "channel_title", "text": "Pips Masterclass"}, {"field": "channel_bio", "text": "I help traders understand the hidden patterns and tactics used by large market players... My goal is to give you the skills to think independently and trade with purpose."}]

### UCvsG6DaKak09CSZ72_N4dCQ
Channel: Blue Signal FX [UCvsG6DaKak09CSZ72_N4dCQ] | country: United States
youtube: https://www.youtube.com/channel/UCvsG6DaKak09CSZ72_N4dCQ
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Disclaimer: Trading Futures, Forex, CFDs and Stocks involves a risk of loss. Please consider carefully if such trading is appropriate for you. Past performance is not indicative of future results. Content in this guide are for entertainment purposes only and do not constitute investment recommendations or advice. 5AGDX5
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=ACTIVE_TRADING confidence=85 supportedLanguage=True latencyMs=3282 tokens=372/235
  reasonCodes=["LANG_EN", "CONTENT_TRADING"] concepts=["Futures", "Forex", "CFDs", "Stocks", "Trading"] languages=["en"]
  explanation: The channel title and bio reference trading futures, forex, CFDs and stocks, indicating a focus on active trading activities rather than education or news.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=ACTIVE_TRADING confidence=95 supportedLanguage=True latencyMs=1754 tokens=290/266
  reasonCodes=["channel_title_indicates_trading_focus", "channel_bio_discloses_trading_risks"] concepts=["Forex", "Futures", "CFDs", "Stocks", "Trading Signals", "Risk Disclosure"] languages=["en"]
  explanation: The channel title 'Blue Signal FX' strongly suggests a focus on Forex trading signals. The channel bio explicitly mentions trading Futures, Forex, CFDs, and Stocks, and includes standard risk disclaimers associated with active trading activities. This indicates the content is centered around active trading rather than general education or news.
  citations: [{"field": "channel_title", "text": "Blue Signal FX"}, {"field": "channel_bio", "text": "Disclaimer: Trading Futures, Forex, CFDs and Stocks involves a risk of loss."}]

### UCyX88WRXkRx75isztAxyc2w
Channel: Taksh Trading  [UCyX88WRXkRx75isztAxyc2w] | country: United States
youtube: https://www.youtube.com/channel/UCyX88WRXkRx75isztAxyc2w
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=COMPLETED
bio: **Welcome to TAKSH FINANCE ACADEMY!**

Your trusted destination for learning **Stock Market, Smart Money Concepts (SMC), Price Action, Option Trading, Risk Management, Trading Psychology, Technical Analysis, NIFTY, BANK NIFTY, Market Structure, BOS, CHoCH, Order Blocks, Liquidity, FVG, Intraday Trading, Swing Trading, and Personal Finance**.

This channel is dedicated to helping beginners and experienced traders understand the financial markets through practical chart analysis, educational tutorials, real market examples, and professional trading concepts. Our goal is to simplify complex topics so you can build confidence, improve discipline, and become a smarter trader.

**⚠️ Disclaimer:** All content is for educational and informational purposes only and should not be considered financial or investment advice. Always do your own research before making any investment or trading decisions.

📧 Business: [vickykumarmhera169@gmail.com](mailto:vickykumarmhera169@gmail.com)


gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=2047 tokens=524/240
  reasonCodes=["EDU_CONTENT", "FINANCIAL_TERMS", "CHANNEL_BIO"] concepts=["Stock Market", "Smart Money Concepts", "Price Action", "Option Trading", "Risk Management", "Trading Psychology", "Technical Analysis", "Personal Finance"] languages=["en"]
  explanation: The channel bio describes a finance academy offering tutorials on stock market, trading strategies, technical analysis, and personal finance. The focus is on educating viewers about investing and trading concepts rather than providing real-time trading signals or news.
  citations: [{"field": "channel_title"}, {"field": "channel_bio"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=98 supportedLanguage=True latencyMs=2034 tokens=449/324
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "CURRICULUM_LISTING", "DISCLAIMER_PRESENT"] concepts=["Stock Market", "Smart Money Concepts (SMC)", "Price Action", "Option Trading", "Risk Management", "Trading Psychology", "Technical Analysis", "NIFTY", "BANK NIFTY", "Market Structure", "BOS", "CHoCH", "Order Blocks", "Liquidity", "FVG", "Intraday Trading", "Swing Trading", "Personal Finance"] languages=["en"]
  explanation: The channel title 'TAKSH FINANCE ACADEMY' and the bio explicitly state the purpose is 'learning' and 'educational tutorials.' The content lists specific trading concepts (SMC, Price Action, Technical Analysis) and aims to help beginners and experienced traders understand markets through education rather than providing real-time signals or news. The disclaimer reinforces the educational nature of the content.
  citations: ["channel_title", "channel_bio"]

### UCyi6pQ5bn2DJuAA-tzywHBg
Channel: Trading Akademin [UCyi6pQ5bn2DJuAA-tzywHBg] | country: Sweden
youtube: https://www.youtube.com/channel/UCyi6pQ5bn2DJuAA-tzywHBg
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Välkommen till Trading Akademin – Här får du ta del av utbildningar från mig och annat trading content




gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=3401 tokens=339/327
  reasonCodes=["R1"] concepts=["trading", "education", "financial markets"] languages=["sv"]
  explanation: The channel title and bio are in Swedish and explicitly mention providing education and training related to trading, indicating a focus on investing education rather than active trading or news.
  citations: [{"field": "channel_title", "text": "Trading Akademin"}, {"field": "channel_bio", "text": "V\u00e4lkommen till Trading Akademin \u2013 H\u00e4r f\u00e5r du ta del av utbildningar fr\u00e5n mig och annat trading content"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1577 tokens=257/250
  reasonCodes=["EXPLICIT_EDUCATION_CLAIM", "CHANNEL_NAME_INDICATOR"] concepts=["Trading Education", "Financial Training", "Academy"] languages=["sv"]
  explanation: The channel title 'Trading Akademin' translates to 'Trading Academy', and the bio explicitly states 'Här får du ta del av utbildningar' (Here you get to participate in training/education). This clearly indicates the content focus is on educating viewers about trading.
  citations: [{"field": "channel_title", "text": "Trading Akademin"}, {"field": "channel_bio", "text": "V\u00e4lkommen till Trading Akademin \u2013 H\u00e4r f\u00e5r du ta del av utbildningar fr\u00e5n mig och annat trading content"}]

### UCzlXIDR88ZY85S4-ayTCOww
Channel: Pip Hunters [UCzlXIDR88ZY85S4-ayTCOww] | country: Saudi Arabia
youtube: https://www.youtube.com/channel/UCzlXIDR88ZY85S4-ayTCOww
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: This Channel is to teach people Advanced Trading techniques to trade live Forex Markets
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1906 tokens=327/274
  reasonCodes=["EDU_TRADING"] concepts=["Forex", "Advanced Trading", "Live Market"] languages=["en"]
  explanation: The channel explicitly states it teaches advanced trading techniques for live Forex markets, indicating an educational focus on investing rather than personal trading activity.
  citations: [{"ref": {"field": "channel_title"}, "text": "Pip Hunters"}, {"ref": {"field": "channel_bio"}, "text": "This Channel is to teach people Advanced Trading techniques to trade live Forex Markets"}]
Qwen3.6-27B: label=INVESTING_EDUCATION confidence=95 supportedLanguage=True latencyMs=1469 tokens=244/208
  reasonCodes=["EXPLICIT_EDUCATIONAL_INTENT", "TRADING_TECHNIQUES_FOCUS"] concepts=["Forex Trading", "Advanced Trading Techniques", "Live Markets", "Trading Education"] languages=["en"]
  explanation: The channel bio explicitly states the purpose is to 'teach people Advanced Trading techniques'. This clearly indicates an educational focus on trading strategies rather than just providing news, personal finance advice, or hype.
  citations: [{"field": "channel_bio", "text": "This Channel is to teach people Advanced Trading techniques to trade live Forex Markets"}]

## 2. Both models abstain (0 channels)
## 3. Disagreements (1 channels)
### UC5GzSfm3OMQ34I9DY4VzQew
Channel: Nifty Vista [UC5GzSfm3OMQ34I9DY4VzQew] | country: None
youtube: https://www.youtube.com/channel/UC5GzSfm3OMQ34I9DY4VzQew
status: trading=UNCERTAIN scan=ENRICHMENT_PENDING discord=UNCERTAIN validation=NOT_STARTED
bio: Share your videos with friends, family, and the world
links: http://schema.org/ImageObject | http://schema.org/Person | http://schema.org/http://schema.org/YoutubeChannelV2 | http://www.w3.org/2000/svg | https://# | https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=YouTube+Sans:wght@300..900&display=swap | https://g | https://i.ytimg.com | https://i.ytimg.com/an_webp/LQeR-P9QpCw/mqdefault_6s.webp?du=3000&sqp=CKiv9dQG&rs=AOn4CLAthU75lif2AoRauFljbiAhevsUYg | https://i.ytimg.com/an_webp/QiE2dJq4cWM/mqdefault_6s.webp?du=3000&sqp=CLXQ9dQG&rs=AOn4CLCOedQnNdz_oze5RIKSqHZ7wr8mYQ
gemini_history: none found
cohort: UNCERTAIN trading status, >=50-char bio, no human decision on record
GPT-OSS-120B: label=INVESTING_EDUCATION confidence=65 supportedLanguage=True latencyMs=2175 tokens=323/329
  reasonCodes=["LANGUAGE_DETECTED", "KEYWORD_NIFTY"] concepts=["Nifty", "stock market", "investment"] languages=["en"]
  explanation: The title 'Nifty Vista' references the Indian stock index 'Nifty', suggesting content about investing or market analysis. The bio is generic and does not contradict this interpretation, leading to a classification as investing education with moderate confidence.
  citations: [{"field": "channel_title", "text": "Nifty Vista"}, {"field": "channel_bio", "text": "Share your videos with friends, family, and the world"}]
Qwen3.6-27B: label=AMBIGUOUS confidence=10 supportedLanguage=False latencyMs=3635 tokens=240/224
  reasonCodes=["INSUFFICIENT_CONTEXT", "GENERIC_BIO"] concepts=[] languages=["en"]
  explanation: The channel title 'Nifty Vista' suggests a potential connection to financial markets (specifically the Nifty index), but the channel bio is a generic YouTube default text ('Share your videos with friends, family, and the world') that provides no information about the content's nature. Without video titles, descriptions, or specific keywords in the bio, it is impossible to reliably determine if the content is related to active trading, investing education, financial news, or if it is unrelated (e.g., a travel vlog or unrelated commentary). Therefore, the meaning cannot be reliably interpreted.
  citations: ["channel_title", "channel_bio"]
