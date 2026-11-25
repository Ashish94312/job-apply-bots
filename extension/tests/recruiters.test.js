const test = require('node:test');
const assert = require('node:assert/strict');

const data = {};
globalThis.JB = {};
globalThis.chrome = { storage: { local: {
  get: async key => ({ [key]: structuredClone(data[key]) }),
  set: async values => Object.assign(data, structuredClone(values)),
} } };
for (const file of ['../lib/filters.js', '../lib/store.js', '../lib/roles.js', '../referral.js', '../recruiters.js']) require(file);
JB.sites = { linkedin: { jobUrlRe: /linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/, jobReadyCss: 'h1' } };
const { store, roles } = JB;
const BASE = 'https://www.linkedin.com';

const reset = () => { for (const k of Object.keys(data)) delete data[k]; };
const job = (id, extra = {}) => ({ jobId: String(id), url: `${BASE}/jobs/view/${id}/`, title: 'Backend Engineer', company: 'Razorpay', ...extra });

// ---------------------------------------------------------------- the store keeps the two kinds apart

test('a recruiter invite is never followed up as a referral, and the other way round', async () => {
  reset();
  await store.saveContact({ profile: `${BASE}/in/rec/`, name: 'Rec' }, job(1), `${BASE}/company/razorpay/`, 'invited', '', 'recruiter');
  await store.saveContact({ profile: `${BASE}/in/ref/`, name: 'Ref' }, job(1), `${BASE}/company/razorpay/`, 'invited');
  assert.deepEqual((await store.pendingInvites('referral')).map(c => c.name), ['Ref']);
  assert.deepEqual((await store.pendingInvites('recruiter')).map(c => c.name), ['Rec']);
  assert.deepEqual((await store.pendingInvites()).map(c => c.name), ['Ref']); // the default stays referrals
});

test('contacts saved before recruiters came count as referrals', async () => {
  reset();
  data.contacts = { [`${BASE}/in/old/`]: { profile: `${BASE}/in/old/`, name: 'Old', status: 'invited', companyUrl: 'c', ts: '2026-11-01 10:00:00' } };
  assert.equal((await store.pendingInvites('referral')).length, 1);
  assert.equal((await store.pendingInvites('recruiter')).length, 0);
  assert.equal(await store.askedAt('c', 'referral'), 1);
  assert.equal(await store.askedAt('c', 'recruiter'), 0);
});

test('people per company are counted per kind; the daily count and who was contacted are shared', async () => {
  reset();
  const c = `${BASE}/company/razorpay/`;
  await store.saveContact({ profile: `${BASE}/in/a/`, name: 'A' }, job(1), c, 'messaged');
  await store.saveContact({ profile: `${BASE}/in/b/`, name: 'B' }, job(1), c, 'messaged');
  await store.saveContact({ profile: `${BASE}/in/r/`, name: 'R' }, job(1), c, 'invited', '', 'recruiter');
  assert.equal(await store.askedAt(c, 'referral'), 2);
  assert.equal(await store.askedAt(c, 'recruiter'), 1);
  assert.equal(await store.sentToday(), 3);
  assert.equal(await store.knownContact(`${BASE}/in/a/`), true); // a recruiter run won't write to a referral contact
});

test('each kind goes through the jobs on its own', async () => {
  reset();
  await store.record('linkedin', job(7), 'applied');
  await store.jobDone(job(7), 'asked'); // asked for a referral about it
  assert.equal(await store.askedAbout('7'), true);
  assert.equal(await store.askedAbout('7', 'recruiter'), false);
  assert.deepEqual(await store.jobsToAsk('linkedin', ['applied'], 14), []);
  assert.deepEqual((await store.jobsToAsk('linkedin', ['applied'], 14, 'recruiter')).map(j => j.jobId), ['7']);
  await store.jobDone(job(7), 'asked', '', 'recruiter');
  assert.deepEqual(await store.jobsToAsk('linkedin', ['applied'], 14, 'recruiter'), []);
  assert.throws(() => store.saveContact({ profile: 'x' }, job(1), 'c', 'messaged', '', 'friend'), /Unknown contact kind/);
});

// ---------------------------------------------------------------- who is a recruiter

