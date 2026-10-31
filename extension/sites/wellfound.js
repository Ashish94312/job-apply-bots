// Wellfound (formerly AngelList Talent): where its jobs are, how to read them, and its page quirks (ported from
// wellfound/portal.py).
//
// Role pages list jobs per role and place: /role/l/<role>/<place> (e.g. india) or /role/r/<role> for remote,
// 25-30 jobs a page, later pages ?page=N. Each job row shows "N years of exp", so jobs asking for too much
// experience are skipped without opening them. A role Wellfound doesn't know sends you to all jobs instead;
// that search is skipped. Loaded in the background worker and in Wellfound's pages (`page`, which runs there).
(function (JB) {
  const EXP_RE = /(\d+)\+?\s*years? of exp/i;

  /** Wellfound says "3 years of exp"; put "3 - 3 years" up front so the experience filter reads it. */
  const withRange = text => {
    const m = EXP_RE.exec(text || "");
    return m ? `${m[1]} - ${m[1]} years. ${text}` : text;
  };

  const site = {
    name: "wellfound",
    label: "Wellfound",
    domain: "wellfound.com",
    loginUrl: "https://wellfound.com/login",
    loginCheckUrl: "https://wellfound.com/jobs",
    loginHint: "email and password, or Google",
    jobLinkCss: "a[href^='/jobs/']",
    jobReadyCss: "h1",
    jobUrlRe: /wellfound\.com\/jobs\/(\d+)-/,
    applyRe: /^\s*apply now\s*$/i, // job pages also list similar jobs with plain "Apply" buttons
    paged: true,
    searchHost: /^https:\/\/(www\.)?wellfound\.com\//,
    withRange,

    jobId(url) {
      return this.jobUrlRe.exec(url)[1];
    },

    /** One role page per keyword (a Wellfound role name) and place, plus any extra URLs. */
    searchUrls(cfg) {
      const { slug } = JB.filters;
      const places = cfg.locations && cfg.locations.length ? cfg.locations : ["india"];
      const urls = [];
      for (const role of cfg.keywords || []) {
        for (const place of places) {
          urls.push(place.toLowerCase() === "remote" ? `https://wellfound.com/role/r/${slug(role)}` : `https://wellfound.com/role/l/${slug(role)}/${slug(place)}`);
        }
      }
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    /** The place a role page searches in: "/role/l/<role>/united-states" is United States; "/role/r/" is remote. */
    placeOf(url) {
      const m = /\/role\/l\/[^/]+\/([^/?#]+)/.exec(url);
      return m ? m[1].replace(/-/g, " ") : "";
    },

    searchPageUrl(url, n) {
      return n === 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`;
    },

    // Runs inside Wellfound's pages.
    page: {
      isLoggedIn() {
        return !JB.page.firstVisible(document, /^\s*log\s*in\s*$/i);
      },

      /** [job URL, text of its row] pairs; or why to skip, if Wellfound went somewhere other than the role page. */
      collectLinks() {
        if (!location.pathname.includes("/role/")) return { skip: `Wellfound has no such role page (went to ${location.href})` };
        const rows = new Map();
        const jobHref = a => /^\/jobs\/\d+-/.test(a.getAttribute("href") || "");
        for (const a of document.querySelectorAll("a[href^='/jobs/']")) {
          if (!jobHref(a)) continue;
          let row = a; // widen to the job's own row: stop before the block that holds other jobs too
          while (row.parentElement && new Set([...row.parentElement.querySelectorAll("a[href^='/jobs/']")]
            .filter(jobHref).map(x => x.getAttribute("href").split("?")[0])).size === 1) row = row.parentElement;
          const url = a.href.split("?")[0];
          const text = JB.page.norm(row.innerText);
          if (site.jobUrlRe.test(url) && text.length > (rows.get(url) || "").length) rows.set(url, text);
        }
        return [...rows].map(([url, text]) => [url, withRange(text)]);
      },

      /** The heading reads "<title> at <company>" when logged in; the tab title has "at <company> •". */
      readJob() {
        const m = / at (.+?) (?:•|\|)/.exec(document.title);
        const company = m ? m[1].trim() : "";
        const h1 = document.querySelector("h1");
        let title = h1 ? JB.page.norm(h1.innerText) : "";
        if (company && title.endsWith(` at ${company}`)) title = title.slice(0, -` at ${company}`.length);
        return { title, company, text: withRange(document.body ? document.body.innerText : "") };
      },

      /** A confirmation message, or the job's own button saying "Applied". The left menu has an "Applied"
       * link (your applications), so links don't count. */
      isApplied() {
        if (JB.page.APPLIED_TEXT_RE.test(document.body ? document.body.innerText : "")) return true;
        return !!JB.page.firstVisible(document, /^\s*applied\s*$/i, ["button"]);
      },

      /** The apply dialog says up front when a company won't take your application. */
      cannotApply() {
        const text = document.body ? document.body.innerText : "";
        if (/not accepting applications from your (current )?location/i.test(text)) return "company doesn't hire from your location";
        if (/no longer accepting applications/i.test(text)) return "job is closed";
        return null;
      },
    },
  };

  JB.sites = JB.sites || {};
  JB.sites.wellfound = site;
})(globalThis.JB = globalThis.JB || {});
