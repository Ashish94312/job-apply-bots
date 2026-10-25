// Company sites: applying on a company's own application form when it's on Greenhouse, Lever, Ashby or Workday. It has no
// search: it works through the job links you list in Settings, and the jobs the other sites found that apply on one
// of these (recorded as "Other site", with the link it opened). Your profile and resume fill the standard fields;
// the company's own questions are answered like any site's, asked once when nothing answers them.
//
// Loaded in the background worker (the plain settings, `apply`) and in those forms' pages (`page`, which runs there).
(function (JB) {
  const named = job => (job.company ? `${job.title || "the job"} at ${job.company}` : job.title || "the job");
  const status = (s, note = "") => [s, note];
  const REVIEW = [["Send it", "send", "primary"], ["I'll send it in Chrome", "manual"], ["Skip this job", "skip"], ["Stop run", "stop", "stop"]];
  const SIGN_IN = [["Signed in, continue", "continue", "primary"], ["Skip this job", "skip"], ["Stop run", "stop", "stop"]];
  const CONTINUE = [["Done, continue", "continue", "primary"], ["Stop run", "stop", "stop"]];
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  /** A job link it can apply on: { system, jobId, url } with the form's own address, else null. */
  function parse(link) {
    let u;
    try {
      u = new URL(String(link).trim());
    } catch {
      return null;
    }
    let m;
    if (u.protocol === "https:" && /(^|\.)greenhouse\.io$/.test(u.hostname)) {
      // job-boards.greenhouse.io/<board>/jobs/<id>, boards.greenhouse.io/..., or an embedded form: embed/job_app?for=<board>&token=<id>
      const id = (u.pathname.match(/\/jobs\/(\d+)/) || [])[1] || (/job_app/.test(u.pathname) && u.searchParams.get("token"));
      const board = u.searchParams.get("for") || (u.pathname.match(/^\/([\w-]+)\/jobs\//) || [])[1];
      if (!id || !/^\d+$/.test(id)) return null;
      // the form itself, as companies embed it: a job's page may send you on to the company's careers site instead
      return { system: "greenhouse", jobId: `gh-${id}`, url: board ? `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${id}` : u.href };
    }
    if (u.protocol === "https:" && u.hostname === "jobs.lever.co" && (m = u.pathname.match(new RegExp(`^/([\\w.-]+)/(${UUID})`, "i")))) {
      return { system: "lever", jobId: `lever-${m[2].toLowerCase()}`, url: `https://jobs.lever.co/${m[1]}/${m[2]}/apply` };
    }
    if (u.protocol === "https:" && u.hostname === "jobs.ashbyhq.com" && (m = u.pathname.match(new RegExp(`^/([^/]+)/(${UUID})`, "i")))) {
      return { system: "ashby", jobId: `ashby-${m[2].toLowerCase()}`, url: `https://jobs.ashbyhq.com/${m[1]}/${m[2]}/application` };
    }
    // Workday: <company>.wd5.myworkdayjobs.com/[en-US/]<site>/job/<place>/<title>_<requisition id>, the job's own page
    if (u.protocol === "https:" && /\.(myworkdayjobs|myworkdaysite)\.com$/.test(u.hostname) && (m = u.pathname.match(/^(.*\/job\/.+_([\w-]+?))(?:\/apply.*)?\/?$/))) {
      return { system: "workday", jobId: `wd-${u.hostname.split(".")[0]}-${m[2]}`.toLowerCase(), url: `https://${u.hostname}${m[1]}` };
    }
    return null;
  }

  /** The link an "Other site" job opened, from its note ("apply opens an external site: <url>", "redirected to <url>"). */
  const linkIn = note => ((/(https:\/\/\S+)/.exec(note || "") || [])[1] || "").replace(/[).,]+$/, "");

  /** The jobs to apply to, in order, not done before: your links, then the ones other sites found. */
  function queue(cfg, history) {
    const seen = new Set(Object.values(history).filter(r => r.site === "company" && r.status !== "failed").map(r => r.jobId));
    const out = new Map();
    for (const link of cfg.searchUrls || []) {
      const p = parse(link);
      if (p && !seen.has(p.jobId)) out.set(p.jobId, { url: p.url, jobId: p.jobId, title: "", company: "", text: "" });
    }
    if (cfg.fromOthers) {
      const found = Object.values(history).filter(r => r.status === "external").sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      for (const r of found) {
        const p = parse(linkIn(r.note));
        if (p && !seen.has(p.jobId) && !out.has(p.jobId)) {
          out.set(p.jobId, { url: p.url, jobId: p.jobId, title: r.title, company: r.company, text: "", from: `${r.site}:${r.jobId}` });
        }
      }
    }
    return [...out.values()];
  }

  const site = {
    name: "company",
    label: "Company sites",
    flow: "list",
    jobReadyCss: "input, textarea, select, [data-automation-id=adventureButton]", // a form, or Workday's Apply
    settleMs: 2500, // Ashby's form draws itself after the page loads
    parse,
    queue,
    linkIn,

    jobId(url) {
      return (parse(url) || {}).jobId;
    },

    /** The job and its form are open: fill it from your answers, profile and resume, ask about what's left, then
     * send it (after you've had a look, unless Settings says to send straight away). Returns [status, note]. */
    async apply(run, cfg, job) {
      if ((parse(job.url) || {}).system === "workday") return this.workday(run, cfg, job);
      const resume = await JB.store.resume();
      const note = JB.answers.coverNote(cfg.coverNote, job);
      run.step(`Filling in the application for ${named(job)}`);
      let missing = await run.exec("site.fill", cfg.answers, note, resume);
      while (missing.length) {
        if (missing.some(m => m.kind === "file")) return status("needs_manual", "it wants your resume: add it in Settings > Your profile");
        const learned = await run.learn(missing, cfg, job); // cfg.answers takes what you answer
        if (learned !== true) return run.unanswered(missing, learned);
        missing = await run.exec("site.fill", cfg.answers, note, resume);
      }
      if (cfg.sendMode !== "direct") {
        const go = await run.ask("Filled in: send it?", `${named(job)}. Have a look in the bot's window first if you like.`, REVIEW);
        if (go === "skip") return status("skipped", "declined");
        if (go === "manual") return this.byHand(run, job, "Send it in the bot's window.");
      }
      run.step(`Sending the application for ${named(job)}`);
      await run.exec("site.submit");
      let seen = null;
      for (let i = 0; i < 20; i++) {
        await run.sleep(1000);
        seen = await run.exec("site.result");
        if (seen.sent) return status("applied");
        if (seen.check) break;
        if (seen.errors.length && i >= 3) break;
      }
      const why = seen.check || (seen.errors.length ? `the form says: ${seen.errors.join("; ")}` : "couldn't confirm the application went through");
      // a captcha or an emailed code needs you now, while the form is open; when you aren't watching, leave it for you
      if (seen.check && cfg.sendMode !== "direct") return this.byHand(run, job, `It ${seen.check}: do that in the bot's window, and send it if it's still there.`);
      return status("needs_manual", why);
    },

    /** Workday, a page at a time. Apply; you sign in (each company has its own Workday account, and the bot never
     * sees your password); then each page is filled from your profile, resume and answers, what nothing answers is
     * asked, and Save and Continue, up to Review; there it's sent after you've had a look (unless Settings says to
     * send straight away). Anything Workday still wants on a page (a date, a list the bot doesn't know) you do in
     * the bot's window. Returns [status, note]. */
    async workday(run, cfg, job) {
      const resume = await JB.store.resume();
      const note = JB.answers.coverNote(cfg.coverNote, job);
      const where = new URL(job.url).hostname.split(".")[0];
      run.step(`Starting the application for ${named(job)}`);
      if (!(await run.exec("site.wdStart"))) {
        const step = await run.exec("site.wdStep");
        if (step.done) return status("already_applied");
        return status("needs_manual", "no Apply button on the job's page");
      }
      await run.sleep(1500);
      await run.loaded({ fresh: false });
      await run.sleep(3000); // it draws the page after loading
      let seen = "";
      for (let page = 0; page < 14; page++) {
        const step = await run.exec("site.wdStep");
        if (step.done) return status("applied");
        if (step.signIn) {
          if (seen === "sign in") return status("needs_manual", `not signed in to ${where}'s Workday`);
          seen = "sign in";
          const go = await run.ask("Sign in, then continue", `${named(job)}: sign in to ${where}'s Workday in the bot's window, or create your account there (each company has its own). The bot never sees your password.`, SIGN_IN);
          if (go === "skip") return status("skipped", "declined");
          await run.sleep(3000);
          continue;
        }
        if (step.review) {
          if (cfg.sendMode !== "direct") {
            const go = await run.ask("Filled in: send it?", `${named(job)}. Workday's Review page is open in the bot's window: have a look first if you like.`, REVIEW);
            if (go === "skip") return status("skipped", "declined");
            if (go === "manual") return this.byHand(run, job, "Send it in the bot's window.");
          }
          run.step(`Sending the application for ${named(job)}`);
          await run.exec("site.wdNext");
          for (let i = 0; i < 20; i++) {
            await run.sleep(1000);
            if ((await run.exec("site.wdStep")).done) return status("applied");
          }
          return status("needs_manual", "couldn't confirm the application went through");
        }
        run.step(`Filling in "${step.name}" for ${named(job)}`);
        let missing = await run.exec("site.wdFill", cfg.answers, note, resume);
        while (missing.length) {
          if (missing.some(m => m.kind === "file")) return status("needs_manual", "it wants your resume: add it in Settings > Your profile");
          const learned = await run.learn(missing, cfg, job);
          if (learned !== true) return run.unanswered(missing, learned);
          missing = await run.exec("site.wdFill", cfg.answers, note, resume);
        }
        await run.exec("site.wdNext");
        await run.sleep(3000);
        const after = await run.exec("site.wdStep");
        if (!after.done && after.name === step.name) { // still here: Workday wants something it couldn't give
          const why = after.errors.length ? after.errors.join("; ") : "it didn't go on to the next page";
          if (cfg.sendMode === "direct") return status("needs_manual", `Workday says, on "${step.name}": ${why}`);
          await run.ask("Do this in Chrome, then continue", `${named(job)}, "${step.name}": ${why}\nFix it in the bot's window and press Save and Continue there.`, CONTINUE);
          await run.sleep(1500);
        }
      }
      return status("needs_manual", "the application had too many pages");
    },

    /** You finish it in the bot's window; then see if it went. */
    async byHand(run, job, what) {
      await run.ask("Do this in Chrome, then continue", `${named(job)}: ${what}`, CONTINUE);
      return (await run.exec("site.result")).sent ? status("applied", "finished by hand") : status("needs_manual", "not sent");
    },

    // ---------------------------------------------------------- runs inside the application form's page
    page: (() => {
      const norm = s => (s || "").replace(/\s+/g, " ").trim();
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const SENT_RE = /thank you for (applying|your application)|application (was |has been )?(successfully )?(submitted|received|sent)|we('ve| have) received your application|your application is on its way/i;
      const CODE_RE = /(verification|security|confirmation) code|enter the code/i;
      const SUBMIT_RE = /^\s*submit( (your|my))?( application)?\s*$/i;

      const form = () => document.querySelector("#application-form, .application-form form, form#application_form")
        || document.querySelector(".ashby-application-form-container") || document.querySelector("main form") || document.body;

      /** The resume box: its id, name or label says resume or CV, and it isn't a cover letter or an "autofill from your resume". */
      function isResumeBox(e) {
        const group = e.closest("[role=group][aria-labelledby]");
        const groupLabel = group ? (document.getElementById(group.getAttribute("aria-labelledby")) || {}).innerText : "";
        const said = [e.id, e.name, e.getAttribute("data-qa"), groupLabel, (e.closest("label") || {}).innerText].join(" ");
        const around = norm((e.closest("[class*=autofill]") || {}).innerText);
        return /resume|\bcv\b/i.test(said) && !/cover|autofill/i.test(said + around);
      }

      /** Put your resume in a file box the way picking it would. */
      function attach(box, file) {
        const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], file.name, { type: file.type || "application/pdf" }));
        box.files = transfer.files;
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }

      /** Ashby asks yes/no questions with two buttons (a hidden checkbox behind them): press the one that's the answer. */
      function yesNo(root, answers) {
        const missing = [];
        for (const box of root.querySelectorAll(".ashby-application-form-input-yesno")) {
          const buttons = [...box.querySelectorAll("button")];
          if (!buttons.length || buttons.some(b => b.getAttribute("aria-pressed") === "true")) continue;
          const entry = box.closest(".ashby-application-form-field-entry") || box.parentElement;
          const title = entry.querySelector("label, .ashby-application-form-question-title");
          const q = norm(title ? title.innerText : "");
          const options = buttons.map(b => norm(b.innerText));
          const k = JB.answers.pick(options, JB.answers.answerFor(q, answers));
          if (k != null) JB.page.click(buttons[k]);
          else if (title && /required/i.test(title.className)) missing.push({ q, kind: "choice", options });
        }
        return missing;
      }

      /** Lever's location box empties itself unless one of its suggestions is picked: type, then pick. */
      async function leverLocation(root, answers) {
        const box = root.querySelector("#location-input");
        const picked = root.querySelector("#selected-location");
        if (!box || !picked || picked.value) return []; // not Lever's suggesting box, or one's picked
        const field = JB.page.fields(root)[[...root.querySelectorAll("input, textarea, select")].indexOf(box)];
        // the label wraps the suggestions too: the question is its own part ("Current location ✱")
        const own = box.closest(".application-question")?.querySelector(".application-label");
        if (own) field.label = JB.page.norm(own.innerText);
        const given = JB.answers.answerFor(field.label, answers);
        if (given) {
          await sleep(600); // typed in as a plain box a moment ago: let Lever empty it first, not halfway through typing
          await JB.page.typeIn(box, given);
          let option = null;
          for (let i = 0; i < 16 && !option; i++) {
            await sleep(250);
            option = JB.page.matching([...root.querySelectorAll(".dropdown-location")].filter(JB.page.isVisible), given);
          }
          if (option) {
            JB.page.click(option);
            for (let i = 0; i < 12 && picked && !picked.value; i++) await sleep(250); // Lever notes the pick a moment later
            if (!picked || picked.value || box.value) return [];
          }
        }
        return field.required ? [{ q: field.label, kind: "search" }] : [];
      }

      // ---------------------------------------------------------- Workday
      const WD_DONE_RE = /application (was |has been )?(successfully )?submitted|thank you for (applying|your application)|you('ve| have) (successfully )?applied/i;
      const auto = id => document.querySelector(`[data-automation-id="${id}"]`);
      const wdRoot = () => auto("applyFlowPage") || document.querySelector("main") || document.body;
      const until = async (test, ms) => {
        for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (test()) return true;
        return test();
      };

      /** A Workday dropdown (a button opening a list): its question, whether it's picked, and its options. */
      function wdDropdowns(root) {
        return [...root.querySelectorAll("button[aria-haspopup=listbox]")].filter(JB.page.isVisible).map(b => {
          const label = norm((b.labels && b.labels[0] && b.labels[0].innerText) || (b.getAttribute("aria-label") || "").replace(/\b(select one|required)\b/gi, ""));
          return { b, label, picked: !/^(select one)?$/i.test(norm(b.innerText)), required: /[*✱]\s*$/.test(label) || /required/i.test(b.getAttribute("aria-label") || "") || b.getAttribute("aria-required") === "true" };
        });
      }

      /** Open a Workday list, return its options; `want` picks the one that's the answer. */
      async function wdList(b, want) {
        JB.page.click(b);
        await until(() => document.querySelector("[role=listbox] [role=option]"), 3000);
        const options = [...document.querySelectorAll("[role=listbox] [role=option]")].filter(JB.page.isVisible);
        const option = want ? JB.page.matching(options, want) : null;
        if (option) JB.page.click(option);
        else b.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        await sleep(400);
        return { option, options: options.map(o => norm(o.innerText)).filter(Boolean) };
      }

      return {
        /** Workday's job page: Apply, then "Use My Last Application" when it offers that, else "Apply Manually". That
         * loads the application, so it's clicked just after this returns; true already in the application too. */
        async wdStart() {
          if (auto("progressBarActiveStep") || auto("signInContent")) return true;
          const apply = auto("adventureButton") || JB.page.firstVisible(document, /^\s*apply( now)?\s*$/i);
          if (!apply) return false;
          JB.page.click(apply);
          await until(() => auto("applyManually") || auto("useMyLastApplication") || auto("progressBarActiveStep"), 8000);
          const how = auto("useMyLastApplication") || auto("applyManually");
          if (how) setTimeout(() => JB.page.click(how), 100);
          return true;
        },

        /** Where the application is: the page's name, a sign-in, Review, done, and what Workday complains about. */
        wdStep() {
          const active = auto("progressBarActiveStep");
          const name = norm(active ? active.innerText : "").replace(/^current step \d+ of \d+\s*/i, "");
          const text = document.body ? document.body.innerText : "";
          const errors = [...new Set([...document.querySelectorAll("[data-automation-id*=rror], [role=alert]")]
            .filter(JB.page.isVisible).map(e => norm(e.innerText)).filter(t => t && t.length < 200))].slice(0, 3);
          return {
            name,
            signIn: /sign in|create account/i.test(name) || !!auto("signInContent") || !!auto("createAccountLink"),
            review: /^review$/i.test(name),
            done: !active && WD_DONE_RE.test(text),
            errors,
          };
        },

        /** Fill this page: its boxes as any form's, its dropdowns, and the resume where it's asked for. Returns the
         * questions that must be answered and have no answer. */
        async wdFill(answers, note, resume) {
          const root = wdRoot();
          const missing = [];
          const box = root.querySelector("input[type=file]");
          if (box && !box.files.length && !auto("file-upload-item") && !root.querySelector("[data-automation-id*=fileName], [data-automation-id=delete-file]")) {
            if (resume) {
              attach(box, resume);
              await sleep(3000);
            } else if (/resume|\bcv\b/i.test(norm(root.innerText)) && /[*✱]/.test(norm((box.closest("[data-automation-id*=formField], fieldset, div") || {}).innerText))) {
              missing.push({ q: "Resume", kind: "file" });
            }
          }
          missing.push(...(await JB.page.fillForm(root, answers, note, { requiredOnly: true })));
          for (const d of wdDropdowns(root)) {
            if (d.picked) continue;
            const given = JB.answers.answerFor(d.label, answers);
            const { option, options } = await wdList(d.b, given);
            if (!option && d.required) missing.push({ q: d.label, kind: "choice", options });
          }
          return missing;
        },

        /** Save and Continue, or Submit on Review. */
        wdNext() {
          const next = auto("bottom-navigation-next-button") || auto("pageFooterNextButton")
            || JB.page.firstVisible(document, /^\s*(save and continue|continue|next|submit)\s*$/i, ["button"]);
          if (!next) return false;
          JB.page.click(next);
          return true;
        },

        isLoggedIn: () => true,

        readJob() {
          // in this order: a page has its site's name in an h1 before the job's own title (Workday's header)
          const title = ["[data-automation-id=jobPostingHeader]", ".posting-headline h2", "h1.section-header", ".job__title h1", "h1"]
            .map(css => document.querySelector(css)).find(Boolean);
          const fromTitle = document.title.split(/ @ | - | at /); // Ashby "<title> @ <company>", Lever "<company> - <title>"
          let company = "";
          if (location.hostname === "jobs.lever.co") company = fromTitle[0];
          else if (location.hostname === "jobs.ashbyhq.com") company = fromTitle.length > 1 ? fromTitle[fromTitle.length - 1] : "";
          else if (/myworkday/.test(location.hostname)) company = location.hostname.split(".")[0]; // nvidia.wd5.myworkdayjobs.com
          else company = /Job Application for .+ at (.+)$/.exec(document.title)?.[1] || ""; // Greenhouse
          // else the company's name in the address: greenhouse "for=<board>", lever and ashby "/<company>/"
          company = company || new URL(location.href).searchParams.get("for") || location.pathname.split("/")[1] || "";
          return { title: norm(title ? title.innerText : fromTitle[0]).slice(0, 150), company: norm(company).slice(0, 100), text: norm(document.body.innerText).slice(0, 4000) };
        },

        /** Fill the form; returns the questions that must be answered and have no answer ([{ q, kind, options }],
         * kind "file" for the resume when there's none to give). */
        async fill(answers, note, resume) {
          const root = form();
          const missing = [];
          const box = [...root.querySelectorAll("input[type=file]")].find(isResumeBox);
          if (box && !box.files.length && !/\.(pdf|docx?)\b/i.test(norm(box.closest("div, label")?.innerText))) {
            if (resume) {
              attach(box, resume);
              await sleep(3000); // Lever reads it and fills in what it finds
            } else if (JB.page.isRequired(box, "") || /[*✱]/.test(norm((box.closest("label") || {}).innerText))) {
              missing.push({ q: "Resume", kind: "file" });
            }
          }
          missing.push(...(await JB.page.fillForm(root, answers, note, { requiredOnly: true })), ...yesNo(root, answers));
          if (location.hostname === "jobs.lever.co") {
            const where = await leverLocation(root, answers); // fillForm typed it in, and Lever emptied it: pick it from its list
            missing.splice(0, missing.length, ...missing.filter(m => !where.length || m.q !== where[0].q), ...where);
          }
          return missing;
        },

        submit() {
          const button = JB.page.firstVisible(document, SUBMIT_RE, ["button"]) || document.querySelector("#btn-submit, button[type=submit]");
          if (!button) return false;
          JB.page.click(button);
          return true;
        },

        /** After sending: did it go, does it want something from you (a captcha, an emailed code), or what's wrong. */
        result() {
          const text = document.body ? document.body.innerText : "";
          const sent = SENT_RE.test(text) || /\/(confirmation|thanks)\b/.test(location.pathname);
          const challenge = [...document.querySelectorAll("iframe")].some(f => /recaptcha.*bframe|hcaptcha.*challenge/i.test(f.src) && f.getBoundingClientRect().height > 100);
          const code = !sent && CODE_RE.test(text) && [...document.querySelectorAll("input")].some(e => JB.page.isVisible(e) && /code/i.test(`${e.name} ${e.id} ${e.getAttribute("aria-label")}`));
          const shown = [...document.querySelectorAll("[class*=error], [role=alert]")]
            .filter(e => JB.page.isVisible(e) && !e.querySelector("[class*=error]")).map(e => norm(e.innerText));
          // a box the browser itself won't send the form without (it says so in a bubble the bot can't read)
          const box = document.querySelector("form") && [...document.querySelector("form").elements].find(e => e.willValidate && !e.checkValidity());
          const invalid = box ? `${norm(JB.page.fields(box.form).find(f => f.name === box.name && f.name)?.label || box.labels?.[0]?.innerText || box.name || "a box")}: ${box.validationMessage}` : "";
          const errors = [...new Set([...shown, invalid].filter(t => t && t.length < 200))].slice(0, 3);
          return { sent, errors, check: challenge ? "asks you to prove you're human" : code ? "asks for a code it emailed you" : "" };
        },

        isApplied() {
          return this.result().sent;
        },
      };
    })(),
  };

  JB.sites = JB.sites || {};
  JB.sites.company = site;
})(globalThis.JB = globalThis.JB || {});
