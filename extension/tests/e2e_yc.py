#!/usr/bin/env python3
"""End-to-end test of YC startups in a real Chromium, on fake pages built like ycombinator.com's job pages and Work at
a Startup's: a dry run without signing in, jobs skipped for their title or because they won't sponsor the US visa you'd
need, the note's <...> part stopping the run, signing in when asked, and the note to the founders shown filled in,
changed, and sent.

  .venv/bin/python extension/tests/e2e_yc.py            # headless
  .venv/bin/python extension/tests/e2e_yc.py --headed   # watch it
"""
import argparse
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright

from e2e import EXT, Hirist, Test, launch

PAGE = """<!doctype html><html><head><meta charset=utf-8><title>{title}</title><style>[hidden]{{display:none}}</style></head>
<body>{body}<script>{script}</script></body></html>"""

# slug, job id there, Work at a Startup's id, title, company, where, visa line, founders
JOBS = [
    ("acme", "abc123A", "1001", "ML Engineer", "Acme", "Bengaluru, KA, IN / Remote (IN)", "US citizenship/visa not required", ["Priya Sharma", "Rahul Verma"]),
    ("beta", "def456B", "1002", "Senior Backend Engineer", "Beta", "Remote (US)", "Will sponsor", ["Lee Chen"]),
    ("gamma", "ghi789C", "1003", "Founding Engineer", "Gamma", "San Francisco, CA, US", "US citizen/visa only", ["Sam Ortiz"]),
]


def role_page():
    links = "".join(f'<li><a href="/companies/{slug}/jobs/{jid}-{title.lower().replace(" ", "-")}">{title}</a> <span>{company} (S24) · {where}</span></li>'
                    for slug, jid, _, title, company, where, _, _ in JOBS)
    return PAGE.format(title="Software Engineer jobs | Y Combinator", script="", body=f"<main><h1>Remote software engineer jobs</h1><ul>{links}</ul></main>")


def job_page(slug):
    _, jid, waas, title, company, where, visa, founders = next(j for j in JOBS if j[0] == slug)
    apply = f"https://account.ycombinator.com/authenticate?continue={quote(f'https://www.workatastartup.com/application?signup_job_id={waas}', safe='')}"
    people = "".join(f"<div><p>{name}</p><p>Founder</p></div>" for name in founders)
    body = (f'<main><div><a href="/companies/{slug}">{company} (S24)</a><p>We build tools for teams.</p></div><h1>{title}</h1>'
            f'<div><p>$40K - $80K</p><p>{where}</p><p>1+ years</p><p>{visa}</p><a href="{apply}">Apply now</a></div>'
            f'<h2>About the role</h2><p>Python and ML.</p><h2>Founders</h2>{people}</main>')
    return PAGE.format(title=f"{title} at {company} | Y Combinator", body=body, script="")


def waas_job(waas, applied):
    button = '<button disabled>Applied</button>' if applied else '<button id="apply">Apply</button>'
    body = f"""<main><h1>Job {waas}</h1>{button}
<div role="dialog" id="dialog" hidden><h2>Apply</h2><label>Note to the founders<textarea id="note"></textarea></label><button id="send">Send</button></div></main>"""
    script = """
const apply = document.getElementById('apply');
if (apply) apply.addEventListener('click', () => { document.getElementById('dialog').hidden = false; });
document.getElementById('send').addEventListener('click', async () => {
  await fetch(location.pathname + '/note', { method: 'POST', body: document.getElementById('note').value });
  location.reload();
});"""
    return PAGE.format(title="Work at a Startup", body=body, script=script)


