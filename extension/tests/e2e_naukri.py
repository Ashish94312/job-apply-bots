#!/usr/bin/env python3
"""End-to-end test for Naukri: the extension in a real Chromium, applying on a fake Naukri (its questions chat in React).

  .venv/bin/python extension/tests/e2e_naukri.py            # headless
  .venv/bin/python extension/tests/e2e_naukri.py --headed   # watch it

Same setup as e2e.py (Playwright's Chromium, React fetched once into tests/.cache).
"""
import argparse
import json
import re
import sys
import tempfile
import urllib.request
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

from e2e import CACHE, EXT, REACT
from e2e_sites import REACT_TAGS, Check, fake, page, redirect

JOBS = {  # id: (title, company, years, kind)
    "231024500101": ("ML Engineer", "Acme", "1-3", "chat"),
    "231024500102": ("Python Developer", "Beta", "0-2", "direct"),
    "231024500103": ("AI Engineer", "Outside Co", "1-3", "external"),
    "231024500104": ("Data Scientist", "Done Co", "1-2", "applied"),
    "231024500105": ("Backend Engineer", "Old Co", "5-8", "direct"),
    "231024500106": ("Software Engineer", "Hard Co", "1-3", "hard"),
    "231024500107": ("Machine Learning Engineer", "Chip Co", "1-3", "chips"),
    "231024500108": ("Software Developer", "Quota Co", "1-3", "quota"),
    "231024500109": ("Backend Developer", "Late Co", "1-3", "direct"),
}
PAGES = [list(JOBS)[:6], list(JOBS)[6:]]  # page 3 and on repeat page 2, as Naukri does past the end

QUESTIONS = {
    "chat": [
        {"key": "ctc", "kind": "text", "q": "What is your current CTC (in lakhs)?", "number": True},
        {"key": "notice", "kind": "radio", "q": "What is your notice period?",
         "options": ["15 Days or less", "1 Month", "2 Months", "3 Months", "More than 3 Months", "Serving Notice Period"]},
        {"key": "relocate", "kind": "radio", "q": "Are you willing to relocate to Bengaluru?", "options": ["Yes", "No"]},
        {"key": "skills", "kind": "checkbox", "q": "Which of these have you worked with?", "options": ["Python", "PyTorch", "Java"]},
    ],
    "hard": [{"key": "dob", "kind": "text", "q": "What is your date of birth?"}],
    "chips": [{"key": "join", "kind": "chips", "q": "Can you join immediately?", "options": ["Yes", "No"]}],
}

