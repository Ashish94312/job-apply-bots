#!/usr/bin/env python3
"""End-to-end test of the answers you give when the bot asks, in a real Chromium on the fake Hirist (see e2e.py):
questions left for you, answered in Settings and used on the next run; asked on the dashboard during a run; kept and
used again on another job.

  .venv/bin/python extension/tests/e2e_answers.py            # headless
  .venv/bin/python extension/tests/e2e_answers.py --headed   # watch it
  .venv/bin/python extension/tests/e2e_answers.py --shots DIR  # also save screenshots to DIR
"""
import argparse
import sys
import tempfile
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

from e2e import CACHE, EXT, JOBS, REACT, Hirist, Test, launch

# More jobs asking the question nothing in Settings answers ("Describe your favourite colour").
JOBS["2013"] = ("Hue Co", "Python Developer", "1 - 3", "screening-hard")
JOBS["2014"] = ("Tint Co", "Python Developer", "1 - 3", "screening-hard")
JOBS["2015"] = ("Shade Co", "Python Developer", "1 - 3", "screening-hard")
COLOUR = "4 describe your favourite colour"  # the question's key


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--shots", type=Path)
    args = parser.parse_args()
    if args.shots:
        args.shots.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    for name, url in REACT.items():
        if not (CACHE / name).exists():
            urllib.request.urlretrieve(url, CACHE / name)

    site = Hirist()
    site.logged_in = True
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx, dash = launch(pw, EXT, profile, args.headed, site)
        t = Test(ctx, dash, site)
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector(".bot h2")
        t.set_settings(
            profile={"answers": [["notice period", "30 days"], ["expect.*(ctc|salary|compensation)", "12 LPA"],
                                 ["immediate(ly)? join|join immediately", "Yes"]]},
            site={"keywords": ["python"], "searchUrls": []},
            limits={"delaySeconds": [0, 0], "maxPages": 1, "maxPerDay": 30, "maxPerRun": 10},
        )

        def store(key):
            return dash.evaluate(f"async () => (await chrome.storage.local.get('{key}'))['{key}'] || {{}}")

        def shot(name):
            if args.shots:
                dash.screenshot(path=str(args.shots / f"{name}.png"), full_page=True)

        def apply(*jids):
            site.listed = list(jids)
            t.click("apply")

        def settings_answers():
            t.page("settings")
            dash.click('.toc [data-goto="your-answers"]')

        print("Left for you, answered in Settings")
        apply("2003")
        t.wait_done()
        t.check(t.status("2003") == "needs_manual", "a question nothing answers leaves the job for you")
        waiting = store("waiting")
        t.check(COLOUR in waiting and waiting[COLOUR]["jobs"] == ["hirist:2003"] and waiting[COLOUR]["kind"] == "long",
                f"the question waits for an answer, with the job it held up ({list(waiting)})")
        t.page("overview")
        link = dash.locator("#needs-list a", has_text="question")
        t.check(link.count() == 1, "the overview offers to answer it")
        link.click()
        item = dash.locator("#waiting-list li", has_text="Describe your favourite colour")
        item.wait_for()
        t.check("1 job left for you over it, on Hirist" in item.inner_text(), "Settings lists it, with how many jobs it held up")
        item.get_by_role("button", name="Save").click()
        t.check("Type or pick the answer first." in dash.locator("#answers-status").inner_text(), "an empty answer isn't saved")
        item.locator("textarea").fill("Blue")
        item.get_by_role("button", name="Save").click()
        dash.wait_for_function(f"async () => ((await chrome.storage.local.get('kept')).kept || {{}})['{COLOUR}']?.answer === 'Blue'")
        t.check("1 job it left for you will be tried again" in dash.locator("#answers-status").inner_text(), "saving says the job goes again")
        t.check("hirist:2003" not in t.jobs() and not store("waiting"), "the job is forgotten, so the next run tries it")
        t.check(dash.locator("#kept-list li", has_text="Describe your favourite colour").count() == 1, "the answer is listed as kept")
        shot("1-your-answers")

        apply("2003")
        t.wait_done()
        t.check(t.status("2003") == "applied" and site.posted["2003"]["colour"] == "Blue", f"the next run applies with it ({site.posted.get('2003')})")

        print("\nUsed again on another job")
        apply("2013")
        t.wait_done()
        t.check(t.status("2013") == "applied" and site.posted["2013"]["colour"] == "Blue", "the same question elsewhere gets the same answer")

        print("\nAsked during a run")
        settings_answers()
        dash.locator("#kept-list li", has_text="Describe your favourite colour").get_by_role("button", name="Forget").click()
        dash.wait_for_function(f"async () => !((await chrome.storage.local.get('kept')).kept || {{}})['{COLOUR}']")
        t.check(True, "an answer can be forgotten")
        t.page("overview")
        dash.click(".bot details.opts summary")
        dash.check('.opts [name="assist"]')
        dash.click(".bot h1")  # close the options menu
        apply("2014")
        box = t.wait_prompt("A question it has no answer for")
        t.check("Tint Co" in box.inner_text() and box.locator("textarea").count() == 1, "the dashboard asks it, with a box to answer in")
        shot("2-asked")
        t.answer("Save and continue")
        t.check("Answer each one" in box.locator(".prompt-err").inner_text(), "it needs an answer to go on")
        box.locator("textarea").fill("Green")
        t.answer("Save and continue")
        s = t.wait_done()
        t.check(t.status("2014") == "applied" and site.posted["2014"]["colour"] == "Green", f"the form is filled with it and sent ({site.posted.get('2014')})")
        t.check(store("kept").get(COLOUR, {}).get("answer") == "Green", "and it's kept")
        t.check("Kept 1 answer for next time" in t.log(s), "the log says so")

        print("\nSkipping instead")
        dash.evaluate(f"() => chrome.runtime.sendMessage({{ type: 'unlearn', keys: ['{COLOUR}'] }})")
        apply("2015")
        t.wait_prompt("A question it has no answer for")
        t.answer("Skip this job")
        t.wait_done()
        t.check(t.status("2015") == "skipped" and "2015" not in site.posted, "Skip this job skips it, unsent")
        t.check(not store("waiting"), "a skipped job's question isn't kept waiting")

        print("\nDropdowns, in a form")
        missing = dash.evaluate("""async () => {
            await new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = "lib/page.js";
                s.onload = resolve;
                s.onerror = reject;
                document.head.append(s);
            });
            const form = document.createElement("form");
            form.innerHTML = `
              <label for="a">Notice period</label><select id="a"><option value="">Select</option><option value="1">15 Days or less</option><option value="2">1 Month</option></select>
              <label for="b">Highest degree</label><select id="b"><option value="">Select</option><option>B.Tech</option><option>M.Tech</option></select>
              <label for="c">Country</label><select id="c"><option value="in" selected>India</option><option value="us">USA</option></select>`;
            document.body.append(form);
            const answers = [["notice", "30 days"], ["=highest degree", ""]];
            const missing = await JB.page.fillForm(form, answers, "");
            const values = [...form.querySelectorAll("select")].map(e => e.value);
            const again = await JB.page.fillForm(form, [["=highest degree", "M.Tech"]], "");
            const after = form.querySelector("#b").value;
            form.remove();
            return { missing, values, again, after };
        }""")
        t.check(missing["values"][0] == "2", "a dropdown is answered from your answers: 30 days picks 1 Month")
        t.check(missing["values"][2] == "in", "a dropdown already set is left alone")
        t.check(missing["missing"] == [{"q": "Highest degree", "kind": "choice", "options": ["B.Tech", "M.Tech"]}],
                f"one with no answer comes back with its options ({missing['missing']})")
        t.check(missing["again"] == [] and missing["after"] == "M.Tech", "an answer you gave picks its option")

        t.check(not errors, f"no errors on the dashboard {errors}")
        ctx.close()

    print(f"\n{'All good.' if not t.failures else f'{t.failures} failed.'}")
    sys.exit(1 if t.failures else 0)


if __name__ == "__main__":
    main()
