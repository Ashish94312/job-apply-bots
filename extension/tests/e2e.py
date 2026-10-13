#!/usr/bin/env python3
"""End-to-end test: the extension in a real Chromium, applying on a fake Hirist (real React forms).

  .venv/bin/python extension/tests/e2e.py            # headless
  .venv/bin/python extension/tests/e2e.py --headed   # watch it

Needs Playwright's own Chromium (branded Chrome can't load an unpacked extension from the command line):
  .venv/bin/playwright install chromium
React is fetched once from unpkg into extension/tests/.cache.
"""
import argparse
import json
import re
import shutil
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
EXT = HERE.parent
CACHE = HERE / ".cache"
REACT = {
    "react.js": "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
    "react-dom.js": "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
}

# ---------------------------------------------------------------- the fake Hirist

JOBS = {  # id: (company, title, experience, kind)
    "2001": ("Nice Co", "Python Developer", "1 - 3", "direct"),
    "2002": ("Good Co", "Backend Engineer", "1 - 2", "screening"),
    "2003": ("Hard Co", "AI Engineer", "0 - 2", "screening-hard"),
    "2004": ("Ext Co", "ML Engineer", "1 - 3", "external"),
    "2005": ("Old Co", "Python Developer", "5 - 8", "direct"),
    "2006": ("Big Co", "Senior Backend Engineer", "1 - 3", "direct"),
    "2007": ("Done Co", "Python Engineer", "1 - 3", "already"),
    "2008": ("Modal Co", "Django Developer", "1 - 3", "dialog"),
    "2009": ("Nine Co", "Backend Developer", "1 - 3", "direct"),
    "2010": ("Ten Co", "Python Developer", "1 - 3", "direct"),
    "2011": ("Eleven Co", "Python Developer", "1 - 3", "direct"),
    "2012": ("Twelve Co", "Python Developer", "1 - 3", "direct"),
}


