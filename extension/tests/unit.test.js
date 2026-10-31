// Unit tests for the extension's plain logic:  node --test extension/tests/
// cases.json holds what the Python bots answer for the same inputs (make_cases.py), so the port stays faithful.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

globalThis.JB = {};
globalThis.chrome = { storage: { local: {} } }; // store.js only touches it when called
const local = chrome.storage.local; // the one store.js keeps
for (const file of ["referral.js", "lib/defaults.js", "lib/filters.js", "lib/answers.js", "lib/tracker.js", "lib/store.js", "lib/places.js", "sites/hirist.js", "sites/instahyre.js", "sites/wellfound.js", "sites/cutshort.js", "sites/linkedin.js", "sites/naukri.js", "sites/company.js"]) {
  require(path.join(__dirname, "..", file));
}
const cases = require("./cases.json");
const { filters, answers, store, sites, tracker, places } = JB;
const hirist = sites.hirist;

test("skipReason matches the Python bots", () => {
  for (const c of cases.skipReason) {
    const expected = c.expected === "not an engineering role" ? "not one of your roles" : c.expected; // worded for any field
    assert.equal(filters.skipReason(c, cases.filters), expected, `${c.title} / ${c.company} / ${c.text}`);
  }
});

test("previewOk matches the Python bots", () => {
  for (const c of cases.previewOk) assert.equal(filters.previewOk(c.preview, cases.filters), c.expected, c.preview);
});

test("minYears matches the Python bots", () => {
  for (const c of cases.minYears) assert.equal(filters.minYears(c.text), c.expected, c.text);
});

test("hasWord matches the Python bots", () => {
  for (const c of cases.hasWord) assert.equal(filters.hasWord(c.text, c.word), c.expected, `${c.word} in ${c.text}`);
});

test("answerFor matches the Python bots", () => {
  for (const c of cases.answerFor) assert.equal(answers.answerFor(c.label, cases.answers), c.expected, c.label);
});

test("answer helpers", () => {
  assert.equal(answers.numberAnswer("15 LPA"), "15");
  assert.equal(answers.numberAnswer("+91 98765 43210"), "919876543210");
  assert.equal(answers.numberAnswer("2.5"), "2.5");
  assert.equal(answers.coverNote("  Keen on {title} at {company}. ", { title: "SDE", company: "Acme" }), "Keen on SDE at Acme.");
  assert.equal(answers.coverNote("Hi {company}", { title: "", company: "" }), "Hi your company");
  assert.deepEqual(answers.badPatterns([["notice", "x"], ["(unclosed", "y"], ["", "z"]]), ["(unclosed", ""]);
});

test("Hirist search pages and job ids", () => {
  const cfg = { keywords: ["Python Developer", "AI/ML", "python developer"], minExperience: 1, maxExperience: 2, searchUrls: ["https://www.hirist.tech/k/python-jobs"] };
  assert.deepEqual(hirist.searchUrls(cfg), [
    "https://www.hirist.tech/search/python-developer?minexp=1&maxexp=2",
    "https://www.hirist.tech/search/ai-ml?minexp=1&maxexp=2",
    "https://www.hirist.tech/k/python-jobs",
  ]);
  assert.deepEqual(hirist.searchUrls({ keywords: ["rag"] }), ["https://www.hirist.tech/search/rag"]);
  assert.equal(hirist.searchPageUrl("https://www.hirist.tech/search/rag?minexp=1", 1), "https://www.hirist.tech/search/rag?minexp=1");
  assert.equal(hirist.searchPageUrl("https://www.hirist.tech/search/rag?minexp=1", 3), "https://www.hirist.tech/search/rag?minexp=1&page=3");
  assert.equal(hirist.searchPageUrl("https://www.hirist.tech/k/rag-jobs", 2), "https://www.hirist.tech/k/rag-jobs?page=2");
  assert.equal(hirist.jobId("https://www.hirist.tech/j/focalworks-python-developer-django-1671936"), "1671936");
  assert.equal(hirist.jobId("https://www.hirist.tech/j/1671936?ref=x"), "1671936");
  assert.ok(hirist.searchHost.test("https://hirist.tech/k/x") && !hirist.searchHost.test("https://evil.com/hirist.tech/"));
});

test("settings: defaults fill gaps, a site's answers come before the shared ones", () => {
  const s = store.normalize({ profile: { coverNote: "Hi", filters: { excludeTitle: ["intern"] } }, sites: { hirist: { limits: { maxPerRun: 3 } } } });
  assert.equal(s.profile.coverNote, "Hi");
  assert.deepEqual(s.profile.filters.excludeTitle, ["intern"]);
  assert.deepEqual(s.profile.filters.requireRole, JB.DEFAULTS.profile.filters.requireRole);
  assert.equal(s.sites.hirist.limits.maxPerRun, 3);
  assert.equal(s.sites.hirist.limits.maxPerDay, JB.DEFAULTS.sites.hirist.limits.maxPerDay);
  assert.deepEqual(s.sites.hirist.keywords, JB.DEFAULTS.sites.hirist.keywords);

  const mine = cfg => cfg.answers.slice(0, -2); // the last two are the standard ones (self-identification, consent)
  assert.deepEqual(mine(store.effective(s, "hirist")), s.profile.answers); // no answers of its own: the shared ones
  s.sites.hirist.answers = [["notice", "15 days"]];
  const cfg = store.effective(s, "hirist");
  assert.deepEqual(mine(cfg), [["notice", "15 days"]]); // its own replace the shared ones
  assert.equal(cfg.coverNote, "Hi");
  assert.deepEqual(cfg.keywords, s.sites.hirist.keywords);
  assert.equal(store.normalize(undefined).savedAt, null);
});

test("Instahyre, Wellfound and Cutshort search pages match the Python bots", async () => {
  const kept = {};
  globalThis.chrome = { storage: { local: { get: async k => ({ [k]: kept[k] }), set: async o => Object.assign(kept, o) } } };
  for (const c of cases.siteUrls) {
    const got = sites[c.site].searches ? await sites[c.site].searches(c.cfg, async () => null, () => {}) : sites[c.site].searchUrls(c.cfg);
    assert.deepEqual(got, c.expected, `${c.site} ${JSON.stringify(c.cfg)}`);
  }
});

