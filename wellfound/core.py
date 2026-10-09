"""Generic bot machinery: browser, history, filters, form filling, and the apply flow.

The site-specific parts live in portal.py.
"""
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from playwright.sync_api import TimeoutError as PWTimeout

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / ".env")  # secrets shared by all bots, e.g. INSTAHYRE_PASSWORD
DATA = ROOT / "data"
PROFILE = DATA / "profile"
SCREENSHOTS = DATA / "screenshots"


class Status:
    APPLIED = "applied"
    ALREADY = "already_applied"
    SKIPPED = "skipped"
    MANUAL = "needs_manual"
    EXTERNAL = "external"
    FAILED = "failed"


@dataclass
class Job:
    url: str
    job_id: str
    title: str = ""
    company: str = ""
    text: str = ""

    @property
    def label(self):
        return f"{self.title or '?'} @ {self.company or '?'}"


# ---------------------------------------------------------------- browser

def launch(pw, cfg, headless=False):
    """Persistent browser profile, so a login is remembered between runs."""
    opts = {"user_data_dir": str(PROFILE), "headless": headless}
    if headless:
        opts["viewport"] = {"width": 1366, "height": 900}
    else:
        opts["no_viewport"] = True
    if cfg.get("browser_channel"):
        opts["channel"] = cfg["browser_channel"]
    ctx = pw.chromium.launch_persistent_context(**opts)
    ctx.set_default_timeout(20000)
    return ctx


CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def login_in_plain_chrome(url):
    """Google refuses sign-in in a browser driven by automation, so open the bot's profile in an ordinary
    Chrome window instead. Same keychain flags as Playwright uses, so the bot can read the saved session."""
    proc = subprocess.Popen(
        [CHROME, f"--user-data-dir={PROFILE}", "--use-mock-keychain", "--password-store=basic",
         "--no-first-run", "--no-default-browser-check", url],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    input("\nA normal Chrome window opened. Log in there (Google or phone OTP), then press Enter here... ")
    if proc.poll() is None:
        proc.terminate()  # Chrome shuts down cleanly on SIGTERM and saves the session
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()


def on_challenge(page):
    return "just a moment" in page.title().lower()


def clear_challenge(page, seconds=30):
    """Cloudflare's "Just a moment..." page usually clears itself in a real browser; otherwise ask the user."""
    for _ in range(seconds):
        if not on_challenge(page):
            return True
        page.wait_for_timeout(1000)
    if sys.stdin.isatty():
        input("  Cloudflare check is showing. Solve it in the browser, then press Enter... ")
    return not on_challenge(page)


def ensure_loaded(page, css, timeout=20000):
    """Wait for `css`; if it never shows (captcha, Cloudflare check), let the user fix it by hand."""
    clear_challenge(page)
    try:
        page.wait_for_selector(css, timeout=timeout)
        return True
    except PWTimeout:
        pass
    if not sys.stdin.isatty():
        return False
    input(f"  Page not ready ({page.url}).\n  Solve any captcha/check in the browser, then press Enter... ")
    try:
        page.wait_for_selector(css, timeout=10000)
        return True
    except PWTimeout:
        return False


def first_visible(scope, pattern, roles=("button", "link")):
    for role in roles:
        loc = scope.get_by_role(role, name=pattern)
        for i in range(loc.count()):
            if loc.nth(i).is_visible():
                return loc.nth(i)
    return None


def click(locator, timeout=5000):
    """Click; if another element sits on top (e.g. a button wrapped in a link), fire the click directly."""
    try:
        locator.click(timeout=timeout)
    except PWTimeout:
        locator.evaluate("e => e.click()")


DIALOG_CSS = ", ".join(
    f"{sel}:visible" for sel in ("[role=dialog]", "[aria-modal=true]", ".modal", ".ReactModal__Content")
)


def visible_dialog(page):
    loc = page.locator(DIALOG_CSS)
    return loc.last if loc.count() else None


def text_of(locator):
    try:
        return locator.inner_text(timeout=3000).strip()
    except PWTimeout:
        return ""


def screenshot(page, job_id):
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    path = SCREENSHOTS / f"{job_id}.png"
    try:
        page.screenshot(path=str(path))
    except Exception:
        return None
    return path


def collect_links(page, link_css, url_re, max_scrolls):
    """Job URL -> card text from a search page, scrolling to load more results."""
    found = {}
    for _ in range(max_scrolls + 1):
        before = len(found)
        for href, text in page.eval_on_selector_all(
            link_css, "els => els.map(a => [a.href, (a.innerText || '').replace(/\\s+/g, ' ').trim()])"
        ):
            if not url_re.search(href):
                continue
            p = urlsplit(href)
            url = f"{p.scheme}://{p.netloc}{p.path}"
            if len(text) > len(found.get(url, "")):
                found[url] = text
        if len(found) == before:
            break
        page.mouse.wheel(0, 6000)
        page.wait_for_timeout(2000)
    return found


def unique_urls(urls):
    """Keyword searches first, backup URLs after; drop repeats (ignoring case)."""
    seen, out = set(), []
    for url in urls:
        if url.lower() not in seen:
            seen.add(url.lower())
            out.append(url)
    return out


# ---------------------------------------------------------------- filters

EXPERIENCE_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*(?:years?|yrs?)", re.I)


def has_word(text, word):
    return re.search(rf"(?<!\w){re.escape(word)}(?!\w)", text or "", re.I) is not None


def min_years(text):
    """Minimum experience asked for: the first "X - Y years" in the text (job pages show it in the header)."""
    m = EXPERIENCE_RE.search(text or "")
    return float(m.group(1)) if m else None


def too_senior(text, filters):
    max_years = filters.get("max_experience_required")
    needed = min_years(text)
    if max_years is not None and needed is not None and needed > max_years:
        return needed
    return None


def preview_ok(preview, filters):
    """Cheap check on the search-results text, before opening the job page."""
    if not preview:
        return True
    if too_senior(preview, filters):
        return False
    include = filters.get("include_title") or []
    if include and not any(has_word(preview, k) for k in include):
        return False
    return not any(c.lower() in preview.lower() for c in filters.get("exclude_companies") or [])


def skip_reason(job, filters):
    if not job.title:
        return "couldn't read job title"
    needed = too_senior(job.text, filters)
    if needed:
        return f"needs {needed:g}+ yrs"
    include = filters.get("include_title") or []
    if include and not any(has_word(job.title, k) for k in include):
        return "title not in include_title"
    roles = filters.get("require_role") or []
    if roles and not any(has_word(job.title, r) for r in roles):
        return "not an engineering role"
    for k in filters.get("exclude_title") or []:
        if has_word(job.title, k):
            return f"title has '{k}'"
    for c in filters.get("exclude_companies") or []:
        if c.lower() in job.company.lower():
            return f"company '{c}' excluded"
    for k in filters.get("exclude_text") or []:
        if has_word(job.text, k):
            return f"description mentions '{k}'"
    return None


# ---------------------------------------------------------------- forms

FIELDS_JS = """root => {
  const t = s => (s || '').replace(/\\s+/g, ' ').trim();
  // A label like "Enter your answer" says nothing; the question is in the surrounding block then.
  const GENERIC = /^(enter|type|write|add)?\\s*(your|an?)?\\s*(answer|response|text|here)\\b|^[-–—\\s]*$|^select\\b/i;
  const labelOf = e => {
    const by = e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'));
    const own = (e.labels && e.labels.length && e.type !== 'radio' && t(e.labels[0].innerText))
      || t(e.getAttribute('aria-label')) || (by && t(by.innerText)) || t(e.placeholder);
    if (own && !GENERIC.test(own)) return own;
    for (let p = e.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      const s = t(p.innerText);
      if (s && s !== own && !GENERIC.test(s)) return s.slice(0, 200);
    }
    return own || t(e.name);
  };
  const radioQuestion = e => {  // climb past the block holding just the options to reach the question text
    const same = [...root.querySelectorAll('input[type=radio]')].filter(r => r.name === e.name);
    let p = e.parentElement;
    while (p && !same.every(r => p.contains(r))) p = p.parentElement;
    const options = t(p ? p.innerText : '');
    for (let i = 0; p && i < 4 && t(p.innerText).length <= options.length + 5; i++) p = p.parentElement;
    return p ? t(p.innerText).slice(0, 200) : '';
  };
  const optionOf = e => t((e.labels && e.labels[0] && e.labels[0].innerText) || (e.closest('label') || {}).innerText || e.value);
  return [...root.querySelectorAll('input, textarea, select')].map((e, i) => ({
    i, tag: e.tagName.toLowerCase(), type: (e.type || '').toLowerCase(), name: e.name || '',
    value: t(e.value), checked: !!e.checked, disabled: e.disabled,
    visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
    label: e.type === 'radio' ? radioQuestion(e) : labelOf(e),
    option: e.type === 'radio' ? optionOf(e) : '',
    combo: e.getAttribute('aria-autocomplete') === 'list' || e.getAttribute('role') === 'combobox',
    chosen: !!(e.closest('[class*=container]') || e.parentElement).querySelector('[class*=singleValue], [class*=single-value]'),
  }));
}"""

NOTE_RE = re.compile(r"note|cover|message|pitch|recruiter|why|introduc|about (you|yourself)|interests? you|good fit", re.I)
IGNORED_TYPES = {"hidden", "submit", "button", "file", "search", "checkbox", "image", "reset"}


def answer_for(label, answers):
    for pattern, answer in (answers or {}).items():
        if answer not in (None, "") and re.search(pattern, label, re.I):
            return str(answer)
    return None


def cover_note(cfg, job=None):
    """cover_note from config, with {title} and {company} filled in."""
    note = (cfg.get("cover_note") or "").strip()
    if job:
        note = note.replace("{title}", job.title or "this role").replace("{company}", job.company or "your company")
    return note


def choose_option(box, answer):
    """Searchable dropdown: type the answer, pick the option that matches it. Never picks a mere guess."""
    if not answer:
        return False
    page = box.page
    box.click(force=True)
    box.fill(answer)
    page.wait_for_timeout(900)
    options = page.locator("[id*='-option-']:visible, [role=option]:visible")
    plain = lambda t: re.sub(r"[^a-z0-9]+", "", t.lower())   # "Institute Of Technology, Jodhpur" == "institute of technology jodhpur"
    texts = [plain(options.nth(i).inner_text()) for i in range(options.count())]
    want = plain(answer)
    for rule in (lambda t: t == want, lambda t: t.startswith(want), lambda t: want in t):
        for i, text in enumerate(texts):
            if text and rule(text):
                options.nth(i).click()
                page.wait_for_timeout(300)
                return True
    box.fill("")       # no matching option: clear it and move on (Escape would close the whole dialog)
    box.press("Tab")
    return False


def fill_form(scope, cfg, job=None):
    """Fill what we have answers for. Returns the questions we couldn't answer (empty = ready to submit)."""
    note = cover_note(cfg, job)
    inputs = scope.locator("input, textarea, select")
    missing, radio_groups = [], {}
    for f in scope.evaluate(FIELDS_JS):
        if f["disabled"] or f["type"] in IGNORED_TYPES:
            continue
        if f["type"] == "radio":
            group = radio_groups.setdefault(f["name"] or f["label"], {"label": f["label"], "checked": False, "options": []})
            group["checked"] |= f["checked"]
            group["options"].append((f["i"], f["option"]))
            continue
        if f["combo"]:
            if not f["chosen"] and not choose_option(inputs.nth(f["i"]), answer_for(f["label"], cfg.get("answers"))):
                missing.append(f["label"][:60] or "dropdown")
            continue
        if not f["visible"] or f["value"]:
            continue
        if f["tag"] == "select":
            missing.append(f["label"][:60] or "dropdown")
            continue
        answer = answer_for(f["label"], cfg.get("answers"))
        is_message_box = f["tag"] == "textarea" and (not f["label"] or NOTE_RE.search(f["label"]))
        if answer is None and is_message_box:
            if not note:
                continue  # no cover_note configured: send without a message
            answer = note
        if answer is None:
            missing.append(f["label"][:60] or f["name"] or f["tag"])
            continue
        if f["type"] == "number":  # "15 LPA" -> "15"; "+91 8955247261" -> "918955247261"
            if re.search(r"[a-z]", answer, re.I):
                number = re.search(r"\d+(?:\.\d+)?", answer)
                answer = number.group(0) if number else answer
            else:
                answer = re.sub(r"[^\d.]", "", answer)
        inputs.nth(f["i"]).fill(answer)
    for group in radio_groups.values():
        if group["checked"]:
            continue
        answer = (answer_for(group["label"], cfg.get("answers")) or "").lower()
        pick = next((i for i, option in group["options"] if answer and option.lower() == answer), None)
        if pick is None:
            missing.append(group["label"][:60] or "choice")
            continue
        inputs.nth(pick).evaluate("e => e.click()")  # radios are often hidden behind custom styling
    return missing


# ---------------------------------------------------------------- applying

SUBMIT_RE = re.compile(r"^\s*(submit|apply|send|confirm|continue|next|done|yes)\b", re.I)
APPLIED_BUTTON_RE = re.compile(r"^\s*applied\s*$", re.I)
APPLIED_TEXT_RE = re.compile(
    r"you('ve| have) (already )?applied|already applied|application (has been )?(sent|submitted|received)"
    r"|applied successfully|successfully applied",
    re.I,
)


def is_applied(page, portal=None):
    if portal is not None and hasattr(portal, "is_applied"):  # a site with its own way of showing it
        return portal.is_applied(page)
    if first_visible(page, APPLIED_BUTTON_RE):
        return True
    loc = page.get_by_text(APPLIED_TEXT_RE)
    return any(loc.nth(i).is_visible() for i in range(min(loc.count(), 5)))


def apply_job(page, portal, cfg, job=None):
    """Click apply and walk through any dialog. Returns (status, note)."""
    if is_applied(page, portal):
        return Status.ALREADY, ""
    button = first_visible(page, portal.apply_re)
    if button is None:
        return Status.MANUAL, "no apply button found"

    pages_before = len(page.context.pages)
    click(button)
    page.wait_for_timeout(2500)
    blocked = getattr(portal, "cannot_apply", lambda page: None)(page)
    if blocked:
        page.keyboard.press("Escape")
        return Status.SKIPPED, blocked
    new_tabs = page.context.pages[pages_before:]
    if new_tabs:
        for tab in new_tabs:
            tab.close()
        return Status.EXTERNAL, "apply opens an external site"
    if portal.domain not in page.url:
        return Status.EXTERNAL, f"redirected to {page.url}"

    # Fill what we can, submit, repeat (multi-step forms).
    for _ in range(4):
        portal.dismiss_extras(page)
        if is_applied(page, portal):
            return Status.APPLIED, ""
        form = visible_dialog(page) or portal.question_page(page)
        if form is None:
            break
        missing = fill_form(form, cfg, job)
        if missing:
            return Status.MANUAL, "unanswered: " + "; ".join(missing)
        submit = first_visible(form, SUBMIT_RE)
        if submit is None:
            break
        click(submit)
        page.wait_for_timeout(2500)

    portal.dismiss_extras(page)
    if is_applied(page, portal):
        return Status.APPLIED, ""
    return Status.MANUAL, "couldn't confirm the application went through"


# ---------------------------------------------------------------- history

class Store:
    def __init__(self, site, path=DATA / "jobs.db"):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.site = site
        self.db = sqlite3.connect(path)
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                site TEXT, job_id TEXT, url TEXT, title TEXT, company TEXT,
                status TEXT, note TEXT, ts TEXT, PRIMARY KEY (site, job_id))"""
        )

    def seen(self, job_id):
        """Anything except a failure is final; failures get retried next run."""
        row = self.db.execute("SELECT status FROM jobs WHERE site=? AND job_id=?", (self.site, job_id)).fetchone()
        return row is not None and row[0] != Status.FAILED

    def record(self, job, status, note=""):
        self.db.execute(
            "INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))",
            (self.site, job.job_id, job.url, job.title, job.company, status, note),
        )
        self.db.commit()

    def applied_today(self):
        return self.db.execute(
            "SELECT COUNT(*) FROM jobs WHERE site=? AND status=? AND date(ts)=date('now', 'localtime')",
            (self.site, Status.APPLIED),
        ).fetchone()[0]

    def history(self, status=None, limit=30):
        sql, args = "SELECT ts, status, title, company, url, note FROM jobs WHERE site=?", [self.site]
        if status:
            sql += " AND status=?"
            args.append(status)
        return self.db.execute(sql + " ORDER BY ts DESC LIMIT ?", (*args, limit)).fetchall()

    def forget(self, status):
        n = self.db.execute("DELETE FROM jobs WHERE site=? AND status=?", (self.site, status)).rowcount
        self.db.commit()
        return n
