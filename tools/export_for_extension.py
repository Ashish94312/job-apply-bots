#!/usr/bin/env python3
"""Bring your settings and history from the Python bots into the Chrome extension.

  .venv/bin/python tools/export_for_extension.py             # writes extension-import.json; import it on the
                                                              # extension's dashboard (Settings > Bring over)
  .venv/bin/python tools/export_for_extension.py --defaults  # regenerate extension/lib/defaults.js from the
                                                              # config.example.yaml files

The history makes the extension skip jobs the Python bots already handled. Only the sites the extension
supports are exported. Screenshots stay where they are.
"""
import argparse
import json
import re
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SITES = ("hirist", "instahyre", "wellfound", "cutshort", "linkedin")
PROFILE_SITE = "hirist"  # whose filters and answers become the profile every site shares
FORMAT = "job-apply-bots/1"
SHOT_RE = re.compile(r"\s*\[[\w.-]+\.png\]")


def text(value):
    if isinstance(value, bool):  # an unquoted yes/no in YAML
        return "Yes" if value else "No"
    return "" if value is None else str(value)


def site_settings(cfg):
    search, limits = cfg.get("search") or {}, cfg.get("limits") or {}
    out = {
        "keywords": list(search.get("keywords") or []),
        "searchUrls": list(cfg.get("search_urls") or []),
        "limits": {
            "maxPerRun": limits.get("max_per_run", 10),
            "maxPerDay": limits.get("max_per_day", 30),
            "delaySeconds": list(limits.get("delay_seconds") or [20, 45]),
        },
    }
    if "max_scrolls" in limits:  # a site whose results load as you scroll (Instahyre)
        out["limits"]["maxScrolls"] = limits["max_scrolls"]
    else:
        out["limits"]["maxPages"] = limits.get("max_pages", 5)
    if "locations" in search:  # a site searched by place (Wellfound, LinkedIn)
        out["locations"] = list(search.get("locations") or [])
    # LinkedIn's own search filters and Easy Apply settings
    for yaml_key, key in (("easy_apply_only", "easyApplyOnly"), ("experience_levels", "experienceLevels"),
                          ("work_types", "workTypes"), ("posted_within", "postedWithin")):
        if yaml_key in search:
            out[key] = search[yaml_key] if not isinstance(search[yaml_key], list) else list(search[yaml_key])
    if "skill_years" in cfg:
        out["skillYears"] = {str(k): v for k, v in (cfg.get("skill_years") or {}).items()}
    for yaml_key, key in (("other_skill_years", "otherSkillYears"), ("follow_companies", "followCompanies")):
        if yaml_key in cfg:
            out[key] = cfg[yaml_key]
    if cfg.get("referral"):  # LinkedIn: asking people at the companies for a referral
        rc = cfg["referral"]
        out["referral"] = {
            "forJobs": list(rc.get("for_jobs") or ["applied"]), "withinDays": rc.get("within_days", 14),
            "jobs": list(rc.get("jobs") or []), "school": text(rc.get("school")),
            "peopleKeywords": list(rc.get("people_keywords") or []), "skipHeadline": list(rc.get("skip_headline") or []),
            "perCompany": rc.get("per_company", 2), "maxPerRun": rc.get("max_per_run", 8), "maxPerDay": rc.get("max_per_day", 15),
            "inviteExpiryDays": rc.get("invite_expiry_days", 21), "inviteWithoutNote": rc.get("invite_without_note", True),
            "connectNote": text(rc.get("connect_note")), "message": text(rc.get("message")),
        }
    return out


def profile_settings(cfg):
    search, filters = cfg.get("search") or {}, cfg.get("filters") or {}
    return {
        "minExperience": search.get("min_experience"),
        "maxExperience": search.get("max_experience"),
        "filters": {
            "includeTitle": list(filters.get("include_title") or []),
            "requireRole": list(filters.get("require_role") or []),
            "excludeTitle": list(filters.get("exclude_title") or []),
            "excludeCompanies": list(filters.get("exclude_companies") or []),
            "excludeText": list(filters.get("exclude_text") or []),
            "maxExperienceRequired": filters.get("max_experience_required"),
        },
        "answers": [[str(pattern), text(answer)] for pattern, answer in (cfg.get("answers") or {}).items()],
        "coverNote": text(cfg.get("cover_note")),
    }