class Sites:
    def __init__(self):
        self.signed_in = False
        self.notes = {}

    def handle(self, route):
        req = route.request
        u = re.sub(r"^https://", "", req.url).split("?")[0].rstrip("/")
        if req.method == "POST" and (m := re.fullmatch(r"www\.workatastartup\.com/jobs/(\d+)/note", u)):
            self.notes[m.group(1)] = req.post_data
            return route.fulfill(body="ok")
        if u.startswith("www.workatastartup.com") and not self.signed_in:  # YC's sign-in first
            return route.fulfill(status=302, headers={"Location": "https://account.ycombinator.com/authenticate"})
        html = None
        if u == "www.ycombinator.com/jobs/role/software-engineer/remote":
            html = role_page()
        elif m := re.fullmatch(r"www\.ycombinator\.com/companies/([\w-]+)/jobs/\w+-[\w-]+", u):
            html = job_page(m.group(1))
        elif u == "account.ycombinator.com/authenticate":
            html = PAGE.format(title="Sign in | YC", script="", body="<main><h1>Sign in</h1><button>Log in</button></main>")
        elif u == "www.workatastartup.com/application":
            html = PAGE.format(title="Work at a Startup", script="", body="<main><h1>Your profile</h1></main>")
        elif m := re.fullmatch(r"www\.workatastartup\.com/jobs/(\d+)", u):
            html = waas_job(m.group(1), m.group(1) in self.notes)
        if html is None:
            return route.fulfill(status=404, body="not found")
        route.fulfill(body=html, content_type="text/html; charset=utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    sites = Sites()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as tmp:
        # Chrome's permission prompt can't be clicked from a test: allow YC's sites in a copy instead.
        ext = Path(tmp) / "extension"
        shutil.copytree(EXT, ext, ignore=shutil.ignore_patterns("tests"))
        manifest = json.loads((ext / "manifest.json").read_text())
        manifest["host_permissions"] += ["https://www.ycombinator.com/*", "https://account.ycombinator.com/*", "https://www.workatastartup.com/*"]
        (ext / "manifest.json").write_text(json.dumps(manifest))
        ctx, dash = launch(pw, ext, Path(tmp) / "profile", args.headed, Hirist())
        for host in ("www.ycombinator.com", "account.ycombinator.com", "www.workatastartup.com"):
            ctx.route(f"https://{host}/**", sites.handle)
        t = Test(ctx, dash, None)
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector(".bot h2")

        def run_state():
            return dash.evaluate("async () => (await chrome.storage.session.get('run:yc'))['run:yc'] || null")

        def status(jid):
            r = t.jobs().get(f"yc:{jid}")
            return r and r["status"]

        def wait_done(timeout=240):
            end = time.time() + timeout
            while time.time() < end:
                s = run_state()
                if s and not s["running"]:
                    return "\n".join(s["log"])
                dash.wait_for_timeout(500)
            raise AssertionError("run didn't finish:\n" + "\n".join((run_state() or {}).get("log", [])))

        dash.evaluate("""async () => {
            const s = await JB.store.getSettings();
            Object.assign(s.profile, { firstName: "Asha", lastName: "Rao", country: "India", workIn: [{ country: "United States", can: "visa" }],
              filters: { ...s.profile.filters, includeTitle: [], requireRole: ["engineer"], excludeTitle: ["senior"], maxExperienceRequired: 2 } });
            Object.assign(s.sites.yc, { keywords: ["software engineer"], locations: ["remote"] });
            s.sites.yc.limits.delaySeconds = [0, 0];
            await JB.store.saveSettings(s);
        }""")
        dash.goto(dash.url.split("#")[0] + "#overview/yc")
        dash.wait_for_selector("#site-name:text('YC startups')")

        print("YC startups: a dry run, signed out")
        t.click("dry-run")
        log = wait_done()
        t.check("~ would apply" in log and "ML Engineer" in log and log.count("~ would apply") == 1, f"would apply to Acme's job only\n{log[-700:]}")
        t.check(status("def456B") == "skipped" and "senior" in t.jobs()["yc:def456B"]["note"], "a senior title is skipped")
        t.check(status("ghi789C") == "skipped" and "visa" in t.jobs()["yc:ghi789C"]["note"],
                "a US job that's \"US citizen/visa only\", when you'd need a US visa, is skipped")

        print("\nThe note's <...> part stops it")
        dash.evaluate("async () => { await chrome.storage.local.set({ jobs: {} }); }")
        sites.signed_in = True
        t.click("apply")
        log = wait_done()
        t.check("still has a <...> part" in log and not sites.notes, "nothing sent while the template has its <...> part")

        print("\nSigned out: it asks you to sign in, then sends the note you looked at")
        sites.signed_in = False
        dash.evaluate("""async () => {
            const s = await JB.store.getSettings();
            s.sites.yc.message = "Hi {founders},\\n\\nI'd love to join {company} as {title}. I built a search ranking model.\\n\\n{name}";
            await JB.store.saveSettings(s);
            await chrome.storage.local.set({ jobs: {} });
        }""")
        t.click("apply")
        t.wait_prompt("Log in")
        sites.signed_in = True
        t.answer("Done, continue")
        box = t.wait_prompt("Send this note?")
        note = box.locator("textarea")
        t.check(note.input_value() == "Hi Priya and Rahul,\n\nI'd love to join Acme as ML Engineer. I built a search ranking model.\n\nAsha Rao",
                f"the note for Acme, to its founders by name ({note.input_value()!r})")
        note.fill(note.input_value().replace("I built", "I've read your launch post, and I built"))
        box.get_by_role("button", name="Send it", exact=True).click()
        log = wait_done()
        t.check(status("abc123A") == "applied" and "I've read your launch post" in sites.notes.get("1001", ""),
                f"the note as you changed it is sent, and the job counted as applied\n{log[-500:]}")
        t.check(set(sites.notes) == {"1001"}, "nothing sent to the skipped ones")
        t.check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not t.failures else f'{t.failures} FAILED.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
