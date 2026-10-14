// Hirist: where its jobs are, how to read them, and its page quirks (ported from hirist/portal.py).
//
// Search pages take filters in the URL: /search/<keyword>?minexp=1&maxexp=2, and later pages are &page=N.
// Each job card shows "X - Y yrs", so jobs outside the experience range are skipped without opening them.
// Loaded in the background worker (the plain settings) and in Hirist's pages (`page`, which runs there).
(function (JB) {
  const site = {
    name: "hirist",
    label: "Hirist",
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

      /** After "Apply", Hirist may ask recruiter questions on a separate /screening page. */
      questionPage() {
        return location.pathname.includes("/screening") ? document.body : null;
      },
    },
  };

  JB.sites = JB.sites || {};
  JB.sites.hirist = site;
})(globalThis.JB = globalThis.JB || {});
