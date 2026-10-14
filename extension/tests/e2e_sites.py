#!/usr/bin/env python3
"""End-to-end test for Instahyre, Wellfound and Cutshort: the extension in a real Chromium, on fake copies of them.

  .venv/bin/python extension/tests/e2e_sites.py            # headless
  .venv/bin/python extension/tests/e2e_sites.py --headed   # watch it

Same setup as e2e.py (Playwright's Chromium, React fetched once into tests/.cache).
"""
import argparse
import json
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

from e2e import CACHE, EXT, REACT

REACT_TAGS = '<script src="/static/react.js"></script><script src="/static/react-dom.js"></script>'
MODAL_JS = """
function modal(fields, button, onSend) {  // a React dialog: labelled inputs, one button
  const e = React.createElement;
  const host = document.body.appendChild(document.createElement('div'));
  function Dialog() {
    const [values, set] = React.useState({});
    const [done, setDone] = React.useState(false);
    if (done) return e('p', null, done);
    return e('div', {role: 'dialog', 'aria-modal': 'true'},
      ...fields.map(([key, label, tag]) => e('div', {key},
        e('label', {htmlFor: key}, label),
        e(tag || 'input', {id: key, value: values[key] || '', onChange: ev => set({...values, [key]: ev.target.value})}))),
      e('button', {disabled: fields.some(([k]) => !values[k]), onClick: () => onSend(values).then(setDone)}, button));
  }
  ReactDOM.createRoot(host).render(e(Dialog));
}
"""


def page(title, body, scripts=""):
    return f"<!doctype html><html><head><meta charset=utf-8><title>{title}</title></head><body>{body}{scripts}</body></html>"


def redirect(route, to):
    """Send the page elsewhere, as the site's server would (Playwright can't fulfil a navigation with a 302)."""
    route.fulfill(body=f"<!doctype html><title>Redirecting</title><script>location.replace({json.dumps(to)})</script>", content_type="text/html")


def fake(handler):
    """Never let a request through to the real site: a broken fake answers 500 instead."""
    def handle(route):
        try:
            handler(route)
        except Exception as e:  # noqa: BLE001
            print(f"  (fake site error on {route.request.url}: {e})")
            route.fulfill(status=500, body="fake site error")
    return handle


