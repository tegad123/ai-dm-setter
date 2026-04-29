// ---------------------------------------------------------------------------
// geography-gate.ts
// ---------------------------------------------------------------------------
// Pre-generation geography filter. When `geographyGate.enabled` is set on
// the persona, leads whose first messages identify them as based outside
// the supported regions are auto-disqualified BEFORE any LLM call fires —
// zero credits used.
//
// IMPORTANT: when geography is unknown or ambiguous, ALWAYS let the lead
// through. Only block on HIGH-confidence disallowed signals (country
// name, major-city name, native currency symbol). Timezone alone is
// MEDIUM confidence and never blocks.
// ---------------------------------------------------------------------------

export type GeographyConfidence = 'high' | 'medium';

export interface GeographyDetection {
  country: string | null;
  confidence: GeographyConfidence;
}

interface CountryRule {
  country: string;
  // HIGH-confidence patterns: country name, major cities, native
  // currency symbol/word. A match here is strong enough to disqualify.
  high: RegExp[];
  // MEDIUM-confidence patterns: timezone abbreviations or 3-letter
  // currency codes used loosely. Logged but never block on their own.
  medium?: RegExp[];
}

// First-world allowed list. A match here always wins over a disallowed
// match — handles "I'm a US-based Nigerian" and similar dual signals.
const ALLOWED_RULES: CountryRule[] = [
  {
    country: 'United States',
    high: [
      /\b(united\s+states|u\.s\.a\.?|\busa\b|\bus\b(?!\s+(trading|strategy|prop|broker|dollar))|america|american|new\s+york|los\s+angeles|chicago|houston|phoenix|philadelphia|san\s+antonio|san\s+diego|dallas|austin|jacksonville|fort\s+worth|columbus|indianapolis|charlotte|seattle|denver|boston|nashville|miami|atlanta|texas|california|florida|virginia|maryland|massachusetts|washington\s+state|new\s+jersey|illinois|ohio|georgia|colorado|arizona)\b/i
    ]
  },
  {
    country: 'Canada',
    high: [
      /\b(canada|canadian|toronto|vancouver|montreal|calgary|edmonton|ottawa|winnipeg|quebec|hamilton|kitchener|london\s+ontario|halifax|saskatoon|regina|ontario|alberta|british\s+columbia|manitoba|saskatchewan|nova\s+scotia|new\s+brunswick)\b/i
    ]
  },
  {
    country: 'United Kingdom',
    high: [
      /\b(united\s+kingdom|\buk\b|britain|british|england|scotland|scottish|wales|welsh|northern\s+ireland|london|manchester|birmingham|liverpool|leeds|sheffield|bristol|glasgow|edinburgh|cardiff|belfast|newcastle)\b/i
    ]
  },
  {
    country: 'Ireland',
    high: [/\b(ireland|irish|dublin|cork|galway|limerick)\b/i]
  },
  {
    country: 'Germany',
    high: [
      /\b(germany|german|deutschland|berlin|munich|hamburg|frankfurt|cologne|stuttgart|dusseldorf|leipzig|dresden)\b/i
    ]
  },
  {
    country: 'France',
    high: [
      /\b(france|french|paris|marseille|lyon|toulouse|nice|nantes|bordeaux|lille)\b/i
    ]
  },
  {
    country: 'Netherlands',
    high: [
      /\b(netherlands|dutch|holland|amsterdam|rotterdam|the\s+hague|utrecht|eindhoven)\b/i
    ]
  },
  {
    country: 'Belgium',
    high: [/\b(belgium|belgian|brussels|antwerp|ghent|bruges)\b/i]
  },
  {
    country: 'Switzerland',
    high: [
      /\b(switzerland|swiss|zurich|geneva|basel|bern|lausanne|swiss\s+franc|chf)\b/i
    ]
  },
  {
    country: 'Austria',
    high: [/\b(austria|austrian|vienna|salzburg|graz|innsbruck)\b/i]
  },
  {
    country: 'Sweden',
    high: [
      /\b(sweden|swedish|stockholm|gothenburg|malmo|swedish\s+krona|\bsek\b)\b/i
    ]
  },
  {
    country: 'Norway',
    high: [/\b(norway|norwegian|oslo|bergen|trondheim|nok\b)\b/i]
  },
  {
    country: 'Denmark',
    high: [
      /\b(denmark|danish|copenhagen|aarhus|odense|aalborg|danish\s+krone|\bdkk\b)\b/i
    ]
  },
  {
    country: 'Finland',
    high: [/\b(finland|finnish|helsinki|espoo|tampere|vantaa)\b/i]
  },
  {
    country: 'Iceland',
    high: [/\b(iceland|icelandic|reykjavik)\b/i]
  },
  {
    country: 'Luxembourg',
    high: [/\bluxembourg\b/i]
  },
  {
    country: 'Monaco',
    high: [/\b(monaco|monte\s+carlo)\b/i]
  },
  {
    country: 'Liechtenstein',
    high: [/\bliechtenstein\b/i]
  },
  {
    country: 'Italy',
    high: [
      /\b(italy|italian|rome|milan|naples|turin|florence|venice|bologna|genoa)\b/i
    ]
  },
  {
    country: 'Spain',
    high: [
      /\b(spain|spanish|madrid|barcelona|valencia|seville|zaragoza|malaga|bilbao)\b/i
    ]
  },
  {
    country: 'Portugal',
    high: [/\b(portugal|portuguese|lisbon|porto|braga|faro|coimbra)\b/i]
  },
  {
    country: 'Greece',
    high: [/\b(greece|greek|athens|thessaloniki|patras)\b/i]
  },
  {
    country: 'Poland',
    high: [
      /\b(poland|polish|warsaw|krakow|cracow|wroclaw|poznan|gdansk|lodz)\b/i
    ]
  },
  {
    country: 'Czech Republic',
    high: [/\b(czech\s+republic|czech|czechia|prague|brno|ostrava)\b/i]
  },
  {
    country: 'Slovakia',
    high: [/\b(slovakia|slovak|bratislava|kosice)\b/i]
  },
  {
    country: 'Hungary',
    high: [/\b(hungary|hungarian|budapest|debrecen|szeged)\b/i]
  },
  {
    country: 'Romania',
    high: [/\b(romania|romanian|bucharest|cluj|timisoara|iasi)\b/i]
  },
  {
    country: 'Bulgaria',
    high: [/\b(bulgaria|bulgarian|sofia|plovdiv|varna|burgas)\b/i]
  },
  {
    country: 'Croatia',
    high: [/\b(croatia|croatian|zagreb|split|rijeka|dubrovnik)\b/i]
  },
  {
    country: 'Slovenia',
    high: [/\b(slovenia|slovenian|ljubljana|maribor)\b/i]
  },
  {
    country: 'Estonia',
    high: [/\b(estonia|estonian|tallinn|tartu)\b/i]
  },
  {
    country: 'Latvia',
    high: [/\b(latvia|latvian|riga|daugavpils)\b/i]
  },
  {
    country: 'Lithuania',
    high: [/\b(lithuania|lithuanian|vilnius|kaunas)\b/i]
  },
  {
    country: 'Australia',
    high: [
      /\b(australia|australian|sydney|melbourne|brisbane|perth|adelaide|gold\s+coast|aussie|aud\b|aussie\s+dollar)\b/i
    ]
  },
  {
    country: 'New Zealand',
    high: [/\b(new\s+zealand|kiwi|auckland|wellington|christchurch|nzd\b)\b/i]
  },
  {
    country: 'Japan',
    high: [
      /\b(japan|japanese|tokyo|osaka|kyoto|yokohama|nagoya|sapporo|kobe|fukuoka|yen\b|jpy\b|¥)\b/i
    ]
  },
  {
    country: 'South Korea',
    high: [
      /\b(south\s+korea|korean|seoul|busan|incheon|daegu|south\s+korean\s+won|krw\b|₩)\b/i
    ]
  },
  {
    country: 'Singapore',
    high: [/\b(singapore|singaporean|sgd\b|s\$)\b/i]
  },
  {
    country: 'Hong Kong',
    high: [/\b(hong\s+kong|hkd\b|hk\$)\b/i]
  },
  {
    country: 'United Arab Emirates',
    high: [
      /\b(united\s+arab\s+emirates|\buae\b|emirati|dubai|abu\s+dhabi|sharjah|aed\b|dirham)\b/i
    ]
  },
  {
    country: 'Qatar',
    high: [/\b(qatar|qatari|doha|qar\b)\b/i]
  },
  {
    country: 'Kuwait',
    high: [/\b(kuwait|kuwaiti|kuwait\s+city|kwd\b|dinar)\b/i]
  },
  {
    country: 'Bahrain',
    high: [/\b(bahrain|bahraini|manama|bhd\b)\b/i]
  },
  {
    country: 'Saudi Arabia',
    high: [/\b(saudi\s+arabia|saudi|riyadh|jeddah|mecca|medina|sar\b|riyal)\b/i]
  },
  {
    country: 'Israel',
    high: [
      /\b(israel|israeli|tel\s+aviv|jerusalem|haifa|shekel|ils\b|nis\b|₪)\b/i
    ]
  },
  {
    country: 'Oman',
    high: [/\b(oman|omani|muscat|omr\b)\b/i]
  }
];