# Naukri's questions chat: a drawer of messages, and under them a text box, options or chips, then Save.
CHAT_JS = r"""
const e = React.createElement;
function Chat({ jobId, questions }) {
  const [log, setLog] = React.useState([
    { bot: true, text: 'Hi Asha, thank you for showing interest.' },
    { bot: true, text: "Kindly answer all the recruiter's questions to successfully apply for the job." },
    { bot: true, text: questions[0].q },
  ]);
  const [i, setI] = React.useState(0);
  const [typing, setTyping] = React.useState(false);
  const [text, setText] = React.useState('');
  const [picked, setPicked] = React.useState([]);
  const [open, setOpen] = React.useState(true);
  const got = React.useRef({});
  const box = React.useRef(null);
  if (!open) return null;
  const q = questions[i];
  function reply(value) {
    const said = [...log, { bot: false, text: value }];
    setText('');
    setPicked([]);
    if (box.current) box.current.textContent = '';
    setLog(said);
    setTyping(true);
    if (q.number && !/^\d+(\.\d+)?$/.test(value)) {
      setTimeout(() => { setLog(l => [...l, { bot: true, text: 'Please enter a valid number' }]); setTyping(false); }, 400);
      return;
    }
    got.current[q.key] = value;
    if (i + 1 < questions.length) {
      setTimeout(() => { setLog(l => [...l, { bot: true, text: questions[i + 1].q }]); setI(i + 1); setTyping(false); }, 500);
    } else {
      fetch('/api/apply/' + jobId, { method: 'POST', body: JSON.stringify(got.current) }).then(() => { setOpen(false); applied(); });
    }
  }
  const close = () => { fetch('/api/close/' + jobId, { method: 'POST' }); setOpen(false); };
  const save = (ready, onSave) => e('div', { className: 'sendMsgbtn_container' },
    e('div', { className: 'send' + (ready ? '' : ' disabled') }, e('div', { className: 'sendMsg', onClick: () => ready && onSave() }, 'Save')));
  const options = (type, cls) => q.options.map((o, k) => e('div', { key: q.key + k, className: cls + '-container' },
    e('input', { type, className: cls, id: q.key + k, name: q.key, value: o, checked: picked.includes(o), style: { display: 'none' },
      onChange: () => setPicked(p => type === 'radio' ? [o] : p.includes(o) ? p.filter(x => x !== o) : [...p, o]) }),
    e('label', { htmlFor: q.key + k }, o)));
  let footer = null;
  if (!typing && q.kind === 'text') {
    footer = e('div', { className: 'chatbot_InputContainer' },
      e('div', { className: 'textArea', contentEditable: true, suppressContentEditableWarning: true, ref: box, onInput: ev => setText(ev.currentTarget.textContent) }),
      save(!!text.trim(), () => reply(text.trim())));
  } else if (!typing && q.kind === 'radio') {
    footer = e('div', { className: 'chatbot_InputContainer' },
      e('div', { className: 'singleselect-radiobutton-container' }, ...options('radio', 'ssrc__radio')), save(picked.length > 0, () => reply(picked[0])));
  } else if (!typing && q.kind === 'checkbox') {
    footer = e('div', { className: 'chatbot_InputContainer' },
      e('div', { className: 'multicheckboxes-container' }, ...options('checkbox', 'mcc__checkbox')), save(picked.length > 0, () => reply(picked.join(', '))));
  } else if (!typing && q.kind === 'chips') {
    footer = e('div', { className: 'chatbot_Chips chipsContainer' }, ...[...q.options, 'Skip this question'].map(o =>
      e('div', { key: o, className: 'chatbot_Chip chipInRow chipItem', onClick: () => reply(o) }, e('span', null, o))));
  }
  return e('div', { className: 'chatbot_Drawer chatbot_right', id: '_k3j9xChatbotContainer' },
    e('div', { className: 'chatbot_Nav' }, e('div', { className: 'chatBot chatBot-ic-cross crossIcon', style: { width: '20px', height: '20px' }, onClick: close })),
    e('div', { className: 'chatbot_DrawerContentWrapper' }, e('ul', null, ...log.map((m, k) =>
      e('li', { key: k, className: 'chatbot_ListItem ' + (m.bot ? 'botItem' : 'userItem') },
        e('div', { className: m.bot ? 'botMsg msg' : 'userMsg msg' }, e('div', null, e('span', null, m.text))))))),
    footer);
}
function applied() {
  document.getElementById('buttons').innerHTML = '<button id="already-applied" disabled>Applied</button>';
  document.getElementById('msg').textContent = 'You have successfully applied to ' + document.querySelector('h1').textContent;
}
"""


