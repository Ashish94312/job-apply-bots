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

  /** A question the way answers you gave are kept: any case, punctuation, "*" and "(required)" aside. */
  function questionKey(question) {
    return (question || "").toLowerCase()
      .replace(/\((required|optional)\)|\*/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s(required|optional)$/, "")
      .trim();
  }

  /** The first answer whose pattern matches the question; empty answers mean "leave it for me". A pattern
   * "=<question key>" is an answer you gave to that very question (store.effective puts those first). */
  function answerFor(label, answers) {
    let key = null;
    for (const [pattern, answer] of answers || []) {
      if (answer == null || answer === "") continue;
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

  const plain = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  /** Index of the option matching the answer (ignoring case and punctuation), else of one starting with it. */
  function pick(options, answer) {
    const want = plain(answer);
    if (!want) return null;
    for (const rule of [o => o === want, o => o.startsWith(want)]) {
      const k = options.findIndex(o => plain(o) && rule(plain(o)));
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

  const DAYS = { day: 1, week: 7, month: 30, year: 365 };
  const N = "(\\d+(?:\\.\\d+)?)";
  const UNIT = "(day|week|month|year)s?";
  const LENGTH_RES = [ // [regex, (numbers..., days per unit) -> range]; an open end leaves that number out ("less than 15")
    [new RegExp(`^${N}\\s*(?:-|–|to)\\s*${N}\\s*${UNIT}$`), (a, b, u) => ({ lo: a * u, hi: b * u })],
    [new RegExp(`^${N}\\s*${UNIT}\\s*(?:or|and)\\s*(?:less|below|fewer)$|^(?:up\\s*to|upto|within|max(?:imum)?)\\s*${N}\\s*${UNIT}$`), (n, u) => ({ lo: 0, hi: n * u })],
    [new RegExp(`^(?:less than|under|below|<)\\s*${N}\\s*${UNIT}$`), (n, u) => ({ lo: 0, hi: n * u, hiOpen: true })],
    [new RegExp(`^(?:more than|over|above|greater than|>)\\s*${N}\\s*${UNIT}$`), (n, u) => ({ lo: n * u, hi: Infinity, loOpen: true })],
    [new RegExp(`^${N}\\s*\\+\\s*${UNIT}$|^${N}\\s*${UNIT}\\s*(?:\\+|or more|and above)$`), (n, u) => ({ lo: n * u, hi: Infinity })],
    [new RegExp(`^${N}\\s*${UNIT}$`), (n, u) => ({ lo: n * u, hi: n * u })],
  ];

  /** A length of time like a notice period, in days: "1 Month" -> 30 to 30, "15 Days or less" -> 0 to 15,
   * "More than 3 Months" -> over 90, "Immediately" -> 0. Null for anything else. */
  function daysRange(text) {
    const t = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (/^(immediate(ly)?( joiner| joining)?|no notice( period)?)$/.test(t)) return { lo: 0, hi: 0 };
    for (const [re, range] of LENGTH_RES) {
      const m = re.exec(t);
      if (!m) continue;
      const got = m.slice(1).filter(Boolean); // the numbers, then the unit
      const unit = DAYS[got.pop()];
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

  /** For number boxes: "15 LPA" -> "15"; "+91 98765 43210" -> "919876543210". */
  function numberAnswer(answer) {
    if (/[a-z]/i.test(answer)) {
      const m = answer.match(/\d+(?:\.\d+)?/);
      return m ? m[0] : answer;
    }
    return answer.replace(/[^\d.]/g, "");
  }

  JB.answers = { questionKey, answerFor, badPatterns, coverNote, pick, pickSeveral, daysRange, pickDuration, numberAnswer };
})(globalThis.JB = globalThis.JB || {});
