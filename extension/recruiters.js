// Writing to the recruiters hiring for the jobs you applied to, on LinkedIn. Runs in the background worker as the
// "reach" action; the page work is in sites/linkedin.js, and the messaging and inviting is referral.js's.
//
// For each job applied to recently (plus any job link in the settings) it opens the job and:
//   - writes to whoever posted it (LinkedIn's "Meet the hiring team" card), if anyone did;
//   - else searches the company's employees for recruiters (3rd-degree too: recruiters often are), and picks by
//     their headline (lib/roles.js): recruiters at the company first, never agencies or people who left.
// People you're connected with get the message; the others an invite with a short note, and the message on a later
// run once they've accepted. One person per company by default, a daily cap shared with referrals, and nobody is
// contacted twice, for a referral or as a recruiter.
(function (JB) {
  const BASE = "https://www.linkedin.com";
  const KIND = "recruiter";
  const SEARCH = ["recruiter", "talent acquisition"];
  const MANAGER_SEARCH = ["engineering manager", "hiring manager"];
  const EVERYONE = ["F", "S", "O"]; // 1st, 2nd and 3rd+ degree

  const L = () => JB.referral; // finding, messaging and inviting, shared with referrals

  async function run(r, cfg) {
    const rc = cfg.recruiter || {};
    if (!(rc.message || "").trim()) {
      r.log("Write the recruiter message in Settings > Sites > LinkedIn first.");
      return;
    }
    if (!r.dry && /<[^<>\n]+>/.test(rc.message)) {
      r.log("The recruiter message still has a <...> placeholder. Write that part in Settings, then run again.");
      return;
    }
    const budget = await L().todaysBudget(r, cfg, r.opts.max || rc.maxPerRun || 5);
    if (budget <= 0) return;
    const state = { kind: KIND, notesUsedUp: false, dryAsked: {} }; // dryAsked: company -> people a dry run would have written to
    let sent = 0;
    try {
      sent += await L().followUp(r, rc, budget, state);
      const forJobs = rc.forJobs && rc.forJobs.length ? rc.forJobs : ["applied"];
      const jobs = [...(await JB.store.jobsToAsk("linkedin", forJobs, rc.withinDays ?? 14, KIND)), ...(await extraJobs(r, rc))];
      r.log();
      r.log(`${jobs.length} job(s) to find the recruiter for.`);
      for (const job of jobs) {
        if (sent >= budget) break;
        try {
          sent += await reachAtCompany(r, rc, job, budget - sent, state);
        } catch (e) {
          if (e.stopReferrals || r.isStop(e)) throw e;
          r.log(`  x ${L().firstLine(e)}`);
        }
      }
    } catch (e) {
      if (!e.stopReferrals) throw e;
      r.log();
      r.log(e.stopReferrals);
    }
    r.log();
    r.log(`Done: ${r.dry ? "would contact" : "contacted"} ${sent}.`);
  }

  async function extraJobs(r, rc) {
    const jobs = [];
    for (const url of rc.jobs || []) {
      const m = JB.sites.linkedin.jobUrlRe.exec(url || "");
      if (!m) r.log(`Not a LinkedIn job link, skipped: ${url}`);
      else if (!(await JB.store.askedAbout(m[1], KIND))) jobs.push({ url: `${BASE}/jobs/view/${m[1]}/`, jobId: m[1], title: "", company: "" });
    }
    return jobs;
  }

  /** Which kinds of people to write to (lib/roles.js roles): the job's poster and recruiters, unless set otherwise. */
  function wanted(rc) {
    const targets = new Set(rc.targets && rc.targets.length ? rc.targets : ["poster", "recruiter"]);
    const roles = new Set();
    if (targets.has("poster")) roles.add("poster");
    if (targets.has("recruiter")) ["recruiter", "hiring"].forEach(x => roles.add(x));
    if (targets.has("manager")) roles.add("manager");
    return { targets, roles };
  }

  /** Find who's hiring for the job and write to up to perCompany of them. Returns how many. */
  async function reachAtCompany(r, rc, job, budget, state) {
    const finish = async (status, note = "") => {
      if (!r.dry) await JB.store.jobDone(job, status, note, KIND);
    };
    r.step(`Finding who's hiring at ${job.company || "the company"}`);
    await r.goto(job.url);
    if (!(await r.waitFor(JB.sites.linkedin.jobReadyCss, 15000))) {
      r.log();
      r.log(job.url);
      r.log("  x couldn't open the job");
      return 0;
    }
    await r.sleep(2000);
    job = { ...job, ...(await r.exec("site.readJob")) };
    const companyUrl = await r.exec("site.companyUrl");
    r.log();
    r.log(`${job.title || "?"} @ ${job.company || "?"}  ${job.url}`);
    const key = companyUrl || `company:${(job.company || job.jobId).toLowerCase()}`; // counts people per company
    const asked = (await JB.store.askedAt(key, KIND)) + (state.dryAsked[key] || 0);
    const want = (rc.perCompany ?? 1) - asked;
    if (want <= 0) {
      r.log(`  = already wrote to ${asked} at ${job.company}`);
      await finish("already_asked");
      return 0;
    }

    const people = await findPeople(r, rc, job, companyUrl, want);
    if (!people.length) {
      r.log(companyUrl ? "  - no recruiter found for it" : "  - nobody posted it, and the job doesn't link to a LinkedIn company page");
      await finish(companyUrl ? "nobody_found" : "no_company");
      return 0;
    }

    let sent = 0;
    for (const person of people.slice(0, want * 3)) { // don't open every profile if several don't work out
      if (sent >= Math.min(want, budget)) break;
      r.log(`  ${person.name}: ${person.why}`);
      if (await L().contact(r, rc, person, job, key, state)) sent++;
    }
    if (r.dry) state.dryAsked[key] = (state.dryAsked[key] || 0) + sent;
    if (sent < want && sent >= budget) return sent; // out of today's budget: this company gets the rest next run
    await finish(sent ? "asked" : "nobody_reached", `${sent} contacted`);
    return sent;
  }

  /** People to write to about the job, best first: its poster, then recruiters found at the company. */
  async function findPeople(r, rc, job, companyUrl, want) {
    const { targets, roles } = wanted(rc);
    const skip = rc.skipHeadline || [];
    const found = new Map();
    const consider = async (p, isPoster = false) => { // p: {profile, name, headline, degree}
      const profile = p.profile;
      if (found.has(profile) || (await JB.store.knownContact(profile))) return;
      if (skip.some(word => JB.filters.hasWord(p.headline, word))) return;
      const c = JB.roles.classify(p.headline, job.company, { isPoster });
      if (!roles.has(c.role) || c.score < JB.roles.MIN_SCORE) return;
      found.set(profile, { profile, name: p.name, headline: p.headline, degree: p.degree, score: c.score, role: c.role, why: c.why });
    };

    if (targets.has("poster") || targets.has("recruiter")) { // the card lists recruiters too, not only the poster
      if (await r.waitForTrue("site.hasHiringTeam", 5000)) {
        for (const p of await r.exec("site.hiringTeam")) await consider({ ...p, profile: `${BASE}/in/${p.slug}/` }, p.isPoster);
      }
    }
    if (found.size < want && companyUrl && (targets.has("recruiter") || targets.has("manager"))) {
      const ids = await L().companyIds(r, companyUrl);
      if (!ids.length) r.log(`  - couldn't find ${job.company}'s employee list on ${companyUrl}`);
      const searches = [
        ...(targets.has("recruiter") ? (rc.searchKeywords && rc.searchKeywords.length ? rc.searchKeywords : SEARCH) : []),
        ...(targets.has("manager") ? MANAGER_SEARCH : []),
      ];
      for (const keywords of ids.length ? searches : []) {
        for (const p of await L().searchPeople(r, ids, keywords, EVERYONE)) await consider(p);
        if (found.size >= want * 3) break; // plenty; save LinkedIn's search allowance
      }
    }
    // best score first; among equals, people you're connected with (a message, not an invite)
    return [...found.values()].sort((a, b) => b.score - a.score || (a.degree !== "1st") - (b.degree !== "1st"));
  }

  JB.recruiters = { run, wanted };
})(globalThis.JB = globalThis.JB || {});
