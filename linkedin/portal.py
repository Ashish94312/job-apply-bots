"""LinkedIn: where its jobs are, how to read them, logging in, and Easy Apply.

Searches are /jobs/search/?keywords=..&location=.., 25 jobs a page (&start=25, 50, ...), narrowed in the URL to
Easy Apply jobs, your experience levels and recent posts. A result card only fills in once it has been scrolled
into view, so the list is scrolled through before it's read. Applying goes through LinkedIn's own dialog
(contact info, resume, the company's questions, review, submit); jobs that apply on the company's website are
recorded as external.
"""
import os
import re
import sys
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import TimeoutError as PWTimeout

from core import (
    EXPERIENCE_RE,
    NOTE_RE,
    Job,
    Status,
    answer_for,
    choose_option,
    click,
    cover_note,
    first_visible,
    has_word,
    text_of,
    unique_urls,
    visible_dialog,
)

BASE = "https://www.linkedin.com"
EXPERIENCE_LEVELS = {"internship": 1, "entry level": 2, "associate": 3, "mid-senior level": 4, "director": 5, "executive": 6}
WORK_TYPES = {"on-site": 1, "onsite": 1, "remote": 2, "hybrid": 3}
POSTED_WITHIN = {"day": "r86400", "week": "r604800", "month": "r2592000"}


class DailyLimit(Exception):
    """LinkedIn won't take more Easy Apply applications today."""


# Every job card on a search page -> [job id, card text]. The cards carry the job id even before they fill in.
CARDS_JS = """() => {
  const t = s => (s || '').replace(/\\s+/g, ' ').trim();
  const cards = {};
  for (const card of document.querySelectorAll('[data-occludable-job-id]'))
    cards[card.getAttribute('data-occludable-job-id')] = t(card.innerText);
  for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {  // in case the cards lose that attribute
    const m = a.href.match(/\\/jobs\\/view\\/(?:[^/?#]*-)?(\\d+)/);
    if (m && !cards[m[1]]) cards[m[1]] = t((a.closest('li') || a).innerText);
  }
  return Object.entries(cards);
}"""

