#!/usr/bin/env python3
"""Make the Chrome Web Store images in store/: five 1280x800 screenshots of the real dashboard (with made-up
sample data), the 440x280 small promo tile and the 1400x560 marquee.

  .venv/bin/python store/make_assets.py

Needs Playwright's Chromium (.venv/bin/playwright install chromium). Run it again after changing the dashboard.
"""
import json
import shutil
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
EXT = HERE.parent / "extension"

COMPANIES = [("ML Engineer", "Northwind Labs"), ("Backend Engineer", "Bluefin AI"), ("Applied AI Engineer", "Quanta Health"),
             ("Python Developer", "Lumen Retail"), ("Software Engineer", "Orbit Freight"), ("Data Scientist", "Kestrel Finance"),
             ("GenAI Engineer", "Tidewater Media"), ("Full Stack Engineer", "Cedar Learning")]

SEED = """async ([companies, site]) => {
  const pad = n => String(n).padStart(2, "0");
  const stamp = (daysAgo, h, m) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(h)}:${pad(m)}:00`; };
  const jobs = {};
  let id = 500000;
  const add = (s, status, note, daysAgo, h, m) => { const [t, c] = companies[id % companies.length];
    jobs[`${s}:${id}`] = { site: s, jobId: String(id), url: `https://example.com/jobs/${id}`, title: t, company: c, status, note, ts: stamp(daysAgo, h, m), shot: false }; id++; };
  [4, 6, 2, 7, 5, 8, 3, 0, 6, 9, 5, 7, 4, 6].forEach((n, i) => { for (let k = 0; k < n; k++) add(["hirist", "instahyre", "wellfound", "cutshort", "linkedin"][k % 5], "applied", "", 13 - i, 9 + k, (7 * k) % 60); });
  add(site, "needs_manual", "unanswered: What is your current CTC?", 0, 9, 40);
  add(site, "needs_manual", "unanswered: Can you join within 15 days? Yes No", 0, 10, 5);
  add(site, "skipped", "title has 'senior'", 0, 10, 12);
  add(site, "external", "apply opens an external site: https://careers.example.com/jobs/88", 0, 10, 20);
  await chrome.storage.local.set({ jobs });
  const s = await JB.store.getSettings();
  await JB.store.saveSettings(s);
}"""

RUN = """async ([companies, site, prompt]) => {
  const now = Date.now();
  const named = i => `${companies[i][0]} at ${companies[i][1]}`;
  const states = ["seen", "applied", "filtered", "applied", "needs_manual", "skipped", "applied", "external", "working",
                  "pending", "pending", "filtered", "pending", "seen", "pending", "pending", "pending", "filtered", "pending", "pending"];
  const cells = states.map((state, i) => ({ url: `https://example.com/jobs/${600000 + i}`, state, label: named(i % companies.length) }));
  const ev = (min, status, i, note) => ({ ts: now - min * 60000, kind: "job", status, title: companies[i][0], company: companies[i][1], url: "https://example.com/jobs/1", note });
  const events = [{ ts: now - 9 * 60000, kind: "search", label: "machine learning engineer", n: 1, listed: 20, fresh: 13 },
    ev(8, "applied", 0), ev(7, "applied", 1), ev(6, "needs_manual", 2, "unanswered: What is your current CTC?"),
    ev(5, "skipped", 3, "title has 'senior'"), ev(4, "applied", 4), ev(2, "external", 5, "apply opens an external site: https://careers.example.com/jobs/88")];
  const run = { id: "demo", site, action: "apply", running: true, started: now - 600000, ended: null, stopped: false, error: "",
    log: ["", "https://example.com/search?q=machine+learning", "  20 jobs listed, 13 new and matching"],
    now: `Filling in the application for ${named(6)}`, events, page: { label: "machine learning engineer", n: 1, listed: 20, fresh: 13, cells },
    prompt: prompt ? { id: 1, title: "Apply to this one?", text: named(7), choices: [["Apply", "y", "primary"], ["Skip", "n"], ["Stop run", "stop", "stop"]] } : null };
  await chrome.storage.session.set({ [`run:${site}`]: run });
}"""

REFER = """async (companies) => {
  const now = Date.now();
  const people = [["Ananya Rao", "messaged"], ["Vikram Mehta", "invited"], ["Sara Thomas", "messaged"]];
  const contacts = {};
  people.forEach(([name, status], i) => { const [t, c] = companies[i];
    contacts[`https://www.linkedin.com/in/demo-${i}/`] = { profile: `https://www.linkedin.com/in/demo-${i}/`, name, headline: `Software Engineer at ${c}`,
      company: c, companyUrl: "", jobId: String(i), jobUrl: "https://example.com/jobs/1", title: t, status, note: status === "invited" ? "with a note" : "",
      ts: JB.store.now(), updated: JB.store.now() }; });
  await chrome.storage.local.set({ contacts });
  const s = await JB.store.getSettings();
  s.sites.linkedin.referral.message = "Hi {first_name}, I applied for {title} at {company}: {job_url}. I'm an ML engineer with two years of Python. Would you be open to referring me?";
  await JB.store.saveSettings(s);
  const events = people.map(([name, status], i) => ({ ts: now - (5 - i) * 60000, kind: "contact", status, name, company: companies[i][1], title: companies[i][0],
    url: `https://www.linkedin.com/in/demo-${i}/`, note: status === "invited" ? "with a note" : "" }));
  await chrome.storage.session.set({ "run:linkedin": { id: "demo2", site: "linkedin", action: "refer", running: false, started: now - 400000, ended: now - 60000,
    stopped: false, error: "", log: ["", "Done: contacted 3."], now: "", events, page: null, prompt: null } });
}"""