test("Cutshort looks up a skill it doesn't know once, and remembers it", async () => {
  const kept = {};
  globalThis.chrome = { storage: { local: { get: async k => ({ [k]: kept[k] }), set: async o => Object.assign(kept, o) } } };
  const asked = [];
  const lookup = async k => { asked.push(k); return k === "FastAPI" ? "06785" : null; };
  const said = [];
  const cfg = { keywords: ["FastAPI", "unicorn", "python"], minExperience: 1, maxExperience: 2, searchUrls: [] };
  const urls = await sites.cutshort.searches(cfg, lookup, line => said.push(line));
  assert.deepEqual(urls, [
    "https://cutshort.io/profile/all-jobs?minexp=1&maxexp=2&skills=06785",
    "https://cutshort.io/profile/all-jobs?minexp=1&maxexp=2&skills=00360",
  ]);
  assert.deepEqual(asked, ["FastAPI", "unicorn"]);
  assert.deepEqual(said, ["  Cutshort has no skill called 'unicorn', skipping it."]);
  assert.deepEqual(kept[sites.cutshort.CACHE_KEY], { fastapi: "06785" });
  assert.equal(sites.cutshort.searchLabel(urls[0]), "fastapi");
  await sites.cutshort.searches(cfg, lookup, () => {});
  assert.deepEqual(asked, ["FastAPI", "unicorn", "unicorn"]); // found ones aren't looked up again; misses are retried
  assert.equal(sites.cutshort.searchPageUrl(urls[0], 3), `${urls[0]}&page=3`);
  assert.equal(sites.cutshort.jobId("https://cutshort.io/job/ML-Engineer-Acme-abc123?ref=feed"), "ML-Engineer-Acme-abc123");
});

test("Wellfound's experience reads like the Python bot's", () => {
  for (const c of cases.withRange) assert.equal(sites.wellfound.withRange(c.text), c.expected, c.text);
});

test("Instahyre and Wellfound job ids and paging", () => {
  assert.equal(sites.instahyre.jobId("https://www.instahyre.com/job-298311-ml-engineer-at-acme-bangalore/"), "298311");
  assert.equal(sites.instahyre.searchPageUrl("https://www.instahyre.com/search-jobs?skills=x&years=1", 2), null);
  assert.equal(sites.wellfound.jobId("https://wellfound.com/jobs/3119876-machine-learning-engineer"), "3119876");
  assert.equal(sites.wellfound.searchPageUrl("https://wellfound.com/role/l/ai-engineer/india", 2), "https://wellfound.com/role/l/ai-engineer/india?page=2");
  assert.ok(!sites.instahyre.paged && sites.wellfound.paged && sites.hirist.paged);
});

test("defaults have each site's own settings", () => {
  const s = store.normalize(undefined);
  assert.ok(s.sites.instahyre.limits.maxScrolls >= 0 && s.sites.instahyre.limits.maxPages === undefined);
  assert.deepEqual(s.sites.wellfound.locations, ["india", "remote"]);
  assert.ok(s.sites.wellfound.limits.maxPages >= 1);
});

test("Naukri search pages, paging, job ids", () => {
  const naukri = sites.naukri;
  const cfg = { keywords: ["Machine Learning Engineer", "AI/ML"], minExperience: 1, maxExperience: 2, postedWithin: "week", searchUrls: ["https://www.naukri.com/python-jobs-in-pune"] };
  assert.deepEqual(naukri.searchUrls(cfg), [
    "https://www.naukri.com/machine-learning-engineer-jobs?k=Machine%20Learning%20Engineer&experience=2&jobAge=7",
    "https://www.naukri.com/ai-ml-jobs?k=AI%2FML&experience=2&jobAge=7",
    "https://www.naukri.com/python-jobs-in-pune",
  ]);
  assert.deepEqual(naukri.searchUrls({ keywords: ["sde"], locations: ["Bengaluru", "delhi ncr"], postedWithin: "" }), [
    "https://www.naukri.com/sde-jobs-in-bengaluru?k=sde&l=Bengaluru",
    "https://www.naukri.com/sde-jobs-in-delhi-ncr?k=sde&l=delhi%20ncr",
  ]);
  const url = naukri.searchUrls(cfg)[0];
  assert.equal(naukri.searchPageUrl(url, 1), url);
  assert.equal(naukri.searchPageUrl(url, 2), "https://www.naukri.com/machine-learning-engineer-jobs-2?k=Machine%20Learning%20Engineer&experience=2&jobAge=7");
  assert.equal(naukri.searchPageUrl("https://www.naukri.com/python-jobs-in-pune", 3), "https://www.naukri.com/python-jobs-in-pune-3");
  assert.equal(naukri.searchLabel("https://www.naukri.com/sde-jobs-in-bengaluru?k=sde&l=Bengaluru"), "sde, Bengaluru");
  assert.equal(naukri.searchLabel("https://www.naukri.com/python-jobs-in-pune"), null);
  assert.equal(naukri.jobId("https://www.naukri.com/job-listings-ml-engineer-acme-bengaluru-1-to-3-years-231024500101?src=jobsearchDesk"), "231024500101");
  assert.ok(!naukri.jobUrlRe.test("https://www.naukri.com/acme-jobs-careers-123456"));
  assert.ok(naukri.searchHost.test("https://naukri.com/x") && !naukri.searchHost.test("https://evil.com/naukri.com/"));
  assert.ok(filters.previewOk("ML Engineer Acme 1-3 Yrs Bengaluru", { maxExperienceRequired: 2 })); // its cards' "X-Y Yrs"
  assert.ok(!filters.previewOk("ML Engineer Old Co 5-8 Yrs Bengaluru", { maxExperienceRequired: 2 }));
  const s = store.normalize(undefined);
  assert.deepEqual(s.sites.naukri.locations, []);
  assert.ok(s.sites.naukri.limits.maxPages >= 1 && s.sites.naukri.postedWithin === "week");
});

test("select all that apply: the options the answer lists, even ones with commas in them", () => {
  const options = ["Citizen or permanent resident of Cuba, Iran, North Korea, or Syria", "Ordinarily a resident of Russia or Belarus", "None of the above"];
  assert.deepEqual(answers.pickSeveral(options, "None of the above"), [2]);
  assert.deepEqual(answers.pickSeveral(options, "Citizen or permanent resident of Cuba, Iran, North Korea, or Syria"), [0]);
  assert.deepEqual(answers.pickSeveral(["English (ENG)", "Hindi (HIN)", "Tamil (TAM)"], "english (eng), Hindi (HIN)"), [0, 1]);
  assert.deepEqual(answers.pickSeveral(["No", "None"], "None"), [1]); // not "No" because "None" starts with it
  assert.deepEqual(answers.pickSeveral(["Yes", "No"], ""), []);
});

test("an option is picked only when it is the answer, or starts with it", () => {
  assert.equal(answers.pick(["15 Days or less", "1 Month", "2 Months"], "1 month"), 1);
  assert.equal(answers.pick(["Yes", "No"], "yes"), 0);
  assert.equal(answers.pick(["Yes, I am", "No"], "Yes"), 0);
  assert.equal(answers.pick(["15 Days or less", "1 Month"], "30 days"), null);
  assert.equal(answers.pick(["Yes", "No"], ""), null);
});