class Hirist:
    def __init__(self):
        self.logged_in = False
        self.listed = ["2001", "2002", "2003", "2004", "2005", "2006", "2007", "2008"]
        self.applied = {"2007"}
        self.posted = {}  # job id -> what its form sent
        self.pages = []

    def slug(self, jid):
        company, title, _, _ = JOBS[jid]
        return re.sub(r"[^a-z0-9]+", "-", f"{company} {title}".lower()).strip("-") + f"-{jid}"

    def header(self):
        return f"<header><button>{'My Profile' if self.logged_in else 'Login'}</button></header>"

    def page(self, title, body, scripts=""):
        return (f"<!doctype html><html><head><meta charset=utf-8><title>{title}</title></head><body>{self.header()}"
                f"{body}{scripts}</body></html>")

    def search(self):
        cards = "".join(
            f'<a href="/j/{self.slug(j)}?ref=sp_br"><b>{JOBS[j][0]} - {JOBS[j][1]}</b> {JOBS[j][2]} yrs Bangalore</a><br>'
            for j in self.listed
        )
        return self.page("Search for - Python Jobs | hirist.tech", f"<main>{cards}</main>")

    def job(self, jid):
        company, title, exp, kind = JOBS[jid]
        if jid in self.applied:
            action = "<button disabled>Applied</button>"
        else:
            action = '<button id="apply">Apply</button><div id="modal"></div>'
        on_apply = {
            "direct": "post({}).then(() => { b.outerHTML = '<button>Applied</button><p>Applied successfully</p>'; });",
            "screening": f"location.href = '/screening/{jid}';",
            "screening-hard": f"location.href = '/screening/{jid}';",
            "external": f"window.open('https://careers.example.com/jobs/{jid}', '_blank');",
            "dialog": "openModal();",
        }.get(kind, "")
        script = f"""<script src="/static/react.js"></script><script src="/static/react-dom.js"></script><script>
const post = data => fetch('/api/apply/{jid}', {{method: 'POST', body: JSON.stringify(data)}});
const b = document.getElementById('apply');
if (b) b.addEventListener('click', () => {{ {on_apply} }});
function openModal() {{
  const e = React.createElement;
  function Modal() {{
    const [notice, setNotice] = React.useState('');
    const [done, setDone] = React.useState(false);
    if (done) return null;
    return e('div', {{role: 'dialog', 'aria-modal': 'true', style: {{border: '1px solid', padding: 10}}}},
      e('label', {{htmlFor: 'm-notice'}}, 'What is your notice period?'),
      e('input', {{id: 'm-notice', value: notice, onChange: ev => setNotice(ev.target.value)}}),
      e('button', {{disabled: !notice, onClick: () => post({{notice}}).then(() => {{
        setDone(true); document.getElementById('apply').outerHTML = '<button>Applied</button>'; }})}}, 'Submit'));
  }}
  ReactDOM.createRoot(document.getElementById('modal')).render(e(Modal));
}}
</script>"""
        body = (f"<main><h1>{company} - {title}</h1><p>{exp} yrs · Bangalore</p>{action}"
                f"<section><h2>Job description</h2><p>Build things with Python. Great team.</p></section></main>")
        return self.page(f"{company} - {title} - {company} Pvt Ltd | hirist.tech", body, script)

    def screening(self, jid):
        company, title, _, kind = JOBS[jid]
        hard = "true" if kind == "screening-hard" else "false"
        script = f"""<script src="/static/react.js"></script><script src="/static/react-dom.js"></script><script>
const e = React.createElement, HARD = {hard};
function App() {{
  const [join, setJoin] = React.useState(''), [notice, setNotice] = React.useState('');
  const [ctc, setCtc] = React.useState(''), [colour, setColour] = React.useState('');
  const ready = join && notice && ctc && (!HARD || colour);
  const submit = () => fetch('/api/apply/{jid}', {{method: 'POST', body: JSON.stringify({{join, notice, ctc, colour}})}})
    .then(() => {{ location.href = '/j/{self.slug(jid)}'; }});
  return e('div', null,
    e('h2', null, 'Before you submit your application, tell the recruiter more about yourself'),
    e('div', {{className: 'q'}}, e('p', null, '1. Can you join immediately? *'),
      e('div', {{className: 'opts'}}, ['Yes', 'No'].map(v => e('label', {{key: v}},
        e('input', {{type: 'radio', name: 'q1', value: v, checked: join === v, onChange: () => setJoin(v)}}), ' ' + v)))),
    e('div', {{className: 'q'}}, e('label', {{htmlFor: 'notice'}}, '2. What is your notice period?'),
      e('input', {{id: 'notice', value: notice, onChange: ev => setNotice(ev.target.value)}})),
    e('div', {{className: 'q'}}, e('label', {{htmlFor: 'ctc'}}, '3. What is your expected CTC (LPA)?'),
      e('input', {{id: 'ctc', type: 'number', value: ctc, onChange: ev => setCtc(ev.target.value)}})),
    HARD && e('div', {{className: 'q'}}, e('label', {{htmlFor: 'colour'}}, '4. Describe your favourite colour'),
      e('textarea', {{id: 'colour', value: colour, onChange: ev => setColour(ev.target.value)}})),
    e('button', {{disabled: !ready, onClick: submit}}, 'Next'));
}}
ReactDOM.createRoot(document.getElementById('root')).render(e(App));
</script>"""
        return self.page(f"Apply - {company} | hirist.tech", f"<h1>You are Applying to: {company} - {title}</h1><div id=root></div>", script)

    def handle(self, route):
        req = route.request
        url = req.url
        path = re.sub(r"^https://(www\.)?hirist\.tech", "", url).split("?")[0]
        self.pages.append(path)
        html = None
        if path.startswith("/static/"):
            return route.fulfill(path=str(CACHE / path.split("/")[-1]), content_type="text/javascript")
        if path.startswith("/api/apply/") and req.method == "POST":
            jid = path.rsplit("/", 1)[1]
            self.applied.add(jid)
            self.posted[jid] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        if path in ("/", ""):
            html = self.page("hirist.tech", "<main>Jobs for techies</main>")
        elif path.startswith("/search/"):
            html = self.search()
        elif m := re.match(r"^/j/.*-(\d+)$", path):
            html = self.job(m.group(1)) if m.group(1) in JOBS else None
        elif m := re.match(r"^/screening/(\d+)$", path):
            html = self.screening(m.group(1))
        if html is None:
            return route.fulfill(status=404, body="not found")
        route.fulfill(body=html, content_type="text/html; charset=utf-8")


