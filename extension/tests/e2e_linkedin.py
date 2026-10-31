#!/usr/bin/env python3
"""End-to-end test for LinkedIn: the extension in a real Chromium, Easy Applying on a fake LinkedIn (React dialog).

  .venv/bin/python extension/tests/e2e_linkedin.py            # headless
  .venv/bin/python extension/tests/e2e_linkedin.py --headed   # watch it

Same setup as e2e.py (Playwright's Chromium, React fetched once into tests/.cache).
"""
import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.request
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

from urllib.parse import quote

from e2e import CACHE, EXT, REACT
from e2e_sites import REACT_TAGS, Check, fake, page, redirect

LEVER_JOB = "6ed76ce8-4156-4b60-b120-403538bd66cd"  # where the job that applies on its company's site leads

JOBS = {  # id: (title, company, kind)
    "400006": ("Senior ML Engineer", "Bigcorp", "easy"),
    "400001": ("ML Engineer", "Acme", "easy"),
    "400002": ("AI Engineer", "Outside Co", "external"),
    "400003": ("Data Scientist", "Gone Co", "closed"),
    "400004": ("Backend Engineer", "Nightly", "night"),
    "400005": ("Python Developer", "Done Co", "applied"),
    "400007": ("Software Engineer", "Limit Co", "limit"),
    "400008": ("Machine Learning Engineer", "After Co", "easy"),
}

# The Easy Apply dialog: contact info, questions, review; LinkedIn checks each step before moving on.
EASY_APPLY_JS = r"""
const e = React.createElement;
function EasyApply({ jobId, company, kind }) {
  const [step, setStep] = React.useState(kind === 'limit' ? -1 : 0);
  const [v, setV] = React.useState({ cc: 'Andorra (+376)', phone: '', email: 'me@example.com', years: '', commute: '', notice: '', follow: true, night: '' });
  const [error, setError] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const set = k => ev => setV({ ...v, [k]: ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value });
  if (sent) return e('div', { role: 'dialog', className: 'jobs-easy-apply-modal' },
    e('h2', null, `Your application was sent to ${company}`),
    e('button', { onClick: () => { document.getElementById('modal').remove(); document.getElementById('state').textContent = 'Applied 1 minute ago'; } }, 'Done'));
  const label = (id, text) => e('label', { htmlFor: id }, text);
  const steps = [
    [label('cc', 'Phone country code'), e('select', { id: 'cc', required: true, value: v.cc, onChange: set('cc') },
        ...['Select an option', 'Andorra (+376)', 'India (+91)'].map(o => e('option', { key: o, value: o }, o))),
     label('phone-numeric', 'Mobile phone number'), e('input', { id: 'phone-numeric', required: true, value: v.phone, onChange: set('phone') }),
     label('email', 'Email address'), e('select', { id: 'email', value: v.email, onChange: set('email') },
        ...['Select an option', 'me@example.com'].map(o => e('option', { key: o, value: o }, o)))],
    kind === 'night'
      ? [e('fieldset', { 'aria-required': 'true' }, e('legend', null, 'Are you willing to work night shifts? *'),
          ...['Yes', 'No'].map(o => e('span', { key: o }, e('input', { type: 'radio', id: 'n' + o, name: 'night', value: o, checked: v.night === o, onChange: set('night') }), label('n' + o, o))))]
      : [label('years-numeric', 'How many years of work experience do you have with Python?'),
         e('input', { id: 'years-numeric', required: true, value: v.years, onChange: set('years') }),
         e('fieldset', null, e('legend', null, "Are you comfortable commuting to this job's location? *"),
           ...['Yes', 'No'].map(o => e('span', { key: o }, e('input', { type: 'radio', id: 'c' + o, name: 'commute', value: o, checked: v.commute === o, onChange: set('commute') }), label('c' + o, o)))),
         label('notice', 'Notice period (in days)'),
         e('input', { id: 'notice', required: true, value: v.notice, onChange: set('notice'), 'aria-describedby': 'notice-error', 'aria-invalid': error ? 'true' : 'false' }),
         e('p', { id: 'notice-error' }, error),
         e('input', { type: 'checkbox', id: 'follow', checked: v.follow, onChange: set('follow') }),
         label('follow', `Follow ${company} to stay up to date with their page.`)],
    [e('h3', null, 'Review your application'), e('p', null, `Phone ${v.phone}, ${v.years} years of Python.`)],
  ];
  const next = () => {
    if (step === 1 && !/^\d+$/.test(v.notice)) { setError('Enter a whole number between 0 and 365'); return; }
    setError('');
    setStep(step + 1);
  };
  const submit = () => fetch('/api/apply/' + jobId, { method: 'POST', body: JSON.stringify(v) }).then(() => setSent(true));
  return e('div', { role: 'dialog', className: 'jobs-easy-apply-modal', 'aria-modal': 'true' },
    e('h2', null, `Apply to ${company}`),
    step === -1 ? e('p', null, "You've reached the Easy Apply application limit for today. Save this job and come back tomorrow.") : steps[step],
    step === 2 ? e('button', { onClick: submit }, 'Submit application') : step >= 0 ? e('button', { onClick: next }, step === 1 ? 'Review' : 'Next') : null);
}
const b = document.getElementById('easy');
if (b) b.addEventListener('click', () => {
  const host = document.body.appendChild(document.createElement('div'));
  host.id = 'modal';
  ReactDOM.createRoot(host).render(e(EasyApply, { jobId: b.dataset.id, company: b.dataset.company, kind: b.dataset.kind }));
});
"""


