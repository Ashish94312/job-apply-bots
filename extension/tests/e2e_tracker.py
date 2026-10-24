#!/usr/bin/env python3
"""End-to-end test of the dashboard's Applications page, in a real Chromium: following applications after applying.

  .venv/bin/python extension/tests/e2e_tracker.py            # headless
  .venv/bin/python extension/tests/e2e_tracker.py --headed   # watch it
  .venv/bin/python extension/tests/e2e_tracker.py --shots DIR  # also save screenshots of each step to DIR

No job site is needed: the history is filled in as if the bot had applied.
"""
import argparse
import json
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

from e2e import EXT


def ts(days_ago):
    return (datetime.now() - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S")


def day(days_from_now):
    return (datetime.now() + timedelta(days=days_from_now)).strftime("%Y-%m-%d")


HISTORY = {  # key: (title, company, status, note, days ago)
    "linkedin:101": ("ML Engineer", "Kestrel AI", "applied", "", 3),
    "naukri:102": ("Data Scientist", "Plinth", "applied", "", 5),
    "hirist:103": ("AI Engineer", "Orbit Health", "applied", "", 30),
    "hirist:104": ("Python Developer", "Ridgeway", "needs_manual", "unanswered: 1. Expected CTC", 1),
    "hirist:105": ("Senior Engineer", "Amberline", "skipped", "title has 'senior'", 1),
    "cutshort:106": ("NLP Engineer", "Quillbase", "already_applied", "", 2),
}


class Check:
    def __init__(self):
        self.failures = 0

    def __call__(self, ok, what):
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")
        self.failures += not ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--shots", type=Path)
    args = parser.parse_args()
    if args.shots:
        args.shots.mkdir(parents=True, exist_ok=True)

    check = Check()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=not args.headed, viewport={"width": 1360, "height": 900},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"], accept_downloads=True,
        )
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        dash = ctx.new_page()
        dash.goto(f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html")
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.on("dialog", lambda d: d.accept())
        dash.wait_for_selector(".bot h2")

        def shot(name):
            if args.shots:
                dash.screenshot(path=str(args.shots / f"{name}.png"), full_page=True)

        def track():
            return dash.evaluate("async () => (await chrome.storage.local.get('track')).track || {}")

        def row(title):
            return dash.locator("#app-rows tr", has=dash.locator(".job-link", has_text=re.compile(f"^{re.escape(title)}$")))

        panel = dash.locator("#app-panel")
        body = dash.locator("#app-panel-body")

        dash.evaluate("""async history => {
            const jobs = {};
            for (const [key, [title, company, status, note, ts]] of Object.entries(history)) {
                const [site, jobId] = key.split(":");
                jobs[key] = { site, jobId, url: `https://example.com/${jobId}`, title, company, status, note, ts, shot: false };
            }
            await chrome.storage.local.set({ jobs });
        }""", {k: [*v[:4], ts(v[4])] for k, v in HISTORY.items()})

        print("Applications page")
        dash.click("#nav-applications")
        dash.wait_for_selector("#page-applications:not([hidden])")
        check(row("ML Engineer").count() == 1 and row("Senior Engineer").count() == 0, "applied jobs are listed, skipped ones aren't")
        check(row("NLP Engineer").locator(".tag", has_text="Before Sendoff").count() == 1, "a job applied before Sendoff is marked so")
        check(dash.locator('#app-chips .chip[aria-pressed="true"]').inner_text().startswith("All"), "with nothing going on, it starts on All")
        check(dash.locator("#figures li").first.locator("b").inner_text() == "3", "figures leave out jobs applied before Sendoff")
        check("Gone quiet" in row("AI Engineer").locator("td.stage").inner_text(), "30 days with no reply: gone quiet")
        check("gone quiet" in dash.locator("#upnext").inner_text(), "up next offers to close the quiet ones")
        shot("1-list")

        print("\nThey replied, from a template")
        row("ML Engineer").get_by_role("button", name="They replied").click()
        panel.wait_for(state="visible")
        check(body.locator("h1").inner_text() == "ML Engineer", "the side panel opens on it")
        check(body.get_by_role("button", name="Email", exact=True).get_attribute("aria-pressed") == "true", "a reply starts as an email today")
        body.get_by_role("button", name="Call", exact=True).click()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].heard.via === 'call'")
        check(True, "how they reached you is saved")
        who = body.locator('[data-f="heard:who"]')
        who.fill("Priya, talent team")
        who.press("Tab")
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].heard.who === 'Priya, talent team'")
        check(True, "who replied is saved on leaving the box")
        body.locator(".tpl", has_text="Startup").click()
        dash.wait_for_selector("#app-panel-body .round >> nth=3")
        names = body.locator(".round .bare:not(.note)").evaluate_all("els => els.map(e => e.value)")
        check(names == ["Recruiter call", "Take-home", "Technical", "Founder chat"], f"the template adds its rounds {names}")

        print("\nChanging the rounds")
        first = body.locator(".round").nth(0)
        first.get_by_role("button", name="Cleared", exact=True).click()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds[0].status === 'cleared'")
        due = body.locator(".round").nth(1).locator('input[type="date"]').nth(1)
        due.fill(day(2))
        due.blur()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds[1].status === 'scheduled'")
        check(body.locator(".round").nth(1).get_by_role("button", name="To do", exact=True).get_attribute("aria-pressed") == "true",
              "a due date books the take-home: To do")
        name = body.locator(".round").nth(3).locator(".bare:not(.note)")
        name.fill("Founder chat with Arjun")
        name.press("Enter")
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds[3].name === 'Founder chat with Arjun'")
        check(True, "a round can be renamed")
        body.locator(".round").nth(3).get_by_role("button", name="Move up: round 4").click()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds[2].name === 'Founder chat with Arjun'")
        check(True, "and moved")
        body.get_by_role("button", name="Add a round").click()
        dash.wait_for_selector("#app-panel-body .round >> nth=4")
        focused = dash.evaluate("document.activeElement.dataset.f || ''")
        check(focused.endswith(":name"), "a new round's name box gets the cursor")
        dash.keyboard.type("HR")
        dash.keyboard.press("Enter")
        body.locator(".round").nth(4).locator(".kind").select_option("hr")
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds[4].kind === 'hr'")
        check(track()["linkedin:101"]["rounds"][4]["name"] == "HR", "a round added by hand keeps its name and kind")
        body.locator(".round").nth(4).get_by_role("button", name="Remove: round 5").click()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds.length === 4")
        check(True, "and removed")
        when = body.locator(".round").nth(2).locator('input[type="datetime-local"]')
        when.fill(f"{day(1)}T11:00")
        when.blur()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds[2].status === 'scheduled'")
        with dash.expect_download() as dl:
            body.locator(".round").nth(2).get_by_role("button", name="Add to calendar").click()
        ics = Path(dl.value.path()).read_text()
        check("SUMMARY:Founder chat with Arjun: ML Engineer at Kestrel AI" in ics, "a booked round downloads as a calendar file")
        notes = body.locator('[data-f="notes"]')
        notes.fill("Ask about on-call.")
        notes.blur()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].notes === 'Ask about on-call.'")
        log = [e["text"] for e in track()["linkedin:101"]["log"]]
        check(log[0] == "They replied" and "Added the Startup rounds" in log and "Round 1 (Recruiter call): cleared" in log, f"the timeline keeps what happened {log}")
        check(body.locator(".timeline li").last.inner_text().endswith("Sendoff applied on LinkedIn"), "the timeline starts with the application")
        shot("2-panel")
        dash.keyboard.press("Escape")
        panel.wait_for(state="hidden")

        print("\nThe list after")
        stage = row("ML Engineer").locator("td.stage").inner_text()
        check("Assignment, to do" in stage, f"the stage shows the round on now: {stage!r}")
        check(row("ML Engineer").locator("td.via").inner_text().startswith("Call"), "and how they replied")
        upnext = dash.locator("#upnext").inner_text()
        check("Assignment · Take-home" in upnext and "Round 3 · Founder chat with Arjun" in upnext, "up next has the due date and the booked round")
        check(dash.locator("#nav-soon").inner_text() == "2", "the sidebar counts what's coming up this week")
        row("ML Engineer").get_by_role("button", name="Submitted").click()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['linkedin:101'].rounds[1].status === 'given'")
        check(True, "a quick action on the row marks the take-home submitted")
        dash.locator("#upnext li", has_text="gone quiet").get_by_role("button", name="Mark all ghosted").click()
        dash.wait_for_function("async () => (await chrome.storage.local.get('track')).track['hirist:103']?.outcome === 'ghosted'")
        check(True, "quiet ones close as ghosted in one go")
        dash.click('#app-chips .chip[data-group="active"]')
        check(row("ML Engineer").count() == 1 and row("Data Scientist").count() == 0, "Active shows only what's going on")
        dash.click('#app-chips .chip[data-group=""]')

        print("\nAdding one by hand")
        dash.click("#add-app")
        form = dash.locator("#add-form")
        form.locator('[name="title"]').fill("Backend ML Engineer")
        form.locator('[name="company"]').fill("Saltmarsh")
        form.locator('[name="through"]').select_option("Email")
        form.get_by_role("button", name="Add application").click()
        panel.wait_for(state="visible")
        check(body.locator("h1").inner_text() == "Backend ML Engineer" and "Email · added by you" in body.locator(".meta").first.inner_text(),
              "it opens, added by you through email")
        dash.keyboard.press("Escape")
        check(row("Backend ML Engineer").locator(".tag", has_text="Added by you").count() == 1, "and is listed")

        print("\nHistory")
        dash.click("#nav-history")
        dash.click('#chips .chip[data-status="needs_manual"]')
        dash.locator("#history-rows tr", has_text="Ridgeway").get_by_role("button", name="I applied myself").click()
        dash.wait_for_function("async () => (await chrome.storage.local.get('jobs')).jobs['hirist:104'].status === 'applied'")
        check(True, "I applied myself counts a job it left for you as applied")
        dash.click("#nav-applications")
        check(row("Python Developer").locator(".tag", has_text="You applied").count() == 1, "and it's in Applications")
        dash.click("#nav-history")
        dash.click('#chips .chip[data-status="applied"]')
        dash.locator("#history-rows tr", has_text="Kestrel AI").get_by_role("button", name="In Applications").click()
        panel.wait_for(state="visible")
        check(body.locator("h1").inner_text() == "ML Engineer", "a tracked job opens from History")
        dash.keyboard.press("Escape")

        print("\nOverview")
        dash.click("#nav-overview")
        coming = dash.locator("#coming-list").inner_text()
        check("Kestrel AI" in coming, f"the overview's card lists what's coming up {coming!r}")
        shot("3-overview")

        print("\nTemplates in Settings")
        dash.click("#nav-settings")
        dash.click('.toc [data-goto="applications"]')
        check(dash.locator("#templates .template").count() == 3, "three templates to start with")
        dash.click("#add-template")
        box = dash.locator("#templates .template").nth(3)
        box.locator('[data-key="template"]').fill("Agency")
        box.get_by_role("button", name="Add a round").click()
        box.locator("tbody tr input").fill("Client interview")
        box.locator("tbody tr select").select_option("interview")
        dash.locator('[name="tracker.quietDays"]').fill("14")
        dash.click("#save")
        dash.wait_for_function("async () => (await chrome.storage.local.get('settings')).settings.tracker.templates.length === 4")
        saved = dash.evaluate("async () => (await chrome.storage.local.get('settings')).settings.tracker")
        check(saved["templates"][3] == {"name": "Agency", "rounds": [["interview", "Client interview"]]} and saved["quietDays"] == 14,
              "a new template and the quiet days are saved")
        box.locator('[data-key="template"]').fill("")
        dash.click("#save")
        check("needs a name" in dash.locator("#errors").inner_text(), "a template needs a name")
        dash.click("#discard")
        if args.shots:
            dash.locator("#set-applications").screenshot(path=str(args.shots / "4-settings.png"))

        print("\nBack up")
        with dash.expect_download() as dl:
            dash.click('.toc [data-goto="bring-over"]')
            dash.click("#export")
        backup = json.loads(Path(dl.value.path()).read_text())
        check(backup["track"]["linkedin:101"]["rounds"][0]["status"] == "cleared", "the backup has the applications")

        dash.emulate_media(color_scheme="dark")
        dash.click("#nav-applications")
        row("ML Engineer").locator(".job-link").click()
        panel.wait_for(state="visible")
        time.sleep(0.3)
        if args.shots:
            dash.screenshot(path=str(args.shots / "5-panel-dark.png"))
        check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not check.failures else f'{check.failures} failed.'}")
    sys.exit(1 if check.failures else 0)


if __name__ == "__main__":
    main()