test("a length of time picks the option covering it, never a guess", () => {
  const naukri = ["15 Days or less", "1 Month", "2 Months", "3 Months", "More than 3 Months", "Serving Notice Period"];
  const picked = a => naukri[answers.pickDuration(naukri, a)];
  assert.equal(picked("30 days"), "1 Month");
  assert.equal(picked("15 days"), "15 Days or less");
  assert.equal(picked("Immediately"), "15 Days or less");
  assert.equal(picked("90 days"), "3 Months");
  assert.equal(picked("120 days"), "More than 3 Months");
  assert.equal(picked("45 days"), undefined); // between 1 and 2 months
  assert.equal(picked("Yes"), undefined);
  const ranges = ["0-15 days", "15-30 days", "30-60 days", "60+ days"];
  assert.equal(ranges[answers.pickDuration(ranges, "30 days")], "15-30 days"); // the narrower of the two covering it
  assert.equal(ranges[answers.pickDuration(ranges, "90 days")], "60+ days");
  assert.equal(answers.pickDuration(["0-30 days", "30-60 days"], "30 days"), null); // two fit as well
  assert.equal(answers.pickDuration(["Less than 30 days", "30 days or more"], "30 days"), 1); // "less than" leaves 30 out
  assert.equal(answers.pickDuration(["Within 2 weeks", "1 Month"], "2 weeks"), 0);
  assert.equal(answers.pickDuration(naukri, "15-30 days"), null); // an answer that's a range itself: no
});

test("questions, options and experience in other languages", () => {
  assert.equal(answers.questionKey("¿Cuál es su salario esperado? *"), "cual es su salario esperado");
  assert.equal(answers.questionKey("Kündigungsfrist?"), "kundigungsfrist");
  assert.equal(answers.questionKey("希望年収を教えてください（必須）"), "希望年収を教えてください 必須");
  assert.equal(answers.questionKey("ما هو راتبك المتوقع؟"), "ما هو راتبك المتوقع");
  assert.notEqual(answers.questionKey("Python経験年数"), answers.questionKey("Pythonの使用歴")); // not both "python"
  assert.equal(answers.pick(["Sí", "No"], "Si"), 0);
  assert.equal(answers.pick(["Não", "Sim"], "Nao"), 0);
  assert.equal(answers.pick(["はい", "いいえ"], "いいえ"), 1);
  assert.equal(answers.pick(["Ｙｅｓ", "Ｎｏ"], "No"), 1); // full-width letters
  assert.deepEqual(answers.pickSeveral(["Français", "Deutsch", "日本語"], "francais, 日本語"), [0, 2]);

  for (const [text, years] of [["3-5 Jahre Berufserfahrung", 3], ["de 2 a 4 años", 2], ["3 à 5 ans", 3], ["3〜5年以上", 3],
    ["2–4 år", 2], ["3-5 lat", 3], ["1 tot 3 jaar", 1], ["3-5 лет", 3], ["3-5 answers", null], ["5-8 YrsBengaluru", 5]]) {
    assert.equal(filters.minYears(text), years, text);
  }
  assert.equal(sites.linkedin.withRange("Mindestens 3 bis 5 Jahre"), "3 - 3 years. Mindestens 3 bis 5 Jahre");

  const de = ["Sofort", "Bis zu 1 Monat", "1-3 Monate", "Mehr als 3 Monate"];
  assert.equal(de[answers.pickDuration(de, "30 days")], "Bis zu 1 Monat");
  assert.equal(de[answers.pickDuration(de, "Immediately")], "Sofort");
  assert.equal(de[answers.pickDuration(de, "120 days")], "Mehr als 3 Monate");
  const fr = ["Immédiatement", "Moins de 15 jours", "1 mois", "2 mois", "Plus de 3 mois"];
  assert.equal(fr[answers.pickDuration(fr, "1 month")], "1 mois");
  assert.equal(fr[answers.pickDuration(fr, "10 days")], "Moins de 15 jours");
  const es = ["15 días o menos", "De 1 a 3 meses", "Más de 3 meses"];
  assert.equal(es[answers.pickDuration(es, "60 days")], "De 1 a 3 meses");
  assert.deepEqual(answers.daysRange("até 30 dias"), { lo: 0, hi: 30 });
  assert.deepEqual(answers.daysRange("1 miesiąc"), { lo: 30, hi: 30 });
});

test("answers kept under the old ASCII-only keys come back under today's", async () => {
  const before = {
    "k ndigungsfrist": { q: "Kündigungsfrist?", answer: "3 Monate", ts: "2026-10-01 10:00:00" },
    "": { q: "希望年収", answer: "800万円", ts: "2026-10-02 10:00:00" },
    "notice period": { q: "Notice period", answer: "30 days", ts: "2026-10-03 10:00:00" },
  };
  local.get = async key => ({ [key]: key === "kept" ? before : {
    "s alaire": { q: "Salaire ?", jobs: ["company:1"], ts: "2026-10-01" },
    "salaire": { q: "Salaire", jobs: ["company:2"], ts: "2026-10-02" },
  } });
  const kept = await store.kept();
  assert.deepEqual(Object.keys(kept).sort(), ["kundigungsfrist", "notice period", "希望年収"]);
  assert.equal(kept.kundigungsfrist.answer, "3 Monate");
  assert.deepEqual((await store.waiting()).salaire.jobs, ["company:1", "company:2"]); // two that are now one
  delete local.get;
});

test("LinkedIn reads experience, answers questions and picks options like the Python bot", () => {
  const li = cases.linkedin;
  for (const c of li.withRange) assert.equal(sites.linkedin.withRange(c.text), c.expected, c.text);
  const fill = { answers: li.answers, skillYears: li.skillYears, otherSkillYears: li.otherSkillYears };
  for (const c of li.answer) assert.equal(sites.linkedin.answer(c.label, fill), c.expected, c.label);
  for (const c of li.pick) assert.equal(sites.linkedin.pick(c.options, c.answer), c.expected, `${c.answer} in ${c.options}`);
  assert.equal(sites.linkedin.searchPageUrl("https://www.linkedin.com/jobs/search/?keywords=x", 3), "https://www.linkedin.com/jobs/search/?keywords=x&start=50");
  assert.equal(sites.linkedin.jobId("https://www.linkedin.com/jobs/view/senior-ml-engineer-at-x-4012345678/?trk=1"), "4012345678");
  assert.equal(sites.linkedin.searchLabel("https://www.linkedin.com/jobs/search/?keywords=ai+engineer&location=India"), "ai engineer, India");
});

