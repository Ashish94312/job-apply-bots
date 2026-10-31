#!/usr/bin/env python3
"""End-to-end test of applying on company sites (Greenhouse, Lever, Ashby) in a real Chromium, on fake forms built
like the real ones (their markup: tests/e2e_company.py's notes): profile and resume fill the standard boxes, your
answers the company's questions, the rest is asked once; sending straight away and after a look.

  .venv/bin/python extension/tests/e2e_company.py            # headless
  .venv/bin/python extension/tests/e2e_company.py --headed   # watch it
  .venv/bin/python extension/tests/e2e_company.py --shots DIR  # also save screenshots to DIR
"""
import argparse
import json
import re
from urllib.parse import parse_qs, urlsplit
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from e2e import EXT, Hirist, Test, launch

LEVER_ID = "6ed76ce8-4156-4b60-b120-403538bd66cd"
ASHBY_ID = "34413f8d-26bf-4bbc-8ade-eb309a0e2245"
GREENHOUSE = {"1001": "ML Engineer", "1002": "Data Engineer", "1003": "AI Engineer"}

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>{title}</title>
<style>.visually-hidden{{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}}
.select__menu{{border:1px solid #ccc}} [hidden]{{display:none}}</style></head><body>{body}<script>{script}</script></body></html>"""

POST = """function post(system, id, data) {
  return fetch('/api/apply/' + system + '/' + id, {method: 'POST', body: JSON.stringify(data)});
}"""

# ---------------------------------------------------------------- Greenhouse (job-boards.greenhouse.io, a React form)

GH_COMBO = """<div class="field-wrapper"><label id="{id}-label" for="{id}" class="label">{label}{star}</label>
<div class="select-shell"><div><div class="select__control"><div class="select__value-container">
<div class="select__placeholder">Select...</div><div class="select__input-container"><input class="select__input" id="{id}"
 type="text" aria-autocomplete="list" aria-expanded="false" aria-labelledby="{id}-label" aria-required="{req}" role="combobox" value=""></div></div></div></div>
<input {required} tabindex="-1" aria-hidden="true" class="requiredInput" value=""></div></div>"""


def gh_text(id, label, required=False, type="text"):
    star = '<span aria-hidden="true">*</span>' if required else ""
    return (f'<div class="field-wrapper"><label id="{id}-label" for="{id}" class="label">{label}{star}</label>'
            f'<input id="{id}" class="input" aria-label="{label}" aria-required="{str(required).lower()}" type="{type}" value=""></div>')


def gh_combo(id, label, required=False):
    return GH_COMBO.format(id=id, label=label, star='<span aria-hidden="true">*</span>' if required else "",
                           req=str(required).lower(), required="required" if required else "")


def gh_upload(id, label, required=False):
    star = '<span class="required">*</span>' if required else ""
    return (f'<div class="field-wrapper"><div role="group" aria-labelledby="upload-label-{id}" aria-required="{str(required).lower()}" class="file-upload">'
            f'<div id="upload-label-{id}" class="label upload-label">{label}{star}</div><button type="button" class="btn">Attach</button>'
            f'<label class="visually-hidden" for="{id}">Attach</label><input id="{id}" class="visually-hidden" type="file" accept=".pdf,.doc,.docx">'
            f'<span class="filename" id="{id}-name"></span></div></div>')


def greenhouse(jid):
    title = GREENHOUSE[jid]
    body = f"""<div class="job__title"><h1 class="section-header">{title}</h1><div class="job__location">Bengaluru, India</div></div><p>Build models.</p>
<form method="get" action="/acme/jobs/{jid}" id="application-form" class="application--form"><div class="application--questions">
{gh_text("first_name", "First Name", True)}{gh_text("last_name", "Last Name", True)}{gh_text("email", "Email", True)}
{gh_combo("country", "Country")}{gh_text("phone", "Phone", False, "tel")}
{gh_upload("resume", "Resume/CV", True)}{gh_upload("cover_letter", "Cover Letter")}
{gh_text("question_1", "LinkedIn Profile")}{gh_text("question_2", "What's the name you'd prefer us to use?")}
{gh_combo("question_3", "Will you now or in the future require sponsorship for a visa?", True)}
{gh_combo("question_4", "Have you previously worked at or consulted for Acme?", True)}
<fieldset class="checkbox" aria-required="true"><legend>Which of these locations could you work from?<span>*</span></legend>
<label><input type="checkbox" name="question_5[]" value="India"> India</label>
<label><input type="checkbox" name="question_5[]" value="US"> US</label></fieldset>
{gh_combo("gender", "Gender")}
<p id="errors" class="helper-text helper-text--error" hidden></p>
<button type="submit" class="btn btn--pill">Submit application</button></div></form>"""
    script = POST + """
const COMBOS = {country: ['India', 'British Indian Ocean Territory', 'United States'], question_3: ['Yes', 'No'], question_4: ['Yes', 'No'],
  gender: ['Male', 'Female', 'Decline To Self Identify']};
for (const [id, options] of Object.entries(COMBOS)) {
  const input = document.getElementById(id);
  const shell = input.closest('.select-shell');
  const values = shell.querySelector('.select__value-container');
  const hidden = shell.querySelector('input[aria-hidden=true]');
  let menu = null;
  const close = () => { if (menu) menu.remove(); menu = null; };
  const choose = o => {
    values.querySelector('.select__placeholder, .select__single-value').remove();
    const v = document.createElement('div');
    v.className = 'select__single-value';
    v.textContent = o;
    values.prepend(v);
    hidden.value = o;
    input.value = '';
    close();
  };
  const open = () => {
    close();
    menu = document.createElement('div');
    menu.className = 'select__menu';
    options.filter(o => o.toLowerCase().includes(input.value.toLowerCase())).forEach((o, k) => {
      const d = document.createElement('div');
      d.setAttribute('role', 'option');
      d.id = `react-select-${id}-option-${k}`;
      d.textContent = o;
      d.addEventListener('click', () => choose(o));
      menu.append(d);
    });
    shell.append(menu);
  };
  input.addEventListener('keydown', e => { if (e.key === 'ArrowDown') open(); if (e.key === 'Escape') close(); });
  input.addEventListener('input', open);
  shell.querySelector('.select__control').addEventListener('mousedown', e => { e.preventDefault(); menu ? close() : open(); });
}
for (const id of ['resume', 'cover_letter']) {
  const box = document.getElementById(id);
  box.addEventListener('change', () => { document.getElementById(id + '-name').textContent = box.files[0] ? box.files[0].name : ''; });
}
document.getElementById('application-form').addEventListener('submit', async e => {
  e.preventDefault();
  const v = id => document.getElementById(id).value;
  const picked = id => (document.getElementById(id).closest('.select-shell').querySelector('input[aria-hidden=true]') || {}).value || '';
  const places = [...document.querySelectorAll('input[name="question_5[]"]:checked')].map(b => b.value);
  const resume = document.getElementById('resume').files[0];
  const wrong = [];
  for (const id of ['first_name', 'last_name', 'email']) if (!v(id)) wrong.push(id);
  if (!picked('question_3') || !picked('question_4')) wrong.push('questions');
  if (!places.length) wrong.push('locations');
  if (!resume) wrong.push('resume');
  if (wrong.length) {
    const p = document.getElementById('errors');
    p.hidden = false;
    p.textContent = 'This field is required: ' + wrong.join(', ');
    return;
  }
  await post('greenhouse', '%JID%', {first: v('first_name'), last: v('last_name'), email: v('email'), phone: v('phone'), country: picked('country'),
    linkedin: v('question_1'), preferred: v('question_2'), sponsorship: picked('question_3'), before: picked('question_4'), places,
    gender: picked('gender'), resume: resume.name, resumeSize: resume.size, cover: document.getElementById('cover_letter').files.length});
  location.href = '/acme/jobs/%JID%/confirmation';
});""".replace("%JID%", jid)
    return PAGE.format(title=f"Job Application for {title} at Acme", body=body, script=script)


def greenhouse_done():
    return PAGE.format(title="Acme", body="<h1>Thank you for applying.</h1><p>Your application has been received.</p>", script="")

# ---------------------------------------------------------------- Lever (jobs.lever.co, a plain form)


def lever_q(label, field, required=True):
    star = '<span class="required">✱</span>' if required else ""
    return (f'<li class="application-question custom-question"><div><div class="application-label full-width">'
            f'<div class="text">{label}{star}</div></div><div class="application-field full-width{" required-field" if required else ""}">{field}</div></div></li>')


def lever():
    radios = "".join(f'<li><label><input type="radio" name="cards[a][field0]" value="{v}" required="required"><span>{v}</span></label></li>' for v in ["Yes", "No"])
    boxes = "".join(f'<li><label><input type="checkbox" name="cards[b][field0]" value="{v}" required=""><span>{v}</span></label></li>' for v in ["English (ENG)", "Hindi (HIN)", "Tamil (TAM)"])
    select = '<div class="application-dropdown"><select name="cards[c][field0]" required=""><option value="">Select...</option><option>LinkedIn</option><option>A friend</option></select></div>'
    body = f"""<div class="posting-headline"><h2>Backend Engineer</h2><div class="posting-categories"><div class="location">London, United Kingdom</div></div></div>
<form id="application-form" method="POST" enctype="multipart/form-data"><ul>
<li class="application-question resume"><label><div class="application-label">Resume/CV <span class="required">✱</span></div>
<div class="application-field"><a href="#" class="postings-btn visible-resume-upload"><span class="filename"></span><span class="default-label">ATTACH RESUME/CV</span>
<input class="application-file-input invisible-resume-upload" data-qa="input-resume" id="resume-upload-input" name="resume" tabindex="-1" type="file"></a></div></label></li>
<li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div><div class="application-field"><input type="text" name="name" required=""></div></label></li>
<li class="application-question"><label><div class="application-label">Email<span class="required">✱</span></div><div class="application-field"><input name="email" type="email" required=""></div></label></li>
<li class="application-question"><label><div class="application-label">Phone </div><div class="application-field"><input type="text" name="phone"></div></label></li>
<li class="application-question"><label><div class="application-label">Current location<span class="required">✱</span></div><div class="application-field"><input type="text" name="location" id="location-input" class="location-input" required=""><input id="selected-location" type="hidden" name="selectedLocation"><div class="dropdown-container" hidden><div class="dropdown-results"></div></div></div></label></li>
<li class="application-question"><label><div class="application-label">Current company</div><div class="application-field"><input type="text" name="org"></div></label></li>
<li class="application-question"><label><div class="application-label">LinkedIn URL</div><div class="application-field"><input type="text" name="urls[LinkedIn]"></div></label></li>
<li class="application-question"><label><div class="application-label">GitHub URL</div><div class="application-field"><input type="text" name="urls[GitHub]"></div></label></li>
</ul><div class="section application-form"><h4>Work Authorization</h4><ul>
{lever_q("Are you legally authorized to work in the country for which you are applying?", f'<ul data-qa="multiple-choice">{radios}</ul>')}
{lever_q("Language Skill(s) (Check all that apply)", f'<ul data-qa="checkboxes">{boxes}</ul>')}
{lever_q("How did you hear about this opportunity?", select)}
{lever_q("What has been your favorite project?", '<textarea name="cards[d][field0]"></textarea>', False)}
</ul></div>
<div class="application-question"><div class="application-label">Additional information</div><textarea name="comments" id="additional-information"></textarea></div>
<p class="error-message" hidden id="errors"></p>
<button id="btn-submit" type="button" class="template-btn-submit">SUBMIT APPLICATION</button></form>"""
    script = POST + f"""
// its location box suggests places as you type, and empties itself unless you pick one
const where = document.getElementById('location-input'), picked = document.getElementById('selected-location');
const results = document.querySelector('.dropdown-results');
where.addEventListener('input', () => {{
  picked.value = '';
  results.parentElement.hidden = where.value.length < 3;
  results.innerHTML = ['Bengaluru, Bengaluru Urban, Karnataka, IND', 'Bengaluru, Bangalore, Karnataka, IND', 'Pune, Maharashtra, IND']
    .filter(p => p.toLowerCase().startsWith(where.value.toLowerCase()))
    .map((p, k) => `<div class="dropdown-location" id="location-${{k}}">${{p}}</div>`).join('');
  results.querySelectorAll('.dropdown-location').forEach(d => d.addEventListener('click', () => {{
    where.value = d.textContent;
    picked.value = JSON.stringify({{name: d.textContent}});
    results.parentElement.hidden = true;
  }}));
}});
where.addEventListener('blur', () => setTimeout(() => {{ if (!picked.value) where.value = ''; }}, 200));
document.getElementById('btn-submit').addEventListener('click', async () => {{
  const f = document.getElementById('application-form');
  const v = n => (f.elements[n] || {{}}).value || '';
  const resume = document.getElementById('resume-upload-input').files[0];
  const langs = [...f.querySelectorAll('input[name="cards[b][field0]"]:checked')].map(b => b.value);
  const auth = (f.querySelector('input[name="cards[a][field0]"]:checked') || {{}}).value || '';
  if (!resume || !v('name') || !v('email') || !v('location') || !auth || !langs.length || !v('cards[c][field0]')) {{
    const p = document.getElementById('errors');
    p.hidden = false;
    p.textContent = 'Please fill out all required fields';
    return;
  }}
  await post('lever', '{LEVER_ID}', {{name: v('name'), email: v('email'), phone: v('phone'), location: v('location'), picked: v('selectedLocation'), org: v('org'),
    linkedin: v('urls[LinkedIn]'), github: v('urls[GitHub]'), auth, langs, heard: v('cards[c][field0]'), project: v('cards[d][field0]'),
    comments: v('comments'), resume: resume.name}});
  location.href = '/acme/{LEVER_ID}/thanks';
}});"""
    return PAGE.format(title="Acme - Backend Engineer", body=body, script=script)


def lever_done():
    return PAGE.format(title="Acme", body="<h3>Application submitted!</h3>", script="")

# ---------------------------------------------------------------- Ashby (jobs.ashbyhq.com, a React app with no <form>)


def ashby_entry(id, label, field, required=True):
    return (f'<div class="_fieldEntry ashby-application-form-field-entry"><label class="_heading{" _required" if required else ""} '
            f'ashby-application-form-question-title" for="{id}">{label}</label>{field}</div>')


def ashby_yesno(id, label):
    return ashby_entry(id, label, f'<div class="_yesno ashby-application-form-input-yesno"><button class="ashby-application-form-input-yesno-option" '
                       f'aria-pressed="false" data-option="yes">Yes</button><button class="ashby-application-form-input-yesno-option" aria-pressed="false" '
                       f'data-option="no">No</button><input type="checkbox" class="_input" tabindex="-1" name="{id}"></div>')


def ashby():
    body = f"""<div id="root"><h1 class="ashby-job-posting-heading">Data Scientist</h1><div><h2>Location</h2><p>Remote - India</p></div>
<div class="ashby-application-form-autofill-input-root">Autofill from resume Upload your resume here to autofill key application fields.
<input type="file" id="autofill"><button>Upload file</button></div>
<div class="_jobPostingForm ashby-application-form-container"><div class="ashby-application-form-section-container">
{ashby_entry("_systemfield_name", "Legal Name", '<input type="text" id="_systemfield_name" name="_systemfield_name" required>')}
{ashby_entry("_systemfield_email", "Email", '<input type="email" id="_systemfield_email" name="_systemfield_email" required>')}
{ashby_entry("phone1", "Phone", '<input type="tel" id="phone1" name="phone1">', False)}
{ashby_entry("_systemfield_resume", "Resume", '<div role="presentation"><input type="file" id="_systemfield_resume"><button>Upload File</button></div>')}
{ashby_entry("li1", "LinkedIn Profile", '<input type="text" id="li1" name="li1" required>')}
{ashby_yesno("yn1", "Do you have 3+ years of experience with Python?")}
{ashby_yesno("yn2", "Will you now or in the future require visa sponsorship?")}
{ashby_entry("ta1", "Tell us about a project you are proud of", '<textarea id="ta1" name="ta1" required></textarea>')}
</div></div><p class="_error" id="errors" hidden></p><button class="ashby-application-form-submit-button">Submit Application</button></div>"""
    script = POST + f"""
for (const box of document.querySelectorAll('.ashby-application-form-input-yesno')) {{
  const [yes, no] = box.querySelectorAll('button');
  const hidden = box.querySelector('input');
  for (const b of [yes, no]) b.addEventListener('click', e => {{
    e.preventDefault();
    yes.setAttribute('aria-pressed', String(b === yes));
    no.setAttribute('aria-pressed', String(b === no));
    hidden.checked = b === yes;
    box.dataset.answered = b.dataset.option;
  }});
}}
document.querySelector('.ashby-application-form-submit-button').addEventListener('click', async () => {{
  const v = id => document.getElementById(id).value;
  const yn = id => document.querySelector(`input[name="${{id}}"]`).closest('.ashby-application-form-input-yesno').dataset.answered || '';
  const resume = document.getElementById('_systemfield_resume').files[0];
  if (!resume || !v('_systemfield_name') || !v('_systemfield_email') || !v('li1') || !yn('yn1') || !yn('yn2') || !v('ta1')) {{
    const p = document.getElementById('errors');
    p.hidden = false;
    p.textContent = 'Missing entry for required field';
    return;
  }}
  await post('ashby', '{ASHBY_ID}', {{name: v('_systemfield_name'), email: v('_systemfield_email'), phone: v('phone1'), linkedin: v('li1'),
    python: yn('yn1'), visa: yn('yn2'), project: v('ta1'), resume: resume.name, autofill: document.getElementById('autofill').files.length}});
  document.getElementById('root').innerHTML = '<h2>Thank you</h2><p>Your application was successfully submitted.</p>';
}});"""
    return PAGE.format(title="Data Scientist @ Acme", body=body, script=script)


class Forms:
    def __init__(self):
        self.posted = {}

    def handle(self, route):
        req = route.request
        u = re.sub(r"^https://", "", req.url).split("?")[0]
        if req.method == "POST" and (m := re.search(r"/api/apply/(\w+)/([\w-]+)$", u)):
            self.posted[f"{m.group(1)}:{m.group(2)}"] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        html = None
        q = parse_qs(urlsplit(req.url).query)
        if u == "job-boards.greenhouse.io/embed/job_app" and q.get("for") == ["acme"]:  # the form, as companies embed it
            html = greenhouse(q["token"][0]) if q.get("token", [""])[0] in GREENHOUSE else None
        elif re.match(r"^job-boards\.greenhouse\.io/acme/jobs/\d+/confirmation$", u):
            html = greenhouse_done()
        elif u == f"jobs.lever.co/acme/{LEVER_ID}/apply":
            html = lever()
        elif u == f"jobs.lever.co/acme/{LEVER_ID}/thanks":
            html = lever_done()
        elif u == f"jobs.ashbyhq.com/acme/{ASHBY_ID}/application":
            html = ashby()
        if html is None:
            return route.fulfill(status=404, body="not found")
        route.fulfill(body=html, content_type="text/html; charset=utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--shots", type=Path)
    args = parser.parse_args()
    if args.shots:
        args.shots.mkdir(parents=True, exist_ok=True)

    forms = Forms()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx, dash = launch(pw, EXT, profile, args.headed, Hirist())
        for host in ("job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"):
            ctx.route(f"https://{host}/**", forms.handle)
        t = Test(ctx, dash, None)
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector(".bot h2")

        def run_state():
            return dash.evaluate("async () => (await chrome.storage.session.get('run:company'))['run:company'] || null")

        def status(jid):
            r = t.jobs().get(f"company:{jid}")
            return r and r["status"]

        def wait_done(timeout=300):
            end = time.time() + timeout
            while time.time() < end:
                s = run_state()
                if s and not s["running"]:
                    return s
                dash.wait_for_timeout(500)  # not time.sleep: the fake sites answer only while Playwright runs
            s = run_state() or {}
            raise AssertionError(f"run didn't finish, it's at: {s.get('now')!r}, asking {(s.get('prompt') or {}).get('title')!r}:\n" + "\n".join(s.get("log", [])))

        def settings(**changes):
            dash.evaluate("""async changes => {
                const s = await JB.store.getSettings();
                Object.assign(s.profile, changes.profile || {});
                Object.assign(s.sites.company, changes.company || {});
                Object.assign(s.sites.company.limits, { delaySeconds: [0, 0] });
                await JB.store.saveSettings(s);
            }""", changes)

        def shot(name):
            if args.shots:
                dash.screenshot(path=str(args.shots / f"{name}.png"), full_page=True)

        gh = lambda jid: f"https://job-boards.greenhouse.io/acme/jobs/{jid}"
        settings(profile={"answers": [["sponsorship", "No"], ["legally authorized", "Yes"], ["language skill", "English (ENG), Hindi (HIN)"],
                                      ["hear about", "LinkedIn"], ["years of experience with python", "Yes"], ["locations could you work", "India"]],
                          "country": "India", "workIn": [{"country": "United Kingdom", "can": "visa"}]},  # Where you can work: the UK needs a visa
                 company={"searchUrls": [gh("1003")], "fromOthers": False, "sendMode": "direct"})

        print("Company sites on the dashboard")
        dash.goto(dash.url.split("#")[0] + "#overview/company")
        dash.wait_for_selector("#site-name:text('Company sites')")
        t.check(dash.locator('.bot [data-act="login"]').is_hidden(), "no Log in button: company forms need none")

        print("\nNo resume yet")
        t.click("apply")
        wait_done()
        t.check(status("gh-1003") == "needs_manual" and "add it in Settings" in t.jobs()["company:gh-1003"]["note"],
                f"a form that wants a resume is left for you, saying where to add one ({t.jobs().get('company:gh-1003', {}).get('note')})")

        print("\nYour profile and resume")
        t.page("settings")
        dash.click('.toc [data-goto="profile"]')
        for name, value in {"firstName": "Asha", "lastName": "Rao", "email": "asha@example.com", "phone": "+91 98765 43210",
                            "city": "Bengaluru", "linkedin": "https://www.linkedin.com/in/asha", "github": "https://github.com/asha"}.items():
            dash.fill(f'[name="profile.{name}"]', value)
        dash.select_option('[name="profile.country"]', "India")  # Where you are
        with tempfile.NamedTemporaryFile(suffix=".pdf", prefix="Asha_Rao_Resume_") as pdf:
            pdf.write(b"%PDF-1.4\n% a resume\n" + b"x" * 2000)
            pdf.flush()
            dash.set_input_files("#resume-file", pdf.name)
            dash.wait_for_function("async () => !!(await JB.store.resume())")
            resume_name = Path(pdf.name).name
        t.check(resume_name in dash.locator("#resume-status").inner_text(), "the resume is kept as soon as it's picked")
        dash.click('.toc [data-goto="search"]')
        dash.click("#site-tab-company")
        dash.fill('[name="sites.company.searchUrls"]', "https://acme.icims.com/jobs/1/ml/job")
        dash.click("#save")
        t.check("aren't job links it can apply on" in dash.locator("#errors").inner_text(), "a link it can't apply on is pointed out")
        dash.fill('[name="sites.company.searchUrls"]', "https://example.com/careers/1")
        dash.click("#save")
        t.check("Other companies' forms too" in dash.locator("#errors").inner_text(), "...and one that needs Other companies' forms ticked")
        dash.fill('[name="sites.company.searchUrls"]', f"{gh('1001')}\nhttps://jobs.lever.co/acme/{LEVER_ID}")
        dash.check('[name="sites.company.fromOthers"]')
        dash.click("#save")
        dash.wait_for_function("async () => (await JB.store.getSettings()).sites.company.searchUrls.length === 2")
        saved = dash.evaluate("async () => (await JB.store.getSettings()).profile")
        t.check(saved["firstName"] == "Asha" and saved["linkedin"] == "https://www.linkedin.com/in/asha", "the profile is saved with the settings")
        shot("1-profile")

        # a job another site found, which applies on Ashby
        dash.evaluate("""async url => {
            const jobs = (await chrome.storage.local.get('jobs')).jobs || {};
            jobs['hirist:777'] = { site: 'hirist', jobId: '777', url: 'https://www.hirist.tech/j/x-777', title: 'Data Scientist', company: 'Acme',
              status: 'external', note: 'apply opens an external site: ' + url, ts: '2026-10-20 10:00:00', shot: false };
            await chrome.storage.local.set({ jobs });
        }""", f"https://jobs.ashbyhq.com/acme/{ASHBY_ID}")

        print("\nApplying, asked once about what nothing answers")
        dash.goto(dash.url.split("#")[0] + "#overview/company")
        dash.bring_to_front()
        dash.click(".bot details.opts summary")
        dash.check('.opts [name="assist"]')
        dash.click(".bot h1")
        t.click("apply")
        box = t.wait_prompt("A question it has no answer for")
        t.check("previously worked at or consulted for Acme" in box.inner_text() and box.locator("input[type=radio]").count() == 2,
                "Greenhouse's dropdown question is asked with its own options")
        shot("2-asked")
        box.get_by_label("No", exact=True).check()
        t.answer("Save and continue")
        dash.bring_to_front()
        dash.locator(".bot .prompt", has_text="project you are proud of").wait_for(timeout=300000)  # not the one just answered
        box = t.wait_prompt("A question it has no answer for")
        t.check("project you are proud of" in box.inner_text() and box.locator("textarea").count() == 1, "then Ashby's, to write")
        box.locator("textarea").fill("A search ranking model that cut support tickets by a third.")
        t.answer("Save and continue")
        s = wait_done()
        log = "\n".join(s["log"])
        t.check(status("gh-1001") == "applied" and status(f"lever-{LEVER_ID}") == "applied" and status(f"ashby-{ASHBY_ID}") == "applied",
                f"all three applied ({[status(j) for j in ('gh-1001', f'lever-{LEVER_ID}', f'ashby-{ASHBY_ID}')]})\n{log[-600:]}")
        g = forms.posted.get("greenhouse:1001", {})
        t.check(g.get("first") == "Asha" and g.get("last") == "Rao" and g.get("email") == "asha@example.com" and g.get("phone") == "+91 98765 43210",
                f"Greenhouse: name, email and phone from your profile ({g})")
        t.check(g.get("country") == "India" and g.get("linkedin") == "https://www.linkedin.com/in/asha", "the country dropdown and LinkedIn too")
        t.check(g.get("sponsorship") == "No" and g.get("before") == "No" and g.get("places") == ["India"],
                "its dropdown questions and checkboxes from your answers, and the one you were asked")
        t.check(g.get("resume") == resume_name and g.get("resumeSize", 0) > 2000 and g.get("cover") == 0, "your resume attached, not as the cover letter")
        t.check(g.get("preferred") == "", "a question it needn't answer, with no answer, left alone")
        t.check(g.get("gender") == "Decline To Self Identify", f"US self-identification declined, as the form words it ({g.get('gender')!r})")
        lv = forms.posted.get(f"lever:{LEVER_ID}", {})
        t.check(lv.get("name") == "Asha Rao" and lv.get("github") == "https://github.com/asha", f"Lever: full name and links ({lv})")
        t.check(lv.get("location") == "Bengaluru, Bengaluru Urban, Karnataka, IND" and "Bengaluru" in lv.get("picked", ""),
                "the location picked from Lever's suggestions, as it wants")
        t.check(lv.get("auth") == "No" and lv.get("langs") == ["English (ENG)", "Hindi (HIN)"] and lv.get("heard") == "LinkedIn",
                "its radio, checkbox and dropdown questions; authorized to work in the job's country (London): No, you'd need a visa")
        t.check(lv.get("resume") == resume_name and lv.get("project") == "" and lv.get("comments") == "", "the resume attached, optional boxes left empty")
        ab = forms.posted.get(f"ashby:{ASHBY_ID}", {})
        t.check(ab.get("name") == "Asha Rao" and ab.get("linkedin") == "https://www.linkedin.com/in/asha" and ab.get("python") == "yes"
                and ab.get("visa") == "no", f"Ashby: legal name, LinkedIn, its yes/no buttons ({ab})")
        t.check(ab.get("resume") == resume_name and ab.get("autofill") == 0, "the resume in its own box, not the autofill one")
        t.check(ab.get("project", "").startswith("A search ranking model"), "and the answer you wrote")
        t.check(f"https://jobs.ashbyhq.com/acme/{ASHBY_ID}/application" in log, "the job another site found is applied to on its company site")
        apps = dash.evaluate("async () => JB.tracker.list((await chrome.storage.local.get('jobs')).jobs, {}).map(a => [a.key, a.title, a.company])")
        t.check(["company:gh-1001", "ML Engineer", "Acme"] in apps, f"applied ones are in Applications, with title and company ({apps})")

        print("\nA look before it's sent")
        settings(company={"searchUrls": [gh("1002")], "sendMode": "review"})
        t.click("apply")
        box = t.wait_prompt("Filled in: send it?")
        t.check("Data Engineer at Acme" in box.inner_text(), "it shows which job, filled in, and waits")
        dash.bring_to_front()
        dash.locator(".bot .prompt button", has_text=re.compile("^Send it$")).click()
        wait_done()
        t.check(status("gh-1002") == "applied" and forms.posted.get("greenhouse:1002", {}).get("before") == "No",
                "sent when you say, the question you answered once answered again")

        print("\nNothing left")
        t.click("apply")
        s = wait_done()
        t.check("Nothing to apply to" in "\n".join(s["log"]), "applied ones aren't applied to again")

        t.check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not t.failures else f'{t.failures} failed.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
