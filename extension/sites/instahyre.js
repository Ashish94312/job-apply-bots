// Instahyre: where its jobs are, how to read them, and its page quirks (ported from instahyre/portal.py).
//
// Search pages take filters in the URL: /search-jobs?skills=<keyword>&years=N, where years=N means "at least N
// years", so each keyword is searched once per year of your range. Results are one long page that loads more as
// you scroll. Loaded in the background worker (the plain settings) and in Instahyre's pages (`page`, which runs there).
(function (JB) {
  const site = {
    name: "instahyre",
    label: "Instahyre",
    domain: "instahyre.com",
    loginUrl: "https://www.instahyre.com/login/",
    loginCheckUrl: "https://www.instahyre.com/candidate/opportunities/?matching=true", // sends you to /login if you aren't
    loginHint: "email and password, or Google",
    jobLinkCss: "a[href*='/job-']",
    jobReadyCss: "h1",
    jobUrlRe: /instahyre\.com\/job-(\d+)-/,
    applyRe: /^\s*apply( now)?\s*$/i,
    paged: false, // one page per search, scrolled for more
    searchHost: /^https:\/\/(www\.)?instahyre\.com\//,

    jobId(url) {
      return this.jobUrlRe.exec(url)[1];
    },

    /** One search per keyword and year of experience, plus any extra URLs. */
    searchUrls(cfg) {
      const lo = cfg.minExperience ?? 0;
      const hi = cfg.maxExperience ?? lo;
      const skill = k => encodeURIComponent(k).replace(/%2F/gi, "/"); // like Python's quote()
      const urls = [];
      for (const k of cfg.keywords || []) {
        for (let y = lo; y <= hi; y++) urls.push(`https://www.instahyre.com/search-jobs?skills=${skill(k)}&years=${y}`);
      }
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    searchPageUrl(url, n) {
      return n === 1 ? url : null;
    },

    // Runs inside Instahyre's pages.
    page: {
      isLoggedIn() {
        return !location.pathname.startsWith("/login");
      },

      /** The tab title reads "<title> job at <company> - Instahyre". */
      readJob() {
        const m = /^(.*?) job at (.*?) - Instahyre/i.exec(document.title);
        const h1 = document.querySelector("h1");
        const [title, company] = m ? [m[1], m[2]] : [h1 ? JB.page.norm(h1.innerText) : "", ""];
        return { title: title.trim(), company: company.trim(), text: document.body ? document.body.innerText : "" };
      },

      /** After applying, Instahyre may offer to "Apply to N jobs" like this one. Decline it. */
      dismissExtras() {
        const similar = JB.page.firstVisible(document, /^\s*apply to \d+ jobs?\s*$/i);
        if (!similar) return false;
        const modal = similar.closest(".modal");
        const close = modal && JB.page.firstVisible(modal, /^\s*(cancel|close|skip|no,? thanks|not now|×)\s*$/i);
        if (close) JB.page.click(close);
        else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        return true;
      },
    },
  };

  JB.sites = JB.sites || {};
  JB.sites.instahyre = site;
})(globalThis.JB = globalThis.JB || {});
