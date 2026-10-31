#!/usr/bin/env python3
"""End-to-end test of "Other companies' forms" (Company sites) in a real Chromium, on fake pages: a company's own
form behind its job page's Apply link, a Workable form behind a button, a careers site that wants you to sign in, and
an iCIMS job left alone. Also what a form asks the same way everywhere (self-identification, consent, a start date)
and the answers for the job's country (a London job, from India, with a UK visa needed).

  .venv/bin/python extension/tests/e2e_forms.py            # headless
  .venv/bin/python extension/tests/e2e_forms.py --headed   # watch it
"""
import argparse
import json
import re
import shutil
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

from e2e import EXT, Hirist, Test, launch

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>{title}</title><style>[hidden]{{display:none}}</style></head>
<body>{body}<script>{script}</script></body></html>"""

POST = """async function post(id) {
  const f = document.querySelector('form'), v = n => (f.elements[n] && f.elements[n].value) || '';
  const data = {};
  for (const e of f.elements) if (e.name) data[e.name] = e.type === 'checkbox' ? e.checked : e.type === 'radio' ? (e.checked ? e.value : data[e.name] || '') : e.type === 'file' ? (e.files[0] || {}).name || '' : e.value;
  await fetch('/api/apply/' + id, {method: 'POST', body: JSON.stringify(data)});
}"""


def acme_job():
    return PAGE.format(title="ML Engineer | Acme Careers", script="", body="""<header><input type="search" placeholder="Search jobs"></header>
<main><h1>ML Engineer</h1><h3>Location</h3><p>London, United Kingdom</p><p>Build models with us.</p>
<a href="/careers/ml-engineer/apply" target="_blank">Apply now</a></main>""")


def acme_form():
    body = """<main><h1>Apply: ML Engineer</h1><form>
<div class="field"><label>First name <input name="first" required></label></div>
<div class="field"><label>Last name <input name="last" required></label></div>
<div class="field"><label>Email <input name="email" type="email" required></label></div>
<div class="field"><label>Phone <input name="phone" type="tel"></label></div>
<div class="field"><label>Resume/CV <input name="resume" id="resume" type="file" required></label></div>
<div class="field"><fieldset><legend>Will you require visa sponsorship to work in this country?</legend>
<label><input type="radio" name="sponsor" value="Yes" required> Yes</label><label><input type="radio" name="sponsor" value="No"> No</label></fieldset></div>
<div class="field"><label>Expected salary <input name="salary" required></label></div>
<div class="field"><label>Gender <select name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Prefer not to say</option></select></label></div>
<div class="field"><label>Earliest start date <input name="start" type="date" required></label></div>
<div class="field"><label><input type="checkbox" name="privacy" required> I agree to the processing of my personal data as set out in the Privacy Notice</label></div>
<div class="field"><label><input type="checkbox" name="pool"> Keep my details for future opportunities</label></div>
<button type="button" id="send">Submit application</button></form></main>"""
    script = POST + """
document.getElementById('send').addEventListener('click', async () => {
  if (!document.querySelector('form').checkValidity()) return;
  await post('acme-ml');
  document.querySelector('main').innerHTML = '<h2>Thank you for applying!</h2>';
});"""
    return PAGE.format(title="Apply | Acme", body=body, script=script)


def workable_job():
    body = """<main><h1>Data Analyst</h1><div><h2>Location</h2><p>Remote - India</p></div><p>Dashboards.</p>
<button id="open">Apply for this job</button>
<form hidden><label>Full name <input name="name" required></label><label>Email <input name="email" type="email" required></label>
<label>Resume <input name="resume" type="file" required></label>
<label>Are you legally authorized to work in the country for which you are applying? <select name="auth" required>
<option value="">Choose</option><option>Yes</option><option>No</option></select></label>
<button type="button" id="send">Submit application</button></form></main>"""
    script = POST + """
document.getElementById('open').addEventListener('click', () => { document.querySelector('form').hidden = false; document.getElementById('open').remove(); });
document.getElementById('send').addEventListener('click', async () => {
  if (!document.querySelector('form').checkValidity()) return;
  await post('workable-abc123');
  document.querySelector('main').innerHTML = '<p>Your application has been submitted.</p>';
});"""
    return PAGE.format(title="Data Analyst - Acme", body=body, script=script)


def sign_in_job():
    return PAGE.format(title="Backend Engineer", script="", body="""<main><h1>Backend Engineer</h1><p>Bengaluru, India</p>
<a href="/careers/backend/login">Apply</a></main>""")


def sign_in():
    return PAGE.format(title="Sign in", script="", body="""<main><h1>Sign in to apply</h1><form><label>Email <input name="e" type="email"></label>
