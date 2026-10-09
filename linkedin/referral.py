"""Asking people at a company for a referral, on LinkedIn.

For each job the bot applied to recently (plus any job link in referral.jobs) it opens the company's page,
searches its employees among your 1st and 2nd-degree connections (alumni of your college first), and then:
  - people you're already connected with get the referral message right away;
  - the others get a connection invite (with a short note while LinkedIn still allows you notes), and get
    the referral message on a later run, once they've accepted.
A few people per company, a daily cap, and nobody is contacted twice.
"""
import json
import re
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlencode

from playwright.sync_api import Error as PWError
from playwright.sync_api import TimeoutError as PWTimeout

from core import Job, click, first_visible, has_word, text_of, visible_dialog
from portal import BASE, PORTAL

MESSAGED, INVITED, EXPIRED, FAILED = "messaged", "invited", "not_accepted", "failed"
STATUSES = (MESSAGED, INVITED, EXPIRED, FAILED)


class Stop(Exception):
    """Stop asking for now: a LinkedIn limit, or you said quit."""


@dataclass
class Person:
    profile: str
    name: str
    headline: str = ""
    degree: str = ""
    rank: int = 0


# People on a search results page -> {slug, name, degree, headline}. A result also links to mutual connections,
# so a person's own link is the first one in their result.
PEOPLE_JS = """() => {
  const t = s => (s || '').replace(/\\s+/g, ' ').trim();
  const slugOf = a => { const m = (a.getAttribute('href') || '').match(/\\/in\\/([^/?#]+)/); return m ? decodeURIComponent(m[1]) : ''; };
  let rows = [...document.querySelectorAll('[data-view-name="people-search-result"], [data-chameleon-result-urn], [data-view-name="search-entity-result-universal-template"]')];
  if (!rows.length)  // a layout with no markers: rows of a role=list
    rows = [...document.querySelectorAll('main [role=listitem]')].filter(r => r.querySelector('a[href*="/in/"]') && !r.querySelector('[role=listitem]'));
  if (!rows.length) {  // else: the list with the most items linking to profiles
    const lists = new Map();
    for (const li of document.querySelectorAll('main li'))
      if (li.querySelector('a[href*="/in/"]')) lists.set(li.parentElement, [...(lists.get(li.parentElement) || []), li]);
    rows = [...lists.values()].sort((a, b) => b.length - a.length)[0] || [];
  }
  return rows.map(row => {
    const title = row.querySelector('a[data-view-name="search-result-lockup-title"]');  // the person's own name link
    const links = [...row.querySelectorAll('a[href*="/in/"]')];
    const slug = title ? slugOf(title) : links.length ? slugOf(links[0]) : '';
    const nameOf = a => {  // "Name" + a hidden "View Name's profile" in older layouts; else the link's first line
      const hidden = a.querySelector('span[aria-hidden=true]');
      if (hidden && /view .*profile/i.test(a.innerText || '')) return t(hidden.innerText);
      return (a.innerText || '').split('\\n').map(t).filter(Boolean)[0] || '';
    };
    const name = links.filter(a => slugOf(a) === slug).map(nameOf).find(n => n && n.length < 80) || '';
    const degree = (row.innerText.match(/\\b(1st|2nd|3rd\\+?)\\b/) || [])[1] || '';
    const junk = s => s === name || /^[•·]?\\s*(1st|2nd|3rd\\+?)$/.test(s) || /^[•·]$/.test(s)
      || /degree connection|^view .*profile$|^(connect|message|follow|following|pending)$/i.test(s);
    const lines = row.innerText.split('\\n').map(t).filter(Boolean).filter(s => !junk(s));
    return { slug, name, degree, headline: lines[0] || '' };
  }).filter(p => p.slug && p.name && p.name !== 'LinkedIn Member');
}"""