test("referrals name people, fill in messages and search like the Python bot", () => {
  const li = cases.linkedin;
  for (const c of li.firstName) assert.equal(JB.referral.firstName(c.name), c.expected, c.name);
  for (const c of li.render) assert.equal(JB.referral.render(c.template, c.name, c.job), c.expected, `${c.template} / ${c.name}`);
  for (const c of li.peopleUrl) assert.equal(JB.referral.peopleUrl(c.ids, c.keywords), c.expected, c.keywords);
  assert.equal(JB.referral.slugOf("https://www.linkedin.com/in/Priya-Sharma-%C3%A9/?x=1"), "priya-sharma-é");
});

test("applications: applied jobs are in it on their own, with what's tracked about them", () => {
  const jobs = {
    "hirist:1": { site: "hirist", jobId: "1", title: "ML Engineer", company: "Acme", url: "u1", status: "applied", note: "", ts: "2026-10-01 10:00:00" },
    "hirist:2": { site: "hirist", jobId: "2", title: "SDE", company: "Beta", status: "skipped", note: "", ts: "2026-10-01 10:00:00" },
    "naukri:3": { site: "naukri", jobId: "3", title: "AI Engineer", company: "Gamma", status: "applied", note: "finished by hand", ts: "2026-10-02 10:00:00" },
    "naukri:4": { site: "naukri", jobId: "4", title: "Old", company: "Delta", status: "already_applied", note: "", ts: "2026-10-02 10:00:00" },
    "naukri:5": { site: "naukri", jobId: "5", title: "Gone", company: "Eps", status: "applied", note: "", ts: "2026-10-02 10:00:00" },
  };
  const track = {
    "hirist:1": { key: "hirist:1", heard: { at: "2026-10-03", via: "email", who: "Priya" }, rounds: [], log: [] },
    "manual:x": { key: "manual:x", site: "manual", jobId: "x", title: "Mine", company: "Zeta", appliedAt: "2026-10-05 12:00:00", source: "manual", rounds: [], log: [] },
    "naukri:5": { key: "naukri:5", hidden: true, rounds: [] },
  };
  const apps = Object.fromEntries(tracker.list(jobs, track).map(a => [a.key, a]));
  assert.deepEqual(Object.keys(apps).sort(), ["hirist:1", "manual:x", "naukri:3", "naukri:4"]);
  assert.equal(apps["hirist:1"].title, "ML Engineer"); // from the history...
  assert.equal(apps["hirist:1"].heard.who, "Priya"); // ...with what's tracked on top
  assert.equal(apps["hirist:1"].source, "bot");
  assert.equal(apps["naukri:3"].source, "self");
  assert.ok(apps["naukri:4"].old && !apps["hirist:1"].old);
  assert.equal(apps["manual:x"].company, "Zeta");
});

test("applications: the stage, and what's next", () => {
  const now = new Date("2026-10-24T12:00").getTime();
  const base = { heard: null, rounds: [], outcome: null, appliedAt: "2026-10-20 10:00:00" };
  assert.equal(tracker.stage(base, 21, now), "waiting");
  assert.equal(tracker.stage({ ...base, appliedAt: "2026-09-01 10:00:00" }, 21, now), "quiet");
  assert.equal(tracker.stage({ ...base, heard: { via: "email" } }, 21, now), "heard");
  assert.equal(tracker.group(tracker.stage({ ...base, heard: { via: "email" } }, 21, now)), "active");
  assert.equal(tracker.group("rejected"), "closed");
  assert.equal(tracker.next(base, 21, now), null);
  assert.equal(tracker.next({ ...base, heard: {} }, 21, now).type, "setup");

  const rounds = tracker.fromTemplate(tracker.DEFAULTS.templates[0]);
  assert.deepEqual(rounds.map(r => [r.kind, r.name, r.status]), [
    ["call", "Recruiter call", "planned"], ["assignment", "Take-home", "planned"], ["interview", "Technical", "planned"], ["interview", "Founder chat", "planned"]]);
  assert.equal(new Set(rounds.map(r => r.id)).size, 4);
  let a = { ...base, rounds };
  assert.equal(tracker.stage(a, 21, now), "rounds");
  assert.equal(tracker.next(a, 21, now).type, "plan");
  assert.ok(tracker.heardBack(a) && !tracker.hadRound(a));

  a = tracker.change(a, { round: { id: rounds[0].id, status: "cleared" } });
  a = tracker.change(a, { round: { id: rounds[1].id, status: "scheduled", at: "2026-10-22", due: "2026-10-26" } });
  let nx = tracker.next(a, 21, now);
  assert.equal(nx.type, "due");
  assert.equal(nx.round.id, rounds[1].id);
  assert.equal(nx.at.getDate(), 26);
  assert.equal(tracker.roundWord(nx.round), "To do"); // an assignment's own words
  assert.equal(tracker.roundWord({ kind: "interview", status: "scheduled" }), "Scheduled");

  a = tracker.change(a, { round: { id: rounds[1].id, status: "given", changed: "2026-10-20" } });
  nx = tracker.next(a, 21, now);
  assert.equal(nx.type, "result");
  assert.equal(nx.days, 4);
  a = tracker.change(a, { round: { id: rounds[1].id, status: "cleared" } });
  a = tracker.change(a, { round: { id: rounds[2].id, status: "scheduled", at: "2026-10-26T11:00" } });
  nx = tracker.next(a, 21, now);
  assert.deepEqual([nx.type, nx.at.getHours()], ["round", 11]);
  a = tracker.change(a, { round: { id: rounds[2].id, status: "not_cleared" } });
  assert.equal(tracker.next(a, 21, now).type, "plan"); // the founder chat is still on
  a = tracker.change(a, { drop: rounds[3].id });
  assert.equal(tracker.next(a, 21, now).type, "end");
  a = tracker.change(a, { set: { outcome: "rejected" } });
  assert.equal(tracker.stage(a, 21, now), "rejected");
  assert.equal(tracker.next(a, 21, now), null);
  assert.equal(tracker.next({ ...a, outcome: "offer" }, 21, now).type, "reply");
});

test("applications: changes merge, move and add rounds", () => {
  let a = { heard: null, rounds: [], log: [] };
  a = tracker.change(a, { heard: { at: "2026-10-03", via: "email" } });
  a = tracker.change(a, { heard: { via: "call" } });
  assert.deepEqual(a.heard, { at: "2026-10-03", via: "call" });
  assert.equal(tracker.change(a, { heard: null }).heard, null);

  a = tracker.change(a, { round: { id: "r1", name: "Screen" } }); // a new id adds it, with the rest filled in
  assert.deepEqual(a.rounds[0], { id: "r1", kind: "interview", name: "Screen", at: "", due: "", status: "planned", note: "" });
  a = tracker.change(a, { rounds: [tracker.newRound("assignment", "Take-home")] });
  a = tracker.change(a, { move: { id: "r1", by: 1 } });
  assert.deepEqual(a.rounds.map(r => r.name), ["Take-home", "Screen"]);
  assert.deepEqual(tracker.change(a, { move: { id: "r1", by: 1 } }).rounds.map(r => r.name), ["Take-home", "Screen"]); // already last
  const before = a.rounds;
  tracker.change(a, { round: { id: "r1", status: "given" } });
  assert.equal(before[1].status, "planned"); // the one passed in is left as it was
});

