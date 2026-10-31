#!/usr/bin/env python3
"""Make a YouTube Short about Applications, Sendoff's tracker: what you can add, what it reads for you, and how to
follow each job to the end. About a minute, 1080x1920, the same look as make_short.py and the same sample data.

  .venv/bin/python store/make_tracking_short.py                   # writes video/sendoff-tracking-neerja.mp4
  .venv/bin/python store/make_tracking_short.py --voice prabhat   # a male voice
  .venv/bin/python store/make_tracking_short.py --music-only --music track.mp3   # music under the last one
"""
import json
import time

from make_short import DASH_H, DASH_W, Dashboard, fit, main, push

SCENES = [
    ("stats", "Applied to dozens of jobs and lost track? Sendoff keeps track of every application for you."),
    ("list", "Every job it applies to lands here on its own, with where it stands."),
    ("add", "Applied somewhere else? Add it in seconds."),
    ("replies", "Tap Check for replies, and it reads LinkedIn and Naukri for you: viewed, shortlisted, or not selected."),
    ("templates", "Heard back? Add the interview rounds from a template in one tap."),
    ("rounds", "Book each round, and add it to your calendar."),
    ("result", "Mark each round cleared or not, and how it ended: offer, rejected, or ghosted."),
    ("upnext", "Up next shows your interviews, assignments due, and offers to answer."),
    ("figures", "And see what works: your reply rate on each site, and with a referral."),
    ("end", "It's free in early access. Try it, and tell me what to add next. Link in the description."),
]
WHERE = {"list": "Applications", "add": "Applications › Add an application", "replies": "Applications › Check for replies",
         "templates": "Application › Rounds", "rounds": "Application › Rounds", "result": "Application › Result",
         "upnext": "Applications › Up next", "figures": "Applications › Where they stand"}

# On top of the sample applications: referrals asked at a few LinkedIn companies, what Naukri said, the timeline and
# notes of the one with a round booked, and one you added yourself. Returns the keys of the ones the panel shows.
TRACK = """async () => {
  const pad = n => String(n).padStart(2, "0");
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const stamp = (n, h, m = 0) => `${day(n)} ${pad(h)}:${pad(m)}:00`;
  const round = (kind, name, status) => ({ id: Math.random().toString(36).slice(2), kind, name, at: "", due: "", status, note: "" });
  const { jobs, track } = await chrome.storage.local.get(["jobs", "track"]);
  const key = j => `${j.site}:${j.jobId}`;
  const of = site => Object.values(jobs).filter(j => j.site === site && j.status === "applied").sort((a, b) => b.ts.localeCompare(a.ts));
  const linkedin = of("linkedin"), naukri = of("naukri");
  const [booked, heard] = linkedin, offer = of("hirist")[0];
  const contacts = {};
  ["Ananya Rao", "Vikram Mehta", "Sara Thomas", "Rohan Iyer", "Meera Nair"].forEach((name, i) => { const j = linkedin[i], profile = `https://www.linkedin.com/in/demo-r${i}/`;
    contacts[profile] = { profile, name, headline: `Engineer at ${j.company}`, company: j.company, companyUrl: "", jobId: j.jobId, jobUrl: j.url,
                          title: j.title, status: "messaged", note: "", ts: stamp(-6, 10), updated: stamp(-6, 10) }; });
  const t = j => track[key(j)] || (track[key(j)] = { key: key(j), heard: null, rounds: [], outcome: null, notes: "", log: [] });
  naukri.slice(3, 6).forEach(j => Object.assign(t(j), { viewed: day(-1), signals: { viewed: day(-1) }, log: [{ ts: stamp(-1, 9, 30), text: "Naukri says: application viewed" }] }));
  Object.assign(t(naukri[1]), { signals: { replied: day(-1) }, log: [{ ts: stamp(-1, 9, 30), text: "Naukri says they got in touch" }] });
  Object.assign(t(naukri[2]), { signals: { rejected: day(-4) }, log: [{ ts: stamp(-4, 9, 30), text: "Naukri says: not selected" }] });
  const b = t(booked);
  b.rounds.push(round("interview", "Hiring manager", "planned"));
  b.notes = "Recruiter: Kavya. Revise system design; ask about the team's ML stack.";
  b.log = [{ ts: stamp(-6, 10, 2), text: "They replied" }, { ts: stamp(-4, 16), text: "Round 1 (Recruiter call): cleared" }, { ts: stamp(-3, 12), text: "Round 2 (Technical): booked" }];
  track["manual:demo1"] = { key: "manual:demo1", site: "manual", jobId: "demo1", title: "Data Engineer", company: "Zephyr Pay", url: "",
    appliedAt: stamp(-5, 12), source: "manual", through: "Someone referred me", heard: { at: day(-2), via: "referral", who: "" },
    rounds: [], outcome: null, notes: "", log: [{ ts: stamp(-2, 18), text: "They replied" }], updated: stamp(-2, 18) };
  await chrome.storage.local.set({ contacts, track });
  return { booked: key(booked), heard: key(heard), offer: key(offer) };
}"""

STATUS = ("Reading LinkedIn and Naukri in their own windows. Applications update as each finishes; "
          "see each site's overview for how it went.")
