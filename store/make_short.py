#!/usr/bin/env python3
"""Make a YouTube Short about Sendoff: about a minute, 1080x1920, from the real dashboard at phone width in dark
mode (with the same made-up sample data as the store images), a voice-over, and captions that follow each word.

  .venv/bin/python store/make_short.py                   # writes video/sendoff-short-neerja.mp4
  .venv/bin/python store/make_short.py --voice prabhat   # a male voice: video/sendoff-short-prabhat.mp4
  .venv/bin/python store/make_short.py --music-only --music track.mp3   # music under the last one: ...-neerja-music.mp4

Music has to be yours to use on YouTube (YouTube Studio's Audio Library, Pixabay, Mixkit), or add it in the YouTube
app when uploading instead.

The voice is Microsoft Edge's online text-to-speech (edge-tts), so it needs the internet; Playwright's Chromium and
ffmpeg too. Each scene lasts as long as its line takes to say. YouTube's own buttons cover the bottom of a Short, so
nothing that matters is drawn there.
"""
import argparse
import asyncio
import math
import re
import subprocess
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path

import edge_tts
from playwright.sync_api import sync_playwright

from make_assets import COMPANIES, EXT, REFER, RUN, SEED
from make_promo_video import FINAL, STEP, WORKED, ease, sharp_logo

ROOT = Path(__file__).resolve().parent.parent
VOICES = {"neerja": "en-IN-NeerjaNeural", "prabhat": "en-IN-PrabhatNeural"}
W, H, FPS, FADE = 1080, 1920, 30, 0.3
DASH_W, DASH_H, SHOT_SCALE = 420, 900, 3  # phone width, so the dashboard lays out in one column
VIEW_L, VIEW_T, VIEW_W, VIEW_H = 70, 600, 940, 1000  # where the dashboard shows in the frame
K = VIEW_W / DASH_W
LEAD, TAIL = 0.2, 0.3  # quiet before and after each line

SCENES = [
    ("hook", "Still applying to jobs one by one? Let this Chrome extension do it for you."),
    ("profile", "Set it up once. In Settings, add your details and upload your resume."),
    ("answers", "Then add answers like your current package, expected package and notice period. It fills them in for you."),
    ("run", "Now pick your roles and hit Apply. It skips the jobs that don't fit, and applies to the rest."),
    ("ask", "A new question on a form? It asks you once, and remembers."),
    ("apps", "Then it tracks replies from LinkedIn and Naukri, and your interview rounds."),
    ("refer", "It even asks your LinkedIn connections for referrals. You check every message first."),
    ("sites", "Works on LinkedIn, Naukri, Hirist, Instahyre, Wellfound, Cutshort, and company career pages."),
    ("end", "It's free in early access. Try it now, and tell me what to improve. Link in the description."),
]
SITES = ["LinkedIn", "Naukri", "Hirist", "Instahyre", "Wellfound", "Cutshort", "company"]
# Where on the dashboard each scene is, shown on the window so viewers can find it.
WHERE = {"profile": "Settings › Your profile", "answers": "Settings › Answers", "run": "Overview › Apply", "ask": "Overview",
         "apps": "Applications", "refer": "Overview › LinkedIn"}

# A made-up person's profile and resume, and the first answers in plain words.
PROFILE = """async () => {
  const s = await JB.store.getSettings();
  Object.assign(s.profile, { firstName: "Priya", lastName: "Sharma", email: "priya.sharma@example.com", phone: "+91 98765 43210",
                             city: "Bengaluru", country: "India", company: "Acme Analytics", jobTitle: "ML Engineer" });
  s.profile.answers = [["notice period", "30 days"], ["current ctc", "8 LPA"], ["expected ctc", "12 LPA"], ["total experience", "2"],
                       ["current city", "Bengaluru"], ["willing to relocate", "Yes"], ["join immediately", "No"], ["work from office", "Yes"]];
  await JB.store.saveSettings(s);
  await JB.store.saveResume({ name: "Priya_Sharma_Resume.pdf", type: "application/pdf", size: 186000, data: "" });
}"""