PROMO = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: Archivo; src: url("{font}") format("woff2-variations"); font-weight: 100 900; font-stretch: 62% 125%; }}
* {{ box-sizing: border-box; margin: 0; }}
body {{ width: {w}px; height: {h}px; background: #F3F4F1; font-family: Archivo, system-ui, sans-serif; color: #16181B;
  display: flex; align-items: center; padding: 0 {pad}px; gap: {gap}px; overflow: hidden; }}
.mark {{ width: {icon}px; height: {icon}px; flex: none; }}
h1 {{ font-size: {title}px; font-weight: 700; font-stretch: 78%; letter-spacing: -0.01em; line-height: 1; }}
p {{ margin-top: {space}px; font-size: {tag}px; color: #4D535B; line-height: 1.3; }}
.strip {{ display: flex; gap: {cgap}px; margin-top: {space2}px; }}
.c {{ width: {cell}px; height: {cell}px; border-radius: {rad}px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: {glyph}px; }}
.a {{ background: #137A4C; }} .n {{ background: #B08300; }} .e {{ background: #6B52CC; }} .s {{ background: #E8EAE5; color: #8C9199; }}
.w {{ background: #fff; box-shadow: inset 0 0 0 2px #2741C4; }} .p {{ background: #fff; box-shadow: inset 0 0 0 1px #CBCFC8; }}
</style></head><body>
<img class="mark" src="{logo}" alt="">
<div><h1>Sendoff</h1><p>{tagline}</p>
<div class="strip"><span class="c a">✓</span><span class="c a">✓</span><span class="c s">–</span><span class="c n">!</span><span class="c a">✓</span><span class="c e">↗</span><span class="c w"></span><span class="c p"></span><span class="c p"></span></div>
</div></body></html>"""


def promo(page, out, w, h, **size):
    html = PROMO.format(font=(EXT / "fonts" / "archivo-latin.woff2").as_uri(), logo=(EXT / "icons" / "128.png").as_uri(), w=w, h=h, **size)
    path = HERE / f".{out.stem}.html"
    path.write_text(html)
    page.set_viewport_size({"width": w, "height": h})
    page.goto(path.as_uri())
    page.wait_for_timeout(500)
    page.screenshot(path=str(out))
    path.unlink()


def main():
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(profile, channel="chromium", headless=True, viewport={"width": 1280, "height": 800},
                                                    device_scale_factor=1, args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        url = f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html"
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_selector("#site-name")
        page.evaluate(SEED, [COMPANIES, "hirist"])

        def shot(name, hash_, before=None):
            page.goto(f"{url}{hash_}")
            page.wait_for_selector("#site-name", state="attached")
            page.evaluate("window.scrollTo(0, 0)")  # moving between pages by address keeps the scroll position
            time.sleep(0.8)
            if before:
                before()
                time.sleep(0.5)
            page.screenshot(path=str(HERE / name))
            print(f"  store/{name}")

        page.evaluate(RUN, [COMPANIES, "hirist", False])
        shot("screenshot-1-overview.png", "#overview/hirist")
        page.evaluate(RUN, [COMPANIES, "instahyre", True])
        shot("screenshot-2-asks-you.png", "#overview/instahyre")
        shot("screenshot-3-history.png", "#history", lambda: page.click('.chip[data-status=""]'))
        shot("screenshot-4-settings.png", "#settings", lambda: page.locator("#set-answers").scroll_into_view_if_needed())
        page.evaluate(REFER, COMPANIES)
        shot("screenshot-5-referrals.png", "#overview/linkedin")

        promo(page, HERE / "promo-small-440x280.png", 440, 280, pad=34, gap=22, icon=84, title=50, tag=17, space=6, space2=16,
              cell=19, cgap=5, rad=5, glyph=11, tagline="Applies to jobs for you.")
        promo(page, HERE / "promo-marquee-1400x560.png", 1400, 560, pad=150, gap=70, icon=240, title=130, tag=40, space=14, space2=40,
              cell=54, cgap=12, rad=12, glyph=28, tagline="Applies to jobs for you, in your own Chrome.")
        print("  store/promo-small-440x280.png\n  store/promo-marquee-1400x560.png")
        shutil.copy(EXT / "icons" / "128.png", HERE / "icon-128.png")
        ctx.close()


if __name__ == "__main__":
    main()
