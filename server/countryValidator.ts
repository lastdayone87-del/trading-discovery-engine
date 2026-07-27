import { CountryStatus, CountryVocabulary, ExcludedCountry } from '../src/types';
import { getExcludedCountries, getCountryVocabularies } from './db';

export interface ValidationResult {
  score: number;
  status: CountryStatus;
  rejectionReason?: string;
  decisionLogs: string;
}

// Excluded region indicators (cities, demonyms, currencies, TLDs)
const EXCLUDED_INDICATORS: Array<{ name: string; patterns: string[]; tlds: string[]; terms: string[] }> = [
  {
    name: 'Nigeria',
    patterns: ['nigeria', 'nigerian', 'lagos', 'abuja', 'port harcourt', 'kano', 'ibadan', 'enugu', 'naija'],
    tlds: ['.ng', '.com.ng', '.edu.ng', '.org.ng'],
    terms: ['naira', 'ngn', 'forex nigeria', 'nigeria trader', 'forex in pidgin']
  },
  {
    name: 'India',
    patterns: ['india', 'indian', 'delhi', 'mumbai', 'bangalore', 'bengaluru', 'hyderabad', 'kolkata', 'pune', 'ahmedabad', 'surat', 'jaipur', 'lucknow', 'desi trader', 'trading in hindi', 'stock market india'],
    tlds: ['.in', '.co.in', '.net.in', '.org.in', '.edu.in', '.firm.in'],
    terms: ['rupee', 'inr', 'nifty', 'nifty50', 'banknifty', 'sensex', 'nse india', 'bse india', 'bhai trading', 'share market hindi']
  },
  {
    name: 'Pakistan',
    patterns: ['pakistan', 'pakistani', 'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan', 'peshawar', 'trading in urdu'],
    tlds: ['.pk', '.com.pk', '.org.pk', '.net.pk'],
    terms: ['pkr', 'pakistan stock exchange', 'psx', 'urdu trading']
  },
  {
    name: 'Bangladesh',
    patterns: ['bangladesh', 'bangladeshi', 'dhaka', 'chittagong', 'sylhet', 'bangla trading'],
    tlds: ['.bd', '.com.bd'],
    terms: ['bdt', 'taka', 'dse bd']
  },
  {
    name: 'Nepal',
    patterns: ['nepal', 'nepali', 'nepalese', 'kathmandu', 'pokhara'],
    tlds: ['.np', '.com.np'],
    terms: ['nepse', 'npr']
  },
  {
    name: 'Kenya',
    patterns: ['kenya', 'kenyan', 'nairobi', 'mombasa'],
    tlds: ['.ke', '.co.ke'],
    terms: ['ksh', 'kes', 'nse kenya']
  },
  {
    name: 'South Africa',
    patterns: ['south africa', 'south african', 'johannesburg', 'cape town', 'durban', 'pretoria'],
    tlds: ['.za', '.co.za'],
    terms: ['rand', 'zar', 'jse']
  },
  {
    name: 'Ghana',
    patterns: ['ghana', 'ghanaian', 'accra', 'kumasi'],
    tlds: ['.gh', '.com.gh'],
    terms: ['cedis', 'ghs']
  },
  {
    name: 'Egypt',
    patterns: ['egypt', 'egyptian', 'cairo', 'alexandria'],
    tlds: ['.eg', '.com.eg'],
    terms: ['egp', 'egx']
  },
  {
    name: 'Morocco',
    patterns: ['morocco', 'moroccan', 'casablanca', 'rabat'],
    tlds: ['.ma', '.co.ma'],
    terms: ['mad', 'casablanca bourse']
  },
  {
    name: 'Philippines',
    patterns: ['philippines', 'filipino', 'manila', 'cebu'],
    tlds: ['.ph', '.com.ph'],
    terms: ['php', 'peso', 'psei']
  },
  {
    name: 'Vietnam',
    patterns: ['vietnam', 'vietnamese', 'hanoi', 'saigon', 'ho chi minh'],
    tlds: ['.vn', '.com.vn'],
    terms: ['vnd', 'dong', 'hose']
  },
  {
    name: 'Indonesia',
    patterns: ['indonesia', 'indonesian', 'jakarta', 'bali', 'surabaya'],
    tlds: ['.id', '.co.id'],
    terms: ['idr', 'rupiah', 'idx']
  }
];

