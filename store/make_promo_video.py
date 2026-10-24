#!/usr/bin/env python3
"""Make the Chrome Web Store promo video: about 33 seconds in 4K (3840x2160), from the real dashboard with the same
made-up sample data as the screenshots. Each scene starts on the whole dashboard and eases in on the part that
matters. Upload it to YouTube (4K keeps it sharp there, even when watched at 1080p) and paste its link into the
listing's "Global promo video" field.

  .venv/bin/python store/make_promo_video.py      # writes video/sendoff-promo-4k.mp4

Needs Playwright's Chromium and ffmpeg. It has no sound: add music in YouTube Studio (Audio Library) if you like.
"""
import subprocess
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageFilter
from playwright.sync_api import sync_playwright

from make_assets import COMPANIES, EXT, PROMO, REFER, RUN, SEED

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "video" / "sendoff-promo-4k.mp4"
W, H, FPS, FADE = 1920, 1080, 30, 0.5  # laid out at 1920x1080, drawn at twice that
SHOT_SCALE = 3                           # dashboard pixels per CSS pixel: still sharp when zoomed in
BOX_W, BOX_H, BOX_TOP = 1408, 880, 170   # where the 1280x800 dashboard sits in the frame
DASH_W, DASH_H = 1280, 800

# What each job on the first page of results ends up as; "seen" and "filtered" are known before it starts on them.
FINAL = ["seen", "applied", "filtered", "applied", "needs_manual", "skipped", "applied", "external", "applied", "filtered",
         "applied", "applied", "pending", "seen", "pending", "pending", "pending", "filtered", "pending", "pending"]
WORKED = [i for i, s in enumerate(FINAL[:12]) if s not in ("seen", "filtered")]

STEP = """async ([companies, final, worked, k]) => {
  const now = Date.now();
  const job = i => companies[i % companies.length];
  const NOTES = { needs_manual: "unanswered: What is your current CTC?", skipped: "title has 'senior'",
                  external: "apply opens an external site: https://careers.example.com/jobs/88" };
  const done = worked.slice(0, k);
  const cells = final.map((s, i) => ({ url: `https://example.com/jobs/${700000 + i}`, label: `${job(i)[0]} at ${job(i)[1]}`,
    state: !worked.includes(i) || done.includes(i) ? s : i === worked[k] ? "working" : "pending" }));
  const events = [{ ts: now - (done.length + 1) * 40000, kind: "search", label: "machine learning engineer", n: 1, listed: 20, fresh: 13 },
    ...done.map((i, j) => ({ ts: now - (done.length - j) * 40000, kind: "job", status: final[i], title: job(i)[0], company: job(i)[1],
                             url: `https://example.com/jobs/${700000 + i}`, note: NOTES[final[i]] || "" }))];
  const last = done[done.length - 1];
  if (last !== undefined && final[last] === "applied") {
    await JB.store.record("hirist", { jobId: String(700000 + last), url: `https://example.com/jobs/${700000 + last}`, title: job(last)[0], company: job(last)[1] }, "applied", "");
  }
  const current = worked[k];
  await chrome.storage.session.set({ "run:hirist": { id: "promo", site: "hirist", action: "apply", running: true, started: now - 600000,
    ended: null, stopped: false, error: "", log: [], events, prompt: null,
    now: current === undefined ? "" : `Filling in the application for ${job(current)[0]} at ${job(current)[1]}`,
    page: { label: "machine learning engineer", n: 1, listed: 20, fresh: 13, cells } } });
}"""

# One frame: a caption, and the dashboard in a rounded window that show() pans and zooms.
FRAME = """<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Archivo; src: url("__FONT__") format("woff2-variations"); font-weight: 100 900; font-stretch: 62% 125%; }
* { box-sizing: border-box; margin: 0; }
body { width: __W__px; height: __H__px; background: #F3F4F1; font-family: Archivo, system-ui, sans-serif; color: #16181B; overflow: hidden; }
h2 { position: absolute; top: 0; left: 0; right: 0; height: __TOP__px; display: grid; place-items: center; padding: 0 120px;
  font-size: 46px; font-weight: 600; letter-spacing: -0.01em; text-align: center; }
.view { position: absolute; left: __LEFT__px; top: __TOP__px; width: __BW__px; height: __BH__px; overflow: hidden; border-radius: 14px;
  background: #fff; box-shadow: 0 0 0 1px #DCDFD8, 0 24px 60px rgba(22, 24, 27, .12); }
img { position: absolute; left: 0; top: 0; width: __BW__px; height: __BH__px; transform-origin: 0 0; }
</style></head><body><h2></h2><div class="view"><img id="shot" alt=""></div>
<script>
const BW = __BW__, BH = __BH__, K = __BW__ / __DW__;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
async function show(src, s, cx, cy) {
  const img = document.getElementById("shot");
  if (img.getAttribute("src") !== src) { img.src = src; await img.decode(); }
  const tx = clamp(BW / 2 - cx * K * s, BW - BW * s, 0), ty = clamp(BH / 2 - cy * K * s, BH - BH * s, 0);
  img.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + s + ")";
}
</script></body></html>"""

