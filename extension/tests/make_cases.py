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

cases = {
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