def settings(config_name):
    configs = {}
    for site in SITES:
        path = ROOT / site / config_name
        if not path.exists():
            sys.exit(f"Missing {path.relative_to(ROOT)}.")
        configs[site] = yaml.safe_load(path.read_text()) or {}
    profile = profile_settings(configs[PROFILE_SITE])
    sites = {site: site_settings(cfg) for site, cfg in configs.items()}
    for site, cfg in configs.items():  # a site with answers of its own (LinkedIn's number boxes) keeps them
        own = profile_settings(cfg)["answers"]
        if site != PROFILE_SITE and own != profile["answers"]:
            sites[site]["answers"] = own
    return {"version": 1, "profile": profile, "sites": sites}


def history():
    rows = []
    for site in SITES:
        path = ROOT / site / "data" / "jobs.db"
        if not path.exists():
            continue
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
            for job_id, url, title, company, status, note, ts in db.execute(
                "SELECT job_id, url, title, company, status, note, ts FROM jobs WHERE site=?", (site,)
            ):
                rows.append({"site": site, "jobId": job_id, "url": url, "title": title or "", "company": company or "",
                             "status": status, "note": SHOT_RE.sub("", note or "").strip(), "ts": ts})
    return rows


def write_defaults():
    data = settings("config.example.yaml")
    out = ROOT / "extension" / "lib" / "defaults.js"
    out.write_text(
        "// Generated by tools/export_for_extension.py --defaults from the bots' config.example.yaml files.\n"
        "// Sample values: everyone puts in their own on the dashboard's Settings.\n"
        f"(function (JB) {{\n  JB.DEFAULTS = {json.dumps(data, indent=2, ensure_ascii=False).replace(chr(10), chr(10) + '  ')};\n"
        "})(globalThis.JB = globalThis.JB || {});\n"
    )
    print(f"Wrote {out.relative_to(ROOT)}.")


def referrals():
    """Who the LinkedIn bot asked for a referral, and the jobs it asked about, so nobody is asked twice."""
    path = ROOT / "linkedin" / "data" / "jobs.db"
    if not path.exists():
        return [], []
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        people = [] if "contacts" not in names else [
            {"profile": p, "name": n or "", "headline": h or "", "company": c or "", "companyUrl": cu or "", "jobId": j or "",
             "jobUrl": ju or "", "title": t or "", "status": s, "note": note or "", "ts": ts, "updated": up}
            for p, n, h, c, cu, j, ju, t, s, note, ts, up in db.execute(
                "SELECT profile, name, headline, company, company_url, job_id, job_url, title, status, note, ts, updated FROM contacts")]
        asked = [] if "referral_jobs" not in names else [
            {"jobId": j, "url": u or "", "title": t or "", "company": c or "", "status": s, "note": n or "", "ts": ts}
            for j, u, t, c, s, n, ts in db.execute("SELECT job_id, url, title, company, status, note, ts FROM referral_jobs")]
    return people, asked


def cache():
    """What the bots have looked up and kept, e.g. Cutshort's skill ids."""
    found = {}
    skills = ROOT / "cutshort" / "data" / "skill_ids.json"
    if skills.exists():
        found["cache:cutshort:skills"] = json.loads(skills.read_text())
    return found


def write_export(out):
    people, asked = referrals()
    data = {"format": FORMAT, "exported": datetime.now().isoformat(timespec="seconds"),
            "settings": settings("config.yaml"), "history": history(), "cache": cache(),
            "contacts": people, "referralJobs": asked}
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    applied = sum(r["status"] == "applied" for r in data["history"])
    print(f"Wrote {out}: settings for {', '.join(SITES)}, {len(data['history'])} past jobs ({applied} applied)"
          f" and {len(people)} people asked for a referral.")
    print("Import it on the extension's dashboard: Settings > Bring over from the Python bots.")
    print("It has your answers (phone, salary...) in it: delete it once imported.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--defaults", action="store_true", help="regenerate extension/lib/defaults.js instead")
    parser.add_argument("--out", type=Path, default=ROOT / "extension-import.json")
    args = parser.parse_args()
    if args.defaults:
        write_defaults()
    else:
        write_export(args.out)


if __name__ == "__main__":
    main()