# ---------------------------------------------------------------- driving the extension

class Test:
    def __init__(self, ctx, dash, site):
        self.ctx, self.dash, self.site = ctx, dash, site
        self.failures = 0

    def check(self, ok, what):
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")
        self.failures += not ok

    def run_state(self):
        return self.dash.evaluate("async () => (await chrome.storage.session.get('run:hirist'))['run:hirist'] || null")

    def jobs(self):
        return self.dash.evaluate("async () => (await chrome.storage.local.get('jobs')).jobs || {}")

    def status(self, jid):
        r = self.jobs().get(f"hirist:{jid}")
        return r and r["status"]

    def set_settings(self, **changes):
        self.dash.evaluate("""async changes => {
            const s = await JB.store.getSettings();
            Object.assign(s.profile, changes.profile || {});
            Object.assign(s.sites.hirist, changes.site || {});
            Object.assign(s.sites.hirist.limits, changes.limits || {});
            await JB.store.saveSettings(s);
        }""", changes)

    def page(self, name):
        if not self.dash.locator(f"#page-{name}").is_visible():
            self.dash.click(f"#nav-{name}")

    def click(self, act):
        self.page("overview")
        self.dash.click(f'.bot [data-act="{act}"]')

    def cells(self):
        return self.dash.eval_on_selector_all("#strip .cell", "els => els.map(e => e.className.replace('cell s-', ''))")

    def wait_running(self, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            s = self.run_state()
            if s and s["running"]:
                return s
            time.sleep(0.2)
        raise AssertionError("run didn't start")

    def wait_done(self, timeout=240):
        end = time.time() + timeout
        while time.time() < end:
            s = self.run_state()
            if s and not s["running"]:
                return s
            time.sleep(0.5)
        raise AssertionError(f"run didn't finish; log so far:\n" + "\n".join((self.run_state() or {}).get("log", [])))

    def wait_prompt(self, title, timeout=60):
        box = self.dash.locator(".bot .prompt")
        box.wait_for(state="visible", timeout=timeout * 1000)
        text = box.inner_text()
        self.check(title in text, f"dashboard asks: {title!r}")
        return box

    def answer(self, label):
        self.dash.locator(".bot .prompt button", has_text=label).click()

    def log(self, state):
        return "\n".join(state["log"])


BOT_TABS_JS = """async () => (await chrome.tabs.query({}))
    .filter(t => /hirist\\.tech|example\\.com/.test(t.url || t.pendingUrl || "")).map(t => t.id)"""


def bot_tabs(dash):
    """The bot's tabs, asked of Chrome itself: Playwright doesn't see windows an extension opens."""
    return dash.evaluate(BOT_TABS_JS)


def launch(pw, ext, profile, headed, site):
    """Chromium with the extension, the fake Hirist in place of the real one; returns (context, dashboard page)."""
    ctx = pw.chromium.launch_persistent_context(
        str(profile), channel="chromium", headless=not headed,
        args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"],
    )
    ctx.route(re.compile(r"^https://(www\.)?hirist\.tech/"), site.handle)
    ctx.route("https://careers.example.com/**", lambda r: r.fulfill(body="<h1>Careers</h1>", content_type="text/html"))
    worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    dash_url = f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html"
    opened = False
    for _ in range(40):  # the extension opens its dashboard when installed
        opened = worker.evaluate(f"async () => (await chrome.tabs.query({{url: '{dash_url}'}})).length > 0")
        if opened:
            break
        time.sleep(0.5)
    dash = ctx.new_page()  # our own copy: Playwright may not see the tab the extension opened
    dash.goto(dash_url)
    dash.opened_by_extension = opened
    dash.on("dialog", lambda d: d.accept())
    return ctx, dash


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    CACHE.mkdir(exist_ok=True)
    for name, url in REACT.items():
        if not (CACHE / name).exists():
            urllib.request.urlretrieve(url, CACHE / name)

    site = Hirist()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx, dash = launch(pw, EXT, profile, args.headed, site)
        t = Test(ctx, dash, site)
        t.check(dash.opened_by_extension, "dashboard opens when the extension is installed")
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector(".bot h2")
        t.check(dash.locator("#first-run").is_visible(), "first-run banner shows until settings are saved")

        t.set_settings(
            profile={"answers": [["notice period", "30 days"], ["expect.*(ctc|salary|compensation)", "12 LPA"],
                                 ["immediate(ly)? join|join immediately", "Yes"], ["phone", ""]]},
            site={"keywords": ["python"], "searchUrls": []},
            limits={"delaySeconds": [0, 0], "maxPages": 2, "maxPerDay": 30, "maxPerRun": 10},
        )
        dash.wait_for_selector("#first-run", state="hidden")
        t.check(True, "first-run banner goes once settings are saved")

        print("\nDry run, logged out")
        t.click("dry-run")
        s = t.wait_done()
        log = t.log(s)
        t.check("Not logged in to Hirist: fine for a dry run." in log, "dry run goes ahead without a login")
        would = re.findall(r"~ would apply\s+(.+?) @", log)
        t.check(would == ["Python Developer", "Backend Engineer", "AI Engineer", "ML Engineer", "Python Engineer", "Django Developer"],
                f"would apply to the 6 matching jobs, in the site's order ({would})")
        t.check("Old Co" not in log and site.pages.count(f"/j/{site.slug('2005')}") == 0, "5 - 8 yrs job skipped from the search page, unopened")
        t.check(t.status("2006") == "skipped" and "title has 'senior'" in t.jobs()["hirist:2006"]["note"], "Senior title skipped after opening")
        t.check("Done: would apply to 6." in log, "dry run summary")
        t.check(not site.posted, "dry run applied to nothing")
        t.check(t.cells() == ["would_apply", "would_apply", "would_apply", "would_apply", "filtered", "skipped", "would_apply", "would_apply"],
                f"run strip shows each job on the page ({t.cells()})")
        t.check(dash.locator("#events li").count() == 8 and "Searched “python”" in dash.locator("#events").inner_text(),
                "activity lists the search and each job")
        t.check(not bot_tabs(dash), "the bot's window closes after the run")

        print("\nApply, logging in when asked")
        t.click("apply")
        t.wait_prompt("Log in, then continue")
        t.check(dash.locator(".bot").get_attribute("data-state") == "waiting", "card shows it's waiting for you")
        site.logged_in = True
        t.answer("Done, continue")
        s = t.wait_done()
        log = t.log(s)
        jobs = t.jobs()
        t.check(t.status("2001") == "applied", "direct apply")
        t.check(t.status("2002") == "applied" and site.posted.get("2002") == {"join": "Yes", "notice": "30 days", "ctc": "12", "colour": ""},
                f"React screening form filled: radio, text, number ({site.posted.get('2002')})")
        t.check(t.status("2003") == "needs_manual" and "Describe your favourite colour" in jobs["hirist:2003"]["note"],
                f"unanswerable question left for you ({jobs.get('hirist:2003', {}).get('note')})")
        t.check(jobs.get("hirist:2003", {}).get("shot") is False, "no screenshot unless you allow them")
        t.check(t.status("2004") == "external" and "careers.example.com/jobs/2004" in jobs["hirist:2004"]["note"],
                f"external apply recorded with its URL ({jobs.get('hirist:2004', {}).get('note')})")
        t.check(t.status("2007") == "already_applied", "already applied")
        t.check(t.status("2008") == "applied" and site.posted.get("2008") == {"notice": "30 days"}, "apply dialog filled and submitted")
        t.check("Done: applied to 3." in log, "run summary")
        t.check(t.cells() == ["applied", "applied", "needs_manual", "external", "filtered", "seen", "already_applied", "applied"],
                f"run strip shows how each job went ({t.cells()})")
        t.check("Couldn't answer: Describe your favourite colour" in dash.locator("#events").inner_text(), "activity says what it couldn't answer")
        t.check("Applies on the company's site: careers.example.com/jobs/2004" in dash.locator("#events").inner_text(), "activity names the other site")
        t.check("Last run finished" in dash.locator(".bot .status").inner_text(), "header says the run finished")
        t.check(not bot_tabs(dash), "the bot's window closes after the run")

        print("\nHistory on the dashboard")
        t.check("AI Engineer" in dash.locator("#needs-list").inner_text(), "overview lists the job that needs you")
        t.check(dash.locator("#nav-needs").inner_text() == "1", "History shows 1 needs you")
        t.page("history")
        dash.click('.chip[data-status="needs_manual"]')
        t.check("AI Engineer" in dash.locator("#history-rows").inner_text(), "Needs you filter lists the job")
        t.check(dash.locator("#history-rows button:has-text('Screenshot')").count() == 0, "no Screenshot link without one")
        t.page("overview")
        t.check(dash.locator(".today-figure").inner_text().startswith("3 of 30"), "applied today: 3 of 30")
        t.check(dash.locator("#trend-chart .col.today").count() == 1, "today's column on the 14-day chart")

        print("\nAsk before each, then stop")
        site.listed = ["2009", "2010"]
        dash.click(".bot details.opts summary")
        dash.check('.bot .opts [name="confirm"]')
        t.click("apply")
        t.wait_prompt("Apply to this one?")
        t.answer("Skip")
        dash.wait_for_function("() => !document.querySelector('.bot .prompt').hidden && document.querySelector('.bot .prompt').innerText.includes('Python Developer at Ten Co')", timeout=60000)
        t.answer("Stop run")
        s = t.wait_done()
        t.check(t.status("2009") == "skipped" and t.jobs()["hirist:2009"]["note"] == "declined", "Skip records it as declined")
        t.check(s["stopped"] and "Stopped." in t.log(s) and t.status("2010") is None, "Stop run stops before applying")
        t.check("Stopped at" in dash.locator(".bot .status").inner_text(), "card says it stopped")
        dash.click(".bot details.opts summary")
        dash.uncheck('.bot .opts [name="confirm"]')
        dash.click(".bot details.opts summary")

        print("\nDaily limit")
        t.set_settings(limits={"maxPerDay": 3})
        t.click("apply")
        s = t.wait_done()
        t.check("Daily limit reached (3)." in t.log(s), "stops at the daily limit")
        t.set_settings(limits={"maxPerDay": 30})

        print("\nClosing the bot's window")
        site.listed = ["2011"]
        t.click("apply")
        t.wait_running()
        deadline = time.time() + 30
        while not (tabs := bot_tabs(dash)) and time.time() < deadline:
            time.sleep(0.2)
        dash.evaluate("ids => chrome.tabs.remove(ids)", tabs)
        s = t.wait_done()
        t.check("Browser window was closed, stopping." in t.log(s), "notices the window was closed")

        print("\nSettings")
        t.page("settings")
        t.check(dash.locator("#shots").inner_text() == "Allow screenshots", "screenshots are off until you allow them")
        dash.fill('[name="sites.hirist.keywords"]', "python\nbackend engineer")
        dash.click("#add-answer")
        dash.locator("#answer-rows tr:last-child [data-key=pattern]").fill("(broken")
        dash.locator("#answer-rows tr:last-child [data-key=answer]").fill("x")
        dash.click("#save")
        t.check("isn't a valid regular expression" in dash.locator("#errors").inner_text(), "a broken pattern is refused")
        saved = dash.evaluate("async () => (await JB.store.getSettings()).sites.hirist.keywords")
        t.check(saved == ["python"], "nothing saved while there are errors")
        dash.locator("#answer-rows tr:last-child [data-key=pattern]").fill("hometown")
        dash.fill('[name="sites.hirist.limits.delaySeconds.0"]', "9")
        dash.fill('[name="sites.hirist.limits.delaySeconds.1"]', "3")
        dash.click("#save")
        t.check("the first not more than the second" in dash.locator("#errors").inner_text(), "pause range checked")
        dash.fill('[name="sites.hirist.limits.delaySeconds.0"]', "0")
        dash.fill('[name="sites.hirist.limits.delaySeconds.1"]', "0")
        dash.click("#save")
        s = dash.evaluate("async () => JB.store.getSettings()")
        t.check(s["sites"]["hirist"]["keywords"] == ["python", "backend engineer"] and s["profile"]["answers"][-1] == ["hometown", "x"],
                "settings saved from the form")
        t.check(dash.locator("#saved").inner_text().startswith("Saved"), "says saved")

        print("\nBring over from the Python bots")
        export = {"format": "job-apply-bots/1", "settings": s, "history": [
            {"site": "hirist", "jobId": "2012", "url": "https://www.hirist.tech/j/x-2012", "title": "Python Developer",
             "company": "Twelve Co", "status": "applied", "note": "", "ts": "2026-10-01 10:00:00"},
            {"site": "hirist", "jobId": "2001", "url": "", "title": "", "company": "", "status": "failed", "note": "", "ts": "2026-10-01 10:00:00"},
        ]}
        export["settings"]["profile"]["coverNote"] = "Imported note"
        path = Path(profile) / "import.json"
        path.write_text(json.dumps(export))
        dash.set_input_files("#import-file", str(path))
        dash.wait_for_function("() => document.querySelector('#import-status').innerText.startsWith('Done')", timeout=10000)
        t.check("1 past jobs added (1 were already here)" in dash.locator("#import-status").inner_text(), "import adds only new history")
        t.check(t.status("2001") == "applied", "import doesn't overwrite newer history")
        t.check(dash.input_value('[name="profile.coverNote"]') == "Imported note", "import replaces the settings")
        site.listed = ["2012"]
        t.click("apply")
        s = t.wait_done()
        t.check("1 jobs listed, 0 new and matching" in t.log(s) and "2012" not in site.posted, "imported jobs aren't applied to again")

        print("\nRe-check skipped jobs")
        t.page("history")
        dash.click("#recheck")
        dash.wait_for_function("() => document.querySelector('.chip[data-status=skipped] .n').innerText === '0'", timeout=10000)
        t.check(t.status("2006") is None and t.status("2009") is None, "skipped jobs forgotten")

        t.check(not errors, f"no errors on the dashboard page {errors}")
        ctx.close()

    print("\nScreenshots, once allowed")
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as tmp:
        # Chrome's permission prompt can't be clicked from a test: grant access to all sites in a copy instead.
        ext = Path(tmp) / "extension"
        shutil.copytree(EXT, ext, ignore=shutil.ignore_patterns("tests"))
        manifest = json.loads((ext / "manifest.json").read_text())
        manifest["host_permissions"].append("<all_urls>")
        (ext / "manifest.json").write_text(json.dumps(manifest))
        site = Hirist()
        site.logged_in = True
        site.listed = ["2003"]
        ctx, dash = launch(pw, ext, Path(tmp) / "profile", args.headed, site)
        t.dash = dash
        dash.wait_for_selector(".bot h2")
        t.set_settings(site={"keywords": ["python"], "searchUrls": []}, limits={"delaySeconds": [0, 0], "maxPages": 1})
        t.click("apply")
        t.wait_done()
        t.check(t.jobs().get("hirist:2003", {}).get("shot") is True, "screenshot kept for the job that needs you")
        shot = dash.evaluate("() => JB.store.shot('hirist', '2003')") or ""
        t.check(shot.startswith("data:image/jpeg"), "screenshot is an image")
        t.page("history")
        dash.click(".chip[data-status=needs_manual]")
        dash.click("#history-rows button:has-text('Screenshot')")
        t.check(dash.locator("#shot-dialog img").get_attribute("src").startswith("data:image"), "screenshot opens on the dashboard")
        dash.click("#shot-dialog button")
        t.page("settings")
        t.check(dash.locator("#shots").inner_text() == "Turn screenshots off", "dashboard shows screenshots are on")
        ctx.close()

    print(f"\n{'All passed.' if not t.failures else f'{t.failures} FAILED.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
