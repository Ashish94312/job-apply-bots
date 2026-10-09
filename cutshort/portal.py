"""Cutshort: logging in, reading the logged-in job feed, and applying from its cards.

When logged in, Cutshort applies from its job feed (/profile/all-jobs), not from public job pages:
each card has "Apply now", which opens a dialog with your resume, a message box and "Send".
The feed takes its filters from the URL: minexp / maxexp (years) and skills (ids joined with "-").
"""
import re

from playwright.sync_api import TimeoutError as PWTimeout

from core import (
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
