// The run loop (ported from run.py). Runs in the background worker; each run drives its own Chrome window and
// reaches into the site's pages through lib/page.js. Its state (log, question for you) is kept in
// chrome.storage.session as "run:<site>", where the dashboard watches it.
(function (JB) {
  const S = { APPLIED: "applied", ALREADY: "already_applied", SKIPPED: "skipped", MANUAL: "needs_manual", EXTERNAL: "external", FAILED: "failed" };
  const ICONS = { applied: "+", already_applied: "=", skipped: "-", needs_manual: "!", external: ">", failed: "x" };
  const CONTINUE = [["Done, continue", "continue", "primary"], ["Stop run", "stop", "stop"]];
  const CHECK_RE = /just a moment|attention required|verify you are human|captcha|security check/i;
  const MAX_LOG = 3000;

  class Stopped extends Error {}
  class WindowClosed extends Error {}

  const random = (lo, hi) => lo + Math.random() * (hi - lo);
  const firstLine = e => String((e && e.message) || e).split("\n")[0];
  const label = job => `${job.title || "?"} @ ${job.company || "?"}`;
  const pageFiles = site => ["lib/filters.js", "lib/answers.js", "lib/page.js", `sites/${site}.js`];

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
      this.dry = action === "dry-run";
      this.stopping = false;
      this.tabId = null;
      this.windowId = null;
      this.reply = null;
      this.saveTimer = null;
      this.state = {
        id: `${siteName}-${Date.now()}`, site: siteName, action, running: true, started: Date.now(), ended: null,
        stopped: false, error: "", log: [], prompt: null,
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

    /** Show a question on the dashboard and wait for the answer. "stop" stops the run. */
    async ask(title, text, choices) {
      this.state.prompt = { id: Date.now(), title, text, choices };
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
      await this.goto(this.site.loginUrl);
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
        `Log in to ${this.site.label} in the bot's window (OTP, password or Google all work there).`,
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
        if (this.windowId != null) chrome.windows.remove(this.windowId).catch(() => {});
        delete runs[this.site.name];
        await this.save(true);
        updateKeepAlive();
        updateBadge();
      }
    }

    async main() {
      const cfg = JB.store.effective(await JB.store.getSettings(), this.site.name);
      const searches = this.site.searchUrls(cfg);
      if (this.action !== "login" && !searches.length) {
        this.log("Nothing to search for: add keywords in Settings first.");
        return;
      }
      await this.openWindow();
      if (this.action === "login") {
        const ok = await this.login(true);
        this.log(ok ? "Logged in. Chrome remembers it; the bot uses that login." : "Still not logged in - try again.");
        return;
      }
      if (!(await this.login(!this.dry))) {
        if (!this.dry) {
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

      let done = 0;
      for (const search of searches) {
        const listed = new Set();
        for (let n = 1; n <= limits.maxPages && done < budget; n++) {
          const url = this.site.searchPageUrl(search, n);
          this.log();
          this.log(url);
          let links;
          try {
            await this.goto(url);
            links = (await this.ensureLoaded(this.site.jobLinkCss)) ? await this.exec("collectLinks", this.site.maxScrolls) : [];
          } catch (e) {
            if (e instanceof Stopped || e instanceof WindowClosed) throw e;
            this.log(`  Couldn't load search page: ${firstLine(e)}`);
            break;
          }
          const urls = links.map(([u]) => u);
          if (!urls.some(u => !listed.has(u))) { // empty, or a page past the end repeating earlier jobs
            this.log("  No more jobs for this search.");
            break;
          }
          urls.forEach(u => listed.add(u));
          const fresh = [];
          for (const [u, preview] of links) {
            if (!(await JB.store.seen(this.site.name, this.site.jobId(u))) && JB.filters.previewOk(preview, cfg.filters)) fresh.push(u);
          }
          this.log(`  ${urls.length} jobs listed, ${fresh.length} new and matching`);

          for (const u of fresh) {
            if (done >= budget) break;
            let job = { url: u, jobId: this.site.jobId(u), title: "", company: "", text: "" };
            let status;
            let note;
            try {
              [status, job, note] = await this.handleJob(job, cfg);
            } catch (e) {
              if (e instanceof Stopped || e instanceof WindowClosed) throw e;
              [status, note] = [S.FAILED, firstLine(e)];
            }
            if (status == null) { // dry run
              done++;
              continue;
            }
            const shot = (status === S.MANUAL || status === S.FAILED) && (await this.screenshot(job.jobId));
            await JB.store.record(this.site.name, job, status, note, shot);
            this.log(`  ${ICONS[status]} ${status.padEnd(15)} ${label(job)}  ${note}`);
            if (status === S.APPLIED) {
              done++;
              await this.sleep(random(...limits.delaySeconds) * 1000);
            } else {
              await this.sleep(random(2, 5) * 1000);
            }
          }
        }
        if (done >= budget) break;
      }
      this.log();
      this.log(`Done: ${this.dry ? "would apply" : "applied"} to ${done}.`);
    }

    /** Returns [status, job, note]; status null means nothing to record (a dry run). */
    async handleJob(job, cfg) {
      await this.goto(job.url);
      await this.ensureLoaded(this.site.jobReadyCss);
      await this.sleep(1500); // let the apply button render
      job = { ...job, ...(await this.exec("site.readJob")) };

      const reason = JB.filters.skipReason(job, cfg.filters);
      if (reason) return [S.SKIPPED, job, reason];
      if (this.dry) {
        this.log(`  ~ would apply   ${label(job)}  ${job.url}`);
        return [null, job, ""];
      }
      if (this.opts.confirm) {
        const yes = await this.ask("Apply to this one?", label(job), [["Apply", "y", "primary"], ["Skip", "n"], ["Stop run", "stop", "stop"]]);
        if (yes !== "y") return [S.SKIPPED, job, "declined"];
      }

      let [status, note] = await this.applyJob(cfg, job);
      if (status === S.MANUAL && this.opts.assist) {
        await this.ask("Do this in Chrome, then continue", `${label(job)}: ${note}\nFinish it in the bot's window.`, CONTINUE);
        if (await this.exec("isApplied")) [status, note] = [S.APPLIED, "finished by hand"];
      }
      return [status, job, note];
    }

    /** Click apply and walk through any form. Returns [status, note]. */
    async applyJob(cfg, job) {
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
        await this.exec("site.dismissExtras");
        if (await this.exec("isApplied")) return [S.APPLIED, ""];
        const step = await this.exec("formStep", cfg.answers, note);
        if (!step || !step.found) break;
        if (step.missing.length) return [S.MANUAL, `unanswered: ${step.missing.join("; ")}`];
        if (!step.submitted) break;
        await this.sleep(2500);
      }
      await this.loaded({ fresh: false });
      await this.exec("site.dismissExtras");
      if (await this.exec("isApplied")) return [S.APPLIED, ""];
      return [S.MANUAL, "couldn't confirm the application went through"];
    }
  }

  JB.engine = {
    start(site, action, opts) {
      if (!JB.sites[site]) throw new Error(`Unknown site "${site}".`);
      if (!["apply", "dry-run", "login"].includes(action)) throw new Error(`Unknown action "${action}".`);
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
