// LinkedIn: where its jobs are, how to read them, and Easy Apply (ported from linkedin/portal.py).
//
// Searches are /jobs/search/?keywords=..&location=.., 25 jobs a page (&start=25, 50, ...), narrowed in the URL to
// Easy Apply jobs, your experience levels and recent posts. A result card only fills in once it has been scrolled
// into view, so the list is scrolled through before it's read. Applying goes through LinkedIn's own dialog
// (contact info, resume, the company's questions, review, submit), one step at a time; jobs that apply on the
// company's website are recorded as external. Loaded in the background worker (settings, the apply loop) and in
// LinkedIn's pages (`page`, which reads and fills them).
(function (JB) {
  const BASE = "https://www.linkedin.com";
  const EXPERIENCE_LEVELS = { internship: 1, "entry level": 2, associate: 3, "mid-senior level": 4, director: 5, executive: 6 };
  const WORK_TYPES = { "on-site": 1, onsite: 1, remote: 2, hybrid: 3 };
  const POSTED_WITHIN = { day: "r86400", week: "r604800", month: "r2592000" };
  const MAX_STEPS = 12;

  const EXPERIENCE_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*(?:years?|yrs?)/gi;
  // "3+ years of experience", "minimum 2 years experience": LinkedIn job pages state experience like this.
  const PLUS_YEARS_RE = /(?<![\d.])(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,40}?\bexperience/gi;

  /** The smallest experience the description asks for, written "N - N years" up front for the experience filter. */
  function withRange(text) {
    const found = [...(text || "").matchAll(EXPERIENCE_RE), ...(text || "").matchAll(PLUS_YEARS_RE)].map(m => parseFloat(m[1]));
    if (!found.length) return text;
    const n = Math.min(...found);
    return `${n} - ${n} years. ${text}`;
  }

  const plain = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const pick = (options, answer) => JB.answers.pick(options, answer); // lib/answers.js

  // "How many years of work experience do you have with Python?", "Years of Java experience", "Experience with
  // Python?", "React experience?": the skill is the group that matched.
  const SKILL_RES = [
    /years (?:of )?(?:\w+ )?experience (?:do you (?:currently )?have )?(?:with|in|using|working with|on) (.+?)\s*\??$/i,
    /years of (.+?) experience(?: do you (?:currently )?have)?\s*\??$/i,
    /^experience (?:with|in|using|on) (.+?)\s*\??$/i,
    /^((?:[\w.+#/-]+ ?){1,3}) experience\s*\??$/i,
  ];
  const NOT_A_SKILL_RE = new RegExp(
    "^(total|overall|all|any|work|relevant|professional|prior|previous|related|industry|it|information technology"
      + "|software|software (development|engineering)|the (field|industry|role)|this (field|industry|role|position)|your)$",
    "i",
  );

  /** Answer from `answers`; else, for "years of experience with <skill>", from the skill years. */
  function answer(label, fill) {
    const given = JB.answers.answerFor(label, fill.answers);
    if (given != null) return given;
    const m = SKILL_RES.map(re => re.exec(label || "")).find(Boolean);
    if (!m || NOT_A_SKILL_RE.test(m[1].trim())) return null;
    for (const [skill, years] of Object.entries(fill.skillYears || {})) {
      if (years != null && years !== "" && JB.filters.hasWord(m[1], String(skill))) return String(years);
    }
    const other = fill.otherSkillYears;
    return other == null || other === "" ? null : String(other);
  }

  const status = (s, note = "") => [s, note];
  const dailyLimit = () => Object.assign(new Error("LinkedIn says you've hit today's Easy Apply limit. Try again tomorrow."), {
    stopRun: "LinkedIn says you've hit today's Easy Apply limit. Try again tomorrow.",
  });

  const site = {
    name: "linkedin",
    label: "LinkedIn",
    domain: "linkedin.com",
    loginUrl: `${BASE}/login`,
    loginCheckUrl: `${BASE}/feed/`, // sends you to a login page, an "authwall" or a security check if you aren't
    loginHint: "and do any security check it asks for",
    loginRequired: true,
    refers: true, // can ask people at the companies for referrals (referral.js)
    jobLinkCss: "[data-occludable-job-id], a[href*='/jobs/view/']",
    jobReadyCss: "[data-view-name=job-detail-page], [data-view-name=job-apply-button], h1, main a[href*='/company/'], button[aria-label*='apply' i]",
    jobUrlRe: /linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/,
    paged: true,
    settleMs: 2500, // the apply button takes a while to show
    searchHost: /^https:\/\/(www\.)?linkedin\.com\//,
    EXPERIENCE_LEVELS,
    WORK_TYPES,
    POSTED_WITHIN,
    withRange,
    answer,
    pick,

    jobId(url) {
      return this.jobUrlRe.exec(url)[1];
    },

    /** One search per keyword and place, with the filters in the URL. */
    searchUrls(cfg) {
      const params = [];
      if (cfg.easyApplyOnly !== false) params.push(["f_AL", "true"]);
      for (const [names, codes, key] of [[cfg.experienceLevels, EXPERIENCE_LEVELS, "f_E"], [cfg.workTypes, WORK_TYPES, "f_WT"]]) {
        const known = [...new Set((names || []).map(n => codes[n.toLowerCase()]).filter(Boolean).map(String))].sort();
        if (known.length) params.push([key, known.join(",")]);
      }
      if (POSTED_WITHIN[cfg.postedWithin]) params.push(["f_TPR", POSTED_WITHIN[cfg.postedWithin]]);
      params.push(["sortBy", "DD"]); // newest first
      const places = cfg.locations && cfg.locations.length ? cfg.locations : ["India"];
      const urls = [];
      for (const keyword of cfg.keywords || []) {
        for (const place of places) urls.push(`${BASE}/jobs/search/?${new URLSearchParams([["keywords", keyword], ["location", place], ...params])}`);
      }
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    searchPageUrl(url, n) {
      return n === 1 ? url : `${url}${url.includes("?") ? "&" : "?"}start=${(n - 1) * 25}`;
    },

    searchLabel(url) {
      try {
        const q = new URL(url).searchParams;
        return q.get("keywords") ? [q.get("keywords"), q.get("location")].filter(Boolean).join(", ") : null;
      } catch {
        return null;
      }
    },

    // ---------------------------------------------------------- Easy Apply, step by step (runs in the worker)

    /** Easy Apply through every step of the dialog. Returns [status, note]; throws to stop the run at the daily limit. */
    async apply(run, cfg, job) {
      const state = await run.exec("site.applyState");
      if (!state.easy) {
        if (state.applied) return status("already_applied");
        if (state.closed) return status("skipped", "job is closed");
        if (state.external) return status("external", "applies on the company website");
        return status("needs_manual", "no Easy Apply button found");
      }
      await run.exec("site.clickEasyApply");
      await this.waitForStep(run);
      if (await run.exec("site.limitHit")) throw dailyLimit();

      const fill = {
        answers: cfg.answers, skillYears: cfg.skillYears, otherSkillYears: cfg.otherSkillYears,
        followCompanies: !!cfg.followCompanies, note: JB.answers.coverNote(cfg.coverNote, job),
      };
      let lastStep = null;
      for (let i = 0; i < MAX_STEPS; i++) {
        if (await run.exec("site.sent")) {
          await run.exec("site.closeDone");
          return status("applied");
        }
        const before = await run.exec("site.modalText");
        if (before == null) return (await run.exec("isApplied")) ? status("applied") : status("needs_manual", "the Easy Apply dialog didn't open");
        run.step(`Filling in step ${i + 1} of the application for ${job.title || "the job"}`);
        let { missing, leftBlank } = await run.exec("site.fillStep", fill);
        while (missing.length) { // fill.answers is cfg.answers: what you answer goes in it
          const learned = await run.learn(missing, cfg, job);
          if (learned !== true) return run.unanswered(missing, learned);
          ({ missing, leftBlank } = await run.exec("site.fillStep", fill));
        }
        const changed = await run.exec("site.answeredByItself", leftBlank);
        if (changed.length) return status("needs_manual", `answered without the bot, check: ${changed.map(q => q.slice(0, 60)).join("; ")}`);

        const button = await run.exec("site.stepButton");
        if (!button) return status("needs_manual", "no Next / Review / Submit button in the dialog");
        const step = await run.exec("site.modalText");
        let errors = await this.press(run, button);
        if (errors.length && (await run.exec("site.asNumbers", errors))) errors = await this.press(run, button); // "0 months" in a number box
        if (errors.length) return status("needs_manual", `LinkedIn says: ${errors.map(e => e.text).join("; ")}`);
        if (button === "submit") {
          if ((await run.exec("site.sent")) || (await run.exec("isApplied"))) {
            await run.exec("site.closeDone");
            return status("applied");
          }
          return status("needs_manual", "submitted, but couldn't confirm the application went through");
        }
        const after = await run.exec("site.modalText");
        if (after != null && after === step) {
          if (step === lastStep) return status("needs_manual", "stuck on a step of the dialog");
          lastStep = step;
        }
      }
      return status("needs_manual", "the dialog had too many steps");
    },

    /** The dialog shows up first and its questions a moment later: wait for a field or a step button. */
    async waitForStep(run, seconds = 12) {
      for (let i = 0; i < seconds * 2; i++) {
        if ((await run.exec("site.stepReady")) || (await run.exec("site.limitHit"))) break;
        await run.sleep(500);
      }
      await run.sleep(500);
    },

    /** Click Next / Review / Submit. Returns LinkedIn's complaints about this step, if any. */
    async press(run, button) {
      await run.exec("site.pressStep", button);
      await run.sleep(1500);
      const submit = button === "submit";
      for (let i = 0; i < (submit ? 10 : 1); i++) { // a submitted application's confirmation can take a few seconds
        if (submit && ((await run.exec("site.sent")) || (await run.exec("isApplied")))) return [];
        const errors = await run.exec("site.errors");
        if (errors.length) return errors;
        if (submit) {
          if (await run.exec("site.limitHit")) throw dailyLimit();
          await run.sleep(1000);
        }
      }
      if (!submit) await this.waitForStep(run);
      return [];
    },

    // ---------------------------------------------------------- runs inside LinkedIn's pages
    page: (() => {
      const norm = s => (s || "").replace(/\s+/g, " ").trim();
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const bodyText = () => (document.body ? document.body.innerText : "");
      const EASY_APPLY_RE = /easy apply/i;
      const EXTERNAL_APPLY_RE = /^\s*apply\b/i;
      const SUBMIT_RE = /^\s*submit( application)?\s*$/i;
      const REVIEW_RE = /^\s*review( your application)?\s*$/i;
      const NEXT_RE = /^\s*(next|continue( to next step| applying)?)\s*$/i; // also the "safety reminder" some jobs show
      const STEP_RES = { submit: SUBMIT_RE, review: REVIEW_RE, next: NEXT_RE };
      const DONE_RE = /^\s*(done|not now|dismiss)\s*$/i;
      const SENT_RE = /application (was )?sent|application submitted/i;
      const APPLIED_RE = /^\s*applied\s+(\d+|an?)\s+\w+\s+ago|application (was )?(sent|submitted)/im;
      const SEE_APPLICATION_RE = /^\s*see application\s*$/i;
      const CLOSED_RE = /no longer accepting applications/i;
      const LIMIT_RE = /(easy apply|application)s? limit|reached (the|your) (daily )?limit|limit (for|on) (easy apply|applications)/i;
      const FOLLOW_RE = /^follow\b/i;
      const YES_RE = /^\s*(yes|true|agree|i agree|accept|checked?)\s*$/i;
      const SKIP_TYPES = new Set(["hidden", "submit", "button", "file", "search", "image", "reset"]);
      const NOTE_RE = /note|cover|message|pitch|recruiter|why|introduc|about (you|yourself)|interests? you|good fit/i;

      function modal() {
        const own = [...document.querySelectorAll(".jobs-easy-apply-modal, [data-test-modal-id='easy-apply-modal']")].find(JB.page.isVisible);
        return own || JB.page.visibleDialog(); // now a plain <dialog open>
      }

      // A label often holds its text twice, once on screen and once for screen readers: "QQ" -> "Q".
      function once(s) {
        const h = Math.floor(s.length / 2);
        for (let i = Math.max(1, h - 2); i <= Math.min(s.length - 1, h + 2); i++) if (norm(s.slice(0, i)) === norm(s.slice(i))) return norm(s.slice(0, i));
        return s;
      }

      /** The questions on the current step, one entry per input (FIELDS_JS in portal.py). */
      function fields(root) {
        const clean = s => once(norm(norm(s).replace(/\*/g, "")).replace(/\s*\brequired$/i, ""));
        const marked = s => /\*|\brequired\b/i.test(s || "");
        const labelFor = e => (e.id && root.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest("label");
        // Newer forms: the <label> is empty and the option's text sits next to the input, in a div role=radio
        // (whose aria-label is the question) or in a plain block (the question is then the input's aria-label).
        const wrapper = e => e.closest("[role=radio], [role=checkbox]");
        const ownBlock = e => { // the biggest block holding this option and no other
          let p = e;
          while (p.parentElement && p.parentElement !== root && p.parentElement.querySelectorAll("input[type=radio], input[type=checkbox]").length === 1) p = p.parentElement;
          return p;
        };
        const optionText = e => norm((labelFor(e) || {}).innerText) || norm((wrapper(e) || {}).innerText) || norm(ownBlock(e).innerText).slice(0, 200) || e.value;
        const legend = e => {
          const fs = e.closest("fieldset");
          const lg = fs && fs.querySelector("legend");
          return lg ? lg.innerText : "";
        };
        const ownLabel = e => {
          const lab = labelFor(e);
          if (lab && norm(lab.innerText)) return lab.innerText;
          const by = (e.getAttribute("aria-labelledby") || "").split(/\s+/).map(id => id && document.getElementById(id)).filter(Boolean).map(x => x.innerText).join(" ");
          if (norm(by)) return by;
          if (norm(e.getAttribute("aria-label"))) return e.getAttribute("aria-label");
          if (norm(legend(e))) return legend(e);
          for (let p = e.parentElement, i = 0; p && p !== root && i < 6; p = p.parentElement, i++) if (norm(p.innerText)) return p.innerText.slice(0, 300);
          return e.placeholder || e.name || "";
        };
        const question = e => { // a radio's or checkbox's question: its legend or aria-label, else the text around the group
          if (norm(legend(e))) return legend(e);
          const own = (wrapper(e) && wrapper(e).getAttribute("aria-label")) || e.getAttribute("aria-label");
          if (norm(own) && norm(own) !== norm(optionText(e))) return own;
          const group = e.closest("fieldset, [role=radiogroup], [role=group]");
          if (group && norm(group.getAttribute("aria-label"))) return group.getAttribute("aria-label");
          const same = [...root.querySelectorAll("input")].filter(x => x.type === e.type && x.name && x.name === e.name);
          let p = e.parentElement;
          while (p && p !== root && !same.every(x => p.contains(x))) p = p.parentElement;
          const options = norm(p ? p.innerText : "");
          for (let i = 0; p && p !== root && i < 4 && norm(p.innerText).length <= options.length + 5; i++) p = p.parentElement;
          return p ? p.innerText.slice(0, 300) : "";
        };
        const fieldsets = [...root.querySelectorAll("fieldset")];
        return [...root.querySelectorAll("input, textarea, select")].map((e, i) => {
          const tag = e.tagName.toLowerCase();
          const type = (e.type || "").toLowerCase();
          const choice = type === "radio" || type === "checkbox";
          const raw = choice ? question(e) : ownLabel(e);
          const fs = e.closest("fieldset");
          const group = choice && e.closest("fieldset, [role=radiogroup], [role=group]");
          const sel = tag === "select" ? e.options[e.selectedIndex] : null;
          const unchosen = tag === "select" && (!sel || sel.value === "" || /^select\b/i.test(norm(sel.text)));
          const combo = e.getAttribute("role") === "combobox" || e.getAttribute("aria-autocomplete") === "list";
          return {
            i, tag, type,
            kind: tag === "select" ? "select" : tag === "textarea" ? "textarea" : choice ? type : combo ? "combo" : "text",
            label: clean(raw).slice(0, 200),
            option: choice ? clean(optionText(e)) : "",
            group: !choice ? "" : type === "radio" && e.name ? `r:${e.name}` : fs ? `f:${fieldsets.indexOf(fs)}` : `i:${i}`,
            value: tag === "select" ? (unchosen ? "" : norm(sel.text)) : norm(e.value),
            options: tag === "select" ? [...e.options].map(o => norm(o.text)) : [],
            checked: !!e.checked || (!!wrapper(e) && wrapper(e).getAttribute("aria-checked") === "true"),
            disabled: e.disabled,
            required: e.required || e.getAttribute("aria-required") === "true" || marked(raw)
              || (!!group && (group.getAttribute("aria-required") === "true" || /\*/.test((group.innerText || "").split("\n")[0]))),
            numeric: type === "number" || /numeric/i.test(e.id || ""),
            visible: JB.page.isVisible(e),
          };
        });
      }

      /** The step's fields, once they've stopped changing: options get their text a moment after they appear. */
      async function readFields(root, tries = 5) {
        let got = fields(root);
        for (let i = 0; i < tries; i++) {
          await sleep(700);
          const again = fields(root);
          if (JSON.stringify(again) === JSON.stringify(got)) break;
          got = again;
        }
        return got;
      }

      /** Tick a radio or checkbox the way a person would (the inputs hide behind custom styling); else click its label. */
      function choose(e) {
        const w = e.closest("[role=radio], [role=checkbox]");
        const on = () => e.checked || (!!w && w.getAttribute("aria-checked") === "true");
        (w || e).click();
        const label = !on() && e.labels && e.labels[0];
        if (label) label.click();
        return on();
      }

      return {
        isLoggedIn() {
          return location.pathname.startsWith("/feed");
        },

        searchReady() {
          return !!document.querySelector("[data-occludable-job-id], a[href*='/jobs/view/']") || /no matching jobs/i.test(bodyText());
        },

        /** [job URL, card text] for every card on a search page, after scrolling each into view so it fills in. */
        async collectLinks() {
          for (const card of document.querySelectorAll("[data-occludable-job-id]")) {
            card.scrollIntoView({ block: "center" });
            await sleep(150);
          }
          const cards = new Map();
          for (const card of document.querySelectorAll("[data-occludable-job-id]")) cards.set(card.getAttribute("data-occludable-job-id"), norm(card.innerText));
          for (const a of document.querySelectorAll("a[href*='/jobs/view/']")) { // in case the cards lose that attribute
            const m = a.href.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/);
            if (m && !cards.has(m[1])) cards.set(m[1], norm((a.closest("li") || a).innerText));
          }
          return [...cards].filter(([id]) => /^\d+$/.test(id)).map(([id, text]) => [`${BASE}/jobs/view/${id}/`, text]);
        },

        /** The tab title reads "<title> | <company> | LinkedIn"; the description sits under "About the job". */
        readJob() {
          const m = /^(?:\(\d+\)\s*)?(.+?) \| (.+?) \| LinkedIn$/.exec(document.title);
          let title = m ? m[1].trim() : "";
          let company = m ? m[2].trim() : "";
          if (!m) {
            const h1 = document.querySelector("main h1, h1");
            title = h1 ? norm(h1.innerText) : "";
            const link = [...document.querySelectorAll(".job-details-jobs-unified-top-card__company-name a, main a[href*='/company/']")].find(a => norm(a.innerText));
            company = link ? norm(link.innerText) : "";
          }
          const h = [...document.querySelectorAll("h1, h2, h3")].find(e => /^about the job$/i.test(e.innerText.trim()));
          let p = h && h.parentElement;
          for (let i = 0; p && i < 4 && p.innerText.trim().length < 200; i++) p = p.parentElement;
          const about = (p && p.innerText) || (document.querySelector("main") || {}).innerText || "";
          return { title, company, text: withRange(about) };
        },

        /** The job shows "Applied 3 minutes ago" and a "See application" button once you've applied. */
        isApplied() {
          return APPLIED_RE.test(bodyText()) || !!JB.page.firstVisible(document, SEE_APPLICATION_RE);
        },

        applyState() {
          return {
            easy: !!JB.page.firstVisible(document, EASY_APPLY_RE, ["button"]), // similar-job links mention it too
            applied: this.isApplied(),
            closed: CLOSED_RE.test(bodyText()),
            external: !!JB.page.firstVisible(document, EXTERNAL_APPLY_RE),
          };
        },

        clickEasyApply() {
          JB.page.click(JB.page.firstVisible(document, EASY_APPLY_RE, ["button"]));
        },

        stepReady() {
          const m = modal();
          return (!!m && (!!m.querySelector("input, select, textarea") || Object.values(STEP_RES).some(re => JB.page.firstVisible(m, re, ["button"]))))
            || SENT_RE.test(bodyText());
        },

        sent: () => SENT_RE.test(bodyText()),
        limitHit: () => LIMIT_RE.test(bodyText()),

        modalText() {
          const m = modal();
          return m ? norm(m.innerText) : null;
        },

        /** Fill this step from your answers. Returns the required questions it has no answer for ({ q, kind, options },
         * as lib/page.js fillForm), and the choices it left blank. */
        async fillStep(fill) {
          const root = modal();
          if (!root) return { missing: [], leftBlank: [] };
          const inputs = [...root.querySelectorAll("input, textarea, select")];
          const missing = [];
          const groups = new Map();
          for (const f of await readFields(root)) {
            if (f.disabled || SKIP_TYPES.has(f.type)) continue;
            if (f.kind === "radio" || f.kind === "checkbox") {
              if (FOLLOW_RE.test(f.option) || FOLLOW_RE.test(f.label)) { // "Follow <company>": off unless you want it
                if (f.checked !== fill.followCompanies) (inputs[f.i].closest("[role=checkbox]") || inputs[f.i]).click();
                continue;
              }
              if (!groups.has(f.group)) groups.set(f.group, { label: f.label, kind: f.kind, required: false, checked: false, options: [] });
              const g = groups.get(f.group);
              g.required = g.required || f.required;
              g.checked = g.checked || f.checked;
              g.options.push([f.i, f.option]);
              continue;
            }
            if (!f.visible) continue;
            if (f.kind === "select") { // a prefilled one too: "Phone country code" starts at Andorra
              const k = pick(f.options, answer(f.label, fill));
              if (k != null && plain(f.options[k]) !== plain(f.value)) JB.page.setValue(inputs[f.i], inputs[f.i].options[k].value);
              else if (k == null && !f.value && f.required) missing.push({ q: f.label || "dropdown", kind: "choice", options: f.options.filter(o => o && !/^select\b/i.test(o)) });
              continue;
            }
            if (f.value) continue;
            let given = answer(f.label, fill);
            if (f.kind === "combo") {
              if (!(await JB.page.chooseOption(inputs[f.i], given)) && f.required) missing.push({ q: f.label || "dropdown", kind: "search" });
              continue;
            }
            if (given == null && f.kind === "textarea" && (!f.label || NOTE_RE.test(f.label))) given = fill.note || null;
            if (given == null) {
              if (f.required) missing.push({ q: f.label || "text box", kind: f.kind === "textarea" ? "long" : f.numeric ? "number" : "text" });
              continue;
            }
            JB.page.setValue(inputs[f.i], f.numeric ? JB.answers.numberAnswer(given) : given);
          }
          const leftBlank = [];
          for (const g of groups.values()) {
            if (g.checked) continue;
            const given = answer(g.label, fill);
            const options = g.options.map(([, o]) => o);
            let chosen;
            if (g.kind === "radio") {
              const k = pick(options, given);
              chosen = k == null ? [] : [g.options[k][0]];
            } else if (options.length === 1) { // a lone "I agree" box
              chosen = given && (YES_RE.test(given) || plain(given) === plain(options[0])) ? [g.options[0][0]] : [];
            } else { // "select all that apply": the answer lists the options, comma separated
              const wanted = new Set((given || "").split(/[,;|]/).map(plain).filter(Boolean));
              chosen = g.options.filter(([, o]) => wanted.has(plain(o))).map(([i]) => i);
            }
            for (const i of chosen) choose(inputs[i]);
            if (!chosen.length) {
              leftBlank.push(g.label);
              if (g.required) missing.push({ q: g.label || "choice", kind: g.kind === "radio" || options.length === 1 ? "choice" : "several", options });
            }
          }
          return { missing, leftBlank };
        },

        /** Questions the bot left blank that have an answer now (never send one it didn't choose). */
        async answeredByItself(leftBlank) {
          const root = modal();
          if (!root) return [];
          const checked = new Set((await readFields(root, 1)).filter(f => (f.kind === "radio" || f.kind === "checkbox") && f.checked).map(f => f.label));
          return leftBlank.filter(l => checked.has(l)).sort();
        },

        stepButton() {
          const m = modal();
          if (!m) return null;
          return ["submit", "review", "next"].find(kind => JB.page.firstVisible(m, STEP_RES[kind], ["button"])) || null;
        },

        async pressStep(kind) {
          const button = JB.page.firstVisible(modal(), STEP_RES[kind], ["button"]);
          await JB.page.whenEnabled(button, 2000);
          JB.page.click(button);
        },

        /** What LinkedIn complains about after Next/Review/Submit (ERRORS_JS in portal.py). */
        errors() {
          const root = modal();
          if (!root) return [];
          const ERROR = /invalid|required|please|must|valid|enter |select|larger|smaller|between|at least|at most/i;
          const fieldEls = [...root.querySelectorAll("input, textarea, select")];
          const out = [];
          const seen = new Set();
          const add = (i, q, msg) => {
            const line = q ? `${once(norm(q.replace(/\*/g, ""))).slice(0, 80)}: ${msg}` : msg;
            if (!seen.has(line)) {
              seen.add(line);
              out.push({ i, text: line });
            }
          };
          const described = ":is(input, textarea, select, fieldset, [role=radiogroup], [role=group])";
          for (const e of root.querySelectorAll(`${described}[aria-describedby], ${described}[aria-errormessage]`)) {
            const ids = `${e.getAttribute("aria-describedby") || ""} ${e.getAttribute("aria-errormessage") || ""}`.split(/\s+/).filter(Boolean);
            const msg = norm(ids.map(id => (document.getElementById(id) || {}).innerText || "").join(" ").replace(/\b\d+\s*\/\s*\d+\b/g, ""));
            if (!msg || !(ERROR.test(msg) || e.getAttribute("aria-invalid") === "true")) continue;
            const radio = e.querySelector && e.querySelector("[role=radio][aria-label]");
            const q = e.getAttribute("aria-label") || (e.labels && e.labels[0] && e.labels[0].innerText)
              || (radio && radio.getAttribute("aria-label")) || ((e.querySelector && e.querySelector("legend")) || {}).innerText || "";
            add(fieldEls.indexOf(e), q, msg);
          }
          // Errors not linked to their field: short texts like "This field is required" under a question.
          const SHOWN = /^(this field is required|invalid input|required|please (enter|make|select|provide|choose) .{0,60}|enter a (valid|whole|decimal) .{0,60})$/i;
          for (const el of root.querySelectorAll("p, span, div")) {
            if (el.children.length || !JB.page.isVisible(el) || !SHOWN.test(norm(el.innerText))) continue;
            let p = el.parentElement;
            let q = "";
            for (let i = 0; p && p !== root && i < 6 && !q; p = p.parentElement, i++) {
              const f = p.querySelector("[aria-label]:is(input, textarea, select, [role=radio]), legend, label");
              if (f) q = f.getAttribute("aria-label") || f.innerText;
            }
            add(-1, q, norm(el.innerText));
          }
          for (const el of root.querySelectorAll(".artdeco-inline-feedback--error, [role=alert]")) { // the older layout
            const msg = norm(el.innerText);
            if (!msg || !JB.page.isVisible(el)) continue;
            let q = "";
            for (let p = el.parentElement, i = 0; p && p !== root && i < 6 && !q; p = p.parentElement, i++) {
              const lab = p.querySelector("label, legend");
              if (lab) q = lab.innerText;
            }
            add(-1, q, msg);
          }
          return out.filter(e => !SENT_RE.test(e.text));
        },

        /** Rewrite rejected answers like "0 months" or "9 LPA" as plain numbers. Returns true if any changed. */
        asNumbers(errors) {
          const root = modal();
          if (!root) return false;
          const inputs = [...root.querySelectorAll("input, textarea, select")];
          let changed = false;
          for (const e of errors) {
            const box = inputs[e.i];
            if (!box || box.tagName === "SELECT" || ["radio", "checkbox"].includes(box.type)) continue;
            const number = /\d/.test(box.value) ? JB.answers.numberAnswer(box.value) : "";
            if (number && number !== box.value) {
              JB.page.setValue(box, number);
              changed = true;
            }
          }
          return changed;
        },

        /** Close the "Your application was sent" dialog. */
        async closeDone() {
          await sleep(800);
          const button = JB.page.firstVisible(document, DONE_RE, ["button"]);
          if (button) {
            JB.page.click(button);
            await sleep(800);
          }
        },

        // ------------------------------------------------------ referrals (referral.js drives these)

        /** The job's company page, e.g. https://www.linkedin.com/company/razorpay/. */
        companyUrl() {
          const link = [...document.querySelectorAll(".job-details-jobs-unified-top-card__company-name a, main a[href*='/company/']")].find(a => norm(a.innerText));
          const m = /\/company\/([^/?#]+)/.exec(link ? link.getAttribute("href") || "" : "");
          return m ? `${BASE}/company/${m[1]}/` : null;
        },

        hasCompanyIds: () => !!document.querySelector("a[href*='currentCompany']"),

        /** The company's LinkedIn ids, from its "See all N employees" link (a people search by company). */
        companyIds() {
          for (const a of document.querySelectorAll("a[href*='currentCompany']")) {
            const m = /currentCompany=([^&#]+)/.exec(a.href);
            const ids = m ? decodeURIComponent(m[1]).match(/\d+/g) || [] : [];
            if (ids.length) return ids;
          }
          return [];
        },

        peopleReady() {
          return !!document.querySelector("[data-view-name=people-search-result], [data-chameleon-result-urn], main li a[href*='/in/']") || /no results found/i.test(bodyText());
        },

        searchLimit: () => /monthly (search )?limit|commercial use limit/i.test(bodyText()),

        /** People on a search results page: {slug, name, degree, headline} (PEOPLE_JS in referral.py). */
        people() {
          const slugOf = a => {
            const m = (a.getAttribute("href") || "").match(/\/in\/([^/?#]+)/);
            return m ? decodeURIComponent(m[1]) : "";
          };
          let rows = [...document.querySelectorAll('[data-view-name="people-search-result"], [data-chameleon-result-urn], [data-view-name="search-entity-result-universal-template"]')];
          if (!rows.length) rows = [...document.querySelectorAll("main [role=listitem]")].filter(r => r.querySelector('a[href*="/in/"]') && !r.querySelector("[role=listitem]"));
          if (!rows.length) { // else: the list with the most items linking to profiles
            const lists = new Map();
            for (const li of document.querySelectorAll("main li")) {
              if (li.querySelector('a[href*="/in/"]')) lists.set(li.parentElement, [...(lists.get(li.parentElement) || []), li]);
            }
            rows = [...lists.values()].sort((a, b) => b.length - a.length)[0] || [];
          }
          return rows.map(row => {
            const title = row.querySelector('a[data-view-name="search-result-lockup-title"]'); // the person's own name link
            const links = [...row.querySelectorAll('a[href*="/in/"]')];
            const slug = title ? slugOf(title) : links.length ? slugOf(links[0]) : "";
            const nameOf = a => { // "Name" + a hidden "View Name's profile" in older layouts; else the link's first line
              const hidden = a.querySelector("span[aria-hidden=true]");
              if (hidden && /view .*profile/i.test(a.innerText || "")) return norm(hidden.innerText);
              return (a.innerText || "").split("\n").map(norm).filter(Boolean)[0] || "";
            };
            const name = links.filter(a => slugOf(a) === slug).map(nameOf).find(n => n && n.length < 80) || "";
            const degree = (row.innerText.match(/\b(1st|2nd|3rd\+?)\b/) || [])[1] || "";
            const junk = s => s === name || /^[•·]?\s*(1st|2nd|3rd\+?)$/.test(s) || /^[•·]$/.test(s)
              || /degree connection|^view .*profile$|^(connect|message|follow|following|pending)$/i.test(s);
            const lines = row.innerText.split("\n").map(norm).filter(Boolean).filter(s => !junk(s));
            return { slug, name, degree, headline: lines[0] || "" };
          }).filter(p => p.slug && p.name && p.name !== "LinkedIn Member");
        },

        profileReady: () => !!document.querySelector("main section"),

        /** The profile's address, name (from the tab title), text, and the degree and buttons in its header. */
        profileInfo() {
          const m = /\/in\/([^/?#]+)/.exec(location.pathname);
          const name = /^(?:\(\d+\)\s*)?(.+?) \| LinkedIn$/.exec(document.title);
          const top = document.querySelector("main section");
          return {
            slug: m ? decodeURIComponent(m[1]).toLowerCase() : "",
            name: name ? name[1].trim() : "",
            main: norm((document.querySelector("main") || {}).innerText),
            degree: ((top ? top.innerText : "").match(/\b(1st|2nd|3rd)\b/) || [])[1] || "",
          };
        },

        openMessage() {
          const top = document.querySelector("main section");
          const button = top && JB.page.firstVisible(top, /^\s*message\b/i);
          if (!button) return false;
          JB.page.click(button);
          return true;
        },

        messageBox() {
          const boxes = [...document.querySelectorAll(".msg-form__contenteditable[contenteditable=true], [role=textbox][contenteditable=true]")].filter(JB.page.isVisible);
          return boxes[boxes.length - 1] || null;
        },

        messageBoxReady() {
          return !!this.messageBox();
        },

        /** Type into LinkedIn's message box (an editable block, not a text field), the way a paste would. */
        typeMessage(text) {
          const box = this.messageBox();
          box.focus();
          document.getSelection().selectAllChildren(box);
          if (!document.execCommand("insertText", false, text)) {
            box.innerText = text;
            box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          }
        },

        sendMessageNow() {
          const send = JB.page.firstVisible(document, /^\s*send\s*$/i, ["button"]);
          if (!send) return false;
          JB.page.click(send);
          return true;
        },

        messageBoxEmpty() {
          const box = this.messageBox();
          return !box || !norm(box.innerText); // LinkedIn empties the box once the message has gone
        },

        closeChat() {
          const close = JB.page.firstVisible(document, /^\s*close your (conversation|draft)/i, ["button"]);
          if (close) JB.page.click(close);
        },

        /** Click Connect (straight on the profile, or under More). Returns false if there's no Connect. */
        async openInvite(name) {
          const top = document.querySelector("main section");
          const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const own = new RegExp(`^\\s*invite ${esc} to connect\\s*$`, "i");
          const connect = new RegExp(`${own.source}|^\\s*connect\\s*$`, "i");
          let button = top && JB.page.firstVisible(top, connect);
          if (!button && top) {
            const more = JB.page.firstVisible(top, /^\s*more( actions)?\s*$/i, ["button"]);
            if (more) {
              JB.page.click(more);
              await sleep(800);
              button = JB.page.firstVisible(top, connect, ["button", "menuitem"]) || JB.page.firstVisible(document, own, ["button", "menuitem"]);
            }
          }
          if (!button) {
            this.escape();
            return false;
          }
          JB.page.click(button);
          return true;
        },

        pending() {
          const top = document.querySelector("main section");
          return !!top && !!JB.page.firstVisible(top, /^\s*pending\b/i);
        },

        inviteLimit: () => /weekly invitation limit|limit for (connection requests|invitations)|too many pending invitations/i.test(bodyText()),

        inviteWantsEmail() {
          const d = JB.page.visibleDialog();
          return !!d && /enter (their|his|her) email|how do you know/i.test(d.innerText);
        },

        /** "Add a note" and write it; or say LinkedIn showed a Premium offer instead (free notes used up). */
        async addNote(note) {
          const add = JB.page.firstVisible(document, /^\s*add a (free )?note\s*$/i, ["button"]);
          if (!add) return { added: false, premium: false };
          JB.page.click(add);
          await sleep(1000);
          const box = [...document.querySelectorAll("[role=dialog] textarea, dialog[open] textarea")].find(JB.page.isVisible);
          if (!box) return { added: false, premium: true };
          JB.page.setValue(box, note.slice(0, parseInt(box.getAttribute("maxlength"), 10) || 300));
          return { added: true };
        },

        hasDialog: () => !!JB.page.visibleDialog(),

        /** Close a dialog or menu, like pressing Escape. */
        escape() {
          const d = JB.page.visibleDialog();
          const close = d && JB.page.firstVisible(d, /^\s*(dismiss|close|×|✕)\s*$/i, ["button"]);
          if (close) JB.page.click(close);
          else for (const target of [document.activeElement || document.body, document]) target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        },

        sendInvite(withNote) {
          const d = JB.page.visibleDialog() || document;
          const send = withNote ? JB.page.firstVisible(d, /^\s*send( invitation| now)?\s*$/i, ["button"])
            : JB.page.firstVisible(d, /^\s*send without a note\s*$/i, ["button"]) || JB.page.firstVisible(d, /^\s*send( invitation| now)?\s*$/i, ["button"]);
          if (!send) return false;
          JB.page.click(send);
          return true;
        },

        inviteSent() {
          return /invitation (to .+ )?(was )?sent/i.test(bodyText()) || this.pending();
        },

        connectionsReady: () => !!document.querySelector("main a[href*='/in/']"),

        /** Profile slugs of your most recent connections (that page lists the newest first). */
        async connectionSlugs(scrolls) {
          for (let i = 0; i < scrolls; i++) {
            window.scrollBy(0, 4000);
            await sleep(1500);
          }
          const slugs = [...document.querySelectorAll("main a[href*='/in/']")].map(a => {
            const m = /\/in\/([^/?#]+)/.exec(a.href);
            return m ? decodeURIComponent(m[1]).toLowerCase() : "";
          });
          return [...new Set(slugs.filter(Boolean))];
        },
      };
    })(),
  };

  JB.sites = JB.sites || {};
  JB.sites.linkedin = site;
})(globalThis.JB = globalThis.JB || {});
