// Who someone is at a company, from their LinkedIn headline (and their latest job, when known): a recruiter there,
// a recruiter at an agency, someone who used to work there, a manager, or someone else. Plain rules; recruiters.js
// writes to the people these score highest.
(function (JB) {
  // Recruiting words. HR, TA and HRBP only in capitals: "ta" and "hr" are parts of other words and names.
  const RECRUITER = /\b(recruit(?:er|ers|ing|ment)|talent acquisition|talent (?:partner|lead|scout|specialist|advisor|sourcer|team)|sourc(?:er|ing) (?:specialist|lead|partner)|sourcer|human resources|people (?:partner|operations|ops)|hiring (?:partner|specialist|lead|team))\b/i;
  const RECRUITER_CAPS = /\b(HR|TA|HRBP)\b/;
  const HIRING = /\b(we'?re hiring|we are hiring|is hiring|hiring now|actively hiring|#hiring|hiring)\b/i;
  // Agencies and freelancers recruit for clients, not for the company the job is at.
  const AGENCY = /\b(staffing|manpower|head ?hunt\w*|executive search|rpo|freelanc\w*|placements?|recruitment (?:agency|firm|consultancy|consultant)|(?:hr|recruitment|staffing) (?:consultancy|consultancies|solutions|services)|hiring for (?:top|multiple|various|leading|our|my) (?:clients?|companies|mncs|startups|organi[sz]ations|brands))\b/i;
  const EX_ROLE = /\b(?:ex|former|formerly|previously|retired)[\s-]+(?:recruit|hr\b|talent|people)/i;
  const MANAGER = /\b(engineering manager|hiring manager|head of|director|vp|vice president|cto|chief technology officer|co-?founder|founder|tech(?:nical)? lead|team lead|lead engineer|principal engineer)\b/i;
  const MANAGER_CAPS = /\bEM\b/;

  // Words in company names that don't tell companies apart.
  const SUFFIX = /\b(inc|incorporated|llc|llp|ltd|limited|pvt|private|plc|corp|corporation|co|company|gmbh|ag|sa|bv|technologies|technology|tech|labs|software|solutions|services|systems|india|global|group|holdings)\b\.?/g;

  const words = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** The part of a company's name that tells it apart: "Razorpay Software Pvt Ltd" -> "razorpay". */
  function companyKey(name) {
    const all = words(name);
    const key = all.replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
    return key || all; // a name that is only such words ("Tech Solutions") stays whole
  }

  /** Does the text name the company (as whole words)? */
  function mentions(text, company) {
    const key = companyKey(company);
    if (!key) return false;
    return new RegExp(`(^| )${esc(key)}( |$)`).test(words(text));
  }

  /** Says they used to work at the company: "Ex-Google", "Former recruiter at Flipkart". Each part of the headline
   * on its own ("Ex-Amazon | Recruiter at Microsoft" is at Microsoft now), the company at most 3 words after. */
  function formerly(text, company) {
    const key = companyKey(company);
    if (!key) return false;
    const re = new RegExp(`(^| )(?:ex|former|formerly|previously|past)( [^ ]+){0,3} ${esc(key)}( |$)`);
    return String(text || "").split(/[|,;•·/()[\]]+/).some(part => re.test(words(part)));
  }

  /**
   * Who someone is, for writing to them about a job at `company`.
   * `headline`: their headline. `opts.current`: their latest job's text, when known (from the profile).
   * `opts.isPoster`: they posted the job (LinkedIn's "Job poster").
   * Returns { role, score, why }: role is poster, recruiter, hiring, manager, agency, former or other; score 0 to 1.
   */
  function classify(headline, company, opts = {}) {
    const h = String(headline || "");
    const named = !!company && mentions(h, company);
    const current = opts.current;
    if (company && current && !mentions(current, company)) return { role: "former", score: 0, why: `their latest job isn't at ${company}` };
    if (company && formerly(h, company)) return { role: "former", score: 0, why: `used to work at ${company}` };
    if (opts.isPoster) return { role: "poster", score: 1, why: "posted this job" };
    if (EX_ROLE.test(h)) return { role: "other", score: 0.1, why: "used to recruit" };
    const recruiter = RECRUITER.test(h) || RECRUITER_CAPS.test(h);
    if ((recruiter || HIRING.test(h)) && AGENCY.test(h) && !named) return { role: "agency", score: 0, why: "recruits for an agency or for clients" };
    if (recruiter) return named ? { role: "recruiter", score: 0.9, why: `recruiter at ${company}` } : { role: "recruiter", score: 0.7, why: "recruiter" };
    if (MANAGER.test(h) || MANAGER_CAPS.test(h)) return { role: "manager", score: 0.6, why: "manager or lead" };
    if (HIRING.test(h)) return { role: "hiring", score: 0.5, why: "says they're hiring" };
    return { role: "other", score: 0.1, why: "not recruiting" };
  }

  /** The lowest score worth writing to. */
  const MIN_SCORE = 0.5;

  JB.roles = { classify, companyKey, mentions, formerly, MIN_SCORE };
})(globalThis.JB = globalThis.JB || {});
