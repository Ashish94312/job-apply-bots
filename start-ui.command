#!/bin/bash
# Double-click this in Finder: it opens the job bots dashboard in your browser.
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "Set up the bots first (see Setup in README.md), then double-click this again."
  read -r -p "Press Enter to close. "
  exit 1
fi
exec .venv/bin/python ui/server.py