SEARCH_LIMIT_RE = re.compile(r"monthly (search )?limit|commercial use limit", re.I)
WEEKLY_LIMIT_RE = re.compile(r"weekly invitation limit|limit for (connection requests|invitations)|too many pending invitations", re.I)
EMAIL_RE = re.compile(r"enter (their|his|her) email|how do you know", re.I)
MORE_RE = re.compile(r"^\s*more( actions)?\s*$", re.I)
PENDING_RE = re.compile(r"^\s*pending\b", re.I)
ADD_NOTE_RE = re.compile(r"^\s*add a (free )?note\s*$", re.I)
SEND_RE = re.compile(r"^\s*send( invitation| now)?\s*$", re.I)
SEND_PLAIN_RE = re.compile(r"^\s*send without a note\s*$", re.I)
INVITE_SENT_RE = re.compile(r"invitation (to .+ )?(was )?sent", re.I)
CLOSE_CHAT_RE = re.compile(r"^\s*close your (conversation|draft)", re.I)
MESSAGE_BOX_CSS = ".msg-form__contenteditable[contenteditable=true], [role=textbox][contenteditable=true]"
TITLES = {"dr", "mr", "mrs", "ms", "er", "ca", "prof"}


def slug_of(url):
    m = re.search(r"/in/([^/?#]+)", url or "")
    return unquote(m.group(1)).lower() if m else ""


def first_name(name):
    words = [w for w in re.sub(r"[^\w\s.'-]", " ", name).split() if w.lower().rstrip(".") not in TITLES]
    first = words[0] if words else "there"
    return first.capitalize() if first.islower() or first.isupper() else first


def render(template, name, job):
    """The message with {first_name}, {name}, {company}, {title} and {job_url} filled in."""
    text = (template or "").strip()
    for key, value in (("first_name", first_name(name)), ("name", name), ("company", job.company or "your company"),
                       ("title", job.title or "the open role"), ("job_url", job.url)):
        text = text.replace("{" + key + "}", value)
    return text


def indent(text):
    return "\n".join(f"      {line}" for line in text.splitlines())


# ---------------------------------------------------------------- who has been asked

class Contacts:
    """Everyone the bot has contacted, and the jobs it has asked about, next to the jobs table."""

    def __init__(self, store):
        self.db, self.site = store.db, store.site
        self.db.executescript(
            """CREATE TABLE IF NOT EXISTS contacts (
                profile TEXT PRIMARY KEY, name TEXT, headline TEXT, company TEXT, company_url TEXT,
                job_id TEXT, job_url TEXT, title TEXT, status TEXT, note TEXT, ts TEXT, updated TEXT);
            CREATE TABLE IF NOT EXISTS referral_jobs (
                job_id TEXT PRIMARY KEY, url TEXT, title TEXT, company TEXT, status TEXT, note TEXT, ts TEXT);"""
        )

    def jobs_to_ask(self, statuses, days):
        """Jobs with one of these statuses from the last `days` days, newest first, not asked about yet."""
        marks = ",".join("?" * len(statuses))
        rows = self.db.execute(
            f"""SELECT url, job_id, title, company FROM jobs
                WHERE site=? AND status IN ({marks}) AND ts >= datetime('now', 'localtime', ?)
                  AND job_id NOT IN (SELECT job_id FROM referral_jobs)
                ORDER BY ts DESC""",
            (self.site, *statuses, f"-{int(days)} days"),
        ).fetchall()
        return [Job(*row) for row in rows]

    def asked_about(self, job_id):
        return self.db.execute("SELECT 1 FROM referral_jobs WHERE job_id=?", (job_id,)).fetchone() is not None

    def job_done(self, job, status, note=""):
        self.db.execute(
            "INSERT OR REPLACE INTO referral_jobs VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))",
            (job.job_id, job.url, job.title, job.company, status, note),
        )
        self.db.commit()

    def known(self, profile):
        return self.db.execute("SELECT 1 FROM contacts WHERE profile=?", (profile,)).fetchone() is not None

    def asked_at(self, company_url):
        return self.db.execute(
            "SELECT COUNT(*) FROM contacts WHERE company_url=? AND status IN (?, ?)", (company_url, MESSAGED, INVITED)
        ).fetchone()[0]

    def sent_today(self):
        return self.db.execute(
            "SELECT COUNT(*) FROM contacts WHERE status IN (?, ?) AND date(updated)=date('now', 'localtime')",
            (MESSAGED, INVITED),
        ).fetchone()[0]

    def pending(self):
        """Invites not accepted yet: (person, job, company_url, days since the invite), oldest first."""
        rows = self.db.execute(
            """SELECT profile, name, headline, company, company_url, job_id, job_url, title,
                      julianday('now', 'localtime') - julianday(ts)
               FROM contacts WHERE status=? ORDER BY ts""",
            (INVITED,),
        ).fetchall()
        return [(Person(profile, name, headline), Job(job_url, job_id, title, company), company_url, age)
                for profile, name, headline, company, company_url, job_id, job_url, title, age in rows]

    def save(self, person, job, company_url, status, note=""):
        """Add someone, or update their status (keeping when they were first contacted)."""
        self.db.execute(
            """INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                            datetime('now', 'localtime'), datetime('now', 'localtime'))
               ON CONFLICT(profile) DO UPDATE SET status=excluded.status, note=excluded.note, updated=excluded.updated""",
            (person.profile, person.name, person.headline, job.company, company_url, job.job_id, job.url, job.title,
             status, note),
        )
        self.db.commit()

    def history(self, status=None, limit=30):
        sql, args = "SELECT updated, status, name, headline, company, profile, note FROM contacts", []
        if status:
            sql += " WHERE status=?"
            args.append(status)
        return self.db.execute(sql + " ORDER BY updated DESC LIMIT ?", (*args, limit)).fetchall()


