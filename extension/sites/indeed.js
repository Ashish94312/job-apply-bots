// Indeed: where its jobs are, how to read them, and applying through Indeed's own application. There's no Python bot
// for Indeed: this was written for the extension.
//
// Searches are /jobs?q=<keyword>&l=<place>&fromage=<days> on the Indeed of your country (in.indeed.com for India,
// uk.indeed.com, www.indeed.com for the US...), 10 or so jobs a page (&start=10, 20, ...), narrowed to "Easily apply"
// jobs (the ones that apply on Indeed) unless you say otherwise. A job's page is /viewjob?jk=<id>. Its "Apply now"
// opens Indeed's application (smartapply.indeed.com), a page at a time: your contact details, your resume (the one
// on Indeed, or yours from Settings), the employer's questions, your experience, then a review and "Submit your
// application". "Apply on company site" is recorded as Other site with where it leads, for Company sites. Chrome lets
// Sendoff onto Indeed when you first use it. Loaded in the background worker (settings, the apply loop) and in
// Indeed's pages (`page`, which reads and fills them).
(function (JB) {
  // Indeed's own site for each country (lib/places.js codes); anywhere else, the US one.
  const HOSTS = {
    US: "www", IN: "in", GB: "uk", CA: "ca", AU: "au", NZ: "nz", IE: "ie", SG: "sg", AE: "ae", ZA: "za", DE: "de", FR: "fr",
    NL: "nl", BE: "be", CH: "ch", AT: "at", ES: "es", IT: "it", BR: "br", MX: "mx", JP: "jp", PH: "ph", HK: "hk", PK: "pk",
  };
  const COUNTRY_OF = Object.fromEntries(Object.entries(HOSTS).map(([code, sub]) => [sub, code]));
  const EASY_APPLY = "0kf:attr(DSQF7);"; // Indeed's "Easily apply" filter
  const JOB_RE = /[?&](?:jk|vjk)=([0-9a-f]{16})\b/i;
  const FORM_RE = /^https:\/\/(smartapply|apply|m5\.apply)\.indeed\.com\//; // Indeed's application
  const MAX_STEPS = 12;

  const BLOCKED = "Indeed has blocked this browser for now (its \"Request Blocked\" page). Try again later, or sign in to Indeed in Chrome first.";
  const status = (s, note = "") => [s, note];
  const blocked = () => Object.assign(new Error(BLOCKED), { stopRun: BLOCKED }); // nothing more to do on Indeed this run
  const named = job => (job.company ? `${job.title || "the job"} at ${job.company}` : job.title || "the job");
  const EXPERIENCE_RE = new RegExp(JB.filters.RANGE, "giu"); // "3 - 5 years" (lib/filters.js)
  const PLUS_YEARS_RE = /(?<![\d.])(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,40}?\bexperience/gi; // "3+ years of experience"

  /** The smallest experience the description asks for, written "N - N years" up front for the experience filter. */
  function withRange(text) {
    const found = [...(text || "").matchAll(EXPERIENCE_RE), ...(text || "").matchAll(PLUS_YEARS_RE)].map(m => parseFloat(m[1]));
    if (!found.length) return text;
    const n = Math.min(...found);
    return `${n} - ${n} years. ${text}`;
  }

  /** "https://in.indeed.com" for India: the Indeed of the country you're in. */
  function base(countryName) {
    const code = JB.places?.country(countryName)?.code;
    return `https://${HOSTS[code] || "www"}.indeed.com`;
  }

  const site = {
    name: "indeed",
    label: "Indeed",
    domain: "indeed.com",
    // Chrome lets Sendoff onto Indeed only when you first use it (no new permission for everyone on an update)
    origins: ["https://*.indeed.com/*"],
    loginUrl: "https://secure.indeed.com/auth",
    loginCheckUrl: "https://myjobs.indeed.com/applied", // the jobs you applied to: signed out, it sends you to sign in
    loginHint: "email, Google or Apple",
    jobLinkCss: "a[data-jk], a[href*='jk=']",
    jobReadyCss: "h1, #jobDescriptionText",
    jobUrlRe: JOB_RE,
    paged: true, // later pages are &start=10, 20, ...
    settleMs: 2000, // its apply button draws itself after the heading
    searchHost: /^https:\/\/\w+\.indeed\.com\/jobs\b/,
    searchExample: "https://in.indeed.com/jobs?q=… (your country's Indeed)",
    HOSTS,
    base,
    withRange,

    jobId(url) {
      return this.jobUrlRe.exec(url)[1].toLowerCase();
    },

    /** One search per keyword and place (or the whole country), on the Indeed of your country, posted within the days
     * you chose, only "Easily apply" jobs unless you said otherwise; plus any extra URLs. */
    searchUrls(cfg) {
      const at = base(cfg.country);
      const places = cfg.locations && cfg.locations.length ? cfg.locations : [""];
      const urls = [];
      for (const keyword of cfg.keywords || []) {
        for (const place of places) {
          const q = new URLSearchParams({ q: keyword });
          if (place) q.set("l", place);
          if (Number(cfg.postedWithin) > 0) q.set("fromage", String(cfg.postedWithin));
          if (cfg.easyApplyOnly !== false) q.set("sc", EASY_APPLY);
          urls.push(`${at}/jobs?${q}`);
        }
      }
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    searchPageUrl(url, n) {
      if (n === 1) return url;
      const u = new URL(url);
      u.searchParams.set("start", String((n - 1) * 10));
      return u.toString();
    },

    searchLabel(url) {
      try {
        const q = new URL(url).searchParams;
        return q.get("q") ? [q.get("q"), q.get("l")].filter(Boolean).join(", ") : null;
      } catch {
        return null;
      }
    },

    /** The country of the Indeed searched (in.indeed.com: India), for the jobs found there (lib/places.js). */
    placeOf(url) {
      try {
        const code = COUNTRY_OF[new URL(url).hostname.split(".")[0]];
        return code ? JB.places.COUNTRIES.find(c => c.code === code)?.name || "" : "";
      } catch {
        return "";
      }
    },

    // ---------------------------------------------------------- applying, page by page (runs in the worker)

    /** Apply now, then each page of Indeed's application until it says it's sent. Returns [status, note]. */
    async apply(run, cfg, job) {
      const state = await run.exec("site.applyState");
      if (state.blocked) throw blocked();
      if (state.applied) return status("already_applied");
      if (state.closed) return status("skipped", "job is closed");
      if (!state.apply && state.external) {
        const link = await run.followOut("site.clickCompanySite");
        return status("external", link ? `apply opens an external site: ${link}` : "applies on the company website");
      }
      if (!state.apply) return status("needs_manual", "no Apply button found");
      run.step(`Starting the application for ${named(job)}`);
      if (!(await this.openForm(run))) return status("needs_manual", "Indeed's application didn't open");

      const note = JB.answers.coverNote(cfg.coverNote, job);
      const resume = await JB.store.resume();
      for (let i = 0; i < MAX_STEPS; i++) {
        await run.sleep(1500); // each page draws itself after loading
        const step = await run.exec("site.step");
        if (step.sent) return status("applied");
        if (step.check) return status("needs_manual", `Indeed ${step.check}`);
        if (!step.button) return status("needs_manual", `no Continue button on "${step.name}"`);
        run.step(`Filling in "${step.name}" for ${named(job)}`);
        let missing = await run.exec("site.fill", cfg.answers, note, resume);
        while (missing.length) { // cfg.answers takes what you answer
          if (missing.some(m => m.kind === "file")) return status("needs_manual", "it wants a resume: add yours in Settings > Your profile, or one on Indeed");
          const learned = await run.learn(missing, cfg, job);
          if (learned !== true) return run.unanswered(missing, learned);
          missing = await run.exec("site.fill", cfg.answers, note, resume);
        }
        run.step(step.submit ? `Sending the application for ${named(job)}` : `Filling in the application for ${named(job)}`);
        await run.exec("site.next");
        for (let k = 0; k < (step.submit ? 15 : 8); k++) { // the next page, or the confirmation, can take a few seconds
          await run.sleep(1000);
          await run.loaded({ fresh: false });
          const after = await run.exec("site.step");
          if (after.sent) return status("applied");
          if (after.key !== step.key) break;
          if (k >= 2 && after.errors.length) return status("needs_manual", `Indeed says, on "${step.name}": ${after.errors.join("; ")}`);
          if (after.check) return status("needs_manual", `Indeed ${after.check}`);
          if (k === (step.submit ? 14 : 7)) return status("needs_manual", step.submit ? "couldn't confirm the application went through" : `it didn't go on from "${step.name}"`);
        }
      }
      return status("needs_manual", "the application had too many pages");
    },

    /** Apply now leads to Indeed's application: in this tab, a new one, or a box on the job's page. Have it here. */
    async openForm(run) {
      const { seen } = await run.opens("site.clickApply");
      if (FORM_RE.test((await run.tab()).url)) return true;
      const there = seen.find(u => FORM_RE.test(u)) || (await run.exec("site.formFrame"));
      if (!there) return false;
      await run.goto(there);
      return FORM_RE.test((await run.tab()).url);
    },

    // ---------------------------------------------------------- runs inside Indeed's pages
    page: (() => {
      const norm = s => (s || "").replace(/\s+/g, " ").trim();
      const bodyText = () => (document.body ? document.body.innerText : "");
      const visible = e => !!e && JB.page.isVisible(e) && !e.disabled && e.getAttribute("aria-disabled") !== "true";
      const APPLY_RE = /^\s*(apply now|easily apply|apply)\s*$/i;
      const COMPANY_SITE_RE = /^\s*apply on (the )?company('s)? (site|website)\b/i;
      const APPLIED_RE = /\byou applied\b|you('ve| have) (already )?applied/i;
      const CLOSED_RE = /this job has expired|job (post )?(is )?no longer available|no longer accepting applications|(employer|job) is not accepting applications/i;
      const NO_RESULTS_RE = /did not match any jobs|no jobs found|no results found/i;
      // Indeed turning a browser away: "Blocked - Indeed.com", "Request Blocked. You have been blocked."
      const isBlocked = () => /^blocked\b/i.test(document.title) || /request blocked|you have been blocked/i.test(bodyText().slice(0, 2000));
      const SENT_RE = /your application has been submitted|application (was |has been )?(successfully )?submitted|thanks? (you )?for applying|you('ve| have) applied to this job/i;
      const NEXT_RE = /^\s*(continue|next|review( your application)?|submit( your)?( application)?)\s*$/i;
      const SUBMIT_RE = /^\s*submit( your)?( application)?\s*$/i;
      const OPTIONAL_RE = /\(optional\)|\boptional\s*$/i;
      const CARD_CSS = ".job_seen_beacon, .cardOutline, [data-testid=slider_item], li";

      const iaButton = () => [document.querySelector("#indeedApplyButton, [data-testid=indeedApplyButton], .indeed-apply-button")]
        .find(visible) || JB.page.firstVisible(document, APPLY_RE, ["button"]);
      const companyButton = () => [...document.querySelectorAll("#applyButtonLinkContainer a, #applyButtonLinkContainer button, [data-testid*=companySite]")]
        .find(e => JB.page.isVisible(e)) || JB.page.firstVisible(document, COMPANY_SITE_RE);
      const nextButton = () => [...document.querySelectorAll("[data-testid=continue-button], [data-testid*=submit], .ia-continueButton")].find(visible)
        || JB.page.firstVisible(document.querySelector("main") || document, NEXT_RE, ["button"]);

      return {
        isLoggedIn() {
          return location.hostname !== "secure.indeed.com" && !JB.page.firstVisible(document, /^\s*sign in\s*$/i);
        },

        searchReady() {
          return !!document.querySelector("a[data-jk], .job_seen_beacon") || NO_RESULTS_RE.test(bodyText()) || isBlocked();
        },

        /** [job URL, card text] for each result card (sponsored ones too: their link has the job's id as data-jk);
         * on Indeed's "blocked" page, why there are none. */
        collectLinks() {
          if (isBlocked()) return { skip: BLOCKED.replace(/\. Try again.*$/, "") };
          const rows = new Map();
          for (const a of document.querySelectorAll("a[data-jk], a[href*='jk=']")) {
            const jk = a.getAttribute("data-jk") || (JOB_RE.exec(a.href) || [])[1];
            if (!jk || !/^[0-9a-f]{16}$/i.test(jk)) continue;
            const url = `${location.origin}/viewjob?jk=${jk.toLowerCase()}`;
            const text = norm((a.closest(CARD_CSS) || a).innerText);
            if (text.length > (rows.get(url) || "").length) rows.set(url, text);
          }
          return [...rows];
        },

        /** The heading is the title ("... - job post" for screen readers); the company and where are under it. On
         * Indeed's "blocked" page, only that (`stopRun`): it isn't a job, and the run stops without recording one. */
        readJob() {
          if (isBlocked()) return { stopRun: BLOCKED };
          const h1 = document.querySelector("[data-testid=jobsearch-JobInfoHeader-title], h1.jobsearch-JobInfoHeader-title, h1");
          const title = norm(h1 ? h1.innerText : "").replace(/\s*-\s*job post\s*$/i, "");
          const co = document.querySelector("[data-testid=inlineHeader-companyName], [data-company-name], .jobsearch-CompanyInfoContainer a");
          const company = norm(co ? co.innerText.split("\n")[0] : "").replace(/\s*\d(\.\d)?\s*(out of 5 stars?|★).*$/i, "");
          const place = document.querySelector("[data-testid=inlineHeader-companyLocation], [data-testid=job-location], #jobLocationText");
          const header = document.querySelector(".jobsearch-InfoHeaderContainer, [data-testid=jobsearch-InfoHeaderContainer]");
          const about = document.querySelector("#jobDescriptionText");
          const text = [header ? header.innerText : "", about ? about.innerText : ""].filter(Boolean).join("\n") || bodyText();
          return { title: title.slice(0, 150), company: company.slice(0, 100), text: withRange(norm(text)).slice(0, 6000), where: norm(place ? place.innerText : "").slice(0, 200) };
        },

        /** In the application: it says it's sent. On the job's page: its button reads "Applied", or its header says
         * you did (not the "Applied" on other jobs' cards beside it). */
        isApplied() {
          if (FORM_RE.test(location.href)) return this.step().sent;
          const own = document.querySelector("#indeedApplyButton, [data-testid=indeedApplyButton]");
          const header = document.querySelector(".jobsearch-InfoHeaderContainer, [data-testid=jobsearch-InfoHeaderContainer], #applyButtonLinkContainer");
          return (!!own && /^\s*applied\s*$/i.test(own.innerText)) || !!JB.page.firstVisible(header || document.createElement("i"), /^\s*applied\s*$/i, ["button"])
            || (!!header && APPLIED_RE.test(header.innerText));
        },

        applyState() {
          return { apply: !!iaButton(), external: !!companyButton(), applied: this.isApplied(), closed: CLOSED_RE.test(bodyText()), blocked: isBlocked() };
        },

        /** Apply now: a link (or a button with an address) gives where it goes, in this tab; a button is pressed. */
        clickApply() {
          const button = iaButton();
          if (!button) return null;
          const href = (button.closest("a[href]") || {}).href || button.getAttribute("href");
          if (href && FORM_RE.test(new URL(href, location.href).href)) return new URL(href, location.href).href;
          JB.page.click(button);
          return null;
        },

        /** An application opened in a box on the job's page (an iframe the bot can't fill): its address. */
        formFrame() {
          const frame = [...document.querySelectorAll("iframe")].find(f => FORM_RE.test(f.src || "") && JB.page.isVisible(f));
          return frame ? frame.src : null;
        },

        /** "Apply on company site": its address when it has one (Indeed's own redirect to it), else it's clicked. */
        clickCompanySite() {
          const button = companyButton();
          if (!button) return null;
          const href = (button.closest("a[href]") || {}).href || button.getAttribute("href");
          if (href && /^(https?:)?\//.test(href)) return new URL(href, location.href).href;
          JB.page.click(button);
          return null;
        },

        /** Where the application is: the page's name, whether it's sent, its button (Submit on the last page), a
         * captcha in the way, and what Indeed complains about. */
        step() {
          const text = bodyText();
          const button = nextButton();
          const heading = document.querySelector("main h1, h1, main h2, h2");
          const name = norm(heading ? heading.innerText : "").slice(0, 80) || location.pathname.split("/").filter(Boolean).pop() || "the page";
          const errors = [...new Set([...document.querySelectorAll("[role=alert], [class*=error i], [id*=error i]")]
            .filter(e => JB.page.isVisible(e) && !e.querySelector("[class*=error i]")).map(e => norm(e.innerText)).filter(t => t && t.length < 200))].slice(0, 3);
          const challenge = [...document.querySelectorAll("iframe")].some(f => /recaptcha.*bframe|hcaptcha.*challenge|challenges\.cloudflare/i.test(f.src) && f.getBoundingClientRect().height > 100);
          return {
            sent: SENT_RE.test(text) || /\/post-apply\b/.test(location.pathname),
            name, key: `${location.pathname}|${name}`, errors,
            button: !!button, submit: !!button && SUBMIT_RE.test(norm(button.innerText || button.value)),
            check: challenge ? "asks you to prove you're human" : "",
          };
        },

        /** Fill this page from your answers; on the resume page, the one picked already (Indeed's) or yours. Returns
         * the questions that need an answer and have none (optional ones are left alone). */
        async fill(answers, note, resume) {
          const root = document.querySelector("main") || document.body;
          if (/resume/i.test(location.pathname)) { // its choices are which resume to send, not a question
            const picked = root.querySelector("input[type=radio]:checked, [aria-checked=true], [aria-selected=true], [data-testid*=resume-selected]");
            const box = root.querySelector("input[type=file]");
            if (picked || !box || box.files.length) return [];
            if (!resume) return [{ q: "Resume", kind: "file" }];
            JB.page.attach(box, resume);
            await new Promise(r => setTimeout(r, 3000)); // Indeed reads it in
            return [];
          }
          return (await JB.page.fillForm(root, answers, note)).filter(m => !OPTIONAL_RE.test(m.q));
        },

        next() {
          const button = nextButton();
          if (!button) return false;
          JB.page.click(button);
          return true;
        },
      };
    })(),
  };

  JB.sites = JB.sites || {};
  JB.sites.indeed = site;
})(globalThis.JB = globalThis.JB || {});