# The questions on the current step of the Easy Apply dialog, one entry per input.
FIELDS_JS = """root => {
  const t = s => (s || '').replace(/\\s+/g, ' ').trim();
  // A label often holds its text twice, once on screen and once for screen readers: "QQ" -> "Q".
  const once = s => {
    const h = Math.floor(s.length / 2);
    for (let i = Math.max(1, h - 2); i <= Math.min(s.length - 1, h + 2); i++)
      if (t(s.slice(0, i)) === t(s.slice(i))) return t(s.slice(0, i));
    return s;
  };
  const clean = s => once(t(t(s).replace(/\\*/g, '')).replace(/\\s*\\brequired$/i, ''));
  const marked = s => /\\*|\\brequired\\b/i.test(s || '');
  const labelFor = e => (e.id && root.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label');
  // Newer forms: the <label> is empty and the option's text sits next to the input, in a div role=radio
  // (whose aria-label is the question) or in a plain block (the question is then the input's aria-label).
  const wrapper = e => e.closest('[role=radio], [role=checkbox]');
  const ownBlock = e => {  // the biggest block holding this option and no other
    let p = e;
    while (p.parentElement && p.parentElement !== root
           && p.parentElement.querySelectorAll('input[type=radio], input[type=checkbox]').length === 1) p = p.parentElement;
    return p;
  };
  const optionText = e => t((labelFor(e) || {}).innerText) || t((wrapper(e) || {}).innerText)
    || t(ownBlock(e).innerText).slice(0, 200) || e.value;
  const legend = e => { const fs = e.closest('fieldset'); const lg = fs && fs.querySelector('legend'); return lg ? lg.innerText : ''; };
  const ownLabel = e => {
    const lab = labelFor(e);
    if (lab && t(lab.innerText)) return lab.innerText;
    const by = (e.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => id && document.getElementById(id))
      .filter(Boolean).map(x => x.innerText).join(' ');
    if (t(by)) return by;
    if (t(e.getAttribute('aria-label'))) return e.getAttribute('aria-label');
    if (t(legend(e))) return legend(e);
    for (let p = e.parentElement, i = 0; p && p !== root && i < 6; p = p.parentElement, i++)
      if (t(p.innerText)) return p.innerText.slice(0, 300);
    return e.placeholder || e.name || '';
  };
  const question = e => {  // a radio's or checkbox's question: its legend or aria-label, else the text around the group
    if (t(legend(e))) return legend(e);
    const own = (wrapper(e) && wrapper(e).getAttribute('aria-label')) || e.getAttribute('aria-label');
    if (t(own) && t(own) !== t(optionText(e))) return own;
    const group = e.closest('fieldset, [role=radiogroup], [role=group]');
    if (group && t(group.getAttribute('aria-label'))) return group.getAttribute('aria-label');
    const same = [...root.querySelectorAll('input')].filter(x => x.type === e.type && x.name && x.name === e.name);
    let p = e.parentElement;
    while (p && p !== root && !same.every(x => p.contains(x))) p = p.parentElement;
    const options = t(p ? p.innerText : '');
    for (let i = 0; p && p !== root && i < 4 && t(p.innerText).length <= options.length + 5; i++) p = p.parentElement;
    return p ? p.innerText.slice(0, 300) : '';
  };
  const fieldsets = [...root.querySelectorAll('fieldset')];
  return [...root.querySelectorAll('input, textarea, select')].map((e, i) => {
    const tag = e.tagName.toLowerCase(), type = (e.type || '').toLowerCase();
    const choice = type === 'radio' || type === 'checkbox';
    const raw = choice ? question(e) : ownLabel(e);
    const fs = e.closest('fieldset');
    const group = choice && e.closest('fieldset, [role=radiogroup], [role=group]');
    const sel = tag === 'select' ? e.options[e.selectedIndex] : null;
    const unchosen = tag === 'select' && (!sel || sel.value === '' || /^select\\b/i.test(t(sel.text)));
    const combo = e.getAttribute('role') === 'combobox' || e.getAttribute('aria-autocomplete') === 'list';
    return {
      i, tag, type,
      kind: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : choice ? type : combo ? 'combo' : 'text',
      label: clean(raw).slice(0, 200),
      option: choice ? clean(optionText(e)) : '',
      group: !choice ? '' : type === 'radio' && e.name ? 'r:' + e.name : fs ? 'f:' + fieldsets.indexOf(fs) : 'i:' + i,
      value: tag === 'select' ? (unchosen ? '' : t(sel.text)) : t(e.value),
      options: tag === 'select' ? [...e.options].map(o => t(o.text)) : [],
      checked: !!e.checked || (!!wrapper(e) && wrapper(e).getAttribute('aria-checked') === 'true'),
      disabled: e.disabled,
      required: e.required || e.getAttribute('aria-required') === 'true' || marked(raw)
        || (!!group && (group.getAttribute('aria-required') === 'true' || /\\*/.test((group.innerText || '').split('\\n')[0]))),
      numeric: type === 'number' || /numeric/i.test(e.id || ''),
      visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
    };
  });
}"""

# The job description: the block under the "About the job" heading (it has no id of its own).
ABOUT_JS = """() => {
  const h = [...document.querySelectorAll('h1, h2, h3')].find(e => /^about the job$/i.test(e.innerText.trim()));
  let p = h && h.parentElement;
  for (let i = 0; p && i < 4 && p.innerText.trim().length < 200; i++) p = p.parentElement;
  return p ? p.innerText : '';
}"""