test("applications: figures, and settings with defaults", () => {
  const app = (key, more) => ({ key, site: key.split(":")[0], source: "bot", heard: null, rounds: [], outcome: null, ...more });
  const f = tracker.figures([
    app("hirist:1"), app("hirist:2", { heard: { via: "email" } }),
    app("linkedin:3", { rounds: [{ status: "cleared" }], outcome: "offer" }), app("linkedin:4", { outcome: "rejected" }),
    app("manual:5", { source: "manual", outcome: "ghosted" }),
  ], new Set(["linkedin:3", "linkedin:4"]));
  assert.deepEqual([f.applied, f.bot, f.heard, f.rounds, f.offers], [5, 4, 3, 1, 1]);
  assert.deepEqual(f.sites.hirist, { n: 2, heard: 1 });
  assert.deepEqual(f.ended, { rejected: 1, ghosted: 1 });
  assert.deepEqual(f.referral, { n: 2, heard: 2, otherN: 3, otherHeard: 1 });

  assert.equal(store.normalize(undefined).tracker.quietDays, 21);
  assert.equal(store.normalize(undefined).tracker.templates.length, 3);
  const mine = store.normalize({ tracker: { quietDays: 30, templates: [] } }).tracker;
  assert.deepEqual([mine.quietDays, mine.templates, mine.countOld], [30, [], false]); // no templates is a choice
});

