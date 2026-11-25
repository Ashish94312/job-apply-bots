#!/usr/bin/env python3
"""End-to-end test of Indeed in a real Chromium, on fake pages built like Indeed's: its search on the Indeed of your
country, a dry run without signing in, jobs skipped for their title or the experience they ask for, one that has
expired, one applied to before, "Apply on company site" kept with where it leads, and Indeed's application a page at
a time (contact details, resume, the employer's questions, review), opened in the same tab or a new one, with a
question it has no answer for asked once; settings saved before Indeed came; Indeed's "blocked" page, on a search and
on a job; and the Other site jobs kept without a link forgotten when the extension updates.

  .venv/bin/python extension/tests/e2e_indeed.py            # headless
  .venv/bin/python extension/tests/e2e_indeed.py --headed   # watch it
"""
import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

from e2e import EXT, sample_settings
from e2e_sites import Check, fake, page, redirect

JOBS = {  # job id: (title, company, where, what its description asks, kind)
    "a1b2c3d4e5f60001": ("ML Engineer", "Acme", "Bengaluru, Karnataka", "1-3 years of experience with Python.", "apply"),
    "a1b2c3d4e5f60002": ("Python Developer", "Beta", "Bengaluru, Karnataka", "2+ years of experience.", "apply-tab"),
    "a1b2c3d4e5f60003": ("AI Engineer", "Outside Co", "Remote", "Python, ML.", "external"),
    "a1b2c3d4e5f60004": ("Data Scientist", "Done Co", "Bengaluru, Karnataka", "Python.", "applied"),
    "a1b2c3d4e5f60005": ("Senior ML Engineer", "Big Co", "Bengaluru, Karnataka", "Python.", "apply"),
    "a1b2c3d4e5f60006": ("Backend Engineer", "Old Co", "Pune, Maharashtra", "Python.", "expired"),
    "a1b2c3d4e5f60007": ("ML Engineer", "Far Co", "Bengaluru, Karnataka", "At least 6+ years of experience building ML systems.", "apply"),
}
SMART = "https://smartapply.indeed.com/beta/indeedapply/form"

# One page of Indeed's application: its heading, boxes, and Continue; the page's answers go to the fake's server first.
FORM_JS = r"""
const jk = new URLSearchParams(location.search).get('jk');
document.querySelector('[data-testid=continue-button]').addEventListener('click', async () => {
  const f = document.querySelector('main form');
  const data = {};
  for (const e of f.elements) {
    if (!e.name || ((e.type === 'radio' || e.type === 'checkbox') && !e.checked)) continue;
    data[e.name] = e.type === 'file' ? (e.files[0] || {}).name || '' : e.value;
  }
  const missing = [...f.querySelectorAll('[required]')].filter(e => !data[e.name]).map(e => e.name);
  const error = document.getElementById('error');
  if (missing.length) { error.hidden = false; error.textContent = 'Answer this question to continue'; return; }
  await fetch('/api/step/' + jk + '/' + STEP, { method: 'POST', body: JSON.stringify(data) });
  location.href = NEXT + '?jk=' + jk;
});"""


def smart_page(step, jk, heading, fields, button="Continue", nxt=""):
    body = (f'<header><a href="https://in.indeed.com/">Indeed</a></header><main><h1>{heading}</h1><form onsubmit="return false">{fields}</form>'
            f'<div role="alert" id="error" hidden></div><button type="button" data-testid="continue-button">{button}</button></main>')
    script = f"<script>const STEP = {json.dumps(step)}, NEXT = {json.dumps(nxt)};{FORM_JS}</script>"
    return page("Indeed Apply", body, script)


def text_q(name, label, required=True, value="", type="text"):
    return f'<div><label for="{name}">{label}</label><input id="{name}" name="{name}" type="{type}" value="{value}"{" required" if required else ""}></div>'