# At phone width a round's boxes make the panel wider than the screen.
PHONE = (".panel-body, .rounds, .round-main { grid-template-columns: minmax(0, 1fr); } .round-top > .bare { width: 0; }")


def shots(pw, tmp):
    """The screenshots for each scene, and where on them the parts the camera looks at are."""
    dash = Dashboard(pw, tmp)
    page, url, boxes, shot = dash.page, dash.url, dash.boxes, dash.shot
    keys = page.evaluate(TRACK)
    page.goto(f"{url}#applications")
    page.reload()
    page.wait_for_selector("#figures b")
    page.add_style_tag(content=PHONE)
    time.sleep(0.8)
    to_top = lambda: page.evaluate("window.scrollTo(0, 0)")  # clicking scrolls; boxes are measured from the top

    a, heard, rounds, offers = (int(n.replace(",", "")) for n in page.locator("#figures b").all_inner_texts())
    out = {"stats": {"nums": [a, heard, rounds, offers], "shares": [1, heard / a, rounds / heard, offers / rounds]}}
    out["upnext"] = out["figures"] = ([shot("apps.png")], {"upnext": boxes([".upnext"]), "figures": boxes(["#figures"]),
                                                          "foot": boxes(["#funnel-foot"])})

    page.click('#app-chips .chip[data-group="active"]')
    to_top()
    top = page.locator(".apps-list").bounding_box()["y"] - 24
    out["list"] = ([shot("list.png", top=top, height=1300)],
                   {"list": boxes([".apps-list h2", "#app-rows tr:nth-child(2)"], top),
                    "rows": boxes(["#app-rows tr:nth-child(1)", "#app-rows tr:nth-child(4)"], top)})

    page.click("#add-app")
    form = page.locator("#add-form")
    form.locator('[name="title"]').fill("Data Engineer")
    form.locator('[name="company"]').fill("Zephyr Pay")
    form.locator('[name="url"]').fill("https://careers.example.com/zephyr-pay/data-engineer")
    form.locator('[name="through"]').select_option("Someone referred me")
    page.locator("#add-form h2").click()  # nothing focused, so no caret blinking in a box
    out["add"] = ([shot("add.png", height=DASH_H, full=False)], {"dialog": boxes(["#add-dialog"])})
    page.keyboard.press("Escape")

    page.select_option("#app-site", "naukri")
    page.click('#app-chips .chip[data-group=""]')
    page.evaluate("t => { const s = document.getElementById('replies-status'); s.textContent = t; s.hidden = false; }", STATUS)
    to_top()
    end = page.locator(".apps-list").bounding_box()
    out["replies"] = ([shot("replies.png", height=end["y"] + end["height"] + 20)],
                      {"head": boxes([".apps-head"]), "rows": boxes(["#app-rows tr:nth-child(1)", "#app-rows tr:nth-child(5)"])})

    page.set_viewport_size({"width": DASH_W, "height": 2200})  # the panel is as tall as the screen: all of it at once
    section = lambda n: f"#app-panel-body > section:nth-of-type({n})"
    for name, which in [("templates", "heard"), ("rounds", "booked"), ("result", "offer")]:
        page.evaluate(f"openApp({json.dumps(keys[which])})")
        time.sleep(0.6)
        tall = page.evaluate("document.getElementById('app-panel').scrollHeight")
        out[name] = ([shot(f"{name}.png", height=min(2200, tall), full=False)],
                     {"top": boxes(["#app-panel .panel-top", "#app-panel .steps"]), "heard": boxes([section(1)]),
                      "rounds": boxes([section(2)]), "result": boxes([section(3)])})
        page.evaluate("document.getElementById('app-panel').close()")
    dash.close()
    return out


def camera(name, b, d):
    """Keyframes [(seconds, camera)] for a dashboard scene `d` seconds long."""
    hold = lambda cam, f=1.05: [(0, cam), (d, push(cam, f))]
    if name == "list":
        return [(0, fit(b["list"])), (d * 0.45, push(fit(b["list"]), 1.02)), (d, fit(b["rows"], 1.35))]
    if name == "add":
        return hold(fit(b["dialog"]))
    if name == "replies":
        return [(0, fit(b["head"])), (d * 0.35, push(fit(b["head"]), 1.03)), (d * 0.35 + 1.0, fit(b["rows"])), (d, push(fit(b["rows"]), 1.04))]
    if name == "templates":
        return [(0, fit(b["top"])), (d * 0.3, fit(b["top"])), (d * 0.3 + 0.9, fit(b["rounds"])), (d, push(fit(b["rounds"]), 1.03))]
    if name == "rounds":
        return [(0, fit(b["top"])), (0.9, fit(b["rounds"])), (d, push(fit(b["rounds"]), 1.04))]
    if name == "result":
        return [(0, fit(b["rounds"])), (d * 0.45, fit(b["rounds"])), (d * 0.45 + 0.9, fit(b["result"], 1.4)), (d, push(fit(b["result"], 1.4), 1.04))]
    if name == "upnext":
        return hold(fit(b["upnext"]))
    return [(0, fit(b["figures"])), (d * 0.45, push(fit(b["figures"]), 1.03)), (d * 0.45 + 0.9, fit(b["foot"], 1.5)), (d, push(fit(b["foot"], 1.5), 1.04))]


if __name__ == "__main__":
    main(__doc__, "tracking", SCENES, shots, camera, WHERE)