class Naukri:
    def __init__(self):
        self.logged_in = False
        self.applied = {"231024500104"}
        self.posted = {}  # job id -> the chat's answers
        self.closed = set()  # chats closed half-answered
        self.searches = []  # (path, query) of each search page opened

    def url(self, jid):
        title, company, years, _ = JOBS[jid]
        lo, hi = years.split("-")
        return f"https://www.naukri.com/job-listings-{re.sub(r'[^a-z0-9]+', '-', f'{title} {company}'.lower())}-bengaluru-{lo}-to-{hi}-years-{jid}"

    def card(self, jid):
        title, company, years, _ = JOBS[jid]
        return (f'<div class="srp-jobtuple-wrapper" data-job-id="{jid}"><div class="cust-job-tuple layout-wrapper lay-2 sjw__tuple">'
                f'<div class="row1"><h2><a class="title " href="{self.url(jid)}?src=jobsearchDesk&sid=17&xp=1&px=1" title="{title}">{title}</a></h2></div>'
                f'<div class="row2"><a class=" comp-name mw-25" href="/x-jobs-careers-1">{company}</a></div>'
                f'<div class="row3"><span class="exp-wrap"><span class="expwdth">{years} Yrs</span></span><span class="loc-wrap"><span class="locWdth">Bengaluru</span></span></div>'
                f'<div class="row4"><span class="job-desc">Python, machine learning</span></div></div></div>')

    def header(self):
        return f"<header>{'<a href=/mnjuser/homepage>My Naukri</a>' if self.logged_in else '<a id=login_Layer>Login</a>'}</header>"

    def job(self, jid):
        title, company, years, kind = JOBS[jid]
        lo, hi = years.split("-")
        if jid in self.applied:
            action = '<button id="already-applied" disabled>Applied</button>'
        elif kind == "external":
            action = '<button id="company-site-button">Apply on company site</button>'
        else:
            action = '<button id="apply-button">Apply</button>'
        on_apply = {
            "direct": f"fetch('/api/apply/{jid}', {{method: 'POST', body: '{{}}'}}).then(applied);",
            "quota": "document.getElementById('msg').textContent = 'Your daily quota has been expired.';",
        }.get(kind, f"ReactDOM.createRoot(document.body.appendChild(document.createElement('div'))).render("
                    f"e(Chat, {{ jobId: '{jid}', questions: {json.dumps(QUESTIONS.get(kind, []))} }}));")
        script = f"""{REACT_TAGS}<script>{CHAT_JS}
          const b = document.getElementById('apply-button');
          if (b) b.addEventListener('click', () => {{ {on_apply} }});</script>"""
        body = (f"{self.header()}<main><section class='styles_job-header-container__x1'>"
                f"<h1 class='styles_jd-header-title__x2'>{title}</h1>"
                f"<div class='styles_jd-header-comp-name__x3'><a href='/x-jobs-careers-1'>{company}</a><span>4.1</span></div>"
                f"<div class='styles_jhc__exp__x4'><span>{lo} - {hi} years</span></div><div>Bengaluru</div>"
                f"<div id='buttons'>{action}</div><span id='msg'></span></section>"
                f"<section class='styles_job-desc-container__x5'><div class='styles_JDC__dang-inner-html__x6'>About the role: Python, ML.</div></section>"
                f"<aside><h2>Similar jobs</h2><a href='{self.url('231024500105')}'>Head of ML, 10 - 15 years</a></aside></main>")
        return page(f"{title} - {company} - {lo} to {hi} years of experience - Bengaluru | Naukri.com", body, script)

    def handle(self, route):
        req = route.request
        parts = urlsplit(req.url)
        path = parts.path
        if path.startswith("/static/"):
            return route.fulfill(path=str(CACHE / path.split("/")[-1]), content_type="text/javascript")
        if path.startswith("/mnjuser/"):
            if not self.logged_in:
                return redirect(route, "https://www.naukri.com/nlogin/login?URL=https://www.naukri.com/mnjuser/homepage")
            return route.fulfill(body=page("Home | Mynaukri", f"{self.header()}<h1>Your profile</h1>"), content_type="text/html")
        if path.startswith("/nlogin/"):
            return route.fulfill(body=page("Login | Naukri.com", "<h1>Login</h1><input id=usernameField><input id=passwordField type=password>"), content_type="text/html")
        if path.startswith("/api/apply/"):
            jid = path.rsplit("/", 1)[1]
            self.applied.add(jid)
            self.posted[jid] = json.loads(req.post_data or "{}")
            return route.fulfill(json={"ok": True})
        if path.startswith("/api/close/"):
            self.closed.add(path.rsplit("/", 1)[1])
            return route.fulfill(json={"ok": True})
        m = re.match(r"^/job-listings-.*-(\d{6,})$", path)
        if m and m.group(1) in JOBS:
            return route.fulfill(body=self.job(m.group(1)), content_type="text/html")
        m = re.match(r"^/([a-z0-9-]+?)-jobs(?:-in-([a-z0-9-]+?))?(?:-(\d+))?$", path)
        if m:
            self.searches.append((path, parse_qs(parts.query)))
            n = int(m.group(3) or 1)
            cards = json.dumps("".join(self.card(j) for j in PAGES[min(n, len(PAGES)) - 1]))
            script = f"<script>setTimeout(() => {{ document.getElementById('list').innerHTML = {cards}; }}, 400);</script>"
            return route.fulfill(body=page("Jobs - Naukri.com", f"{self.header()}<main id='list'></main>", script), content_type="text/html")
        route.fulfill(status=404, body="not found")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    CACHE.mkdir(exist_ok=True)
    for name, url in REACT.items():
        if not (CACHE / name).exists():
            urllib.request.urlretrieve(url, CACHE / name)

    nk = Naukri()
    with sync_playwright() as pw, tempfile.TemporaryDirectory() as profile:
        ctx = pw.chromium.launch_persistent_context(
            profile, channel="chromium", headless=not args.headed,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        ctx.route(re.compile(r"^https://(www\.)?naukri\.com/"), fake(nk.handle))
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        dash = ctx.new_page()
        dash.goto(f"chrome-extension://{worker.url.split('/')[2]}/dashboard.html")
        dash.on("dialog", lambda d: d.accept())
        errors = []
        dash.on("pageerror", lambda e: errors.append(str(e)))
        dash.wait_for_selector("#site-name")
        check = Check(dash)

        dash.evaluate("""async () => {
            const s = await JB.store.getSettings();
            Object.assign(s.profile, { minExperience: 1, maxExperience: 2, answers: [
              ["notice period", "30 days"], ["current.*ctc", "8 LPA"], ["relocat", "Yes"], ["join immediately", "Yes"],
              ["worked with", "Python, PyTorch"], ["date of birth", ""]] });
            Object.assign(s.sites.naukri, { keywords: ["machine learning engineer"], locations: ["bengaluru"], postedWithin: "week", searchUrls: [] });
            Object.assign(s.sites.naukri.limits, { delaySeconds: [0, 0], maxPages: 3 });
            await JB.store.saveSettings(s);
        }""")

        print("\nNaukri on the dashboard")
        names = dash.eval_on_selector_all("#site-list li a", "els => els.map(a => a.childNodes[1].textContent)")
        check(names[-1] == "Naukri", f"sidebar lists Naukri ({names})")

        print("\nNaukri: dry run, logged out")
        check.start("naukri", "dry-run")
        s = check.wait_done("naukri")
        log = "\n".join(s["log"])
        check("Not logged in to Naukri: fine for a dry run." in log, "dry run goes ahead without a login")
        path, q = nk.searches[0]
        check(path == "/machine-learning-engineer-jobs-in-bengaluru" and q == {"k": ["machine learning engineer"], "l": ["bengaluru"], "experience": ["2"], "jobAge": ["7"]},
              f"searches the keyword in the city, with experience and how recent ({path} {q})")
        check([p for p, _ in nk.searches[1:3]] == ["/machine-learning-engineer-jobs-in-bengaluru-2", "/machine-learning-engineer-jobs-in-bengaluru-3"], "later pages are -2, -3")
        check("6 jobs listed, 5 new and matching" in log and "No more jobs for this search." in log,
              "waits for the cards; the 5-8 Yrs job is filtered out; page 3 repeating ends the search")
        would = re.findall(r"~ would apply\s+(.+?)\s{2}", log)
        check(would[:2] == ["ML Engineer @ Acme", "Python Developer @ Beta"] and len(would) == 8, f"reads title and company from each job ({would[:2]}, {len(would)} in all)")
        check(not nk.posted, "dry run applied to nothing")

        print("\nNaukri: apply, logging in when asked")
        check.start("naukri", "apply")
        check.wait_prompt("Log in, then continue")
        nk.logged_in = True
        check.answer("Done, continue")
        s = check.wait_done("naukri")
        log = "\n".join(s["log"])
        check(check.status("naukri", "231024500101") == "applied", f"applied through the questions chat ({check.note('naukri', '231024500101')})")
        check(nk.posted.get("231024500101") == {"ctc": "8", "notice": "1 Month", "relocate": "Yes", "skills": "Python, PyTorch"},
              f"typed, picked and ticked the answers; 30 days picked 1 Month; \"8 LPA\" sent again as 8 when Naukri wanted a number ({nk.posted.get('231024500101')})")
        check(check.status("naukri", "231024500102") == "applied" and nk.posted.get("231024500102") == {}, "applied straight away (no questions)")
        check(check.status("naukri", "231024500103") == "external" and check.note("naukri", "231024500103") == "applies on the company website", "Apply on company site is external")
        check(check.status("naukri", "231024500104") == "already_applied", "already applied")
        check(check.status("naukri", "231024500105") is None, "senior job never opened")
        check(check.status("naukri", "231024500106") == "needs_manual" and check.note("naukri", "231024500106") == "unanswered: What is your date of birth?",
              "a question kept for you is left for you")
        check("231024500106" in nk.closed, "and its chat is closed before the next job")
        check(check.status("naukri", "231024500107") == "applied" and nk.posted.get("231024500107") == {"join": "Yes"}, "answered by clicking a chip")
        check("Naukri says today's applications are used up" in log and check.status("naukri", "231024500108") is None
              and check.status("naukri", "231024500109") is None, "the daily quota stops the run; nothing after it is touched")
        check("Done: applied to 3." in log, "run summary")
        titles = {r["title"]: r["company"] for k, r in check.jobs().items() if k.startswith("naukri:")}
        check(titles.get("ML Engineer") == "Acme", f"history has the title and company ({titles})")

        print("\nNaukri: the next run carries on")
        JOBS["231024500108"] = ("Software Developer", "Quota Co", "1-3", "direct")  # the quota is back
        check.start("naukri", "apply")
        s = check.wait_done("naukri")
        check(check.status("naukri", "231024500108") == "applied" and check.status("naukri", "231024500109") == "applied", "picks up where the quota stopped it")
        check("Done: applied to 2." in "\n".join(s["log"]), "and only those")

        print("\nSettings")
        dash.evaluate("location.hash = '#settings'")
        dash.click("#site-tab-naukri")
        check(dash.locator('[name="sites.naukri.locations"]').is_visible(), "Naukri has places to search")
        dash.fill('[name="sites.naukri.locations"]', "bengaluru\npune")
        dash.select_option('[name="sites.naukri.postedWithin"]', "day")
        dash.click("#save")
        saved = dash.evaluate("async () => (await JB.store.getSettings()).sites.naukri")
        check(saved["locations"] == ["bengaluru", "pune"] and saved["postedWithin"] == "day", f"saved ({saved['locations']}, {saved['postedWithin']})")
        kept = dash.evaluate("""async () => {
            const file = await JB.store.getSettings();
            delete file.sites.naukri; // what export_for_extension.py writes: no Python bot for Naukri
            file.sites.hirist.limits.maxPerRun = 4;
            await chrome.runtime.sendMessage({ type: "import", settings: file, history: [] });
            const s = await JB.store.getSettings();
            return [s.sites.naukri.locations, s.sites.hirist.limits.maxPerRun];
        }""")
        check(kept == [["bengaluru", "pune"], 4], f"bringing over from the Python bots keeps the Naukri settings ({kept})")
        check(not errors, f"no errors on the dashboard page {errors}")
        ctx.close()

    print(f"\n{'All passed.' if not check.failures else f'{check.failures} FAILED.'}")
    sys.exit(1 if check.failures else 0)


if __name__ == "__main__":
    main()
