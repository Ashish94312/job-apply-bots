# Cutshort apply bot

Opens Chrome, goes through Cutshort's logged-in job feed with your filters, and applies from each matching card.

![Cutshort bot dry run](../docs/demo-cutshort.gif)

```bash
cd cutshort
cp config.example.yaml config.yaml                # first time: then edit it
../.venv/bin/python run.py --dry-run             # see what it would apply to
../.venv/bin/python run.py --confirm --assist    # apply, asking before each one
../.venv/bin/python run.py                       # apply
../.venv/bin/python run.py history               # recent results
../.venv/bin/python run.py history --status needs_manual
../.venv/bin/python run.py reset                 # re-check filter-skipped jobs after changing filters
```

**Login:** Cutshort only offers Google or phone OTP, and Google refuses sign-in inside an automated browser
("This browser or app may not be secure"). So when a login is needed, the bot opens a *normal* Chrome window on
its own profile: click "Candidate login", tick "I agree to the Terms", sign in, then press Enter in the terminal.
The bot closes that window and carries on with the saved session (`data/profile/`), so later runs skip this.

**Where jobs come from:** the logged-in feed at `cutshort.io/profile/all-jobs`, one feed per keyword in
`search.keywords`, filtered to your experience range (`minexp` / `maxexp`). Keywords must be Cutshort *skill names*
(e.g. "large language models", "software development", "django"): the bot looks up each skill's id once in the
feed's Skills filter and remembers it in `data/skill_ids.json`. Keywords Cutshort has no skill for are skipped with
a message. The bot pages through each feed (`&page=N`). Any URL in `search_urls` is used as well.

**Applying:** "Apply now" on a card opens a dialog with your resume and a message box. The bot fills the message
from `cover_note` (empty = no message), clicks Send, and counts it as applied when the card switches to
"View conversation". Applied jobs drop out of the feed afterwards.

**Results** are stored in `data/jobs.db`, so no job is applied to twice. `needs_manual` / `failed` jobs get a
screenshot in `data/screenshots/`. Failed jobs are retried next run.

Only one run at a time: two runs can't share the same browser profile.
