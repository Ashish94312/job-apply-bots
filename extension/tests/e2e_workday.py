#!/usr/bin/env python3
"""End-to-end test of applying on Workday, in a real Chromium, on a fake Workday built like the real one (its
data-automation-id names, its progress bar, its list dropdowns): you sign in, then it fills each page from your
profile, resume and answers, asks what nothing answers, and sends it from Review after you say so.

  .venv/bin/python extension/tests/e2e_workday.py            # headless
  .venv/bin/python extension/tests/e2e_workday.py --headed   # watch it
"""
import argparse
import json
import re
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

from e2e import EXT, Hirist, Test, launch

HOST = "acme.wd5.myworkdayjobs.com"
JOB = "/External/job/Bengaluru/ML-Engineer_JR100"
JOB2 = "/External/job/Pune/Data-Engineer_JR200"
TITLES = {JOB: "ML Engineer", JOB2: "Data Engineer"}
STEPS = ["Create Account/Sign In", "My Information", "My Experience", "Application Questions", "Review"]

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>{title}</title>
<style>[role=listbox]{{border:1px solid #999}} .hidden{{display:none}}</style></head><body>
<header><h1 data-automation-id="headerTitle">CAREERS AT ACME</h1></header>{body}<script>{script}</script></body></html>"""


def text(id, label, required=True, kind="text"):
    star = "<abbr title='required'>*</abbr>" if required else ""
    return (f'<div data-automation-id="formField-{id}"><label for="{id}">{label}{star}</label>'
            f'<input id="{id}" name="{id}" type="{kind}" {"aria-required=true" if required else ""}></div>')


def dropdown(id, label, options, required=True):
    star = "<abbr title='required'>*</abbr>" if required else ""
    return (f'<div data-automation-id="formField-{id}"><label for="{id}">{label}{star}</label>'
            f'<button type="button" id="{id}" aria-haspopup="listbox" data-options="{json.dumps(options).replace(chr(34), "&quot;")}">Select One</button></div>')


def radios(id, label, options):
    rows = "".join(f'<label><input type="radio" name="{id}" value="{o}" required> {o}</label>' for o in options)
    return f'<fieldset data-automation-id="formField-{id}"><legend>{label}<abbr title="required">*</abbr></legend>{rows}</fieldset>'


FLOW_JS = r"""
for (const b of document.querySelectorAll('button[aria-haspopup=listbox]')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('[role=listbox]').forEach(l => l.remove());
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    for (const o of JSON.parse(b.dataset.options)) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.innerHTML = `<div>${o}</div>`;
      li.addEventListener('click', () => { b.textContent = o; b.dataset.value = o; list.remove(); });
      list.append(li);
    }
    b.after(list);
  });
}
const next = document.querySelector('[data-automation-id=bottom-navigation-next-button]');
if (next) next.addEventListener('click', async () => {
  const values = {};
  const wrong = [];
  for (const e of document.querySelectorAll('[data-automation-id=applyFlowPage] input, [data-automation-id=applyFlowPage] button[aria-haspopup]')) {
    const required = e.getAttribute('aria-required') === 'true' || e.required || e.closest('[data-automation-id^=formField]')?.querySelector('abbr');
    let v = e.tagName === 'BUTTON' ? (e.dataset.value || '') : e.type === 'radio' ? (e.checked ? e.value : null) : e.type === 'file' ? (e.files[0] || {}).name || '' : e.value;
    if (v === null) { if (!(e.name in values)) values[e.name] = ''; continue; }
    if (e.type === 'radio') { values[e.name] = v; continue; }
    values[e.id || e.name] = v;
  }
  for (const [k, v] of Object.entries(values)) {
    const field = document.querySelector(`[data-automation-id=formField-${k}]`);
    if (field && field.querySelector('abbr') && !v) wrong.push(k);
  }
  if (wrong.length) {
    document.getElementById('errors').innerHTML = `<div data-automation-id="errorMessage">Error: ${wrong.join(', ')} is required</div>`;
    return;
  }
  await fetch(location.pathname.replace(/\/apply\/.*$/, '') + '/api/step', { method: 'POST', body: JSON.stringify(values) });
  location.reload();
});
"""


SIGN_IN_JS = r"""
function show(id) {
  document.getElementById('sign-in').classList.toggle('hidden', id !== 'sign-in');
  document.getElementById('create').classList.toggle('hidden', id !== 'create');
}
const filters = document.querySelectorAll('[data-automation-id=click_filter]');
filters.forEach(f => f.addEventListener('click', async () => {
  const which = f.previousElementSibling.dataset.automationId;
  const box = f.closest('[data-automation-id$=Content]');
  const v = id => (box.querySelector(`[data-automation-id=${id}]`) || {}).value || '';
  if (which === 'signInSubmitButton') await fetch('/api/signin', { method: 'POST', body: JSON.stringify({ email: v('email'), password: v('password') }) });
  else await fetch('/api/create', { method: 'POST', body: JSON.stringify({ email: v('email'), password: v('password'), verify: v('verifyPassword'),
    agree: box.querySelector('[data-automation-id=createAccountCheckbox]').checked }) });
  location.reload();
}));
"""


class Application:
    def __init__(self):
        self.step = 1
        self.values = {}
        self.sent = False


class Workday:
    def __init__(self):
        self.accounts = {}  # email -> password
        self.signed_in = False
        self.apps = {JOB: Application(), JOB2: Application()}
        self.pages = []
        self.error = ""

    @property
    def step(self):
        return self.apps[JOB].step

    @property
    def values(self):
        return self.apps[JOB].values

    @property
    def sent(self):
        return self.apps[JOB].sent

    def sign_in_page(self):
        error = f'<div data-automation-id="errorMessage">{self.error}</div>' if self.error else ""
        button = lambda id, label: (f'<div style="position:relative"><button data-automation-id="{id}">{label}</button>'
                                    f'<div data-automation-id="click_filter" style="position:absolute;inset:0" aria-hidden="true"></div></div>')
        return (f'{error}<div data-automation-id="signInContent" id="sign-in"><label for="email">Email Address</label><input id="email" data-automation-id="email">'
                '<label for="password">Password</label><input id="password" type="password" data-automation-id="password">'
                + button("signInSubmitButton", "Sign In") + '<button data-automation-id="createAccountLink" onclick="show(\'create\')">Create Account</button></div>'
                '<div data-automation-id="createAccountContent" id="create" class="hidden"><label for="c-email">Email Address</label><input id="c-email" data-automation-id="email">'
                '<label for="c-password">Password</label><input id="c-password" type="password" data-automation-id="password">'
                '<label for="c-verify">Verify New Password</label><input id="c-verify" type="password" data-automation-id="verifyPassword">'
                '<label><input type="checkbox" data-automation-id="createAccountCheckbox"> I agree</label>'
                + button("createAccountSubmitButton", "Create Account") + '<button data-automation-id="signInLink" onclick="show(\'sign-in\')">Sign In</button></div>')

    def flow(self, job):
        app = self.apps[job]
        if app.sent:
            return PAGE.format(title="Acme", body="<main><h2>Application Submitted</h2><p>Thank you for applying.</p></main>", script="")
        current = 0 if not self.signed_in else app.step
        bar = "".join(
            f'<li data-automation-id="{"progressBarActiveStep" if k == current else "progressBarInactiveStep"}">'
            f'{"current step" if k == current else "step"} {k + 1} of {len(STEPS)}<br>{name}</li>' for k, name in enumerate(STEPS))
        if current == 0:
            content = self.sign_in_page()
        elif current == 1:
            content = (text("firstName", "First Name") + text("lastName", "Last Name") + text("email", "Email Address")
                       + text("phone", "Phone Number", kind="tel") + dropdown("country", "Country", ["United States of America", "India", "Indonesia"])
                       + dropdown("source", "How Did You Hear About Us?", ["Job Board", "LinkedIn", "Referral"])
                       + radios("worked", "Have you previously worked for Acme?", ["Yes", "No"]))
        elif current == 2:
            content = ('<div data-automation-id="formField-resume"><label>Resume/CV<abbr>*</abbr></label>'
                       '<input type="file" data-automation-id="file-upload-input-ref" name="resume"></div>' + text("linkedin", "LinkedIn", required=False))
        elif current == 3:
            content = radios("sponsor", "Will you now or in the future require sponsorship?", ["Yes", "No"]) + text("notice", "Notice Period (days)")
        else:
            content = "<h3>Review</h3>" + "".join(f"<p>{k}: {v}</p>" for k, v in app.values.items())
        label = "Submit" if current == 4 else "Save and Continue"
        footer = "" if current == 0 else f'<div id="errors"></div><button data-automation-id="bottom-navigation-next-button">{label}</button>'
        body = (f'<div data-automation-id="applyFlowPage"><h2 data-automation-id="jobTitleHeading">{TITLES[job]}</h2>'
                f'<ol data-automation-id="progressBar">{bar}</ol><div class="content">{content}</div>{footer}</div>')
        return PAGE.format(title="Acme Careers", body=body, script=FLOW_JS + SIGN_IN_JS.replace("%JOB%", job))

    def job(self, job):
        body = (f'<main><div data-automation-id="jobPostingPage"><h2 data-automation-id="jobPostingHeader">{TITLES[job]}</h2>'
                '<a data-automation-id="adventureButton" href="#" role="button">Apply</a>'
                '<div id="choices" class="hidden" role="dialog"><a data-automation-id="autofillWithResume" href="#">Autofill with Resume</a>'
                f'<a data-automation-id="applyManually" href="{job}/apply/applyManually">Apply Manually</a></div>'
                '<div data-automation-id="jobPostingDescription">Build ML systems in Python.</div></div></main>')
        script = "document.querySelector('[data-automation-id=adventureButton]').addEventListener('click', e => { e.preventDefault(); document.getElementById('choices').classList.remove('hidden'); });"
        return PAGE.format(title="ML Engineer", body=body, script=script)

    def handle(self, route):
        req = route.request
        path = re.sub(rf"^https://{re.escape(HOST)}", "", req.url).split("?")[0]
        self.pages.append(path)
        if path == "/api/signin":
            d = json.loads(req.post_data or "{}")
            self.signed_in = bool(d.get("email")) and self.accounts.get(d["email"]) == d.get("password")
            self.error = "" if self.signed_in else "Wrong email address or password."
            return route.fulfill(json={"ok": self.signed_in})
        if path == "/api/create":
            d = json.loads(req.post_data or "{}")
            ok = d.get("agree") and d.get("password") and d["password"] == d.get("verify") and d.get("email") not in self.accounts
            if ok:
                self.accounts[d["email"]] = d["password"]
                self.signed_in, self.error = True, ""
            else:
                self.error = "Couldn't create the account."
            return route.fulfill(json={"ok": bool(ok)})
        if m := re.match(r"^(/External/job/[^/]+/[^/]+)/api/step$", path):
            app = self.apps[m[1]]
            app.values.update(json.loads(req.post_data or "{}"))
            if app.step == 4:
                app.sent = True
            app.step += 1
            return route.fulfill(json={"ok": True})
        for job in (JOB, JOB2):
            if path == job:
                return route.fulfill(body=self.job(job), content_type="text/html")
            if path.startswith(job + "/apply"):
                return route.fulfill(body=self.flow(job), content_type="text/html")
        route.fulfill(status=404, body="not found")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    wd = Workday()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx, dash = launch(pw, EXT, profile, args.headed, Hirist())
        ctx.route(f"https://{HOST}/**", wd.handle)
        t = Test(ctx, dash, None)
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector(".bot h2")

        def run_state():
            return dash.evaluate("async () => (await chrome.storage.session.get('run:company'))['run:company'] || null")

        def wait_done(timeout=300):
            end = time.time() + timeout
            while time.time() < end:
                s = run_state()
                if s and not s["running"]:
                    return s
                dash.wait_for_timeout(500)
            s = run_state() or {}
            raise AssertionError(f"run didn't finish, it's at {s.get('now')!r}:\n" + "\n".join(s.get("log", [])))

        dash.evaluate("""async link => {
            const s = await JB.store.getSettings();
            Object.assign(s.profile, { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+91 98765 43210', country: 'India',
              answers: [['hear about', 'LinkedIn'], ['sponsorship', 'No'], ['notice period', '30']] });
            Object.assign(s.sites.company, { searchUrls: [link], fromOthers: false, sendMode: 'review' });
            s.sites.company.limits.delaySeconds = [0, 0];
            await JB.store.saveSettings(s);
            await JB.store.saveResume({ name: 'Asha_Rao_Resume.pdf', type: 'application/pdf', size: 1500, data: btoa('%PDF-1.4 ' + 'x'.repeat(1500)) });
        }""", f"https://{HOST}{JOB}")

        print("Workday, page by page")
        dash.goto(dash.url.split("#")[0] + "#overview/company")
        t.front()
        dash.click(".bot details.opts summary")
        dash.check('.opts [name="assist"]')
        dash.click(".bot h1")
        t.click("apply")
        box = t.wait_prompt("Sign in, then continue")
        t.check("acme's Workday" in box.inner_text() and "Settings > Your profile" in box.inner_text(),
                "with no sign-in saved, it hands you the sign-in (and says where to save one)")
        t.check(f"{JOB}/apply/applyManually" in wd.pages, "after Apply, it picked Apply Manually (not autofill)")
        wd.accounts["asha@example.com"] = "typed by you"  # you, in the bot's window: make the account and sign in
        wd.signed_in = True
        dash.evaluate("async () => { const [tab] = (await chrome.tabs.query({})).filter(t => /myworkdayjobs/.test(t.url)); await chrome.tabs.reload(tab.id); }")
        dash.wait_for_timeout(1500)
        t.answer("Signed in, continue")
        dash.locator(".bot .prompt", has_text="previously worked for Acme").wait_for(timeout=120000)
        box = t.wait_prompt("A question it has no answer for")
        t.check(box.locator("input[type=radio]").count() == 2, "a question nothing answers is asked, with its options")
        box.get_by_label("No", exact=True).check()
        t.answer("Save and continue")
        dash.locator(".bot .prompt", has_text="Filled in: send it?").wait_for(timeout=120000)
        t.check(wd.step == 4 and "Review" in dash.locator(".bot .prompt").inner_text(), "it went page by page up to Review, and waits there")
        dash.locator(".bot .prompt button", has_text=re.compile("^Send it$")).click()
        s = wait_done()
        log = "\n".join(s["log"])
        status = t.jobs().get("company:wd-acme-jr100", {})
        t.check(wd.sent and status.get("status") == "applied", f"sent, and counted as applied ({status})\n{log[-500:]}")
        v = wd.values
        t.check(v.get("firstName") == "Asha" and v.get("lastName") == "Rao" and v.get("email") == "asha@example.com" and v.get("phone") == "+91 98765 43210",
                f"My Information from your profile ({v})")
        t.check(v.get("country") == "India" and v.get("source") == "LinkedIn", "its list dropdowns: Country from your profile, How Did You Hear from your answers")
        t.check(v.get("worked") == "No", "and the one you were asked")
        t.check(v.get("resume") == "Asha_Rao_Resume.pdf" and v.get("linkedin") == "", "My Experience: your resume, optional boxes left alone")
        t.check(v.get("sponsor") == "No" and v.get("notice") == "30", "Application Questions from your answers")
        t.check(status.get("title") == "ML Engineer" and status.get("company") == "acme", "the job's title, not the site's header")

        print("\nWith a sign-in saved: it signs in, or makes the account, itself")
        wd.signed_in = False
        t.page("settings")
        dash.click('.toc [data-goto="profile"]')
        dash.fill("#wd-email", "asha.jobs@example.com")
        dash.fill("#wd-password", "only-for-workday-7")
        dash.check("#wd-create")
        dash.click("#wd-save")
        dash.wait_for_function("async () => !!(await JB.store.workdaySignIn())")
        t.check(dash.locator("#wd-password").input_value() == "" and "Saved for asha.jobs@example.com" in dash.locator("#wd-status").inner_text(),
                "saved, and the password isn't shown again")
        t.check(not dash.locator("#savebar").evaluate("e => e.classList.contains('dirty')"), "it's saved by itself, not with the settings")
        dash.evaluate("""async link => {
            const s = await JB.store.getSettings();
            s.sites.company.searchUrls = [link];
            await JB.store.saveSettings(s);
        }""", f"https://{HOST}{JOB2}")
        asked = []
        t.click("apply")
        for _ in range(120):
            dash.wait_for_timeout(1000)
            st = run_state() or {}
            p = (st.get("prompt") or {}).get("title")
            if p and p not in asked:
                asked.append(p)
            if p == "Filled in: send it?":
                break
        t.check(asked == ["Filled in: send it?"], f"no sign-in to do, and nothing to ask: only whether to send it ({asked})")
        t.check(wd.accounts.get("asha.jobs@example.com") == "only-for-workday-7", "it tried signing in, then made the account with your saved sign-in")
        t.front()
        dash.locator(".bot .prompt button", has_text=re.compile("^Send it$")).click()
        s = wait_done()
        t.check(t.jobs().get("company:wd-acme-jr200", {}).get("status") == "applied" and wd.apps[JOB2].sent, "and applied")
        t.check(wd.apps[JOB2].values.get("worked") == "No", "with the answer you gave on the last one")
        log = "\n".join(s["log"])
        t.check("only-for-workday-7" not in log, "the password isn't in the log")

        t.page("settings")
        dash.click('.toc [data-goto="bring-over"]')
        with dash.expect_download() as dl:
            dash.click("#export")
        backup = open(dl.value.path()).read()
        t.check("only-for-workday-7" not in backup and "asha.jobs@example.com" not in backup, "nor in a backup")
        t.check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not t.failures else f'{t.failures} failed.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
