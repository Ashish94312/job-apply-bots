#!/usr/bin/env python3
"""End-to-end test for Instahyre and Wellfound: the extension in a real Chromium, on fake copies of both sites.

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
        self.dash.wait_for_function(f"document.getElementById('site-name').textContent === {json.dumps(site.capitalize())}")

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
        raise AssertionError(f"{site} run didn't finish:\n" + "\n".join((self.run(site) or {}).get("log", [])))

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

    ih, wf = Instahyre(), Wellfound()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=not args.headed,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        ctx.route(re.compile(r"^https://(www\.)?instahyre\.com/"), fake(ih.handle))
        ctx.route(re.compile(r"^https://(www\.)?wellfound\.com/"), fake(wf.handle))
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
            await JB.store.saveSettings(s);
        }""")

        print("\nThe dashboard has every site")
        names = dash.eval_on_selector_all("#site-list li a", "els => els.map(a => a.childNodes[1].textContent)")
        check(names == ["Hirist", "Instahyre", "Wellfound"], f"sidebar lists the sites ({names})")
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

        print("\nBoth sites at once")
        dash.evaluate("async () => { await chrome.storage.local.set({ jobs: {} }); }")
        check.start("instahyre", "dry-run")
        check.start("wellfound", "dry-run")
        a, b = check.wait_done("instahyre"), check.wait_done("wellfound")
        check("Done: would apply to 6." in "\n".join(a["log"]) and "Done: would apply to 3." in "\n".join(b["log"]), "two runs side by side, each in its own window")

        print("\nSettings for each site")
        dash.evaluate("location.hash = '#settings'")
        tabs = dash.eval_on_selector_all("#site-tabs button", "els => els.map(b => b.textContent)")
        check(tabs == ["Hirist", "Instahyre", "Wellfound"], "a tab per site")
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