const ALLOWED_NAMES: Set<string> = new Set(
  ALLOWED_RULES.map((r) => r.country.toLowerCase())
);

// Disallowed list — non-first-world regions where the gate fires when
// enabled. Currency-symbol patterns are HIGH confidence (₦100,000 is
// strong evidence the lead is in Nigeria). Timezone abbreviations are
// MEDIUM (someone might mention IST in passing without being in India).
const DISALLOWED_RULES: CountryRule[] = [
  // ── Africa ──
  {
    country: 'Nigeria',
    high: [
      /\b(nigeria|nigerian|lagos|abuja|kano|ibadan|port\s+harcourt|naira|\bngn\b)\b/i,
      /₦/,
      // # used as informal naira-amount prefix: "#100000" — observed
      // in Paul 2026-04-29.
      /#\s?\d{4,}/
    ],
    medium: [/\bWAT\b/]
  },
  {
    country: 'Ghana',
    high: [/\b(ghana|ghanaian|accra|kumasi|cedi|\bghs\b|gh₵)\b/i, /₵/]
  },
  {
    country: 'Kenya',
    high: [
      /\b(kenya|kenyan|nairobi|mombasa|kisumu|kenyan\s+shilling|\bkes\b|\bksh\b)\b/i
    ],
    medium: [/\bEAT\b/]
  },
  {
    country: 'South Africa',
    // Bare "rand" is too common in English (proper names, "rand" as
    // a verb in some dialects) — only match when it's clearly the
    // currency word ("south african rand", "in rand", currency code).
    high: [
      /\b(south\s+africa|south\s+african|johannesburg|cape\s+town|durban|pretoria|soweto|\bzar\b)\b/i,
      /\b(south\s+african\s+rand|rand\s+(currency|notes?|coins?))\b/i,
      /\bR\s*\d{2,}/
    ]
  },
  {
    country: 'Ethiopia',
    high: [/\b(ethiopia|ethiopian|addis\s+ababa|birr|\betb\b)\b/i],
    medium: [/\bEAT\b/]
  },
  {
    country: 'Uganda',
    high: [/\b(uganda|ugandan|kampala|jinja|ugandan\s+shilling|\bugx\b)\b/i],
    medium: [/\bEAT\b/]
  },
  {
    country: 'Tanzania',
    high: [
      /\b(tanzania|tanzanian|dar\s+es\s+salaam|dodoma|zanzibar|tanzanian\s+shilling|\btzs\b)\b/i
    ],
    medium: [/\bEAT\b/]
  },
  {
    country: 'Zimbabwe',
    high: [/\b(zimbabwe|zimbabwean|harare|bulawayo|\bzwl\b)\b/i],
    medium: [/\bCAT\b/]
  },
  {
    country: 'Cameroon',
    high: [/\b(cameroon|cameroonian|douala|yaounde|yaoundé)\b/i],
    medium: [/\bWAT\b/]
  },
  {
    country: 'Ivory Coast',
    high: [
      /\b(ivory\s+coast|ivoirian|cote\s+d['’]?ivoire|côte\s+d['’]?ivoire|abidjan|yamoussoukro)\b/i
    ]
  },
  {
    country: 'Senegal',
    high: [/\b(senegal|senegalese|dakar)\b/i]
  },
  {
    country: 'Angola',
    high: [/\b(angola|angolan|luanda|kwanza|\baoa\b)\b/i]
  },
  {
    country: 'Mozambique',
    high: [/\b(mozambique|mozambican|maputo|metical|\bmzn\b)\b/i],
    medium: [/\bCAT\b/]
  },
  {
    country: 'Zambia',
    high: [/\b(zambia|zambian|lusaka|kwacha|\bzmw\b)\b/i],
    medium: [/\bCAT\b/]
  },
  {
    country: 'Rwanda',
    high: [/\b(rwanda|rwandan|kigali|\brwf\b)\b/i],
    medium: [/\bCAT\b/]
  },
  {
    country: 'Mali',
    high: [/\b(\bmali\b|malian|bamako)\b/i]
  },
  {
    country: 'Egypt',
    high: [
      /\b(egypt|egyptian|cairo|alexandria|giza|egyptian\s+pound|\begp\b)\b/i
    ]
  },
  {
    country: 'Morocco',
    high: [
      /\b(morocco|moroccan|casablanca|rabat|marrakesh|fes|dirham|\bmad\b)\b/i
    ]
  },
  {
    country: 'Algeria',
    high: [/\b(algeria|algerian|algiers|oran|constantine|\bdzd\b)\b/i]
  },
  {
    country: 'Tunisia',
    high: [/\b(tunisia|tunisian|tunis|\btnd\b)\b/i]
  },
  {
    country: 'Sudan',
    high: [/\b(sudan|sudanese|khartoum|\bsdg\b)\b/i]
  },
  {
    country: 'Somalia',
    high: [/\b(somalia|somali|mogadishu)\b/i],
    medium: [/\bEAT\b/]
  },
  {
    country: 'Libya',
    high: [/\b(libya|libyan|tripoli|benghazi)\b/i]
  },

  // ── Southeast Asia ──
  {
    country: 'Philippines',
    high: [
      /\b(philippines|filipino|filipina|pilipinas|manila|cebu|davao|quezon\s+city|caloocan|peso|\bphp\b)\b/i,
      /₱/
    ],
    medium: [/\bPHT\b/]
  },
  {
    country: 'Indonesia',
    high: [
      /\b(indonesia|indonesian|jakarta|surabaya|bandung|medan|denpasar|\bbali\b|rupiah|\bidr\b)\b/i,
      /Rp\s*\d/
    ]
  },
  {
    country: 'Vietnam',
    high: [
      /\b(vietnam|vietnamese|hanoi|ho\s+chi\s+minh|saigon|haiphong|dong|\bvnd\b|₫)\b/i
    ]
  },
  {
    country: 'Thailand',
    high: [
      /\b(thailand|thai|bangkok|phuket|chiang\s+mai|pattaya|baht|\bthb\b|฿)\b/i
    ]
  },
  {
    country: 'Malaysia',
    high: [
      /\b(malaysia|malaysian|kuala\s+lumpur|johor|penang|ringgit|\bmyr\b|\brm\s*\d)/i
    ]
  },
  {
    country: 'Myanmar',
    high: [/\b(myanmar|burmese|burma|yangon|naypyidaw|kyat|\bmmk\b)\b/i]
  },
  {
    country: 'Cambodia',
    high: [/\b(cambodia|cambodian|phnom\s+penh|siem\s+reap|riel|\bkhr\b)\b/i]
  },
  {
    country: 'Laos',
    high: [/\b(laos|laotian|vientiane|kip|\blak\b)\b/i]
  },

  // ── South Asia ──
  {
    country: 'India',
    high: [
      /\b(india|indian|mumbai|bombay|delhi|new\s+delhi|bangalore|bengaluru|hyderabad|chennai|madras|kolkata|calcutta|pune|ahmedabad|jaipur|surat|lucknow|kanpur|nagpur|indore|rupee|\binr\b)\b/i,
      /₹/
    ],
    medium: [/\bIST\b/]
  },
  {
    country: 'Pakistan',
    high: [
      /\b(pakistan|pakistani|karachi|lahore|islamabad|rawalpindi|faisalabad|peshawar|quetta|multan|\bpkr\b)\b/i
    ],
    medium: [/\bPKT\b/]
  },
  {
    country: 'Bangladesh',
    high: [
      /\b(bangladesh|bangladeshi|dhaka|chittagong|khulna|rajshahi|taka|\bbdt\b|৳)\b/i
    ]
  },
  {
    country: 'Sri Lanka',
    high: [/\b(sri\s+lanka|sri\s+lankan|colombo|sinhalese|\blkr\b)\b/i, /₨/]
  },
  {
    country: 'Nepal',
    high: [/\b(nepal|nepali|nepalese|kathmandu|pokhara|\bnpr\b)\b/i]
  },

  // ── Latin America (non-first-world) ──
  {
    country: 'Mexico',
    high: [
      /\b(mexico|mexican|mexico\s+city|guadalajara|monterrey|puebla|tijuana|leon|juarez|mexican\s+peso|\bmxn\b)\b/i
    ]
  },
  {
    country: 'Colombia',
    high: [
      /\b(colombia|colombian|bogota|bogotá|medellin|medellín|cali|barranquilla|cartagena|colombian\s+peso|\bcop\b)\b/i
    ]
  },
  {
    country: 'Venezuela',
    high: [
      /\b(venezuela|venezuelan|caracas|maracaibo|valencia\s+venezuela|bolivar|\bves\b|\bvef\b)\b/i
    ]
  },
  {
    country: 'Peru',
    high: [/\b(peru|peruvian|lima|arequipa|cusco|sol\b|soles\b|\bpen\b)\b/i]
  },
  {
    country: 'Ecuador',
    high: [/\b(ecuador|ecuadorian|quito|guayaquil|cuenca)\b/i]
  },
  {
    country: 'Bolivia',
    high: [
      /\b(bolivia|bolivian|la\s+paz|santa\s+cruz|cochabamba|sucre|boliviano|\bbob\b)\b/i
    ]
  },
  {
    country: 'Honduras',
    high: [
      /\b(honduras|honduran|tegucigalpa|san\s+pedro\s+sula|lempira|\bhnl\b)\b/i
    ]
  },
  {
    country: 'Guatemala',
    high: [/\b(guatemala|guatemalan|guatemala\s+city|quetzal|\bgtq\b)\b/i]
  },
  {
    country: 'El Salvador',
    high: [/\b(el\s+salvador|salvadoran|san\s+salvador)\b/i]
  },
  {
    country: 'Nicaragua',
    high: [/\b(nicaragua|nicaraguan|managua|cordoba|\bnio\b)\b/i]
  },
  {
    country: 'Haiti',
    high: [/\b(haiti|haitian|port[-\s]?au[-\s]?prince|gourde|\bhtg\b)\b/i]
  },
  {
    country: 'Jamaica',
    high: [/\b(jamaica|jamaican|kingston|montego\s+bay|\bjmd\b)\b/i]
  },
  {
    country: 'Dominican Republic',
    high: [
      /\b(dominican\s+republic|dominicano|dominicana|santo\s+domingo|santiago\s+(de\s+los\s+caballeros)?|\bdop\b)\b/i
    ]
  },
  {
    country: 'Brazil',
    // Abdulahi 2026-04-29 false-positive: bare "real" matched in
    // "I'll be real with you". Bare currency words that are also
    // common English words ("real", "kiwi") need explicit currency
    // context to count. R$ pattern is its own regex (no outer \b)
    // because the trailing word boundary fails on "R$5000".
    high: [
      /\b(brazil|brazilian|brasil|sao\s+paulo|são\s+paulo|rio\s+de\s+janeiro|brasilia|salvador|fortaleza|recife|\bbrl\b)\b/i,
      /r\$\s*\d/i,
      /\b(brazilian\s+real|real\s+(currency|notes?))\b/i
    ]
  },
  {
    country: 'Argentina',
    high: [
      /\b(argentina|argentine|argentinian|buenos\s+aires|cordoba|rosario|argentine\s+peso|\bars\b)\b/i
    ]
  },
  {
    country: 'Chile',
    high: [
      /\b(chile|chilean|santiago\s+chile|valparaiso|chilean\s+peso|\bclp\b)\b/i
    ]
  }
];

