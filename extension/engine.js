// The run loop (ported from run.py). Runs in the background worker; each run drives its own Chrome window and
// reaches into the site's pages through lib/page.js. Its state (log, question for you) is kept in
// chrome.storage.session as "run:<site>", where the dashboard watches it.
(function (JB) {
  const S = { APPLIED: "applied", ALREADY: "already_applied", SKIPPED: "skipped", MANUAL: "needs_manual", EXTERNAL: "external", FAILED: "failed" };
  const ICONS = { applied: "+", already_applied: "=", skipped: "-", needs_manual: "!", external: ">", failed: "x" };
  const CONTINUE = [["Done, continue", "continue", "primary"], ["Stop run", "stop", "stop"]];
  const LEARN = [["Save and continue", "save", "primary"], ["I'll do it in Chrome", "manual"], ["Skip this job", "skip"], ["Stop run", "stop", "stop"]];
  const KEEP = [["Keep them", "save", "primary"], ["Don't keep them", "no"]];
  const CHECK_RE = /just a moment|attention required|verify you are human|captcha|security check/i;
  const MAX_LOG = 3000;
  const MAX_EVENTS = 400;

  class Stopped extends Error {}
  class WindowClosed extends Error {}

  const random = (lo, hi) => lo + Math.random() * (hi - lo);
  const firstLine = e => String((e && e.message) || e).split("\n")[0];
  const label = job => `${job.title || "?"} @ ${job.company || "?"}`;
  const named = job => (job.company ? `${job.title || "the job"} at ${job.company}` : job.title || "the job");
  const pageFiles = site => ["lib/filters.js", "lib/answers.js", "lib/page.js", `sites/${site}.js`];

  /** Answers you just gave, first from now on: for this job, and the rest of the run (`run`: a job's settings are a
   * copy, lib/places.js forJob, whose answers for the job's country still come before these). */
  function keep(cfg, given) {
    for (const c of new Set([cfg, cfg.run].filter(Boolean))) {
      for (const a of given) c.answers.unshift([`=${JB.answers.questionKey(a.q)}`, String(a.answer).trim()]);
    }
  }

  /** "https://www.hirist.tech/search/generative-ai?minexp=1" -> "generative ai" */
  function searchLabel(url) {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop() || url;
      return decodeURIComponent(last).replace(/-jobs$/, "").replace(/[-_]+/g, " ");
    } catch {
      return url;
    }
  }

  /** Runs in the page's own world: note the URLs it opens with window.open (Chrome blocks those, see clickApply). */
  function watchWindowOpen() {
    if (window.__jobBotsOpened) return;
    window.__jobBotsOpened = [];
    const open = window.open;
    window.open = function (url, ...rest) {
      window.__jobBotsOpened.push(String(url || ""));
      return open.call(this, url, ...rest);
    };
  }

  /** Runs in the site's tab: call a lib/page.js or site function there (structured-clone results only). */
  function callInPage(siteName, path, args) {
    const JB = self.JB;
    if (!JB || !JB.page || !JB.sites || !JB.sites[siteName]) return { missing: true };
    JB.site = JB.sites[siteName];
    return Promise.resolve()
      .then(() => JB.page.call(path, args))
      .then(value => ({ value }), e => ({ error: String((e && e.stack) || e) }));
  }

  const runs = {}; // site -> its Run while one is going

  // A worker with nothing to do is shut down after 30 s, timers or not; any extension call counts as activity.
  let keepAlive = null;
  function updateKeepAlive() {
    const busy = Object.keys(runs).length > 0;
    if (busy && !keepAlive) keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
    if (!busy && keepAlive) keepAlive = clearInterval(keepAlive) || null;
  }

  function updateBadge() {
    const all = Object.values(runs);
    const waiting = all.some(r => r.state.prompt);
    chrome.action.setBadgeText({ text: waiting ? "!" : all.length ? "on" : "" });
    chrome.action.setBadgeBackgroundColor({ color: waiting ? "#A45A00" : "#2741C4" });
  }

  class Run {
    constructor(siteName, action, opts) {
      this.site = JB.sites[siteName];
      this.action = action;
      this.opts = opts || {};
      this.dry = action === "dry-run" || action === "refer-dry-run";
      if (action === "refer-dry-run") this.action = "refer";
      this.stopping = false;
      this.tabId = null;
      this.windowId = null;
      this.reply = null;
      this.saveTimer = null;
      this.asked = new Set(); // questions asked about on this job (their keys): each only once
      this.pending = null; // the questions this job is being left for you over
      this.state = {
        id: `${siteName}-${Date.now()}`, site: siteName, action, running: true, started: Date.now(), ended: null,
        stopped: false, error: "", log: [], prompt: null,
        now: "", // what it's doing, in words
        events: [], // searches and job results, for the dashboard's activity list
        page: null, // the search page being worked through: one cell per job listed
      };
    }

    // ---------------------------------------------------------- state, log, questions

    save(now = false) {
      clearTimeout(this.saveTimer);
      const write = () => chrome.storage.session.set({ [`run:${this.site.name}`]: this.state });
      if (now) return write();
      this.saveTimer = setTimeout(write, 200);
    }

    log(line = "") {
      this.state.log.push(line);
      if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
      this.save();
    }

    step(text) {
      this.state.now = text;
      this.save();
    }

    event(e) {
      this.state.events.push({ ts: Date.now(), ...e });
      if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
      this.save();
    }

    /** Update the current search page's cell for this job. */
    mark(url, change) {
      const cell = this.state.page && this.state.page.cells.find(c => c.url === url);
      if (cell) Object.assign(cell, change);
      this.save();
    }

    /** Show a question on the dashboard and wait for the answer. "stop" stops the run. With `fields` (questions,
     * each { q, kind, options }) the dashboard shows a box for each, and "save" comes back as { answers }. */
    async ask(title, text, choices, fields = null) {
      this.state.prompt = { id: Date.now(), title, text, choices, fields };
      this.save(true);
      updateBadge();
      const value = await new Promise(resolve => { this.reply = resolve; });
      this.reply = null;
      this.state.prompt = null;
      this.save(true);
      updateBadge();
      if (value === "stop" || this.stopping) throw new Stopped();
      return value;
    }

    answer(id, value) {
      if (this.reply && this.state.prompt && this.state.prompt.id === id) this.reply(value);
    }

    stop() {
      this.stopping = true;
      if (this.reply) this.reply("stop");
    }

    /** A form's questions with no answer yet ([{ q, kind, options }]). With "Pause on questions" on, ask you on the
     * dashboard and keep your answers: true means fill the form again with them. Else false, or what you chose
     * instead ("manual": do it in Chrome, "skip"). */
    async learn(missing, cfg, job) {
      const key = JB.answers.questionKey;
      if (!this.opts.assist || missing.some(m => !key(m.q) || this.asked.has(key(m.q)))) return false; // asked already: it didn't take
      missing.forEach(m => this.asked.add(key(m.q)));
      const fields = missing.map(({ q, kind, options }) => ({ q, kind: kind || "text", options: options || [] }));
      const reply = await this.ask(`${missing.length > 1 ? `${missing.length} questions` : "A question"} it has no answer for`,
        `${named(job)}. Answer once and it's kept for next time (Settings > Your answers).`, LEARN, fields);
      if (typeof reply !== "object") return reply;
      const given = reply.answers.filter(a => String(a.answer ?? "").trim());
      if (given.length < missing.length) return false;
      await JB.store.learn(given, this.site.name);
      keep(cfg, given);
      this.log(`  Kept ${given.length} answer${given.length > 1 ? "s" : ""} for next time`);
      return true;
    }

    /** You finish the job in the bot's window. What you enter there for the questions it had no answer for is
     * watched, and kept for next time if you say so. Returns whether it went (`applied`: how to tell). */
    async byHand(job, note, cfg, applied) {
      const pending = this.pending || [];
      let watching = false;
      try {
        watching = pending.length > 0 && (await this.exec("watchAnswers", pending.map(m => m.q)));
      } catch (e) {
        if (this.isStop(e)) throw e;
      }
      await this.ask("Do this in Chrome, then continue", `${named(job)}: ${note}\nFinish it in the bot's window.`, CONTINUE);
      if (watching) await this.keepTyped(pending, cfg);
      return !!(await applied());
    }

    /** Offer to keep what you entered in Chrome for the questions it had no answer for. */
    async keepTyped(pending, cfg) {
      let typed;
      try {
        typed = (await this.exec("typedAnswers")) || [];
      } catch (e) {
        if (this.isStop(e)) throw e;
        return; // it went on to a page the bot can't look into (another site)
      }
      const key = JB.answers.questionKey;
      const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a)));
      const fields = pending.map(m => [m, typed.find(t => same(key(t.q), key(m.q)))]).filter(([, t]) => t && t.answer)
        .map(([m, t]) => ({ q: m.q, kind: m.kind || "text", options: m.options || [], answer: t.answer }));
      if (!fields.length) return;
      const reply = await this.ask("Keep what you answered?",
        `What you entered in Chrome for ${fields.length > 1 ? `${fields.length} questions` : "a question"} it had no answer for. Kept, it's answered for you next time (Settings > Your answers).`,
        KEEP, fields);
      if (typeof reply !== "object") return;
      const given = reply.answers.filter(a => String(a.answer ?? "").trim());
      if (!given.length) return;
      await JB.store.learn(given, this.site.name);
      keep(cfg, given);
      this.log(`  Kept ${given.length} answer${given.length > 1 ? "s" : ""} you entered`);
    }

    /** A job's result when questions are left unanswered: skipped if you said so, else left for you, with the
     * questions kept to answer on the dashboard. */
    unanswered(missing, how) {
      if (how === "skip") return [S.SKIPPED, "declined"];
      this.pending = missing;
      return [S.MANUAL, `unanswered: ${missing.map(m => m.q.slice(0, 60)).join("; ")}`];
    }

    /** Stopped by you, or the window closed: anything that has to end the whole run. */
    isStop(e) {
      return e instanceof Stopped || e instanceof WindowClosed;
    }

    async sleep(ms) {
      for (const end = Date.now() + ms; ;) {
        if (this.stopping) throw new Stopped();
        const left = end - Date.now();
        if (left <= 0) return;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, left)));
      }
    }

    // ---------------------------------------------------------- the bot's window

    async tab() {
      try {
        return await chrome.tabs.get(this.tabId);
      } catch {
        throw new WindowClosed();
      }
    }

    async openWindow() {
      const win = await chrome.windows.create({ url: "about:blank", focused: true });
      this.windowId = win.id;
      this.tabId = win.tabs[0].id;
    }

    /** Wait for the tab to finish loading; `fresh` waits for a new load to start first. */
    async loaded({ fresh = true, timeout = 30000 } = {}) {
      let started = !fresh;
      let done = false;
      const onUpdated = (id, info) => {
        if (id !== this.tabId) return;
        if (info.status === "loading") started = true;
        else if (info.status === "complete" && started) done = true;
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      try {
        if (!fresh && (await this.tab()).status === "complete") return;
        for (const end = Date.now() + timeout; !done && Date.now() < end;) await this.sleep(200);
      } finally {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
      await this.tab(); // closed meanwhile?
    }

    async goto(url) {
      await this.tab();
      const loaded = this.loaded();
      try {
        await chrome.tabs.update(this.tabId, { url });
      } catch {
        loaded.catch(() => {});
        throw new WindowClosed();
      }
      await loaded;
    }

    /** Run a script in the bot's tab without waiting for the page to finish loading (some never quite do),
     * and give up on it after a while rather than hang the run. */
    script(options) {
      const run = chrome.scripting.executeScript({ target: { tabId: this.tabId }, injectImmediately: true, ...options });
      run.catch(() => {});
      let timer;
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("the page didn't respond for 20 s")), 20000);
      });
      return Promise.race([run, late]).finally(() => clearTimeout(timer));
    }

    /** Call a lib/page.js function ("site.<name>" for the site's own) in the bot's tab. */
    async exec(path, ...args) {
      const deadline = Date.now() + 60000;
      for (let injected = 0; ;) {
        if (this.stopping) throw new Stopped();
        let out;
        try {
          await this.tab();
          [{ result: out }] = await this.script({ func: callInPage, args: [this.site.name, path, args] });
          if (out && out.missing) {
            if (++injected > 5) throw new Error("couldn't load the bot's scripts into the page");
            await this.script({ files: pageFiles(this.site.name) });
            continue;
          }
        } catch (e) {
          if (e instanceof WindowClosed || e instanceof Stopped || Date.now() > deadline) throw e;
          await this.sleep(500); // e.g. the page is in the middle of loading
          continue;
        }
        if (out && out.error) throw new Error(out.error);
        return out ? out.value : undefined;
      }
    }

    /** Run `func` in the page's own JavaScript world (not the extension's), e.g. to see what the page does. */
    async inMainWorld(func) {
      try {
        const [{ result }] = await this.script({ world: "MAIN", func });
        return result;
      } catch {
        await this.tab(); // the window closed: say so; anything else (a page mid-load) isn't worth failing over
        return undefined;
      }
    }

    async waitFor(css, timeout) {
      for (const end = Date.now() + timeout; ;) {
        if (await this.exec("exists", css)) return true;
        if (Date.now() > end) return false;
        await this.sleep(500);
      }
    }

    async screenshot(jobId) {
      try {
        // Chrome lets an extension take screenshots only with access to all sites: you allow that on the dashboard.
        if (!(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) return false;
        const image = await chrome.tabs.captureVisibleTab(this.windowId, { format: "jpeg", quality: 70 });
        await JB.store.saveShot(this.site.name, jobId, image);
        return true;
      } catch {
        return false; // e.g. the window is minimised
      }
    }

    // ---------------------------------------------------------- checks and logins

    async onCheckPage(re = /just a moment/i) {
      return re.test((await this.tab()).title || "");
    }

    /** Cloudflare's "Just a moment..." page usually clears itself; otherwise ask you. */
    async clearChallenge(seconds = 30) {
      for (let i = 0; i < seconds; i++) {
        if (!(await this.onCheckPage())) return true;
        await this.sleep(1000);
      }
      await this.ask("Do this in Chrome, then continue", "A Cloudflare check is showing in the bot's window. Solve it there.", CONTINUE);
      return !(await this.onCheckPage());
    }

    /** Wait for `css`; if a check or captcha is in the way, let you deal with it. */
    async ensureLoaded(css, timeout = 20000) {
      await this.clearChallenge();
      await this.loaded({ fresh: false });
      if (await this.waitFor(css, timeout)) return true;
      if (!(await this.onCheckPage(CHECK_RE))) return false; // just a page without it, e.g. no results
      await this.ask("Do this in Chrome, then continue", "The page isn't ready: solve the check or captcha in the bot's window.", CONTINUE);
      return this.waitFor(css, 10000);
    }

    async loggedIn() {
      this.step(`Checking you're logged in to ${this.site.label}`);
      await this.goto(this.site.loginCheckUrl || this.site.loginUrl);
      await this.clearChallenge();
      await this.sleep(3000); // let the page finish drawing its header
      return !!(await this.exec("site.isLoggedIn"));
    }

    /** Logged in already, or after you log in in the bot's window (if `ask`). */
    async login(ask) {
      if (await this.loggedIn()) return true;
      if (!ask) return false;
      await this.ask(
        "Log in, then continue",
        `Log in to ${this.site.label} in the bot's window (${this.site.loginHint || "any way it offers"}).`,
        CONTINUE,
      );
      return this.loggedIn();
    }

    // ---------------------------------------------------------- the run

    async start() {
      runs[this.site.name] = this;
      updateKeepAlive();
      updateBadge();
      this.save(true);
      try {
        await this.main();
      } catch (e) {
        if (e instanceof Stopped) {
          this.state.stopped = true;
          this.log();
          this.log("Stopped.");
        } else if (e instanceof WindowClosed) {
          this.log("Browser window was closed, stopping.");
        } else {
          this.state.error = firstLine(e);
          this.log(`Error: ${(e && e.stack) || e}`);
        }
      } finally {
        this.state.running = false;
        this.state.ended = Date.now();
        this.state.prompt = null;
        this.state.now = "";
        if (this.windowId != null) chrome.windows.remove(this.windowId).catch(() => {});
        delete runs[this.site.name];
        await this.save(true);
        updateKeepAlive();
        updateBadge();
      }
    }

    async main() {
      const cfg = JB.store.effective(await JB.store.getSettings(), this.site.name, await JB.store.kept());
      if (this.site.flow === "list") return this.mainList(cfg);
      const fixed = this.site.searches ? null : this.site.searchUrls(cfg); // Cutshort looks its searches up once logged in
      const nothing = fixed ? !fixed.length : !(cfg.keywords || []).length && !(cfg.searchUrls || []).length;
      if (!["login", "refer", "replies"].includes(this.action) && nothing) {
        this.log("Nothing to search for: add keywords in Settings first.");
        return;
      }
      await this.openWindow();
      if (this.action === "refer") { // LinkedIn: ask people at the companies applied to for a referral (referral.js)
        if (!(await this.login(true))) {
          this.log(`Not logged in to ${this.site.label}, stopping.`);
          return;
        }
        await JB.referral.run(this, cfg);
        return;
      }
      if (this.action === "replies") { // read what the site says about your applications there
        if (!(await this.login(true))) {
          this.log(`Not logged in to ${this.site.label}, stopping.`);
          return;
        }
        await this.checkReplies();
        return;
      }
      if (this.action === "login") {
        const ok = await this.login(true);
        this.log(ok ? "Logged in. Chrome remembers it; the bot uses that login." : "Still not logged in - try again.");
        return;
      }
      const mustLogIn = !this.dry || this.site.loginRequired;
      if (!(await this.login(mustLogIn))) {
        if (mustLogIn) {
          this.log(`Not logged in to ${this.site.label}, stopping.`);
          return;
        }
        this.log(`Not logged in to ${this.site.label}: fine for a dry run.`);
      }

      const limits = cfg.limits;
      let budget = this.opts.max || limits.maxPerRun;
      if (!this.dry) {
        budget = Math.min(budget, limits.maxPerDay - (await JB.store.appliedToday(this.site.name)));
        if (budget <= 0) {
          this.log(`Daily limit reached (${limits.maxPerDay}).`);
          return;
        }
      }
      const searches = fixed || await this.site.searches(cfg, keyword => this.lookupSkill(keyword), line => this.log(line));
      if (!searches.length) {
        this.log("Nothing to search for: none of the keywords can be searched here.");
        return;
      }
      const done = this.site.flow === "feed" ? await this.runFeed(cfg, searches, budget) : await this.runPages(cfg, searches, budget);
      this.log();
      this.log(`Done: ${this.dry ? "would apply" : "applied"} to ${done}.`);
      if (!this.dry && this.site.replies && cfg.readReplies) {
        try {
          await this.checkReplies();
        } catch (e) {
          if (this.isStop(e)) throw e;
          this.log(`Couldn't read your applications on ${this.site.label}: ${firstLine(e)}`);
        }
      }
    }

    /** Read the site's list of jobs you applied to, and what it says about each, into Applications. */
    async checkReplies() {
      const cards = new Map();
      for (const url of this.site.replies.pages) {
        this.step(`Reading your applications on ${this.site.label}`);
        await this.goto(url);
        await this.clearChallenge();
        await this.sleep(3000); // its cards draw themselves after the page loads
        const got = (await this.exec("site.appliedCards")) || [];
        const fresh = got.filter(([id]) => !cards.has(id));
        fresh.forEach(([id, text]) => cards.set(id, text));
        if (!fresh.length) break; // the list ended
      }
      const found = await JB.store.noteReplies(this.site.name, this.site.label, [...cards]);
      this.log();
      this.log(`Read ${cards.size} of your applications on ${this.site.label}: ${found.viewed} viewed, ${found.replied} got in touch, ${found.rejected} not selected (new since last time).`);
    }

    /** Company sites: no login and no search, a list of job links to apply to (sites/company.js queue). */
    async mainList(cfg) {
      if (["login", "refer"].includes(this.action)) {
        this.log(`${this.site.label} need no login.`);
        return;
      }
      if (cfg.moreForms && !(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) {
        this.log("Other companies' forms are on, but Chrome's access to all sites is off: only Greenhouse, Lever, Ashby and Workday this time (Settings > Sites > Company sites).");
        cfg = { ...cfg, moreForms: false };
      }
      const jobs = this.site.queue(cfg, await JB.store.jobs());
      if (!jobs.length) {
        this.log("Nothing to apply to: add job links in Settings, or let it take the jobs other sites found on Greenhouse, Lever, Ashby or Workday (and with Other companies' forms on, any).");
        return;
      }
      let budget = this.opts.max || cfg.limits.maxPerRun;
      if (!this.dry) {
        budget = Math.min(budget, cfg.limits.maxPerDay - (await JB.store.appliedToday(this.site.name)));
        if (budget <= 0) {
          this.log(`Daily limit reached (${cfg.limits.maxPerDay}).`);
          return;
        }
      }
      await this.openWindow();
      this.log(`${jobs.length} job${jobs.length > 1 ? "s" : ""} to apply to.`);
      this.state.page = { label: "Job links", n: 1, listed: jobs.length, fresh: jobs.length, cells: jobs.map(j => ({ url: j.url, state: "pending", label: named(j) })) };
      this.event({ kind: "search", label: "Job links", n: 1, listed: jobs.length, fresh: jobs.length });
      let done = 0;
      for (let job of jobs) {
        if (done >= budget) break;
        let status;
        let note;
        this.log();
        this.log(job.url);
        this.mark(job.url, { state: "working" });
        try {
          [status, job, note] = await this.handleJob(job, cfg);
        } catch (e) {
          if (this.isStop(e)) throw e;
          [status, note] = [S.FAILED, firstLine(e)];
        }
        done += await this.finish(job, status, note, budget, done, cfg.limits);
      }
      this.log();
      this.log(`Done: ${this.dry ? "would apply" : "applied"} to ${done}.`);
    }

    whereFor(search) {
      return (this.site.searchLabel && this.site.searchLabel(search)) || searchLabel(search);
    }

    /** Record a job's result and pause before the next one. Returns 1 if it counts towards the run's limit. */
    async finish(job, status, note, budget, done, limits) {
      const result = { title: job.title, company: job.company, url: job.url };
      const pending = this.pending;
      this.pending = null;
      this.asked = new Set();
      if (status == null) { // dry run
        this.mark(job.url, { state: "would_apply", label: named(job) });
        this.event({ kind: "job", status: "would_apply", ...result });
        return 1;
      }
      const shot = (status === S.MANUAL || status === S.FAILED) && (await this.screenshot(job.jobId));
      if ((status === S.MANUAL || status === S.FAILED) && this.site.page.dismiss) {
        try {
          if (await this.exec("site.dismiss")) await this.sleep(800); // close a half-filled dialog so the next job can go
        } catch (e) {
          if (e instanceof Stopped || e instanceof WindowClosed) throw e;
        }
      }
      if (status === S.MANUAL && pending) await JB.store.noteQuestions(this.site.name, job, pending);
      await JB.store.record(this.site.name, job, status, note, shot);
      this.log(`  ${ICONS[status]} ${status.padEnd(15)} ${label(job)}  ${note}`);
      this.mark(job.url, { state: status, label: named(job) });
      this.event({ kind: "job", status, note, ...result });
      if (status === S.APPLIED) {
        const pause = random(...limits.delaySeconds);
        if (done + 1 < budget && pause >= 3) this.step(`Waiting ${Math.round(pause)} s before the next application`);
        await this.sleep(pause * 1000);
        return 1;
      }
      if (status !== S.SKIPPED || this.site.flow !== "feed") await this.sleep(random(2, 5) * 1000); // feed skips don't load a page
      return 0;
    }

    /** Sites with a page per job (Hirist, Instahyre, Wellfound): search pages, then each job's own page. */
    async runPages(cfg, searches, budget) {
      const limits = cfg.limits;
      let done = 0;
      for (const search of searches) {
        const listed = new Set();
        const pages = this.site.paged ? limits.maxPages : 1;
        for (let n = 1; n <= pages && done < budget; n++) {
          const url = this.site.searchPageUrl(search, n);
          const where = this.whereFor(search);
          this.log();
          this.log(url);
          this.step(`Searching "${where}"${n > 1 ? `, page ${n}` : ""}`);
          let links;
          try {
            await this.goto(url);
            const own = this.site.page.collectLinks ? "site.collectLinks" : "collectLinks";
            const ready = this.site.page.searchReady // e.g. LinkedIn says "No matching jobs" instead of listing none
              ? (await this.clearChallenge()) && (await this.waitForTrue("site.searchReady", 20000))
              : await this.ensureLoaded(this.site.jobLinkCss);
            links = ready ? await this.exec(own, limits.maxScrolls ?? this.site.maxScrolls ?? 0) : [];
          } catch (e) {
            if (e instanceof Stopped || e instanceof WindowClosed) throw e;
            this.log(`  Couldn't load search page: ${firstLine(e)}`);
            break;
          }
          if (links && links.skip) { // e.g. Wellfound has no page for that role
            this.log(`  ${links.skip}, skipping.`);
            break;
          }
          const urls = links.map(([u]) => u);
          if (!urls.some(u => !listed.has(u))) { // empty, or a page past the end repeating earlier jobs
            this.log(this.site.paged ? "  No more jobs for this search." : "  No jobs on this search.");
            break;
          }
          urls.forEach(u => listed.add(u));
          const fresh = [];
          const cells = [];
          for (const [u, preview] of links) {
            const before = await JB.store.seen(this.site.name, this.site.jobId(u));
            const fits = !before && JB.filters.previewOk(preview, cfg.filters);
            if (fits) fresh.push(u);
            cells.push({ url: u, state: before ? "seen" : fits ? "pending" : "filtered", label: preview.slice(0, 160) });
          }
          this.state.page = { label: where, n, listed: urls.length, fresh: fresh.length, cells };
          this.event({ kind: "search", label: where, n, listed: urls.length, fresh: fresh.length });
          this.log(`  ${urls.length} jobs listed, ${fresh.length} new and matching`);

          for (const u of fresh) {
            if (done >= budget) break;
            let job = { url: u, jobId: this.site.jobId(u), title: "", company: "", text: "", place: this.site.placeOf?.(url) || "" };
            let status;
            let note;
            this.mark(u, { state: "working" });
            try {
              [status, job, note] = await this.handleJob(job, cfg);
            } catch (e) {
              if (e instanceof Stopped || e instanceof WindowClosed) throw e;
              if (e.stopRun) { // e.g. LinkedIn's daily Easy Apply limit: nothing more to do today
                this.mark(u, { state: "pending" });
                this.log();
                this.log(e.stopRun);
                return done;
              }
              [status, note] = [S.FAILED, firstLine(e)];
            }
            done += await this.finish(job, status, note, budget, done, limits);
          }
        }
        if (done >= budget) break;
      }
      return done;
    }

    /** Sites that apply from a feed of job cards (Cutshort): each card has the job and its own apply button. */
    async runFeed(cfg, searches, budget) {
      const limits = cfg.limits;
      let done = 0;
      for (const search of searches) {
        const listed = new Set();
        for (let n = 1; n <= limits.maxPages && done < budget; n++) {
          const url = this.site.searchPageUrl(search, n);
          const where = this.whereFor(search);
          this.log();
          this.log(url);
          this.step(`Reading the feed for "${where}"${n > 1 ? `, page ${n}` : ""}`);
          let cards = [];
          try {
            await this.goto(url);
            await this.clearChallenge();
            if (await this.waitForTrue("site.feedReady", 20000)) {
              await this.exec("site.closePopups");
              cards = await this.exec("site.feedJobs");
            }
          } catch (e) {
            if (e instanceof Stopped || e instanceof WindowClosed) throw e;
            this.log(`  Couldn't load feed: ${firstLine(e)}`);
            break;
          }
          const jobs = cards.map(([u, title, company, text]) => ({ url: u, jobId: this.site.jobId(u), title, company, text }));
          if (!jobs.some(j => !listed.has(j.jobId))) { // empty, or a page past the end repeating earlier jobs
            this.log("  No more jobs on this feed.");
            break;
          }
          jobs.forEach(j => listed.add(j.jobId));
          const fresh = [];
          const cells = [];
          for (const job of jobs) {
            const before = await JB.store.seen(this.site.name, job.jobId);
            if (!before) fresh.push(job);
            cells.push({ url: job.url, state: before ? "seen" : "pending", label: named(job) });
          }
          this.state.page = { label: where, n, listed: jobs.length, fresh: fresh.length, cells };
          this.event({ kind: "search", label: where, n, listed: jobs.length, fresh: fresh.length });
          this.log(`  ${jobs.length} jobs on page, ${fresh.length} new`);

          for (const job of fresh) {
            if (done >= budget) break;
            let status;
            let note;
            this.mark(job.url, { state: "working" });
            try {
              [status, note] = await this.handleCard(job, cfg);
            } catch (e) {
              if (e instanceof Stopped || e instanceof WindowClosed) throw e;
              [status, note] = [S.FAILED, firstLine(e)];
            }
            done += await this.finish(job, status, note, budget, done, limits);
          }
        }
        if (done >= budget) break;
      }
      return done;
    }

    /** A feed card: the filters, then apply from the card. Returns [status, note]. */
    async handleCard(job, cfg) {
      cfg = JB.places.forJob(cfg, job, this.site);
      const reason = JB.filters.skipReason(job, cfg.filters) || JB.places.skipReason(job, cfg, this.site);
      if (reason) return [S.SKIPPED, reason];
      if (this.dry) {
        this.log(`  ~ would apply   ${label(job)}  ${job.url}`);
        return [null, ""];
      }
      if (this.opts.confirm) {
        const yes = await this.ask("Apply to this one?", named(job), [["Apply", "y", "primary"], ["Skip", "n"], ["Stop run", "stop", "stop"]]);
        if (yes !== "y") return [S.SKIPPED, "declined"];
      }
      let [status, note] = await this.applyCard(job, cfg);
      if (status === S.MANUAL && this.opts.assist && (await this.byHand(job, note, cfg, () => this.exec("site.cardApplied", job.jobId)))) {
        [status, note] = [S.APPLIED, "finished by hand"];
      }
      return [status, note];
    }

    async applyCard(job, cfg) {
      this.step(`Applying to ${named(job)}`);
      await this.exec("site.closePopups");
      if (!(await this.exec("site.clickApply", job.jobId))) return [S.MANUAL, "card not found on the feed"];
      await this.sleep(2500);
      this.step(`Filling in the application for ${named(job)}`);
      let step;
      for (;;) {
        step = await this.exec("site.sendApplication", job.jobId, cfg.answers, JB.answers.coverNote(cfg.coverNote, job));
        if (!step.dialog || !step.missing.length) break;
        const learned = await this.learn(step.missing, cfg, job);
        if (learned !== true) return this.unanswered(step.missing, learned);
      }
      if (!step.dialog) return step.applied ? [S.APPLIED, ""] : [S.MANUAL, "no apply dialog appeared"];
      if (!step.sent) return [S.MANUAL, "no Send button in the apply dialog"];
      await this.sleep(3500);
      if (await this.exec("site.sent", job.jobId)) return [S.APPLIED, ""];
      return [S.MANUAL, "couldn't confirm the application went through"];
    }

    /** Find a keyword's id in the site's own filter (Cutshort's Skills): the id shows up in the address. */
    async lookupSkill(keyword) {
      this.step(`Looking up "${keyword}" in ${this.site.label}'s skills`);
      await this.goto(this.site.lookupUrl);
      await this.clearChallenge();
      await this.sleep(4000);
      if (!(await this.exec("site.pickSkill", keyword))) return null;
      await this.sleep(2500);
      const ids = new URL((await this.tab()).url).searchParams.get("skills");
      return ids ? ids.split("-").pop() : null;
    }

    async waitForTrue(path, timeout) {
      for (const end = Date.now() + timeout; ;) {
        if (await this.exec(path)) return true;
        if (Date.now() > end) return false;
        await this.sleep(500);
      }
    }

    /** Returns [status, job, note]; status null means nothing to record (a dry run). */
    async handleJob(job, cfg) {
      this.step("Opening the next job");
      await this.goto(job.url);
      await this.ensureLoaded(this.site.jobReadyCss);
      await this.sleep(this.site.settleMs || 1500); // let the apply button render
      job = { ...job, ...(await this.exec("site.readJob")) };
      this.step(`Checking ${named(job)}`);
      cfg = JB.places.forJob(cfg, job, this.site); // its answers for the job's country, when you work abroad

      const reason = this.site.flow !== "list" // a link you gave is one you want
        && (JB.filters.skipReason(job, cfg.filters) || JB.places.skipReason(job, cfg, this.site));
      if (reason) return [S.SKIPPED, job, reason];
      if (this.dry) {
        this.log(`  ~ would apply   ${label(job)}  ${job.url}`);
        return [null, job, ""];
      }
      if (this.opts.confirm) {
        const yes = await this.ask("Apply to this one?", named(job), [["Apply", "y", "primary"], ["Skip", "n"], ["Stop run", "stop", "stop"]]);
        if (yes !== "y") return [S.SKIPPED, job, "declined"];
      }

      this.step(`Applying to ${named(job)}`);
      let [status, note] = await this.applyJob(cfg, job);
      if (status === S.MANUAL && this.opts.assist && (await this.byHand(job, note, cfg, () => this.exec("isApplied")))) {
        [status, note] = [S.APPLIED, "finished by hand"];
      }
      return [status, job, note];
    }

    /** Click apply and walk through any form. Returns [status, note]. */
    async applyJob(cfg, job) {
      if (this.site.apply) return this.site.apply(this, cfg, job); // a site with its own way, e.g. LinkedIn's Easy Apply
      if (await this.exec("isApplied")) return [S.ALREADY, ""];
      const opened = [];
      const onCreated = tab => {
        if (tab.openerTabId === this.tabId || tab.windowId === this.windowId) opened.push(tab.id);
      };
      chrome.tabs.onCreated.addListener(onCreated);
      let newTab;
      try {
        await this.inMainWorld(watchWindowOpen);
        newTab = await this.exec("clickApply");
        if (newTab !== false) await this.sleep(2500);
      } finally {
        chrome.tabs.onCreated.removeListener(onCreated);
      }
      if (newTab === false) return [S.MANUAL, "no apply button found"];
      const blocked = await this.exec("site.cannotApply"); // e.g. "company doesn't hire from your location"
      if (blocked) return [S.SKIPPED, blocked];
      const wanted = newTab || (await this.inMainWorld(() => (window.__jobBotsOpened || []).pop()));
      if (opened.length || wanted) {
        await chrome.tabs.remove(opened).catch(() => {});
        return [S.EXTERNAL, `apply opens an external site${wanted ? `: ${wanted}` : ""}`];
      }
      const url = (await this.tab()).url || "";
      if (!url.includes(this.site.domain)) return [S.EXTERNAL, `redirected to ${url}`];

      const note = JB.answers.coverNote(cfg.coverNote, job);
      for (let i = 0; i < 4; i++) { // fill what we can, submit, repeat (multi-step forms)
        await this.loaded({ fresh: false });
        await this.dismissExtras();
        if (await this.exec("isApplied")) return [S.APPLIED, ""];
        this.step(`Filling in the application for ${named(job)}`);
        const step = await this.exec("formStep", cfg.answers, note);
        if (!step || !step.found) break;
        if (step.missing.length) {
          const learned = await this.learn(step.missing, cfg, job);
          if (learned !== true) return this.unanswered(step.missing, learned);
          i--; // the same step again, with your answers
          continue;
        }
        if (!step.submitted) break;
        await this.sleep(2500);
      }
      await this.loaded({ fresh: false });
      await this.dismissExtras();
      if (await this.exec("isApplied")) return [S.APPLIED, ""];
      return [S.MANUAL, "couldn't confirm the application went through"];
    }

    /** Click what applies on the company's own site (`path`: the site's function that clicks it, or gives the address
     * when it's a plain link) and note the address it leads to, without applying there. Where it shows: the link, a
     * tab it opens (closed again), one it tries to open (Chrome blocks a new tab from a click that isn't yours), or
     * this tab going there. The site's own redirect counts as where it leads. Null when it shows nowhere. */
    async followOut(path) {
      const opened = [];
      const onCreated = tab => {
        if (tab.openerTabId === this.tabId || tab.windowId === this.windowId) opened.push(tab.id);
      };
      chrome.tabs.onCreated.addListener(onCreated);
      let link;
      try {
        await this.inMainWorld(watchWindowOpen);
        link = await this.exec(path);
        if (!link) {
          await this.sleep(1500);
          if (this.site.page.continueOut && (await this.exec("site.continueOut"))) await this.sleep(2000); // "you're leaving" dialogs
        }
      } finally {
        chrome.tabs.onCreated.removeListener(onCreated);
      }
      const tabs = (await Promise.all(opened.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
      const tried = await this.inMainWorld(() => (window.__jobBotsOpened || []).pop());
      await chrome.tabs.remove(opened).catch(() => {});
      const here = (await this.tab()).url;
      const out = [link, ...tabs.map(t => t.url || t.pendingUrl), tried, here].map(u => this.outside(u)).find(Boolean);
      if (out || !link || !this.outside(link, true)) return out || null;
      await this.goto(link); // a redirect of the site's own with nothing to read the address from: see where it goes
      return this.outside((await this.tab()).url);
    }

    /** The address if it's off this site, or what a redirect of the site's own leads to ("?url=https://..."); else
     * null. With `own`, true for any address on the site. */
    outside(url, own = false) {
      let u;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      if (!/^https?:$/.test(u.protocol)) return null;
      const ours = h => h === this.site.domain || h.endsWith(`.${this.site.domain}`);
      if (own) return ours(u.hostname);
      if (!ours(u.hostname)) return u.href;
      for (const v of u.searchParams.values()) {
        try {
          if (/^https?:\/\//.test(v) && !ours(new URL(v).hostname)) return v;
        } catch {
          // not an address
        }
      }
      return null;
    }

    /** Close what a site pops up after applying (e.g. Instahyre's "Apply to N similar jobs"). */
    async dismissExtras() {
      if (await this.exec("site.dismissExtras")) await this.sleep(1000);
    }
  }

  JB.engine = {
    start(site, action, opts) {
      if (!JB.sites[site]) throw new Error(`Unknown site "${site}".`);
      if (!["apply", "dry-run", "login", "refer", "refer-dry-run", "replies"].includes(action)) throw new Error(`Unknown action "${action}".`);
      if (action === "replies" && !JB.sites[site].replies) throw new Error(`${JB.sites[site].label} doesn't show what happened to your applications.`);
      if (action.startsWith("refer") && !JB.sites[site].refers) throw new Error(`${JB.sites[site].label} has no referrals.`);
      if (runs[site]) throw new Error(`${JB.sites[site].label} is already running.`);
      new Run(site, action, opts).start();
    },
    stop(site) {
      if (runs[site]) runs[site].stop();
    },
    answer(site, id, value) {
      if (runs[site]) runs[site].answer(id, value);
    },
    /** A run the storage says is going but this worker doesn't have: the worker was restarted under it. */
    async markInterrupted() {
      const saved = await chrome.storage.session.get(null);
      for (const [k, state] of Object.entries(saved)) {
        if (!k.startsWith("run:") || !state.running || runs[state.site]) continue;
        state.running = false;
        state.ended = Date.now();
        state.prompt = null;
        state.error = "interrupted";
        state.log.push("", "Interrupted: Chrome restarted the extension in the middle of the run. Click Apply to carry on.");
        await chrome.storage.session.set({ [k]: state });
      }
    },
  };
})(globalThis.JB = globalThis.JB || {});