test('headlines: recruiters at the company, not agencies or people who left', () => {
  const cases = [
    ['Technical Recruiter at Razorpay', 'Razorpay', 'recruiter', 0.9],
    ['Talent Acquisition | Hiring for Engineering', 'Razorpay', 'recruiter', 0.7],
    ['HR Business Partner', 'Swiggy', 'recruiter', 0.7],
    ['Finding rockstars 🚀 TA Lead', 'Swiggy', 'recruiter', 0.7],
    ['Talent Acquisition Consultant at Google', 'Google LLC', 'recruiter', 0.9],
    ['Recruiter @ Razorpay!', 'Razorpay Software Private Limited', 'recruiter', 0.9],
    ['Ex-Amazon | Recruiter at Microsoft', 'Microsoft', 'recruiter', 0.9],
    ['Senior Recruiter | Hiring for top MNCs', 'Razorpay', 'agency', 0],
    ['Recruitment Consultant at ABC Staffing', 'Razorpay', 'agency', 0],
    ['Freelance technical recruiter', 'Razorpay', 'agency', 0],
    ['Ex-Microsoft | Recruiter at Amazon', 'Microsoft', 'former', 0],
    ['Former Recruiter at Flipkart', 'Flipkart', 'former', 0],
    ['Ex-HR, now Product Manager', 'Swiggy', 'other', 0.1],
    ['Engineering Manager, Payments @ Razorpay | Hiring!', 'Razorpay', 'manager', 0.6],
    ['EM - Platform', 'Razorpay', 'manager', 0.6],
    ['SDE-2 @ Swiggy | We are hiring', 'Swiggy', 'hiring', 0.5],
    ['Software Engineer at Swiggy', 'Swiggy', 'other', 0.1],
    ['Data analyst, Tamil Nadu', 'Swiggy', 'other', 0.1], // "ta" inside words isn't TA
    ['Shravan | Photographer', 'Swiggy', 'other', 0.1], // nor "hr"
  ];
  for (const [headline, company, role, score] of cases) {
    const got = roles.classify(headline, company);
    assert.deepEqual([got.role, got.score], [role, score], headline);
  }
});

test('the job poster comes first; a latest job elsewhere rules anyone out', () => {
  assert.equal(roles.classify('Data Analyst', 'Swiggy', { isPoster: true }).score, 1);
  assert.equal(roles.classify('Recruiter', 'Swiggy', { current: 'Recruiter Zomato · Full-time Jan 2024 - Present' }).role, 'former');
  assert.equal(roles.classify('Recruiter', 'Swiggy', { current: 'Talent Acquisition Swiggy · Full-time' }).role, 'recruiter');
});

test('company names match on the part that tells them apart', () => {
  assert.equal(roles.companyKey('Razorpay Software Pvt Ltd'), 'razorpay');
  assert.equal(roles.companyKey('Tech Solutions'), 'tech solutions');
  assert.equal(roles.mentions('Recruiter at Zomato', 'Zomato Ltd'), true);
  assert.equal(roles.mentions('Recruiter at Zomatoes', 'Zomato'), false);
  assert.equal(roles.mentions('Recruiter at Nestlé', 'Nestle India'), true);
});

// ---------------------------------------------------------------- a run, on a pretend LinkedIn

/** A run against pages described by `pages`: url -> what the site.* calls return there. */
function fakeRun(pages, { dry = true, answers = [] } = {}) {
  let url = '';
  const r = {
    dry, opts: {}, logs: [], events: [], visited: [],
    log: (line = '') => r.logs.push(line),
    step() {},
    event: e => r.events.push(e),
    isStop: () => false,
    sleep: async () => {},
    goto: async u => { url = u; r.visited.push(u); },
    waitFor: async () => true,
    waitForTrue: async name => !!(await r.exec(name)),
    ask: async () => answers.shift() || 'n',
    exec: async (name, ...args) => {
      const page = Object.entries(pages).find(([prefix]) => url.startsWith(prefix));
      const value = page && page[1][name.replace(/^site\./, '')];
      return typeof value === 'function' ? value(...args) : value;
    },
  };
  return r;
}

const profilePage = (name, company, degree = '2nd', current = `Talent Acquisition ${company} · Full-time`) => ({
  profileReady: true, profileInfo: { slug: '', name, main: `${name} recruiter ${company}`, degree, current },
});

const cfg = () => ({
  outreachPerDay: 30,
  recruiter: {
    message: 'Hi {first_name}, I applied for {title} at {company}.', connectNote: 'Hi {first_name}, I applied at {company}.',
    targets: ['poster', 'recruiter'], perCompany: 1, maxPerRun: 5, withinDays: 14, forJobs: ['applied'], skipHeadline: ['intern'],
  },
});

test('a dry run writes to the job poster when the job has one', async () => {
  reset();
  await store.record('linkedin', job(1), 'applied');
  const r = fakeRun({
    [`${BASE}/jobs/view/1/`]: {
      readJob: { title: 'Backend Engineer', company: 'Razorpay' }, companyUrl: `${BASE}/company/razorpay/`, hasHiringTeam: true,
      hiringTeam: [{ slug: 'poster', name: 'Priya Sharma', headline: 'Engineering at Razorpay', degree: '2nd', isPoster: true }],
    },
    [`${BASE}/in/poster/`]: profilePage('Priya Sharma', 'Razorpay', '2nd', 'Engineering Manager Razorpay'),
  });
  await JB.recruiters.run(r, cfg());
  assert.deepEqual(r.events.map(e => [e.name, e.status, e.for]), [['Priya Sharma', 'would_invite', 'recruiter']]);
  assert.ok(!r.visited.some(u => u.includes('/search/')), 'no people search when the poster is there');
  assert.ok(r.logs.some(l => /would invite Priya Sharma/.test(l)));
  assert.deepEqual(data.recruiterJobs || {}, {}, 'a dry run records nothing');
});

