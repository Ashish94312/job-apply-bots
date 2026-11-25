// Hirist: where its jobs are, how to read them, and its page quirks (ported from hirist/portal.py).
//
// Search pages take filters in the URL: /search/<keyword>?minexp=1&maxexp=2, and later pages are &page=N.
// Each job card shows "X - Y yrs", so jobs outside the experience range are skipped without opening them.
// Loaded in the background worker (the plain settings) and in Hirist's pages (`page`, which runs there).
(function (JB) {
  const site = {
    name: "hirist",
    label: "Hirist",
    country: "IN", // its jobs are all in India (lib/places.js)
    domain: "hirist.tech",
    loginUrl: "https://www.hirist.tech/", // its "Login" button is there
    jobLinkCss: "a[href*='/j/']",
    jobReadyCss: "h1",
    jobUrlRe: /hirist\.tech\/j\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/,
    applyRe: /^\s*apply( now)?\s*$/i,
    paged: true, // 20 jobs per page, later pages are &page=N
    maxScrolls: 0,
    loginHint: "OTP, password or Google",
    searchHost: /^https:\/\/(www\.)?hirist\.tech\//,

    jobId(url) {
      return this.jobUrlRe.exec(url)[1];
    },

    /** One search per keyword with the experience range, plus any extra URLs. */
    searchUrls(cfg) {
      const lo = cfg.minExperience;
      const hi = cfg.maxExperience;
      const exp = lo != null && hi != null ? `?minexp=${lo}&maxexp=${hi}` : "";
      const urls = (cfg.keywords || []).map(k => `https://www.hirist.tech/search/${JB.filters.slug(k)}${exp}`);
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    searchPageUrl(url, n) {
      return n === 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`;
    },

    // Runs inside Hirist's pages.
    page: {
      // The Apply request can finish after the job page itself has finished loading.
      applyResult() {
        if (JB.page.isApplied()) return "applied";
        const form = JB.page.visibleDialog() || this.questionPage();
        if (form && [...form.querySelectorAll('button, [role=button], input, select, textarea')].some(JB.page.isVisible)) return "form";
        return null;
      },

      isLoggedIn() {
        return !JB.page.firstVisible(document, /^\s*login\s*$/i);
      },

      /** The heading is usually "Company - Title"; the tab title always ends "... - Company | hirist". */
      readJob() {
        const h1 = document.querySelector("h1");
        const heading = h1 ? JB.page.norm(h1.innerText) : "";
        const m = / - ([^-|]+?) \| hirist/i.exec(document.title);
        const company = m ? m[1].trim() : "";
        // The prefix may be spelled differently ("OZI" / "OZI Technologies").
        const at = heading.indexOf(" - ");
        const prefix = at < 0 ? heading : heading.slice(0, at);
        const rest = at < 0 ? "" : heading.slice(at + 3);
        const same = company && (company.toLowerCase().includes(prefix.toLowerCase()) || prefix.toLowerCase().includes(company.toLowerCase()));
        const title = rest && same ? rest : heading;
        return { title: title.trim(), company, text: document.body ? document.body.innerText : "" };
      },

      /** After "Apply", Hirist may ask recruiter questions: on /job/<id>/review-apply since Nov 2026 (its steps:
       * Submit a Form, Add Audio/Video Profile, Review & Submit), before on a separate /screening page. */
      questionPage() {
        return /\/(review-apply|screening)(\/|$)/.test(location.pathname) ? document.body : null;
      },

      /** What moves those steps on: Next (after the questions), Skip this step (the audio/video profile, which needs a
       * recording), then Review & Submit. Never "Save & Apply Later". An enabled one first. */
      submitButton(form) {
        const steps = [/^\s*next\s*$/i, /^\s*review\s*(&|and)\s*submit\s*$/i, /^\s*skip this step\s*$/i, /^\s*submit\s*$/i];
        const found = steps.map(re => JB.page.firstVisible(form, re, ["button"])).filter(Boolean);
        return found.find(b => !b.disabled && b.getAttribute("aria-disabled") !== "true") || found[0] || null;
      },
    },
  };

  JB.sites = JB.sites || {};
  JB.sites.hirist = site;
})(globalThis.JB = globalThis.JB || {});
