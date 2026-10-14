// Cutshort: its logged-in job feed and applying from the feed's cards (ported from cutshort/portal.py).
//
// Cutshort applies from its feed (/profile/all-jobs), not from job pages: each card has "Apply now", which opens
// a dialog with your resume, a message box and "Send". The feed takes its filters from the URL: minexp / maxexp
// (years) and skills (Cutshort's own skill ids). A keyword without a known id is looked up once in the feed's
// Skills filter and remembered. Loaded in the background worker and in Cutshort's pages (`page`, which runs there).
(function (JB) {
  const FEED = "https://cutshort.io/profile/all-jobs";
  // Skill ids the Python bot found; others are looked up in the feed and kept in storage (CACHE_KEY).
  const KNOWN_SKILLS = {
    "machine learning": "00268", "natural language processing": "00301", nlp: "00301", "deep learning": "00543",
    "computer vision": "06726", "large language models": "06768", llm: "06768", "generative ai": "06851",
    genai: "06851", python: "00360", pytorch: "06694", "data science": "00121", mlops: "06790",
  };
  const CACHE_KEY = "cache:cutshort:skills";
  const APPLY_NOW_RE = /^\s*apply now\s*$/i;
  const APPLIED_CARD_RE = /^\s*(view conversation|applied)\s*$/i;
  const SEND_RE = /^\s*(send|submit|apply)\b/i;

  const site = {
    name: "cutshort",
    label: "Cutshort",
    domain: "cutshort.io",
    loginUrl: "https://cutshort.io/jobs", // click "Candidate login" there
    loginHint: "click Candidate login, then Google or phone OTP",
    loginRequired: true, // the feed only shows when logged in, dry run or not
    flow: "feed", // applies from feed cards, not job pages
    paged: true, // a few jobs per feed page, later pages are &page=N
    jobUrlRe: /cutshort\.io\/job\/([^/?#]+)/,
    searchHost: /^https:\/\/(www\.)?cutshort\.io\//,
    lookupUrl: FEED, // where the Skills filter is
    KNOWN_SKILLS,
    CACHE_KEY,
    labels: {}, // feed URL -> the keyword it searches, for the dashboard

    jobId(url) {
      return this.jobUrlRe.exec(url)[1];
    },

    feedUrl(id, cfg) {
      const lo = cfg.minExperience;
      const hi = cfg.maxExperience;
      const exp = lo != null && hi != null ? `minexp=${lo}&maxexp=${hi}&` : "";
      return `${FEED}?${exp}skills=${id}`;
    },

    /** One feed per keyword that has a Cutshort skill id (known or looked up via `lookup`), plus any extra URLs. */
    async searches(cfg, lookup, log) {
      const cached = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
      const urls = [];
      for (const keyword of cfg.keywords || []) {
        const key = keyword.trim().toLowerCase();
        let id = KNOWN_SKILLS[key] || cached[key];
        if (!id) {
          id = await lookup(keyword);
          if (id) { // remember finds only, so a failed lookup is tried again next run
            cached[key] = id;
            await chrome.storage.local.set({ [CACHE_KEY]: cached });
          }
        }
        if (id) {
          urls.push(this.feedUrl(id, cfg));
          this.labels[this.feedUrl(id, cfg)] = key;
        } else {
          log(`  Cutshort has no skill called '${keyword}', skipping it.`);
        }
      }
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    searchLabel(url) {
      return this.labels[url];
    },

    searchPageUrl(url, n) {
      return n === 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`;
    },

    // Runs inside Cutshort's pages.
    page: {
      isLoggedIn() {
        return !JB.page.firstVisible(document, /candidate login/i);
      },

      /** The feed has jobs once an "Apply now" button shows. */
      feedReady() {
        return !!JB.page.firstVisible(document, APPLY_NOW_RE, ["button"]);
      },

      /** A survey, and "Submit feedback to companies" you applied to (skip it, one company per step). */
      async closePopups() {
        const survey = [...document.querySelectorAll("button")].find(b => /^close survey$/i.test(b.getAttribute("aria-label") || b.innerText.trim()));
        if (survey && JB.page.isVisible(survey)) JB.page.click(survey);
        for (let i = 0; i < 5; i++) {
          if (!/submit feedback to companies/i.test(document.body.innerText)) break;
          const skip = JB.page.firstVisible(document, /^\s*skip\s*$/i);
          if (!skip) {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
            break;
          }
          JB.page.click(skip);
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      },

      /** [job url, title, company, card text] for every card with "Apply now". */
      feedJobs() {
        const jobs = [];
        const seen = new Set();
        for (const b of document.querySelectorAll("button")) {
          if (!APPLY_NOW_RE.test(b.innerText)) continue;
          let c = b;
          for (let k = 0; k < 12 && c && !c.querySelector("a[href*='/job/']"); k++) c = c.parentElement;
          if (!c) continue;
          let card = c; // widen until the card includes its "X - Y yrs" line
          for (let k = 0; k < 5 && card && !/\d\s*-\s*\d+(\.\d+)?\s*yrs/.test(card.innerText); k++) card = card.parentElement;
          const a = c.querySelector("a[href*='/job/']");
          const co = c.querySelector("a[href*='/company/']");
          const url = a.href.split("?")[0];
          if (!site.jobUrlRe.test(url) || seen.has(url)) continue;
          seen.add(url);
          jobs.push([url, a.innerText.trim(), co ? co.innerText.trim() : "", JB.page.norm((card || c).innerText).slice(0, 1500)]);
        }
        return jobs;
      },

      /** Pick the keyword in the feed's Skills filter; Cutshort then puts its id in the address (skills=<id>). */
      async pickSkill(keyword) {
        await this.closePopups();
        const label = [...document.querySelectorAll("body *")].find(e => !e.children.length && e.textContent.trim() === "Skills" && JB.page.isVisible(e));
        if (!label) return false;
        JB.page.click(label);
        await new Promise(resolve => setTimeout(resolve, 800));
        const box = [...document.querySelectorAll("input[type=text], input:not([type])")].find(JB.page.isVisible);
        if (!box) return false;
        JB.page.setValue(box, keyword, { blur: false });
        await new Promise(resolve => setTimeout(resolve, 2000));
        // "Machine Learning" matches the option "Machine Learning (ML)", not "Machine Learning Ops"; the option sits
        // under the box (job cards further down show skill tags with the same name).
        const want = new RegExp(`^\\s*${keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*\\(.*\\))?\\s*$`, "i");
        const under = box.getBoundingClientRect();
        const options = [...document.querySelectorAll("body *")]
          .filter(e => JB.page.isVisible(e) && want.test(e.textContent) && ![...e.children].some(k => want.test(k.textContent)))
          .map(e => [e.getBoundingClientRect(), e])
          .filter(([r]) => r.top > under.top && Math.abs(r.left - under.left) < under.width)
          .sort((a, b) => a[0].top - b[0].top);
        if (!options.length) return false;
        JB.page.click(options[0][1]);
        return true;
      },

      /** The job's card: the nearest block around its link holding "Apply now" (or, once applied, "View conversation"
       * or "Applied"). */
      card(jobId) {
        const link = document.querySelector(`a[href*='/job/${CSS.escape(jobId)}']`);
        const marks = el => [...el.querySelectorAll("*")].some(x => /^(apply now|view conversation|applied)$/i.test(x.textContent.trim()));
        for (let c = link; c; c = c.parentElement) if (marks(c)) return c;
        return null;
      },

      cardApplied(jobId) {
        const card = this.card(jobId);
        if (!card) return false;
        const buttons = [...card.querySelectorAll("button")].filter(b => APPLY_NOW_RE.test(b.innerText));
        return !buttons.length && [...card.querySelectorAll("*")].some(x => APPLIED_CARD_RE.test(x.textContent));
      },

      clickApply(jobId) {
        const card = this.card(jobId);
        const button = card && [...card.querySelectorAll("button")].find(b => APPLY_NOW_RE.test(b.innerText));
        if (!button) return false;
        JB.page.click(button);
        return true;
      },

      /** Fill the apply dialog and send it, or say why not. */
      async sendApplication(jobId, answers, note) {
        const dialog = JB.page.visibleDialog();
        if (!dialog) return { dialog: false, applied: this.cardApplied(jobId) };
        const missing = await JB.page.fillForm(dialog, answers, note);
        if (missing.length) return { dialog: true, missing };
        const send = JB.page.firstVisible(dialog, SEND_RE);
        if (!send) return { dialog: true, missing: [], sent: false };
        await JB.page.whenEnabled(send);
        JB.page.click(send);
        return { dialog: true, missing: [], sent: true };
      },

      sent(jobId) {
        return !JB.page.visibleDialog() && this.cardApplied(jobId);
      },

      /** Close a half-filled apply dialog so the next card can be used. */
      dismiss() {
        const dialog = JB.page.visibleDialog();
        if (!dialog) return false;
        const close = JB.page.firstVisible(dialog, /^\s*(close|cancel|×|✕)\s*$/i);
        if (close) JB.page.click(close);
        else for (const target of [dialog, document]) target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        return true;
      },
    },
  };

  JB.sites = JB.sites || {};
  JB.sites.cutshort = site;
})(globalThis.JB = globalThis.JB || {});