# ---------------------------------------------------------------- the run

def run(page, cfg, store, args):
    rc = cfg["referral"]
    if not (rc.get("message") or "").strip():
        print("Write the referral message (referral.message) in config.yaml first.")
        return
    if not args.dry_run and re.search(r"<[^<>\n]+>", rc.get("message") or ""):
        print("The referral message in config.yaml still has a <...> placeholder. Write that part, then run again.")
        return
    contacts = Contacts(store)
    budget = args.max or rc.get("max_per_run", 8)
    if not args.dry_run:
        budget = min(budget, rc.get("max_per_day", 15) - contacts.sent_today())
        if budget <= 0:
            print(f"Daily limit reached ({rc.get('max_per_day', 15)} messages + invites).")
            return
    state = {"notes_used_up": False, "dry_asked": {}}  # dry_asked: company -> people a dry run would have asked
    sent = 0
    try:
        sent += follow_up(page, rc, contacts, args, budget, state)
        jobs = contacts.jobs_to_ask(rc.get("for_jobs") or ["applied"], rc.get("within_days", 14)) + extra_jobs(rc, contacts)
        print(f"\n{len(jobs)} job(s) to ask about.")
        for job in jobs:
            if sent >= budget:
                break
            try:
                sent += ask_at_company(page, rc, contacts, args, job, budget - sent, state)
            except PWError as e:
                if page.is_closed():
                    print("Browser window was closed, stopping.")
                    return
                print(f"  x {str(e).splitlines()[0]}")
    except Stop as e:
        print(f"\n{e}")
    print(f"\nDone: {'would contact' if args.dry_run else 'contacted'} {sent}.")


def extra_jobs(rc, contacts):
    jobs = []
    for url in rc.get("jobs") or []:
        m = PORTAL.job_url_re.search(url or "")
        if not m:
            print(f"Not a LinkedIn job link, skipped: {url}")
        elif not contacts.asked_about(m.group(1)):
            jobs.append(Job(f"{BASE}/jobs/view/{m.group(1)}/", m.group(1)))
    return jobs