# A question it has no answer for, as the dashboard shows it mid-run.
ASK = """async () => {
  const key = "run:hirist", run = (await chrome.storage.session.get(key))[key];
  run.now = "";
  run.prompt = { id: 2, title: "2 questions it has no answer for",
    text: "GenAI Engineer at Tidewater Media. Answer once and it's kept for next time (Settings > Your answers).",
    choices: [["Save and continue", "save", "primary"], ["I'll do it in Chrome", "manual"], ["Skip this job", "skip"], ["Stop run", "stop", "stop"]],
    fields: [{ q: "Are you willing to relocate to Bengaluru?", kind: "choice", options: ["Yes", "No"], answer: "Yes" },
             { q: "What is your expected CTC (in LPA)?", kind: "text", options: [], answer: "18" }] };
  await chrome.storage.session.set({ [key]: run });
}"""

# Applications: some Naukri ones too, and what happened after applying to a few of them.
APPS = """async (companies) => {
  const pad = n => String(n).padStart(2, "0");
  const day = (n, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + n);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; return h === undefined ? date : `${date}T${pad(h)}:${pad(m)}`; };
  const { jobs } = await chrome.storage.local.get("jobs");
  companies.slice(0, 6).forEach(([title, company], i) => { const id = 800000 + i;
    jobs[`naukri:${id}`] = { site: "naukri", jobId: String(id), url: `https://example.com/jobs/${id}`, title, company, status: "applied",
                             note: "", ts: `${day(-3 - i)} 11:${pad(5 * i)}:00`, shot: false }; });
  await chrome.storage.local.set({ jobs });
  const of = site => Object.values(jobs).filter(j => j.site === site && j.status === "applied").sort((a, b) => b.ts.localeCompare(a.ts));
  const [n0, n1, n2] = of("naukri"), [l0, l1, l2] = of("linkedin"), [h0, h1] = of("hirist"), [i0] = of("instahyre"), [w0] = of("wellfound");
  const round = (kind, name, status, at = "", due = "") => ({ id: Math.random().toString(36).slice(2), kind, name, at, due, status, note: "" });
  const track = {};
  const put = (j, t) => { if (!j) return; const key = `${j.site}:${j.jobId}`;
    track[key] = { key, heard: null, rounds: [], outcome: null, notes: "", log: [], ...t }; };
  put(l0, { heard: { at: day(-6), via: "linkedin", who: "" }, rounds: [round("call", "Recruiter call", "cleared", day(-4, 15)), round("interview", "Technical", "scheduled", day(1, 11))] });
  put(n0, { heard: { at: day(-2), via: "site", who: "" }, rounds: [round("assignment", "Take-home", "scheduled", "", day(2))] });
  put(h0, { heard: { at: day(-12), via: "email", who: "" }, outcome: "offer",
            rounds: [round("call", "Recruiter screen", "cleared", day(-10, 12)), round("interview", "Coding", "cleared", day(-7, 16)), round("interview", "Hiring manager", "cleared", day(-3, 17))] });
  put(i0, { heard: { at: day(-5), via: "call", who: "" }, rounds: [round("interview", "Founder chat", "scheduled", day(3, 18))] });
  put(l2, { heard: { at: day(-2), via: "referral", who: "Ananya Rao" }, rounds: [round("interview", "Technical", "given", day(-1, 14))] });
  put(l1, { heard: { at: day(-1), via: "linkedin", who: "" } });
  put(n1, { heard: { at: day(-1), via: "site", who: "" } });
  put(w0, { heard: { at: day(-3), via: "email", who: "" } });
  put(h1, { heard: { at: day(-8), via: "email", who: "" }, outcome: "rejected" });
  put(n2, { heard: { at: day(-4), via: "site", who: "" }, outcome: "rejected" });
  await chrome.storage.local.set({ track });
}"""