class Instahyre:
    JOBS = {  # id: (title, company, years, kind)
        "3001": ("ML Engineer", "Acme", "1 - 3", "direct"),
        "3002": ("Backend Developer", "Beta", "1 - 2", "dialog"),
        "3003": ("Python Developer", "Gamma", "0 - 2", "already"),
        "3004": ("Python Developer", "Old Co", "5 - 9", "direct"),
    }

    def __init__(self):
        self.logged_in = False
        self.applied = {"3003"}
        self.posted = {}
        self.dismissed = set()
        self.searches = []

    def url(self, jid):
        title, company, _, _ = self.JOBS[jid]
        return f"/job-{jid}-{re.sub(r'[^a-z0-9]+', '-', f'{title} at {company}'.lower())}-bangalore/"

    def card(self, jid):
        title, company, years, _ = self.JOBS[jid]
        return f'<a href="{self.url(jid)}"><b>{title}</b> {company} {years} yrs Bangalore</a><br>'

    def handle(self, route):
        req = route.request
        parts = urlsplit(req.url)
        path = parts.path
        if path.startswith("/static/"):
            return route.fulfill(path=str(CACHE / path.split("/")[-1]), content_type="text/javascript")
        if path.startswith("/candidate/opportunities"):
            if not self.logged_in:
                return redirect(route, "https://www.instahyre.com/login/")
            return route.fulfill(body=page("Opportunities - Instahyre", "<h1>Your opportunities</h1>"), content_type="text/html")
        if path.startswith("/login"):
            return route.fulfill(body=page("Login - Instahyre", "<h1>Log in</h1><input id=email><input id=password type=password>"), content_type="text/html")
        if path.startswith("/api/apply/"):
            jid = path.rsplit("/", 1)[1]
            self.applied.add(jid)
            self.posted[jid] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        if path.startswith("/api/dismiss/"):
            self.dismissed.add(path.rsplit("/", 1)[1])
            return route.fulfill(json={"ok": True})
        if path.startswith("/search-jobs"):
            self.searches.append(parse_qs(parts.query))
            first = "".join(self.card(j) for j in ("3001", "3002"))
            more = json.dumps("".join(self.card(j) for j in ("3003", "3004")))
            script = f"""<script>let more = false; addEventListener('scroll', () => {{ if (more) return; more = true;
              setTimeout(() => document.getElementById('list').insertAdjacentHTML('beforeend', {more}), 300); }});</script>"""
            body = f'<main id="list" style="min-height:4000px">{first}</main>'
            return route.fulfill(body=page("Search jobs - Instahyre", body, script), content_type="text/html")
        m = re.match(r"^/job-(\d+)-", path)
        if m and m.group(1) in self.JOBS:
            jid = m.group(1)
            title, company, years, kind = self.JOBS[jid]
            action = "<button disabled>Applied</button>" if jid in self.applied else '<button id="apply">Apply</button>'
            on_apply = {
                "direct": f"""post({{}}).then(() => {{ b.outerHTML = '<button>Applied</button>';
                  document.body.insertAdjacentHTML('beforeend', '<div class="modal"><p>Similar jobs</p><button>Apply to 5 jobs</button>' +
                    '<button id="nope">Not now</button></div>');
                  document.getElementById('nope').onclick = () => {{ fetch('/api/dismiss/{jid}', {{method: 'POST'}}); document.querySelector('.modal').remove(); }}; }});""",
                "dialog": """modal([['notice', 'What is your notice period?']], 'Submit', v => post(v).then(() => {
                  document.getElementById('apply').outerHTML = '<button>Applied</button>'; return 'Thanks!'; }));""",
            }.get(kind, "")
            script = f"""{REACT_TAGS}<script>{MODAL_JS}
              const post = data => fetch('/api/apply/{jid}', {{method: 'POST', body: JSON.stringify(data)}});
              const b = document.getElementById('apply');
              if (b) b.addEventListener('click', () => {{ {on_apply} }});</script>"""
            body = f"<h1>{title}</h1><p>{company}, Bangalore. {years} yrs.</p>{action}<p>About the role: Python, ML.</p>"
            return route.fulfill(body=page(f"{title} job at {company} - Instahyre", body, script), content_type="text/html")
        route.fulfill(status=404, body="not found")


