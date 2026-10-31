// Answers to screening questions (ported from core.py). Loaded in job pages, the dashboard and the tests.
(function (JB) {
  const cache = new Map();

  /** The pattern as a case-insensitive regex, or null if it isn't a valid one. */
  function compile(pattern) {
    if (!cache.has(pattern)) {
      try {
        cache.set(pattern, new RegExp(pattern, "i"));
      } catch {
        cache.set(pattern, null);
      }
    }
    return cache.get(pattern);
  }

  /** Text the way it's compared: lower case, accents off ("Kündigung" -> "kundigung"), full-width letters as plain
   * ones. Only the marks on Latin, Greek and Cyrillic letters go: other scripts' marks change the word. */
  const fold = s => (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase();

  /** A question the way answers you gave are kept: any case, accents, punctuation, "*" and "(required)" aside. */
  function questionKey(question) {
    return fold(question)
      .replace(/\((required|optional)\)|\*/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s(required|optional)$/, "")
      .trim();
  }

  // An answer meaning "ask me": the question is left for you even if a later pattern has an answer for it (one
  // that depends on the job, like a work permit for its country, when that isn't known: lib/places.js forJob).
  const ASK = "\u0000ask";

  /** The first answer whose pattern matches the question; empty answers mean "leave it for me". A pattern
   * "=<question key>" is an answer you gave to that very question (store.effective puts those first). */
  function answerFor(label, answers) {
    let key = null;
    for (const [pattern, answer] of answers || []) {
      if (answer == null || answer === "") continue;
      if (answer === ASK) {
        if (compile(pattern)?.test(label || "")) return null;
        continue;
      }
      if (pattern.startsWith("=")) {
        if (pattern.slice(1) === (key ??= questionKey(label))) return String(answer);
        continue;
      }
      const re = compile(pattern);
      if (re && re.test(label || "")) return String(answer);
    }
    return null;
  }

  const badPatterns = answers => (answers || []).map(([pattern]) => pattern).filter(p => !p || !compile(p));

  /** The cover note with {title} and {company} filled in. */
  function coverNote(note, job) {
    note = (note || "").trim();
    if (job) note = note.replaceAll("{title}", job.title || "this role").replaceAll("{company}", job.company || "your company");
    return note;
  }

  const plain = s => fold(s).replace(/[^\p{L}\p{N}]+/gu, "");

  // Not saying, the many ways forms put it: "Decline To Self Identify", "I don't wish to answer", "Prefer not to say"
  const DECLINE_RE = /decline|(don.?t|do not) (wish|want) to|prefer not|rather not|choose not|not (to )?(say|disclose|answer)|not specified|not declared/i;

  /** Index of the option matching the answer (ignoring case and punctuation), else of one starting with it; for an
   * answer declining to say, the option that declines, however it's worded. */
  function pick(options, answer) {
    const want = plain(answer);
    if (!want) return null;
    for (const rule of [o => o === want, o => o.startsWith(want)]) {
      const k = options.findIndex(o => plain(o) && rule(plain(o)));
      if (k >= 0) return k;
    }
    if (DECLINE_RE.test(answer)) {
      const k = options.findIndex(o => DECLINE_RE.test(o || ""));
      if (k >= 0) return k;
    }
    return null;
  }

  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** "Select all that apply": the options the answer lists, comma separated (indexes). An option that has a comma
   * of its own ("Cuba, Iran, North Korea, or Syria") counts when it's in the answer whole. */
  function pickSeveral(options, answer) {
    const parts = (answer || "").split(/[,;|]/).map(plain).filter(Boolean);
    const said = (answer || "").toLowerCase();
    return options.map((o, k) => [String(o || ""), k]).filter(([o]) => {
      if (!plain(o)) return false;
      if (parts.includes(plain(o))) return true;
      const whole = o.toLowerCase().trim();
      return /[,;|]/.test(whole) && new RegExp(`(^|[,;|]\\s*)${escape(whole)}\\s*($|[,;|])`).test(said);
    }).map(([, k]) => k);
  }

  // Lengths of time in English, German, French, Spanish, Portuguese, Italian, Dutch and Polish, accents off (fold):
  // each unit's words and its days, then the words around the numbers.
  const UNITS = [
    [1, "days?|tagen?|tage|jours?|dias?|giorni|giorno|dagen|dag|dni|dzien"],
    [7, "weeks?|wochen?|semaines?|semanas?|settimane|settimana|weken|tygodni[ea]?|tydzien"],
    [30, "months?|monaten?|monate|monat|mois|meses|mes|mesi|mese|maanden|maand|miesiac[ey]?|miesiecy"],
    [365, "years?|jahren?|jahre|jahr|ans?|annees?|anos?|anni|anno|jaren|jaar|lata?|rok"],
  ];
  const unitDays = word => UNITS.find(([, words]) => new RegExp(`^(?:${words})$`).test(word))[0];
  const N = "(\\d+(?:\\.\\d+)?)";
  const UNIT = `(${UNITS.map(([, words]) => words).join("|")})`;
  const TO = "(?:-|–|to|bis|a|tot|al|y|e|do)";
  const OR = "(?:or|and|oder|und|ou|et|o|y|e|of|en|lub)";
  const LESS = "(?:less|below|fewer|weniger|moins|menos|meno|minder|mniej)";
  const MORE = "(?:more|above|mehr|plus|mas|mais|piu|meer|wiecej)";
  const UP_TO = "(?:up\\s*to|upto|within|max(?:imum)?|bis zu|jusqu'?a|hasta|ate|fino a|tot|do)";
  const LESS_THAN = "(?:less than|under|below|<|weniger als|unter|moins de|menos de|meno di|minder dan|mniej niz|ponizej)";
  const MORE_THAN = "(?:more than|over|above|greater than|>|mehr als|uber|plus de|mas de|mais de|piu di|meer dan|wiecej niz|powyzej)";
  const FROM = "(?:(?:from|von|de|da|entre|van|od) )?";
  const LENGTH_RES = [ // [regex, (numbers..., days per unit) -> range]; an open end leaves that number out ("less than 15")
    [new RegExp(`^${FROM}${N}\\s*${TO}\\s*${N}\\s*${UNIT}$`), (a, b, u) => ({ lo: a * u, hi: b * u })],
    [new RegExp(`^${N}\\s*${UNIT}\\s*${OR}\\s*${LESS}$|^${UP_TO}\\s*${N}\\s*${UNIT}$`), (n, u) => ({ lo: 0, hi: n * u })],
    [new RegExp(`^${LESS_THAN}\\s*${N}\\s*${UNIT}$`), (n, u) => ({ lo: 0, hi: n * u, hiOpen: true })],
    [new RegExp(`^${MORE_THAN}\\s*${N}\\s*${UNIT}$`), (n, u) => ({ lo: n * u, hi: Infinity, loOpen: true })],
    [new RegExp(`^${N}\\s*\\+\\s*${UNIT}$|^${N}\\s*${UNIT}\\s*(?:\\+|${OR}\\s*${MORE}|and above)$`), (n, u) => ({ lo: n * u, hi: Infinity })],
    [new RegExp(`^${N}\\s*${UNIT}$`), (n, u) => ({ lo: n * u, hi: n * u })],
  ];
  const IMMEDIATE_RE = new RegExp("^(immediate(ly)?( joiner| joining)?|no notice( period)?|(ab )?sofort|immediatement|"
    + "(tout )?de suite|inmediat(o|a|amente)|imediat(o|a|amente)|subito|immediatamente|(per )?direct|natychmiast)$");

  /** A length of time like a notice period, in days: "1 Month" -> 30 to 30, "15 Days or less" -> 0 to 15,
   * "More than 3 Months" -> over 90, "Immediately" -> 0; "3 Monate", "moins de 15 jours" too. Null for anything else. */
  function daysRange(text) {
    const t = fold(text).replace(/\s+/g, " ").trim();
    if (IMMEDIATE_RE.test(t)) return { lo: 0, hi: 0 };
    for (const [re, range] of LENGTH_RES) {
      const m = re.exec(t);
      if (!m) continue;
      const got = m.slice(1).filter(Boolean); // the numbers, then the unit
      const unit = unitDays(got.pop());
      return range(...got.map(Number), unit);
    }
    return null;
  }

  /** For an answer that's a length of time ("30 days"): the option covering it ("1 Month", "15-30 days"). A single
   * length beats a range, a narrower range a wider one; two that fit equally well, or none, give null. */
  function pickDuration(options, answer) {
    const want = daysRange(answer);
    if (!want || want.lo !== want.hi) return null;
    const d = want.lo;
    const covers = r => (r.lo < d || (r.lo === d && !r.loOpen)) && (d < r.hi || (d === r.hi && !r.hiOpen));
    const fits = options.map((o, k) => [k, daysRange(o)]).filter(([, r]) => r && covers(r)).map(([k, r]) => [k, r.hi - r.lo]);
    fits.sort((a, b) => a[1] - b[1]);
    if (!fits.length || (fits.length > 1 && fits[0][1] === fits[1][1])) return null;
    return fits[0][0];
  }

  /** For date boxes: an answer that's a date ("2026-12-01") or a length of time from today ("30 days", "Immediately"),
   * written the way the box wants it: "iso" for a date input, else its placeholder ("MM/DD/YYYY", "dd.mm.yyyy").
   * Null when it's neither, or the placeholder isn't a date's. */
  function dateAnswer(answer, format = "iso", today = new Date()) {
    let d = null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(answer || "").trim());
    const range = !iso && daysRange(answer);
    if (iso) d = new Date(+iso[1], iso[2] - 1, +iso[3]);
    else if (range && range.lo === range.hi) d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + range.lo);
    if (!d) return null;
    const p = n => String(n).padStart(2, "0");
    const parts = { yyyy: String(d.getFullYear()), mm: p(d.getMonth() + 1), dd: p(d.getDate()) };
    if (format === "iso") return `${parts.yyyy}-${parts.mm}-${parts.dd}`;
    const m = /^(dd|mm|yyyy)([./ -])(dd|mm|yyyy)\2(dd|mm|yyyy)$/i.exec(String(format).trim());
    return m ? [m[1], m[3], m[4]].map(k => parts[k.toLowerCase()]).join(m[2]) : null;
  }

  /** For number boxes: "15 LPA" -> "15"; "+91 98765 43210" -> "919876543210". */
  function numberAnswer(answer) {
    if (/[a-z]/i.test(answer)) {
      const m = answer.match(/\d+(?:\.\d+)?/);
      return m ? m[0] : answer;
    }
    return answer.replace(/[^\d.]/g, "");
  }

  JB.answers = { ASK, fold, plain, questionKey, answerFor, badPatterns, coverNote, pick, pickSeveral, daysRange, pickDuration, dateAnswer, numberAnswer };
})(globalThis.JB = globalThis.JB || {});
