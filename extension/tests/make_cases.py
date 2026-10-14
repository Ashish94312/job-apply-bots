#!/usr/bin/env python3
"""Write tests/cases.json: what the Python bots' filters and answers say for many inputs, so the extension's
JavaScript port can be checked against them (tests/unit.test.js).

  .venv/bin/python extension/tests/make_cases.py
"""
import json
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "hirist"))
from core import Job, answer_for, has_word, min_years, preview_ok, skip_reason  # noqa: E402

cfg = yaml.safe_load((ROOT / "hirist" / "config.example.yaml").read_text())
filters = dict(cfg["filters"], exclude_companies=["Acme Staffing"], exclude_text=["night shift"])
answers = dict(cfg["answers"], **{"phone|mobile": "+91 98765 43210", "date of birth": None})

TITLES = [
    "Software Engineer", "SWE II", "Backend Engineer", "Back-End Developer", "AI Agent Developer", "Founding Engineer",
    "Product Engineer - Python", "Applied Scientist", "Prompt Engineer", "LLMOps Engineer", "Agentic AI Engineer",
    "API Developer", "Software Test Engineer", "Senior Backend Engineer", "Software Engineer in Test",
    "AI Agent Trainer", "Customer Support Agent", "Java Developer", "DevOps Engineer", "Sr. ML Engineer",
    "ML Engineer (Gen AI)", "AI/ML Engineer - NLP & Speech Recognition", "SDE1 - Backend", "SDE-2 Python",
    "SDE 3", "Software Development Engineer III", "Data Scientist", "Data Science SME", "Machine Learning Intern",
    "Lead Data Scientist", "Full-Stack Developer (Django)", "Fullstack Engineer", "Python Developer - Django",
    "Computer Vision Engineer", "Head of AI", "AI Architect", "QA Automation Engineer", "Engineer 3 - Platform",
    "Développeur Python", "Ingénieur IA", "RAG Engineer", "LangChain Developer", "Gen AI Engineer",
    "Generative AI Scientist", "Research Engineer, LLMs", "NLP Researcher", "AI Content Writer",
    "Mlops Engineer", "Platform Engineer - AI Systems", "Forward Deployed Engineer - AI/ML", "",
]
PREVIEWS = [
    "Focalworks - Python Developer - Django 2 - 6 yrs Mumbai Python Django Posted 3 weeks ago",
    "TELUS Digital - Robotics Applied AI Engineer - Python 2 - 4 yrs Bangalore",
    "Acme Staffing - AI Engineer 1 - 3 yrs Pune",
    "Coverfox - Backend Developer - Python/Django 1 to 2 years Bangalore",
    "Some Co - Sales Executive 0 - 1 yrs Delhi",
    "BigCo - Data Scientist 3.5 - 7 Years Hyderabad",
    "",
    "Startup - Founding Engineer 0-2yrs Remote",
]
TEXTS = ["2 - 6 yrs", "3.5 – 7 years", "1 to 2 years", "0-2yrs", "v2.0 - 5 years", "12 - 15 Years", "no range here", "5 yrs+"]
LABELS = [
    "What is your notice period?", "Current CTC (in LPA)", "What is your expected CTC?",
    "How many years of experience do you have?", "Total experience", "Are you currently living in Bengaluru?",
    "Are you currently based in Pune?", "Are you willing to relocate?", "Can you join immediately?",
    "Phone number", "Mobile", "What's your LinkedIn profile?", "Date of birth", "Which college did you attend?",
    "Can you work from office 5 days a week?", "Describe a time you showed high agency",
    "Why do you want to join us?", "Current city", "",
]
WORDS = [("AI/ML Engineer", "ai"), ("Email engineer", "ai"), ("Sr. ML", "sr"), ("SDE1", "sde"), ("SDE-1", "sde"),
         ("Full-Stack", "full stack"), ("Full-Stack", "full-stack"), ("C++ Dev", "c++"), ("Ingénieur IA", "ia"),
         ("naïve", "na"), ("RAG/LLM", "rag"), ("drag", "rag")]

def bot_module(bot, name):
    """Import <bot>/<name>.py on its own: every bot has a core.py and portal.py of the same names."""
    import importlib
    for m in ("core", "portal"):
        sys.modules.pop(m, None)
    sys.path.insert(0, str(ROOT / bot))
    try:
        return importlib.import_module(name)
    finally:
        sys.path.pop(0)