test('without a poster it searches recruiters (3rd-degree too) and skips agencies, interns and people contacted before', async () => {
  reset();
  await store.record('linkedin', job(2, { company: 'Swiggy' }), 'applied');
  await store.saveContact({ profile: `${BASE}/in/known/`, name: 'Known' }, job(9), 'x', 'messaged'); // asked for a referral once
  const results = [
    { slug: 'agency', name: 'Agency Person', headline: 'Recruiter | Hiring for top MNCs', degree: '1st' },
    { slug: 'known', name: 'Known', headline: 'Recruiter at Swiggy', degree: '1st' },
    { slug: 'intern', name: 'Intern Person', headline: 'HR intern at Swiggy', degree: '1st' },
    { slug: 'ta', name: 'Asha Rao', headline: 'Talent Acquisition', degree: '3rd' },
    { slug: 'rec', name: 'Ravi Kumar', headline: 'Technical Recruiter at Swiggy', degree: '2nd' },
  ];
  const r = fakeRun({
    [`${BASE}/jobs/view/2/`]: { readJob: { title: 'SDE', company: 'Swiggy' }, companyUrl: `${BASE}/company/swiggy/`, hasHiringTeam: false },
    [`${BASE}/company/swiggy/`]: { hasCompanyIds: true, companyIds: ['123'] },
    [`${BASE}/search/results/people/`]: { peopleReady: true, searchLimit: false, people: results },
    [`${BASE}/in/rec/`]: profilePage('Ravi Kumar', 'Swiggy'),
    [`${BASE}/in/ta/`]: profilePage('Asha Rao', 'Swiggy', '3rd'),
  });
  await JB.recruiters.run(r, cfg());
  const search = r.visited.find(u => u.includes('/search/results/people/'));
  assert.match(decodeURIComponent(search), /"F","S","O"/);
  assert.deepEqual(r.events.map(e => e.name), ['Ravi Kumar'], 'the best one: a recruiter who names the company');
});

test('a recruiter whose latest job is elsewhere is skipped on their profile', async () => {
  reset();
  await store.record('linkedin', job(3, { company: 'Swiggy' }), 'applied');
  const r = fakeRun({
    [`${BASE}/jobs/view/3/`]: {
      readJob: { title: 'SDE', company: 'Swiggy' }, companyUrl: null, hasHiringTeam: true,
      hiringTeam: [{ slug: 'moved', name: 'Moved On', headline: 'Recruiter at Swiggy', degree: '1st', isPoster: false }],
    },
    [`${BASE}/in/moved/`]: profilePage('Moved On', 'Swiggy', '1st', 'Recruiter Zomato · Full-time'),
  });
  await JB.recruiters.run(r, cfg());
  assert.deepEqual(r.events, []);
  assert.ok(r.logs.some(l => /latest job isn't at Swiggy/.test(l)));
});

test('sending: the message to a connection is saved as a recruiter contact, and the job as done', async () => {
  reset();
  await store.record('linkedin', job(4), 'applied');
  const sent = [];
  const r = fakeRun({
    [`${BASE}/jobs/view/4/`]: {
      readJob: { title: 'Backend Engineer', company: 'Razorpay' }, companyUrl: `${BASE}/company/razorpay/`, hasHiringTeam: true,
      hiringTeam: [{ slug: 'p', name: 'Neha Gupta', headline: 'Recruiter at Razorpay', degree: '1st', isPoster: true }],
    },
    [`${BASE}/in/p/`]: {
      ...profilePage('Neha Gupta', 'Razorpay', '1st'),
      openMessage: true, messageBoxReady: true, typeMessage: text => sent.push(text), sendMessageNow: true, messageBoxEmpty: true, closeChat: true,
    },
  }, { dry: false, answers: ['y'] });
  await JB.recruiters.run(r, cfg());
  assert.deepEqual(sent, ['Hi Neha, I applied for Backend Engineer at Razorpay.']);
  const c = data.contacts[`${BASE}/in/p/`];
  assert.deepEqual([c.kind, c.status], ['recruiter', 'messaged']);
  assert.equal(data.recruiterJobs['4'].status, 'asked');
  assert.equal(data.referralJobs, undefined, 'referrals still have this job to ask about');
});

test('the daily limit is shared with referrals', async () => {
  reset();
  for (let i = 0; i < 30; i++) await store.saveContact({ profile: `${BASE}/in/p${i}/`, name: `P${i}` }, job(1), 'c', 'messaged');
  await store.record('linkedin', job(5), 'applied');
  const r = fakeRun({}, { dry: false });
  await JB.recruiters.run(r, cfg());
  assert.ok(r.logs.some(l => /Daily limit reached \(30 messages \+ invites, referrals and recruiters together\)/.test(l)));
  assert.deepEqual(r.visited, []);
});

test('it waits for your own words in the message before sending', async () => {
  reset();
  const r = fakeRun({}, { dry: false });
  await JB.recruiters.run(r, { recruiter: { ...cfg().recruiter, message: 'Hi {first_name}\n<one or two lines about you>' } });
  assert.match(r.logs.join('\n'), /still has a <\.\.\.> placeholder/);
});
