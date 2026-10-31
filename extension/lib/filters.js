// Which jobs to apply to (ported from core.py). Loaded in the background worker, in job pages and in the tests.
(function (JB) {
  // Python's \w is Unicode-aware; JavaScript's isn't, so spell it out.
  const WORD = "[\\p{L}\\p{N}_]";
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "3 - 5 years" in the languages jobs are posted in: Jahre, ans, años, anos, anni, jaar, lat, år, лет, 年, 년;
  // "3 bis 5", "3 à 5", "3 a 5", "3 tot 5", "3〜5".
  // A short word ("ans", "lat") only on its own, not "3-5 answers"; the rest even run into the next ("5-8 YrsBengaluru").
  const YEARS = "(?:years?|yrs?|jahren?|ann[ée]es|años|anni|jaren|jaar|лет|года?|年|년|(?:ans|anos|lata?|år)(?!\\p{L}))";
  const TO = "(?:-|–|—|~|〜|～|to|a|à|bis|tot|al|till)";
  const RANGE = `(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*${TO}\\s*\\d+(?:\\.\\d+)?\\s*${YEARS}`;
  const EXPERIENCE_RE = new RegExp(RANGE, "iu");

  function hasWord(text, word) {
    return new RegExp(`(?<!${WORD})${escape(String(word))}(?!${WORD})`, "iu").test(text || "");
  }

  /** Minimum experience asked for: the first "X - Y years" in the text (job pages show it in the header). */
  function minYears(text) {
    const m = EXPERIENCE_RE.exec(text || "");
    return m ? parseFloat(m[1]) : null;
  }

  function tooSenior(text, filters) {
    const max = filters.maxExperienceRequired;
    const needed = minYears(text);
    return max != null && needed != null && needed > max ? needed : null;
  }

  /** Cheap check on the search-results text, before opening the job page. */
  function previewOk(preview, filters) {
    if (!preview) return true;
    if (tooSenior(preview, filters)) return false;
    const include = filters.includeTitle || [];
    if (include.length && !include.some(k => hasWord(preview, k))) return false;
    return !(filters.excludeCompanies || []).some(c => preview.toLowerCase().includes(c.toLowerCase()));
  }

  /** Why to skip this job, or null to apply. */
  function skipReason(job, filters) {
    if (!job.title) return "couldn't read job title";
    const needed = tooSenior(job.text, filters);
    if (needed) return `needs ${needed}+ yrs`;
    const include = filters.includeTitle || [];
    if (include.length && !include.some(k => hasWord(job.title, k))) return "title not in include_title";
    const roles = filters.requireRole || [];
    if (roles.length && !roles.some(r => hasWord(job.title, r))) return "not one of your roles"; // the Python bots: "not an engineering role"
    for (const k of filters.excludeTitle || []) if (hasWord(job.title, k)) return `title has '${k}'`;
    for (const c of filters.excludeCompanies || []) {
      if ((job.company || "").toLowerCase().includes(c.toLowerCase())) return `company '${c}' excluded`;
    }
    for (const k of filters.excludeText || []) if (hasWord(job.text, k)) return `description mentions '${k}'`;
    return null;
  }

  /** Keyword searches first, extra URLs after; drop repeats (ignoring case). */
  function uniqueUrls(urls) {
    const seen = new Set();
    return urls.filter(url => !seen.has(url.toLowerCase()) && seen.add(url.toLowerCase()));
  }

  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // Ready-made lists for "...and is a role like" (Settings > Which jobs), one per kind of work.
  const FIELDS = {
    "Software and IT": "engineer, developer, programmer, sde, swe, architect, devops, sre, administrator, tester, qa",
    "AI and data science": "data scientist, scientist, machine learning, ml, ai, engineer, researcher, statistician",
    "Data and analytics": "analyst, analytics, data scientist, statistician, business intelligence, bi",
    "Design": "designer, ux, ui, user researcher, illustrator, art director, animator",
    "Product and project management": "product manager, product owner, program manager, project manager, scrum master",
    "Marketing": "marketing, marketer, seo, brand, growth, social media, communications, copywriter, content",
    "Sales and business development": "sales, account executive, business development, sdr, bdr, account manager, partnerships",
    "Customer support and success": "support, customer success, customer service, customer experience, help desk, client services",
    "Finance and accounting": "accountant, accounting, finance, financial, auditor, controller, tax, bookkeeper, treasury",
    "HR and recruiting": "recruiter, recruiting, talent acquisition, hr, human resources, people partner, hrbp, payroll",
    "Operations and supply chain": "operations, supply chain, logistics, procurement, purchasing, coordinator, planner",
    "Healthcare": "nurse, nursing, doctor, physician, pharmacist, therapist, medical, clinical, dentist, caregiver",
    "Teaching and training": "teacher, tutor, lecturer, professor, instructor, trainer, educator, faculty",
    "Writing and content": "writer, editor, copywriter, content, journalist, translator",
    "Legal": "lawyer, attorney, counsel, paralegal, legal, advocate, solicitor",
  };
  const fieldRoles = name => (FIELDS[name] || "").split(",").map(r => r.trim()).filter(Boolean);

  /** Your filters with a field's roles as "...and is a role like" (any title among them: "Title has one of" emptied),
   * and its roles out of "Skip titles with" ("manager" goes for product managers, "sales" for sales). */
  function forField(filters, name) {
    const roles = fieldRoles(name);
    const clash = word => roles.some(r => hasWord(r, word) || hasWord(word, r));
    return { ...filters, includeTitle: [], requireRole: roles, excludeTitle: (filters.excludeTitle || []).filter(w => !clash(w)) };
  }

  JB.filters = { hasWord, minYears, tooSenior, previewOk, skipReason, uniqueUrls, slug, RANGE, FIELDS, forField };
})(globalThis.JB = globalThis.JB || {});