PEOPLE = {  # slug: (name, degree, headline, connect under "More")
    "priya-sharma": ("Priya Sharma", "1st", "Software Engineer at Acme", False),
    "rahul-verma": ("Rahul Verma", "2nd", "Machine Learning Engineer at Acme", True),
    "ivan-intern": ("Ivan Petrov", "2nd", "Software Engineer Intern at Acme", False),
    "far-away": ("Far Away", "3rd", "Engineer at Acme", False),
}

# A profile's header buttons: Message for connections; Connect (maybe under More) with LinkedIn's invite dialog.
PROFILE_JS = r"""
const slug = document.body.dataset.slug;
const post = (what, data) => fetch(`/api/${what}/${slug}`, { method: 'POST', body: JSON.stringify(data) });
const card = document.querySelector('main section');
function chat() {
  const box = document.body.appendChild(document.createElement('div'));
  box.innerHTML = '<div class="msg-form__contenteditable" contenteditable="true" role="textbox"></div><button class="send">Send</button>' +
    `<button class="close">Close your conversation with ${document.body.dataset.name}</button>`;
  box.querySelector('.send').onclick = () => { const ed = box.querySelector('[contenteditable]'); post('message', { text: ed.innerText }); ed.innerHTML = ''; };
  box.querySelector('.close').onclick = () => box.remove();
}
function invite() {
  const d = document.body.appendChild(document.createElement('div'));
  d.setAttribute('role', 'dialog');
  d.innerHTML = '<p>Add a note to your invitation?</p><button class="note">Add a note</button><button class="plain">Send without a note</button><button aria-label="Dismiss">×</button>';
  const sent = note => post('invite', { note }).then(() => { d.remove(); card.querySelector('.connect, .more')?.remove(); card.insertAdjacentHTML('beforeend', '<button>Pending</button><p>Invitation sent</p>'); });
  d.querySelector('.plain').onclick = () => sent('');
  d.querySelector('[aria-label=Dismiss]').onclick = () => d.remove();
  d.querySelector('.note').onclick = () => {
    d.innerHTML = '<textarea maxlength="300"></textarea><button class="send">Send</button>';
    d.querySelector('.send').onclick = () => sent(d.querySelector('textarea').value);
  };
}
card.querySelector('.message')?.addEventListener('click', chat);
card.querySelector('.connect')?.addEventListener('click', invite);
card.querySelector('.more')?.addEventListener('click', () => {
  const menu = card.appendChild(document.createElement('div'));
  menu.innerHTML = `<div role="menuitem" aria-label="Invite ${document.body.dataset.name} to connect">Connect</div>`;
  menu.firstChild.onclick = () => { menu.remove(); invite(); };
});
"""