FRAME = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Archivo; src: url("__FONT__") format("woff2-variations"); font-weight: 100 900; font-stretch: 62% 125%; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: __W__px; height: __H__px; overflow: hidden; font-family: Archivo, system-ui, sans-serif; color: #F2F4F7;
  background: radial-gradient(1000px 800px at 50% 52%, #1A2045 0%, rgba(14, 16, 19, 0) 70%), #0E1013; }
#cap { position: absolute; left: 50px; right: 50px; top: 240px; height: 320px; display: flex; flex-wrap: wrap; align-content: center;
  justify-content: center; gap: 0 22px; font-size: 84px; font-weight: 800; line-height: 1.1; letter-spacing: -0.015em;
  text-shadow: 0 6px 26px rgba(0, 0, 0, .6); transform-origin: 50% 50%; }
#cap .on { color: #FFD447; }
.slot { position: absolute; left: __VL__px; top: __VT__px; width: __VW__px; height: __VH__px; }
.win { position: absolute; inset: 0; overflow: hidden; border-radius: 30px; background: #111315;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .1), 0 40px 90px rgba(0, 0, 0, .55); }
.win img { position: absolute; left: 0; top: 0; width: __VW__px; transform-origin: 0 0; }
.tag { position: absolute; top: -34px; left: 50%; transform: translateX(-50%); z-index: 3; white-space: nowrap; padding: 14px 34px;
  border-radius: 40px; background: #6F86F2; color: #0A0F2E; font-size: 38px; font-weight: 800; box-shadow: 0 10px 30px rgba(0, 0, 0, .45); }
.card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.logo { width: 230px; height: 230px; }
.card h1 { font-size: 150px; font-weight: 700; font-stretch: 78%; letter-spacing: -0.01em; line-height: 1; margin-top: 34px; }
.card .sub { font-size: 46px; color: #B4B9C0; margin-top: 18px; }
.cells { display: grid; grid-template-columns: repeat(5, 120px); gap: 22px; margin-top: 70px; }
.cells i { width: 120px; height: 120px; border-radius: 24px; display: grid; place-items: center; font-style: normal; font-size: 60px; font-weight: 700;
  color: #fff; box-shadow: inset 0 0 0 3px #3A3E44; transition: none; }
.cells .applied { background: #1F9470; box-shadow: none; } .cells .applied::before { content: "✓"; }
.cells .needs { background: #B4891A; box-shadow: none; } .cells .needs::before { content: "!"; }
.cells .external { background: #8A79E8; box-shadow: none; } .cells .external::before { content: "↗"; }
.cells .skipped { background: #25282C; box-shadow: none; color: #6E747C; } .cells .skipped::before { content: "–"; }
.cells .working { box-shadow: inset 0 0 0 5px #6F86F2; }
.sites h3 { font-size: 52px; font-weight: 600; color: #B4B9C0; margin-bottom: 44px; }
.chips { display: grid; grid-template-columns: repeat(2, 400px); gap: 26px; }
.chips span, .co { opacity: 0; }
.chips span { height: 120px; border-radius: 60px; display: grid; place-items: center; font-size: 54px; font-weight: 700;
  background: #181A1D; box-shadow: inset 0 0 0 2px #3A3E44; }
.co { margin-top: 40px; padding: 34px 40px; border-radius: 36px; background: #1D2340; box-shadow: inset 0 0 0 2px #2A3360; width: 826px; }
.co b { display: block; font-size: 50px; font-weight: 700; }
.co span { display: block; font-size: 40px; color: #B4B9C0; margin-top: 12px; }
.cta ul { list-style: none; margin-top: 54px; display: grid; gap: 22px; text-align: left; }
.cta li { font-size: 50px; font-weight: 600; opacity: 0; }
.cta li::before { content: "✓"; color: #1F9470; margin-right: 22px; font-weight: 800; }
.pill { margin-top: 64px; padding: 30px 60px; border-radius: 80px; background: #6F86F2; color: #0A0F2E; font-size: 54px; font-weight: 800; opacity: 0; }
.logo.small { width: 140px; height: 140px; }
.stats h2 { font-size: 104px; font-weight: 700; font-stretch: 78%; letter-spacing: -0.01em; line-height: 1; margin: 30px 0 54px; }
.tiles { display: grid; grid-template-columns: repeat(2, 410px); gap: 26px; }
.tiles div { padding: 30px 36px 34px; border-radius: 30px; background: #181A1D; box-shadow: inset 0 0 0 2px #2A2D32; text-align: left; opacity: 0; }
.tiles span { display: block; font-size: 40px; color: #B4B9C0; }
.tiles b { display: block; font-size: 128px; font-weight: 700; font-stretch: 72%; line-height: 1.05; font-variant-numeric: tabular-nums; }
.tiles i { display: block; height: 12px; border-radius: 6px; background: #2A3360; margin-top: 16px; overflow: hidden; }
.tiles u { display: block; height: 100%; width: 0; background: #6F86F2; }
.tiles div:last-child u { background: #1F9470; }
</style></head><body>
<div id="cap"></div><div class="slot" id="s0"></div><div class="slot" id="s1"></div>
<template id="t-hook"><div class="card"><img class="logo" src="logo.png" alt=""><h1>Sendoff</h1><p class="sub">Chrome extension</p>
  <div class="cells">__CELLS__</div></div></template>
<template id="t-sites"><div class="card sites"><h3>Works on</h3><div class="chips">__CHIPS__</div>
  <div class="co"><b>+ company career pages</b><span>Greenhouse · Lever · Ashby · Workday</span></div></div></template>
<template id="t-stats"><div class="card stats"><img class="logo small" src="logo.png" alt=""><h2>Applications</h2><div class="tiles">
  <div><span>Applied</span><b>0</b><i><u></u></i></div><div><span>Heard back</span><b>0</b><i><u></u></i></div>
  <div><span>Interviews</span><b>0</b><i><u></u></i></div><div><span>Offers</span><b>0</b><i><u></u></i></div></div></div></template>
<template id="t-end"><div class="card cta"><img class="logo" src="logo.png" alt=""><h1>Sendoff</h1><p class="sub">Free in early access</p>
  <ul><li>Try it now, free</li><li>Tell me what to improve</li><li>Your data stays in your browser</li></ul><p class="pill">Link in description</p></div></template>
<script>
const VW = __VW__, VH = __VH__, K = __K__;
const HOOK = ["applied", "applied", "skipped", "applied", "needs", "applied", "external", "applied", "applied", "working"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pop = age => age < 0 ? [0, 0.8] : [Math.min(1, age / 0.15), 0.8 + 0.2 * Math.min(1, age / 0.2)];
const show = (el, age) => { const [o, s] = pop(age); el.style.opacity = o; el.style.transform = `scale(${s})`; };
const UPDATE = {
  hook: (el, v) => el.querySelectorAll(".cells i").forEach((c, i) => {
    c.className = i < v.n ? HOOK[i] : "";
    if (HOOK[i] === "working" && i < v.n) c.style.opacity = 0.55 + 0.45 * Math.cos(v.t * 4);
  }),
  sites: (el, v) => [...el.querySelectorAll(".chips span"), el.querySelector(".co")].forEach((c, i) => show(c, v.ages[i])),
  end: (el, v) => [...el.querySelectorAll("li"), el.querySelector(".pill")].forEach((c, i) => show(c, v.t - 0.5 - 0.45 * i)),
  stats: (el, v) => el.querySelectorAll(".tiles div").forEach((tile, i) => {
    const age = v.t - 0.2 - 0.35 * i, p = ease(clamp(age / 1.1, 0, 1));
    show(tile, age);
    tile.querySelector("b").textContent = Math.round(v.nums[i] * p);
    tile.querySelector("u").style.width = `${100 * v.shares[i] * p}%`;
  }),
};
async function render(st) {
  const cap = document.getElementById("cap");
  cap.replaceChildren(...(st.cap ? st.cap.words : []).map((w, i) => {
    const s = document.createElement("span"); s.textContent = w; if (i === st.cap.on) s.className = "on"; return s; }));
  cap.style.transform = `scale(${st.cap ? 0.9 + 0.1 * ease(st.cap.pop) : 1})`;
  for (let i = 0; i < 2; i++) {
    const el = document.getElementById("s" + i), v = st.slots[i];
    if (!v) { el.style.opacity = 0; continue; }
    el.style.opacity = v.a;
    el.style.zIndex = v.z;
    if (el.dataset.kind !== v.kind) {
      el.dataset.kind = v.kind;
      if (v.kind === "dash") el.innerHTML = "<div class='win'><img alt=''></div><p class='tag'></p>";
      else el.replaceChildren(document.getElementById("t-" + v.kind).content.cloneNode(true));
      await Promise.all([...el.querySelectorAll("img[src]")].map(img => img.decode()));
    }
    if (v.kind !== "dash") { UPDATE[v.kind](el, v); continue; }
    el.querySelector(".tag").textContent = v.tag;
    const img = el.querySelector("img");
    if (img.getAttribute("src") !== v.src) { img.src = v.src; await img.decode(); }
    const ih = img.naturalHeight / img.naturalWidth * VW;
    const tx = clamp(VW / 2 - v.cx * K * v.s, VW - VW * v.s, 0), ty = clamp(VH / 2 - v.cy * K * v.s, VH - ih * v.s, 0);
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${v.s})`;
  }
}
function ease(t) { return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; }
</script></body></html>"""


# ---------------------------------------------------------------- voice and captions

async def speak(line, voice, out):
    """Say the line into an mp3; returns each word as (text, start, end) in seconds."""
    words = []
    with out.open("wb") as f:
        async for chunk in edge_tts.Communicate(line, voice, rate="+18%", boundary="WordBoundary").stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append((chunk["text"], chunk["offset"] / 1e7, (chunk["offset"] + chunk["duration"]) / 1e7))
    return words


def length(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                                capture_output=True, text=True, check=True).stdout)


def chunks(line, words, at, end):
    """The words as captions of about three, broken at punctuation: [(start, end, [(word, start)])], times from `at`."""
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    tokens, j, out = line.split(), 0, []
    for text, t0, _ in words:
        shown = text
        for k in range(j, min(j + 3, len(tokens))):
            if norm(tokens[k]) and norm(tokens[k]).startswith(norm(text)):
                shown, j = tokens[k], k + 1
                break
        n, ends = (len(out[-1][2]), out[-1][2][-1][0][-1] in ",.?!:") if out else (0, True)
        if ends or n == 4 or (n == 3 and shown[-1] not in ",.?!:"):  # a phrase's last word stays with it
            out.append([at + t0, None, []])
        out[-1][2].append((shown, at + t0))
    for a, b in zip(out, out[1:]):
        a[1] = b[0]
    out[-1][1] = end
    return [(s, e, [(w.rstrip(",.:"), t) for w, t in ws]) for s, e, ws in out]


def mix(parts, total, out):
    """[(mp3, start)] -> one sound track as long as the video, at YouTube's loudness."""
    inputs, chain = [], []
    for i, (path, at) in enumerate(parts):
        inputs += ["-i", str(path)]
        chain.append(f"[{i}:a]adelay={round(at * 1000)}:all=1[a{i}]")
    chain.append("".join(f"[a{i}]" for i in range(len(parts)))
                 + f"amix=inputs={len(parts)}:normalize=0,apad,atrim=0:{total:.3f},loudnorm=I=-14:TP=-1.5:LRA=11[out]")
    subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(chain), "-map", "[out]",
                    "-ar", "48000", "-c:a", "aac", "-b:a", "192k", str(out)], check=True)


def add_music(video, music, out):
    """The video with music under the voice: looped, levelled well below it, quieter still while the voice talks,
    faded in and out. The picture is copied as it is."""
    total = length(video)
    chain = (f"[1:a]loudnorm=I=-27:TP=-3:LRA=11,afade=t=in:d=0.8,afade=t=out:st={total - 2:.3f}:d=2[m];"
             "[0:a]asplit=2[v][key];"
             "[m][key]sidechaincompress=threshold=0.02:ratio=5:attack=30:release=400[duck];"
             "[v][duck]amix=inputs=2:normalize=0,alimiter=limit=0.9[out]")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-stream_loop", "-1", "-i", str(music),
                    "-filter_complex", chain, "-map", "0:v", "-map", "[out]", "-t", f"{total:.3f}", "-c:v", "copy",
                    "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)], check=True)
    print(f"Wrote {out.relative_to(ROOT)}: with {music.name} under the voice.")


# ---------------------------------------------------------------- the dashboard

class Dashboard:
    """The extension's dashboard at phone width in dark mode, with the sample data in it, to take screenshots of."""

    def __init__(self, pw, tmp):
        self.tmp = tmp
        self.ctx = pw.chromium.launch_persistent_context(str(tmp / "profile"), channel="chromium", headless=True, color_scheme="dark",
                                                         viewport={"width": DASH_W, "height": DASH_H}, device_scale_factor=SHOT_SCALE,
                                                         args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        worker = self.ctx.service_workers[0] if self.ctx.service_workers else self.ctx.wait_for_event("serviceworker")
        self.url = f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html"
        self.page = self.ctx.new_page()
        self.page.goto(self.url)
        self.page.wait_for_selector("#site-name")
        self.page.evaluate(SEED, [COMPANIES, "hirist"])
        self.page.evaluate(APPS, COMPANIES)

    def boxes(self, selectors, top=0):
        """The box around these elements, measured from `top`."""
        found = [b for b in (self.page.locator(s).first.bounding_box() for s in selectors) if b]
        x0, y0 = min(b["x"] for b in found), min(b["y"] for b in found)
        return x0, y0 - top, max(b["x"] + b["width"] for b in found) - x0, max(b["y"] + b["height"] for b in found) - y0

    def shot(self, name, hash_=None, before=None, top=0, height=1700, full=True):
        """A screenshot from `top` down, `height` long: of the whole page, or of what's on screen if not `full`."""
        page = self.page
        if hash_:
            page.goto(f"{self.url}{hash_}")
            page.wait_for_selector("#site-name", state="attached")
        if full:
            page.evaluate("window.scrollTo(0, 0)")
        time.sleep(0.8)
        if before:
            before()
            if full:
                page.evaluate("window.scrollTo(0, 0)")
            time.sleep(0.5)
        page.screenshot(path=str(self.tmp / name), full_page=full, clip={"x": 0, "y": top, "width": DASH_W, "height": height})
        return name

    def close(self):
        self.ctx.close()


def shots(pw, tmp):
    """The screenshots for each scene, and where on them the parts the camera looks at are."""
    dash = Dashboard(pw, tmp)
    page, url, boxes, shot = dash.page, dash.url, dash.boxes, dash.shot

    run = []
    for k in range(len(WORKED) + 1):
        page.evaluate(STEP, [COMPANIES, FINAL, WORKED, k])
        run.append(shot(f"run-{k:02d}.png", "#overview/hirist" if k == 0 else None))
    out = {"run": (run, {"run": boxes([".run"])})}
    page.evaluate(ASK)
    out["ask"] = ([shot("ask.png")], {"prompt": boxes([".prompt"])})
    out["apps"] = ([shot("apps.png", "#applications")], {"funnel": boxes([".funnel"]), "upnext": boxes([".upnext"])})
    page.evaluate(REFER, COMPANIES)
    out["refer"] = ([shot("refer.png", "#overview/linkedin")], {"refer": boxes(["#refer-box", "#events > li:nth-child(3)"])})
    page.evaluate(PROFILE)
    page.goto(f"{url}#settings")
    page.reload()  # the resume is only read when the dashboard loads
    page.wait_for_function("document.getElementById('resume-status').textContent.includes('Priya')")
    # At phone width the row of site tabs doesn't wrap and makes Settings wider than the screen, and answers get cut off.
    page.add_style_tag(content=".settings { grid-template-columns: minmax(0, 1fr) !important; } .site-tabs { flex-wrap: wrap; }"
                               " .answers td:first-child { width: 42%; }")
    page.evaluate("window.scrollTo(0, 0)")
    time.sleep(0.5)
    top = page.locator("#set-profile").bounding_box()["y"] - 24
    out["profile"] = ([shot("profile.png", top=top, height=1500)],
                      {"profile": boxes(["#profile-title", "#set-profile .two > label:nth-child(4)"], top),
                       "resume": boxes(["#set-profile > div.field:not(#wd-sign-in)"], top)})
    top = page.locator("#set-answers").bounding_box()["y"] - 24
    out["answers"] = ([shot("answers.png", top=top, height=1100)],
                      {"answers": boxes(["#answers-title", "#answer-rows tr:nth-child(3)"], top),
                       "rows": boxes(["#answer-rows tr:nth-child(1)", "#answer-rows tr:nth-child(3)"], top)})
    dash.close()
    return out


def fit(box, most=1.3, margin=14):
    """The camera (scale, centre x, centre y) that fills the view's width with the box, from its top if it's tall."""
    x, y, w, h = box
    w = min(w, DASH_W - 2 * x)  # a wide table scrolls sideways: only what's on screen counts
    s = min(most, DASH_W / (w + 2 * margin))
    seen = VIEW_H / K / s
    return s, x + w / 2, (y - margin + seen / 2) if h + 2 * margin > seen else y + h / 2


TOP = (1.0, DASH_W / 2, VIEW_H / K / 2)
push = lambda cam, f=1.06: (cam[0] * f, cam[1], cam[2])


def camera(name, b, d):
    """Keyframes [(seconds, camera)] for a dashboard scene `d` seconds long."""
    if name == "profile":
        return [(0, fit(b["profile"])), (d * 0.45, push(fit(b["profile"]), 1.03)), (d - 0.7, fit(b["resume"])), (d, push(fit(b["resume"]), 1.04))]
    if name == "answers":
        return [(0, fit(b["answers"])), (d * 0.3, fit(b["answers"])), (d * 0.3 + 1.0, fit(b["rows"], 1.6)), (d, push(fit(b["rows"], 1.6), 1.04))]
    if name == "run":
        return [(0, TOP), (1.2, fit(b["run"])), (d, push(fit(b["run"])))]
    if name == "ask":
        return [(0, TOP), (1.0, fit(b["prompt"])), (d, push(fit(b["prompt"])))]
    if name == "apps":
        return [(0, TOP), (0.9, fit(b["funnel"])), (d * 0.55, push(fit(b["funnel"]), 1.03)), (d - 0.5, fit(b["upnext"])), (d, fit(b["upnext"]))]
    return [(0, TOP), (1.0, fit(b["refer"])), (d, push(fit(b["refer"])))]


def at(keys, t):
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t <= t1:
            e = ease(max(0.0, (t - t0) / (t1 - t0)))
            return tuple(x + (y - x) * e for x, y in zip(a, b))
    return keys[-1][1]


# ---------------------------------------------------------------- putting it together

CARDS = ("hook", "sites", "stats", "end")


def render(scenes, capture, camera, where, voice, out):
    """Make the video. scenes: [(name, line)]; capture(pw, tmp): {scene: ([screenshots], {part: box})} for the dashboard
    scenes, and {scene: {...}} with what a card needs; camera(name, boxes, seconds): keyframes; where: {scene: label}."""
    names = [n for n, _ in scenes]
    with tempfile.TemporaryDirectory() as tmpdir, ExitStack() as stack:
        tmp = Path(tmpdir)
        print("Voice-over...")
        said = [asyncio.run(speak(line, VOICES[voice], tmp / f"{name}.mp3")) for name, line in scenes]
        spans = [LEAD + length(tmp / f"{name}.mp3") + TAIL for name in names]
        spans[-1] += 1.0
        starts = [sum(spans[:i]) for i in range(len(spans))]
        total = sum(spans)
        caps = [c for (_, line), words, s, d in zip(scenes, said, starts, spans) for c in chunks(line, words, s + LEAD, s + d)]
        mix([(tmp / f"{name}.mp3", s + LEAD) for name, s in zip(names, starts)], total, tmp / "voice.m4a")

        sites_at = []  # when each site is said, for its chip to pop up then
        for i, site in enumerate(SITES if "sites" in names else []):
            hit = next((t0 for text, t0, _ in said[names.index("sites")] if text.lower().startswith(site.lower())), None)
            sites_at.append(LEAD + (hit if hit is not None else 0.4 + 0.45 * i))

        print("Dashboard...")
        pw = stack.enter_context(sync_playwright())  # after the voice: Playwright keeps an event loop running
        shots = capture(pw, tmp)
        sharp_logo(tmp / "logo.png")

        def view(i, t):
            name, d = names[i], spans[i]
            if name == "hook":
                return {"kind": "hook", "n": max(0, min(10, math.floor((t - 0.3) / 0.3) + 1)), "t": t}
            if name == "sites":
                return {"kind": "sites", "ages": [t - s for s in sites_at]}
            if name in CARDS:
                return {"kind": name, "t": t, **shots.get(name, {})}
            images, b = shots[name]
            k = 0 if len(images) == 1 else max(0, min(len(images) - 1, int((t - 1.0) / ((d - 1.6) / (len(images) - 1))) + 1))
            s, cx, cy = at(camera(name, b, d), t)
            return {"kind": "dash", "src": images[k], "s": s, "cx": cx, "cy": cy, "tag": where[name]}

        html = FRAME
        for key, value in {"__FONT__": (EXT / "fonts" / "archivo-latin.woff2").as_uri(), "__W__": W, "__H__": H, "__VL__": VIEW_L,
                           "__VT__": VIEW_T, "__VW__": VIEW_W, "__VH__": VIEW_H, "__K__": K, "__CELLS__": "<i></i>" * 10,
                           "__CHIPS__": "".join(f"<span>{s}</span>" for s in SITES[:-1])}.items():
            html = html.replace(key, str(value))
        (tmp / "frame.html").write_text(html)
        page = pw.chromium.launch(headless=True).new_page(viewport={"width": W, "height": H})
        page.goto((tmp / "frame.html").as_uri())
        page.evaluate("document.fonts.ready.then(() => 0)")

        print("Frames...")
        out.parent.mkdir(exist_ok=True)
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "png", "-i", "-",
                                "-i", str(tmp / "voice.m4a"), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "16",
                                "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest",
                                "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
        frames = round(total * FPS)
        for f in range(frames):
            t = f / FPS
            i = max(n for n, s in enumerate(starts) if s <= t)
            slots = [None, None]
            slots[i % 2] = {**view(i, t - starts[i]), "a": 1, "z": 2}
            if i and t - starts[i] < FADE:
                slots[i % 2]["a"] = ease((t - starts[i]) / FADE)
                slots[(i - 1) % 2] = {**view(i - 1, spans[i - 1]), "a": 1, "z": 1}
            cap = next(((s, ws) for s, e, ws in caps if s <= t < e), None)
            state = {"slots": slots, "cap": cap and {"words": [w for w, _ in cap[1]], "on": max(n for n, (_, w0) in enumerate(cap[1]) if w0 <= t),
                                                     "pop": min(1, (t - cap[0]) / 0.12)}}
            page.evaluate("s => render(s)", state)
            enc.stdin.write(page.screenshot(type="png"))
            if f % (FPS * 5) == 0:
                print(f"  {t:4.1f} / {total:.1f} s")
        enc.stdin.close()
        enc.wait()
    print(f"Wrote {out.relative_to(ROOT)}: {total:.1f} s, {W}x{H}, {out.stat().st_size / 1e6:.1f} MB.")


def main(doc=__doc__, name="short", scenes=SCENES, capture=shots, camera=camera, where=WHERE):
    """The command line for one Short: video/sendoff-<name>-<voice>.mp4."""
    parser = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voice", choices=list(VOICES), default="neerja")
    parser.add_argument("--music", type=Path, help="a music file to put under the voice; also writes ...-music.mp4")
    parser.add_argument("--music-only", action="store_true", help="only put --music under the video made last time")
    args = parser.parse_args()
    out = ROOT / "video" / f"sendoff-{name}-{args.voice}.mp4"
    if not args.music_only:
        render(scenes, capture, camera, where, args.voice, out)
    if args.music:
        add_music(out, args.music.expanduser(), out.with_stem(f"{out.stem}-music"))


if __name__ == "__main__":
    main()
