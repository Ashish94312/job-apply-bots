"""Run from a scheduler for the configured environment. Report failures for retry."""
import logging

from .web import configured_app


def sweep(app):
    with app.ledger.connection() as db:
        orders = db.execute("SELECT id FROM orders WHERE paid_at IS NULL").fetchall()
        refunds = db.execute("SELECT order_id, refund_id FROM pending_refunds").fetchall()
        events = db.execute("SELECT * FROM notifications WHERE done=0").fetchall()
    failures = 0
    for order in orders:
        try:
            app.ledger.reconcile(app.gateway, order["id"])
        except Exception as error:
            logging.error("Reconcile order %s: %s", order["id"], type(error).__name__)
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
    raise SystemExit(bool(sweep(configured_app())))
