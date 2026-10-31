# Sendoff

Sends your job applications off for you. It's the bots in this repo as a Chrome extension: no Python, no terminal. It runs in your own Chrome, with your own logins, and
keeps everything (settings, history) in that Chrome. It applies on **Hirist**, **Instahyre**, **Wellfound**,
**Cutshort**, **LinkedIn** (Easy Apply) and **Naukri**, and on LinkedIn it can also **ask for referrals**. Naukri is in
the extension only: there's no Python bot for it. So is applying on **company sites**: a company's own application form
when it's on Greenhouse, Lever or Ashby.

On each site it does what the Python bot does: searches with your keywords and experience range, skips jobs that don't
fit your filters, answers the screening questions it has answers for, applies, and never applies to the same job
twice. When it needs you (a login, a check, a question it can't answer) it asks on its dashboard.

## Install

The extension isn't on the Chrome Web Store yet, so you load it from this folder:

1. Get this repo (`git clone`, or download it as a ZIP and unzip it).
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder.
4. The dashboard opens. Later, click the extension's icon (pin it from the puzzle-piece menu) to open it again.

To update: get the new code, then click the reload arrow on the extension's card in `chrome://extensions`.
Your settings and history stay.

## First run

1. **Settings** (on the dashboard): first **Where you are**: your country and city, the currency and your current
   and expected salary, your notice period and whether you'd relocate. Saving puts these in your answers to screening
   questions (salary "8 LPA" in India, "65000 EUR a year" elsewhere; LinkedIn's number boxes get the plain amount),
   along with "Are you based in <your city or country>?" and the phone's country code, and makes LinkedIn and
   Wellfound search your country instead of the sample India. Until you do, those answers are empty, so the jobs
   asking them are left for you. Changing one there again changes those answers again; an answer you edit yourself
   stays until then. Then check the other answers, the search keywords, which titles to apply to, and how many
   applications per run and per day. Save.
   - **Coming from the Python bots?** Bring your settings and history over instead: in the repo folder run
     `.venv/bin/python tools/export_for_extension.py`, then on the dashboard pick the `extension-import.json`
     it writes (Settings > Bring over from the Python bots). The history makes the extension skip the jobs the
     Python bot already handled. Delete the file afterwards: it has your answers in it.
2. **Log in** to each site once: pick the site in the sidebar, click **Log in** and sign in in the window that
   opens (any way the site offers works, Google included: it's your normal Chrome). Chrome remembers it. No
   passwords are stored by the extension.
3. **Dry run** lists what it would apply to, without applying. Then **Apply**. Each site runs on its own, so you
   can run several at once, each in its own window.

**Any kind of work.** The sample filters are for software and AI jobs. For another field, in **Settings > Which jobs**
pick it under **Start from a field** (design, product, marketing, sales, finance, HR, healthcare, teaching and more)
and **Use it**: its roles become the "...and is a role like" list, and they come out of "Skip titles with" (so
"manager" stops skipping product managers). Then set each site's search keywords for that work.

Per site, in Settings > Sites: the search keywords (Hirist: any words; Instahyre: skills, searched once per year
of your experience range; Wellfound: role names, plus the places to search, like `germany` or `remote`; Cutshort:
skill names, each looked up once in Cutshort's Skills filter and remembered; Naukri: what you'd type in its search,
plus the cities to search, empty for anywhere) and how many applications per run and per day. Cutshort applies from its
logged-in feed, so it needs you logged in even for a dry run.

Naukri searches jobs open to the top of your experience range, posted within the time you pick in its tab (a week to
start with). A job's questions come in a chat, one at a time, answered from the shared answers: a text box gets the
answer typed in (sent again as a plain number if Naukri asks for one, "8 LPA" becoming 8), and for options the answer
has to be one of them, or how one starts. For a length of time, like the notice period, it picks the option covering
your answer: "30 days" picks "1 Month", "15 days" picks "15 Days or less", "120 days" picks "More than 3 Months"; if
none fits ("45 days" between "1 Month" and "2 Months") or two fit as well, it doesn't guess. A question it has no
answer for is left for you. "Apply on company site" jobs are recorded as **Other site**, and it stops for the
day when Naukri says your daily quota is used up. Bringing settings over from the Python bots leaves the Naukri ones as
they are.

LinkedIn has more in its tab: its own search filters (experience level, on-site/remote/hybrid, how recent),
years of experience per skill (for "How many years of experience do you have with X?"), whether to follow the
company, and **its own answers**, used instead of the shared ones (some of its questions are number boxes, so
salaries are plain amounts, 800000 rather than 8 LPA, and the phone goes without its country code, which is a
dropdown of its own). It stops for the day when LinkedIn says you've
hit its Easy Apply limit, and never sends an answer it didn't choose itself.

**Asking for referrals (LinkedIn):** on LinkedIn's page, **Preview** shows who it would ask and the messages,
**Ask for referrals** sends them. For jobs it applied to recently it finds people at the company among your 1st and
2nd-degree connections (alumni of your college first): people you're connected with get your message; the others
get an invite with a short note, and the message on a later run once they accept. A few people per company, a
daily cap, and nobody is asked twice. Write the message in Settings > Sites > LinkedIn first: until its `<…>` part
is in your own words it won't send. These go to real people in your name, so tick *Ask me before each* the first
times. History lists everyone asked. Which jobs to take, your answers and the cover note are shared by all sites.

While it runs, the bot works in its own Chrome window: leave that window open (you can use other windows
meanwhile). It closes the window when it's done. **Stop** stops it after the current step.

Options on the card: *Ask me before each application*, *When it's stuck, ask me* (below), and a per-run cap.

**Questions it has no answer for are asked once.** With *When it's stuck, ask me* on, a form question none of your
answers covers shows up on the dashboard with a box to answer in (or the form's own options to pick from). Answer it
and the bot fills it in and carries on; the answer is kept for that question and used whenever it comes up again, on
any site, before the patterns in Settings. You can also say you'll do that job in Chrome yourself, or skip it.
With the option off, the job is left for you and its questions wait in **Settings > Your answers**: answer them there
and the jobs that only needed those go again on the next run. Your answers are listed there too, to change or forget.
If you choose to do a job in Chrome yourself, it notices what you enter there for the questions it didn't know and,
when you continue, offers to keep those answers too.

**Jobs in other countries.** Living in India and applying in the US or the UK, say, list those countries in
**Settings > Where you are > Where you can work**: for each, whether you're a citizen, allowed to work there or would
need a visa, and the salary you'd ask for there (in its currency). Then, for each job, it works out the job's
country: India's job sites are in India; elsewhere from the location on the job page ("London, England, United
Kingdom", "San Francisco, CA", "Remote - US"), or the place it was searched in (LinkedIn's and Wellfound's places).
Questions about a work permit, sponsorship or a visa are answered for that country ("Will you require sponsorship?"
is Yes for a US job, No for an Indian one), and so are questions naming a country ("Are you a U.S. citizen?"),
before any other answer. The expected salary is the one you gave for there; it never sends your Indian one abroad.
When the job's country isn't clear, those questions are left for you rather than guessed. Jobs in a country that
isn't in the list are skipped, and so are jobs where you'd need a visa that say they won't sponsor one ("unable to
sponsor", "U.S. citizens only", "must have the right to work in the UK"). With the list empty, nothing changes.

**What most forms ask the same way.** After all your own answers come a few standard ones. US forms' voluntary
gender, race and ethnicity, veteran and disability questions are declined, with whichever option the form uses for
that ("Decline To Self Identify", "I don't wish to answer", "Prefer not to say"); to answer them yourself, choose
*Leave them for me* in Settings > Your profile. A box consenting to the company handling your application's data
(an applicant privacy notice, GDPR) is ticked; one about its talent pool, future roles or marketing is not. "When can
you start?" gets your notice period from Where you are, and a box that wants a date gets the date that makes
("30 days" on 31 October: 2026-11-30, or 11/30/2026 if its placeholder reads MM/DD/YYYY).

**Forms in other languages.** A question in any language or script is kept and matched like an English one, and
options are matched ignoring accents ("Si" picks "Sí"). The experience a job asks for ("3 bis 5 Jahre", "3 à 5 ans",
"3〜5年") and lengths of time in options ("3 Monate", "moins de 15 jours", "De 1 a 3 meses") are read in English,
German, French, Spanish, Portuguese, Italian, Dutch and Polish, and experience in Swedish, Russian, Japanese and
Korean too.

**Applications: what happened after applying.** Every job it applied to is on the Applications page by itself.
When a company replies, click **They replied** and say how (email, call, a message on the site, LinkedIn, a
referral) and who. Add its rounds in one click from a **template** (Startup, Product company, Service company, or
your own in Settings > Applications), then change what's different: rename, reorder, add or remove rounds, set
when each is (a due date for an assignment), and mark it Given or Submitted, Cleared or Not cleared, Missed or
Not done. **Up next** lists the rounds and due dates coming up (a booked round downloads as a calendar file), and
the figures show how many replied, had a round and got an offer, by site and with or without a referral. Ones with
no reply in 21 days are marked gone quiet and close as ghosted in one go. Jobs you applied to elsewhere go in with
**Add an application**; a job it left for you that you finished yourself, with **I applied myself** in History.

**Company sites (Greenhouse, Lever, Ashby, Workday).** Many jobs apply on the company's own form instead of the job
site's. When that form is on Greenhouse, Lever, Ashby or Workday, **Company sites** in the sidebar applies there: to the job links you
list in its Settings tab, and to the jobs the other sites found that lead to one of these (they're in History as
Other site). First fill in **Settings > Your profile** (name, email, phone, links) and **Where you are** (city,
country), and add your resume: they go in
the standard boxes, and the resume is uploaded. The company's own questions are answered from your answers like on
any site, and the ones nothing answers are asked once (*When it's stuck, ask me*). Questions a form doesn't require
are left alone unless you have an answer. By default it shows you each filled-in form with a **Send it** button; a
captcha or a code the company emails you is left for you to do in the bot's window. Each job is applied to once.
On Workday each company has its own account. Save a sign-in in **Settings > Your profile** (an email and a password,
best one used only for these) and the bot signs in by itself, or makes the account when a company has none yet; without
one, or when that doesn't work (some companies want you to confirm your email first), it asks you to sign in in its
window. Then it goes page by page (My Information, My Experience, its questions) up to Review. Anything Workday still
wants on a page that the bot can't fill, like a date, you do there and press Save and Continue. The sign-in is kept
only in this Chrome, apart from the settings: never in a backup, and not shown again once saved.

**Other companies' forms.** Tick *Other companies' forms too* in Company sites' Settings tab and it also applies on
Workable, SmartRecruiters, Recruitee, Teamtailor, BambooHR, JazzHR, Breezy, Jobvite, Keka and Zoho Recruit, and on any
company's own one-page form: your links, and the jobs LinkedIn, Naukri and the others found that lead there. Chrome
asks once to let Sendoff onto all sites for this (the same access screenshots use). On the job's page it presses
**Apply** if the form isn't there yet, fills it in the same way, and always shows it to you with **Send it** first,
even with *Send it straight away* chosen: it's a form it hasn't seen the like of. A site that wants you to sign in or
make an account first (iCIMS, SuccessFactors, Taleo, Oracle, Darwinbox, or a careers site asking for a password) is
left for you.

**Replies, read from the sites.** LinkedIn and Naukri list the jobs you applied to with what happened to each. After
each run there (you can turn it off in their Settings tab), and whenever you click **Check for replies** on
Applications, the bot reads those lists into Applications: "Application viewed" marks it Viewed, a recruiter getting in
touch (shortlisted, an interview, "Recruiter Action") marks it Heard back, and "No longer being considered" or "Not
shortlisted" closes it as Rejected. Each says so on its timeline, and nothing it says overrides what you've noted.

## What it keeps, and permissions

Everything stays in your Chrome (`chrome.storage`): settings, the history of every job it looked at, what you
note about your applications, and screenshots if you turn them on. Nothing is sent anywhere. **Download backup** saves it all to a file.

Chrome asks for:

- **Read and change your data on hirist.tech, instahyre.com, wellfound.com, cutshort.io, linkedin.com and naukri.com**: to
  search, read jobs, fill in applications and (on LinkedIn) send the referral messages you set up. And on
  greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, myworkdayjobs.com and myworkdaysite.com: to fill in and send a
  company's own application form.
- **Read your browsing history** (Chrome's wording for the `tabs` permission): to see the bot window's address,
  e.g. to notice an apply button that leads to another site.
- **Screenshots** are off by default. Turning them on (Settings > Screenshots) asks for access to all sites,
  because that's what Chrome requires for taking a screenshot; the bot still only goes to the job sites.
- **Other companies' forms** (Company sites) ask for the same access to all sites, to fill in a form on whatever site
  a company uses. It goes only to the job links you list and the ones the job sites led to.

## How it differs from the Python bot

- No separate login window and no passwords in a file: it uses your Chrome's logins.
- A dry run works without logging in.
- An apply button that opens the company's own site is recorded as **External site** with that link (Chrome
  doesn't let an extension open new tabs on a site's behalf, so it doesn't follow it).
- It only stops to ask about a page that isn't ready when there's a check or captcha on it; an empty search page
  just moves on.

## Please use it responsibly

Automating applications may go against a site's terms and can get an account restricted. Keep the caps low,
the filters tight, and only apply to jobs you'd take. Recruiters read these applications.

LinkedIn is the strictest about automation, and the account that matters most: its limits here are lower by
default (25 a day, 30 to 60 seconds apart), and the [Python bot's notes on it](../linkedin/README.md#be-careful-with-your-linkedin-account)
apply just the same. Referral messages go to real people in your name; preview them, and keep *Ask me before
each* on until you trust the wording.

## Publishing

The first version goes up by hand: [store/LISTING.md](../store/LISTING.md) has everything the Chrome Web Store
asks for, ready to paste, and the images are in `store/`. After that, each update is one command:

```bash
.venv/bin/python tools/publish_extension.py            # raise the version, build, upload, submit for review
.venv/bin/python tools/publish_extension.py --status   # where the review is
```

Google still reviews every update; it goes live by itself once that passes. The script needs access to your
Chrome Web Store account, set up once:

1. In the [Google Cloud console](https://console.cloud.google.com/), make a project, then under *APIs & Services*
   turn on the **Chrome Web Store API**.
2. *OAuth consent screen*: user type External, any app name (e.g. "Sendoff publisher"), your email as a test
   user. Then **Publish app** (to "In production"): while it's "Testing", Google's tokens expire after 7 days.
   Google may call it unverified; that's fine for your own account.
3. *Credentials*: create an **OAuth client ID** of type **Desktop app**, and put its ID and secret in `.env` as
   `CWS_CLIENT_ID` and `CWS_CLIENT_SECRET`.
4. In the Developer Dashboard, copy the **Publisher ID** (*Publisher > Settings*) into `.env` as
   `CWS_PUBLISHER_ID`, and the extension's 32-letter **item ID** (in its dashboard address) as `CWS_EXTENSION_ID`.
5. Run `.venv/bin/python tools/publish_extension.py --setup` and sign in with the account that owns the extension;
   it saves `CWS_REFRESH_TOKEN` in `.env`.

`.env` never goes into git. If you change the extension's visibility in the dashboard, publish that change by
hand once; the script can publish again after that.

## For developers

Plain JavaScript, Manifest V3, no build step.

| File | What it is |
|---|---|
| `background.js` | Service worker: takes the dashboard's requests, runs the engine |
| `engine.js` | The run loop (from `run.py`): drives a bot window, records results, asks you questions |
| `referral.js` | Asking for referrals on LinkedIn (from `linkedin/referral.py`) |
| `lib/page.js` | Runs inside job pages: finds buttons, reads forms, fills them (from `core.py`) |
| `lib/filters.js`, `lib/answers.js` | Which jobs to apply to, answers to questions (from `core.py`) |
| `lib/store.js` | Settings, history, applications and the answers you gave, in `chrome.storage.local` |
| `lib/places.js` | Where you are: the countries (calling code, currency), and the answers it fills in from them |
| `lib/tracker.js` | Applications: where each one stands, what's next, the figures, round templates |
| `lib/defaults.js` | Default settings, generated from the bots' `config.example.yaml` |
| `sites/<site>.js` | Everything specific to one site (from `<site>/portal.py`; Naukri's is the extension's own): its search pages, how to read a job, its quirks |
| `dashboard.*` | The dashboard page |
| `fonts/` | Archivo, the dashboard's typeface (SIL Open Font License, `fonts/OFL.txt`) |

A run's state (log, the question it's waiting on) lives in `chrome.storage.session` as `run:<site>`, which the
dashboard watches. A new site is a `sites/<name>.js` like the others (`paged` for sites with page 2, 3...;
otherwise results are scrolled; optional `page` hooks such as `collectLinks`, `isApplied`, `cannotApply` and
`dismissExtras`; `flow: "feed"` for a site that applies from cards in a feed, like Cutshort; its own `apply`
for a multi-step dialog, like LinkedIn's Easy Apply), plus its hosts in `manifest.json`, `importScripts` in `background.js`, a `<script>` in
`dashboard.html`, an entry in the dashboard's `SITES`, and the site in `tools/export_for_extension.py` (`SITES`, or
`EXTENSION_ONLY` with its defaults for a site with no Python bot, like Naukri).

Tests:

```bash
node --test extension/tests/                     # filters and answers, checked against the Python bots
.venv/bin/python extension/tests/make_cases.py   # after changing core.py's filters: refresh those cases
.venv/bin/python extension/tests/e2e.py          # the extension in Chromium, applying on a fake Hirist
.venv/bin/python extension/tests/e2e_sites.py    # ...and on fake Instahyre, Wellfound and Cutshort
.venv/bin/python extension/tests/e2e_linkedin.py # ...and LinkedIn: Easy Apply and referrals
.venv/bin/python extension/tests/e2e_naukri.py   # ...and Naukri: its questions chat and daily quota
.venv/bin/python extension/tests/e2e_tracker.py  # the Applications page: replies, rounds, templates
.venv/bin/python extension/tests/e2e_answers.py  # questions it asks you once, and the answers it keeps
.venv/bin/python extension/tests/e2e_company.py  # company sites: Greenhouse, Lever and Ashby forms
.venv/bin/python extension/tests/e2e_workday.py  # company sites: Workday, page by page, signing in
.venv/bin/python extension/tests/e2e_replies.py  # replies read from LinkedIn's and Naukri's lists of your applications
.venv/bin/python extension/tests/e2e_forms.py    # other companies' forms: behind an Apply button, a job abroad, sign-in
.venv/bin/python tools/export_for_extension.py --defaults   # after changing a config.example.yaml
```

The end-to-end test needs Playwright's Chromium (`.venv/bin/playwright install chromium`): branded Chrome no
longer loads unpacked extensions from the command line.
