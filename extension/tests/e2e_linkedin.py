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

from e2e import CACHE, EXT, REACT, sample_settings
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
  const [v, setV] = React.useState({ cc: 'Andorra (+376)', phone: '', email: 'me@example.com', resume: '', years: '', commute: '', notice: '', follow: true, night: '' });
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
        ...['Select an option', 'me@example.com'].map(o => e('option', { key: o, value: o }, o))),
     label('resume', 'Resume *'), e('input', { id: 'resume', type: 'file', required: true, style: { display: 'none' },
       onChange: ev => setV({ ...v, resume: ev.target.files[0]?.name || '' }) })],
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
    if (step === 0 && !v.resume) { setError('Please upload a resume'); return; }
    if (step === 1 && !/^\d+$/.test(v.notice)) { setError('Enter a whole number between 0 and 365'); return; }
    setError('');
    setStep(step + 1);
  };
  const submit = () => fetch('/api/apply/' + jobId, { method: 'POST', body: JSON.stringify(v) }).then(() => setSent(true));
  return e('div', { role: 'dialog', className: 'jobs-easy-apply-modal', 'aria-modal': 'true' },
    e('h2', null, `Apply to ${company}`),
    step === 0 && error ? e('p', { role: 'alert' }, error) : null,
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

# Recruiters: only a search for recruiters finds them. slug: (name, degree, headline, latest job on their profile)
RECRUITERS = {
    "meera-iyer": ("Meera Iyer", "2nd", "Talent Acquisition at Acme", "Talent Acquisition Acme · Full-time"),  # posted job 400001
    "anil-agency": ("Anil Kapoor", "1st", "Senior Recruiter | Hiring for top MNCs", "Recruiter TopHire Staffing"),
    "mohan-moved": ("Mohan Das", "1st", "Recruiter at Acme", "Recruiter Zomato · Full-time"),
    "sara-ta": ("Sara Thomas", "3rd", "Talent Acquisition Partner at Acme", "Talent Acquisition Partner Acme · Full-time"),
}

# LinkedIn's overlay as seen in Nov 2026: a #interop-outlet whose open shadow root holds the invitation dialog and
# the chat windows. The hidden /preload/ iframe's scripts build them, so their elements come from that iframe's window.
OVERLAY_JS = r"""
window.overlay = (() => {
  function builder() { // runs in the iframe's window
    const make = html => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
    window.invite = onSend => {
      const modal = root.appendChild(make('<div data-test-modal-id="send-invite-modal" aria-hidden="false" class="artdeco-modal-overlay">'
        + '<div role="dialog" class="artdeco-modal send-invite" aria-labelledby="send-invite-modal"><button aria-label="Dismiss" class="dismiss"></button>'
        + '<h2 id="send-invite-modal">Add a note to your invitation?</h2><p>You have unlimited notes with Premium</p>'
        + '<button aria-label="Add a note" class="note">Add a note</button><button aria-label="Send without a note" class="plain">Send without a note</button></div></div>'));
      const d = modal.firstElementChild;
      const done = note => { modal.remove(); onSend(note); };
      d.querySelector('.dismiss').onclick = () => modal.remove();
      d.querySelector('.plain').onclick = () => done('');
      d.querySelector('.note').onclick = () => setTimeout(() => {
        d.replaceChildren(...make('<div><button aria-label="Dismiss" class="dismiss"></button><h2>Add a note to your invitation</h2>'
          + '<p>Please limit personal note to 300 characters.</p><textarea id="custom-message" name="message"></textarea>'
          + '<button aria-label="Cancel adding a note">Cancel</button><button aria-label="Send invitation" class="send" disabled>Send</button></div>').children);
        const note = d.querySelector('textarea'), send = d.querySelector('.send');
        note.addEventListener('input', () => { send.disabled = !note.value.trim(); });
        send.onclick = () => done(note.value);
        d.querySelector('.dismiss').onclick = () => modal.remove();
      }, 600);
    };
    window.chat = (name, onSend) => {
      const bubble = root.appendChild(make('<div class="msg-convo-wrapper msg-overlay-conversation-bubble"><header>New message'
        + '<button>Minimize your conversation</button><button class="close">Close your draft conversation</button></header>'
        + `<p>${name} · 1st degree connection</p><form class="msg-form"><div class="msg-form__contenteditable" contenteditable="true" role="textbox"></div>`
        + '<button type="submit" class="send" disabled>Send</button></form></div>'));
      const box = bubble.querySelector('[contenteditable]'), send = bubble.querySelector('.send');
      box.addEventListener('input', () => { send.disabled = !box.innerText.trim(); });
      bubble.querySelector('form').onsubmit = e => { e.preventDefault(); onSend(box.innerText.trim()); box.innerHTML = ''; send.disabled = true; };
      bubble.querySelector('.close').onclick = () => bubble.remove();
    };
  }
  function preload() {
    if (!document.getElementById('interop-outlet')) {
      const host = document.body.appendChild(document.createElement('div'));
      host.id = 'interop-outlet';
      host.setAttribute('data-testid', 'interop-shadowdom');
      host.attachShadow({ mode: 'open' });
      const frame = document.body.appendChild(document.createElement('iframe'));
      frame.id = 'preload';
      frame.style.cssText = 'width:0;height:0;border:0';
      frame.contentWindow.root = host.shadowRoot;
      frame.contentWindow.eval(`(${builder})()`);
    }
    return document.getElementById('preload').contentWindow;
  }
  return {
    get root() { preload(); return document.getElementById('interop-outlet').shadowRoot; },
    invite: (onSend = note => { window.invited = note; }) => preload().invite(onSend),
    chat: (name, onSend = text => { if (name === 'Someone Else') window.wrong = true; else window.messaged = [name, text]; }) => preload().chat(name, onSend),
  };
})();
"""

# A profile's header buttons: Message for connections; Connect (maybe under More) with LinkedIn's invite dialog.
PROFILE_JS = r"""
const slug = document.body.dataset.slug;
const post = (what, data) => fetch(`/api/${what}/${slug}`, { method: 'POST', body: JSON.stringify(data) });
const card = document.querySelector('main section');
function chat() { overlay.chat(document.body.dataset.name, text => post('message', { text })); }
function invite() {
  document.body.appendChild(document.createElement('iframe')); // unrelated frame on the profile
  overlay.invite(note => post('invite', { note }).then(() => {
    card.querySelector('.connect, .more')?.remove();
    card.insertAdjacentHTML('beforeend', '<button>Pending</button><p>Invitation sent</p>');
  }));
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
        self.preload_invite = False
        self.hiring_team = True  # job 400001 shows who posted it

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
            q = parse_qs(parts.query)
            self.searches.append(q)
            if re.search(r"recruit|talent", (q.get("keywords") or [""])[0]):
                rows = "".join(f'<li data-view-name="people-search-result"><div><a href="/in/{s}/">{n}</a></div><div>• {d if s not in self.accepted else "1st"}</div>'
                               f'<p>{h}</p></li>' for s, (n, d, h, _) in RECRUITERS.items() if s != "meera-iyer")
                return route.fulfill(body=page("Search | LinkedIn", f"<main><ul>{rows}</ul></main>"), content_type="text/html")
            rows = "".join(f'<li data-view-name="people-search-result"><div><a href="/in/{s}/">{n}</a></div><div>• {d if s not in self.accepted else "1st"}</div>'
                           f'<p>{h}</p><button>{"Message" if d == "1st" else "Connect"}</button></li>' for s, (n, d, h, _) in PEOPLE.items())
            return route.fulfill(body=page("Search | LinkedIn", f"<main><ul>{rows}</ul></main>"), content_type="text/html")
        if path == '/preload/custom-invite/' and self.preload_invite:
            slug = parse_qs(parts.query)['vanityName'][0]
            assert slug == 'rahul-verma'
            body = '''<main><div data-test-modal-container data-test-modal-id="send-invite-modal" aria-hidden="false">
                <div data-test-modal role="dialog" class="artdeco-modal send-invite" aria-labelledby="send-invite-modal">
                <header><h2 id="send-invite-modal">Add a note to your invitation?</h2></header>
                <p>Personalize your invitation to <strong>Rahul Verma</strong> by adding a note.</p>
                <button aria-label="Add a note">Add a note</button>
                <button aria-label="Send without a note">Send without a note</button></div></div></main>'''
            script = """<script>
                const d = document.querySelector('[role=dialog]');
                d.querySelector('button').onclick = () => {
                    d.innerHTML = '<textarea></textarea><button>Send</button>';
                    d.querySelector('button').onclick = async () => {
                        await fetch('/api/invite/rahul-verma', {method:'POST', body:JSON.stringify({note:d.querySelector('textarea').value})});
                        d.innerText = 'Invitation sent';
                    };
                };
                </script>"""
            return route.fulfill(body=page('Invitation | LinkedIn', body, script), content_type='text/html')
        m = re.match(r"^/in/([^/]+)", path)
        if m and m.group(1) in RECRUITERS:
            slug = m.group(1)
            name, degree, headline, latest = RECRUITERS[slug]
            degree = "1st" if slug in self.accepted else degree
            if degree == "1st":
                buttons = '<button class="message">Message</button>'
            elif slug in self.invites:
                buttons = "<button>Pending</button>"
            else:
                buttons = f'<button class="connect" aria-label="Invite {name} to connect">Connect</button>'
            body = (f'<main><section><h1>{name}</h1><p>{headline}</p><div>· {degree}</div><div class="actions">{buttons}</div></section>'
                    f'<section><div id="experience"></div><h2>Experience</h2><ul><li>{latest}</li><li>Recruiter Oldco</li></ul></section></main>')
            html = page(f"{name} | LinkedIn", body, f"<script>{OVERLAY_JS}{PROFILE_JS}</script>").replace("<body>", f'<body data-slug="{slug}" data-name="{name}">')
            return route.fulfill(body=html, content_type="text/html")
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
            if self.preload_invite and degree == '2nd' and slug not in self.invites:
                # A profile-rendered link whose client-side click leaves the profile unchanged.
                body += (f'<a href="/preload/custom-invite/?vanityName={slug}" aria-disabled="false" '
                         f'aria-label="Invite {name} to connect" onclick="event.preventDefault()"><span>Connect</span></a>')
                body = body.replace(buttons, '<button>Connect</button>')  # unrelated fallback must not take precedence
            html = page(f"{name} | LinkedIn", body, f"<script>{OVERLAY_JS}{PROFILE_JS}</script>").replace("<body>", f'<body data-slug="{slug}" data-name="{name}">')
            return route.fulfill(body=html, content_type="text/html")
        if path.startswith("/mynetwork/invite-connect/connections"):
            links = "".join(f'<a href="/in/{s}/">{(PEOPLE.get(s) or RECRUITERS[s])[0]}</a>' for s in sorted(self.accepted)) or '<a href="/in/someone-else/">Someone</a>'
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
            team = ""
            if jid == "400001" and self.hiring_team:  # LinkedIn's "Meet the hiring team" card, with the job's poster
                team = ('<section><div><h2>Meet the hiring team</h2></div><div><div><a href="/in/meera-iyer/"><img alt=""></a></div>'
                        '<div><a href="/in/meera-iyer/"><span aria-hidden="true">Meera Iyer</span><span class="visually-hidden">View Meera Iyer’s profile</span></a>'
                        '<span>• 2nd</span><div>Talent Acquisition at Acme</div><div>Job poster</div></div><button>Message</button></div></section>')
            body = f"<main><h1>{title}</h1><div>{company_link}</div>{action}{team}<section>{about}</section>{similar}</main>"
            return route.fulfill(body=page(f"{title} | {company} | LinkedIn", body, f"{REACT_TAGS}<script>{EASY_APPLY_JS}</script>"), content_type="text/html")
        route.fulfill(status=404, body="not found")


def check_easy_apply_forms(ctx):
    """Exercise the actual page adapter against controls missed by the full application fixture."""
    tab = ctx.new_page()
    tab.set_content('<div role="dialog" class="jobs-easy-apply-modal"></div>')
    tab.add_script_tag(content="globalThis.JB = { sites: {} };")
    for script in ["lib/filters.js", "lib/answers.js", "lib/page.js", "sites/linkedin.js"]:
        tab.add_script_tag(content=(EXT / script).read_text())
    tab.evaluate("JB.site = JB.sites.linkedin")
    failures = []

    def case(name, body, fill, verify):
        tab.evaluate("body => document.querySelector('[role=dialog]').innerHTML = body", body)
        result = tab.evaluate("fill => JB.site.page.fillStep(fill)", {"answers": [], **fill})
        ok = verify(result)
        print(f"  {'PASS' if ok else 'FAIL'} {name}: {result}", flush=True)
        if not ok:
            failures.append(name)

    resume = {"name": "resume.pdf", "type": "application/pdf", "data": "JVBERi0xLjQ="}
    case("uploads the saved resume through a styled file input",
         '<label for="cv">Resume *</label><input id="cv" type="file" required style="display:none">',
         {"resume": resume},
         lambda r: not r["missing"] and tab.evaluate("document.querySelector('#cv').files[0]?.name") == "resume.pdf")
    case("reports a required resume when none is saved",
         '<label for="cv">Resume *</label><input id="cv" type="file" required style="display:none">', {},
         lambda r: any(m["kind"] == "file" for m in r["missing"]))
    case("does not upload the resume as a cover letter",
         '<label for="letter">Cover letter *</label><input id="letter" type="file" required>',
         {"resume": resume},
         lambda r: any(m["kind"] == "file" for m in r["missing"]) and tab.evaluate("document.querySelector('#letter').files.length") == 0)
    case("ignores file inputs on hidden steps",
         '<section hidden><label for="cv">Resume *</label><input id="cv" type="file" required></section>',
         {"resume": resume},
         lambda r: not r["missing"] and tab.evaluate("document.querySelector('#cv').files.length") == 0)
    case("ignores required radio groups on hidden steps",
         '<section hidden><fieldset><legend>Hidden question *</legend><input type="radio" name="old" required value="Yes"></fieldset></section>'
         '<label for="phone">Phone</label><input id="phone" required>',
         {"answers": [["phone", "1234567890"]]},
         lambda r: not r["missing"])
    case("still fills radios hidden behind visible labels",
         '<fieldset><legend>Can you commute? *</legend><input id="yes" type="radio" name="commute" required style="display:none" value="Yes">'
         '<label for="yes">Yes</label><input id="no" type="radio" name="commute" style="display:none" value="No"><label for="no">No</label></fieldset>',
         {"answers": [["commute", "Yes"]]},
         lambda r: not r["missing"] and tab.is_checked('#yes'))
    # LinkedIn can replace its initial controls as the questions finish loading.
    tab.evaluate("""() => {
        document.querySelector('[role=dialog]').innerHTML = '<label for="phone">Phone</label><input id="phone" required>';
        setTimeout(() => { const box = document.querySelector('#phone'); box.replaceWith(box.cloneNode()); }, 100);
    }""")
    result = tab.evaluate("JB.site.page.fillStep({ answers: [['phone', '1234567890']] })")
    ok = not result["missing"] and tab.input_value('#phone') == "1234567890"
    print(f"  {'PASS' if ok else 'FAIL'} fills controls replaced while the step loads", flush=True)
    if not ok:
        failures.append("replaced controls")
    result = tab.evaluate("""async () => {
        JB.store = { resume: async () => null };
        const calls = [];
        const run = {
            exec: async name => {
                calls.push(name);
                return ({ 'site.applyState': { easy: true }, 'site.stepReady': true,
                    'site.modalText': 'Upload resume',
                    'site.fillStep': { missing: [{ q: 'Resume', kind: 'file' }], leftBlank: [] } })[name];
            },
            sleep: async () => {}, step: () => {},
            learn: () => { throw new Error('A missing file must not be treated as a text question'); }
        };
        const status = await JB.site.apply(run, {}, {});
        return { status, pressed: calls.includes('site.pressStep') };
    }""")
    ok = result["status"][0] == "needs_manual" and "Settings" in result["status"][1] and not result["pressed"]
    print(f"  {'PASS' if ok else 'FAIL'} missing resume stops before advancing: {result}", flush=True)
    if not ok:
        failures.append("missing resume handling")
    tab.close()
    assert not failures, f"Easy Apply regressions: {', '.join(failures)}"


def check_invite_controls(ctx):
    tab = ctx.new_page()
    profile = 'https://www.linkedin.com/in/nilayrajderkar/'
    tab.route(profile, lambda route: route.fulfill(body='<main></main>', content_type='text/html'))
    tab.goto(profile)
    tab.add_script_tag(content="globalThis.JB = { sites: {} };")
    for script in ['lib/filters.js', 'lib/answers.js', 'lib/page.js', 'sites/linkedin.js']:
        tab.add_script_tag(content=(EXT / script).read_text())
    tab.evaluate('JB.site = JB.sites.linkedin')
    failures = []

    def case(name, body, action, verify):
        tab.evaluate("body => { document.body.innerHTML = body; window.sent = false; }", body)
        result = tab.evaluate(action)
        ok = verify(result)
        print(f"  {'PASS' if ok else 'FAIL'} {name}: {result}", flush=True)
        if not ok:
            failures.append(name)

    case('screenshot dialog: visible send text differs from accessibility label',
         '<div role="dialog"><h2>Add a note to your invitation?</h2>'
         '<button aria-label="Send an invitation" onclick="window.sent=true">Send without a note</button></div>',
         'JB.site.page.sendInvite(false)', lambda r: r and tab.evaluate('window.sent'))
    case('send with a note uses visible text in an aria-modal dialog',
         '<div aria-modal="true"><textarea>My note</textarea>'
         '<button aria-label="Send invitation to Nikhil U." onclick="window.sent=true">Send</button></div>',
         'JB.site.page.sendInvite(true)', lambda r: r and tab.evaluate('window.sent'))
    case('Add a note uses visible text and waits for a delayed editor',
         '<div aria-modal="true"><button aria-label="Personalize your invitation" '
         'onclick="setTimeout(() => this.parentElement.innerHTML = \'<textarea maxlength=200></textarea><button>Send</button>\', 1600)">Add a note</button></div>',
         "JB.site.page.addNote('Hello, would you connect?')",
         lambda r: r.get('added') and tab.input_value('textarea') == 'Hello, would you connect?')
    case('send waits for a delayed button to become enabled',
         '<div role="dialog"><button onclick="window.sent=true" disabled>Send without a note</button></div>'
         '<script></script>',
         "(() => { setTimeout(() => document.querySelector('button').disabled = false, 500); return JB.site.page.sendInvite(false); })()",
         lambda r: r and tab.evaluate('window.sent'))
    case('no invite dialog never clicks an unrelated Send button',
         '<button onclick="window.sent=true">Send</button>',
         'JB.site.page.sendInvite(false)', lambda r: not r and not tab.evaluate('window.sent'))
    case('detects a LinkedIn modal without dialog attributes',
         '<div class="artdeco-modal"><h2>Add a note to your invitation?</h2>'
         '<button onclick="window.sent=true">Send without a note</button></div>',
         'JB.site.page.sendInvite(false)', lambda r: r and tab.evaluate('window.sent'))
    case('detects an invitation panel from its heading when modal markers are absent',
         '<button onclick="window.wrong=true">Send</button><div class="overlay"><div><h2>Add a note to your invitation?</h2></div>'
         '<footer><button onclick="window.sent=true">Send without a note</button></footer></div>',
         'JB.site.page.sendInvite(false)', lambda r: r and tab.evaluate('window.sent'))
    case('unmarked note editor stays scoped to the invitation',
         '<div><h2>Add a note to your invitation</h2><textarea id="invite-note"></textarea>'
         '<button onclick="window.sent=true">Send</button></div>',
         "JB.site.page.addNote('Hi, please connect')",
         lambda r: r.get('added') and tab.input_value('#invite-note') == 'Hi, please connect')
    case('Connect with a visible plus opens the invitation',
         '<main><section><button onclick="window.sent=true">+ Connect</button></section></main>',
         "JB.site.page.openInvite('Nilay Rajderkar')", lambda r: r and tab.evaluate('window.sent'))
    case('prefers the enabled Connect link for the reviewed profile',
         '<main><section><a href="/preload/custom-invite/?vanityName=another" onclick="window.wrong=true;return false">Connect</a></section></main>'
         '<a aria-disabled="false" href="/preload/custom-invite/?vanityName=nilayrajderkar" '
         'componentkey="ConnectButtonstate:invitation:urn:li:member:611152012_connect" '
         'aria-label="Invite Nilay Rajderkar to connect" onclick="window.sent=true;return false"><span>Connect</span></a>',
         "JB.site.page.openInvite('Nilay Rajderkar')",
         lambda r: r and tab.evaluate("window.sent && !window.wrong && JB.site.page.invitePageUrl().endsWith('vanityName=nilayrajderkar')"))
    case('ignores a Connect link for a different profile',
         '<main><section><a href="/preload/custom-invite/?vanityName=another" onclick="window.sent=true;return false">Connect</a></section></main>',
         "JB.site.page.openInvite('Nilay Rajderkar')", lambda r: not r and not tab.evaluate('window.sent'))
    # As on LinkedIn (Nov 2026): the invitation dialog and chat windows sit in the open shadow root of
    # #interop-outlet, built by the /preload/ iframe's scripts (so their elements come from another window).
    tab.evaluate(OVERLAY_JS)
    case('finds the invitation in LinkedIn\'s overlay and writes the note there',
         '<main><section><h1>Nilay Rajderkar</h1></section></main>',
         "(async () => { overlay.invite(); overlay.chat('Someone Else'); const note = await JB.site.page.addNote('Hi Nilay');"
         " return { dialog: JB.site.page.hasDialog(), note, value: overlay.root.querySelector('#custom-message')?.value }; })().catch(e => ({ error: String(e) }))",
         lambda r: r.get('dialog') and r['note'].get('added') and r['value'] == 'Hi Nilay')
    case('sends the invitation, not the open chat\'s message',
         '<main><section><h1>Nilay Rajderkar</h1></section></main>',
         "(async () => { overlay.invite(); overlay.chat('Someone Else'); await JB.site.page.addNote('Hi Nilay');"
         " return { sent: await JB.site.page.sendInvite(true), invited: window.invited, wrong: window.wrong }; })().catch(e => ({ error: String(e) }))",
         lambda r: r.get('sent') and r['invited'] == 'Hi Nilay' and not r['wrong'])
    case('Dismiss closes the overlay\'s invitation',
         '<main><section><h1>Nilay Rajderkar</h1></section></main>',
         "(async () => { overlay.invite(); JB.site.page.escape(); await new Promise(r => setTimeout(r, 100)); return JB.site.page.hasDialog(); })()",
         lambda r: r is False)
    case('messages only the person whose chat it opened, in the overlay',
         '<main><section><h1>Raksha C C</h1><a href="#" onclick="overlay.chat(\'Raksha C C\'); return false">Message</a>'
         '<a href="#">Message top connections</a></section></main>',
         "(async () => { overlay.chat('Someone Else'); const P = JB.site.page; const opened = await P.openMessage('Raksha C C');"
         " await new Promise(r => setTimeout(r, 200)); const ready = P.messageBoxReady(); P.typeMessage('Would you refer me?');"
         " await new Promise(r => setTimeout(r, 100)); const sent = P.sendMessageNow(); const empty = P.messageBoxEmpty(); P.closeChat();"
         " return { opened, ready, sent, empty, to: window.messaged, wrong: window.wrong, left: overlay.root.querySelectorAll('.msg-overlay-conversation-bubble').length }; })().catch(e => ({ error: String(e) }))",
         lambda r: r.get('opened') and r['ready'] and r['sent'] and r['empty'] and r['to'] == ['Raksha C C', 'Would you refer me?']
         and not r['wrong'] and r['left'] == 0)
    tab.evaluate('''() => {
        document.body.innerHTML = '<iframe></iframe><iframe></iframe>';
        const [chat, invite] = document.querySelectorAll('iframe');
        chat.contentDocument.body.innerHTML = '<div role="dialog"><button onclick="parent.wrong=true">Send</button></div>';
        invite.contentDocument.body.innerHTML = '<div role="dialog"><h2>Add a note to your invitation?</h2><textarea></textarea><button onclick="parent.sent=true">Send</button></div>';
        window.sent = false; window.wrong = false;
    }''')
    result = tab.evaluate("JB.site.page.addNote('Hello Nilay')")
    if not result.get('added') or tab.frames[-1].locator('textarea').input_value() != 'Hello Nilay':
        failures.append('note in the invitation frame')
    if not tab.evaluate('JB.site.page.sendInvite(true)') or not tab.evaluate('window.sent && !window.wrong'):
        failures.append('Send in the invitation frame only')
    tab.close()
    assert not failures, f"Invite regressions: {', '.join(failures)}"


def check_referral_example(dash, li):
    """One explicit job link: preview, skip, retry, send, then follow up after acceptance."""
    check = Check(dash)
    li.logged_in = True
    li.preload_invite = True
    dash.evaluate("""async () => {
        const s = await JB.store.getSettings();
        Object.assign(s.sites.linkedin.referral, {
            jobs: ['https://www.linkedin.com/jobs/view/400001/'],
            message: 'Hi {first_name}, I am interested in {title} at {company}: {job_url}. Would you refer me?',
            connectNote: 'Hi {first_name}, I am applying to {company}. Open to connecting?',
            sendMode: 'review', perCompany: 2
        });
        await JB.store.saveSettings(s);
        await JB.store.saveContact({ profile: 'https://www.linkedin.com/in/rahul-verma/', name: 'Rahul Verma' },
            { jobId: '400001', url: 'https://www.linkedin.com/jobs/view/400001/', title: 'ML Engineer', company: 'Acme' },
            'https://www.linkedin.com/company/acme/', 'failed', 'no Send button in the invite dialog');
    }""")
    check.overview('linkedin')
    dash.click('.bot [data-act="refer-dry-run"]')
    state = check.wait_done('linkedin')
    log = '\n'.join(state['log'])
    check('would message Priya Sharma' in log and 'would invite Rahul Verma' in log,
          'explicit job link previews one connection and one invitation')
    check(not li.messages and not li.invites, 'preview sends nothing')

    dash.click('.bot [data-act="refer"]')
    for name in ['Priya Sharma', 'Rahul Verma']:
        check.wait_prompt('Send this?')
        check(name in dash.locator('.bot .prompt').inner_text(), f'reviews {name}')
        check.answer('Skip')
    check.wait_done('linkedin')
    check(not li.messages and not li.invites, 'skipping both sends nothing')
    eligible = dash.evaluate("JB.store.askedAbout('400001').then(asked => !asked)")
    check(eligible, 'a skipped referral can be retried without clearing history')
    if not eligible:
        raise AssertionError('Skipping both recipients permanently hides the job from future referral runs')

    # Retry the same link and approve each recipient through the dashboard.
    dash.click('.bot [data-act="refer"]')
    for name in ['Priya Sharma', 'Rahul Verma']:
        check.wait_prompt('Send this?')
        check(name in dash.locator('.bot .prompt').inner_text(), f'retry shows {name}')
        check.answer('Send')
    state = check.wait_done('linkedin')
    check(li.messages.get('priya-sharma', {}).get('text') ==
          'Hi Priya, I am interested in ML Engineer at Acme: https://www.linkedin.com/jobs/view/400001/. Would you refer me?',
          'Priya receives the rendered referral message')
    check(li.invites.get('rahul-verma', {}).get('note') ==
          'Hi Rahul, I am applying to Acme. Open to connecting?', 'Rahul receives the invitation note')
    check('Done: contacted 2.' in '\n'.join(state['log']), 'reports two confirmed contacts')
    dash.click('.bot [data-act="refer"]')
    state = check.wait_done('linkedin')
    check('0 job(s) to ask about.' in '\n'.join(state['log']) and len(li.messages) == 1,
          'successful referrals are not sent again')
    li.accepted.add('rahul-verma')
    dash.click('.bot [data-act="refer"]')
    check.wait_prompt('Send this?')
    check('Message Rahul Verma' in dash.locator('.bot .prompt').inner_text(), 'accepted invitation becomes a message')
    check.answer('Send')
    check.wait_done('linkedin')
    check(li.messages.get('rahul-verma', {}).get('text', '').startswith('Hi Rahul, I am interested in ML Engineer'),
          'Rahul receives the referral message after acceptance')
    assert not check.failures, f'{check.failures} referral checks failed'
    print('Referral example: all passed.', flush=True)


def check_recruiters(dash, li, check):
    """Writing to recruiters, after the referral runs above: its own records, the poster first, then a search."""
    print("\nRecruiters: preview")
    dash.evaluate("""async () => {
        const s = await JB.store.getSettings();
        Object.assign(s.sites.linkedin.recruiter, { message: "Hi {first_name}, I applied for {title} at {company}: {job_url}. Are you the right person to talk to?",
          connectNote: "Hi {first_name}, I applied for {title} at {company}.", sendMode: "review" });
        await JB.store.saveSettings(s);
    }""")
    check.overview("linkedin")
    check(dash.locator("#reach-box").is_visible(), "the overview has a Recruiters box for LinkedIn")
    searches = len(li.searches)
    dash.click('.bot [data-act="reach-dry-run"]')
    s = check.wait_done("linkedin")
    log = "\n".join(s["log"])
    check("Meera Iyer: posted this job" in log and "would invite Meera Iyer" in log and "Hi Meera, I applied for ML Engineer at Acme." in log,
          "would invite whoever posted the job, with the recruiter note")
    check(len(li.searches) == searches, "no people search when the job shows its poster")
    check("Priya" not in log and "Rahul" not in log, "people asked for a referral aren't written to")
    check(not li.invites.get("meera-iyer") and not li.messages.get("meera-iyer"), "the preview sent nothing")

    print("\nRecruiters: shown to you first, then sent")
    dash.click('.bot [data-act="reach"]')
    check.wait_prompt("Send this?")
    check("Invite Meera Iyer" in dash.locator(".bot .prompt").inner_text(), "shows who it goes to")
    check.answer("Send")
    s = check.wait_done("linkedin")
    check(li.invites.get("meera-iyer", {}).get("note") == "Hi Meera, I applied for ML Engineer at Acme.", f"invited Meera with the note ({li.invites.get('meera-iyer')})")
    people = dash.evaluate("async () => (await chrome.storage.local.get('contacts')).contacts || {}")
    meera = next((c for c in people.values() if c["name"] == "Meera Iyer"), {})
    check(meera.get("kind") == "recruiter" and meera.get("status") == "invited", f"kept as a recruiter contact ({meera})")
    check(meera.get("headline") == "Talent Acquisition at Acme", f"her headline read off the hiring team card ({meera.get('headline')})")
    dash.evaluate("location.hash = '#history'")
    rows = dash.locator("#referral-rows").inner_text()
    check("Meera Iyer" in rows and "Recruiter" in rows and "Referral" in rows, "History lists recruiters and referrals, each marked")
    check.overview("linkedin")

    print("\nRecruiters: once she accepts, the recruiter message, never the referral one")
    li.accepted.add("meera-iyer")
    dash.click('.bot [data-act="refer"]')
    check.wait_done("linkedin")
    check("meera-iyer" not in li.messages, "a referral run doesn't follow up a recruiter's invite")
    dash.click('.bot [data-act="reach"]')
    check.wait_prompt("Send this?")
    check.answer("Send")
    check.wait_done("linkedin")
    check(li.messages.get("meera-iyer", {}).get("text", "").startswith("Hi Meera, I applied for ML Engineer at Acme: https://www.linkedin.com/jobs/view/400001/. Are you the right"),
          f"the recruiter run sends her the recruiter message ({li.messages.get('meera-iyer')})")

    print("\nRecruiters: no poster, so a search")
    li.hiring_team = False
    dash.evaluate("""async () => {
        const s = await JB.store.getSettings();
        s.sites.linkedin.recruiter.perCompany = 2; // Meera is the first at Acme
        await JB.store.saveSettings(s);
        await chrome.storage.local.set({ recruiterJobs: {} });
    }""")
    searches = len(li.searches)
    dash.click('.bot [data-act="reach-dry-run"]')
    s = check.wait_done("linkedin")
    log = "\n".join(s["log"])
    if os.environ.get("SHOW_LOGS"):
        print(log)
    new = li.searches[searches:]
    check(new and new[0].get("keywords") == ["recruiter"] and new[0].get("network") == ['["F","S","O"]'], f"searched recruiters, 3rd-degree too ({new[:1]})")
    check("Anil" not in log, "an agency recruiter is left out")
    check("Mohan Das: their latest job isn't at Acme, skipped" in log, "someone who moved on is skipped on their profile")
    check("would invite Sara Thomas" in log and "Meera" not in log, "the recruiter there is next; Meera isn't written to twice")
    check("sara-thomas" not in li.invites and "sara-ta" not in li.invites, "the preview sent nothing")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--forms-only", action="store_true")
    parser.add_argument("--referrals-only", action="store_true")
    parser.add_argument("--invites-only", action="store_true")
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
        if args.invites_only:
            try:
                check_invite_controls(ctx)
            finally:
                ctx.close()
            return
        if not args.forms_only:
            check_invite_controls(ctx)
        if not args.referrals_only:
            check_easy_apply_forms(ctx)
        if args.forms_only:
            ctx.close()
            return
        ctx.route(re.compile(r"^https://(www\.)?linkedin\.com/"), fake(li.handle))
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        worker.evaluate("s => chrome.storage.local.set({ settings: s })", sample_settings())  # what these tests are written for
        dash = ctx.new_page()
        dash.goto(f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html")
        dash.on("dialog", lambda d: d.accept())
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector("#site-name")
        if args.referrals_only:
            check_referral_example(dash, li)
            ctx.close()
            return
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
            await JB.store.saveResume({ name: "resume.pdf", type: "application/pdf", data: "JVBERi0xLjQ=" });
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
        check(got.get("resume") == "resume.pdf", "saved resume uploaded and accepted by the React form")
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

        check_recruiters(dash, li, check)

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