class Indeed:
    def __init__(self):
        self.logged_in = False
        self.searches = []
        self.steps = {}  # job id -> {step: what it sent}
        self.applied = {"a1b2c3d4e5f60004"}
        self.blocked = ""  # "search" or "jobs": Indeed's "Request Blocked" page there

    def card(self, jk, sponsored=False):
        title, company, where, _, kind = JOBS[jk]
        href = f"/pagead/clk?mo=r&ad=x&jk={jk}" if sponsored else f"/rc/clk?jk={jk}&from=serp&vjs=3"
        easy = '<span data-testid="indeedApply">Easily apply</span>' if kind.startswith("apply") else ""
        return (f'<li><div class="cardOutline"><div class="job_seen_beacon"><h2 class="jobTitle"><a class="jcs-JobTitle" data-jk="{jk}" href="{href}">'
                f'<span title="{title}">{title}</span></a></h2><span data-testid="company-name">{company}</span>'
                f'<div data-testid="text-location">{where}</div>{easy}</div></div></li>')

    def search(self):
        ids = list(JOBS)
        cards = "".join(self.card(jk, sponsored=(i == 1)) for i, jk in enumerate(ids))
        return page("Machine Learning Engineer Jobs in Bengaluru | Indeed", f"<header><a>Sign in</a></header><main><ul id='mosaic'>{cards}</ul></main>")

    def job(self, jk):
        title, company, where, asks, kind = JOBS[jk]
        if jk in self.applied:
            action = '<button id="indeedApplyButton" disabled><span>Applied</span></button>'
        elif kind == "external":
            action = (f'<div id="applyButtonLinkContainer"><button href="https://in.indeed.com/applystart?jk={jk}&from=vj" '
                      f'aria-label="Apply on company site (opens in a new tab)">Apply on company site</button></div>')
        elif kind == "expired":
            action = "<p>This job has expired on Indeed</p>"
        else:
            go = f"{SMART}/contact-info?jk={jk}"
            how = f"window.open('{go}', '_blank')" if kind == "apply-tab" else f"location.href = '{go}'"
            action = f'<button id="indeedApplyButton" class="indeed-apply-button" onclick="{how}"><span>Apply now</span></button>'
        body = (f"<header><a href='https://myjobs.indeed.com/applied'>{'My jobs' if self.logged_in else 'Sign in'}</a></header><main>"
                f"<div class='jobsearch-InfoHeaderContainer'><h1 class='jobsearch-JobInfoHeader-title' data-testid='jobsearch-JobInfoHeader-title'>"
                f"<span>{title}</span><span style='position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'> - job post</span></h1>"
                f"<div data-testid='inlineHeader-companyName'><a href='/cmp/x'>{company}</a><span>4.1 out of 5 stars</span></div>"
                f"<div data-testid='inlineHeader-companyLocation'>{where}</div></div>"
                f"<div class='jobsearch-ViewJobButtons-container'>{action}</div>"
                f"<div id='jobDescriptionText'><p>About the role. {asks} Machine learning.</p></div></main>"
                f"<aside><div class='job_seen_beacon'>Another job <button>Applied</button></div></aside>")  # another job's: not this one
        return page(f"{title} - {company} - {where} - Indeed.com", body)

    def smart(self, step, jk):
        title, company, *_ = JOBS[jk]
        if step == "contact-info":
            fields = (text_q("firstName", "First name", value="Asha") + text_q("lastName", "Last name", value="Rao")
                      + text_q("phone", "Phone number") + text_q("city", "City, State (optional)", required=False))
            return smart_page(step, jk, "Add your contact information", fields, nxt=f"{SMART}/resume")
        if step == "resume":
            fields = ('<fieldset><label><input type="radio" name="resume" value="indeed" checked> Asha_Rao_Resume.pdf (Indeed resume)</label>'
                      '<label><input type="radio" name="resume" value="upload"> Upload a resume <input type="file" name="file"></label></fieldset>')
            return smart_page(step, jk, "Add a resume for the employer", fields, nxt=f"{SMART}/questions/1")
        if step == "questions/1":
            notice = ('<div><label for="q_notice">What is your notice period?</label><select id="q_notice" name="notice" required>'
                      '<option value="">Select an option</option><option>Immediately</option><option>15 days</option><option>30 days</option><option>60 days</option></select></div>')
            python = text_q("years", "How many years of experience do you have with Python?", type="number")
            hard = text_q("colour", "What is your favourite colour?") if jk == "a1b2c3d4e5f60002" else ""
            extra = text_q("cover", "Anything else you'd like to share? (optional)", required=False)
            return smart_page("questions-1", jk, f"Answer these questions from {company}", notice + python + hard + extra, nxt=f"{SMART}/review")
        if step == "review":
            return smart_page(step, jk, "Please review your application", f"<p>{title} at {company}</p>", button="Submit your application", nxt=f"{SMART}/post-apply")
        if step == "post-apply":
            if jk in self.steps and "review" in self.steps[jk]:
                self.applied.add(jk)
            return page("Indeed Apply", "<main><h1>Your application has been submitted!</h1><p>You will get an email confirmation.</p></main>")
        return None

    def handle(self, route):
        req = route.request
        parts = urlsplit(req.url)
        host, path, q = parts.hostname, parts.path, parse_qs(parts.query)
        if req.method == "POST" and (m := re.fullmatch(r"/api/step/(\w+)/([\w-]+)", path)):
            self.steps.setdefault(m.group(1), {})[m.group(2)] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        html = None
        if host == "in.indeed.com" and (self.blocked == "search" and path == "/jobs" or self.blocked == "jobs" and path == "/viewjob"):
            body = ("<header><a>Find jobs</a><a>Sign in</a></header><main><h1>Request Blocked</h1><p>You have been blocked. If you believe this "
                    "in error, please go to support.indeed.com and reference the following information: Your Ray ID is 1</p></main>")
            return route.fulfill(status=403, body=page("Blocked - Indeed.com", body), content_type="text/html; charset=utf-8")
        if host == "myjobs.indeed.com":
            if not self.logged_in:
                return redirect(route, "https://secure.indeed.com/auth?continue=https://myjobs.indeed.com/applied")
            html = page("My jobs | Indeed", "<header><a>Asha</a></header><main><h1>My jobs</h1></main>")
        elif host == "secure.indeed.com":
            html = page("Sign In | Indeed Accounts", "<main><h1>Ready to take the next step?</h1><button>Sign in</button></main>")
        elif host == "in.indeed.com" and path == "/jobs":
            self.searches.append(q)
            html = self.search()
        elif host == "in.indeed.com" and path == "/viewjob" and q.get("jk", [""])[0] in JOBS:
            html = self.job(q["jk"][0])
        elif host == "in.indeed.com" and path == "/applystart":  # Indeed's own redirect to the company's site
            return redirect(route, f"https://careers.example.com/jobs/{q['jk'][0]}")
        elif host == "smartapply.indeed.com" and (m := re.fullmatch(r"/beta/indeedapply/form/(.+)", path)) and q.get("jk", [""])[0] in JOBS:
            html = self.smart(m.group(1), q["jk"][0])
        if html is None:
            return route.fulfill(status=404, body="not found")
        route.fulfill(body=html, content_type="text/html; charset=utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    indeed = Indeed()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as tmp:
        # Chrome's permission prompt can't be clicked from a test: allow Indeed in a copy instead.
        ext = Path(tmp) / "extension"
        shutil.copytree(EXT, ext, ignore=shutil.ignore_patterns("tests"))
        manifest = json.loads((ext / "manifest.json").read_text())
        manifest["host_permissions"] += ["https://*.indeed.com/*"]
        (ext / "manifest.json").write_text(json.dumps(manifest))
        ctx = pw.chromium.launch_persistent_context(
            str(Path(tmp) / "profile"), channel="chromium", headless=not args.headed,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"],
        )
        ctx.route(re.compile(r"^https://[\w.]*indeed\.com/"), fake(indeed.handle))
        ctx.route("https://careers.example.com/**", lambda r: r.fulfill(body="<h1>Careers</h1>", content_type="text/html"))
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        worker.evaluate("s => chrome.storage.local.set({ settings: s })", sample_settings())
        dash = ctx.new_page()
        dash.goto(f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html")
        dash.on("dialog", lambda d: d.accept())
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector("#site-name")
        check = Check(dash)
        started_clean = dash.evaluate("async () => !!(await chrome.storage.local.get('cleaned:linkless'))['cleaned:linkless']")

        print("Settings saved before Indeed came")
        dash.evaluate("""async () => {
            const { settings } = await chrome.storage.local.get('settings');
            delete settings.sites.indeed;
            Object.assign(settings.sites.naukri, { keywords: ['ml engineer', 'python developer'], locations: ['bengaluru'] });
            await chrome.storage.local.set({ settings });
        }""")
        dash.reload()
        dash.wait_for_selector("#site-name")
        dash.evaluate("location.hash = '#settings'")
        dash.click("#site-tab-indeed")
        words, places = dash.input_value('[name="sites.indeed.keywords"]'), dash.input_value('[name="sites.indeed.locations"]')
        check(words == "ml engineer\npython developer" and places == "bengaluru", f"Indeed searches what Naukri does, its words and cities ({words!r}, {places!r})")
        check(dash.is_checked('[name="sites.indeed.easyApplyOnly"]') and dash.input_value('[name="sites.indeed.postedWithin"]') == "7",
              "its own filters as they start: Easily apply only, the past week")

        dash.evaluate("""async () => {
            const s = await JB.store.getSettings();
            Object.assign(s.profile, { country: "India", firstName: "Asha", lastName: "Rao", phone: "+91 98765 43210", minExperience: 1, maxExperience: 3,
              answers: [["notice period", "30 days"], ["years of experience .*python", "3"]],
              filters: { ...s.profile.filters, includeTitle: [], requireRole: ["engineer", "developer", "scientist"], excludeTitle: ["senior"], maxExperienceRequired: 3 } });
            Object.assign(s.sites.indeed, { keywords: ["machine learning engineer"], locations: ["bengaluru"], searchUrls: [] });
            Object.assign(s.sites.indeed.limits, { delaySeconds: [0, 0], maxPages: 2 });
            await JB.store.saveSettings(s);
        }""")

        print("Indeed on the dashboard")
        names = dash.eval_on_selector_all("#site-list li a", "els => els.map(a => a.childNodes[1].textContent)")
        check("Indeed" in names, f"sidebar lists Indeed ({names})")

        print("\nIndeed: dry run, signed out")
        check.start("indeed", "dry-run")
        s = check.wait_done("indeed")
        log = "\n".join(s["log"])
        check("Not logged in to Indeed: fine for a dry run." in log, f"dry run goes ahead without signing in\n{log[-400:]}")
        q = indeed.searches[0]
        check(q == {"q": ["machine learning engineer"], "l": ["bengaluru"], "fromage": ["7"], "sc": ["0kf:attr(DSQF7);"]},
              f"searches India's Indeed for the keyword in the city, the past week's Easily apply jobs ({q})")
        check(len(indeed.searches) == 2 and indeed.searches[1].get("start") == ["10"] and "No more jobs for this search." in log,
              "page 2 is &start=10; it repeating page 1 ends the search")
        check("7 jobs listed, 7 new and matching" in log, f"every card read, the sponsored one too\n{log[-900:]}")
        would = re.findall(r"~ would apply\s+(.+?)\s{2}", log)
        check(would == ["ML Engineer @ Acme", "Python Developer @ Beta", "AI Engineer @ Outside Co", "Data Scientist @ Done Co", "Backend Engineer @ Old Co"],
              f"reads each job's title (without \"- job post\") and company ({would})")
        check(check.status("indeed", "a1b2c3d4e5f60005") == "skipped" and "senior" in check.note("indeed", "a1b2c3d4e5f60005"), "a senior title is skipped")
        check(check.status("indeed", "a1b2c3d4e5f60007") == "skipped" and "6" in check.note("indeed", "a1b2c3d4e5f60007"),
              f"a job asking for 6+ years is skipped ({check.note('indeed', 'a1b2c3d4e5f60007')})")
        check(not indeed.steps, "the dry run applied to nothing")

        print("\nIndeed: apply, signing in when asked")
        dash.evaluate("async () => { const jobs = (await chrome.storage.local.get('jobs')).jobs; for (const k of Object.keys(jobs)) if (!/0005|0007/.test(k)) delete jobs[k]; await chrome.storage.local.set({ jobs }); }")
        check.overview("indeed")
        dash.click(".bot details.opts summary")
        dash.check('.opts [name="assist"]')
        dash.click(".bot h1")
        check.start("indeed", "apply")
        check.wait_prompt("Log in, then continue")
        indeed.logged_in = True
        check.answer("Done, continue")
        dash.bring_to_front()  # asked once Acme's application, four pages, is done: more than a minute on a slow machine
        dash.locator(".bot .prompt", has_text="A question it has no answer for").wait_for(timeout=180000)
        check.wait_prompt("A question it has no answer for")
        box = dash.locator(".bot .prompt")
        check("favourite colour" in box.inner_text() and "optional" not in box.inner_text(), "Beta's question with no answer is asked; the optional one isn't")
        box.get_by_role("textbox").first.fill("Blue")
        check.answer("Save and continue")
        s = check.wait_done("indeed")
        log = "\n".join(s["log"])
        a = indeed.steps.get("a1b2c3d4e5f60001", {})
        check(check.status("indeed", "a1b2c3d4e5f60001") == "applied", f"applied through Indeed's application, page by page ({check.note('indeed', 'a1b2c3d4e5f60001')})\n{log[-800:]}")
        check(a.get("contact-info", {}).get("phone") == "+91 98765 43210" and a["contact-info"].get("firstName") == "Asha" and a["contact-info"].get("city") == "",
              f"contact details: what Indeed has kept, the phone from your profile, the optional city left alone ({a.get('contact-info')})")
        check(a.get("resume", {}).get("resume") == "indeed", "the resume on Indeed, as picked")
        check(a.get("questions-1", {}).get("notice") == "30 days" and a["questions-1"].get("years") == "3", f"the employer's questions from your answers ({a.get('questions-1')})")
        check("review" in a, "and sent from the review page")
        b = indeed.steps.get("a1b2c3d4e5f60002", {})
        check(check.status("indeed", "a1b2c3d4e5f60002") == "applied" and b.get("questions-1", {}).get("colour") == "Blue",
              f"Apply now opening a new tab: the application is followed there, and the answer you gave sent ({b.get('questions-1')})")
        check(check.status("indeed", "a1b2c3d4e5f60003") == "external"
              and check.note("indeed", "a1b2c3d4e5f60003") == "apply opens an external site: https://careers.example.com/jobs/a1b2c3d4e5f60003",
              f"Apply on company site: Other site, with where Indeed's redirect leads ({check.note('indeed', 'a1b2c3d4e5f60003')})")
        check(check.status("indeed", "a1b2c3d4e5f60004") == "already_applied", "applied before (another job's Applied beside it doesn't count)")
        check(check.status("indeed", "a1b2c3d4e5f60006") == "skipped" and "closed" in check.note("indeed", "a1b2c3d4e5f60006"), "an expired job is skipped")
        check("Done: applied to 2." in log, "run summary")
        kept = dash.evaluate("async () => Object.values(await JB.store.kept()).map(k => k.answer)")
        check("Blue" in kept, "the answer you gave is kept for next time")

        print("\nSettings")
        dash.evaluate("location.hash = '#settings'")
        dash.click("#site-tab-indeed")
        dash.select_option('[name="sites.indeed.postedWithin"]', "3")
        dash.uncheck('[name="sites.indeed.easyApplyOnly"]')
        dash.click("#save")
        saved = dash.evaluate("async () => (await JB.store.getSettings()).sites.indeed")
        check(saved["postedWithin"] == "3" and saved["easyApplyOnly"] is False, f"Indeed's filters saved ({saved['postedWithin']}, {saved['easyApplyOnly']})")

        print("\nIndeed's \"blocked\" page")
        before = check.jobs()
        indeed.blocked = "search"
        check.start("indeed", "apply")
        log = "\n".join(check.wait_done("indeed")["log"])
        check("Indeed has blocked this browser for now" in log and "No jobs on this search" not in log,
              f"on a search: it says Indeed has blocked it, not that there are no jobs\n{log[-300:]}")
        dash.evaluate("async () => { const jobs = (await chrome.storage.local.get('jobs')).jobs; for (const k of Object.keys(jobs)) if (k.startsWith('indeed:')) delete jobs[k]; await chrome.storage.local.set({ jobs }); }")
        indeed.blocked = "jobs"
        check.start("indeed", "apply")
        log = "\n".join(check.wait_done("indeed")["log"])
        indeed_jobs = [k for k in check.jobs() if k.startsWith("indeed:")]
        check("Indeed has blocked this browser for now" in log and "Try again later" in log and not indeed_jobs,
              f"on a job: the run stops there and records nothing, so no job is skipped for it ({indeed_jobs})\n{log[-300:]}")
        check(not errors, f"no errors on the dashboard {errors}")

        print("\nThe update forgets the Other site jobs kept without where they lead")
        check(started_clean, "the background part does it once when it starts (its mark is there from the start)")
        dash.evaluate("""async () => {
            const jobs = (await chrome.storage.local.get('jobs')).jobs || {};
            jobs['naukri:900'] = { site: 'naukri', jobId: '900', url: 'https://www.naukri.com/job-listings-x-900', title: 'ML Engineer', company: 'A',
              status: 'external', note: 'applies on the company website', ts: '2026-11-01 10:00:00', shot: false };
            jobs['naukri:901'] = { ...jobs['naukri:900'], jobId: '901', note: 'apply opens an external site: https://jobs.lever.co/a/b' };
            await chrome.storage.local.set({ jobs });
            await chrome.storage.local.remove('cleaned:linkless'); // as it is before this update
        }""")
        gone = worker.evaluate("JB.store.forgetLinkless()")  # what background.js runs when it starts
        left = dash.evaluate("async () => Object.keys((await chrome.storage.local.get('jobs')).jobs)")
        check(gone == 1 and "naukri:900" not in left and "naukri:901" in left,
              f"the one without a link is gone, the one with a link stays ({gone}, {[k for k in left if k.startswith('naukri:')]})")
        check(worker.evaluate("JB.store.forgetLinkless()") == 0, "and only once")
        ctx.close()

    print(f"\n{'All good.' if not check.failures else f'{check.failures} FAILED.'}")
    sys.exit(1 if check.failures else 0)


if __name__ == "__main__":
    main()
