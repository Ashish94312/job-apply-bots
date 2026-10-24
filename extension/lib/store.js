// Settings, history, screenshots, applications and the answers you gave, kept in chrome.storage.local (the
// replacement for config.yaml and jobs.db).
// Loaded in the background worker and the dashboard. History changes go through the worker, one at a time.
(function (JB) {
  const local = chrome.storage.local;
  const STATUSES = ["applied", "already_applied", "skipped", "needs_manual", "external", "failed"];

  /** Local time as "YYYY-MM-DD HH:MM:SS", like the Python bots' history. */
  function now() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ------------------------------------------------------------ settings

  /** Settings with anything missing filled in from the defaults (e.g. after an update adds a setting). */
  function normalize(s) {
    const d = JB.DEFAULTS;
    s = s || {};
    const mine = s.profile || {};
    const profile = { ...d.profile, ...mine, filters: { ...d.profile.filters, ...(mine.filters || {}) } };
    const sites = {};
    for (const name of Object.keys(d.sites)) {
      const site = (s.sites || {})[name] || {};
      sites[name] = { ...d.sites[name], ...site, limits: { ...d.sites[name].limits, ...(site.limits || {}) } };
    }
    return { version: 1, savedAt: s.savedAt || null, profile, sites, tracker: JB.tracker.settings(s.tracker) };
  }

  async function getSettings() {
    return normalize((await local.get("settings")).settings);
  }

  async function saveSettings(settings) {
    await local.set({ settings: { ...normalize(settings), savedAt: now() } });
  }

  /** What one site's run uses: the shared profile with that site's own settings on top. A site with answers of
   * its own (LinkedIn: number boxes, phone without +91) uses those instead of the shared ones. Answers you gave
   * when it asked (`kept`, see learn) come first, each for its own question. */
  function effective(settings, site, kept = {}) {
    const own = settings.sites[site] || {};
    const answers = own.answers && own.answers.length ? own.answers : settings.profile.answers;
    return { ...settings.profile, ...own, answers: [...Object.entries(kept).map(([k, a]) => [`=${k}`, a.answer]), ...answers] };
  }

  // ------------------------------------------------------------ history

  const key = (site, jobId) => `${site}:${jobId}`;
  const shotKey = (site, jobId) => `shot:${site}:${jobId}`;

  async function jobs() {
    return (await local.get("jobs")).jobs || {};
  }

  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  /** Anything except a failure is final; failures get retried next run. */
  async function seen(site, jobId) {
    const r = (await jobs())[key(site, jobId)];
    return !!r && r.status !== "failed";
  }

  function record(site, job, status, note, shot) {
    return serial(async () => {
      const all = await jobs();
      all[key(site, job.jobId)] = {
        site, jobId: job.jobId, url: job.url, title: job.title || "", company: job.company || "",
        status, note: note || "", ts: now(), shot: !!shot,
      };
      await local.set({ jobs: all });
    });
  }

  async function appliedToday(site) {
    const today = now().slice(0, 10);
    return Object.values(await jobs()).filter(r => r.site === site && r.status === "applied" && r.ts.startsWith(today)).length;
  }

  /** Forget jobs with a status so they're checked again next run (e.g. skipped ones, after changing filters). */
  function forget(site, status) {
    return serial(async () => {
      const all = await jobs();
      const gone = Object.keys(all).filter(k => all[k].site === site && all[k].status === status);
      for (const k of gone) delete all[k];
      await local.set({ jobs: all });
      await local.remove(gone.map(k => shotKey(...k.split(":"))));
      return gone.length;
    });
  }

  /** Add past jobs (from the Python bots' export) that aren't in the history yet. */
  function importHistory(rows) {
    return serial(async () => {
      const all = await jobs();
      let added = 0;
      for (const r of rows || []) {
        if (!r || !r.site || !r.jobId || !STATUSES.includes(r.status) || all[key(r.site, r.jobId)]) continue;
        all[key(r.site, String(r.jobId))] = {
          site: r.site, jobId: String(r.jobId), url: r.url || "", title: r.title || "", company: r.company || "",
          status: r.status, note: r.note || "", ts: r.ts || now(), shot: false,
        };
        added++;
      }
      await local.set({ jobs: all });
      return added;
    });
  }

  // ------------------------------------------------------------ referrals (LinkedIn)

  const CONTACT_STATUSES = ["messaged", "invited", "not_accepted", "failed"];
  const contacts = async () => (await local.get("contacts")).contacts || {}; // profile URL -> who, about which job, status
  const referralJobs = async () => (await local.get("referralJobs")).referralJobs || {}; // job id -> asked about it

  const daysAgo = ts => (Date.now() - new Date(String(ts).replace(" ", "T")).getTime()) / 86400000;

  /** Jobs with one of these statuses from the last `days` days, newest first, not asked about yet. */
  async function jobsToAsk(site, statuses, days) {
    const asked = await referralJobs();
    return Object.values(await jobs())
      .filter(r => r.site === site && statuses.includes(r.status) && daysAgo(r.ts) <= days && !asked[r.jobId])
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }

  function jobDone(job, status, note = "") {
    return serial(async () => {
      const all = await referralJobs();
      all[job.jobId] = { jobId: job.jobId, url: job.url, title: job.title || "", company: job.company || "", status, note, ts: now() };
      await local.set({ referralJobs: all });
    });
  }

  const askedAbout = async jobId => !!(await referralJobs())[jobId];
  const knownContact = async profile => !!(await contacts())[profile];
  const askedAt = async companyUrl => Object.values(await contacts()).filter(c => c.companyUrl === companyUrl && ["messaged", "invited"].includes(c.status)).length;
  const sentToday = async () => Object.values(await contacts()).filter(c => ["messaged", "invited"].includes(c.status) && String(c.updated).startsWith(now().slice(0, 10))).length;

  /** Invites not accepted yet, oldest first, with how many days ago they went. */
  async function pendingInvites() {
    return Object.values(await contacts()).filter(c => c.status === "invited")
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map(c => ({ ...c, age: daysAgo(c.ts) }));
  }

  /** Add someone, or update their status (keeping when they were first contacted). */
  function saveContact(person, job, companyUrl, status, note = "") {
    return serial(async () => {
      const all = await contacts();
      const was = all[person.profile];
      all[person.profile] = {
        profile: person.profile, name: person.name, headline: person.headline || "", company: job.company || "", companyUrl,
        jobId: job.jobId, jobUrl: job.url, title: job.title || "", status, note, ts: was ? was.ts : now(), updated: now(),
      };
      await local.set({ contacts: all });
    });
  }

  /** Add contacts and asked-about jobs (from the Python bot's export) that aren't here yet. */
  function importReferrals(people, asked) {
    return serial(async () => {
      const all = await contacts();
      const done = await referralJobs();
      let added = 0;
      for (const c of people || []) {
        if (!c || !c.profile || all[c.profile] || !CONTACT_STATUSES.includes(c.status)) continue;
        all[c.profile] = c;
        added++;
      }
      for (const j of asked || []) if (j && j.jobId && !done[j.jobId]) done[j.jobId] = j;
      await local.set({ contacts: all, referralJobs: done });
      return added;
    });
  }

  // ------------------------------------------------------------ answers you gave when it asked

  // question key (JB.answers.questionKey) -> { q, answer, kind, options, site, ts }
  const kept = async () => (await local.get("kept")).kept || {};
  // question key -> { q, kind, options, site, jobs: ["site:jobId" left for you over it], ts }: not answered yet
  const waiting = async () => (await local.get("waiting")).waiting || {};

  /** Keep answers you gave, each { q, answer, kind, options }, for next time. A job left for you only over
   * questions answered now is forgotten, so the next run tries it again. Returns how many that is. */
  function learn(items, site = "") {
    return serial(async () => {
      const all = await kept();
      const open = await waiting();
      const history = await jobs();
      const touched = new Set();
      for (const it of items) {
        const k = JB.answers.questionKey(it.q);
        if (!k || it.answer == null || String(it.answer).trim() === "") continue;
        all[k] = { q: it.q, answer: String(it.answer).trim(), kind: it.kind || "text", options: it.options || [], site: site || all[k]?.site || "", ts: now() };
        for (const jk of open[k]?.jobs || []) touched.add(jk);
        delete open[k];
      }
      const stillWaiting = new Set(Object.values(open).flatMap(w => w.jobs));
      const retry = [...touched].filter(jk => !stillWaiting.has(jk) && history[jk]?.status === "needs_manual");
      for (const jk of retry) delete history[jk];
      await local.set({ kept: all, waiting: open, jobs: history });
      await local.remove(retry.map(jk => shotKey(...jk.split(":"))));
      return retry.length;
    });
  }

  /** Forget answers you gave, by question key. */
  function unlearn(keys) {
    return serial(async () => {
      const all = await kept();
      for (const k of keys) delete all[k];
      await local.set({ kept: all });
    });
  }

  /** Questions a job was left for you over ([{ q, kind, options }]), to answer on the dashboard. */
  function noteQuestions(site, job, missing) {
    return serial(async () => {
      const open = await waiting();
      const have = await kept();
      for (const m of missing) {
        const k = JB.answers.questionKey(m.q);
        if (!k || have[k]) continue;
        const was = open[k];
        open[k] = {
          q: m.q, kind: m.kind || "text", options: m.options && m.options.length ? m.options : was?.options || [], site,
          jobs: [...new Set([...(was?.jobs || []), key(site, job.jobId)])], ts: was?.ts || now(),
        };
      }
      await local.set({ waiting: open });
    });
  }

  /** Stop asking about questions, by key: the jobs stay left for you. */
  function dropQuestions(keys) {
    return serial(async () => {
      const open = await waiting();
      for (const k of keys) delete open[k];
      await local.set({ waiting: open });
    });
  }

  /** Add answers (from a backup) for questions that have none here yet. */
  function importKept(rows) {
    return serial(async () => {
      const all = await kept();
      let added = 0;
      for (const [k, a] of Object.entries(rows || {})) {
        if (!k || all[k] || !a || typeof a.answer !== "string") continue;
        all[k] = a;
        added++;
      }
      await local.set({ kept: all });
      return added;
    });
  }

  // ------------------------------------------------------------ applications (lib/tracker.js)

  const tracks = async () => (await local.get("track")).track || {};

  /** Change applications, each { key, base, change, note } (see JB.tracker.change): one starts from `base` the first
   * time, `note` goes on its timeline, and `change.remove` forgets it. Returns them as saved. */
  function saveTracks(items) {
    return serial(async () => {
      const all = await tracks();
      for (const { key, base, change, note } of items) {
        if (change.remove) {
          delete all[key];
          continue;
        }
        const was = all[key] || { ...base, key, rounds: [], log: [] };
        const app = JB.tracker.change(was, change);
        app.updated = now();
        if (note) app.log = [...(was.log || []), { ts: now(), text: note }];
        all[key] = app;
      }
      await local.set({ track: all });
      return items.map(i => all[i.key] || null);
    });
  }

  /** Add applications (from a backup) that aren't here yet. */
  function importTracks(rows) {
    return serial(async () => {
      const all = await tracks();
      let added = 0;
      for (const t of Object.values(rows || {})) {
        if (!t || !t.key || all[t.key] || !Array.isArray(t.rounds)) continue;
        all[t.key] = t;
        added++;
      }
      await local.set({ track: all });
      return added;
    });
  }

  /** You applied to a job it left for you: it counts as applied, as when you finish one while it waits. */
  function markApplied(site, jobId) {
    return serial(async () => {
      const all = await jobs();
      const r = all[key(site, jobId)];
      if (!r || !["needs_manual", "external", "failed"].includes(r.status)) return false;
      all[key(site, jobId)] = { ...r, status: "applied", note: "finished by hand", ts: now() };
      await local.set({ jobs: all });
      return true;
    });
  }

  const saveShot = (site, jobId, dataUrl) => local.set({ [shotKey(site, jobId)]: dataUrl });
  const shot = async (site, jobId) => (await local.get(shotKey(site, jobId)))[shotKey(site, jobId)] || null;

  JB.store = {
    STATUSES, now, normalize, getSettings, saveSettings, effective, jobs, seen, record, appliedToday, forget, importHistory,
    saveShot, shot,
    CONTACT_STATUSES, contacts, referralJobs, jobsToAsk, jobDone, askedAbout, knownContact, askedAt, sentToday, pendingInvites,
    saveContact, importReferrals, tracks, saveTracks, importTracks, markApplied,
    kept, waiting, learn, unlearn, noteQuestions, dropQuestions, importKept,
  };
})(globalThis.JB = globalThis.JB || {});