def ask_at_company(page, rc, contacts, args, job, budget, state):
    """Find people at the job's company and contact up to per_company of them. Returns how many."""
    def finish(status, note=""):
        if not args.dry_run:
            contacts.job_done(job, status, note)

    page.goto(job.url, wait_until="domcontentloaded")
    try:
        page.wait_for_selector(PORTAL.job_ready_css, timeout=15000)
    except PWTimeout:
        print(f"\n{job.url}\n  x couldn't open the job")
        return 0
    page.wait_for_timeout(2000)
    job = PORTAL.read_job(page, job.url)
    company_url = PORTAL.company_url(page)
    print(f"\n{job.label}  {job.url}")
    if not company_url:
        print("  - the job doesn't link to a LinkedIn company page")
        finish("no_company")
        return 0
    asked = contacts.asked_at(company_url) + state["dry_asked"].get(company_url, 0)
    want = rc.get("per_company", 2) - asked
    if want <= 0:
        print(f"  = already asked {asked} people at {job.company}")
        finish("already_asked")
        return 0
    ids = company_ids(page, company_url)
    if not ids:
        print(f"  - couldn't find {job.company}'s employee list on {company_url}")
        finish("no_employee_list")
        return 0
    people = find_people(page, ids, rc, contacts, want)
    if not people:
        print("  - nobody there among your 1st and 2nd-degree connections")
        finish("nobody_found")
        return 0

    sent = 0
    for person in people[: want * 3]:  # don't open every profile if several don't work out
        if sent >= min(want, budget):
            break
        if contact(page, rc, contacts, args, person, job, company_url, state):
            sent += 1
    if args.dry_run:
        state["dry_asked"][company_url] = state["dry_asked"].get(company_url, 0) + sent
    if sent < want and sent >= budget:
        return sent  # out of today's budget: this company gets the rest next run
    finish("asked" if sent else "nobody_reached", f"{sent} contacted")
    return sent


