# LinkedIn apply + referral bot

Two jobs in one bot:

1. **Apply:** searches LinkedIn jobs for your keywords and applies to the matching ones through **Easy Apply**.
2. **Ask for referrals:** for the jobs it applied to, finds people at that company in your network and asks
   them for a referral: a message if you're already connected, otherwise a connection invite, then the message
   once they accept.

```bash
cd linkedin
cp config.example.yaml config.yaml               # first time: then edit it
../.venv/bin/python run.py login                 # first time: sign in once in the Chrome window it opens
../.venv/bin/python run.py --dry-run             # see what it would apply to
../.venv/bin/python run.py --confirm --assist    # apply, asking before each one
../.venv/bin/python run.py                       # apply
../.venv/bin/python run.py refer --dry-run       # who it would ask for a referral, and the exact message
../.venv/bin/python run.py refer --confirm       # ask, checking each message with you first
../.venv/bin/python run.py refer                 # ask
../.venv/bin/python run.py history               # applications
../.venv/bin/python run.py referrals             # who it has asked, and whether they've accepted
```

On the dashboard, the LinkedIn card has an **Ask for referrals** button next to Dry run and Log in, and a
**Referral message** section where you edit the invite note and the message (Save writes them to `config.yaml`).
With "Ask me before each application" ticked under Options, each message shows up there with Send / Skip buttons.
A **Referrals** table under History lists who was asked and where each stands (invite sent, asked, didn't accept).

**Login:** by hand, once, in a normal Chrome window the bot opens (LinkedIn often asks for a security check on a
new login, and Google sign-in refuses automated browsers). The session is kept in `data/profile/`.

## Applying

**Where jobs come from:** one search per keyword in `search.keywords` and place in `search.locations`, newest
first, 25 jobs a page. The search itself is narrowed to Easy Apply jobs (`easy_apply_only`), your
`experience_levels` (entry level, associate, ...), `work_types` and `posted_within`. Then the same title,
company and experience filters as the other bots. Experience is read from the description ("2+ years of
experience", "3-5 years"), taking the smallest number it mentions.

**The Easy Apply dialog:** contact info and resume are already filled from your LinkedIn profile (keep a resume
uploaded there). The company's questions are answered from `config.yaml`:

- `answers`: regex → answer, as in the other bots. Dropdowns and Yes/No buttons pick the option matching your
  answer. Some questions are number boxes, so write salaries as plain rupee amounts (`900000`, not `9 LPA`).
- `skill_years`: LinkedIn often asks "How many years of work experience do you have with *X*?". The bot looks
  up *X* there; skills not listed get `other_skill_years` (0 is the honest answer; leave it empty to answer
  those yourself).
- `cover_note`: for cover letter / message boxes. Empty leaves optional ones blank.

A required question it has no answer for, or an answer LinkedIn rejects ("Enter a whole number"), leaves the job
`needs_manual` with a screenshot, and the dialog says which question. It unticks "Follow *company*" unless
`follow_companies: true`. Jobs that apply on the company's website are recorded as `external`. If LinkedIn says
you've hit its daily Easy Apply limit, the run stops.

## Asking for referrals

`run.py refer` goes through the jobs it applied to in the last `within_days` days (`for_jobs`: `applied`,
`external` or both; external ones are where a referral matters most), plus any LinkedIn job links you put in
`referral.jobs` (e.g. jobs you applied to on another site). For each company:

1. It opens the company's LinkedIn page and searches its current employees among your **1st and 2nd-degree
   connections**: first alumni of your `school`, then each of `people_keywords` (software engineer, ...).
   People whose headline has a `skip_headline` word (intern, student) are left out.
2. People you're **connected** with come first: they get `message` right away.
3. Others get a **connection invite** with `connect_note`. LinkedIn gives free accounts only a few notes a
   month (up to 300 characters each); once they run out, invites go without a note.
4. On later runs it checks your newest connections, and everyone who accepted gets `message`. Invites not
   accepted in `invite_expiry_days` are given up on.

At most `per_company` people per company, `max_per_day` messages + invites a day, and nobody is contacted twice.
Before sending anything it opens their profile and checks that it mentions the company.

**Messages:** `{first_name}`, `{name}`, `{company}`, `{title}` and `{job_url}` are filled in. Write the
`<one or two lines about you>` part of `message` before the first run; the bot refuses to send while it's still
there. Run `refer --dry-run` to read exactly what each person would get.

## Be careful with your LinkedIn account

LinkedIn's terms forbid automation, and it restricts accounts it catches, sometimes for good. This is the account
recruiters look at, so:

- keep the limits low (the defaults: 25 applications and 15 messages + invites a day);
- use `--confirm` for referrals, at least at first: these go to real people, in your name;
- don't run it headless, and don't run several LinkedIn bots or browser extensions alongside it;
- if LinkedIn shows a warning or a security check, stop for a few days.

**Results** are stored in `data/jobs.db` (applications, and the people asked in a `contacts` table). Only one
run at a time.