class Wellfound:
    JOBS = {  # id: (title, company, years, kind)
        "4001": ("ML Engineer", "Acme", "2", "dialog"),
        "4002": ("AI Engineer", "Faraway", "1", "location"),
        "4003": ("ML Engineer", "Senior Co", "6", "dialog"),
        "4004": ("Data Scientist", "Done Co", "2", "already"),
    }

    def __init__(self):
        self.logged_in = False
        self.applied = {"4004"}
        self.posted = {}

    def chrome(self):  # header and the left menu that every page has; its "Applied" is a link to your applications
        login = "" if self.logged_in else "<button>Log in</button>"
        return f'<header>{login}</header><nav><a href="/jobs/applications">Applied</a></nav>'

    def slug(self, jid):
        return f"/jobs/{jid}-{re.sub(r'[^a-z0-9]+', '-', self.JOBS[jid][0].lower())}"

    def handle(self, route):
        req = route.request
        path = urlsplit(req.url).path
        if path.startswith("/static/"):
            return route.fulfill(path=str(CACHE / path.split("/")[-1]), content_type="text/javascript")
        if path.startswith("/api/apply/"):
            jid = path.rsplit("/", 1)[1]
            self.applied.add(jid)
            self.posted[jid] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        if path in ("/jobs", "/jobs/"):
            return route.fulfill(body=page("Startup Jobs | Wellfound", self.chrome() + "<h1>Jobs</h1><a href='/jobs/9-x'>x</a>"), content_type="text/html")
        if path == "/login":
            return route.fulfill(body=page("Log in | Wellfound", "<h1>Log in</h1>"), content_type="text/html")
        if path.startswith("/role/l/unicorn-wrangler"):
            return redirect(route, "https://wellfound.com/jobs")
        if path.startswith("/role/"):
            rows = "".join(
                f'<div class="row"><div><a href="{self.slug(j)}?ref=role">{t}</a></div><div>{c}</div><div>{y} years of exp</div>'
                f'<button>Save</button></div>' for j, (t, c, y, _) in self.JOBS.items())
            return route.fulfill(body=page("Machine Learning Engineer Jobs in India | Wellfound", self.chrome() + f"<main><div class=list>{rows}</div></main>"), content_type="text/html")
        m = re.match(r"^/jobs/(\d+)-", path)
        if m and m.group(1) in self.JOBS:
            jid = m.group(1)
            title, company, years, kind = self.JOBS[jid]
            action = "<button>Applied</button>" if jid in self.applied else '<button id="apply">Apply Now</button>'
            on_apply = {
                "dialog": """modal([['why', 'What interests you about working for this company?', 'textarea']], 'Send application',
                  v => post(v).then(() => 'Application sent'));""",
                "location": """document.body.insertAdjacentHTML('beforeend',
                  '<div role="dialog"><p>This company is not accepting applications from your location.</p><button>Close</button></div>');""",
            }.get(kind, "")
            script = f"""{REACT_TAGS}<script>{MODAL_JS}
              const post = data => fetch('/api/apply/{jid}', {{method: 'POST', body: JSON.stringify(data)}});
              const b = document.getElementById('apply');
              if (b) b.addEventListener('click', () => {{ {on_apply} }});</script>"""
            heading = f"{title} at {company}" if self.logged_in else title
            similar = '<section><h2>Similar jobs</h2><div>Other Co <button>Apply</button></div></section>'
            body = f"{self.chrome()}<h1>{heading}</h1><p>{years} years of exp. Remote OK.</p>{action}{similar}"
            return route.fulfill(body=page(f"{title} at {company} • Wellfound", body, script), content_type="text/html")
        route.fulfill(status=404, body="not found")


