# Wellfound apply bot

Opens Chrome, logs in to Wellfound (formerly AngelList Talent), goes through the role pages for your roles and
locations, and applies to startup jobs that match your filters.

```bash
cd wellfound
cp config.example.yaml config.yaml                # first time: then edit it
../.venv/bin/python run.py --dry-run             # see what it would apply to
../.venv/bin/python run.py --confirm --assist    # apply, asking before each one
../.venv/bin/python run.py                       # apply
../.venv/bin/python run.py history               # recent results
../.venv/bin/python run.py history --status needs_manual
../.venv/bin/python run.py reset                 # re-check filter-skipped jobs after changing filters
```

**Login:** with `WELLFOUND_EMAIL` / `WELLFOUND_PASSWORD` from the `.env` file in the repo root. If that fails (or you
sign in with Google), the bot opens a normal Chrome window for you to log in once. The session is kept in `data/profile/`.

**Where jobs come from:** one role page per role in `search.keywords` and place in `search.locations`:
`wellfound.com/role/l/<role>/<place>`, or `/role/r/<role>` for remote; 25-30 jobs a page, paged with `?page=N`.
Keywords must be Wellfound role names (machine learning engineer, ai engineer, data scientist, software engineer,
backend engineer, full stack engineer, python developer, ...). Roles Wellfound doesn't have redirect to *all* jobs
in a place, so the bot skips those searches instead of applying to random roles.

**Experience:** each listing shows "N years of exp", so jobs asking for more than `max_experience_required` are
skipped without opening them.

**Applying:** "Apply Now" opens a dialog. Many only ask "What interests you about working for this company?"
(optional; filled from `cover_note`, empty = no note). Some companies add required questions (phone, LinkedIn,
college, notice period, salary, work-from-office): they're answered from `answers` in `config.yaml`, picking the
matching option in dropdowns; anything unanswered leaves the job as `needs_manual` with a screenshot. Jobs whose
company "is not accepting applications from your current location" are skipped.

**Tip:** keep your Wellfound profile complete (location, experience, phone, LinkedIn). The dialog checks your
application against it, and recruiters see it.

**Results** are stored in `data/jobs.db`, so no job is applied to twice. Only one run at a time.
