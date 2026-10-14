// Unit tests for the extension's plain logic:  node --test extension/tests/
// cases.json holds what the Python bots answer for the same inputs (make_cases.py), so the port stays faithful.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

globalThis.JB = {};
globalThis.chrome = { storage: { local: {} } }; // store.js only touches it when called
for (const file of ["lib/defaults.js", "lib/filters.js", "lib/answers.js", "lib/store.js", "sites/hirist.js", "sites/instahyre.js", "sites/wellfound.js"]) {
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

  s.sites.hirist.answers = [["notice", "15 days"]];
  const cfg = store.effective(s, "hirist");
  assert.equal(cfg.answers[0][1], "15 days");
  assert.equal(cfg.answers.length, s.profile.answers.length + 1);
  assert.equal(cfg.coverNote, "Hi");
  assert.deepEqual(cfg.keywords, s.sites.hirist.keywords);
  assert.equal(store.normalize(undefined).savedAt, null);
});

test("Instahyre and Wellfound search pages match the Python bots", () => {
  for (const c of cases.siteUrls) assert.deepEqual(sites[c.site].searchUrls(c.cfg), c.expected, `${c.site} ${JSON.stringify(c.cfg)}`);
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