def company_ids(page, company_url):
    """The company's LinkedIn ids, from its "See all N employees" link (a people search by company)."""
    page.goto(company_url, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("a[href*='currentCompany']", state="attached", timeout=15000)
    except PWTimeout:
        return []
    for href in page.eval_on_selector_all("a[href*='currentCompany']", "els => els.map(a => a.href)"):
        m = re.search(r"currentCompany=([^&#]+)", href)
        ids = re.findall(r"\d+", unquote(m.group(1))) if m else []
        if ids:
            return ids
    return []


def search_people(page, ids, keywords):
    compact = lambda value: json.dumps(value, separators=(",", ":"))  # ["F","S"]: LinkedIn mangles ["F", "S"]
    url = f"{BASE}/search/results/people/?" + urlencode({
        "currentCompany": compact(ids),
        "network": compact(["F", "S"]),  # 1st and 2nd-degree connections
        "keywords": keywords,
        "origin": "FACETED_SEARCH",
    }, quote_via=quote)
    page.goto(url, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("[data-view-name=people-search-result], [data-chameleon-result-urn], main li a[href*='/in/'], "
                               ":text-matches('no results found', 'i')", state="attached", timeout=15000)
    except PWTimeout:
        pass
    page.wait_for_timeout(1500)
    if page.get_by_text(SEARCH_LIMIT_RE).filter(visible=True).count():
        raise Stop("LinkedIn's monthly limit on people searches is reached. Referrals can go on when it resets.")
    return [Person(f"{BASE}/in/{p['slug']}/", p["name"], p["headline"], p["degree"]) for p in page.evaluate(PEOPLE_JS)]


def find_people(page, ids, rc, contacts, want):
    """Candidates at the company: people you're connected with first, then alumni of `school`, then the rest."""
    searches = ([rc["school"]] if rc.get("school") else []) + list(rc.get("people_keywords") or ["engineer"])
    skip = rc.get("skip_headline") or []
    found = {}
    for rank, keywords in enumerate(searches):
        for p in search_people(page, ids, keywords):
            if p.profile in found or contacts.known(p.profile) or p.degree.startswith("3"):
                continue
            if any(has_word(p.headline, word) for word in skip):
                continue
            p.rank = rank
            found[p.profile] = p
        if len(found) >= want * 3:  # plenty; save LinkedIn's search allowance
            break
    return sorted(found.values(), key=lambda p: (p.degree != "1st", p.rank))


def contact(page, rc, contacts, args, person, job, company_url, state, only_message=False):
    """Message them if you're connected, else send an invite. Returns True if sent (or, in a dry run, would be)."""
    page.goto(person.profile, wait_until="domcontentloaded")
    try:
        page.wait_for_selector("main section", timeout=15000)
    except PWTimeout:
        print(f"  x couldn't open {person.name}'s profile")
        return False
    page.wait_for_timeout(2000)
    profile = f"{BASE}/in/{slug_of(page.url)}/" if slug_of(page.url) else person.profile
    if not only_message and profile != person.profile and contacts.known(profile):
        return False
    name = profile_name(page) or person.name
    if job.company and job.company.lower() not in text_of(page.locator("main")).lower():
        print(f"  - {name}: their profile doesn't mention {job.company}, skipped")
        return False
    degree = re.search(r"\b(1st|2nd|3rd)\b", text_of(top_card(page)))
    connected = bool(degree) and degree.group(1) == "1st"
    if only_message and not connected:
        return False
    if not connected and state["notes_used_up"] and not rc.get("invite_without_note", True):
        return False

    who = Person(person.profile if only_message else profile, name, person.headline)  # follow-ups update their row
    note = "" if connected or state["notes_used_up"] else render(rc.get("connect_note"), name, job)
    text = render(rc.get("message"), name, job) if connected else note
    verb = "Message" if connected else "Invite"
    print(f"  {name}: {person.headline[:80] or '?'} ({'connected' if connected else 'not connected yet'})")
    if args.dry_run:
        print(f"  ~ would {verb.lower()} {name}" + (f":\n{indent(text)}" if text else " (no note)"))
        if note and len(note) > 300:
            print(f"    (this note is {len(note)} characters; LinkedIn allows 300, so the end would be cut)")
        return True
    if args.confirm:
        if text:
            print(indent(text))
        answer = input(f"  ? {verb} {name}? [y/N/q] ").strip().lower()
        if answer == "q":
            raise Stop("Stopped.")
        if answer != "y":
            return False

    if connected:
        ok, result = send_message(page, text)
        status = MESSAGED
    else:
        ok, result = send_invite(page, name, note, rc, state)
        status = INVITED
        if ok is None:  # notes used up and invite_without_note is off
            return False
    contacts.save(who, job, company_url, status if ok else FAILED, result)
    print(f"  {'+' if ok else 'x'} {status if ok else FAILED:<13} {name}  {result}")
    return ok


def follow_up(page, rc, contacts, args, budget, state):
    """Send the referral message to people who accepted the invite since the last run. Returns how many."""
    pending = contacts.pending()
    if not pending:
        return 0
    print(f"\nChecking which of {len(pending)} invite(s) were accepted...")
    accepted = recent_connections(page)
    if accepted is None:
        print("  Couldn't read your connections list; will check next run.")
        return 0
    sent = 0
    for person, job, company_url, age in pending:
        if slug_of(person.profile) not in accepted:
            days = rc.get("invite_expiry_days", 21)
            if age >= days and not args.dry_run:
                contacts.save(person, job, company_url, EXPIRED, f"not accepted in {days} days")
            continue
        if sent >= budget:
            break
        if contact(page, rc, contacts, args, person, job, company_url, state, only_message=True):
            sent += 1
    return sent


def recent_connections(page, scrolls=3):
    """Profile slugs of your most recent connections (that page lists the newest first)."""
    page.goto(f"{BASE}/mynetwork/invite-connect/connections/", wait_until="domcontentloaded")
    try:
        page.wait_for_selector("main a[href*='/in/']", state="attached", timeout=15000)
    except PWTimeout:
        return None
    for _ in range(scrolls):
        page.mouse.wheel(0, 4000)
        page.wait_for_timeout(1500)
    return {slug_of(href) for href in page.eval_on_selector_all("main a[href*='/in/']", "els => els.map(a => a.href)")} - {""}


# ---------------------------------------------------------------- sending

def profile_name(page):
    """From the tab title, "(3) Priya Sharma | LinkedIn" (the page itself has no h1 now)."""
    m = re.match(r"^(?:\(\d+\)\s*)?(.+?) \| LinkedIn$", page.title())
    return m.group(1).strip() if m else ""


def top_card(page):
    """The profile's header: name, headline, degree and its Connect / Message / More buttons."""
    return page.locator("main section").first


def send_message(page, text):
    button = first_visible(top_card(page), re.compile(r"^\s*message\b", re.I))
    if button is None:
        return False, "no Message button"
    click(button)
    try:
        page.wait_for_selector(MESSAGE_BOX_CSS, state="visible", timeout=10000)
    except PWTimeout:
        return False, "the message box didn't open"
    box = page.locator(MESSAGE_BOX_CSS).filter(visible=True).last
    box.click()
    box.fill(text)
    page.wait_for_timeout(800)
    send = first_visible(page, re.compile(r"^\s*send\s*$", re.I), roles=("button",))
    if send is None:
        return False, "no Send button in the chat"
    click(send)
    page.wait_for_timeout(2500)
    ok = not text_of(box)  # LinkedIn empties the box once the message has gone
    close = first_visible(page, CLOSE_CHAT_RE, roles=("button",))
    if close:
        click(close)
    return ok, "" if ok else "the message may not have been sent"


def open_invite(page, name):
    """Click Connect (straight on the profile, or under More). Returns False if there's no Connect."""
    own = re.compile(rf"^\s*invite {re.escape(name)} to connect\s*$", re.I)
    connect = re.compile(rf"{own.pattern}|^\s*connect\s*$", re.I)
    button = first_visible(top_card(page), connect)
    if button is None:
        more = first_visible(top_card(page), MORE_RE, roles=("button",))
        if more:
            click(more)
            page.wait_for_timeout(800)
            button = (first_visible(top_card(page), connect, roles=("button", "menuitem"))
                      or first_visible(page, own, roles=("button", "menuitem")))
    if button is None:
        page.keyboard.press("Escape")
        return False
    click(button)
    page.wait_for_timeout(1500)
    return True


def check_invite_limit(page):
    if page.get_by_text(WEEKLY_LIMIT_RE).filter(visible=True).count():
        page.keyboard.press("Escape")
        raise Stop("LinkedIn's weekly invitation limit is reached. Invites can go on next week.")


def send_invite(page, name, note, rc, state):
    """Returns (ok, note); ok is None if it was left alone because notes are used up."""
    if not open_invite(page, name):
        if first_visible(top_card(page), PENDING_RE):
            return True, "an invite was already pending"
        return False, "no Connect button (they may only allow follows)"
    check_invite_limit(page)
    dialog = visible_dialog(page)
    if dialog is not None and EMAIL_RE.search(text_of(dialog)):
        page.keyboard.press("Escape")
        return False, "LinkedIn wants their email address to connect"

    with_note = False
    if note:
        add = first_visible(page, ADD_NOTE_RE, roles=("button",))
        if add:
            click(add)
            page.wait_for_timeout(1000)
            box = page.locator("[role=dialog] textarea:visible, dialog[open] textarea:visible")
            if box.count():
                limit = int(box.first.get_attribute("maxlength") or 300)
                box.first.fill(note[:limit])
                with_note = True
            else:  # a Premium offer instead of a note box: this month's free notes are used up
                state["notes_used_up"] = True
                print("  LinkedIn's free invitation notes are used up for this month; invites go without a note now.")
                page.keyboard.press("Escape")
                page.wait_for_timeout(800)
                if not rc.get("invite_without_note", True):
                    page.keyboard.press("Escape")
                    return None, ""
                if visible_dialog(page) is None and not open_invite(page, name):
                    return False, "no Connect button after closing the Premium offer"

    dialog = visible_dialog(page) or page
    send = first_visible(dialog, SEND_RE, roles=("button",)) if with_note else (
        first_visible(dialog, SEND_PLAIN_RE, roles=("button",)) or first_visible(dialog, SEND_RE, roles=("button",)))
    if send is None:
        page.keyboard.press("Escape")
        return False, "no Send button in the invite dialog"
    click(send)
    page.wait_for_timeout(2500)
    check_invite_limit(page)
    if page.get_by_text(INVITE_SENT_RE).filter(visible=True).count() or first_visible(top_card(page), PENDING_RE):
        return True, "with a note" if with_note else "without a note"
    return False, "couldn't confirm the invite was sent"