CARD = dict(w=W, h=H, pad=200, gap=80, icon=240, title=160, tag=42, space=18, space2=50, cell=62, cgap=14, rad=13, glyph=32)


def ease(t):
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def sharp_logo(out, k=8):
    """The 128px icon redrawn at 8x with crisp edges: each colour's coverage is scaled up, smoothed and cut again."""
    bg, blue, navy, split = (247, 248, 250), (10, 74, 173), (21, 13, 94), 66  # navy from column 66 on
    lum = lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    src = Image.open(EXT / "icons" / "128.png").convert("RGBA")
    size = src.width * k

    def crisp(mask):
        big = mask.resize((size, size), Image.BICUBIC).filter(ImageFilter.GaussianBlur(k * 0.7))
        ramp = [min(1, max(0, (v - 112) / 32)) for v in range(256)]
        return big.point([round(255 * t * t * (3 - 2 * t)) for t in ramp])

    flat = Image.alpha_composite(Image.new("RGBA", src.size, bg + (255,)), src).convert("L")
    coverage = lambda ink: [max(0, min(255, round(255 * (lum(bg) - v) / (lum(bg) - lum(ink))))) for v in range(256)]
    ink = flat.point(coverage(blue))
    ink.paste(flat.point(coverage(navy)).crop((split, 0, src.width, src.height)), (split, 0))
    colours = Image.new("RGBA", (size, size), blue + (255,))
    colours.paste(navy + (255,), (split * k, 0, size, size))
    colours.putalpha(crisp(ink))
    disc = Image.new("RGBA", (size, size), bg + (255,))
    disc.putalpha(crisp(src.getchannel("A")))
    Image.alpha_composite(disc, colours).save(out)
    return out


class Composer:
    """Lays out frames at 1920x1080 and saves them at 3840x2160."""

    def __init__(self, browser, tmp):
        self.page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=2)
        self.tmp, self.n = tmp, 0
        html = FRAME
        for key, value in {"__FONT__": (EXT / "fonts" / "archivo-latin.woff2").as_uri(), "__W__": W, "__H__": H, "__TOP__": BOX_TOP,
                           "__LEFT__": (W - BOX_W) // 2, "__BW__": BOX_W, "__BH__": BOX_H, "__DW__": DASH_W}.items():
            html = html.replace(key, str(value))
        (tmp / "frame.html").write_text(html)

    def _save(self):
        self.n += 1
        out = self.tmp / f"frame-{self.n:04d}.png"
        self.page.screenshot(path=str(out))
        return out

    def card(self, tagline, logo):
        path = self.tmp / f"card-{self.n}.html"
        path.write_text(PROMO.format(font=(EXT / "fonts" / "archivo-latin.woff2").as_uri(), logo=logo.as_uri(), tagline=tagline, **CARD))
        self.page.goto(path.as_uri())
        self.page.evaluate("document.fonts.ready")
        self.page.wait_for_timeout(150)
        return self._save()

    def scene(self, caption):
        self.page.goto((self.tmp / "frame.html").as_uri())
        self.page.evaluate("c => { document.querySelector('h2').textContent = c; return document.fonts.ready.then(() => 0); }", caption)

    def frame(self, shot, s=1.0, at=(DASH_W / 2, DASH_H / 2)):
        self.page.evaluate("([src, s, x, y]) => show(src, s, x, y)", [shot.name, s, *at])
        return self._save()

    def zoom(self, shot, scale, at, seconds):
        """Ease from the whole dashboard to `scale` around `at`: one frame per video frame."""
        frames, n = [], round(seconds * FPS)
        for i in range(1, n + 1):
            e = ease(i / n)
            point = (DASH_W / 2 + (at[0] - DASH_W / 2) * e, DASH_H / 2 + (at[1] - DASH_H / 2) * e)
            frames.append((self.frame(shot, 1 + (scale - 1) * e, point), 1 / FPS))
        return frames

    def still(self, shot, caption, scale, at):
        """Whole dashboard, ease in, then hold."""
        self.scene(caption)
        frames = [(self.frame(shot), 0.7)] + self.zoom(shot, scale, at, 1.3)
        frames[-1] = (frames[-1][0], 2.6)
        return frames


def clip(images, out):
    """[(png, seconds), ...] -> an H.264 clip."""
    listing = out.with_suffix(".txt")
    listing.write_text("".join(f"file '{p}'\nduration {d:.6f}\n" for p, d in images) + f"file '{images[-1][0]}'\n")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                    "-vf", f"fps={FPS},scale={W * 2}:{H * 2}:flags=lanczos,format=yuv420p",
                    "-c:v", "libx264", "-crf", "12", "-preset", "slow", str(out)], check=True)
    return out, sum(d for _, d in images)