class LinkedIn:
    def __init__(self):
        self.logged_in = False
        self.applied = {"400005"}
        self.posted = {}
        self.messages = {}
        self.invites = {}
        self.accepted = set()
        self.searches = []

    def handle(self, route):
        req = route.request
        parts = urlsplit(req.url)
        path = parts.path
        if path.startswith("/static/"):
            return route.fulfill(path=str(CACHE / path.split("/")[-1]), content_type="text/javascript")
        if path.startswith("/api/apply/"):
            jid = path.rsplit("/", 1)[1]
            self.applied.add(jid)
            self.posted[jid] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        if path.startswith("/api/message/") or path.startswith("/api/invite/"):
            kind, slug = path.split("/")[2:4]
            (self.messages if kind == "message" else self.invites)[slug] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        if path.startswith("/company/acme"):
            link = '<a href="/search/results/people/?currentCompany=%5B%221234%22%5D&origin=COMPANY_PAGE_CANNED_SEARCH">See all 50 employees</a>'
            return route.fulfill(body=page("Acme | LinkedIn", f"<main><h1>Acme</h1>{link}</main>"), content_type="text/html")
        if path.startswith("/search/results/people"):
            self.searches.append(parse_qs(parts.query))
            rows = "".join(f'<li data-view-name="people-search-result"><div><a href="/in/{s}/">{n}</a></div><div>• {d if s not in self.accepted else "1st"}</div>'
                           f'<p>{h}</p><button>{"Message" if d == "1st" else "Connect"}</button></li>' for s, (n, d, h, _) in PEOPLE.items())
            return route.fulfill(body=page("Search | LinkedIn", f"<main><ul>{rows}</ul></main>"), content_type="text/html")
        m = re.match(r"^/in/([^/]+)", path)
        if m and m.group(1) in PEOPLE:
            slug = m.group(1)
            name, degree, headline, under_more = PEOPLE[slug]
            degree = "1st" if slug in self.accepted else degree
            if degree == "1st":
                buttons = '<button class="message">Message</button>'
            elif slug in self.invites:
                buttons = "<button>Pending</button>"
            else:
                buttons = '<button class="more">More</button>' if under_more else f'<button class="connect" aria-label="Invite {name} to connect">Connect</button>'
            body = (f'<main><section><h1>{name}</h1><p>{headline}</p><div>· {degree}</div><div class="actions">{buttons}</div></section>'
                    f'<section><h2>Experience</h2><p>Engineer, Acme, 2022 - present</p></section></main>')
            html = page(f"{name} | LinkedIn", body, f"<script>{PROFILE_JS}</script>").replace("<body>", f'<body data-slug="{slug}" data-name="{name}">')
            return route.fulfill(body=html, content_type="text/html")
        if path.startswith("/mynetwork/invite-connect/connections"):
            links = "".join(f'<a href="/in/{s}/">{PEOPLE[s][0]}</a>' for s in sorted(self.accepted)) or '<a href="/in/someone-else/">Someone</a>'
            return route.fulfill(body=page("Connections | LinkedIn", f"<main>{links}</main>"), content_type="text/html")
        if path.startswith("/feed"):
            if not self.logged_in:
                return redirect(route, "https://www.linkedin.com/login")
            return route.fulfill(body=page("Feed | LinkedIn", "<h1>Your feed</h1>"), content_type="text/html")
        if path.startswith("/login"):
            return route.fulfill(body=page("LinkedIn Login", "<h1>Sign in</h1>"), content_type="text/html")
        if path.startswith("/jobs/search"):
            q = parse_qs(parts.query)
            if q.get("keywords") == ["nomatch"]:
                return route.fulfill(body=page("Jobs | LinkedIn", "<main><h2>No matching jobs found.</h2></main>"), content_type="text/html")
            # A card fills in only once it scrolls into view, as on LinkedIn.
            cards = "".join(f'<li data-occludable-job-id="{j}" data-text="{t} {c} Bengaluru, Karnataka, India Easy Apply" style="height:400px"></li>'
                            for j, (t, c, _) in JOBS.items())
            script = """<script>window.io = new IntersectionObserver(es => es.forEach(x => { if (x.isIntersecting && !x.target.innerHTML)
              x.target.innerHTML = '<a href="/jobs/view/' + x.target.dataset.occludableJobId + '/">' + x.target.dataset.text + '</a>'; }));
              document.querySelectorAll('li').forEach(li => window.io.observe(li));</script>"""
            return route.fulfill(body=page("Machine Learning Engineer Jobs | LinkedIn", f"<main><ul>{cards}</ul></main>", script), content_type="text/html")
        m = re.match(r"^/jobs/view/(\d+)", path)
        if m and m.group(1) in JOBS:
            jid = m.group(1)
            title, company, kind = JOBS[jid]
            about = f"<h2>About the job</h2><p>We need {title}s with 1+ years of experience in Python and ML. Great team, hybrid in Bengaluru.</p>"
            if jid in self.applied:
                action = '<p id="state">Applied 3 days ago</p><button>See application</button>'
            elif kind == "external":  # a reminder first, then the company's site in a new tab, through LinkedIn's redirect
                to = "https://www.linkedin.com/jobs/view/externalApply/400002?url=" + quote(f"https://jobs.lever.co/outside/{LEVER_JOB}", safe="")
                action = ('<button aria-label="Apply to AI Engineer on company website" onclick="document.getElementById(\'safety\').hidden = false">Apply</button>'
                          '<div id="safety" role="dialog" hidden><h2>Job search safety reminder</h2>'
                          f'<button onclick="window.open(\'{to}&amp;urlHash=x\', \'_blank\')">Continue applying</button></div>')
            elif kind == "closed":
                action = "<p>No longer accepting applications</p>"
            else:
                action = (f'<p id="state"></p><button id="easy" aria-label="Easy Apply to {title} at {company}" data-id="{jid}" '
                          f'data-company="{company}" data-kind="{kind}">Easy Apply</button>')
            similar = '<aside><a href="/jobs/view/999/">Other job · Easy Apply</a></aside>'
            company_link = f'<a href="/company/{company.lower()}/">{company}</a>' if kind != "external" else company
            body = f"<main><h1>{title}</h1><div>{company_link}</div>{action}<section>{about}</section>{similar}</main>"
            return route.fulfill(body=page(f"{title} | {company} | LinkedIn", body, f"{REACT_TAGS}<script>{EASY_APPLY_JS}</script>"), content_type="text/html")
        route.fulfill(status=404, body="not found")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    CACHE.mkdir(exist_ok=True)
    for name, url in REACT.items():
        if not (CACHE / name).exists():
            urllib.request.urlretrieve(url, CACHE / name)

    li = LinkedIn()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=not args.headed,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        ctx.route(re.compile(r"^https://(www\.)?linkedin\.com/"), fake(li.handle))
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        dash = ctx.new_page()
        dash.goto(f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html")
        dash.on("dialog", lambda d: d.accept())
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector("#site-name")
        check = Check(dash)
        dash.evaluate("""async () => {
            const s = await JB.store.getSettings();
            const before = structuredClone(s);
            Object.assign(s.profile, { country: "India", city: "Bengaluru", currency: "INR", noticePeriod: "30 days" });
            JB.places.apply(before, s); // Settings > Where you are, saved: its country code and notice period
            const li = s.sites.linkedin;
            Object.assign(li, { keywords: ["machine learning engineer", "nomatch"], locations: ["India"], searchUrls: [], followCompanies: false });
            Object.assign(li.limits, { delaySeconds: [0, 0], maxPages: 2 });
            li.answers = li.answers.map(([p, a]) => [p, /^phone/.test(p) ? "9876543210" : a]);
            await JB.store.saveSettings(s);
        }""")

        print("\nLinkedIn: dry run needs a login")
        check.start("linkedin", "dry-run")
        check.wait_prompt("Log in, then continue")
        li.logged_in = True
        check.answer("Done, continue")
        s = check.wait_done("linkedin")
        log = "\n".join(s["log"])
        check("8 jobs listed, 8 new and matching" in log, "cards filled in by scrolling each into view")
        check(check.status("linkedin", "400006") == "skipped" and "senior" in check.note("linkedin", "400006"), "Senior title skipped")
        check(len(re.findall(r"~ would apply", log)) == 7, "would apply to the other 7")
        check("keywords=nomatch" in log and log.count("No more jobs for this search.") >= 2, "an empty search moves on")

        print("\nLinkedIn: Easy Apply")
        dash.evaluate("async () => { await chrome.storage.local.set({ jobs: {} }); }")
        check.start("linkedin", "apply")
        s = check.wait_done("linkedin")
        log = "\n".join(s["log"])
        got = li.posted.get("400001", {})
        check(check.status("linkedin", "400001") == "applied", "applied through all three steps")
        check(got.get("cc") == "India (+91)" and got.get("phone") == "9876543210", f"country code changed from Andorra; phone filled ({got})")
        check(got.get("years") == "2", "years with Python from the skill years")
        check(got.get("commute") == "Yes", "commute question answered")
        check(got.get("notice") == "30", "notice period rewritten as a number after LinkedIn rejected \"30 days\"")
        check(got.get("follow") is False, "\"Follow the company\" unticked")
        check(check.status("linkedin", "400002") == "external", "a job that applies on the company site is recorded as external")
        check(check.note("linkedin", "400002") == f"apply opens an external site: https://jobs.lever.co/outside/{LEVER_JOB}",
              f"with where it leads, past the safety reminder and LinkedIn's redirect ({check.note('linkedin', '400002')})")
        check(check.status("linkedin", "400003") == "skipped" and check.note("linkedin", "400003") == "job is closed", "a closed job is skipped")
        check(check.status("linkedin", "400004") == "needs_manual" and "night shifts" in check.note("linkedin", "400004"), "a required question it can't answer is left for you")
        check(check.status("linkedin", "400005") == "already_applied", "already applied")
        check("LinkedIn says you've hit today's Easy Apply limit. Try again tomorrow." in log, "stops at LinkedIn's daily limit")
        check(check.status("linkedin", "400007") is None and check.status("linkedin", "400008") is None, "nothing after the limit")
        check("Done: applied to 1." in log, "run summary")

        print("\nReferrals: preview")
        dash.evaluate("""async () => {
            const s = await JB.store.getSettings();
            Object.assign(s.sites.linkedin.referral, { message: "Hi {first_name}, I applied for {title} at {company}: {job_url}. Would you refer me?",
              connectNote: "Hi {first_name}, I'm applying to {company}. Open to connecting?", perCompany: 2, forJobs: ["applied", "external"], sendMode: "review" });
            await JB.store.saveSettings(s);
        }""")
        check.overview("linkedin")
        check(dash.locator("#refer-box").is_visible(), "the overview has a Referrals box for LinkedIn")
        dash.click('.bot [data-act="refer-dry-run"]')
        s = check.wait_done("linkedin")
        log = "\n".join(s["log"])
        check("would message Priya Sharma" in log and "Hi Priya, I applied for ML Engineer at Acme: https://www.linkedin.com/jobs/view/400001/." in log,
              "would message the 1st-degree connection, message filled in")
        check("would invite Rahul Verma" in log and "Hi Rahul, I'm applying to Acme." in log, "would invite the 2nd-degree one, with the note")
        check("Ivan" not in log and "Far Away" not in log, "interns and 3rd-degree people left out")
        check("the job doesn't link to a LinkedIn company page" in log, "a job without a company page is passed over")
        check(not li.messages and not li.invites, "the preview sent nothing")
        check(li.searches and li.searches[0].get("network") == ['["F","S"]'] and li.searches[0].get("currentCompany") == ['["1234"]'],
              "searched the company's 1st and 2nd-degree connections")

        if os.environ.get("SHOW_LOGS"):
            print(log)
        print("\nReferrals: shown to you first (the default)")
        dash.click('.bot [data-act="refer"]')
        check.wait_prompt("Send this?")
        box = dash.locator(".bot .prompt").inner_text()
        check("Message Priya Sharma" in box and "Would you refer me?" in box, "shows who it goes to and the exact text")
        check.answer("Skip")
        check.wait_prompt("Send this?")
        check("Invite Rahul Verma" in dash.locator(".bot .prompt").inner_text(), "then the next person")
        check.answer("Stop run")
        check.wait_done("linkedin")
        check(not li.messages and not li.invites, "nothing sent without your Send")
        dash.evaluate("""async () => {
            const s = await JB.store.getSettings();
            s.sites.linkedin.referral.sendMode = "direct";
            await JB.store.saveSettings(s);
            await chrome.storage.local.set({ contacts: {}, referralJobs: {} }); // the skipped ones may be asked again
        }""")

        print("\nReferrals: sent straight away (chosen in Settings)")
        dash.click('.bot [data-act="refer"]')
        s = check.wait_done("linkedin")
        log = "\n".join(s["log"])
        if os.environ.get("SHOW_LOGS"):
            print(log)
        check(li.messages.get("priya-sharma", {}).get("text") == "Hi Priya, I applied for ML Engineer at Acme: https://www.linkedin.com/jobs/view/400001/. Would you refer me?",
              f"messaged Priya in LinkedIn's chat box ({li.messages.get('priya-sharma')})")
        check(li.invites.get("rahul-verma", {}).get("note") == "Hi Rahul, I'm applying to Acme. Open to connecting?", "invited Rahul (Connect under More) with the note")
        people = dash.evaluate("async () => (await chrome.storage.local.get('contacts')).contacts || {}")
        statuses = {c["name"]: c["status"] for c in people.values()}
        check(statuses == {"Priya Sharma": "messaged", "Rahul Verma": "invited"}, f"who was asked is kept ({statuses})")
        check("Done: contacted 2." in log, "summary")
        dash.evaluate("location.hash = '#history'")
        check("Rahul Verma" in dash.locator("#referral-rows").inner_text(), "History lists the people asked")

        print("\nReferrals: nobody twice; follow up once they accept")
        check.overview("linkedin")
        dash.click('.bot [data-act="refer"]')
        s = check.wait_done("linkedin")
        log = "\n".join(s["log"])
        check("0 job(s) to ask about." in log and "Checking which of 1 invite(s) were accepted..." in log, "the job isn't asked about again; the invite is checked")
        check(len(li.messages) == 1, "nobody messaged twice")
        li.accepted.add("rahul-verma")
        dash.click('.bot [data-act="refer"]')
        s = check.wait_done("linkedin")
        check(li.messages.get("rahul-verma", {}).get("text", "").startswith("Hi Rahul, I applied for ML Engineer at Acme"), "Rahul gets the message once he accepts")
        people = dash.evaluate("async () => (await chrome.storage.local.get('contacts')).contacts || {}")
        check({c["name"]: c["status"] for c in people.values()}.get("Rahul Verma") == "messaged", "and is marked asked")

        print("\nReferrals: a message with a <...> part isn't sent")
        dash.evaluate("""async () => { const s = await JB.store.getSettings(); s.sites.linkedin.referral.message = "Hi {first_name}, <say who you are>"; await JB.store.saveSettings(s); }""")
        dash.click('.bot [data-act="refer"]')
        s = check.wait_done("linkedin")
        check("still has a <...> placeholder" in "\n".join(s["log"]), "refuses until the <...> part is written")

        print("\nSettings")
        dash.evaluate("location.hash = '#settings'")
        dash.click("#site-tab-linkedin")
        check(dash.locator("#answer-rows-linkedin tr").count() > 10, "LinkedIn's own answers are listed")
        check(dash.locator("#skill-rows-linkedin tr").count() == 4, "skill years listed")
        dash.click("text=Add a skill")
        dash.locator("#skill-rows-linkedin tr:last-child [data-key=skill]").fill("pytorch")
        dash.locator("#skill-rows-linkedin tr:last-child [data-key=years]").fill("1")
        dash.locator('[data-list="sites.linkedin.workTypes"] input[value="remote"]').check()
        dash.select_option('[name="sites.linkedin.postedWithin"]', "day")
        dash.check('[name="sites.linkedin.referral.sendMode"][value="review"]')
        dash.click("#save")
        saved = dash.evaluate("async () => (await JB.store.getSettings()).sites.linkedin")
        check(saved["referral"]["sendMode"] == "review", "the review-or-send choice is saved")
        check(saved["skillYears"].get("pytorch") == 1 and saved["workTypes"] == ["remote"] and saved["postedWithin"] == "day",
              f"saved ({saved['skillYears']}, {saved['workTypes']}, {saved['postedWithin']})")

        print("\nSettings: where you are")
        check(dash.locator("#place-country").input_value() == "India" and dash.locator("#place-currency").input_value() == "INR",
              "the country and currency set before are shown")
        dash.select_option("#place-country", "Germany")
        check(dash.locator("#place-currency").input_value() == "EUR", "the currency goes with the country")
        dash.fill('[name="profile.city"]', "Berlin")
        dash.fill('[name="profile.expectedSalary"]', "70000")
        check('expected "70000 EUR a year"' in dash.locator("#place-preview").inner_text(), "what forms will read is shown")
        dash.click("#save")
        check("Where you are went into" in dash.locator("#saved").inner_text(), f"saving says what it filled in ({dash.locator('#saved').inner_text()})")
        dash.wait_for_function("""() => [...document.querySelectorAll('#answer-rows [data-key="answer"]')].some(i => i.value === "70000 EUR a year")""")
        got = dash.evaluate("""async () => {
            const s = await JB.store.getSettings(), ask = (site, q) => JB.answers.answerFor(q, JB.store.effective(s, site).answers);
            return { expected: ask("hirist", "Expected salary"), li: ask("linkedin", "Expected CTC"), cc: ask("linkedin", "Country code"),
                     here: ask("hirist", "Are you currently living in Berlin?"), there: ask("hirist", "Are you currently living in Bengaluru?"),
                     places: s.sites.linkedin.locations };
        }""")
        check(got == {"expected": "70000 EUR a year", "li": "70000", "cc": "Germany (+49)", "here": "Yes", "there": "No", "places": ["Germany"]},
              f"the answers and LinkedIn's places follow ({got})")
        dash.click("#add-work")
        row = dash.locator("#work-rows tr").last
        row.locator('[data-key="country"]').select_option("United States")
        check(row.locator('[data-key="currency"]').input_value() == "USD", "where you can work: the currency goes with the country")
        row.locator('[data-key="can"]').select_option("visa")
        row.locator('[data-key="salary"]').fill("140000")
        dash.click("#save")
        dash.wait_for_function("async () => (await JB.store.getSettings()).profile.workIn.length === 1")
        work = dash.evaluate("async () => (await JB.store.getSettings()).profile.workIn")
        check(work == [{"country": "United States", "can": "visa", "salary": 140000, "currency": "USD"}], f"...and is saved ({work})")
        check(not errors, f"no errors on the dashboard page {errors}")
        ctx.close()

    print(f"\n{'All passed.' if not check.failures else f'{check.failures} FAILED.'}")
    sys.exit(1 if check.failures else 0)


if __name__ == "__main__":
    main()