class Cutshort:
    CARDS = {  # id: (title, company, years, kind)
        "ML-Engineer-Acme-abc123": ("ML Engineer", "Acme", "1 - 3", "message"),
        "Senior-ML-Engineer-Big-def456": ("Senior ML Engineer", "Big Co", "1 - 3", "message"),
        "Backend-Developer-Beta-ghi789": ("Backend Developer", "Beta", "1 - 2", "city"),
        "Python-Developer-Gamma-jkl012": ("Python Developer", "Gamma", "0 - 2", "direct"),
    }
    SKILLS = {"FastAPI": "06785", "Machine Learning (ML)": "00268", "Machine Learning Ops": "09999"}

    def __init__(self):
        self.logged_in = False
        self.applied = set()
        self.posted = {}
        self.popups = {"survey": 0, "feedback": 0}

    def card(self, cid):
        title, company, years, kind = self.CARDS[cid]
        act = "<span>View conversation</span>" if cid in self.applied else '<button class="apply">Apply now</button>'
        return (f'<div class="card" data-id="{cid}" data-kind="{kind}"><div><a href="/job/{cid}?ref=feed">{title}</a></div>'
                f'<div><a href="/company/{company.lower()}">{company}</a></div><div>{years} yrs · Bangalore</div><div class="act">{act}</div></div>')

    def handle(self, route):
        req = route.request
        path = urlsplit(req.url).path
        if path.startswith("/api/apply/"):
            cid = path.rsplit("/", 1)[1]
            self.applied.add(cid)
            self.posted[cid] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        if path.startswith("/api/popup/"):
            self.popups[path.rsplit("/", 1)[1]] += 1
            return route.fulfill(json={"ok": True})
        login = "" if self.logged_in else "<button>Candidate login</button>"
        if path == "/jobs":
            return route.fulfill(body=page("Jobs | Cutshort", f"<header>{login}</header><h1>Jobs</h1>"), content_type="text/html")
        if path.startswith("/profile/all-jobs"):
            if not self.logged_in:
                return route.fulfill(body=page("Cutshort", f"<header>{login}</header><p>Log in to see your feed.</p>"), content_type="text/html")
            cards = "".join(self.card(c) for c in self.CARDS)
            script = f"""<script>
const SKILLS = {json.dumps(self.SKILLS)};
const post = (id, data) => fetch('/api/apply/' + id, {{method: 'POST', body: JSON.stringify(data || {{}})}});
const done = (card, text) => {{ card.querySelector('.act').innerHTML = '<span>' + text + '</span>'; }};
function dialog(card, field) {{
  const d = document.body.appendChild(document.createElement('div'));
  d.setAttribute('role', 'dialog');
  d.innerHTML = '<p>Your resume: resume.pdf</p>' + field + '<button class="send">Send</button><button class="x">×</button>';
  const close = () => {{ d.remove(); document.removeEventListener('keydown', esc); }};
  const esc = e => {{ if (e.key === 'Escape') close(); }};
  document.addEventListener('keydown', esc);
  d.querySelector('.x').onclick = close;
  d.querySelector('.send').onclick = () => {{
    const box = d.querySelector('textarea, input');
    if (!box.value) return;
    post(card.dataset.id, {{ message: box.value }}).then(() => {{ close(); done(card, 'View conversation'); }});
  }};
}}
document.addEventListener('click', e => {{
  const b = e.target.closest('button.apply');
  if (!b) return;
  const card = b.closest('.card');
  if (card.dataset.kind === 'direct') post(card.dataset.id).then(() => done(card, 'Applied'));
  if (card.dataset.kind === 'message') dialog(card, '<label for=m>Message to the recruiter</label><textarea id=m></textarea>');
  if (card.dataset.kind === 'city') dialog(card, '<input type=text placeholder="Start typing a city">');
}});
// the Skills filter: the id goes into the address, the way Cutshort's does
document.getElementById('skills').onclick = () => {{ document.getElementById('skill-box').style.display = 'block'; }};
document.querySelector('#skill-box input').addEventListener('input', e => {{
  const q = e.target.value.toLowerCase();
  const list = document.getElementById('skill-options');
  list.innerHTML = '';
  for (const [name, id] of Object.entries(SKILLS)) if (q && name.toLowerCase().includes(q)) {{
    const o = list.appendChild(document.createElement('div'));
    o.textContent = name;
    o.onclick = () => history.pushState(null, '', '?skills=' + id);
  }}
}});
// what Cutshort pops up over the feed
document.body.insertAdjacentHTML('beforeend', '<div id="survey"><p>Quick survey</p><button aria-label="Close survey">×</button></div>' +
  '<div id="feedback"><p>Submit feedback to companies</p><p class="co">Acme</p><button>Skip</button></div>');
document.querySelector('[aria-label="Close survey"]').onclick = () => {{ document.getElementById('survey').remove(); fetch('/api/popup/survey', {{method: 'POST'}}); }};
let steps = 2;
document.querySelector('#feedback button').onclick = () => {{
  fetch('/api/popup/feedback', {{method: 'POST'}});
  if (--steps) document.querySelector('#feedback .co').textContent = 'Beta'; else document.getElementById('feedback').remove();
}};
</script>"""
            filters = ('<div class="filters"><span id="skills">Skills</span><div id="skill-box" style="display:none">'
                       '<input type="text" placeholder="Search skills"><div id="skill-options"></div></div></div>')
            return route.fulfill(body=page("All jobs | Cutshort", f"<header>{login}</header>{filters}<main>{cards}</main>", script), content_type="text/html")
        route.fulfill(status=404, body="not found")