# What LinkedIn complains about after Next/Review/Submit: [{i: index of the field or -1, text: "<question>: <error>"}].
ERRORS_JS = """root => {
  const t = s => (s || '').replace(/\\s+/g, ' ').trim();
  const once = s => {  // "QQ" -> "Q", as in FIELDS_JS
    const h = Math.floor(s.length / 2);
    for (let i = Math.max(1, h - 2); i <= Math.min(s.length - 1, h + 2); i++)
      if (t(s.slice(0, i)) === t(s.slice(i))) return t(s.slice(0, i));
    return s;
  };
  const ERROR = /invalid|required|please|must|valid|enter |select|larger|smaller|between|at least|at most/i;
  const fields = [...root.querySelectorAll('input, textarea, select')];
  const out = [], seen = new Set();
  const add = (i, q, msg) => {
    const line = q ? `${once(t(q.replace(/\\*/g, ''))).slice(0, 80)}: ${msg}` : msg;
    if (!seen.has(line)) { seen.add(line); out.push({i, text: line}); }
  };
  const described = ':is(input, textarea, select, fieldset, [role=radiogroup], [role=group])';
  for (const e of root.querySelectorAll(`${described}[aria-describedby], ${described}[aria-errormessage]`)) {
    const ids = `${e.getAttribute('aria-describedby') || ''} ${e.getAttribute('aria-errormessage') || ''}`.split(/\\s+/).filter(Boolean);
    const msg = t(ids.map(id => (document.getElementById(id) || {}).innerText || '').join(' ').replace(/\\b\\d+\\s*\\/\\s*\\d+\\b/g, ''));
    if (!msg || !(ERROR.test(msg) || e.getAttribute('aria-invalid') === 'true')) continue;
    const radio = e.querySelector && e.querySelector('[role=radio][aria-label]');
    const q = e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText)
      || (radio && radio.getAttribute('aria-label')) || ((e.querySelector && e.querySelector('legend')) || {}).innerText || '';
    add(fields.indexOf(e), q, msg);
  }
  // Errors not linked to their field: short texts like "This field is required" under a question.
  const SHOWN = /^(this field is required|invalid input|required|please (enter|make|select|provide|choose) .{0,60}|enter a (valid|whole|decimal) .{0,60})$/i;
  for (const el of root.querySelectorAll('p, span, div')) {
    if (el.children.length || !(el.offsetWidth || el.offsetHeight) || !SHOWN.test(t(el.innerText))) continue;
    let p = el.parentElement, q = '';
    for (let i = 0; p && p !== root && i < 6 && !q; p = p.parentElement, i++) {
      const f = p.querySelector('[aria-label]:is(input, textarea, select, [role=radio]), legend, label');
      if (f) q = f.getAttribute('aria-label') || f.innerText;
    }
    add(-1, q, t(el.innerText));
  }
  for (const el of root.querySelectorAll('.artdeco-inline-feedback--error, [role=alert]')) {  // the older layout
    const msg = t(el.innerText);
    if (!msg || !(el.offsetWidth || el.offsetHeight)) continue;
    let q = '';
    for (let p = el.parentElement, i = 0; p && p !== root && i < 6 && !q; p = p.parentElement, i++) {
      const lab = p.querySelector('label, legend');
      if (lab) q = lab.innerText;
    }
    add(-1, q, msg);
  }
  return out;
}"""

# Tick a radio or checkbox the way a person would (the inputs are hidden behind custom styling); if that
# doesn't take, click its label.
CHOOSE_JS = """e => {
  const w = e.closest('[role=radio], [role=checkbox]');
  const on = () => e.checked || (!!w && w.getAttribute('aria-checked') === 'true');
  (w || e).click();
  const label = !on() && e.labels && e.labels[0];
  if (label) label.click();
  return on();
}"""