<label>Password <input name="p" type="password"></label><button>Sign in</button></form></main>""")


class Sites:
    def __init__(self):
        self.posted = {}

    def handle(self, route):
        req = route.request
        u = re.sub(r"^https://", "", req.url).split("?")[0].rstrip("/")
        if req.method == "POST" and (m := re.search(r"/api/apply/([\w-]+)$", u)):
            self.posted[m.group(1)] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        html = {
            "www.acme.example/careers/ml-engineer": acme_job, "www.acme.example/careers/ml-engineer/apply": acme_form,
            "apply.workable.com/acme/j/ABC123": workable_job, "www.acme.example/careers/backend": sign_in_job,
            "www.acme.example/careers/backend/login": sign_in,
        }.get(u)
        if html is None:
            return route.fulfill(status=404, body="not found")
        route.fulfill(body=html(), content_type="text/html; charset=utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    sites = Sites()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as tmp:
        # Chrome's permission prompt can't be clicked from a test: grant access to all sites in a copy instead.
        ext = Path(tmp) / "extension"
        shutil.copytree(EXT, ext, ignore=shutil.ignore_patterns("tests"))
        manifest = json.loads((ext / "manifest.json").read_text())
        manifest["host_permissions"].append("<all_urls>")
        (ext / "manifest.json").write_text(json.dumps(manifest))
        ctx, dash = launch(pw, ext, Path(tmp) / "profile", args.headed, Hirist())
        for host in ("www.acme.example", "apply.workable.com", "acme.icims.com"):
            ctx.route(f"https://{host}/**", sites.handle)
        t = Test(ctx, dash, None)
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector(".bot h2")

        def run_state():
            return dash.evaluate("async () => (await chrome.storage.session.get('run:company'))['run:company'] || null")

        def status(jid):
            r = t.jobs().get(f"company:{jid}")
            return r and r["status"]

        def wait_done(timeout=240):
            end = time.time() + timeout
            while time.time() < end:
                s = run_state()
                if s and not s["running"]:
                    return s
                dash.wait_for_timeout(500)
            raise AssertionError("run didn't finish:\n" + "\n".join((run_state() or {}).get("log", [])))

        acme = "https://www.acme.example/careers/ml-engineer"
        backend = "https://www.acme.example/careers/backend"
        workable = "https://apply.workable.com/acme/j/ABC123/"
        dash.evaluate("""async ([links, icims]) => {
            const s = await JB.store.getSettings();
            Object.assign(s.profile, { firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "+91 98765 43210",
              country: "India", city: "Bengaluru", noticePeriod: "30 days",
              workIn: [{ country: "United Kingdom", can: "visa", salary: 70000, currency: "GBP" }] });
            Object.assign(s.sites.company, { searchUrls: links, fromOthers: true, moreForms: true, sendMode: "direct" });
            Object.assign(s.sites.company.limits, { delaySeconds: [0, 0] });
            await JB.store.saveSettings(s);
            await JB.store.saveResume({ name: "Asha_Rao_CV.pdf", type: "application/pdf", size: 2000, data: btoa("%PDF-1.4 resume") });
            const jobs = (await chrome.storage.local.get('jobs')).jobs || {};
            jobs['naukri:9'] = { site: 'naukri', jobId: '9', url: 'https://www.naukri.com/job-listings-9', title: 'SDE', company: 'Big',
              status: 'external', note: 'apply opens an external site: ' + icims, ts: '2026-10-20 10:00:00', shot: false };
            await chrome.storage.local.set({ jobs });
        }""", [[acme, workable, backend], "https://acme.icims.com/jobs/9/sde/job"])

        print("Other companies' forms: shown to you before sending, even with send straight away on")
        dash.goto(dash.url.split("#")[0] + "#overview/company")
        dash.wait_for_selector("#site-name:text('Company sites')")
        t.click("apply")
        for _ in range(2):  # the company's form, then Workable's
            box = t.wait_prompt("Filled in: send it?")
            box.get_by_role("button", name="Send it", exact=True).click()
            dash.wait_for_timeout(1500)
        s = wait_done()
        log = "\n".join(s["log"])

        got = sites.posted.get("acme-ml", {})
        job_id = lambda u: dash.evaluate("u => JB.sites.company.parse(u).jobId", u)
        t.check(status(job_id(acme)) == "applied" and got,
                f"a company's own form, behind its Apply link (which opens a new tab): applied\n{log[-800:]}")
        t.check(got.get("first") == "Asha" and got.get("email") == "asha@example.com" and got.get("resume") == "Asha_Rao_CV.pdf",
                f"your profile and resume ({got})")
        t.check(got.get("sponsor") == "Yes" and got.get("salary") == "70000 GBP a year",
                "a London job, from India: sponsorship Yes, and the salary you gave for the UK")
        t.check(got.get("gender") == "Prefer not to say", "self-identification declined, in the form's own words")
        t.check(got.get("start") == (date.today() + timedelta(days=30)).isoformat(), f"start date: 30 days' notice from today ({got.get('start')})")
        t.check(got.get("privacy") is True and got.get("pool") is False, "consent to processing ticked, the talent pool not")

        wk = sites.posted.get("workable-abc123", {})
        t.check(status("workable-acme-abc123") == "applied" and wk.get("name") == "Asha Rao" and wk.get("auth") == "Yes",
                f"Workable, behind its Apply button: authorized in India, where the job is ({wk})")
        backend_id = job_id(backend)
        t.check(status(backend_id) == "needs_manual" and "sign in" in t.jobs()[f"company:{backend_id}"]["note"],
                "a careers site that wants you to sign in is left for you")
        t.check(not any("icims" in k for k in t.jobs() if k.startswith("company:")), "an iCIMS job (an account first) isn't tried")
        t.check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not t.failures else f'{t.failures} FAILED.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
