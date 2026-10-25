#!/usr/bin/env python3
"""End-to-end test of reading replies, in a real Chromium: LinkedIn's and Naukri's lists of the jobs you applied to
(fakes of them), and what they say of each ("Application viewed", "No longer being considered", "Recruiter Action",
"Not Shortlisted") going into Applications.

  .venv/bin/python extension/tests/e2e_replies.py            # headless
  .venv/bin/python extension/tests/e2e_replies.py --headed   # watch it
"""
import argparse
import re
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

from e2e import EXT, Hirist, Test, launch

LINKEDIN = {  # job id: (title, company, what LinkedIn's card says)
    "400101": ("ML Engineer", "Acme", "Applied 3d ago · Application viewed"),
    "400102": ("Data Scientist", "Beta", "Applied 2w ago · No longer being considered"),
    "400103": ("AI Engineer", "Gamma", "Applied 1w ago"),
    "400199": ("Someone Else's Job", "Delta", "Application viewed"),  # not one Sendoff knows: left alone
}
NAUKRI = {
    "231024500201": ("Python Developer", "Plinth", "Applied on 20 Oct · Recruiter Action"),
    "231024500202": ("Backend Engineer", "Quill", "Applied on 18 Oct · Not Shortlisted"),
}
PAGE = "<!doctype html><html><head><meta charset=utf-8><title>{title}</title></head><body>{body}</body></html>"


def naukri_url(jid):
    return f"https://www.naukri.com/job-listings-{jid[-3:]}-engineer-co-bengaluru-1-to-3-years-{jid}"


class Sites:
    def __init__(self):
        self.reads = []

    def linkedin(self, route):
        path = re.sub(r"^https://(www\.)?linkedin\.com", "", route.request.url)
        if path.startswith("/feed"):
            return route.fulfill(body=PAGE.format(title="Feed | LinkedIn", body="<h1>Your feed</h1>"), content_type="text/html")
        if path.startswith("/my-items/saved-jobs/"):
            self.reads.append(("linkedin", path))
            start = int((re.search(r"start=(\d+)", path) or [0, "0"])[1])
            cards = "" if start else "".join(
                f'<li class="entity-result"><a href="https://www.linkedin.com/jobs/view/{jid}/">{t}</a><span>{c} · Bengaluru</span><p>{s}</p></li>'
                for jid, (t, c, s) in LINKEDIN.items())
            return route.fulfill(body=PAGE.format(title="My Jobs | LinkedIn", body=f"<main><h1>Applied</h1><ul>{cards}</ul></main>"), content_type="text/html")
        route.fulfill(status=404, body="not found")

    def naukri(self, route):
        path = re.sub(r"^https://(www\.)?naukri\.com", "", route.request.url)
        if path.startswith("/mnjuser/homepage"):
            return route.fulfill(body=PAGE.format(title="Naukri", body="<h1>My Naukri</h1>"), content_type="text/html")
        if path.startswith("/myapply/historypage"):
            self.reads.append(("naukri", path))
            cards = "".join(f'<article class="apply-tuple"><a href="{naukri_url(jid)}">{t}</a><span>{c}</span><p>{s}</p></article>'
                            for jid, (t, c, s) in NAUKRI.items())
            return route.fulfill(body=PAGE.format(title="Applies | Naukri", body=f"<main>{cards}</main>"), content_type="text/html")
        route.fulfill(status=404, body="not found")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    sites = Sites()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx, dash = launch(pw, EXT, profile, args.headed, Hirist())
        ctx.route(re.compile(r"^https://(www\.)?linkedin\.com/"), sites.linkedin)
        ctx.route(re.compile(r"^https://(www\.)?naukri\.com/"), sites.naukri)
        t = Test(ctx, dash, None)
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector(".bot h2")

        def state(site):
            return dash.evaluate(f"async () => (await chrome.storage.session.get('run:{site}'))['run:{site}'] || null")

        def wait_done(site, timeout=180):
            end = time.time() + timeout
            while time.time() < end:
                s = state(site)
                if s and not s["running"]:
                    return s
                dash.wait_for_timeout(500)
            raise AssertionError(f"{site} didn't finish: {(state(site) or {}).get('log')}")

        def track():
            return dash.evaluate("async () => (await chrome.storage.local.get('track')).track || {}")

        rows = [(f"linkedin:{j}", "linkedin", j, t_, c, "https://www.linkedin.com/jobs/view/" + j) for j, (t_, c, _) in LINKEDIN.items() if j != "400199"]
        rows += [(f"naukri:{j}", "naukri", j, t_, c, naukri_url(j)) for j, (t_, c, _) in NAUKRI.items()]
        dash.evaluate("""async rows => {
            const jobs = {};
            for (const [key, site, jobId, title, company, url] of rows) jobs[key] = { site, jobId, url, title, company, status: 'applied', note: '', ts: '2026-10-15 10:00:00', shot: false };
            await chrome.storage.local.set({ jobs });
        }""", rows)

        print("Settings")
        t.page("settings")
        t.check(dash.locator('[name="sites.linkedin.readReplies"]').is_checked() and dash.locator('[name="sites.naukri.readReplies"]').is_checked(),
                "reading replies after each run is on for LinkedIn and Naukri to start with")

        print("\nCheck for replies, from Applications")
        t.page("applications")
        dash.click("#check-replies")
        dash.locator("#replies-status", has_text="Reading").wait_for(timeout=10000)
        t.check("Reading LinkedIn and Naukri" in dash.locator("#replies-status").inner_text(), "it reads both, each in its own window")
        li, nk = wait_done("linkedin"), wait_done("naukri")
        tr = track()
        t.check(tr.get("linkedin:400101", {}).get("viewed") and not tr["linkedin:400101"].get("outcome"), "LinkedIn's 'Application viewed' marks it viewed")
        t.check(tr.get("linkedin:400102", {}).get("outcome") == "rejected", "'No longer being considered': rejected")
        t.check("linkedin:400103" not in tr, "one that says nothing yet is left as it was")
        t.check(not any(k.endswith("400199") for k in tr), "a job Sendoff doesn't know is left alone")
        t.check(tr.get("naukri:231024500201", {}).get("heard", {}).get("via") == "site", "Naukri's 'Recruiter Action': heard back, through the site")
        t.check(tr.get("naukri:231024500202", {}).get("outcome") == "rejected", "'Not Shortlisted': rejected")
        t.check("Read 4 of your applications on LinkedIn: 1 viewed, 0 got in touch, 1 not selected" in "\n".join(li["log"]), "the log says what it read")
        t.check(("linkedin", "/my-items/saved-jobs/?cardType=APPLIED&start=10") in sites.reads, "it goes on to the next page of the list, and stops when it ends")

        t.page("applications")
        dash.click('#app-chips .chip[data-group=""]')
        row = dash.locator("#app-rows tr", has=dash.locator(".job-link", has_text=re.compile("^ML Engineer$")))
        t.check(row.locator(".tag", has_text="Viewed").count() == 1, "the list shows it was viewed")
        row.locator(".job-link").click()
        t.check("LinkedIn says: application viewed" in dash.locator(".timeline").inner_text(), "its timeline says where that came from")
        dash.keyboard.press("Escape")

        print("\nAgain: nothing new")
        dash.click("#check-replies")
        li = wait_done("linkedin")
        wait_done("naukri")
        t.check("0 viewed, 0 got in touch, 0 not selected" in "\n".join(li["log"][-3:]), "said before, so not again")
        t.check(len([e for e in track()["linkedin:400101"]["log"] if "viewed" in e["text"]]) == 1, "its timeline has it once")
        t.check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not t.failures else f'{t.failures} failed.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
