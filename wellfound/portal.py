"""Wellfound (formerly AngelList Talent): where its jobs are, how to read them, logging in, and its page quirks.

Role pages list jobs per role and place: /role/l/<role>/<location> (e.g. india) or /role/r/<role> for remote,
25-30 jobs a page, later pages ?page=N. Each job row shows "N years of exp", so jobs asking for too much
experience are skipped without opening them. Roles Wellfound doesn't know redirect to all jobs in a place;
those searches are skipped.
"""
import os
import re

from playwright.sync_api import TimeoutError as PWTimeout

from core import APPLIED_TEXT_RE, Job, clear_challenge, first_visible, text_of, unique_urls

# Every job link on a role page -> [url, text of its job row].
JOB_ROWS_JS = """() => {
  const rows = {};
  for (const a of document.querySelectorAll('a[href^="/jobs/"]')) {
    if (!/^\\/jobs\\/\\d+-/.test(a.getAttribute('href'))) continue;
    let row = a;  // widen to the job's own row: stop before the block that holds other jobs too
    while (row.parentElement && new Set([...row.parentElement.querySelectorAll('a[href^="/jobs/"]')]
             .map(x => x.getAttribute('href').split('?')[0]).filter(h => /^\\/jobs\\/\\d+-/.test(h))).size === 1) row = row.parentElement;
    const url = a.href.split('?')[0];
    const text = row.innerText.replace(/\\s+/g, ' ').trim();
    if (text.length > (rows[url] || '').length) rows[url] = text;
  }
  return Object.entries(rows);
}"""
EXP_RE = re.compile(r"(\d+)\+?\s*years? of exp", re.I)


def with_range(text):
    """Wellfound says "3 years of exp"; write it as "3 - 3 years" up front so the experience filter reads it."""
    m = EXP_RE.search(text or "")
    return f"{m.group(1)} - {m.group(1)} years. {text}" if m else text


class Wellfound:
    name = "wellfound"
    domain = "wellfound.com"
    login_url = "https://wellfound.com/login"
    # Logs in with WELLFOUND_EMAIL / WELLFOUND_PASSWORD from .env. If that fails (or you use Google, which
    # refuses sign-in inside an automated browser), you log in by hand once in a normal Chrome window.
    login_outside_automation = True
    job_link_css = "a[href^='/jobs/']"
    job_ready_css = "h1"
    job_url_re = re.compile(r"wellfound\.com/jobs/(\d+)-")
    # Job pages also list similar jobs with plain "Apply" buttons; ours is "Apply Now".
    apply_re = re.compile(r"^\s*apply now\s*$", re.I)
    LOGIN_RE = re.compile(r"^\s*log\s*in\s*$", re.I)
    PAGE_TITLE_RE = re.compile(r" at (.+?) (?:•|\|)")

    def job_id(self, url):
        return self.job_url_re.search(url).group(1)

    def search_urls(self, page, cfg):
        """One role page per keyword (a Wellfound role name) and location, plus any extra URLs."""
        search = cfg.get("search") or {}
        slug = lambda s: re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
        urls = []
        for role in search.get("keywords") or []:
            for place in search.get("locations") or ["india"]:
                urls.append(f"https://wellfound.com/role/r/{slug(role)}" if place.lower() == "remote"
                            else f"https://wellfound.com/role/l/{slug(role)}/{slug(place)}")
        return unique_urls(urls + list(cfg.get("search_urls") or []))

    @staticmethod
    def search_page_url(url, n):
        return url if n == 1 else f"{url}{'&' if '?' in url else '?'}page={n}"

    def collect_links(self, page, max_scrolls=0):
        """Job URL -> its row text, or nothing if Wellfound redirected away from the role page."""
        if "/role/" not in page.url:
            print(f"  Wellfound has no such role page (went to {page.url}), skipping.")
            return {}
        return {url: with_range(text) for url, text in page.evaluate(JOB_ROWS_JS) if self.job_url_re.search(url)}

    # ------------------------------------------------------------ login

    def is_logged_in(self, page):
        page.goto("https://wellfound.com/jobs", wait_until="domcontentloaded")
        if not clear_challenge(page):
            return False
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except PWTimeout:
            pass
        return first_visible(page, self.LOGIN_RE) is None

    def auto_login(self, page, cfg):
        email, password = os.environ.get("WELLFOUND_EMAIL"), os.environ.get("WELLFOUND_PASSWORD")
        if not (email and password):
            return False
        page.goto(self.login_url, wait_until="domcontentloaded")
        if not clear_challenge(page):
            return False
        page.fill("#user_email", email)
        page.fill("#user_password", password)
        page.click("input[type=submit][name=commit]")
        try:
            page.wait_for_url(lambda url: "/login" not in url, timeout=20000)
        except PWTimeout:
            errors = page.get_by_text(re.compile(r"invalid|incorrect|wrong|not found|try again", re.I))
            shown = [errors.nth(i).inner_text().strip() for i in range(errors.count()) if errors.nth(i).is_visible()]
            print(f"Auto-login failed: {shown[0] if shown else 'still on the login page'}")
            return False
        return True

    # ------------------------------------------------------------ jobs

    def read_job(self, page, url):
        m = self.PAGE_TITLE_RE.search(page.title())
        company = m.group(1).strip() if m else ""
        title = text_of(page.locator("h1").first)
        if company and title.endswith(f" at {company}"):  # logged in, the heading reads "<title> at <company>"
            title = title[: -len(f" at {company}")]
        return Job(url, self.job_id(url), title, company, with_range(text_of(page.locator("body"))))

    def question_page(self, page):
        return None  # Wellfound asks in a dialog

    def is_applied(self, page):
        """A confirmation message, or the job's own button showing "Applied". The left menu also has an
        "Applied" link (your applications list), so links don't count."""
        if page.get_by_text(APPLIED_TEXT_RE).filter(visible=True).count():
            return True
        return page.get_by_role("button", name=re.compile(r"^\s*applied\s*$", re.I)).filter(visible=True).count() > 0

    def cannot_apply(self, page):
        """The apply dialog says up front when a company won't take your application."""
        if page.get_by_text(re.compile(r"not accepting applications from your (current )?location", re.I)).filter(visible=True).count():
            return "company doesn't hire from your location"
        if page.get_by_text(re.compile(r"no longer accepting applications", re.I)).filter(visible=True).count():
            return "job is closed"
        return None

    def dismiss_extras(self, page):
        pass


PORTAL = Wellfound()
