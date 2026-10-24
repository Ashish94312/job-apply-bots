# Publishing Sendoff on the Chrome Web Store

Everything to fill in, in the order the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) asks
for it. Copy each block into the field it's under.

**Once, before the first upload:** sign in to the dashboard with your Google account, pay the one-time
registration fee, and fill in your publisher name and contact email (and verify the email).

---

## 1. Package

Build it, then **Add new item** and upload the ZIP:

```bash
.venv/bin/python tools/package_extension.py     # writes dist/sendoff-1.0.0.zip
```

The name (Sendoff), the summary and the icon come from the package itself.

---

## 2. Store listing tab

**Description**

```text
Sendoff applies to jobs for you on Hirist, Instahyre, Wellfound, Cutshort and LinkedIn, the way you would yourself, in your own Chrome.

Tell it what you're looking for and how to answer the usual screening questions. Click Apply, and Sendoff opens the job site in its own window, goes through the search results, skips the jobs that don't fit, and applies to the ones that do. When it needs you, for a login, a check or a question it has no answer for, it asks on its dashboard and waits. It never guesses an answer.

WHAT IT DOES
• Searches each site with your keywords and experience range.
• Skips jobs by title, seniority, company, or the experience they ask for.
• Fills in screening questions from your answers: notice period, salary, city, yes/no questions and more.
• LinkedIn Easy Apply, step by step, including years of experience per skill.
• Never applies to the same job twice, with a daily limit and a pause between applications.
• Dry run: see what it would apply to before it applies to anything.
• Ask for referrals on LinkedIn: it finds people at the companies you applied to among your connections and writes your message for each one. You see who it goes to and the exact text before anything is sent, unless you choose to send without asking.

THE DASHBOARD
• Watch each job on the current page of results fill in as it's handled.
• An activity list in plain words, a history of every job, and the ones that need you.
• Settings for every site in one place, and a backup to a file.

PRIVATE BY DESIGN
Your settings, answers and history stay in your Chrome. Sendoff has no server and no account, and sends nothing to its developer. It uses the logins you already have on the job sites.

PLEASE USE IT RESPONSIBLY
Automating applications may go against a site's terms. Keep the limits low and apply only to jobs you'd take.

Sendoff is an independent tool. It is not affiliated with or endorsed by Hirist, Instahyre, Wellfound, Cutshort or LinkedIn.
```

**Category:** Productivity → Workflow & Planning
**Language:** English

**Graphic assets** (all in this `store/` folder):

| Field | File |
|---|---|
| Store icon (128×128) | `icon-128.png` |
| Screenshots (1280×800), in this order | `screenshot-1-overview.png`, `screenshot-2-asks-you.png`, `screenshot-3-history.png`, `screenshot-4-settings.png`, `screenshot-5-referrals.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560), optional | `promo-marquee-1400x560.png` |
| Global promo video, optional | a YouTube link: upload `video/sendoff-promo-4k.mp4` to YouTube (Unlisted is enough; 4K keeps it sharp there) and paste its address |

`.venv/bin/python store/make_assets.py` makes them again after the dashboard changes, and
`.venv/bin/python store/make_promo_video.py` the video (32 seconds in 4K, no sound: add music in YouTube Studio if you like).

**Additional fields**

- Homepage URL: `https://github.com/Ashish94312/job-apply-bots/tree/chrome-extension/extension`
- Support URL: `https://github.com/Ashish94312/job-apply-bots/issues`
- Mature content: No

---

## 3. Privacy tab

**Single purpose description**

```text
Sendoff applies to jobs for the user on the job sites they choose (Hirist, Instahyre, Wellfound, Cutshort and LinkedIn), using their own search settings and answers to screening questions, and helps them ask their LinkedIn connections at those companies for a referral.
```

**Permission justifications**

storage
```text
Keeps the user's settings, their answers to screening questions and the history of jobs handled, in the browser.
```

unlimitedStorage
```text
The history of jobs handled, and the screenshots the user can turn on, can grow past the default storage quota.
```

scripting
```text
Reads job listings and fills in application forms on the job sites the user chose, in the window the extension opens for that.
```

tabs
```text
Opens the window the extension works in, waits for its pages to load, and reads their address, for example to notice that an apply button leads to the company's own website.
```

Host permissions
```text
Each listed site is a job board the extension searches and applies on for the user: hirist.tech, instahyre.com, wellfound.com, cutshort.io and linkedin.com. On LinkedIn it also sends the referral messages the user sets up and confirms. No other sites are accessed. Access to all sites is optional and only requested if the user turns on screenshots, because chrome.tabs.captureVisibleTab requires it.
```

**Are you using remote code?** No.
```text
All JavaScript is in the package. Nothing is downloaded or evaluated at runtime.
```

**Data usage.** Tick these, and nothing else:

- Personally identifiable information (the phone number, city, college and similar the user enters as answers; the names of LinkedIn members they ask for a referral)
- Location (the city the user enters as an answer)
- Personal communications (the referral messages the user writes and sends)
- Web history (the job pages the extension has handled)
- Website content (the job listings and forms it reads)

Then tick all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

(All of this data stays in the user's browser. It's only ever sent to the job sites, by filling in the forms the user asked for.)

**Privacy policy URL**

```text
https://github.com/Ashish94312/job-apply-bots/blob/chrome-extension/PRIVACY.md
```

---

## 4. Distribution tab

- Payments: Free
- Visibility: **Unlisted** to begin with (only people with the link can install it). Switch to Public later from
  here; switching it by hand once means the next update has to be published by hand too, before the update
  script works again.
- Regions: All regions, or only India.

---

## 5. Submit for review

Google reviews it, often within a few days; the 5 site permissions can make it take longer. If they ask how to
test it, send this:

```text
No account is needed to see it work. After installing, click the Sendoff toolbar icon to open the dashboard. Pick Wellfound in the sidebar and click Dry run: it opens its own window, goes through public Wellfound job pages and lists what it would apply to, without logging in or applying. Applying and referrals use the user's own logins on the job sites, and referral messages are shown to the user for confirmation before they're sent.
```

---

## Every update after that

One command raises the version, builds the ZIP, uploads it and submits it for review; it goes live by itself
once the review passes. Set up its access once, as described under **Publishing** in `extension/README.md`, then:

```bash
.venv/bin/python tools/publish_extension.py            # 1.0.0 -> 1.0.1
.venv/bin/python tools/publish_extension.py --status   # where the review is
```