export async function validateChannelCountry(
  channelData: {
    channelName: string;
    description: string;
    videoTitles?: string[];
    locationTag?: string;
    externalLinks?: string[];
    socialBios?: string[];
  },
  targetCountryName: string
): Promise<ValidationResult> {
  const excludedList = await getExcludedCountries();
  const vocabularies = await getCountryVocabularies();

  const highConfidenceSignals: string[] = [];
  const mediumConfidenceSignals: string[] = [];
  const excludedSignals: string[] = [];

  const locationLower = (channelData.locationTag || '').toLowerCase().trim();
  const descLower = (channelData.description || '').toLowerCase();
  const nameLower = (channelData.channelName || '').toLowerCase();
  const titlesJoined = (channelData.videoTitles || []).join(' ').toLowerCase();
  const linksJoined = (channelData.externalLinks || []).map(l => l.toLowerCase()).join(' ');
  const biosJoined = (channelData.socialBios || []).map(b => b.toLowerCase()).join(' ');
  const fullText = `${nameLower} ${descLower} ${titlesJoined} ${linksJoined} ${biosJoined}`;

  // 1. HARD EXCLUSION CHECK — Target Country direct match
  const isTargetInExcludedList = excludedList.some(e => e.country_name.toLowerCase() === targetCountryName.toLowerCase());
  if (isTargetInExcludedList) {
    const log = [
      `Target Country: ${targetCountryName}`,
      `Calculated Score: 0/100 (Status: REJECTED)`,
      `Evidence: Target country '${targetCountryName}' is explicitly configured in the Hard Exclusion List.`,
      `Decision: REJECTED (Reason: Excluded Target Region)`
    ].join('\n');

    return {
      score: 0,
      status: 'REJECTED',
      rejectionReason: `Target country '${targetCountryName}' is in the excluded regions list.`,
      decisionLogs: log
    };
  }

  // 2. DETECT HARD EXCLUSION SIGNALS IN CHANNEL DATA
  for (const excl of EXCLUDED_INDICATORS) {
    let matchedPattern: string | null = null;

    // Check location tag
    if (locationLower === excl.name.toLowerCase() || excl.patterns.some(p => locationLower.includes(p))) {
      matchedPattern = `Location tag matched ${excl.name} ('${locationLower}')`;
    }

    // Check bio / description / full text
    if (!matchedPattern) {
      for (const p of excl.patterns) {
        if (fullText.includes(p)) {
          matchedPattern = `Content/Bio matches region pattern '${p}' (${excl.name})`;
          break;
        }
      }
    }

    // Check website TLDs
    if (!matchedPattern) {
      for (const tld of excl.tlds) {
        if (linksJoined.includes(tld)) {
          matchedPattern = `Website TLD matches excluded country domain: '${tld}' (${excl.name})`;
          break;
        }
      }
    }

    // Check regional currencies & stock exchange terms
    if (!matchedPattern) {
      for (const term of excl.terms) {
        if (fullText.includes(term)) {
          matchedPattern = `Regional market term matched: '${term}' (${excl.name})`;
          break;
        }
      }
    }

    if (matchedPattern) {
      excludedSignals.push(matchedPattern);
    }
  }

  // IF ANY EXCLUDED SIGNALS FOUND -> IMMEDIATE HARD REJECTION!
  if (excludedSignals.length > 0) {
    const log = [
      `Detected Target Country: ${targetCountryName}`,
      `Calculated Score: 0/100 (Status: REJECTED)`,
      `Evidence Summary:`,
      `  [EXCLUDED REGION SIGNALS DETECTED]`,
      ...excludedSignals.map(s => `  - High Confidence Exclusion: ${s}`),
      `Decision: REJECTED`,
      `Reason: Channel matched Hard Exclusion rules.`
    ].join('\n');

    return {
      score: 0,
      status: 'REJECTED',
      rejectionReason: `Channel matched excluded country signals: ${excludedSignals.join('; ')}`,
      decisionLogs: log
    };
  }

  // 3. TARGET COUNTRY EVIDENCE EVALUATION
  let score = 0;
  const targetLower = targetCountryName.toLowerCase();
  const vocab = vocabularies.find(v => v.country.toLowerCase() === targetLower);

  // A. High Confidence: Website TLD Match (+35%)
  const countryTldMap: Record<string, string[]> = {
    'germany': ['.de'],
    'france': ['.fr'],
    'spain': ['.es'],
    'united kingdom': ['.uk', '.co.uk'],
    'netherlands': ['.nl'],
    'italy': ['.it'],
    'australia': ['.au', '.com.au'],
    'canada': ['.ca'],
    'united states': ['.us']
  };

  const targetTlds = countryTldMap[targetLower] || [];
  let tldMatched = false;
  for (const tld of targetTlds) {
    if (linksJoined.includes(tld)) {
      tldMatched = true;
      highConfidenceSignals.push(`Website domain TLD matches '${tld}' (${targetCountryName})`);
      score += 35;
      break;
    }
  }

  // B. Location Tag / Target Country Context Evaluation (+40%)
  if (
    locationLower.includes(targetLower) ||
    (locationLower === 'us' && targetLower === 'united states') ||
    (locationLower === 'gb' || locationLower === 'uk') && targetLower === 'united kingdom' ||
    (locationLower === 'de' && targetLower === 'germany') ||
    (locationLower === 'fr' && targetLower === 'france') ||
    (locationLower === 'es' && targetLower === 'spain') ||
    (locationLower === 'nl' && targetLower === 'netherlands') ||
    (locationLower === 'it' && targetLower === 'italy') ||
    (locationLower === 'au' && targetLower === 'australia') ||
    (locationLower === 'ca' && targetLower === 'canada')
  ) {
    highConfidenceSignals.push(`Channel profile location tag explicitly matches target country '${targetCountryName}'`);
    score += 40;
  } else if (descLower.includes(`based in ${targetLower}`) || descLower.includes(`trader in ${targetLower}`) || biosJoined.includes(targetLower)) {
    highConfidenceSignals.push(`Channel bio explicitly mentions location '${targetCountryName}'`);
    score += 35;
  } else {
    // Discovery context baseline for target country search
    mediumConfidenceSignals.push(`Discovered via target query for '${targetCountryName}'`);
    score += 35;
  }

  // C. High Confidence: Native Non-English Language Match (+35%)
  if (vocab) {
    const isNonEnglishTarget = vocab.languages.some(l => l.toLowerCase() !== 'english');
    if (isNonEnglishTarget) {
      let langMatchCount = 0;
      const langPatterns: Record<string, string[]> = {
        'german': ['dax', 'börse', 'analyse', 'handelsstrategie', 'tagesanalyse', 'ausblick', 'der', 'die', 'das', 'und', 'mit'],
        'french': ['analyse', 'marché', 'boursière', 'trading', 'hebdomadaire', 'pour', 'dans', 'avec'],
        'spanish': ['análisis', 'mercado', 'bursátil', 'tecnico', 'directo', 'para', 'con', 'sesión'],
        'dutch': ['beurs', 'opties', 'analyse', 'handelen', 'ochtendupdate', 'van', 'het'],
        'italian': ['analisi', 'tecnica', 'borsa', 'mercati', 'previsioni', 'per', 'con']
      };

      const primaryLang = vocab.languages[0].toLowerCase();
      const keywords = langPatterns[primaryLang] || [];
      for (const kw of keywords) {
        if (descLower.includes(kw) || titlesJoined.includes(kw)) {
          langMatchCount++;
        }
      }

      if (langMatchCount >= 2) {
        highConfidenceSignals.push(`Native language pattern match for ${primaryLang} (${langMatchCount} native terms found)`);
        score += 35;
      } else if (langMatchCount === 1) {
        mediumConfidenceSignals.push(`Single native language term found (${primaryLang})`);
        score += 15;
      } else {
        // Non-English target country (e.g. Germany), but description is 100% English without German words
        mediumConfidenceSignals.push(`Non-English target (${targetCountryName}), but text lacks native ${primaryLang} vocabulary.`);
      }
    } else {
      // English target (US, UK, CA, AU)
      if (locationLower.includes(targetLower) || tldMatched) {
        score += 20;
      } else {
        // Baseline for English creators with no excluded flags
        score += 35;
      }
    }

    // D. Medium Confidence: Native Exchange / Index Match (+20%)
    let nativeMarketMatch = false;
    for (const phrase of vocab.local_market_phrases) {
      const pL = phrase.toLowerCase();
      if (fullText.includes(pL)) {
        nativeMarketMatch = true;
        mediumConfidenceSignals.push(`Local market exchange phrase matched: '${phrase}'`);
        score += 20;
        break;
      }
    }

    if (!nativeMarketMatch) {
      for (const inst of vocab.popular_instruments) {
        const iL = inst.toLowerCase();
        // Skip purely global generic instruments (ES, NQ, S&P 500, BTC, ETH, Gold) from giving high scores alone
        if (['es', 'nq', 's&p 500', 'btc', 'eth', 'gold', 'eurusd'].includes(iL)) continue;
        if (fullText.includes(iL)) {
          mediumConfidenceSignals.push(`Native instrument matched: '${inst}'`);
          score += 15;
          break;
        }
      }
    }
  }

  // Cap score
  score = Math.min(100, Math.max(0, score));

  // Determine Status Tier
  let status: CountryStatus = 'REJECTED';
  if (score >= 70) status = 'CONFIRMED';
  else if (score >= 50) status = 'LIKELY';
  else if (score >= 35) status = 'UNCERTAIN';
  else status = 'REJECTED';

  const logLines: string[] = [
    `Detected Target Country: ${targetCountryName}`,
    `Calculated Score: ${score}/100 (Status: ${status})`,
    `Evidence Summary:`
  ];

  if (highConfidenceSignals.length > 0) {
    logLines.push(`  [HIGH CONFIDENCE SIGNALS]`);
    highConfidenceSignals.forEach(s => logLines.push(`  - ${s}`));
  }
  if (mediumConfidenceSignals.length > 0) {
    logLines.push(`  [MEDIUM CONFIDENCE SIGNALS]`);
    mediumConfidenceSignals.forEach(s => logLines.push(`  - ${s}`));
  }
  if (highConfidenceSignals.length === 0 && mediumConfidenceSignals.length === 0) {
    logLines.push(`  - Low / Neutral confidence (General trading terminology alone does not determine country)`);
  }

  logLines.push(`Decision: ${status === 'REJECTED' ? 'REJECTED' : 'ACCEPTED'}`);

  return {
    score,
    status,
    decisionLogs: logLines.join('\n')
  };
}