test("applications: a calendar file for a round", () => {
  const ics = tracker.ics({ key: "linkedin:9", title: "ML Engineer", company: "Acme, Inc", url: "https://x" },
    { id: "r1", kind: "interview", name: "System design", at: "2026-10-26T11:00", note: "Bring; notes" }, new Date("2026-10-24T00:00:00Z"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nSUMMARY:System design: ML Engineer at Acme\\, Inc\r\n/);
  assert.match(ics, /\r\nDESCRIPTION:Bring\\; notes\\nhttps:\/\/x\r\n/);
  const start = new Date("2026-10-26T11:00").toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  assert.ok(ics.includes(`DTSTART:${start}`));
  assert.ok(ics.includes("DTSTAMP:20261024T000000Z"));
});

test("answers you gave are kept for their own question, and tried first", () => {
  assert.equal(answers.questionKey("4. Describe your favourite colour *"), "4 describe your favourite colour");
  assert.equal(answers.questionKey("What is your notice period? (Required)"), "what is your notice period");
  assert.equal(answers.questionKey("Expected CTC (in Lakhs)  Required"), "expected ctc in lakhs");
  const s = store.normalize({ profile: { answers: [["ctc", "12 LPA"], ["notice", "30 days"]] } });
  const cfg = store.effective(s, "hirist", { "expected ctc in lakhs": { q: "Expected CTC (in lakhs)?", answer: "14" } });
  assert.deepEqual(cfg.answers[0], ["=expected ctc in lakhs", "14"]);
  assert.equal(answers.answerFor("Expected CTC (in Lakhs) *", cfg.answers), "14"); // the very question: yours
  assert.equal(answers.answerFor("Current CTC", cfg.answers), "12 LPA"); // any other: the patterns, as before
  assert.equal(answers.answerFor("Notice period", cfg.answers), "30 days");
  assert.deepEqual(store.effective(s, "hirist").answers.slice(0, s.profile.answers.length), s.profile.answers);
});

test("company sites: which links it can apply on, and what's next to apply to", () => {
  const { parse, linkIn, queue } = sites.company;
  assert.deepEqual(parse("https://job-boards.greenhouse.io/gitlab/jobs/8860302002?gh_src=x"), // its form, as companies embed it
    { system: "greenhouse", jobId: "gh-8860302002", url: "https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=8860302002" });
  assert.deepEqual(parse("https://boards.greenhouse.io/embed/job_app?token=8172510&for=stripe"),
    { system: "greenhouse", jobId: "gh-8172510", url: "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8172510" });
  const id = "6ed76ce8-4156-4b60-b120-403538bd66cd";
  assert.deepEqual(parse(`https://jobs.lever.co/palantir/${id}`), { system: "lever", jobId: `lever-${id}`, url: `https://jobs.lever.co/palantir/${id}/apply` });
  assert.equal(parse(`https://jobs.ashbyhq.com/ramp/${id}?src=x`).url, `https://jobs.ashbyhq.com/ramp/${id}/application`);
  assert.deepEqual(parse("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Israel%2C-Yokneam/Software-Engineer--SPE_JR2015623/apply/applyManually"),
    { system: "workday", jobId: "wd-nvidia-jr2015623", url: "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Israel%2C-Yokneam/Software-Engineer--SPE_JR2015623" });
  assert.equal(parse("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"), null); // the careers site, not a job
  for (const no of ["https://jobs.lever.co/palantir", "http://jobs.lever.co/a/" + id, "https://www.linkedin.com/jobs/view/1/", "https://careers.example.com/", "not a link"]) {
    assert.equal(parse(no), null, no);
  }
  // with "Other companies' forms": more systems, and any company's own form
  assert.deepEqual(parse("https://apply.workable.com/acme/j/ABC123DEF/"), { system: "workable", jobId: "workable-acme-abc123def", url: "https://apply.workable.com/acme/j/ABC123DEF/", more: true });
  assert.equal(parse("https://jobs.smartrecruiters.com/Acme/743999912345-ml-engineer?trid=x").jobId, "smartrecruiters-acme-743999912345");
  assert.equal(parse("https://acme.recruitee.com/o/ml-engineer").jobId, "recruitee-acme-ml-engineer");
  assert.equal(parse("https://acme.teamtailor.com/jobs/4512-ml-engineer").jobId, "teamtailor-acme-4512");
  assert.equal(parse("https://acme.keka.com/careers/jobdetails/91").jobId, "keka-acme-91");
  const own = parse("https://careers.example.com/jobs/1?utm=x");
  assert.equal(own.system, "web");
  assert.ok(own.more && /^web-\w+$/.test(own.jobId) && own.jobId === parse("https://careers.example.com/jobs/1/").jobId); // tracking aside
  assert.notEqual(parse("https://acme.com/careers/job?jobId=5").jobId, parse("https://acme.com/careers/job?jobId=6").jobId);
  assert.deepEqual(parse("https://acme.icims.com/jobs/123/ml-engineer/job"), { system: "portal" }); // wants an account: left for you
  assert.deepEqual(parse("https://career5.successfactors.eu/career?company=acme"), { system: "portal" });
  assert.equal(linkIn(`apply opens an external site: https://jobs.lever.co/acme/${id}).`), `https://jobs.lever.co/acme/${id}`);
  assert.equal(linkIn("redirected to https://job-boards.greenhouse.io/acme/jobs/1"), "https://job-boards.greenhouse.io/acme/jobs/1");

  const history = {
    "hirist:1": { site: "hirist", jobId: "1", title: "ML Engineer", company: "Acme", status: "external", note: `apply opens an external site: https://jobs.lever.co/acme/${id}`, ts: "2026-10-01 10:00:00" },
    "hirist:2": { site: "hirist", jobId: "2", status: "external", note: "apply opens an external site: https://careers.example.com/2", ts: "2026-10-01 10:00:00" },
    "naukri:3": { site: "naukri", jobId: "3", status: "external", note: "redirected to https://job-boards.greenhouse.io/b/jobs/33", ts: "2026-10-02 10:00:00" },
    "company:gh-44": { site: "company", jobId: "gh-44", status: "applied", ts: "2026-10-02 10:00:00" },
    "company:gh-55": { site: "company", jobId: "gh-55", status: "failed", ts: "2026-10-02 10:00:00" },
  };
  const links = ["https://job-boards.greenhouse.io/b/jobs/44", "https://job-boards.greenhouse.io/b/jobs/55", "https://job-boards.greenhouse.io/b/jobs/33", "https://x.com/no"];
  const jobs = queue({ searchUrls: links, fromOthers: true }, history);
  assert.deepEqual(jobs.map(j => j.jobId), ["gh-55", "gh-33", `lever-${id}`]); // done ones left out, a failed one tried again, each once
  assert.deepEqual([jobs[2].title, jobs[2].company, jobs[2].from], ["ML Engineer", "Acme", "hirist:1"]);
  assert.deepEqual(queue({ searchUrls: [], fromOthers: false }, history), []);
  const more = queue({ searchUrls: ["https://acme.icims.com/jobs/1/x/job"], fromOthers: true, moreForms: true }, history);
  assert.deepEqual(more.map(j => j.jobId), [`lever-${id}`, parse("https://careers.example.com/2").jobId, "gh-33"]); // not the account one
});

test("your profile answers what forms ask about you, after your own answers", () => {
  const s = store.normalize({
    profile: { firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "+91 98765 43210", linkedin: "https://linkedin.com/in/asha",
      answers: [["linkedin", ""], ["phone", "98765 43210"]] },
  });
  const cfg = store.effective(s, "company", { "4 describe your favourite colour": { answer: "Blue" } });
  const a = q => answers.answerFor(q, cfg.answers);
  assert.equal(a("First Name*"), "Asha");
  assert.equal(a("Full name ✱"), "Asha Rao");
  assert.equal(a("Legal Name"), "Asha Rao");
  assert.equal(a("Email"), "asha@example.com");
  assert.equal(a("LinkedIn Profile"), "https://linkedin.com/in/asha"); // an empty answer of yours leaves it to the profile
  assert.equal(a("Phone"), "98765 43210"); // one you wrote comes first
  assert.equal(a("4. Describe your favourite colour"), "Blue");
  assert.equal(a("Name of your university"), null);
  assert.equal(a("Email address of the person who referred you"), null);
  assert.equal(a("Current company"), null); // nothing in the profile: no answer
});

test("what a site says about an application, and what it changes", () => {
  const says = tracker.replySignal;
  assert.equal(says("Applied 3d ago · Application viewed"), "viewed");
  assert.equal(says("Your resume was downloaded"), "viewed");
  assert.equal(says("Application status: Not selected"), "rejected");
  assert.equal(says("No longer being considered"), "rejected");
  assert.equal(says("Not Shortlisted"), "rejected"); // not "shortlisted"
  assert.equal(says("Recruiter Action"), "replied");
  assert.equal(says("Shortlisted for interview"), "replied");
  assert.equal(says("No longer accepting applications"), null); // the job closed: says nothing of yours
  assert.equal(says("Applied 2w ago"), null);

  const app = { heard: null, rounds: [], outcome: null };
  assert.deepEqual(tracker.fromSite(app, "viewed", "LinkedIn", "2026-10-25"), [{ set: { signals: { viewed: "2026-10-25" }, viewed: "2026-10-25" } }, "LinkedIn says: application viewed"]);
  assert.deepEqual(tracker.fromSite(app, "replied", "Naukri", "2026-10-25")[0].heard, { at: "2026-10-25", via: "site", who: "" });
  assert.equal(tracker.fromSite({ ...app, signals: { viewed: "2026-10-20" } }, "viewed", "LinkedIn", "2026-10-25"), null); // said before
  assert.equal(tracker.fromSite({ ...app, outcome: "offer" }, "rejected", "LinkedIn", "2026-10-25"), null); // you know better
  assert.deepEqual(tracker.fromSite({ ...app, heard: { via: "email" } }, "replied", "Naukri", "2026-10-25")[0], { set: { signals: { replied: "2026-10-25" } } });
});

test("where you are: countries, with their calling code and currency", () => {
  const names = places.COUNTRIES.map(c => c.name);
  assert.ok(places.COUNTRIES.length > 190 && new Set(names).size === names.length);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(places.country("india"), { code: "IN", name: "India", dial: "91", currency: "INR" });
  assert.equal(places.country("Germany").currency, "EUR");
  assert.equal(places.country("United Kingdom").dial, "44");
  assert.equal(places.country("United States").currency, "USD");
  assert.equal(places.country("Atlantis"), null);

  assert.equal(places.salaryText(800000, "INR", "year"), "8 LPA");
  assert.equal(places.salaryText(1250000, "INR", "year"), "12.5 LPA");
  assert.equal(places.salaryText(65000, "EUR", "year"), "65000 EUR a year");
  assert.equal(places.salaryText(40, "USD", "hour"), "40 USD an hour");
  assert.equal(places.salaryText(null, "EUR", "year"), "");
  assert.equal(answers.numberAnswer(places.salaryText(65000, "EUR", "year")), "65000");
});

test("where you are goes into your answers, the shared ones and LinkedIn's", () => {
  const before = store.normalize(undefined); // a new install: those answers start empty
  const ask = (s, site, q) => answers.answerFor(q, store.effective(s, site).answers);
  assert.equal(ask(before, "hirist", "What is your expected CTC?"), null);
  assert.equal(ask(before, "hirist", "Are you currently living in Bangalore?"), "No"); // no sample city says Yes

  const after = structuredClone(before);
  Object.assign(after.profile, { country: "Germany", city: "München", currency: "EUR", salaryPeriod: "year", currentSalary: 60000,
    expectedSalary: 70000, noticePeriod: "3 months", relocate: "No" });
  const got = places.apply(before, after);
  assert.deepEqual(got, { answers: 14, places: 2 });
  for (const [q, a] of [["What is your notice period?", "3 months"], ["Current CTC", "60000 EUR a year"], ["Expected salary", "70000 EUR a year"],
    ["Current city", "München"], ["Are you currently living in Munich?", "Yes"], ["Are you currently based in Germany?", "Yes"],
    ["Are you currently living in Bengaluru?", "No"], ["Are you willing to relocate?", "No"], ["Country code", "Germany (+49)"]]) {
    assert.equal(ask(after, "hirist", q), a, q);
  }
  assert.equal(ask(after, "linkedin", "What is your expected CTC?"), "70000"); // its number boxes
  assert.equal(ask(after, "linkedin", "Current location"), "München");
  assert.equal(ask(after, "linkedin", "Country code"), "Germany (+49)");
  assert.deepEqual(after.sites.linkedin.locations, ["Germany"]); // the sample searched India
  assert.deepEqual(after.sites.wellfound.locations, ["germany", "remote"]);
  assert.deepEqual(places.apply(after, structuredClone(after)), { answers: 0, places: 0 }); // nothing changed: nothing to do

  const raise = structuredClone(after); // only the expected salary: your other answers stay as you wrote them
  raise.profile.answers = raise.profile.answers.map(([p, a]) => [p, /notice/.test(p) ? "90 days" : a]);
  raise.profile.expectedSalary = 75000;
  places.apply(after, raise);
  assert.equal(ask(raise, "hirist", "Expected salary"), "75000 EUR a year");
  assert.equal(ask(raise, "hirist", "Notice period"), "90 days");
});

test("where you are, on answers you wrote yourself", () => {
  const s = store.normalize({ profile: { city: "Bengaluru", answers: [["salary|ctc", "8 LPA"], ["current (city|location)", "Bengaluru"],
    ["currently (living|located|residing|based) in (bengaluru|bangalore)", "Yes"], ["currently (living|located|residing|based) in", "No"]] } });
  const after = structuredClone(s);
  Object.assign(after.profile, { country: "India", currency: "INR", expectedSalary: 1200000 });
  places.apply(s, after);
  const ask = q => answers.answerFor(q, store.effective(after, "hirist").answers);
  assert.equal(ask("Expected CTC"), "12 LPA"); // a row of its own, before the broad one
  assert.equal(ask("Current CTC"), "8 LPA"); // which still answers the rest
  assert.equal(ask("Are you currently based in India?"), "Yes");
  assert.equal(ask("Are you currently living in Bangalore?"), "Yes");
  assert.equal(ask("Are you currently living in Pune?"), "No");

  const moved = structuredClone(after);
  Object.assign(moved.profile, { city: "Toronto", country: "Canada" });
  places.apply(after, moved);
  assert.equal(answers.answerFor("Are you currently living in Bengaluru?", moved.profile.answers), "No"); // not there any more
  assert.equal(answers.answerFor("Are you currently living in Toronto?", moved.profile.answers), "Yes");
  assert.equal(answers.answerFor("Current city", moved.profile.answers), "Toronto");
});

test("jobs abroad: which country a job is in", () => {
  const c = loc => places.countryIn(loc)?.code ?? null;
  assert.equal(c("Bengaluru, Karnataka, India"), "IN");
  assert.equal(c("London, England, United Kingdom"), "GB");
  assert.equal(c("San Francisco, CA"), "US");
  assert.equal(c("New York, NY"), "US");
  assert.equal(c("United States (Remote)"), "US");
  assert.equal(c("Remote - US"), "US");
  assert.equal(c("Remote in UK"), "GB");
  assert.equal(c("Hybrid - Berlin"), "DE");
  assert.equal(c("Toronto, Ontario, Canada"), "CA");
  assert.equal(c("Bangalore"), "IN");
  assert.equal(c("Remote"), null);
  assert.equal(c("US or Canada"), null); // two
  assert.equal(c("EMEA"), null);
  assert.equal(places.country("USA").name, "United States");
  assert.equal(places.country("Hong Kong").code, "HK");
  assert.equal(places.jobCountry({ where: "" }, sites.naukri).code, "IN"); // India's job sites
  assert.equal(places.jobCountry({ where: "", place: "United Kingdom" }, sites.linkedin).code, "GB"); // where it was searched
  assert.equal(places.jobCountry({ where: "Austin, Texas, United States", place: "United Kingdom" }, sites.linkedin).code, "US"); // the page wins
  assert.equal(sites.linkedin.placeOf("https://www.linkedin.com/jobs/search/?keywords=ml&location=United+States"), "United States");
  assert.equal(sites.wellfound.placeOf("https://wellfound.com/role/l/software-engineer/united-kingdom"), "united kingdom");
});

test("jobs abroad: from India, applying in the US and the UK", () => {
  const s = store.normalize({ profile: { country: "India", city: "Bengaluru", currency: "INR", salaryPeriod: "year",
    answers: [["expect.*(ctc|salary|compensation)", "12 LPA"], ["authori[sz]ed to work|legally (allowed|eligible)", "Yes"], ["sponsorship|visa", "No"]],
    workIn: [{ country: "India", can: "citizen" }, { country: "United States", can: "visa", salary: 140000, currency: "USD" },
      { country: "United Kingdom", can: "visa", salary: 70000, currency: "GBP" }] } });
  const cfg = store.effective(s, "company", { "will you now or in the future require sponsorship": { answer: "No" } }); // kept on an Indian job
  const ask = (job, q, site = sites.company) => answers.answerFor(q, places.forJob(cfg, job, site).answers);
  const us = { where: "New York, NY" }, uk = { where: "London, England, United Kingdom" }, india = { where: "Pune, India" }, unknown = { where: "Remote" };

  assert.equal(ask(us, "Will you now or in the future require sponsorship?"), "Yes"); // the job's country, before the kept answer
  assert.equal(ask(us, "Are you legally authorized to work in the country for which you are applying?"), "No");
  assert.equal(ask(us, "Are you authorized to work in the US without sponsorship?"), "No");
  assert.equal(ask(us, "What are your salary expectations?"), "140000 USD a year");
  assert.equal(ask(us, "Expected salary", sites.linkedin), "140000"); // its number boxes
  assert.equal(ask(uk, "Do you have the right to work in the UK?"), "No");
  assert.equal(ask(uk, "Expected salary"), "70000 GBP a year");
  assert.equal(ask(uk, "Are you a U.S. citizen?"), "No"); // a question naming a country: that one
  assert.equal(ask(india, "Will you now or in the future require sponsorship?"), "No");
  assert.equal(ask(india, "Are you authorized to work in India?"), "Yes");
  assert.equal(ask(india, "Are you an Indian citizen?"), "Yes");
  assert.equal(ask(us, "Are you an American citizen or permanent resident?"), "No");
  assert.equal(ask(india, "What is your expected CTC?"), "12 LPA"); // home: your own answer
  assert.equal(ask(unknown, "Will you require visa sponsorship?"), null); // not known: asked, never "No" from below
  assert.equal(ask(unknown, "Are you authorized to work in the United States?"), "No"); // ...unless the question says where
  assert.equal(ask(unknown, "Expected salary"), null);
  assert.equal(ask(us, "Notice period"), null); // the rest: your answers, as before

  const plain = store.effective(store.normalize({ profile: { answers: [["sponsorship", "No"]] } }), "hirist");
  assert.equal(places.forJob(plain, us, sites.company), plain); // no list: as before
  const job = cfgJob => places.forJob(cfg, cfgJob, sites.company);
  assert.equal(job(us).run, cfg);
  assert.equal(job(us).jobCountry, "United States");
});

test("jobs abroad: skipped when they won't sponsor the visa you need, or are somewhere you can't work", () => {
  const cfg = store.effective(store.normalize({ profile: { country: "India",
    workIn: [{ country: "United States", can: "visa" }, { country: "Germany", can: "allowed" }] } }), "company");
  const skip = (where, text) => places.skipReason({ where, text }, cfg, sites.company);
  assert.equal(skip("Austin, TX", "Great team. We are unable to sponsor visas for this role."), "in United States, says no visa sponsorship");
  assert.equal(skip("Austin, TX", "Applicants must be U.S. citizens only."), "in United States, says no visa sponsorship");
  assert.equal(skip("Austin, TX", "Must be authorized to work without the need for sponsorship."), "in United States, says no visa sponsorship");
  assert.equal(skip("Austin, TX", "Visa sponsorship is available. We do not discriminate."), null);
  assert.equal(skip("Austin, TX", "Python and ML."), null);
  assert.equal(skip("Berlin, Germany", "We are unable to sponsor visas."), null); // allowed there: no visa needed
  assert.equal(skip("Bengaluru, India", "Python."), null); // where you live
  assert.equal(skip("Paris, France", "Python."), "in France, not a country you can work in");
  assert.equal(skip("Remote", "We can't sponsor."), null); // not known: not skipped
  assert.equal(places.skipReason({ where: "Paris" }, store.effective(store.normalize({}), "company"), sites.company), null); // no list
});

test("any field: a ready-made list of roles, taken out of the titles to skip", () => {
  const mine = { includeTitle: ["machine learning"], requireRole: ["engineer"], excludeTitle: ["senior", "manager", "sales", "intern", "qa"], excludeCompanies: ["Acme"] };
  const pm = filters.forField(mine, "Product and project management");
  assert.deepEqual(pm.includeTitle, []);
  assert.ok(pm.requireRole.includes("product manager"));
  assert.deepEqual(pm.excludeTitle, ["senior", "sales", "intern", "qa"]); // "manager" went
  assert.deepEqual(pm.excludeCompanies, ["Acme"]);
  assert.equal(filters.skipReason({ title: "Senior Product Manager", text: "" }, pm), "title has 'senior'");
  assert.equal(filters.skipReason({ title: "Product Manager", text: "" }, pm), null);
  assert.equal(filters.skipReason({ title: "Software Engineer", text: "" }, pm), "not one of your roles");
  assert.deepEqual(filters.forField(mine, "Sales and business development").excludeTitle, ["senior", "intern", "qa"]); // account managers too
  assert.deepEqual(filters.forField(mine, "Software and IT").excludeTitle, ["senior", "manager", "sales", "intern"]);
  for (const name of Object.keys(filters.FIELDS)) assert.ok(filters.forField({}, name).requireRole.length > 3, name);
});

test("forms' standard questions: self-identification, consent, when you can start", () => {
  const s = store.normalize({ profile: { noticePeriod: "30 days", answers: [] } });
  const a = q => answers.answerFor(q, store.effective(s, "company").answers);
  for (const q of ["Gender", "Race", "Ethnicity", "Are you Hispanic or Latino?", "Veteran Status", "Disability Status", "Please identify your race"]) {
    assert.equal(a(q), "Decline to self-identify", q);
  }
  assert.equal(a("Please describe any accommodations you need for a disability"), null); // not a self-identification
  assert.equal(a("Do you embrace challenges?"), null);
  assert.equal(a("I have read and agree to the Applicant Privacy Notice"), "Yes");
  assert.equal(a("I consent to the processing of my personal data for this application"), "Yes");
  assert.equal(a("I consent to being contacted about future opportunities and to my data being kept in the talent pool"), null);
  assert.equal(a("I agree to receive marketing emails"), null);
  assert.equal(a("Available start date"), "30 days");
  assert.equal(a("When can you start?"), "30 days");
  s.profile.selfIdentify = "ask";
  assert.equal(a("Gender"), null);
  assert.equal(answers.answerFor("Gender", store.effective(store.normalize({ profile: { answers: [["gender", "Female"]] } }), "company").answers), "Female"); // yours first

  // a declining answer picks the form's own way of declining
  assert.equal(answers.pick(["Male", "Female", "Decline To Self Identify"], "Decline to self-identify"), 2);
  assert.equal(answers.pick(["Yes", "No", "I don't wish to answer"], "Decline to self-identify"), 2);
  assert.equal(answers.pick(["Man", "Woman", "Prefer not to say"], "Decline to self-identify"), 2);
  assert.equal(answers.pick(["Yes", "No"], "Decline to self-identify"), null); // none: asked

  const today = new Date(2026, 9, 31);
  assert.equal(answers.dateAnswer("30 days", "iso", today), "2026-11-30");
  assert.equal(answers.dateAnswer("Immediately", "MM/DD/YYYY", today), "10/31/2026");
  assert.equal(answers.dateAnswer("2 weeks", "dd.mm.yyyy", today), "14.11.2026");
  assert.equal(answers.dateAnswer("2027-01-15", "DD/MM/YYYY", today), "15/01/2027");
  assert.equal(answers.dateAnswer("15-30 days", "iso", today), null); // a range: no one date
  assert.equal(answers.dateAnswer("30 days", "Your answer", today), null);
});
