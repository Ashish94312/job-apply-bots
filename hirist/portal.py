"""Hirist: where its jobs are, how to read them, logging in, and its page quirks.

Search pages take filters in the URL: /search/<keyword>?minexp=1&maxexp=2, and later pages are &page=N.
Each job card shows "X - Y yrs", so jobs outside the experience range are skipped without opening them.
"""
import re

from playwright.sync_api import TimeoutError as PWTimeout

from core import Job, clear_challenge, collect_links, first_visible, text_of


class Hirist:
    name = "hirist"
    domain = "hirist.tech"
    login_url = "https://www.hirist.tech/"  # click "Login" there
    # Login is by OTP, password, Google or Apple. Google refuses sign-in inside an automated browser,
    # so login happens in a normal Chrome window where any of them works.
    login_outside_automation = True
    job_link_css = "a[href*='/j/']"
    job_ready_css = "h1"
    job_url_re = re.compile(r"hirist\.tech/j/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)")
    apply_re = re.compile(r"^\s*apply( now)?\s*$", re.I)
    LOGIN_BUTTON_RE = re.compile(r"^\s*login\s*$", re.I)
    PAGE_TITLE_RE = re.compile(r" - ([^-|]+?) \| hirist", re.I)

    def job_id(self, url):
        return self.job_url_re.search(url).group(1)

    def search_urls(self, page, cfg):
        """One search per keyword with the experience range, plus any extra URLs."""
        search = cfg.get("search") or {}
        lo, hi = search.get("min_experience"), search.get("max_experience")
        exp = f"?minexp={lo}&maxexp={hi}" if lo is not None and hi is not None else ""
        slug = lambda k: re.sub(r"[^a-z0-9]+", "-", k.lower()).strip("-")
        urls = [f"https://www.hirist.tech/search/{slug(k)}{exp}" for k in search.get("keywords") or []]
        return urls + list(cfg.get("search_urls") or [])

    @staticmethod
    def search_page_url(url, n):
        return url if n == 1 else f"{url}{'&' if '?' in url else '?'}page={n}"

    def collect_links(self, page, max_scrolls=0):
        """Job URL -> card text ("Company - Title X - Y yrs Location ...")."""
        return collect_links(page, self.job_link_css, self.job_url_re, max_scrolls)

    # ------------------------------------------------------------ login

    def is_logged_in(self, page):
        page.goto(self.login_url, wait_until="domcontentloaded")
        if not clear_challenge(page):
            return False
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except PWTimeout:
            pass
        return first_visible(page, self.LOGIN_BUTTON_RE) is None

    def auto_login(self, page, cfg):
        return False  # logged in by hand once, in a normal Chrome window

    # ------------------------------------------------------------ jobs

    def read_job(self, page, url):
        # The heading is usually "Company - Title"; the tab title always ends "... - Company | hirist".
        heading = text_of(page.locator("h1").first)
        m = self.PAGE_TITLE_RE.search(page.title())
        company = m.group(1).strip() if m else ""
        prefix, _, rest = heading.partition(" - ")  # the prefix may be spelled differently ("OZI" / "OZI Technologies")
        same = company and (prefix.lower() in company.lower() or company.lower() in prefix.lower())
        title = rest if rest and same else heading
        return Job(url, self.job_id(url), title.strip(), company, text_of(page.locator("body")))

    def question_page(self, page):
        """After "Apply", Hirist may ask recruiter questions on a separate /screening page."""
        return page.locator("body") if "/screening" in page.url else None

    def dismiss_extras(self, page):
        pass


PORTAL = Hirist()
