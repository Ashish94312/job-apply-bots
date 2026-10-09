#!/usr/bin/env python3
"""LinkedIn Easy Apply and referral bot. See README.md.

  python run.py                          # log in if needed, then apply
  python run.py --dry-run                # show what it would apply to
  python run.py --confirm --assist       # ask before each one; pause on questions it can't answer
  python run.py refer --dry-run          # who it would ask for a referral, and what it would send
  python run.py refer --confirm          # ask for referrals, checking each message with you first
  python run.py login                    # only log in and save the session
  python run.py history --status needs_manual
  python run.py referrals                # who it has asked
"""
import argparse
import random
import sys
import time
from pathlib import Path

import yaml
from playwright.sync_api import Error as PWError
from playwright.sync_api import sync_playwright

import referral
from core import (
    Job,
    Status,
    Store,
    ensure_loaded,
    is_applied,
    launch,
    login_in_plain_chrome,
    preview_ok,
    screenshot,
    skip_reason,
)
from portal import PORTAL, DailyLimit

ICONS = {
    Status.APPLIED: "+",
    Status.ALREADY: "=",
    Status.SKIPPED: "-",
    Status.MANUAL: "!",
    Status.EXTERNAL: ">",
    Status.FAILED: "x",
}


def first_page(ctx):
    return ctx.pages[0] if ctx.pages else ctx.new_page()


def open_logged_in(pw, cfg, headless=False):
    """Returns (ctx, page); page is None if login failed.

    Saved session, else saved password, else the user logs in by hand.
    """
    ctx = launch(pw, cfg, headless)
    page = first_page(ctx)
    if PORTAL.is_logged_in(page):
        return ctx, page
    if PORTAL.auto_login(page, cfg) and PORTAL.is_logged_in(page):
        print("Logged in with saved password.")
        return ctx, page
    if not sys.stdin.isatty():
        return ctx, None
    if PORTAL.login_outside_automation:
        ctx.close()  # the profile can only be open in one browser at a time
        login_in_plain_chrome(PORTAL.login_url)
        ctx = launch(pw, cfg, headless)
        page = first_page(ctx)
    else:
        PORTAL.open_login(page)
        input(f"\nLog in to {PORTAL.name} in the browser window (OTP/captcha too), then press Enter here... ")
    return ctx, (page if PORTAL.is_logged_in(page) else None)


def cmd_login(args, cfg):
    with sync_playwright() as pw:
        ctx, page = open_logged_in(pw, cfg)
        ctx.close()
    print("Logged in, session saved." if page else "Still not logged in - try again.")


def cmd_run(args, cfg):
    store = Store(PORTAL.name)
    with sync_playwright() as pw:
        ctx, page = open_logged_in(pw, cfg, args.headless)
        try:
            if page is None:
                print(f"Not logged in to {PORTAL.name}, stopping.")
                return
            run(page, cfg, store, args)
        except KeyboardInterrupt:
            print("\nStopped.")
        finally:
            ctx.close()


def run(page, cfg, store, args):
    limits, filters = cfg["limits"], cfg["filters"]
    budget = args.max or limits["max_per_run"]
    if not args.dry_run:
        budget = min(budget, limits["max_per_day"] - store.applied_today())
        if budget <= 0:
            print(f"Daily limit reached ({limits['max_per_day']}).")
            return

    done = 0
    for search_url in PORTAL.search_urls(page, cfg):
        listed = set()
        for n in range(1, limits["max_pages"] + 1):
            if done >= budget:
                break
            url = PORTAL.search_page_url(search_url, n)
            print(f"\n{url}")
            try:
                page.goto(url, wait_until="domcontentloaded")
                links = PORTAL.collect_links(page) if ensure_loaded(page, PORTAL.job_link_css) else {}
            except PWError as e:
                if page.is_closed():
                    print("Browser window was closed, stopping.")
                    return
                print(f"  Couldn't load search page: {str(e).splitlines()[0]}")
                break
            if not set(links) - listed:  # empty, or a page past the end repeating earlier jobs
                print("  No more jobs for this search.")
                break
            listed |= set(links)
            fresh = {u: p for u, p in links.items() if not store.seen(PORTAL.job_id(u)) and preview_ok(p, filters)}
            print(f"  {len(links)} jobs listed, {len(fresh)} new and matching")

            for url in fresh:
                if done >= budget:
                    break
                job = Job(url, PORTAL.job_id(url))
                try:
                    status, job, note = handle_job(page, job, cfg, args)
                except DailyLimit as e:
                    print(f"\n{e}\nDone: applied to {done}.")
                    return
                except PWError as e:
                    if page.is_closed():
                        print("Browser window was closed, stopping.")
                        return
                    status, note = Status.FAILED, str(e).splitlines()[0]
                if status is None:  # dry run or user quit
                    if note == "quit":
                        return
                    done += 1
                    continue
                if status in (Status.MANUAL, Status.FAILED):
                    shot = screenshot(page, job.job_id)
                    note = f"{note} [{shot.name}]" if shot else note
                store.record(job, status, note)
                print(f"  {ICONS[status]} {status:<15} {job.label}  {note}")
                if status == Status.APPLIED:
                    done += 1
                    time.sleep(random.uniform(*limits["delay_seconds"]))
                else:
                    time.sleep(random.uniform(2, 5))

    verb = "would apply" if args.dry_run else "applied"
    print(f"\nDone: {verb} to {done}.")