SEARCHES = [
    {"keywords": ["machine learning", "AI/ML engineer", "python"], "minExperience": 1, "maxExperience": 2, "searchUrls": []},
    {"keywords": ["data science"], "minExperience": 0, "maxExperience": 0, "searchUrls": ["https://www.instahyre.com/search-jobs?skills=X"]},
]
PLACES = [
    {"keywords": ["Machine Learning Engineer", "ai engineer"], "locations": ["india", "Remote", "New Delhi"], "searchUrls": []},
    {"keywords": ["backend engineer"], "locations": [], "searchUrls": ["https://wellfound.com/jobs?x=1"]},
]


def python_cfg(c):
    return {"search": {"keywords": c["keywords"], "min_experience": c.get("minExperience"), "max_experience": c.get("maxExperience"),
                       "locations": c.get("locations")}, "search_urls": c["searchUrls"]}


instahyre = bot_module("instahyre", "portal").PORTAL
wellfound_portal = bot_module("wellfound", "portal")
site_urls = [{"site": "instahyre", "cfg": c, "expected": instahyre.search_urls(None, python_cfg(c))} for c in SEARCHES]
site_urls += [{"site": "wellfound", "cfg": c, "expected": wellfound_portal.PORTAL.search_urls(None, python_cfg(c))} for c in PLACES]
with_range = [{"text": x, "expected": wellfound_portal.with_range(x)}
              for x in ["Acme ML Engineer 3 years of exp Remote", "Beta 10+ years of exp", "Gamma 1 year of exp", "no experience given", ""]]
cutshort = bot_module("cutshort", "portal")
cutshort.SKILLS_CACHE = Path("/nonexistent")  # only the built-in skill ids, not this machine's cache
FEEDS = [
    {"keywords": ["machine learning", "NLP", "python", "llm"], "minExperience": 1, "maxExperience": 2, "searchUrls": ["https://cutshort.io/profile/all-jobs?skills=00268"]},
    {"keywords": ["deep learning"], "minExperience": None, "maxExperience": None, "searchUrls": []},
]
site_urls += [{"site": "cutshort", "cfg": c, "expected": cutshort.PORTAL.search_urls(None, python_cfg(c))} for c in FEEDS]
linkedin = bot_module("linkedin", "portal")
li_cfg = yaml.safe_load((ROOT / "linkedin" / "config.example.yaml").read_text())
SEARCHES_LI = [
    {"keywords": ["machine learning engineer", "AI/ML"], "locations": ["India", "Bengaluru, Karnataka"], "easyApplyOnly": True,
     "experienceLevels": ["entry level", "Associate"], "workTypes": ["remote", "hybrid", "onsite"], "postedWithin": "week", "searchUrls": []},
    {"keywords": ["sde"], "locations": [], "easyApplyOnly": False, "experienceLevels": [], "workTypes": [], "postedWithin": "",
     "searchUrls": ["https://www.linkedin.com/jobs/search/?keywords=x"]},
]
for c in SEARCHES_LI:
    py = {"search": {"keywords": c["keywords"], "locations": c["locations"], "easy_apply_only": c["easyApplyOnly"],
                     "experience_levels": c["experienceLevels"], "work_types": c["workTypes"], "posted_within": c["postedWithin"]},
          "search_urls": c["searchUrls"]}
    site_urls.append({"site": "linkedin", "cfg": c, "expected": linkedin.PORTAL.search_urls(None, py)})
