// YC startups: applying to jobs at companies Y Combinator funded, on its Work at a Startup, with a note to the
// founders.
//
// Searching is on ycombinator.com's public job pages, /jobs/role/<role>/<place> (the newest 40 or so jobs in a role,
// in a place or remote), so a dry run needs no login. A job's page there says where it is ("Toronto, ON, CA",
// "Remote (US)"), the experience it wants ("1+ years"), whether a US visa matters ("US citizen/visa only", "Will
// sponsor") and who the founders are; its Apply link has the job's id on Work at a Startup. Applying is there
// (workatastartup.com/jobs/<id>), signed in with your YC account: Apply, then the note to the founders, written from
// your template for each company and shown to you to change before it's sent (unless Settings says to send straight
// away). Chrome lets Sendoff onto these sites when you first use this one. Loaded in the background worker and in
// those pages (`page`, which runs there).
(function (JB) {
  const BASE = "https://www.ycombinator.com";
  const WAAS = "https://www.workatastartup.com";
  const REVIEW = [["Send it", "save", "primary"], ["Skip this job", "skip"], ["Stop run", "stop", "stop"]];
  const status = (s, note = "") => [s, note];
  const named = job => (job.company ? `${job.title || "the job"} at ${job.company}` : job.title || "the job");
  const EXP_RE = /(\d+)\+\s*years?/i;

  /** YC says "1+ years"; put "1 - 1 years" up front so the experience filter reads it. */
  const withRange = text => {
    const m = EXP_RE.exec(text || "");
    return m ? `${m[1]} - ${m[1]} years. ${text}` : text;
  };

  // YC's roles, for "Start from a field" (Settings > Which jobs)
  const FIELD_ROLES = {
    "Software and IT": ["software engineer"], "AI and data science": ["software engineer", "science"], "Data and analytics": ["science"],
    "Design": ["designer"], "Product and project management": ["product manager"], "Marketing": ["marketing"],
    "Sales and business development": ["sales manager"], "Customer support and success": ["support"], "HR and recruiting": ["recruiting hr"],
    "Operations and supply chain": ["operations"],
  };

  /** "Sean and Adam", "Sean, Adam and Lee": the founders' first names. */
  const together = names => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "");

  /** The note to the founders: your template with {founders}, {first_name} (the first founder's), {company}, {title},
   * {job_url} and {name} (yours) filled in. */
  function note(template, job, profile = {}) {
    const firsts = (job.founders || []).map(n => n.split(" ")[0]);
    let text = (template || "").trim();
    for (const [key, value] of [["founders", together(firsts) || "there"], ["first_name", firsts[0] || "there"],
      ["company", job.company || "your company"], ["title", job.title || "the open role"], ["job_url", job.url || ""],
      ["name", [profile.firstName, profile.lastName].filter(Boolean).join(" ")]]) text = text.replaceAll(`{${key}}`, value);
    return text;
  }

  const site = {
    name: "yc",
    label: "YC startups",
    domain: "workatastartup.com",
    // Chrome lets Sendoff onto these only when you first use this site (no new permission for everyone on an update)
    origins: ["https://www.ycombinator.com/*", "https://account.ycombinator.com/*", "https://www.workatastartup.com/*"],
    loginUrl: `https://account.ycombinator.com/authenticate?continue=${encodeURIComponent(`${WAAS}/application`)}`,
    loginCheckUrl: `${WAAS}/application`, // signed out, it sends you to YC's sign-in
    loginHint: "your YC account",
    jobLinkCss: "a[href*='/jobs/']",
    jobReadyCss: "h1",
    jobUrlRe: /ycombinator\.com\/companies\/[\w-]+\/jobs\/(\w+)-/,
    searchHost: /^https:\/\/www\.ycombinator\.com\/jobs\b/,
    maxScrolls: 1,
    withRange,
    note,

    jobId(url) {
      return this.jobUrlRe.exec(url)[1];
    },

    /** One role page per role (YC's: software engineer, designer, product manager...) and place ("remote", "india",
     * "san francisco"; "anywhere" for all), plus any extra URLs. No places: remote, and where you are. */
    searchUrls(cfg) {
      const { slug } = JB.filters;
      const places = cfg.locations && cfg.locations.length ? cfg.locations : ["remote", ...(cfg.country ? [cfg.country] : [])];
      const urls = [];
      for (const role of cfg.keywords || []) {
        for (const place of places) urls.push(`${BASE}/jobs/role/${slug(role)}${/^(anywhere|all)$/i.test(place) ? "" : `/${slug(place)}`}`);
      }
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    searchPageUrl(url, n) {
      return n === 1 ? url : null;
    },

    /** "/jobs/role/software-engineer/remote" -> "software engineer, remote" */
    searchLabel(url) {
      const m = /\/jobs\/role\/([\w-]+)(?:\/([\w-]+))?/.exec(url);
      return m ? [m[1], m[2]].filter(Boolean).join(", ").replace(/-/g, " ") : null;
    },

    /** The place a role page searches in, for the job's country when its page doesn't say ("remote" says nowhere). */
    placeOf(url) {
      const m = /\/jobs\/role\/[\w-]+\/([\w-]+)/.exec(url);
      return m && m[1] !== "remote" ? m[1].replace(/-/g, " ") : "";
    },

    rolesFor: field => FIELD_ROLES[field] || [],

    // ---------------------------------------------------------- applying, with a note (runs in the worker)

    /** On Work at a Startup: Apply, then the note to the founders, after you've had a look at it (unless Settings
     * says to send straight away). Returns [status, note]; throws to stop the run while the template still has a
     * <...> part to write. */
    async apply(run, cfg, job) {
      if (/<[^<>\n]+>/.test(cfg.message || "")) {
        const why = "The note to founders still has a <...> part. Write it in Settings > Sites > YC startups, then run again.";
        throw Object.assign(new Error(why), { stopRun: why });
      }
      if (!job.waasId) return status("needs_manual", "no Apply link on its YC page");
      const page = `${WAAS}/jobs/${job.waasId}`;
      await run.goto(page);
      await run.sleep(2500);
      let state = await run.exec("site.applyState");
      if (state.signIn) {
        if (!(await run.login(true))) return status("needs_manual", "not signed in to YC");
        await run.goto(page);
        await run.sleep(2500);
        state = await run.exec("site.applyState");
      }
      if (state.applied) return status("already_applied");
      if (!state.apply) return status("needs_manual", "no Apply button on Work at a Startup");
      run.step(`Applying to ${named(job)}`);
      await run.exec("site.clickApply");
      await run.sleep(2000);
      if (!(await run.exec("site.noteBox"))) {
        if ((await run.exec("site.applyState")).applied) return status("applied");
        return status("needs_manual", "no box for the note to the founders");
      }
      let text = note(cfg.message, job, cfg);
      if (cfg.sendMode !== "direct") {
        const to = together(job.founders || []) || `the founders of ${job.company || "the company"}`;
        const reply = await run.ask("Send this note?", `${named(job)}, to ${to}. Change it here if you like.`, REVIEW,
          [{ q: "Your note to the founders", kind: "long", options: [], answer: text }]);
        if (typeof reply !== "object") return status("skipped", "declined");
        text = reply.answers[0].answer;
      }
      run.step(`Sending your note to ${job.company || "the founders"}`);
      if (!(await run.exec("site.sendNote", text))) return status("needs_manual", "couldn't send the note: send it in the bot's window");
      for (let i = 0; i < 10; i++) {
        await run.sleep(1000);
        if ((await run.exec("site.applyState")).applied || !(await run.exec("site.noteBox"))) return status("applied");
      }
      return status("needs_manual", "couldn't confirm the note went");
    },

    // ---------------------------------------------------------- runs inside ycombinator.com's and Work at a Startup's pages
    page: (() => {
      const norm = s => (s || "").replace(/\s+/g, " ").trim();
      const lines = () => (document.body ? document.body.innerText : "").split("\n").map(norm).filter(Boolean);
      const PLACE_RE = /, [A-Z]{2}(?: \/|$)|\bRemote \([A-Z]{2}\)|^[A-Z]{2}(?: \/|$)/; // "Toronto, ON, CA", "Remote (US)", "IN / ..."
      const VISA_RE = /citizen(ship)?\/visa|will sponsor/i;
      const NAME_RE = /^\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’.-]*){1,3}$/u;
      const NOT_NAME_RE = /founder|ceo|cto|coo|chief|president|partner|head|engineer|lead|director|manager/i;
      const APPLY_RE = /^\s*apply( now| to .+)?\s*$/i;
      const SEND_RE = /^\s*(send|submit|apply|send (note|message|application)|submit application)\s*$/i;

      /** The founders' names: the lines that look like a name under the "Founders" heading. */
      function foundersOf(all) {
        const at = all.findIndex(l => /^founders?$/i.test(l));
        return at < 0 ? [] : all.slice(at + 1, at + 13).filter(l => NAME_RE.test(l) && !NOT_NAME_RE.test(l)).slice(0, 4);
      }

      /** The box for the note: in the dialog Apply opened, else on the page. */
      function box() {
        const scope = JB.page.visibleDialog() || document;
        return [...scope.querySelectorAll("textarea")].find(JB.page.isVisible) || null;
      }

      return {
        /** The job's page on ycombinator.com: title, company, where, the visa line and the rest of the text, the
         * founders, and its id on Work at a Startup (in the Apply link). */
        readJob() {
          const all = lines();
          const slug = location.pathname.split("/")[2] || "";
          const link = [...document.querySelectorAll(`a[href$="/companies/${slug}"]`)].map(a => norm(a.innerText)).find(Boolean);
          const company = (link || slug.replace(/-/g, " ")).replace(/\s*\([A-Z]\d{2}\)$/, ""); // "Evidence (S21)"
          const visa = all.find(l => l.length < 80 && VISA_RE.test(l)) || "";
          const waasId = [...document.querySelectorAll("a[href*='signup_job_id']")]
            .map(a => (/signup_job_id(?:=|%3D)(\d+)/i.exec(a.href) || [])[1]).find(Boolean) || "";
          const body = (document.querySelector("main") || document.body || {}).innerText || "";
          return {
            title: norm((document.querySelector("h1") || {}).innerText),
            company,
            where: all.find(l => l.length < 120 && PLACE_RE.test(l)) || "",
            text: withRange(`${visa}\n${body}`).slice(0, 6000),
            founders: foundersOf(all),
            waasId,
          };
        },

        /** Signed in to Work at a Startup (not sent to YC's sign-in)? */
        isLoggedIn() {
          return location.hostname === "www.workatastartup.com" && !JB.page.firstVisible(document, /^\s*(log ?in|sign ?in)\s*$/i);
        },

        /** The job on Work at a Startup: applied already, its Apply button there, or YC's sign-in instead. */
        applyState() {
          const text = norm(document.body ? document.body.innerText : "");
          return {
            applied: !!JB.page.firstVisible(document, /^\s*applied\s*$/i, ["button"]) || /you('ve| have) applied|application (sent|submitted)/i.test(text),
            apply: !!JB.page.firstVisible(document, APPLY_RE),
            signIn: location.hostname !== "www.workatastartup.com",
          };
        },

        clickApply() {
          const apply = JB.page.firstVisible(document, APPLY_RE);
          if (!apply) return false;
          if (apply.target) apply.target = "_self"; // a new tab is one the bot can't follow
          JB.page.click(apply);
          return true;
        },

        noteBox() {
          return !!box();
        },

        /** Write the note in its box and press Send. */
        sendNote(text) {
          const b = box();
          if (!b) return false;
          JB.page.setValue(b, text);
          const send = JB.page.firstVisible(b.closest("[role=dialog], dialog, form, .modal") || document, SEND_RE, ["button"]);
          if (!send) return false;
          JB.page.click(send);
          return true;
        },
      };
    })(),
  };

  JB.sites = JB.sites || {};
  JB.sites.yc = site;
})(globalThis.JB = globalThis.JB || {});
