// Unit tests for the extension's plain logic:  node --test extension/tests/
// cases.json holds what the Python bots answer for the same inputs (make_cases.py), so the port stays faithful.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

globalThis.JB = {};
globalThis.chrome = { storage: { local: {} } }; // store.js only touches it when called
for (const file of ["referral.js", "lib/defaults.js", "lib/filters.js", "lib/answers.js", "lib/store.js", "sites/hirist.js", "sites/instahyre.js", "sites/wellfound.js", "sites/cutshort.js", "sites/linkedin.js", "sites/naukri.js"]) {
  require(path.join(__dirname, "..", file));
}
const cases = require("./cases.json");
const { filters, answers, store, sites } = JB;
const hirist = sites.hirist;

test("skipReason matches the Python bots", () => {
  for (const c of cases.skipReason) {
    assert.equal(filters.skipReason(c, cases.filters), c.expected, `${c.title} / ${c.company} / ${c.text}`);
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

  assert.deepEqual(store.effective(s, "hirist").answers, s.profile.answers); // no answers of its own: the shared ones
  s.sites.hirist.answers = [["notice", "15 days"]];
  const cfg = store.effective(s, "hirist");
  assert.deepEqual(cfg.answers, [["notice", "15 days"]]); // its own replace the shared ones
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
