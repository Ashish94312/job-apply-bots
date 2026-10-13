// Which jobs to apply to (ported from core.py). Loaded in the background worker, in job pages and in the tests.
(function (JB) {
  // Python's \w is Unicode-aware; JavaScript's isn't, so spell it out.
  const WORD = "[\\p{L}\\p{N}_]";
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const EXPERIENCE_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*(?:years?|yrs?)/i;

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
    if (roles.length && !roles.some(r => hasWord(job.title, r))) return "not an engineering role";
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

  JB.filters = { hasWord, minYears, tooSenior, previewOk, skipReason, uniqueUrls, slug };
})(globalThis.JB = globalThis.JB || {});
