"""Instahyre: where its jobs are, how to read them, logging in, and its page quirks."""
import os
import re
from urllib.parse import quote

from playwright.sync_api import TimeoutError as PWTimeout

from core import Job, clear_challenge, click, collect_links, first_visible, text_of, unique_urls



class Instahyre:
    name = "instahyre"
    domain = "instahyre.com"
    login_url = "https://www.instahyre.com/login/"
    login_outside_automation = False  # email/password login works inside the bot's browser
    job_link_css = "a[href*='/job-']"
    job_ready_css = "h1"
    job_url_re = re.compile(r"instahyre\.com/job-(\d+)-")
    apply_re = re.compile(r"^\s*apply( now)?\s*$", re.I)
    TITLE_RE = re.compile(r"^(.*?) job at (.*?) - Instahyre", re.I)
    SIMILAR_RE = re.compile(r"^\s*apply to \d+ jobs?\s*$", re.I)
    CLOSE_RE = re.compile(r"^\s*(cancel|close|skip|no,? thanks|not now|×)\s*$", re.I)
    LOGIN_ERROR_RE = re.compile(r"incorrect|invalid|not registered|doesn't exist", re.I)

    def job_id(self, url):
        return self.job_url_re.search(url).group(1)

    def search_urls(self, page, cfg):
        """One search per keyword and experience year (years=N means "minimum N years"), plus any extra URLs."""
        search = cfg.get("search") or {}
        lo = search.get("min_experience", 0)
        hi = search.get("max_experience", lo)
        urls = [f"https://www.instahyre.com/search-jobs?skills={quote(k)}&years={y}"
                for k in search.get("keywords") or [] for y in range(lo, hi + 1)]
        return unique_urls(urls + list(cfg.get("search_urls") or []))

    def collect_links(self, page, max_scrolls):
        return collect_links(page, self.job_link_css, self.job_url_re, max_scrolls)

    # ------------------------------------------------------------ login

    def is_logged_in(self, page):
        page.goto("https://www.instahyre.com/candidate/opportunities/?matching=true", wait_until="domcontentloaded")
        return clear_challenge(page) and "/login" not in page.url

    def open_login(self, page):
        page.goto(self.login_url, wait_until="domcontentloaded")

    def auto_login(self, page, cfg):
        """Log in with INSTAHYRE_EMAIL / INSTAHYRE_PASSWORD from .env."""
        email, password = os.environ.get("INSTAHYRE_EMAIL"), os.environ.get("INSTAHYRE_PASSWORD")
        if not (email and password):
            return False
        page.goto(self.login_url, wait_until="domcontentloaded")
        if not clear_challenge(page):
            return False
        page.fill("#email", email)
        page.fill("#password", password)
        page.press("#password", "Enter")
        try:
            page.wait_for_url(lambda url: "/login" not in url, timeout=20000)
        except PWTimeout:
            errors = page.get_by_text(self.LOGIN_ERROR_RE)
            shown = [errors.nth(i).inner_text().strip() for i in range(errors.count()) if errors.nth(i).is_visible()]
            print(f"Auto-login failed: {shown[0] if shown else 'still on the login page'}")
            return False
        return True

    # ------------------------------------------------------------ jobs

    def read_job(self, page, url):
        m = self.TITLE_RE.search(page.title())
        title, company = (m.group(1), m.group(2)) if m else (text_of(page.locator("h1").first), "")
        return Job(url, self.job_id(url), title.strip(), company.strip(), text_of(page.locator("body")))

    def question_page(self, page):
        return None  # Instahyre asks its questions in dialogs, if at all

    def dismiss_extras(self, page):
        # After applying, Instahyre may offer to "Apply to N jobs" similar to this one. Decline it.
        similar = first_visible(page, self.SIMILAR_RE)
        if similar is None:
            return
        modal = similar.locator("xpath=ancestor::*[contains(concat(' ', @class, ' '), ' modal ')][1]")
        close = first_visible(modal, self.CLOSE_RE) if modal.count() else None
        if close:
            click(close)
        else:
            page.keyboard.press("Escape")
        page.wait_for_timeout(1000)


PORTAL = Instahyre()
