"""Run from a scheduler for the configured environment. Report failures for retry."""
import logging
from urllib.error import HTTPError

from .web import configured_app


def sweep(app):
    orders = app.ledger.unpaid()  # older orders have expired at Cashfree, so they can no longer be paid
    with app.ledger.connection() as db:
        refunds = db.execute("SELECT order_id, refund_id FROM pending_refunds").fetchall()
        events = db.execute("SELECT * FROM notifications WHERE done=0").fetchall()
    failures = 0
    for order_id in orders:
        try:
            app.ledger.reconcile(app.gateway, order_id)
        except HTTPError as error:
            if error.code != 404:  # 404: checkout failed before Cashfree created the order, so nothing to confirm
                logging.error("Reconcile order %s: HTTP %s", order_id, error.code)
                failures += 1
        except Exception as error:
            logging.error("Reconcile order %s: %s", order_id, type(error).__name__)
            failures += 1
    for event in events:
        try:
            if event["status"] == "SUCCESS" and not app.ledger.reconcile(app.gateway, event["order_id"]):
                failures += 1
                continue
            with app.ledger.connection() as db:
                db.execute("UPDATE notifications SET done=1 WHERE event_hash=?", (event["event_hash"],))
        except Exception as error:
            logging.error("Retry notification for %s: %s", event["order_id"], type(error).__name__)
            failures += 1
    for refund in refunds:
        try:
            app.process_refund(refund["order_id"], refund["refund_id"])
        except Exception as error:
            logging.error("Retry refund %s: %s", refund["refund_id"], type(error).__name__)
            failures += 1
    return failures


if __name__ == "__main__":
    app = configured_app()
    failures = sweep(app)
    stuck = app.ledger.problems()["paid without access"]
    if stuck:
        logging.error("billing: %d paid orders have no access. Run `billing-admin status`.", stuck)
    raise SystemExit(bool(failures or stuck))
