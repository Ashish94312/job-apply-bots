"""Cutshort: logging in, reading the logged-in job feed, and applying from its cards.

When logged in, Cutshort applies from its job feed (/profile/all-jobs), not from public job pages:
each card has "Apply now", which opens a dialog with your resume, a message box and "Send".
The feed takes its filters from the URL: minexp / maxexp (years) and skills (ids joined with "-").
"""
import json
import re
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import TimeoutError as PWTimeout

from core import (
    DATA,
    Job,
    Status,
    clear_challenge,
    click,
    fill_form,
    first_visible,
    visible_dialog,
)

# Every "Apply now" card on the feed -> [job url, title, company, card text].
FEED_CARDS_JS = """() => [...document.querySelectorAll('button')]
  .filter(b => /^apply now$/i.test(b.innerText.trim()))
  .map(b => {
    let c = b;
    for (let k = 0; k < 12 && c && !c.querySelector('a[href*="/job/"]'); k++) c = c.parentElement;
    if (!c) return null;
    let card = c;  // widen until the card includes its "X - Y yrs" line
    for (let k = 0; k < 5 && card && !/\\d\\s*-\\s*\\d+(\\.\\d+)?\\s*yrs/.test(card.innerText); k++) card = card.parentElement;
    const a = c.querySelector('a[href*="/job/"]'), co = c.querySelector('a[href*="/company/"]');
    return [a.href.split('?')[0], a.innerText.trim(), co ? co.innerText.trim() : '',
            (card || c).innerText.replace(/\\s+/g, ' ').slice(0, 1500)];
  })
  .filter(Boolean)"""

FEED = "https://cutshort.io/profile/all-jobs"
# Cutshort skill ids found so far; other keywords are looked up once in the feed's Skills filter and cached.
KNOWN_SKILLS = {
    "machine learning": "00268", "natural language processing": "00301", "nlp": "00301", "deep learning": "00543",
    "computer vision": "06726", "large language models": "06768", "llm": "06768", "generative ai": "06851",
    "genai": "06851", "python": "00360", "pytorch": "06694", "data science": "00121", "mlops": "06790",
}
SKILLS_CACHE = DATA / "skill_ids.json"

APPLY_NOW_RE = re.compile(r"^\s*apply now\s*$", re.I)
APPLIED_CARD_RE = re.compile(r"^\s*(view conversation|applied)\s*$", re.I)
SKIP_RE = re.compile(r"^\s*skip\s*$", re.I)
SEND_RE = re.compile(r"^\s*(send|submit|apply)\b", re.I)