li_answers = dict(li_cfg["answers"], **{"phone|mobile": "9876543210"})
LI_LABELS = [
    "How many years of work experience do you have with Python?", "Years of Java experience", "Experience with React?",
    "Machine Learning experience?", "How many years of total experience do you have?", "Years of experience",
    "How many years of experience do you have in software development?", "What is your current CTC?",
    "Expected CTC (in INR)", "Notice period", "Are you comfortable commuting to this job's location?",
    "Do you require sponsorship?", "Mobile phone number", "Phone country code", "Have you completed a Bachelor's degree?",
    "How many years of experience do you have with deep learning frameworks?", "Rate your proficiency in English",
    "How many years of experience do you have with SQL databases?", "Years of experience with Kubernetes?",
]
li = {
    "answers": [[k, "" if v is None else str(v)] for k, v in li_answers.items()],
    "skillYears": {str(k): v for k, v in li_cfg["skill_years"].items()},
    "otherSkillYears": li_cfg["other_skill_years"],
    "answer": [{"label": l, "expected": linkedin.PORTAL.answer(l, dict(li_cfg, answers=li_answers))} for l in LI_LABELS],
    "withRange": [{"text": x, "expected": linkedin.with_range(x)} for x in [
        "We want 3+ years of experience in Python.", "Experience: 2 - 5 years. Also 1+ yrs of relevant experience.",
        "Minimum 4 years experience", "no years here", "Looking for 0-1 yrs freshers with 2+ years experience"]],
    "pick": [{"options": o, "answer": a, "expected": linkedin.pick(o, a)} for o, a in [
        (["Select an option", "Yes", "No"], "Yes"), (["India (+91)", "Indonesia (+62)"], "India (+91)"),
        (["Andorra (+376)", "India (+91)"], "india"), (["Professional working proficiency", "Native"], "Professional"),
        (["A", "B"], ""), (["Yes", "No"], "maybe")]],
}
referral = bot_module("linkedin", "referral")
from urllib.parse import quote, urlencode  # noqa: E402
NAMES = ["Priya Sharma", "Dr. Anil Kumar", "RAHUL VERMA", "sneha", "Mr. ", "Jean-Luc O'Neil", "Prof. R. K. Gupta", "D'Souza, Maria", "José Álvarez", ""]
JOB = referral.Job("https://www.linkedin.com/jobs/view/4001/", "4001", "ML Engineer", "Acme")
li["firstName"] = [{"name": n, "expected": referral.first_name(n)} for n in NAMES]
li["render"] = [{"template": tpl, "name": n, "job": {"url": JOB.url, "jobId": JOB.job_id, "title": JOB.title, "company": JOB.company},
                 "expected": referral.render(tpl, n, JOB)}
                for tpl in ["Hi {first_name}, I'm applying for {title} at {company}: {job_url}. Thanks, {name}!", "  plain  ", ""]
                for n in ["Priya Sharma", "dr. SNEHA"]]
li["render"].append({"template": "Hi {first_name} at {company} for {title}", "name": "X", "job": {"url": "u", "jobId": "1", "title": "", "company": ""},
                     "expected": referral.render("Hi {first_name} at {company} for {title}", "X", referral.Job("u", "1", "", ""))})
compact = lambda value: json.dumps(value, separators=(",", ":"))
li["peopleUrl"] = [{"ids": ids, "keywords": k, "expected": f"{referral.BASE}/search/results/people/?" + urlencode(
    {"currentCompany": compact(ids), "network": compact(["F", "S"]), "keywords": k, "origin": "FACETED_SEARCH"}, quote_via=quote)}
    for ids, k in [(["1234"], "software engineer"), (["11", "22"], "Indian Institute of Technology (IIT), Jodhpur"), (["5"], "ML/AI & data")]]
sys.modules.pop("core", None)
sys.modules.pop("portal", None)

cases = {
    "linkedin": li,
    "siteUrls": site_urls,
    "withRange": with_range,
    "filters": {
        "includeTitle": filters["include_title"], "requireRole": filters["require_role"],
        "excludeTitle": filters["exclude_title"], "excludeCompanies": filters["exclude_companies"],
        "excludeText": filters["exclude_text"], "maxExperienceRequired": filters["max_experience_required"],
    },
    "answers": [[k, "" if v is None else str(v)] for k, v in answers.items()],
    "skipReason": [
        {"title": t, "company": c, "text": x, "expected": skip_reason(Job("u", "1", t, c, x), filters)}
        for t in TITLES for c, x in [("Nice Co", "2 - 4 yrs"), ("Acme Staffing Pvt", ""), ("Nice Co", "4 - 8 yrs night shift")]
    ],
    "previewOk": [{"preview": p, "expected": preview_ok(p, filters)} for p in PREVIEWS],
    "minYears": [{"text": t, "expected": min_years(t)} for t in TEXTS],
    "answerFor": [{"label": label, "expected": answer_for(label, answers)} for label in LABELS],
    "hasWord": [{"text": t, "word": w, "expected": has_word(t, w)} for t, w in WORDS],
}
(HERE / "cases.json").write_text(json.dumps(cases, indent=1, ensure_ascii=False) + "\n")
print(f"Wrote {HERE / 'cases.json'}: {sum(len(v) for v in cases.values() if isinstance(v, list))} cases.")
