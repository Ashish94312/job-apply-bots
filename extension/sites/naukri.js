// Naukri: where its jobs are, how to read them, and its questions chat. There's no Python bot for Naukri: this
// was written for the extension.
//
// Searches are /<keyword>-jobs?k=<keyword>&experience=N (in a city: /<keyword>-jobs-in-<city>?..&l=<city>), 20 jobs
// a page, later pages /<keyword>-jobs-2, -3, ... experience=N lists jobs open to N years, so it's the top of your
// range; jobAge=N narrows to jobs posted in the last N days. Each result card shows "X-Y Yrs", so jobs asking for
// too much experience are skipped without opening them. On a job, "Apply" either applies straight away or opens a
// chat drawer with the recruiter's questions, one at a time: a text box, options to pick or chips to click, then
// Save. "Apply on company site" is recorded as external. Naukri caps applications per day and says "Your daily
// quota has been expired" once they're used up: the run stops there. Loaded in the background worker (settings,
// the questions loop) and in Naukri's pages (`page`, which reads and fills them).
(function (JB) {
  const BASE = "https://www.naukri.com";
  const JOB_AGE = { day: 1, week: 7, month: 30 }; // Naukri's own "Freshness" choices include these
  const JOB_URL_RE = /naukri\.com\/job-listings-[^?#]*?-(\d{6,})(?:[/?#]|$)/;
  const MAX_QUESTIONS = 15;
  const QUOTA = "Naukri says today's applications are used up (its daily quota). Try again tomorrow.";

  const status = (s, note = "") => [s, note];
  const clip = s => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  const dailyLimit = () => Object.assign(new Error(QUOTA), { stopRun: QUOTA });
  const query = pairs => pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"); // %20 for spaces, like Naukri's own

  const site = {
    name: "naukri",
    label: "Naukri",
    country: "IN", // its jobs are all in India (lib/places.js)
    domain: "naukri.com",
    loginUrl: `${BASE}/nlogin/login`,
    loginCheckUrl: `${BASE}/mnjuser/homepage`, // sends you to the login page if you aren't
    // the jobs you applied to, with what Naukri says of each ("Application viewed", "Recruiter action", "Not shortlisted")
    replies: { pages: [`${BASE}/myapply/historypage`] },
    loginHint: "password, OTP or Google",
    jobLinkCss: "a[href*='/job-listings-']",
    jobReadyCss: "h1",
    jobUrlRe: JOB_URL_RE,
    paged: true, // 20 jobs a page, later pages /<search>-2, -3, ...
    settleMs: 2500, // the apply buttons show a moment after the heading
    searchHost: /^https:\/\/(www\.)?naukri\.com\//,
    JOB_AGE,

    jobId(url) {
      return this.jobUrlRe.exec(url)[1];
    },

    /** One search per keyword and city (or all of India), with your experience and how recent in the URL. */
    searchUrls(cfg) {
      const { slug } = JB.filters;
      const years = cfg.maxExperience ?? cfg.minExperience;
      const places = cfg.locations && cfg.locations.length ? cfg.locations : [""];
      const urls = [];
      for (const keyword of cfg.keywords || []) {
        for (const place of places) {
          const params = [["k", keyword], ...(place ? [["l", place]] : [])];
          if (years != null) params.push(["experience", years]);
          if (JOB_AGE[cfg.postedWithin]) params.push(["jobAge", JOB_AGE[cfg.postedWithin]]);
          const path = place ? `${slug(keyword)}-jobs-in-${slug(place)}` : `${slug(keyword)}-jobs`;
          urls.push(`${BASE}/${path}?${query(params)}`);
        }
      }
      return JB.filters.uniqueUrls([...urls, ...(cfg.searchUrls || [])]);
    },

    /** "/python-jobs?k=python" -> "/python-jobs-2?k=python" */
    searchPageUrl(url, n) {
      if (n === 1) return url;
      const u = new URL(url);
      u.pathname = `${u.pathname.replace(/\/+$/, "")}-${n}`;
      return u.toString();
    },

    searchLabel(url) {
      try {
        const q = new URL(url).searchParams;
        return q.get("k") ? [q.get("k"), q.get("l")].filter(Boolean).join(", ") : null;
      } catch {
        return null;
      }
    },

    // ---------------------------------------------------------- applying, question by question (runs in the worker)

    /** Click Apply and answer the chat's questions until Naukri says it's sent. Returns [status, note]; throws to stop
     * the run when the daily quota is used up. */
    async apply(run, cfg, job) {
      const state = await run.exec("site.applyState");
      if (state.applied) return status("already_applied");
      if (state.closed) return status("skipped", "job is closed");
      if (!state.apply && state.external) {
        const link = await run.followOut("site.clickCompanySite");
        return status("external", link ? `apply opens an external site: ${link}` : "applies on the company website");
      }
      if (!state.apply) return status("needs_manual", "no Apply button found");
      await run.exec("site.clickApply");

      let answered = null; // the last question answered: what was asked, what it got, and what the chat looked like
      let asked = 0;
      for (let end = Date.now() + 15000; Date.now() < end; await run.sleep(800)) {
        const chat = await run.exec("site.chatState");
        if (chat.quota) throw dailyLimit();
        if (chat.sent) {
          await run.exec("site.dismiss");
          return status("applied");
        }
        if (!chat.open || !chat.kind) continue; // not open yet, or the next question is still being typed
        const key = `${chat.answers}|${chat.question}`;
        if (answered && answered.key === key) { // still on the question just answered
          if (Date.now() - answered.at < 8000) continue;
          return status("needs_manual", `Naukri didn't take "${answered.given}" for: ${clip(answered.question)}${chat.error ? ` (${chat.error})` : ""}`);
        }
        let question = chat.question;
        let given;
        if (answered && chat.rejected) { // asked again, e.g. "Please enter a valid number": "8 LPA" -> "8", once
          const number = /\d/.test(answered.given) ? JB.answers.numberAnswer(answered.given) : "";
          if (answered.retried || !number || number === answered.given) {
            return status("needs_manual", `Naukri didn't take "${answered.given}" for: ${clip(answered.question)} (${clip(chat.question)})`);
          }
          [question, given] = [answered.question, number];
        } else {
          if (++asked > MAX_QUESTIONS) return status("needs_manual", "too many questions");
          given = JB.answers.answerFor(question, cfg.answers);
          if (given == null) {
            const missing = [{ q: question, kind: { radio: "choice", chips: "choice", checkbox: "several" }[chat.kind] || "text", options: chat.options }];
            const learned = await run.learn(missing, cfg, job);
            if (learned !== true) return run.unanswered(missing, learned);
            given = JB.answers.answerFor(question, cfg.answers);
          }
        }
        run.step(`Answering "${clip(question)}" for ${job.title || "the job"}`);
        if (!(await run.exec("site.answerChat", given))) {
          return status("needs_manual", given == null ? `unanswered: ${question.slice(0, 60)}` : `no option fits "${given}": ${question.slice(0, 60)}`);
        }
        answered = { key, question, given, at: Date.now(), retried: !!answered && chat.rejected };
        end = Date.now() + 15000;
      }
      if (await run.exec("isApplied")) return status("applied");
      const chat = await run.exec("site.chatState");
      return status("needs_manual", chat.open ? "the questions chat stopped with nothing to answer" : "couldn't confirm the application went through");
    },

    // ---------------------------------------------------------- runs inside Naukri's pages
    page: (() => {
      const norm = s => (s || "").replace(/\s+/g, " ").trim();
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const bodyText = () => (document.body ? document.body.innerText : "");
      const APPLY_RE = /^\s*apply( now)?\s*$/i;
      const COMPANY_SITE_RE = /^\s*apply on company (site|website)\s*$/i;
      const APPLIED_RE = /^\s*applied\s*$/i;
      const SENT_RE = /(you have )?successfully applied|applied successfully|application (has been )?(sent|submitted)/i;
      const QUOTA_RE = /daily quota|quota (has been |is )?(expired|exhausted|over)|daily (apply|application) limit/i;
      const CLOSED_RE = /no longer accepting applications|this job (has )?expired|job is no longer (available|active)|job (has been )?closed/i;
      const NO_RESULTS_RE = /no results found|could not find (any )?jobs|couldn't find (any )?jobs|no (matching )?jobs found/i;
      // The chat opens with a greeting before the first question; "Please enter a valid number" asks again.
      const INTRO_RE = /^(hi|hello|hey)\b|kindly answer|answer (all )?the (recruiter'?s )?questions|thank you for (showing|your) interest/i;
      const REJECTED_RE = /^(please )?(enter|provide|select|choose|give) an? valid|^(invalid|incorrect)\b|\bnot an? valid\b|only (numbers|digits|numeric)|try again/i;
      const DRAWER_CSS = "[id*='ChatbotContainer'], .chatbot_Drawer";
      const SKIP_CHIP_RE = /^\s*skip( this question)?\s*$/i;

      const drawer = () => [...document.querySelectorAll(DRAWER_CSS)].find(JB.page.isVisible) || null;
      const isUser = item => item.classList.contains("userItem") || !!item.querySelector(".userMsg");
      const textOf = item => norm((item.querySelector(".msg") || item).innerText);
      // Options hide their inputs behind custom styling: count an option as shown when its label is.
      const shown = e => JB.page.isVisible(e) || [...(e.labels || [])].some(JB.page.isVisible) || (!!e.parentElement && JB.page.isVisible(e.parentElement));
      const optionText = e => norm((e.labels && e.labels[0] && e.labels[0].innerText) || (e.closest("label") || {}).innerText || e.value);
      // The option that is the answer; for a length of time, the one covering it ("30 days" -> "1 Month").
      const choose = (options, given) => JB.answers.pick(options, given) ?? JB.answers.pickDuration(options, given);

      /** What the chat wants answered now (not your earlier answers above it). */
      function controls(d) {
        const own = e => !e.closest(".userItem");
        const enabled = e => own(e) && !e.disabled;
        const radios = [...d.querySelectorAll("input[type=radio]")].filter(e => enabled(e) && shown(e));
        const group = radios.length ? radios[radios.length - 1].name : ""; // the newest question's options
        return {
          radios: radios.filter(e => e.name === group),
          boxes: [...d.querySelectorAll("input[type=checkbox]")].filter(e => enabled(e) && shown(e)),
          chips: [...d.querySelectorAll(".chatbot_Chip, [class*='chatbot_Chip']")].filter(e => own(e) && JB.page.isVisible(e) && !e.querySelector(".chatbot_Chip, [class*='chatbot_Chip']")),
          text: [...d.querySelectorAll("[contenteditable=true], textarea, input[type=text], input:not([type])")].find(e => enabled(e) && JB.page.isVisible(e)) || null,
        };
      }

      /** Save itself, not the block around it (".sendMsgbtn_container" has "sendMsg" in its name too). */
      function saveButton(d) {
        const css = ".sendMsg, [class*='sendMsg']";
        return [...d.querySelectorAll(css)].find(e => JB.page.isVisible(e) && !e.querySelector(css))
          || JB.page.firstVisible(d, /^\s*(save|send|submit)\s*$/i, ["button"]);
      }

      // Save sits in a "send disabled" block until there's an answer.
      const saveOff = b => b.disabled || b.getAttribute("aria-disabled") === "true"
        || [b, b.parentElement, b.parentElement && b.parentElement.parentElement].some(e => e && /\bdisabled\b/.test(e.getAttribute("class") || ""));

      async function save(d) {
        const button = saveButton(d);
        if (!button) return false;
        for (let i = 0; i < 30 && saveOff(button); i++) await sleep(100); // it turns on once it has seen the answer
        JB.page.click(button);
        return true;
      }

      /** Type into the chat's box (an editable block, or now and then a plain text field) the way typing would. */
      function type(box, text) {
        if (box.isContentEditable) {
          box.focus();
          document.getSelection().selectAllChildren(box);
          if (!document.execCommand("insertText", false, text)) {
            box.innerText = text;
            box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          }
          box.dispatchEvent(new KeyboardEvent("keyup", { key: text.slice(-1), bubbles: true }));
        } else {
          JB.page.setValue(box, text, { blur: false });
        }
      }

      return {
        isLoggedIn() {
          return location.pathname.startsWith("/mnjuser");
        },

        /** [job id, card text] for each job on the list of ones you applied to. */
        appliedCards() {
          const cards = new Map();
          for (const a of document.querySelectorAll("a[href*='/job-listings-']")) {
            if (!JB.site.jobUrlRe.test(a.href)) continue;
            const id = JB.site.jobId(a.href);
            const card = a.closest("article, li, [class*=tuple], [class*=card]") || a.parentElement;
            const text = norm(card.innerText).slice(0, 500);
            if (text.length > (cards.get(id) || "").length) cards.set(id, text);
          }
          return [...cards];
        },

        searchReady() {
          return !!document.querySelector(".srp-jobtuple-wrapper, a[href*='/job-listings-']") || NO_RESULTS_RE.test(bodyText());
        },

        /** [job URL, card text] for every result card; the card has the "X-Y Yrs" the experience filter reads. */
        collectLinks() {
          const rows = new Map();
          const add = (a, card) => {
            const m = JOB_URL_RE.exec(a.href);
            if (!m) return;
            const url = a.href.split(/[?#]/)[0];
            const text = norm(card.innerText);
            if (text.length > (rows.get(url) || "").length) rows.set(url, text);
          };
          for (const card of document.querySelectorAll(".srp-jobtuple-wrapper, .cust-job-tuple, article.jobTuple")) {
            const a = card.querySelector("a.title[href], a[href*='/job-listings-']");
            if (a) add(a, card);
          }
          for (const a of document.querySelectorAll("a[href*='/job-listings-']")) if (!rows.has(a.href.split(/[?#]/)[0])) add(a, a);
          return [...rows];
        },

        /** The heading is the title; the company links to its Naukri page; the header has "1 - 3 years". */
        readJob() {
          const h1 = document.querySelector("h1");
          const title = h1 ? norm(h1.innerText) : "";
          const co = [...document.querySelectorAll("[class*='jd-header-comp-name'] a, [class*='comp-name'] a, a[href*='-jobs-careers-']")].find(a => norm(a.innerText));
          let header = h1;
          for (let i = 0; header && header.parentElement && i < 6 && !/\d\s*(-|–|to)\s*\d+\s*(years?|yrs?)/i.test(header.innerText); i++) header = header.parentElement;
          const about = document.querySelector("[class*='job-desc'], [class*='JDC'], [class*='dang-inner-html']");
          const text = [header && header !== document.body ? header.innerText : "", about ? about.innerText : ""].filter(Boolean).join("\n");
          return { title, company: co ? norm(co.innerText) : "", text: text || bodyText() };
        },

        /** The job's own button reads "Applied", or Naukri says it's done. */
        isApplied() {
          return !!document.querySelector("#already-applied") || !!JB.page.firstVisible(document, APPLIED_RE, ["button"]) || SENT_RE.test(bodyText());
        },

        applyState() {
          const own = document.querySelector("#apply-button");
          return {
            apply: !!(own && JB.page.isVisible(own)) || !!JB.page.firstVisible(document, APPLY_RE, ["button"]),
            external: !!document.querySelector("#company-site-button") || !!JB.page.firstVisible(document, COMPANY_SITE_RE),
            applied: this.isApplied(),
            closed: CLOSED_RE.test(bodyText()),
          };
        },

        clickApply() {
          const own = document.querySelector("#apply-button");
          JB.page.click(own && JB.page.isVisible(own) ? own : JB.page.firstVisible(document, APPLY_RE, ["button"]));
        },

        /** Where the chat is: the question asked since your last answer, what kind of answer it wants, and whether
         * Naukri has said the application went (or the day's quota is used up). */
        chatState() {
          const d = drawer();
          const state = {
            open: !!d, sent: SENT_RE.test(bodyText()), quota: QUOTA_RE.test(bodyText()),
            question: "", kind: null, options: [], answers: 0, rejected: false, error: "",
          };
          if (!d) return state;
          const items = [...d.querySelectorAll(".chatbot_ListItem")];
          const last = items.map(isUser).lastIndexOf(true);
          state.answers = items.filter(isUser).length;
          const asking = items.slice(last + 1).map(textOf).filter(Boolean);
          const real = asking.filter(t => !INTRO_RE.test(t));
          state.question = (real.length ? real : asking).join(" ").slice(0, 300);
          state.rejected = last >= 0 && REJECTED_RE.test(state.question);
          const c = controls(d);
          state.kind = c.radios.length ? "radio" : c.boxes.length ? "checkbox" : c.chips.length ? "chips" : c.text ? "text" : null;
          state.options = (c.radios.length ? c.radios.map(optionText) : c.boxes.length ? c.boxes.map(optionText)
            : c.chips.filter(e => !SKIP_CHIP_RE.test(e.innerText)).map(e => norm(e.innerText))).filter(Boolean);
          const error = [...d.querySelectorAll("[class*=error i]")].find(e => JB.page.isVisible(e) && norm(e.innerText));
          state.error = error ? norm(error.innerText).slice(0, 120) : "";
          return state;
        },

        /** Answer the question in the chat with `given` and send it. False if it can't: no answer, or no option is it
         * or covers it (the bot never picks one you didn't give). */
        async answerChat(given) {
          const d = drawer();
          if (!d || given == null || given === "") return false;
          const c = controls(d);
          if (c.radios.length) {
            const k = choose(c.radios.map(optionText), given);
            if (k == null) return false;
            const radio = c.radios[k];
            radio.click();
            if (!radio.checked && radio.labels && radio.labels[0]) radio.labels[0].click();
            await sleep(300);
            return save(d);
          }
          if (c.boxes.length) { // "select all that apply": the answer lists the options, comma separated
            const chosen = JB.answers.pickSeveral(c.boxes.map(optionText), given).map(k => c.boxes[k]);
            if (!chosen.length) return false;
            for (const b of chosen) if (!b.checked) b.click();
            await sleep(300);
            return save(d);
          }
          const chips = c.chips.filter(e => !SKIP_CHIP_RE.test(e.innerText));
          const k = choose(chips.map(e => norm(e.innerText)), given);
          if (k != null) { // a chip sends itself
            JB.page.click(chips[k]);
            return true;
          }
          if (!c.text) return false;
          type(c.text, given);
          await sleep(300);
          return save(d);
        },

        /** "Apply on company site": a link gives its address, a button is clicked. */
        clickCompanySite() {
          const button = document.querySelector("#company-site-button") || JB.page.firstVisible(document, COMPANY_SITE_RE);
          if (!button) return null;
          const a = button.closest("a[href]");
          if (a && /^https?:/.test(a.href)) return a.href;
          JB.page.click(button);
          return null;
        },

        /** Close the chat drawer (a half-answered one, or one left open after applying). */
        dismiss() {
          const d = drawer();
          if (!d) return false;
          const close = d.querySelector("[class*='crossIcon'], [class*='chatBot-ic-cross'], [aria-label='close' i]");
          if (close) JB.page.click(close);
          else for (const target of [d, document]) target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          return true;
        },
      };
    })(),
  };

  JB.sites = JB.sites || {};
  JB.sites.naukri = site;
})(globalThis.JB = globalThis.JB || {});