def join(clips, out):
    """Crossfade the clips into one video, with a silent sound track (some players want one)."""
    inputs, chain, offset, prev = [], [], 0.0, "0:v"
    for path, _ in clips:
        inputs += ["-i", str(path)]
    for i, (_, length) in enumerate(clips[:-1]):
        offset += length - FADE
        chain.append(f"[{prev}][{i + 1}:v]xfade=transition=fade:duration={FADE}:offset={offset:.3f}[v{i + 1}]")
        prev = f"v{i + 1}"
    total = sum(length for _, length in clips) - FADE * (len(clips) - 1)
    out.parent.mkdir(exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                    "-filter_complex", ";".join(chain), "-map", f"[{prev}]", "-map", f"{len(clips)}:a", "-t", f"{total:.3f}",
                    "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out)], check=True)
    return total


def main():
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile, tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        ctx = pw.chromium.launch_persistent_context(profile, channel="chromium", headless=True, viewport={"width": DASH_W, "height": DASH_H},
                                                    device_scale_factor=SHOT_SCALE, args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        url = f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html"
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_selector("#site-name")
        page.evaluate(SEED, [COMPANIES, "hirist"])
        comp = Composer(pw.chromium.launch(headless=True), tmp)
        logo = sharp_logo(tmp / "logo.png")

        def focus(selectors, most=1.4, margin=24):
            """Where to zoom to, and how far, to fill the view's width with what these elements cover, from its top."""
            boxes = [b for b in (page.locator(s).first.bounding_box() for s in selectors) if b]
            x0, y0 = max(0, min(b["x"] for b in boxes)), max(0, min(b["y"] for b in boxes))
            x1, y1 = min(DASH_W, max(b["x"] + b["width"] for b in boxes)), min(DASH_H, max(b["y"] + b["height"] for b in boxes))
            scale = min(most, DASH_W / (x1 - x0 + 2 * margin))
            return ((x0 + x1) / 2, y0 - margin + DASH_H / scale / 2), scale

        def shot(name, hash_, selectors, before=None):
            page.goto(f"{url}{hash_}")
            page.wait_for_selector("#site-name", state="attached")
            page.evaluate("window.scrollTo(0, 0)")
            time.sleep(0.8)
            if before:
                before()
                time.sleep(0.5)
            path = tmp / name
            page.screenshot(path=str(path))
            return path, focus(selectors)

        clips = [clip([(comp.card("Applies to jobs for you, in your own Chrome.", logo), 3.5)], tmp / "0.mp4")]

        # A run going through a page of results, one job at a time.
        steps = []
        for k in range(len(WORKED) + 1):
            page.evaluate(STEP, [COMPANIES, FINAL, WORKED, k])
            if k == 0:
                page.goto(f"{url}#overview/hirist")
                page.wait_for_selector("#site-name", state="attached")
            time.sleep(0.6)
            steps.append(tmp / f"run-{k:02d}.png")
            page.screenshot(path=str(steps[-1]))
        at, scale = focus(["#site-name", ".run", "#events > li:first-child", "#today-n"])
        comp.scene("Click Apply. It goes through the results and applies to the jobs that fit.")
        frames = [(comp.frame(steps[0]), 1.0)] + comp.zoom(steps[0], scale, at, 1.2)
        frames += [(comp.frame(s, scale, at), 0.6) for s in steps[1:]]
        frames[-1] = (frames[-1][0], 2.2)
        clips.append(clip(frames, tmp / "1.mp4"))

        page.evaluate(RUN, [COMPANIES, "instahyre", True])
        scenes = [
            (shot("asks.png", "#overview/instahyre", ["#site-name", ".prompt", "#strip"]),
             "When it needs you, it asks and waits. It never guesses an answer."),
            (shot("history.png", "#history", ["#history-title", "#chips", "#history-rows tr:nth-child(5)"], lambda: page.click('.chip[data-status=""]')),
             "A history of every job, so it never applies twice."),
            (shot("settings.png", "#settings", [".settings .toc", "#set-answers"], lambda: page.locator("#set-answers").scroll_into_view_if_needed()),
             "Your answers to the usual screening questions, in one place."),
        ]
        page.evaluate(REFER, COMPANIES)
        to_referrals = lambda: page.evaluate("scrollBy(0, document.getElementById('refer-box').getBoundingClientRect().top - 24)")
        scenes.append((shot("refer.png", "#overview/linkedin", ["#refer-box", "#events", "#today-n"], to_referrals),
                       "On LinkedIn, it asks your connections for referrals. You see each message first."))
        for i, ((path, (at, scale)), caption) in enumerate(scenes):
            clips.append(clip(comp.still(path, caption, scale, at), tmp / f"{i + 2}.mp4"))

        end = comp.card("Hirist, Instahyre, Wellfound, Cutshort and LinkedIn.<br>Your data stays in your Chrome.", logo)
        clips.append(clip([(end, 4.0)], tmp / "9.mp4"))
        ctx.close()
        total = join(clips, OUT)
    print(f"Wrote {OUT.relative_to(ROOT)}: {total:.1f} s, {W * 2}x{H * 2}, {OUT.stat().st_size / 1e6:.1f} MB.")


if __name__ == "__main__":
    main()
