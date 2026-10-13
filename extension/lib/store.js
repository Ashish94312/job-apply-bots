// Settings, history and screenshots, kept in chrome.storage.local (the replacement for config.yaml and jobs.db).
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
    return { version: 1, savedAt: s.savedAt || null, profile, sites };
  }

  async function getSettings() {
    return normalize((await local.get("settings")).settings);
  }

  async function saveSettings(settings) {
    await local.set({ settings: { ...normalize(settings), savedAt: now() } });
  }

  /** What one site's run uses: the shared profile with that site's own settings on top. */
  function effective(settings, site) {
    const own = settings.sites[site] || {};
    return { ...settings.profile, ...own, answers: [...(own.answers || []), ...settings.profile.answers] };
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

  const saveShot = (site, jobId, dataUrl) => local.set({ [shotKey(site, jobId)]: dataUrl });
  const shot = async (site, jobId) => (await local.get(shotKey(site, jobId)))[shotKey(site, jobId)] || null;

  JB.store = { STATUSES, now, normalize, getSettings, saveSettings, effective, jobs, seen, record, appliedToday, forget, importHistory, saveShot, shot };
})(globalThis.JB = globalThis.JB || {});