class Cutshort:
    name = "cutshort"
    domain = "cutshort.io"
    login_url = "https://cutshort.io/jobs"  # click "Candidate login" there
    # Google refuses sign-in inside an automated browser, so login happens in a normal Chrome window.
    login_outside_automation = True
    job_url_re = re.compile(r"cutshort\.io/job/([^/?#]+)")
    LOGIN_BUTTON_RE = re.compile(r"candidate login", re.I)

    def job_id(self, url):
        return self.job_url_re.search(url).group(1)

    # ------------------------------------------------------------ login

    def is_logged_in(self, page):
        page.goto("https://cutshort.io/jobs", wait_until="domcontentloaded")
        if not clear_challenge(page):
            return False
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except PWTimeout:
            pass
        return first_visible(page, self.LOGIN_BUTTON_RE) is None

    def auto_login(self, page, cfg):
        return False  # Cutshort only offers Google / phone-OTP login, so the user logs in by hand once.

    # ------------------------------------------------------------ feed

    def search_urls(self, page, cfg):
        """One feed per keyword (as a Cutshort skill) with the experience range, plus any extra URLs."""
        search = cfg.get("search") or {}
        lo, hi = search.get("min_experience"), search.get("max_experience")
        exp = f"minexp={lo}&maxexp={hi}&" if lo is not None and hi is not None else ""
        cached = json.loads(SKILLS_CACHE.read_text()) if SKILLS_CACHE.exists() else {}
        skills = {**KNOWN_SKILLS, **cached}
        urls = []
        for keyword in search.get("keywords") or []:
            key = keyword.strip().lower()
            if key not in skills:
                skills[key] = self.lookup_skill(page, keyword)
                if skills[key]:  # remember finds only, so a failed lookup is retried next run
                    cached[key] = skills[key]
                    SKILLS_CACHE.parent.mkdir(parents=True, exist_ok=True)
                    SKILLS_CACHE.write_text(json.dumps(cached, indent=1))
            if skills[key]:
                urls.append(f"{FEED}?{exp}skills={skills[key]}")
            else:
                print(f"  Cutshort has no skill called '{keyword}', skipping it.")
        return urls + list(cfg.get("search_urls") or [])

    def lookup_skill(self, page, keyword):
        """Pick the keyword in the feed's Skills filter; Cutshort then shows its id in the URL (skills=<id>)."""
        page.goto(FEED, wait_until="domcontentloaded")
        clear_challenge(page)
        page.wait_for_timeout(4000)
        self.close_popups(page)
        page.get_by_text("Skills", exact=True).first.click()
        page.wait_for_timeout(800)
        box = page.locator("input[type=text]:visible, input:not([type]):visible").first
        box.fill(keyword)
        page.wait_for_timeout(2000)
        under = box.bounding_box()
        # "Machine Learning" should match the option "Machine Learning (ML)", but not "Machine Learning Ops".
        options = page.get_by_text(re.compile(rf"^\s*{re.escape(keyword.strip())}(\s*\(.*\))?\s*$", re.I))
        # The dropdown option sits right under the search box; job cards further down show skill tags with the same name.
        below = []
        for i in range(options.count()):
            where = options.nth(i).bounding_box() if options.nth(i).is_visible() else None
            if where and where["y"] > under["y"] and abs(where["x"] - under["x"]) < under["width"]:
                below.append((where["y"], i))
        if not below:
            return None
        click(options.nth(min(below)[1]))
        page.wait_for_timeout(2500)
        return parse_qs(urlsplit(page.url).query).get("skills", [""])[0].split("-")[-1] or None

    def close_popups(self, page):
        survey = page.get_by_role("button", name="Close survey")
        if survey.count() and survey.first.is_visible():
            click(survey.first)
        # "Submit feedback to companies" you applied to: skip it, one company per step.
        for _ in range(5):
            if not page.get_by_text("Submit feedback to companies").filter(visible=True).count():
                break
            skip = first_visible(page, SKIP_RE)
            if skip is None:
                page.keyboard.press("Escape")
                break
            click(skip)
            page.wait_for_timeout(800)

    def open_feed(self, page, url):
        """Returns False if the feed shows no jobs."""
        page.goto(url, wait_until="domcontentloaded")
        clear_challenge(page)
        try:
            page.get_by_role("button", name=APPLY_NOW_RE).first.wait_for(timeout=20000)
        except PWTimeout:
            return False
        self.close_popups(page)
        return True

    @staticmethod
    def feed_page_url(url, n):
        """The feed shows a few jobs per page; later pages are &page=N."""
        return url if n == 1 else f"{url}{'&' if '?' in url else '?'}page={n}"

    def feed_jobs(self, page):
        """Job id -> Job for every card on the current feed page."""
        jobs = {}
        for url, title, company, text in page.evaluate(FEED_CARDS_JS):
            if self.job_url_re.search(url):
                jobs.setdefault(self.job_id(url), Job(url, self.job_id(url), title, company, text))
        return jobs

    def card(self, page, job):
        """The job's card: the nearest block around its link holding "Apply now" (or, once applied, "View conversation")."""
        link = page.locator(f"a[href*='/job/{job.job_id}']").first
        return link.locator(
            "xpath=ancestor::*[.//*[normalize-space()='Apply now' or normalize-space()='View conversation']][1]"
        )

    def card_applied(self, page, job):
        """After applying, Cutshort swaps the card's "Apply now" for "View conversation"."""
        card = self.card(page, job)
        if not card.count():
            return False
        return (
            card.get_by_role("button", name=APPLY_NOW_RE).count() == 0
            and card.get_by_text(APPLIED_CARD_RE).count() > 0
        )

    def apply(self, page, job, cfg):
        """Apply from the job's feed card. Returns (status, note)."""
        self.close_popups(page)
        card = self.card(page, job)
        if not card.count():
            return Status.MANUAL, "card not found on the feed"
        button = card.get_by_role("button", name=APPLY_NOW_RE).first
        button.scroll_into_view_if_needed()
        click(button)
        page.wait_for_timeout(2500)

        dialog = visible_dialog(page)
        if dialog is None:
            return (Status.APPLIED, "") if self.card_applied(page, job) else (Status.MANUAL, "no apply dialog appeared")
        missing = fill_form(dialog, cfg, job)
        if missing:
            return Status.MANUAL, "unanswered: " + "; ".join(missing)
        send = first_visible(dialog, SEND_RE)
        if send is None:
            return Status.MANUAL, "no Send button in the apply dialog"
        click(send)
        page.wait_for_timeout(3500)
        if visible_dialog(page) is None and self.card_applied(page, job):
            return Status.APPLIED, ""
        return Status.MANUAL, "couldn't confirm the application went through"

    def dismiss(self, page):
        """Close a half-filled apply dialog so the next card can be used."""
        if visible_dialog(page) is not None:
            page.keyboard.press("Escape")
            page.wait_for_timeout(800)


PORTAL = Cutshort()
