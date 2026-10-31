// Where you are: the countries, with their calling code and currency, and the answers that depend on where you live
// and what you'd take (salary, notice period, city, relocating), written into your answers when you change them in
// Settings > Where you are. Loaded in the dashboard and the tests.
(function (JB) {
  // ISO code:calling code:currency. Names come from Intl, in English: what most application forms are in.
  const TABLE = [
    // Africa
    "DZ:213:DZD AO:244:AOA BJ:229:XOF BW:267:BWP BF:226:XOF BI:257:BIF CV:238:CVE CM:237:XAF CF:236:XAF TD:235:XAF",
    "KM:269:KMF CG:242:XAF CD:243:CDF CI:225:XOF DJ:253:DJF EG:20:EGP GQ:240:XAF ER:291:ERN SZ:268:SZL ET:251:ETB",
    "GA:241:XAF GM:220:GMD GH:233:GHS GN:224:GNF GW:245:XOF KE:254:KES LS:266:LSL LR:231:LRD LY:218:LYD MG:261:MGA",
    "MW:265:MWK ML:223:XOF MR:222:MRU MU:230:MUR MA:212:MAD MZ:258:MZN NA:264:NAD NE:227:XOF NG:234:NGN RW:250:RWF",
    "ST:239:STN SN:221:XOF SC:248:SCR SL:232:SLE SO:252:SOS ZA:27:ZAR SS:211:SSP SD:249:SDG TZ:255:TZS TG:228:XOF",
    "TN:216:TND UG:256:UGX ZM:260:ZMW ZW:263:USD",
    // Americas
    "AG:1:XCD AR:54:ARS BS:1:BSD BB:1:BBD BZ:501:BZD BO:591:BOB BR:55:BRL CA:1:CAD CL:56:CLP CO:57:COP CR:506:CRC",
    "CU:53:CUP DM:1:XCD DO:1:DOP EC:593:USD SV:503:USD GD:1:XCD GT:502:GTQ GY:592:GYD HT:509:HTG HN:504:HNL JM:1:JMD",
    "MX:52:MXN NI:505:NIO PA:507:USD PY:595:PYG PE:51:PEN PR:1:USD KN:1:XCD LC:1:XCD VC:1:XCD SR:597:SRD TT:1:TTD",
    "US:1:USD UY:598:UYU VE:58:VES",
    // Asia and the Middle East
    "AF:93:AFN AM:374:AMD AZ:994:AZN BH:973:BHD BD:880:BDT BT:975:BTN BN:673:BND KH:855:KHR CN:86:CNY GE:995:GEL",
    "HK:852:HKD IN:91:INR ID:62:IDR IR:98:IRR IQ:964:IQD IL:972:ILS JP:81:JPY JO:962:JOD KZ:7:KZT KW:965:KWD",
    "KG:996:KGS LA:856:LAK LB:961:LBP MO:853:MOP MY:60:MYR MV:960:MVR MN:976:MNT MM:95:MMK NP:977:NPR KP:850:KPW",
    "OM:968:OMR PK:92:PKR PS:970:ILS PH:63:PHP QA:974:QAR SA:966:SAR SG:65:SGD KR:82:KRW LK:94:LKR SY:963:SYP",
    "TW:886:TWD TJ:992:TJS TH:66:THB TL:670:USD TR:90:TRY TM:993:TMT AE:971:AED UZ:998:UZS VN:84:VND YE:967:YER",
    // Europe
    "AL:355:ALL AD:376:EUR AT:43:EUR BY:375:BYN BE:32:EUR BA:387:BAM BG:359:EUR HR:385:EUR CY:357:EUR CZ:420:CZK",
    "DK:45:DKK EE:372:EUR FI:358:EUR FR:33:EUR DE:49:EUR GR:30:EUR HU:36:HUF IS:354:ISK IE:353:EUR IT:39:EUR",
    "XK:383:EUR LV:371:EUR LI:423:CHF LT:370:EUR LU:352:EUR MT:356:EUR MD:373:MDL MC:377:EUR ME:382:EUR NL:31:EUR",
    "MK:389:MKD NO:47:NOK PL:48:PLN PT:351:EUR RO:40:RON RU:7:RUB SM:378:EUR RS:381:RSD SK:421:EUR SI:386:EUR",
    "ES:34:EUR SE:46:SEK CH:41:CHF UA:380:UAH GB:44:GBP",
    // Oceania
    "AU:61:AUD FJ:679:FJD KI:686:AUD MH:692:USD FM:691:USD NR:674:AUD NZ:64:NZD PW:680:USD PG:675:PGK WS:685:WST",
    "SB:677:SBD TO:676:TOP TV:688:AUD VU:678:VUV",
  ].join(" ").split(" ");
  const regionName = new Intl.DisplayNames(["en"], { type: "region" });
  // The name forms use where Intl's reads differently ("Hong Kong SAR China", "Türkiye")
  const NAMED = { HK: "Hong Kong", MO: "Macau", MM: "Myanmar", PS: "Palestine", CD: "Democratic Republic of the Congo",
    CG: "Republic of the Congo", CI: "Côte d'Ivoire", ST: "São Tomé and Príncipe", TR: "Turkey", KN: "Saint Kitts and Nevis",
    LC: "Saint Lucia", VC: "Saint Vincent and the Grenadines" };
  // ...and the other names a country goes by in job locations and questions
  const AKA = { US: ["united states of america", "usa", "u.s.", "u.s.a.", "america"],
    GB: ["uk", "u.k.", "great britain", "britain", "england", "scotland", "wales", "northern ireland"],
    AE: ["uae", "u.a.e."], NL: ["the netherlands", "holland"], DE: ["deutschland"], KR: ["korea", "republic of korea"],
    CZ: ["czech republic"], TR: ["türkiye", "turkiye"], CI: ["ivory coast"], CD: ["dr congo", "drc"], MM: ["burma"],
    RU: ["russian federation"], VN: ["viet nam"], MK: ["macedonia"], SZ: ["swaziland"] };
  const COUNTRIES = TABLE.map(entry => {
    const [code, dial, currency] = entry.split(":");
    return { code, name: NAMED[code] || regionName.of(code).replace(" & ", " and "), dial, currency };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const names = c => [c.name.toLowerCase(), ...(AKA[c.code] || [])];
  // What questions call its people ("Are you an Indian citizen?")
  const PEOPLE = { IN: "indian", US: "american", GB: "british", CA: "canadian", AU: "australian", NZ: "new zealand", IE: "irish",
    DE: "german", FR: "french", NL: "dutch", ES: "spanish", IT: "italian", PT: "portuguese", PL: "polish", SE: "swedish",
    CH: "swiss", SG: "singaporean", AE: "emirati", JP: "japanese", CN: "chinese", BR: "brazilian", MX: "mexican",
    PK: "pakistani", BD: "bangladeshi", LK: "sri lankan", NP: "nepali", PH: "filipino", NG: "nigerian", ZA: "south african" };

  /** The country with this name (any case, or a name it also goes by, like USA), or null. */
  function country(name) {
    const want = String(name || "").trim().toLowerCase();
    return want ? COUNTRIES.find(c => names(c).includes(want)) || null : null;
  }
  const byCode = code => COUNTRIES.find(c => c.code === code) || null;

  const PER = { year: "a year", month: "a month", hour: "an hour" };

  /** A salary the way to write it in a text box: "8 LPA" in India (what its forms ask in), else "65000 EUR a year".
   * In number boxes (lib/answers.js numberAnswer) that's 8 and 65000. Empty when there's no amount. */
  function salaryText(amount, currency, period = "year") {
    if (amount == null || amount === "") return "";
    if (currency === "INR" && period === "year") return `${+(amount / 1e5).toFixed(2)} LPA`;
    return [amount, currency, PER[period] || PER.year].filter(Boolean).join(" ");
  }

  // The answers where you are fills in: questions that show which of your answers is the one (the first it matches),
  // and a pattern for a new answer when none matches.
  const SLOTS = {
    notice: { asks: ["What is your notice period?", "Notice period (in days)"], pattern: "notice period" },
    current: {
      asks: ["What is your current CTC?", "Current salary", "Current annual compensation"],
      pattern: "current.*(ctc|salary|compensation)|(ctc|salary|compensation).*current",
    },
    expected: {
      asks: ["What is your expected CTC?", "Expected salary", "What are your salary expectations?"],
      pattern: "expect.*(ctc|salary|compensation)|(ctc|salary|compensation).*expect",
    },
    city: { asks: ["Current city", "Current location"], pattern: "current (city|location)" },
    relocate: { asks: ["Are you willing to relocate?"], pattern: "relocat" },
    countryCode: { asks: ["Country code"], pattern: "country code" },
  };
  const LIVES = "currently (living|located|residing|based) in";
  const SAMPLE = "India"; // what the sample settings search (LinkedIn, Wellfound) before you say where you are
  // Cities known by two names, so "Are you based in Bangalore?" counts for Bengaluru.
  const ALSO = [["bengaluru", "bangalore"], ["gurugram", "gurgaon"], ["mumbai", "bombay"], ["chennai", "madras"],
    ["kolkata", "calcutta"], ["delhi", "new delhi"], ["münchen", "munich"], ["köln", "cologne"], ["kyiv", "kiev"]];

  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = (pattern, question) => {
    try {
      return new RegExp(pattern, "i").test(question);
    } catch {
      return false;
    }
  };

  /** Give the slot's questions this answer, in rows of [pattern, answer]: in the row answering them now, unless that
   * row answers another slot's questions too (a broad "salary"), then in a new row just before it. True if it changed. */
  function put(rows, name, answer) {
    const slot = SLOTS[name];
    const others = Object.entries(SLOTS).filter(([n]) => n !== name).flatMap(([, s]) => s.asks);
    const k = rows.findIndex(([p]) => slot.asks.some(q => matches(p, q)));
    if (k >= 0 && !others.some(q => matches(rows[k][0], q))) {
      if (rows[k][1] === answer) return false;
      rows[k] = [rows[k][0], answer];
      return true;
    }
    if (!answer) return false;
    rows.splice(k >= 0 ? k : rows.length, 0, [slot.pattern, answer]);
    return true;
  }

  /** "Are you currently living in <where you are>?": Yes, in the row before the one answering it for anywhere else
   * (which says No). `before` are the places it said Yes for until now. True if it changed. */
  function putLivesIn(rows, places, before) {
    const asks = where => `Are you currently living in ${where}?`;
    const anywhere = p => matches(p, asks("Qqqq"));
    const k = rows.findIndex(([p]) => !anywhere(p) && (p.startsWith(`${LIVES} (`) || before.some(w => w && matches(p, asks(w)))));
    const row = [`${LIVES} (${places.map(escape).join("|")})`, "Yes"];
    if (!places.length) return k >= 0 && !!rows.splice(k, 1).length;
    if (k >= 0) {
      if (rows[k][0] === row[0] && rows[k][1] === row[1]) return false;
      rows[k] = row;
      return true;
    }
    const general = rows.findIndex(([p]) => anywhere(p));
    rows.splice(general >= 0 ? general : rows.length, 0, row);
    return true;
  }

  /** The names a city and country go by, for "currently living in (...)". */
  function placeNames(city, countryName) {
    const names = [city, countryName].map(s => String(s || "").trim().toLowerCase()).filter(Boolean);
    for (const pair of ALSO) if (pair.includes(names[0])) names.splice(1, 0, ...pair.filter(n => n !== names[0]));
    return [...new Set(names)];
  }

  /** You changed where you are (after.profile, from before.profile): put it in your answers, the shared ones and
   * LinkedIn's (number boxes: a salary is the plain amount), and in the places LinkedIn and Wellfound search where
   * those were your country. Changes `after`; returns how many answers and places changed. */
  function apply(before, after) {
    const was = before.profile || {}, now = after.profile;
    const changed = (...fields) => fields.some(f => (was[f] ?? "") !== (now[f] ?? ""));
    const here = country(now.country);
    const tables = [[now.answers, false]];
    if (after.sites.linkedin?.answers?.length) tables.push([after.sites.linkedin.answers, true]);
    let answers = 0;
    for (const [rows, numbers] of tables) {
      const salary = amount => (numbers ? (amount == null ? "" : String(amount)) : salaryText(amount, now.currency, now.salaryPeriod));
      const done = [
        changed("noticePeriod") && put(rows, "notice", (now.noticePeriod || "").trim()),
        changed("currentSalary", "currency", "salaryPeriod") && put(rows, "current", salary(now.currentSalary)),
        changed("expectedSalary", "currency", "salaryPeriod") && put(rows, "expected", salary(now.expectedSalary)),
        changed("city") && put(rows, "city", (now.city || "").trim()),
        changed("relocate") && put(rows, "relocate", now.relocate || ""),
        changed("country") && here && put(rows, "countryCode", `${here.name} (+${here.dial})`),
        changed("city", "country") && putLivesIn(rows, placeNames(now.city, now.country), placeNames(was.city, was.country)),
      ];
      answers += done.filter(Boolean).length;
    }

    let places = 0;
    if (changed("country") && here) {
      const old = (was.country || SAMPLE).trim();
      for (const site of Object.values(after.sites)) {
        if (!Array.isArray(site.locations)) continue;
        site.locations = site.locations.map(l => {
          if (l === JB.filters.slug(old)) return places++, JB.filters.slug(here.name); // Wellfound's "india"
          if (l.toLowerCase() === old.toLowerCase()) return places++, here.name;
          return l;
        });
      }
    }
    return { answers, places };
  }

  // ------------------------------------------------------------ jobs abroad: which country a job is in

  const US_STATES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
    "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
    "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
    "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
    "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
    "wisconsin", "wyoming", "district of columbia"]; // not Georgia: a country too
  const US_CODES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH "
    + "OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split(" ");
  const CA_CODES = "ON BC QC AB MB NS NB SK PE NL".split(" ");
  const CA_PROVINCES = ["ontario", "british columbia", "quebec", "alberta", "manitoba", "nova scotia", "new brunswick", "saskatchewan"];
  // Cities jobs are often in, written alone ("London", "Remote - Berlin")
  const CITIES = {
    IN: "bengaluru|bangalore|mumbai|delhi|new delhi|gurugram|gurgaon|noida|hyderabad|pune|chennai|kolkata|ahmedabad|kochi|jaipur|chandigarh|indore|coimbatore|thiruvananthapuram",
    US: "new york city|nyc|san francisco|seattle|austin|boston|los angeles|chicago|san jose|palo alto|mountain view|menlo park|sunnyvale|denver|atlanta|miami",
    GB: "london|manchester|edinburgh|bristol|glasgow|leeds", DE: "berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart",
    FR: "paris|lyon", NL: "amsterdam|rotterdam|utrecht|eindhoven", IE: "dublin", ES: "madrid|barcelona", PT: "lisbon|lisboa|porto",
    SE: "stockholm", DK: "copenhagen", NO: "oslo", FI: "helsinki", CH: "zurich|zürich|geneva", AT: "vienna", PL: "warsaw|krakow|kraków",
    CZ: "prague", CA: "toronto|vancouver|montreal|ottawa|calgary", AU: "sydney|melbourne|brisbane", NZ: "auckland",
    SG: "singapore", AE: "dubai|abu dhabi", JP: "tokyo|osaka", KR: "seoul", CN: "beijing|shanghai|shenzhen", TW: "taipei",
    IL: "tel aviv", BR: "são paulo|sao paulo|rio de janeiro", MX: "mexico city", AR: "buenos aires", ZA: "cape town|johannesburg",
    NG: "lagos", KE: "nairobi", EG: "cairo", ID: "jakarta", MY: "kuala lumpur", TH: "bangkok", VN: "ho chi minh city|hanoi",
    PH: "manila", PK: "karachi|lahore", BD: "dhaka", LK: "colombo", SA: "riyadh", QA: "doha",
  };
  const CITY = new Map(Object.entries(CITIES).flatMap(([code, list]) => list.split("|").map(c => [c, code])));

  /** The country a job location is in: "London, England, United Kingdom", "San Francisco, CA", "Remote - US",
   * "Bengaluru". Null when it names none, or more than one ("US or Canada", "EMEA"). */
  function countryIn(location) {
    const found = new Set();
    for (const raw of String(location || "").split(/[,;·|()/•]| - | – /)) {
      const part = raw.replace(/^\s*(remote|hybrid|on-?site)\b\s*(in\b)?/i, "").trim(), low = part.toLowerCase();
      if (!low) continue;
      if (US_STATES.includes(low) || US_CODES.includes(part)) found.add("US");
      else if (CA_PROVINCES.includes(low) || CA_CODES.includes(part)) found.add("CA");
      else if (part === "US" || part === "UK") found.add(part === "US" ? "US" : "GB");
      else if (CITY.has(low)) found.add(CITY.get(low));
      else {
        const c = low.length > 2 && country(low);
        if (c) found.add(c.code);
      }
    }
    return found.size === 1 ? byCode([...found][0]) : null;
  }

  /** The country the job is in: the site's own (India's job sites), else where the job page says, else the
   * place it was searched in. Null when none of those says. */
  function jobCountry(job, site) {
    if (site?.country) return byCode(site.country);
    return countryIn(job.where) || countryIn(job.place);
  }

  /** What you are in this country: "citizen", "allowed" (to work), "visa" (you'd need one), "lives" (where you
   * live, not in your list: allowed, citizen unknown); null for a country you didn't list. */
  function standing(cfg, c) {
    if (!c) return null;
    const row = (cfg.workIn || []).find(r => country(r.country)?.code === c.code);
    if (row) return row.can;
    return country(cfg.country)?.code === c.code ? "lives" : null;
  }

  const WITHOUT = "(authori[sz]ed|eligible|able|legally|right).{0,80}without.{0,40}(sponsor|visa)";
  const SPONSOR = "(require|need)\\w*.{0,60}(sponsor|visa|work permit)|sponsorship.{0,20}(required|needed)|visa sponsorship";
  const PERMIT = "authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (allowed|entitled|permitted|able|eligible) to work|right to work|permitted to work|allowed to work|work permit|work visa";
  const ASK = JB.answers.ASK;
  const said = (yes, can) => (can == null ? ASK : yes ? "Yes" : "No");

  /** Rows of [pattern, answer] for questions about working in a country: the one `named` (a pattern for its names),
   * or with none, "the country for which you're applying". Sponsorship, a work permit, and when it's named,
   * citizenship ("Are you a US citizen?"; a list of sanctioned countries' citizens names none of yours). */
  function permitRows(can, named = "") {
    const about = p => (named ? `^(?=.*(${p}))(?=.*${named})` : p);
    const rows = [
      [about(WITHOUT), said(can && can !== "visa", can)],
      [about(SPONSOR), said(can === "visa", can)],
      [about(PERMIT), said(can && can !== "visa", can)],
    ];
    if (named) rows.push([about("citizen"), can === "lives" ? ASK : said(can === "citizen", can)]);
    return rows;
  }

  /** The run's settings for one job, when you've said where you can work (Settings > Where you are): questions
   * naming a country answered for that country, the other permit and visa questions for the job's country (asked
   * when it isn't known), and the expected salary you gave for working there. These come before every other
   * answer, those you gave when it asked too: they were for another job's country. Your answers as they are
   * without the list. `run` is the run's own, for answers kept on the way. */
  function forJob(cfg, job, site) {
    const list = (cfg.workIn || []).filter(r => country(r.country));
    if (!list.length) return cfg;
    const home = country(cfg.country);
    const rows = [];
    for (const c of new Set([...list.map(r => country(r.country)), home].filter(Boolean))) {
      const named = `(?<![a-z])(${[...names(c), PEOPLE[c.code]].filter(Boolean).map(escape).join("|")})(?![a-z])`;
      rows.push(...permitRows(standing(cfg, c), named));
    }
    const where = jobCountry(job, site);
    rows.push(...permitRows(standing(cfg, where)));
    if (!where || where.code !== home?.code) { // abroad, or maybe: the salary for there, never the one for home
      const row = where && list.find(r => country(r.country).code === where.code);
      const amount = row?.salary;
      const numbers = site?.name === "linkedin"; // its number boxes, like its own answers
      const text = amount == null || amount === "" ? ASK
        : numbers ? String(amount) : salaryText(amount, row.currency || where.currency, cfg.salaryPeriod);
      rows.push([SLOTS.expected.pattern, text]);
    }
    return { ...cfg, answers: [...rows, ...cfg.answers], run: cfg.run || cfg, jobCountry: where?.name || "" };
  }

  const SPONSORS_RE = /visa sponsorship (is )?(available|provided|offered)|(we|will|can|do) sponsor (work )?visas?|sponsorship (is )?available/i;
  const NO_SPONSOR_RE = new RegExp([
    "\\b(no|not|unable to|cannot|can't|won't|will not|do not|don't|does not|doesn't)\\b[^.]{0,40}\\bsponsor",
    "without (the need for |requiring )?(visa |employer )?sponsorship", "must (already )?(have|hold) (the |full )?right to work",
    "\\b(us|u\\.s\\.) citizens? only", "(us|u\\.s\\.) citizenship (is )?required", "security clearance",
  ].join("|"), "i");

  /** Why not to apply to this job, given where you can work, or null: it's in a country you didn't list, or one
   * you'd need a visa for while it says it won't sponsor one. Nothing without the list, or when the country isn't known. */
  function skipReason(job, cfg, site) {
    if (!(cfg.workIn || []).some(r => country(r.country))) return null;
    const where = jobCountry(job, site);
    const can = standing(cfg, where);
    if (where && !can) return `in ${where.name}, not a country you can work in`;
    if (can === "visa" && NO_SPONSOR_RE.test(job.text || "") && !SPONSORS_RE.test(job.text || "")) return `in ${where.name}, says no visa sponsorship`;
    return null;
  }

  JB.places = { COUNTRIES, country, salaryText, apply, countryIn, jobCountry, forJob, skipReason };
})(globalThis.JB = globalThis.JB || {});
