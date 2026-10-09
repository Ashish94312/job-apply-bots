# Hirist apply bot

Opens Chrome, goes through the Hirist search pages in `config.yaml`, and applies to jobs that match your filters.

![Hirist bot dry run](../docs/demo-hirist.gif)

```bash
cd hirist
cp config.example.yaml config.yaml                # first time: then edit it
../.venv/bin/python run.py --dry-run             # see what it would apply to
../.venv/bin/python run.py --confirm --assist    # apply, asking before each one
../.venv/bin/python run.py                       # apply
../.venv/bin/python run.py history               # recent results
../.venv/bin/python run.py history --status needs_manual
../.venv/bin/python run.py reset                 # re-check filter-skipped jobs after changing filters
```

**Login:** Hirist offers OTP, password, Google or Apple. Google refuses sign-in inside an automated browser, so
when a login is needed the bot opens a *normal* Chrome window on its own profile: click "Login", sign in any way,
then press Enter in the terminal. The bot carries on with the saved session (`data/profile/`); later runs skip this.

**Where jobs come from:** one search per keyword in `search.keywords`, with your experience range in the URL:
`https://www.hirist.tech/search/<keyword>?minexp=1&maxexp=2`, 20 jobs per page; the bot pages through
them (`&page=N`, up to `max_pages`). Each card shows "X - Y yrs", so out-of-range jobs are skipped unopened.

**Results** are stored in `data/jobs.db`, so no job is applied to twice. `needs_manual` / `failed` jobs get a
screenshot in `data/screenshots/`. Failed jobs are retried next run.

Only one run at a time: two runs can't share the same browser profile.
