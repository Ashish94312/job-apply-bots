#!/bin/sh
# Runs the billing service as the unprivileged "app" user, with its database on the Fly volume (/app/data).
set -e
mkdir -p /app/data
chown app:app /app/data
cd /app
as_app() { setpriv --reuid=app --regid=app --init-groups "$@"; }
# Every 5 minutes: confirm payments and refunds whose Cashfree notifications were missed or failed.
as_app sh -c 'while true; do sleep 300; python -m billing.recovery || echo "billing recovery: needs a look (billing-admin status), retrying" >&2; done' &
# No access log: request lines carry one-time sign-in codes.
exec setpriv --reuid=app --regid=app --init-groups gunicorn --bind 0.0.0.0:8080 --workers 1 --threads 8 --timeout 30 'billing.web:configured_app()'
