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
      if (JB.sites?.[name]?.replies && sites[name].readReplies === undefined) sites[name].readReplies = true; // on unless you turn it off
    }
    // Indeed came after your settings: until you change them, it searches what Naukri does (the same kind of words,
    // and cities), or with none there, LinkedIn's words
    const old = s.sites || {};
    if (old.naukri && !old.indeed) {
      const from = (old.naukri.keywords || []).length ? old.naukri : { keywords: (old.linkedin || {}).keywords };
      Object.assign(sites.indeed, { keywords: [...(from.keywords || [])], locations: [...(from.locations || [])] });
    }
    return { version: 1, savedAt: s.savedAt || null, profile, sites, tracker: JB.tracker.settings(s.tracker) };
  }

  async function getSettings() {
    return normalize((await local.get("settings")).settings);
  }

  async function saveSettings(settings) {
    await local.set({ settings: { ...normalize(settings), savedAt: now() } });
  }

  /** Your profile as answers, for the forms that ask it (a company's own, mostly), after your own patterns. */
  function profileAnswers(p) {
    const end = "\\W*$"; // the whole question, give or take a "*"
    return [
      [`^(legal |preferred )?first name${end}|^given name${end}`, p.firstName],
      [`^(legal )?last name${end}|^(surname|family name)${end}`, p.lastName],
      [`^(full |legal |your )?name${end}|^full legal name${end}`, [p.firstName, p.lastName].filter(Boolean).join(" ")],
      [`^(your )?e-?mail( address)?${end}`, p.email],
      [`^(your )?(phone|mobile)( number)?${end}`, p.phone],
      [`^linkedin( profile)?( url)?${end}`, p.linkedin],
      [`^github( profile)?( url)?${end}`, p.github],
      [`^(personal )?(website|portfolio)( url)?${end}`, p.website],
      [`^current (company|employer)${end}`, p.company],
      [`^current (job )?title${end}`, p.jobTitle],
      [`^(current )?location( \\(city\\))?${end}|^city${end}`, p.city],
      [`^country( of residence)?${end}`, p.country],
    ].filter(([, answer]) => answer);
  }

  // US forms' voluntary self-identification: gender, race and ethnicity, veteran and disability status
  const SELF_ID = "^\\W*(what is your |please (select|identify) your |your )?(gender( identity)?|sex|race|ethnicity|race\\W+ethnicity|"
    + "(protected )?veteran status|disability status|sexual orientation)\\b|hispanic or latin|are you hispanic|"
    + "identify as (transgender|a (protected )?veteran|having a disability)|voluntary self.identification";
  // Consent to the company handling your application's data (GDPR), not to its talent pool or marketing
  const CONSENT = "^(?!.*(future|talent (pool|community)|other (roles|positions|opportunities|vacancies)|marketing|newsletter|sms|text message|whatsapp|promotion))"
    + "(?=.*(consent|agree|acknowledge|accept|confirm|have read))(?=.*(privacy|data protection|gdpr|personal (data|information)|processing|applicant data))"
    // ...or a question that's only the notice's name ("Data Privacy Policy *")
    + "|^\\W*((data|applicant|candidate|recruitment) )?(privacy (policy|notice|statement)|data protection( notice| policy)?|gdpr( consent| notice)?)\\W*$";
  const START = "start date|when (can|could) you (start|join)|how soon\\b.{0,30}\\b(start|join)|earliest (start|joining)|available (to start|from)|availability (date|to start)|date (you are |you're )?available";

  /** Answers most forms want the same way, after all of yours: US forms' self-identification declined (unless you
   * said to leave it for you, Settings > Your profile), consent to the company handling your application's data,
   * and when you can start: your notice period, as the date that makes where a form wants a date. */
  function standardAnswers(p) {
    return [
      [SELF_ID, (p.selfIdentify ?? "decline") === "decline" ? "Decline to self-identify" : ""],
      [CONSENT, "Yes"],
      [START, p.noticePeriod || ""],
    ].filter(([, answer]) => answer);
  }

  /** What one site's run uses: the shared profile with that site's own settings on top. A site with answers of
   * its own (LinkedIn: number boxes, phone without +91) uses those instead of the shared ones. Answers you gave
   * when it asked (`kept`, see learn) come first, each for its own question; your profile's details last. */
  function effective(settings, site, kept = {}) {
    const own = settings.sites[site] || {};
    const answers = own.answers && own.answers.length ? own.answers : settings.profile.answers;
    return {
      ...settings.profile, ...own,
      answers: [...Object.entries(kept).map(([k, a]) => [`=${k}`, a.answer]), ...answers, ...profileAnswers(settings.profile),
        ...standardAnswers(settings.profile)],
    };
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

  /** Forget the jobs recorded as Other site without where they lead (before Sendoff could see where some sites'
   * "Apply on company site" goes), so their site looks at them again and Company sites gets the link. Once. */
  function forgetLinkless() {
    return serial(async () => {
      if ((await local.get("cleaned:linkless"))["cleaned:linkless"]) return 0;
      const all = await jobs();
      const gone = Object.keys(all).filter(k => all[k].status === "external" && !/https?:\/\//.test(all[k].note || ""));
      for (const k of gone) delete all[k];
      await local.set({ jobs: all, "cleaned:linkless": now() });
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

  // ------------------------------------------------------------ people contacted on LinkedIn: referrals and recruiters

  const CONTACT_STATUSES = ["messaged", "invited", "not_accepted", "failed"];
  const CONTACT_KINDS = ["referral", "recruiter"];
  // profile URL -> who, about which job, status, and kind: asked for a "referral", or a "recruiter" written to.
  // Contacts saved before recruiters came have no kind: they were all referrals.
  const contacts = async () => (await local.get("contacts")).contacts || {};
  const kindOf = c => c.kind || "referral";
  // job id -> asked about it, one store per kind, so each run goes through the jobs on its own
  const JOB_STORES = { referral: "referralJobs", recruiter: "recruiterJobs" };
  const jobStore = kind => {
    if (!JOB_STORES[kind]) throw new Error(`Unknown contact kind "${kind}".`);
    return JOB_STORES[kind];
  };
  const askedJobs = async (kind = "referral") => (await local.get(jobStore(kind)))[jobStore(kind)] || {};
  const referralJobs = () => askedJobs("referral");

  const daysAgo = ts => (Date.now() - new Date(String(ts).replace(" ", "T")).getTime()) / 86400000;
  // A failed discovery or a run where every recipient was skipped did not ask anyone.
  // Keep these retryable, including records written by older extension versions.
  const RETRY_REFERRALS = new Set(["no_employee_list", "nobody_found", "nobody_reached"]);
  const referralFinished = record => !!record && !RETRY_REFERRALS.has(record.status);

  /** Jobs with one of these statuses from the last `days` days, newest first, not asked about yet (for this kind). */
  async function jobsToAsk(site, statuses, days, kind = "referral") {
    const asked = await askedJobs(kind);
    return Object.values(await jobs())
      .filter(r => r.site === site && statuses.includes(r.status) && daysAgo(r.ts) <= days && !referralFinished(asked[r.jobId]))
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }

  function jobDone(job, status, note = "", kind = "referral") {
    return serial(async () => {
      const all = await askedJobs(kind);
      all[job.jobId] = { jobId: job.jobId, url: job.url, title: job.title || "", company: job.company || "", status, note, ts: now() };
      await local.set({ [jobStore(kind)]: all });
    });
  }

  const askedAbout = async (jobId, kind = "referral") => referralFinished((await askedJobs(kind))[jobId]);
  const knownContact = async profile => {
    const contact = (await contacts())[profile];
    // These attempts never reached Send. Retry them, while preserving sent invites and
    // ambiguous failures ("couldn't confirm") to avoid contacting someone twice.
    return !!contact && !(contact.status === "failed" && /^no Send button in the invite dialog(?:;|$)/.test(contact.note || ""));
  };
  /** How many people of this kind at the company were messaged or invited. */
  const askedAt = async (companyUrl, kind = "referral") => Object.values(await contacts())
    .filter(c => c.companyUrl === companyUrl && kindOf(c) === kind && ["messaged", "invited"].includes(c.status)).length;
  // Every kind together: LinkedIn's limits are on all your messages and invites.
  const sentToday = async () => Object.values(await contacts()).filter(c => ["messaged", "invited"].includes(c.status) && String(c.updated).startsWith(now().slice(0, 10))).length;

  /** Invites of this kind not accepted yet, oldest first, with how many days ago they went. */
  async function pendingInvites(kind = "referral") {
    return Object.values(await contacts()).filter(c => c.status === "invited" && kindOf(c) === kind)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map(c => ({ ...c, age: daysAgo(c.ts) }));
  }

  /** Add someone, or update their status (keeping when they were first contacted). */
  function saveContact(person, job, companyUrl, status, note = "", kind = "referral") {
    jobStore(kind);
    return serial(async () => {
      const all = await contacts();
      const was = all[person.profile];
      all[person.profile] = {
        profile: person.profile, name: person.name, headline: person.headline || "", company: job.company || "", companyUrl,
        jobId: job.jobId, jobUrl: job.url, title: job.title || "", status, note, kind, ts: was ? was.ts : now(), updated: now(),
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

  /** Under today's question keys: they used to drop every letter outside a-z ("Kündigungsfrist" was
   * "k ndigungsfrist", and a question in Japanese had none). Two that are now one: the newer, with both's jobs. */
  function rekey(map) {
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      const now = JB.answers.questionKey(v.q) || k;
      const was = out[now];
      out[now] = was && (was.ts || "") > (v.ts || "") ? was : v;
      if (was?.jobs) out[now] = { ...out[now], jobs: [...new Set([...was.jobs, ...(v.jobs || [])])] };
    }
    return out;
  }

  // question key (JB.answers.questionKey) -> { q, answer, kind, options, site, ts }
  const kept = async () => rekey((await local.get("kept")).kept || {});
  // question key -> { q, kind, options, site, jobs: ["site:jobId" left for you over it], ts }: not answered yet
  const waiting = async () => rekey((await local.get("waiting")).waiting || {});

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

  /** What a site says about your applications there ([[jobId, card text]], from its list of jobs you applied to),
   * into Applications: viewed, they got in touch, not selected. Returns how many of each. */
  async function noteReplies(site, label, cards) {
    const history = await jobs();
    const have = await tracks();
    const today = now().slice(0, 10);
    const counts = { viewed: 0, replied: 0, rejected: 0 };
    const items = [];
    for (const [jobId, text] of cards) {
      const k = key(site, jobId);
      const job = history[k];
      if (!job || !["applied", "already_applied"].includes(job.status)) continue;
      const signal = JB.tracker.replySignal(text);
      const app = { heard: null, rounds: [], outcome: null, ...have[k] };
      const made = JB.tracker.fromSite(app, signal, label, today);
      if (!made) continue;
      counts[signal]++;
      const base = { site, jobId, title: job.title, company: job.company, url: job.url, appliedAt: job.ts, source: job.note === "finished by hand" ? "self" : "bot", old: job.status === "already_applied" };
      items.push({ key: k, base, change: made[0], note: made[1] });
    }
    if (items.length) await saveTracks(items);
    return counts;
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

  // ------------------------------------------------------------ your resume, for forms that want one

  /** { name, type, size, data: base64 } or null. */
  const resume = async () => (await local.get("resume")).resume || null;
  const saveResume = file => (file ? local.set({ resume: file }) : local.remove("resume"));

  // ------------------------------------------------------------ your sign-in for companies' Workday

  /** { email, password, create } or null. Kept apart from the settings, so a backup never has it. */
  const workdaySignIn = async () => (await local.get("workdaySignIn")).workdaySignIn || null;
  const saveWorkdaySignIn = value => (value ? local.set({ workdaySignIn: value }) : local.remove("workdaySignIn"));

  const saveShot = (site, jobId, dataUrl) => local.set({ [shotKey(site, jobId)]: dataUrl });
  // Screenshots on or off. Null: not chosen since that was its own choice, when they were on whenever Chrome let
  // Sendoff onto all sites (which other companies' forms need too now).
  const screenshots = async () => (await local.get("screenshots")).screenshots ?? null;
  const setScreenshots = on => local.set({ screenshots: on });
  const shot = async (site, jobId) => (await local.get(shotKey(site, jobId)))[shotKey(site, jobId)] || null;

  JB.store = {
    STATUSES, now, normalize, getSettings, saveSettings, effective, profileAnswers, resume, saveResume, workdaySignIn, saveWorkdaySignIn, jobs, seen, record, appliedToday, forget, forgetLinkless, importHistory,
    saveShot, shot, screenshots, setScreenshots,
    CONTACT_STATUSES, CONTACT_KINDS, contacts, kindOf, referralJobs, askedJobs, jobsToAsk, jobDone, askedAbout, knownContact, askedAt, sentToday, pendingInvites,
    saveContact, importReferrals, tracks, saveTracks, importTracks, markApplied, noteReplies,
    kept, waiting, learn, unlearn, noteQuestions, dropQuestions, importKept,
  };
})(globalThis.JB = globalThis.JB || {});
