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
  await fetch('/api/step', { method: 'POST', body: JSON.stringify(values) });
  location.reload();
});
"""


class Workday:
    def __init__(self):
        self.signed_in = False
        self.step = 1
        self.values = {}
        self.sent = False
        self.pages = []

    def flow(self):
        if self.sent:
            return PAGE.format(title="Acme", body="<main><h2>Application Submitted</h2><p>Thank you for applying.</p></main>", script="")
        current = 0 if not self.signed_in else self.step
        bar = "".join(
            f'<li data-automation-id="{"progressBarActiveStep" if k == current else "progressBarInactiveStep"}">'
            f'{"current step" if k == current else "step"} {k + 1} of {len(STEPS)}<br>{name}</li>' for k, name in enumerate(STEPS))
        if current == 0:
            content = ('<div data-automation-id="signInContent"><label for="email">Email Address</label><input id="email" data-automation-id="email">'
                       '<label for="password">Password</label><input id="password" type="password" data-automation-id="password">'
                       '<button data-automation-id="signInSubmitButton" onclick="fetch(\'/api/signin\', {method: \'POST\'}).then(() => location.reload())">Sign In</button></div>')
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
            content = "<h3>Review</h3>" + "".join(f"<p>{k}: {v}</p>" for k, v in self.values.items())
        label = "Submit" if current == 4 else "Save and Continue"
        footer = "" if current == 0 else f'<div id="errors"></div><button data-automation-id="bottom-navigation-next-button">{label}</button>'
        body = (f'<div data-automation-id="applyFlowPage"><h2 data-automation-id="jobTitleHeading">ML Engineer</h2>'
                f'<ol data-automation-id="progressBar">{bar}</ol><div class="content">{content}</div>{footer}</div>')
        return PAGE.format(title="Acme Careers", body=body, script=FLOW_JS)

    def job(self):
        body = ('<main><div data-automation-id="jobPostingPage"><h2 data-automation-id="jobPostingHeader">ML Engineer</h2>'
                '<a data-automation-id="adventureButton" href="#" role="button">Apply</a>'
                '<div id="choices" class="hidden" role="dialog"><a data-automation-id="autofillWithResume" href="#">Autofill with Resume</a>'
                f'<a data-automation-id="applyManually" href="{JOB}/apply/applyManually">Apply Manually</a></div>'
                '<div data-automation-id="jobPostingDescription">Build ML systems in Python.</div></div></main>')
        script = "document.querySelector('[data-automation-id=adventureButton]').addEventListener('click', e => { e.preventDefault(); document.getElementById('choices').classList.remove('hidden'); });"
        return PAGE.format(title="ML Engineer", body=body, script=script)

    def handle(self, route):
        req = route.request
        path = re.sub(rf"^https://{re.escape(HOST)}", "", req.url).split("?")[0]
        self.pages.append(path)
        if path == "/api/signin":
            self.signed_in = True
            return route.fulfill(json={"ok": True})
        if path == "/api/step":
            self.values.update(json.loads(req.post_data or "{}"))
            if self.step == 4:
                self.sent = True
            self.step += 1
            return route.fulfill(json={"ok": True})
        if path == JOB:
            return route.fulfill(body=self.job(), content_type="text/html")
        if path.startswith(JOB + "/apply"):
            return route.fulfill(body=self.flow(), content_type="text/html")
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
        t.check("acme's Workday" in box.inner_text() and "never sees your password" in box.inner_text(), "it hands you the sign-in, its own for each company")
        t.check(f"{JOB}/apply/applyManually" in wd.pages, "after Apply, it picked Apply Manually (not autofill)")
        # you, in the bot's window: sign in
        dash.evaluate("""async () => {
            const [tab] = (await chrome.tabs.query({})).filter(t => /myworkdayjobs/.test(t.url));
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.querySelector('[data-automation-id=signInSubmitButton]').click() });
        }""")
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
        t.check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not t.failures else f'{t.failures} failed.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