SKIP_TYPES = {"hidden", "submit", "button", "file", "search", "image", "reset"}
EASY_APPLY_RE = re.compile(r"easy apply", re.I)
EXTERNAL_APPLY_RE = re.compile(r"^\s*apply\b", re.I)
SUBMIT_RE = re.compile(r"^\s*submit( application)?\s*$", re.I)
REVIEW_RE = re.compile(r"^\s*review( your application)?\s*$", re.I)
NEXT_RE = re.compile(r"^\s*(next|continue( to next step| applying)?)\s*$", re.I)  # also the "safety reminder" some jobs show
STEP_BUTTON_RE = re.compile(rf"{SUBMIT_RE.pattern}|{REVIEW_RE.pattern}|{NEXT_RE.pattern}", re.I)
DONE_RE = re.compile(r"^\s*(done|not now|dismiss)\s*$", re.I)
SENT_RE = re.compile(r"application (was )?sent|application submitted", re.I)
APPLIED_RE = re.compile(r"^\s*applied\s+(\d+|an?)\s+\w+\s+ago|application (was )?(sent|submitted)", re.I)
SEE_APPLICATION_RE = re.compile(r"^\s*see application\s*$", re.I)
CLOSED_RE = re.compile(r"no longer accepting applications", re.I)
LIMIT_RE = re.compile(r"(easy apply|application)s? limit|reached (the|your) (daily )?limit|limit (for|on) (easy apply|applications)", re.I)
FOLLOW_RE = re.compile(r"^follow\b", re.I)
YES_RE = re.compile(r"^\s*(yes|true|agree|i agree|accept|checked?)\s*$", re.I)
# "How many years of work experience do you have with Python?", "Years of Java experience", "Experience with
# Python?", "React experience?": the skill is the group that matched.
SKILL_RES = [re.compile(p, re.I) for p in (
    r"years (?:of )?(?:\w+ )?experience (?:do you (?:currently )?have )?(?:with|in|using|working with|on) (.+?)\s*\??$",
    r"years of (.+?) experience(?: do you (?:currently )?have)?\s*\??$",
    r"^experience (?:with|in|using|on) (.+?)\s*\??$",
    r"^((?:[\w.+#/-]+ ?){1,3}) experience\s*\??$",
)]
NOT_A_SKILL_RE = re.compile(
    r"^(total|overall|all|any|work|relevant|professional|prior|previous|related|industry|it|information technology"
    r"|software|software (development|engineering)|the (field|industry|role)|this (field|industry|role|position)|your)$",
    re.I,
)
# "3+ years of experience", "minimum 2 years experience": LinkedIn job pages state experience like this.
PLUS_YEARS_RE = re.compile(r"(?<![\d.])(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,40}?\bexperience", re.I)
JOB_TITLE_RE = re.compile(r"^(?:\(\d+\)\s*)?(.+?) \| (.+?) \| LinkedIn$")
MAX_STEPS = 12


def with_range(text):
    """Write the smallest experience the description asks for as "N - N years" up front, so the experience
    filter (which reads the first "X - Y years") sees it."""
    found = [float(m.group(1)) for m in EXPERIENCE_RE.finditer(text or "")]
    found += [float(m.group(1)) for m in PLUS_YEARS_RE.finditer(text or "")]
    if not found:
        return text
    n = f"{min(found):g}"
    return f"{n} - {n} years. {text}"