def handle_job(page, job, cfg, args):
    """Returns (status, job, note). status None means nothing to record."""
    page.goto(job.url, wait_until="domcontentloaded")
    ensure_loaded(page, PORTAL.job_ready_css)
    page.wait_for_timeout(2500)  # let the apply button render
    job = PORTAL.read_job(page, job.url)

    reason = skip_reason(job, cfg["filters"])
    if reason:
        return Status.SKIPPED, job, reason
    if args.dry_run:
        print(f"  ~ would apply   {job.label}  {job.url}")
        return None, job, ""
    if args.confirm:
        answer = input(f"  ? Apply to {job.label}? [y/N/q] ").strip().lower()
        if answer == "q":
            return None, job, "quit"
        if answer != "y":
            return Status.SKIPPED, job, "declined"

    status, note = PORTAL.apply(page, cfg, job)
    if status == Status.MANUAL and args.assist:
        input(f"  ! {job.label}: {note}\n    Finish it in the browser, then press Enter... ")
        if is_applied(page, PORTAL):
            status, note = Status.APPLIED, "finished by hand"
    return status, job, note


def cmd_history(args, cfg):
    rows = Store(PORTAL.name).history(args.status, args.n)
    for ts, status, title, company, url, note in rows:
        print(f"{ts}  {ICONS.get(status, '?')} {status:<15} {title} @ {company}\n{'':22}{url}  {note or ''}")
    if not rows:
        print("Nothing yet.")


def cmd_refer(args, cfg):
    if not cfg.get("referral"):
        sys.exit("Add a referral: section to config.yaml first (see config.example.yaml).")
    store = Store(PORTAL.name)
    with sync_playwright() as pw:
        ctx, page = open_logged_in(pw, cfg, args.headless)
        try:
            if page is None:
                print(f"Not logged in to {PORTAL.name}, stopping.")
                return
            referral.run(page, cfg, store, args)
        except KeyboardInterrupt:
            print("\nStopped.")
        finally:
            ctx.close()


def cmd_referrals(args, cfg):
    rows = referral.Contacts(Store(PORTAL.name)).history(args.status, args.n)
    for ts, status, name, headline, company, profile, note in rows:
        print(f"{ts}  {status:<13} {name} ({(headline or '')[:60]}) @ {company}\n{'':22}{profile}  {note or ''}")
    if not rows:
        print("Nobody asked yet.")


def cmd_reset(args, cfg):
    print(f"Forgot {Store(PORTAL.name).forget(args.status)} '{args.status}' jobs; they'll be re-checked next run.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=str(Path(__file__).parent / "config.yaml"))
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("run", help="log in if needed, find matching jobs and apply (default)")
    p.add_argument("--dry-run", action="store_true", help="list matching jobs, don't apply")
    p.add_argument("--confirm", action="store_true", help="ask before each application")
    p.add_argument("--assist", action="store_true", help="pause on questions it can't answer so you can")
    p.add_argument("--max", type=int, help="max applications this run")
    p.add_argument("--headless", action="store_true", help="hide the browser (may get blocked)")

    p = sub.add_parser("refer", help="ask people at the companies you applied to for a referral")
    p.add_argument("--dry-run", action="store_true", help="show who it would contact and the message, send nothing")
    p.add_argument("--confirm", action="store_true", help="ask before each message or invite")
    p.add_argument("--max", type=int, help="max messages + invites this run")
    p.add_argument("--headless", action="store_true", help="hide the browser (may get blocked)")

    p = sub.add_parser("referrals", help="who it has asked for a referral")
    p.add_argument("--status", choices=list(referral.STATUSES))
    p.add_argument("-n", type=int, default=30)

    sub.add_parser("login", help="only log in and save the session")

    p = sub.add_parser("history", help="show past results")
    p.add_argument("--status", choices=list(ICONS))
    p.add_argument("-n", type=int, default=30)

    p = sub.add_parser("reset", help="forget jobs with a status so they're re-checked")
    p.add_argument("--status", choices=list(ICONS), default=Status.SKIPPED)

    commands = {
        "run": cmd_run, "refer": cmd_refer, "referrals": cmd_referrals,
        "login": cmd_login, "history": cmd_history, "reset": cmd_reset,
    }

    argv = sys.argv[1:]
    if not argv or (argv[0].startswith("-") and argv[0] not in ("-h", "--help", "--config")):
        argv = ["run", *argv]  # `python run.py --dry-run` means `python run.py run --dry-run`
    args = parser.parse_args(argv)
    if not Path(args.config).exists():
        sys.exit(f"Missing {args.config}: copy config.example.yaml to config.yaml and edit it.")
    with open(args.config) as f:
        cfg = yaml.safe_load(f)
    commands[args.cmd](args, cfg)


if __name__ == "__main__":
    sys.exit(main())
