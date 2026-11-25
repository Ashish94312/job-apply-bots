#!/bin/sh
# Deploy the billing service to Fly.io: ./billing/deploy/deploy.sh (extra arguments go to `fly deploy`).
# Only the billing code is uploaded. The rest of the repo (your settings, job history, browser profiles) never is.
set -e
here=$(cd "$(dirname "$0")" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/billing"
for f in "$here"/../*.py; do
  case "$(basename "$f")" in test_*|browser_check.py) ;; *) cp "$f" "$stage/billing/" ;; esac
done
cp "$here/Dockerfile" "$here/fly.toml" "$here/start.sh" "$here/billing-admin" "$stage/"
chmod +x "$stage/start.sh" "$stage/billing-admin"
echo "Uploading: $(cd "$stage" && find . -type f | sort | tr '\n' ' ')"
cd "$stage" && fly deploy "$@"