def plain(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def pick(options, answer):
    """Index of the option matching the answer (ignoring case and punctuation), else of one starting with it."""
    want = plain(answer)
    if not want:
        return None
    for rule in (lambda o: o == want, lambda o: o.startswith(want)):
        for k, option in enumerate(options):
            if plain(option) and rule(plain(option)):
                return k
    return None


def as_number(answer):
    """"9 LPA" -> "9"; "+91 89552 47261" -> "918955247261"."""
    if re.search(r"[a-z]", answer, re.I):
        number = re.search(r"\d+(?:\.\d+)?", answer)
        return number.group(0) if number else answer
    return re.sub(r"[^\d.]", "", answer)


class LinkedIn:
    name = "linkedin"
    domain = "linkedin.com"
    login_url = f"{BASE}/login"
    # Logs in with LINKEDIN_EMAIL / LINKEDIN_PASSWORD from .env (a security check on a new login is done by
    # you in the window). Without them, or if that fails, you log in by hand once in a normal Chrome window.
    login_outside_automation = True
    job_link_css = "[data-occludable-job-id], a[href*='/jobs/view/'], :text-matches('no matching jobs', 'i')"
    # LinkedIn serves several layouts of a job page; any of these means it's there.
    job_ready_css = ("[data-view-name=job-detail-page], [data-view-name=job-apply-button], h1, "
                     "main a[href*='/company/'], button[aria-label*='apply' i]")
    job_url_re = re.compile(r"linkedin\.com/jobs/view/(?:[^/?#]*-)?(\d+)")

    def job_id(self, url):
        return self.job_url_re.search(url).group(1)

    # ------------------------------------------------------------ searching

    def search_urls(self, page, cfg):
        """One search per keyword and location, with the filters from `search` in the URL."""
        search = cfg.get("search") or {}
        params = {}
        if search.get("easy_apply_only", True):
            params["f_AL"] = "true"
        for key, codes, value in (
            ("experience_levels", EXPERIENCE_LEVELS, "f_E"),
            ("work_types", WORK_TYPES, "f_WT"),
        ):
            names = [n.lower() for n in search.get(key) or []]
            for n in names:
                if n not in codes:
                    print(f"Unknown {key} '{n}' in config.yaml, ignored. Known: {', '.join(codes)}")
            known = sorted({str(codes[n]) for n in names if n in codes})
            if known:
                params[value] = ",".join(known)
        if search.get("posted_within") in POSTED_WITHIN:
            params["f_TPR"] = POSTED_WITHIN[search["posted_within"]]
        params["sortBy"] = "DD"  # newest first
        urls = [
            f"{BASE}/jobs/search/?" + urlencode({"keywords": keyword, "location": place, **params})
            for keyword in search.get("keywords") or []
            for place in search.get("locations") or ["India"]
        ]
        return unique_urls(urls + list(cfg.get("search_urls") or []))

    @staticmethod
    def search_page_url(url, n):
        return url if n == 1 else f"{url}{'&' if '?' in url else '?'}start={(n - 1) * 25}"

    def collect_links(self, page, max_scrolls=0):
        """Job URL -> its card text. Scrolls each card into view first so it fills in."""
        cards = page.locator("[data-occludable-job-id]")
        for i in range(cards.count()):
            try:
                cards.nth(i).scroll_into_view_if_needed(timeout=3000)
            except PWTimeout:
                pass
            page.wait_for_timeout(150)
        return {f"{BASE}/jobs/view/{job_id}/": text for job_id, text in page.evaluate(CARDS_JS) if job_id.isdigit()}

    # ------------------------------------------------------------ login

    def is_logged_in(self, page):
        """Logged out, LinkedIn sends /feed/ to a login page, an "authwall" or a security check."""
        page.goto(f"{BASE}/feed/", wait_until="domcontentloaded")
        page.wait_for_timeout(2000)
        return urlsplit(page.url).path.startswith("/feed")

    def auto_login(self, page, cfg):
        email, password = os.environ.get("LINKEDIN_EMAIL"), os.environ.get("LINKEDIN_PASSWORD")
        if not (email and password):
            return False
        page.goto(self.login_url, wait_until="domcontentloaded")
        # The page has generated ids and a hidden second password box, so: the visible boxes, by their purpose.
        email_box = page.locator("#username, input[autocomplete=username]").filter(visible=True)
        try:
            email_box.first.wait_for(timeout=15000)
        except PWTimeout:
            return urlsplit(page.url).path.startswith("/feed")  # already in
        email_box.first.fill(email)
        page.locator("#password, input[autocomplete=current-password]").filter(visible=True).first.fill(password)
        click(page.get_by_role("button", name=re.compile(r"^\s*sign in\s*$", re.I)).filter(visible=True).first)
        try:
            page.wait_for_url(lambda url: "/login" not in url and "/uas/login" not in url, timeout=20000)
        except PWTimeout:
            error = page.locator("[id^=error-for], .alert-content, [role=alert]").filter(visible=True)
            print(f"Auto-login failed: {text_of(error.first) if error.count() else 'still on the login page'}")
            return False
        if "/checkpoint" in page.url or "/challenge" in page.url:
            self.wait_for_check(page)
        return urlsplit(page.url).path.startswith("/feed")

    def wait_for_check(self, page, minutes=5):
        """LinkedIn's security check on a new login (a code sent to your email, an app approval or a puzzle)."""
        if sys.stdin.isatty():
            input("\nLinkedIn wants a security check: do it in the browser window, then press Enter here... ")
            return
        print("LinkedIn wants a security check: do it in the browser window.")
        try:
            page.wait_for_url(lambda url: urlsplit(url).path.startswith("/feed"), timeout=minutes * 60000)
        except PWTimeout:
            pass

    # ------------------------------------------------------------ jobs

    def read_job(self, page, url):
        m = JOB_TITLE_RE.search(page.title())  # "<title> | <company> | LinkedIn"; the page itself has no h1 now
        if m:
            title, company = m.group(1).strip(), m.group(2).strip()
        else:
            title = text_of(page.locator("main h1, h1").first) if page.locator("h1").count() else ""
            link = self.company_link(page)
            company = text_of(link) if link else ""
        about = page.evaluate(ABOUT_JS) or (text_of(page.locator("main").first) if page.locator("main").count() else "")
        return Job(url, self.job_id(url), title, company, with_range(about))

    def company_link(self, page):
        loc = page.locator(".job-details-jobs-unified-top-card__company-name a, main a[href*='/company/']")
        for i in range(min(loc.count(), 10)):
            if text_of(loc.nth(i)):
                return loc.nth(i)
        return None

    def company_url(self, page):
        """The job's company page, e.g. https://www.linkedin.com/company/razorpay/."""
        link = self.company_link(page)
        m = re.search(r"/company/([^/?#]+)", (link.get_attribute("href") or "") if link else "")
        return f"{BASE}/company/{m.group(1)}/" if m else None

    def question_page(self, page):
        return None  # LinkedIn asks in a dialog

    def is_applied(self, page):
        """The job shows "Applied 3 minutes ago" and a "See application" button once you've applied."""
        if page.get_by_text(APPLIED_RE).filter(visible=True).count():
            return True
        return first_visible(page, SEE_APPLICATION_RE) is not None

    def cannot_apply(self, page):
        if page.get_by_text(CLOSED_RE).filter(visible=True).count():
            return "job is closed"
        return None

    def dismiss_extras(self, page):
        pass

    # ------------------------------------------------------------ Easy Apply

    def apply(self, page, cfg, job):
        """Easy Apply through every step of the dialog. Returns (status, note)."""
        button = first_visible(page, EASY_APPLY_RE, roles=("button",))  # similar-job links mention it too
        if button is None:
            if self.is_applied(page):
                return Status.ALREADY, ""
            blocked = self.cannot_apply(page)
            if blocked:
                return Status.SKIPPED, blocked
            if first_visible(page, EXTERNAL_APPLY_RE):
                return Status.EXTERNAL, "applies on the company website"
            return Status.MANUAL, "no Easy Apply button found"
        click(button)
        self.wait_for_step(page)
        self.check_limit(page)

        last_step = None
        for _ in range(MAX_STEPS):
            if self.sent(page):
                self.close_done(page)
                return Status.APPLIED, ""
            modal = self.modal(page)
            if modal is None:
                if self.is_applied(page):
                    return Status.APPLIED, ""
                return Status.MANUAL, "the Easy Apply dialog didn't open"
            missing = self.fill_step(modal, cfg, job)
            if missing:
                return Status.MANUAL, "unanswered: " + "; ".join(missing)
            changed = self.answered_by_itself(modal)
            if changed:
                return Status.MANUAL, "answered without the bot, check: " + "; ".join(q[:60] for q in changed)

            submit = first_visible(modal, SUBMIT_RE, roles=("button",))
            button = submit or first_visible(modal, REVIEW_RE, roles=("button",)) or first_visible(modal, NEXT_RE, roles=("button",))
            if button is None:
                return Status.MANUAL, "no Next / Review / Submit button in the dialog"
            step = text_of(modal)
            errors = self.press(page, modal, button, submit)
            if errors and self.as_numbers(modal, errors):  # "0 months" in a box that only takes a number
                errors = self.press(page, modal, button, submit)
            if errors:
                return Status.MANUAL, "LinkedIn says: " + "; ".join(e["text"] for e in errors)
            if submit:
                if self.sent(page) or self.is_applied(page):
                    self.close_done(page)
                    return Status.APPLIED, ""
                return Status.MANUAL, "submitted, but couldn't confirm the application went through"
            if modal.is_visible() and text_of(modal) == step:
                if step == last_step:
                    return Status.MANUAL, "stuck on a step of the dialog"
                last_step = step
        return Status.MANUAL, "the dialog had too many steps"

    def wait_for_step(self, page, seconds=12):
        """The dialog shows up first and its questions a moment later: wait for a field or a step button."""
        for _ in range(seconds * 2):
            modal = self.modal(page)
            if modal is not None and (modal.locator("input, select, textarea").count()
                                      or first_visible(modal, STEP_BUTTON_RE, roles=("button",))):
                break
            if self.sent(page):
                break
            page.wait_for_timeout(500)
        page.wait_for_timeout(500)

    def modal(self, page):
        loc = page.locator(".jobs-easy-apply-modal:visible, [data-test-modal-id='easy-apply-modal']:visible")
        return loc.first if loc.count() else visible_dialog(page)  # now a plain <dialog open>

    def press(self, page, modal, button, submit):
        """Click Next / Review / Submit. Returns LinkedIn's complaints about this step, if any."""
        click(button)
        page.wait_for_timeout(1500)
        for _ in range(10 if submit else 1):  # a submitted application's confirmation can take a few seconds
            if submit and (self.sent(page) or self.is_applied(page)):
                return []
            errors = self.errors(modal)
            if errors:
                return errors
            if submit:
                self.check_limit(page)
                page.wait_for_timeout(1000)
        if not submit:
            self.wait_for_step(page)
        return []

    def errors(self, modal):
        """What LinkedIn complains about on this step ("Invalid input", "Please make a selection", ...)."""
        if not modal.is_visible():
            return []
        return [e for e in modal.evaluate(ERRORS_JS) if not SENT_RE.search(e["text"])]

    def as_numbers(self, modal, errors):
        """Rewrite rejected answers like "0 months" or "9 LPA" as plain numbers. Returns True if any changed."""
        inputs = modal.locator("input, textarea, select")
        changed = False
        for e in errors:
            if e["i"] < 0:
                continue
            box = inputs.nth(e["i"])
            if box.evaluate("e => e.tagName === 'SELECT' || ['radio', 'checkbox'].includes(e.type)"):
                continue
            value = box.input_value()
            number = as_number(value) if re.search(r"\d", value) else ""
            if number and number != value:
                box.fill(number)
                changed = True
        return changed

    def sent(self, page):
        return page.get_by_text(SENT_RE).filter(visible=True).count() > 0

    def close_done(self, page):
        """Close the "Your application was sent" dialog."""
        page.wait_for_timeout(800)
        button = first_visible(page, DONE_RE, roles=("button",))
        if button:
            click(button)
            page.wait_for_timeout(800)

    def check_limit(self, page):
        if page.get_by_text(LIMIT_RE).filter(visible=True).count():
            raise DailyLimit("LinkedIn says you've hit today's Easy Apply limit. Try again tomorrow.")

    def answer(self, label, cfg):
        """Answer from `answers`; else, for "years of experience with <skill>", from `skill_years`."""
        answer = answer_for(label, cfg.get("answers"))
        if answer is not None:
            return answer
        m = next((m for regex in SKILL_RES if (m := regex.search(label or ""))), None)
        if not m or NOT_A_SKILL_RE.match(m.group(1).strip()):
            return None
        for skill, years in (cfg.get("skill_years") or {}).items():
            if years not in (None, "") and has_word(m.group(1), str(skill)):
                return str(years)
        other = cfg.get("other_skill_years")
        return None if other in (None, "") else str(other)

    def read_fields(self, modal, tries=5):
        """The step's fields, once they've stopped changing: options get their text a moment after they appear."""
        fields = modal.evaluate(FIELDS_JS)
        for _ in range(tries):
            modal.page.wait_for_timeout(700)
            again = modal.evaluate(FIELDS_JS)
            if again == fields:
                break
            fields = again
        return fields

    def fill_step(self, modal, cfg, job):
        """Fill this step of the dialog from config. Returns the required questions it has no answer for."""
        inputs = modal.locator("input, textarea, select")
        missing, groups = [], {}
        self.left_blank = set()
        for f in self.read_fields(modal):
            if f["disabled"] or f["type"] in SKIP_TYPES:
                continue
            if f["kind"] in ("radio", "checkbox"):
                if FOLLOW_RE.search(f["option"]) or FOLLOW_RE.search(f["label"]):  # "Follow <company> to stay up to date": off unless follow_companies
                    if f["checked"] != bool(cfg.get("follow_companies")):
                        inputs.nth(f["i"]).evaluate("e => (e.closest('[role=checkbox]') || e).click()")
                    continue
                group = groups.setdefault(f["group"], {"label": f["label"], "kind": f["kind"], "required": False,
                                                       "checked": False, "options": []})
                group["required"] |= f["required"]
                group["checked"] |= f["checked"]
                group["options"].append((f["i"], f["option"]))
                continue
            if not f["visible"]:
                continue
            if f["kind"] == "select":  # a prefilled one too: "Phone country code" starts at Andorra
                k = pick(f["options"], self.answer(f["label"], cfg))
                if k is not None and plain(f["options"][k]) != plain(f["value"]):
                    inputs.nth(f["i"]).select_option(index=k)
                elif k is None and not f["value"] and f["required"]:
                    missing.append(f["label"][:60] or "dropdown")
                continue
            if f["value"]:
                continue
            answer = self.answer(f["label"], cfg)
            if f["kind"] == "combo":
                if not choose_option(inputs.nth(f["i"]), answer) and f["required"]:
                    missing.append(f["label"][:60] or "dropdown")
                continue
            if answer is None and f["kind"] == "textarea" and (not f["label"] or NOTE_RE.search(f["label"])):
                answer = cover_note(cfg, job) or None
            if answer is None:
                if f["required"]:
                    missing.append(f["label"][:60] or "text box")
                continue
            inputs.nth(f["i"]).fill(as_number(answer) if f["numeric"] else answer)

        for group in groups.values():
            if group["checked"]:
                continue
            answer = self.answer(group["label"], cfg)
            options = [option for _, option in group["options"]]
            if group["kind"] == "radio":
                k = pick(options, answer)
                chosen = [] if k is None else [group["options"][k][0]]
            elif len(options) == 1:  # a lone "I agree" box
                chosen = [group["options"][0][0]] if answer and (YES_RE.match(answer) or plain(answer) == plain(options[0])) else []
            else:  # "select all that apply": answer lists the options, comma separated
                wanted = {plain(a) for a in re.split(r"[,;|]", answer or "") if plain(a)}
                chosen = [i for i, option in group["options"] if plain(option) in wanted]
            for i in chosen:
                inputs.nth(i).evaluate(CHOOSE_JS)
            if not chosen:
                self.left_blank.add(group["label"])
                if group["required"]:
                    missing.append(group["label"][:60] or "choice")
        return missing

    def answered_by_itself(self, modal):
        """Questions this bot left blank that have an answer now (never send one it didn't choose)."""
        checked = {f["label"] for f in self.read_fields(modal) if f["kind"] in ("radio", "checkbox") and f["checked"]}
        return sorted(self.left_blank & checked)


PORTAL = LinkedIn()