class Check:
    def __init__(self, dash):
        self.dash = dash
        self.failures = 0

    def __call__(self, ok, what):
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")
        self.failures += not ok

    def run(self, site):
        return self.dash.evaluate(f"async () => (await chrome.storage.session.get('run:{site}'))['run:{site}'] || null")

    def jobs(self):
        return self.dash.evaluate("async () => (await chrome.storage.local.get('jobs')).jobs || {}")

    def status(self, site, jid):
        r = self.jobs().get(f"{site}:{jid}")
        return r and r["status"]

    def note(self, site, jid):
        return (self.jobs().get(f"{site}:{jid}") or {}).get("note", "")

    def overview(self, site):
        self.dash.evaluate(f"location.hash = '#overview/{site}'")
        self.dash.wait_for_function(f"document.getElementById('site-name').textContent.toLowerCase() === {json.dumps(site)}")

    def start(self, site, act):
        self.overview(site)
        self.dash.click(f'.bot [data-act="{act}"]')
        end = time.time() + 20
        while not ((s := self.run(site)) and s["running"]) and time.time() < end:
            time.sleep(0.2)

    def wait_done(self, site, timeout=240):
        end = time.time() + timeout
        while time.time() < end:
            s = self.run(site)
            if s and not s["running"]:
                return s
            time.sleep(0.5)
        s = self.run(site) or {}
        raise AssertionError(f"{site} run didn't finish (doing: {s.get('now')!r}, asking: {s.get('prompt')}):\n" + "\n".join(s.get("log", [])))

    def wait_prompt(self, title):
        box = self.dash.locator(".bot .prompt")
        box.wait_for(state="visible", timeout=60000)
        self(title in box.inner_text(), f"dashboard asks: {title!r}")

    def answer(self, label):
        self.dash.locator(".bot .prompt button", has_text=label).click()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    CACHE.mkdir(exist_ok=True)
    for name, url in REACT.items():
        if not (CACHE / name).exists():
            urllib.request.urlretrieve(url, CACHE / name)

    ih, wf, cs = Instahyre(), Wellfound(), Cutshort()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=not args.headed,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        ctx.route(re.compile(r"^https://(www\.)?instahyre\.com/"), fake(ih.handle))
        ctx.route(re.compile(r"^https://(www\.)?wellfound\.com/"), fake(wf.handle))
        ctx.route(re.compile(r"^https://(www\.)?cutshort\.io/"), fake(cs.handle))
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
            Object.assign(s.profile, { minExperience: 1, maxExperience: 2, coverNote: "Keen on {title} at {company}.",
              answers: [["notice period", "30 days"], ["phone", ""]] });
            Object.assign(s.sites.instahyre, { keywords: ["python"], searchUrls: [] });
            Object.assign(s.sites.instahyre.limits, { delaySeconds: [0, 0], maxScrolls: 2 });
            Object.assign(s.sites.wellfound, { keywords: ["machine learning engineer", "unicorn wrangler"], locations: ["india"], searchUrls: [] });
            Object.assign(s.sites.wellfound.limits, { delaySeconds: [0, 0], maxPages: 2 });
            Object.assign(s.sites.cutshort, { keywords: ["machine learning", "fastapi", "unicorn"], searchUrls: [] });
            Object.assign(s.sites.cutshort.limits, { delaySeconds: [0, 0], maxPages: 2 });
            await JB.store.saveSettings(s);
        }""")

        print("\nThe dashboard has every site")
        names = dash.eval_on_selector_all("#site-list li a", "els => els.map(a => a.childNodes[1].textContent)")
        check(names == ["Hirist", "Instahyre", "Wellfound", "Cutshort", "LinkedIn"], f"sidebar lists the sites ({names})")
        check.overview("instahyre")
        check(dash.locator("#site-list a[aria-current]").inner_text().startswith("Instahyre"), "sidebar marks the site shown")

        print("\nInstahyre: dry run, logged out")
        check.start("instahyre", "dry-run")
        s = check.wait_done("instahyre")
        log = "\n".join(s["log"])
        check("Not logged in to Instahyre: fine for a dry run." in log, "dry run goes ahead without a login")
        check([q.get("years") for q in ih.searches[:2]] == [["1"], ["2"]], "searches each year of the experience range")
        check("4 jobs listed, 3 new and matching" in log, "scrolling loads the rest of the results; the 5 - 9 yrs job is filtered out")
        check(re.findall(r"~ would apply\s+(.+?) @", log)[:3] == ["ML Engineer", "Backend Developer", "Python Developer"], "would apply to the 3 matching jobs, in order")

        print("\nInstahyre: apply, logging in when asked")
        check.start("instahyre", "apply")
        check.wait_prompt("Log in, then continue")
        ih.logged_in = True
        check.answer("Done, continue")
        s = check.wait_done("instahyre")
        check(check.status("instahyre", "3001") == "applied", "direct apply")
        check("3001" in ih.dismissed, "the \"Apply to 5 jobs\" offer is turned down")
        check(check.status("instahyre", "3002") == "applied" and ih.posted.get("3002") == {"notice": "30 days"}, "question dialog answered and sent")
        check(check.status("instahyre", "3003") == "already_applied", "already applied")
        check(check.status("instahyre", "3004") is None, "senior job never opened")
        check("Done: applied to 2." in "\n".join(s["log"]), "run summary")

        print("\nWellfound: dry run, logged out")
        check.start("wellfound", "dry-run")
        s = check.wait_done("wellfound")
        log = "\n".join(s["log"])
        check("Not logged in to Wellfound: fine for a dry run." in log, "dry run goes ahead without a login")
        check("Wellfound has no such role page (went to https://wellfound.com/jobs), skipping." in log, "unknown role skipped")
        check("4 jobs listed, 3 new and matching" in log and "No more jobs for this search." in log, "6 years of exp filtered out; page 2 repeating ends the search")

        print("\nWellfound: apply")
        wf.logged_in = True
        check.start("wellfound", "apply")
        s = check.wait_done("wellfound")
        check(check.status("wellfound", "4001") == "applied" and wf.posted.get("4001") == {"why": "Keen on ML Engineer at Acme."},
              f"cover note written into the dialog and sent ({wf.posted.get('4001')})")
        check(check.status("wellfound", "4002") == "skipped" and check.note("wellfound", "4002") == "company doesn't hire from your location",
              "a company that won't hire from your location is skipped")
        check(check.status("wellfound", "4004") == "already_applied", "already applied (the menu's Applied link doesn't count)")
        check(check.status("wellfound", "4003") is None, "senior job never opened")
        titles = [r["title"] for k, r in check.jobs().items() if k.startswith("wellfound:")]
        check("ML Engineer" in titles and not any(t.endswith(" at Acme") for t in titles), "job titles read without the \"at <company>\"")

        print("\nCutshort: dry run needs a login (the feed only shows logged in)")
        check.start("cutshort", "dry-run")
        check.wait_prompt("Log in, then continue")
        cs.logged_in = True
        check.answer("Done, continue")
        s = check.wait_done("cutshort")
        log = "\n".join(s["log"])
        check("Cutshort has no skill called 'unicorn', skipping it." in log, "a keyword Cutshort has no skill for is skipped")
        kept = dash.evaluate("async () => (await chrome.storage.local.get('cache:cutshort:skills'))['cache:cutshort:skills']")
        check(kept == {"fastapi": "06785"}, f"FastAPI looked up in the Skills filter and remembered ({kept})")
        check("skills=00268" in log and "skills=06785" in log, "one feed per skill")
        check("4 jobs on page, 4 new" in log and "No more jobs on this feed." in log, "reads the cards; page 2 repeating ends the feed")
        check(check.status("cutshort", "Senior-ML-Engineer-Big-def456") == "skipped", "Senior title skipped")
        check(re.findall(r"~ would apply\s+(.+?) @", log)[:3] == ["ML Engineer", "Backend Developer", "Python Developer"], "would apply to the other 3")
        check(cs.popups["survey"] > 0 and cs.popups["feedback"] >= 2, f"survey and feedback pop-ups closed ({cs.popups})")
        check(not cs.posted, "dry run applied to nothing")

        print("\nCutshort: apply from the cards")
        check.start("cutshort", "apply")
        s = check.wait_done("cutshort")
        log = "\n".join(s["log"])
        check(check.status("cutshort", "ML-Engineer-Acme-abc123") == "applied" and cs.posted.get("ML-Engineer-Acme-abc123") == {"message": "Keen on ML Engineer at Acme."},
              f"message dialog filled with the cover note and sent ({cs.posted.get('ML-Engineer-Acme-abc123')})")
        check(check.status("cutshort", "Backend-Developer-Beta-ghi789") == "needs_manual" and check.note("cutshort", "Backend-Developer-Beta-ghi789") == "unanswered: Start typing a city",
              "a question it can't answer is left for you")
        check(check.status("cutshort", "Python-Developer-Gamma-jkl012") == "applied", "applied straight from the card, after closing the half-filled dialog")
        check(re.search(r"\d+ jobs on page, 0 new", log) and "Done: applied to 2." in log, "the second skill's feed has nothing new; summary")

        print("\nBringing over remembered skill ids")
        dash.evaluate("""() => chrome.runtime.sendMessage({ type: "import", history: [], cache: { "cache:cutshort:skills": { django: "00136", fastapi: "11111" } } })""")
        kept = dash.evaluate("async () => (await chrome.storage.local.get('cache:cutshort:skills'))['cache:cutshort:skills']")
        check(kept == {"django": "00136", "fastapi": "06785"}, f"imported ids added; ones found here kept ({kept})")

        print("\nBoth sites at once")
        dash.evaluate("async () => { await chrome.storage.local.set({ jobs: {} }); }")
        check.start("instahyre", "dry-run")
        check.start("wellfound", "dry-run")
        a, b = check.wait_done("instahyre"), check.wait_done("wellfound")
        check("Done: would apply to 6." in "\n".join(a["log"]) and "Done: would apply to 3." in "\n".join(b["log"]), "two runs side by side, each in its own window")

        print("\nSettings for each site")
        dash.evaluate("location.hash = '#settings'")
        tabs = dash.eval_on_selector_all("#site-tabs button", "els => els.map(b => b.textContent)")
        check(tabs == ["Hirist", "Instahyre", "Wellfound", "Cutshort", "LinkedIn"], "a tab per site")
        dash.click("#site-tab-wellfound")
        check(dash.locator('[name="sites.wellfound.locations"]').is_visible(), "Wellfound has places to search")
        dash.fill('[name="sites.wellfound.locations"]', "india\nremote\nbangalore")
        dash.click("#site-tab-instahyre")
        check(dash.locator('[name="sites.instahyre.limits.maxScrolls"]').is_visible(), "Instahyre has scrolls instead of pages")
        dash.click("#save")
        saved = dash.evaluate("async () => (await JB.store.getSettings()).sites.wellfound.locations")
        check(saved == ["india", "remote", "bangalore"], "saved per site")
        dash.evaluate("location.hash = '#history'")
        dash.select_option("#history-site", "wellfound")
        dash.click('.chip[data-status=""]')
        check(all("Instahyre" not in r for r in dash.eval_on_selector_all("#history-rows tr", "els => els.map(e => e.innerText)")), "history filters by site")

        check(not errors, f"no errors on the dashboard page {errors}")
        ctx.close()

    print(f"\n{'All passed.' if not check.failures else f'{check.failures} FAILED.'}")
    sys.exit(1 if check.failures else 0)


if __name__ == "__main__":
    main()