/**
 * Detect the lead's country of residence from their messages. Scans
 * for country names, major-city names, native currency symbols (HIGH
 * confidence) and timezone abbreviations (MEDIUM confidence).
 *
 * Allowed-country matches WIN over disallowed ones — handles "I'm a
 * US-based Nigerian" cases. When neither matches, returns
 * { country: null, confidence: 'medium' }.
 */
export function detectGeography(messages: string[]): GeographyDetection {
  const corpus = messages.filter((m) => typeof m === 'string').join('\n');
  if (!corpus) return { country: null, confidence: 'medium' };

  // 1. Allowed list takes priority — first HIGH match wins.
  for (const rule of ALLOWED_RULES) {
    if (rule.high.some((p) => p.test(corpus))) {
      return { country: rule.country, confidence: 'high' };
    }
  }

  // 2. Disallowed HIGH matches — block.
  for (const rule of DISALLOWED_RULES) {
    if (rule.high.some((p) => p.test(corpus))) {
      return { country: rule.country, confidence: 'high' };
    }
  }

  // 3. Disallowed MEDIUM (timezone-only) matches — log but don't
  //    block. Caller checks `confidence === 'high'` before acting.
  for (const rule of DISALLOWED_RULES) {
    if (rule.medium && rule.medium.some((p) => p.test(corpus))) {
      return { country: rule.country, confidence: 'medium' };
    }
  }

  return { country: null, confidence: 'medium' };
}

/**
 * True when the country is in the first-world allowed list. Returns
 * true when the input is null/empty/unknown — when in doubt, NEVER
 * block. Only returns false on a confirmed match in the disallowed
 * set.
 */
export function isFirstWorldCountry(
  country: string | null | undefined
): boolean {
  if (!country) return true;
  const lower = country.trim().toLowerCase();
  if (!lower) return true;
  if (ALLOWED_NAMES.has(lower)) return true;
  // Match against disallowed list — anything not in disallowed AND
  // not in allowed is treated as allowed (unknown → pass through).
  for (const rule of DISALLOWED_RULES) {
    if (rule.country.toLowerCase() === lower) return false;
  }
  return true;
}

export const GEOGRAPHY_TAG_NAME = 'geography';

export const GEOGRAPHY_DEFAULT_EXIT_MESSAGE =
  "appreciate you reaching out bro 🙏🏿\nthe mentorship program is currently only available in certain regions — it's not the right fit right now\nbut check out my free youtube content in the meantime";
