# Sendoff

Sends your job applications off for you. It's the bots in this repo as a Chrome extension: no Python, no terminal. It runs in your own Chrome, with your own logins, and
keeps everything (settings, history) in that Chrome. **Hirist**, **Instahyre**, **Wellfound** and **Cutshort**
work so far; LinkedIn is still the Python bot in this repo.

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

1. **Settings** (on the dashboard): check your answers to screening questions. They start as sample values
   (salary, notice period; phone and college empty, so jobs asking for them are left for you). Then the search
   keywords, which titles to apply to, and how many applications per run and per day. Save.
   - **Coming from the Python bots?** Bring your settings and history over instead: in the repo folder run
     `.venv/bin/python tools/export_for_extension.py`, then on the dashboard pick the `extension-import.json`
     it writes (Settings > Bring over from the Python bots). The history makes the extension skip the jobs the
     Python bot already handled. Delete the file afterwards: it has your answers in it.
2. **Log in** to each site once: pick the site in the sidebar, click **Log in** and sign in in the window that
   opens (any way the site offers works, Google included: it's your normal Chrome). Chrome remembers it. No
   passwords are stored by the extension.
3. **Dry run** lists what it would apply to, without applying. Then **Apply**. Each site runs on its own, so you
   can run several at once, each in its own window.

Per site, in Settings > Sites: the search keywords (Hirist: any words; Instahyre: skills, searched once per year
of your experience range; Wellfound: role names, plus the places to search, like `india` or `remote`; Cutshort:
skill names, each looked up once in Cutshort's Skills filter and remembered) and how many applications per run
and per day. Cutshort applies from its logged-in feed, so it needs you logged in even for a dry run. Which jobs to take, your answers and the cover note are shared by all sites.

While it runs, the bot works in its own Chrome window: leave that window open (you can use other windows
meanwhile). It closes the window when it's done. **Stop** stops it after the current step.

Options on the card: *Ask me before each application*, *Pause on questions it can't answer* (you fill them
in in the bot's window, then click Continue), and a per-run cap.

## What it keeps, and permissions

Everything stays in your Chrome (`chrome.storage`): settings, the history of every job it looked at, and
screenshots if you turn them on. Nothing is sent anywhere. **Download backup** saves it all to a file.

Chrome asks for:

- **Read and change your data on hirist.tech, instahyre.com, wellfound.com and cutshort.io**: to search, read
  jobs and fill in applications there.
- **Read your browsing history** (Chrome's wording for the `tabs` permission): to see the bot window's address,
  e.g. to notice an apply button that leads to another site.
- **Screenshots** are off by default. Turning them on (Settings > Screenshots) asks for access to all sites,
  because that's what Chrome requires for taking a screenshot; the bot still only goes to the job sites.

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

## For developers

Plain JavaScript, Manifest V3, no build step.

| File | What it is |
|---|---|
| `background.js` | Service worker: takes the dashboard's requests, runs the engine |
| `engine.js` | The run loop (from `run.py`): drives a bot window, records results, asks you questions |
| `lib/page.js` | Runs inside job pages: finds buttons, reads forms, fills them (from `core.py`) |
| `lib/filters.js`, `lib/answers.js` | Which jobs to apply to, answers to questions (from `core.py`) |
| `lib/store.js` | Settings and history in `chrome.storage.local` |
| `lib/defaults.js` | Default settings, generated from the bots' `config.example.yaml` |
| `sites/<site>.js` | Everything specific to one site (from `<site>/portal.py`): its search pages, how to read a job, its quirks |
| `dashboard.*` | The dashboard page |
| `fonts/` | Archivo, the dashboard's typeface (SIL Open Font License, `fonts/OFL.txt`) |

A run's state (log, the question it's waiting on) lives in `chrome.storage.session` as `run:<site>`, which the
dashboard watches. A new site is a `sites/<name>.js` like the others (`paged` for sites with page 2, 3...;
otherwise results are scrolled; optional `page` hooks such as `collectLinks`, `isApplied`, `cannotApply` and
`dismissExtras`; `flow: "feed"` for a site that applies from cards in a feed, like Cutshort), plus its hosts in `manifest.json`, `importScripts` in `background.js`, a `<script>` in
`dashboard.html`, an entry in the dashboard's `SITES`, and the site in `tools/export_for_extension.py`.

Tests:

```bash
node --test extension/tests/                     # filters and answers, checked against the Python bots
.venv/bin/python extension/tests/make_cases.py   # after changing core.py's filters: refresh those cases
.venv/bin/python extension/tests/e2e.py          # the extension in Chromium, applying on a fake Hirist
.venv/bin/python extension/tests/e2e_sites.py    # ...and on fake Instahyre, Wellfound and Cutshort
.venv/bin/python tools/export_for_extension.py --defaults   # after changing a config.example.yaml
```

The end-to-end test needs Playwright's Chromium (`.venv/bin/playwright install chromium`): branded Chrome no
longer loads unpacked extensions from the command line.
