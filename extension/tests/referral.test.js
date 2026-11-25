const test = require('node:test');
const assert = require('node:assert/strict');

const data = {};
globalThis.JB = {};
globalThis.chrome = { storage: { local: {
  get: async key => ({ [key]: structuredClone(data[key]) }),
  set: async values => Object.assign(data, structuredClone(values)),
} } };
require('../lib/store.js');
const store = JB.store;
require('../referral.js');

test('referral discovery failures and skipped recipients remain eligible on the next run', async () => {
  data.jobs = {};
  data.referralJobs = {};
  for (const [i, status] of ['no_employee_list', 'nobody_found', 'nobody_reached'].entries()) {
    const job = { jobId: String(i), url: `https://www.linkedin.com/jobs/view/${i}/`, title: 'Engineer', company: 'Acme' };
    await store.record('linkedin', job, 'applied');
    await store.jobDone(job, status);
    assert.equal(await store.askedAbout(job.jobId), false, status);
  }
  assert.equal((await store.jobsToAsk('linkedin', ['applied'], 14)).length, 3);
});

test('successful and legacy completed referrals remain excluded', async () => {
  data.jobs = {};
  data.referralJobs = {};
  for (const [i, status] of ['asked', 'already_asked', undefined].entries()) {
    const job = { jobId: String(i), url: `https://www.linkedin.com/jobs/view/${i}/` };
    await store.record('linkedin', job, 'applied');
    await store.jobDone(job, status);
    assert.equal(await store.askedAbout(job.jobId), true);
  }
  assert.deepEqual(await store.jobsToAsk('linkedin', ['applied'], 14), []);
});

test('missing Send controls can be retried without retrying sent or uncertain invitations', async () => {
  const profile = 'https://www.linkedin.com/in/example/';
  for (const [status, note, known] of [
    ['failed', 'no Send button in the invite dialog', false],
    ['failed', 'no Send button in the invite dialog; visible dialog buttons: Close', false],
    ['failed', "couldn't confirm the invite was sent", true],
    ['invited', 'with a note', true],
    ['messaged', '', true],
  ]) {
    data.contacts = { [profile]: { status, note } };
    assert.equal(await store.knownContact(profile), known, `${status}: ${note}`);
  }
});

test('Connect that sends directly is confirmed without looking for another Send button', async () => {
  data.jobs = {};
  data.contacts = {};
  data.referralJobs = {};
  const job = { jobId: '42', url: 'https://www.linkedin.com/jobs/view/42/', title: 'Engineer', company: 'Acme' };
  await store.record('linkedin', job, 'applied');
  JB.sites = { linkedin: { jobReadyCss: 'h1' } };
  let pending = false;
  const run = {
    dry: false, opts: { max: 1 },
    log() {}, step() {}, event() {}, goto: async () => {}, sleep: async () => {},
    waitFor: async () => true, waitForTrue: async () => true, isStop: () => false,
    exec: async name => {
      if (name === 'site.openInvite') { pending = true; return true; }
      if (name === 'site.inviteSent') return pending;
      if (['site.addNote', 'site.sendInvite'].includes(name)) throw new Error('Already sent: must not send twice');
      return ({
        'site.readJob': job, 'site.companyUrl': 'https://www.linkedin.com/company/acme/',
        'site.companyIds': ['123'], 'site.searchLimit': false, 'site.inviteLimit': false,
        'site.people': [{ slug: 'example', name: 'Example', degree: '2nd', headline: 'Engineer at Acme' }],
        'site.profileInfo': { slug: 'example', name: 'Example', degree: '2nd', main: 'Engineer at Acme' },
      })[name];
    },
  };
  await JB.referral.run(run, { referral: { message: 'Hi {first_name}, would you refer me?', connectNote: 'Please connect', sendMode: 'direct' } });
  assert.equal(data.contacts['https://www.linkedin.com/in/example/']?.status, 'invited');
});
