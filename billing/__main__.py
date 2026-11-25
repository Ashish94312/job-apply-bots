"""Local operator commands for testing the sandbox before enabling customer checkout."""
import argparse
import json
import os
import time
from pathlib import Path

from .service import CashfreeProduction, CashfreeSandbox, Ledger


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--production", action="store_true", help="Use the separate live catalogue and ledger")
    commands = parser.add_subparsers(dest="command", required=True)
    offer = commands.add_parser("offer")
    offer.add_argument("product")
    offer.add_argument("version")
    offer.add_argument("paise", type=int)
    offer.add_argument("days", type=int)
    order = commands.add_parser("order")
    for name in ("account", "product", "version", "retry_key"):
        order.add_argument(name)
    commands.add_parser("reconcile").add_argument("order_id")
    refund = commands.add_parser("reconcile-refund")
    refund.add_argument("order_id")
    refund.add_argument("refund_id")
    for name in ("pause", "resume"):
        commands.add_parser(name, help=f"{name.title()} new purchases of a product").add_argument("product")
    commands.add_parser("status", help="What needs an operator; exits 1 if anything does")
    commands.add_parser("lookup", help="Support: an account by order ID or email").add_argument("reference")
    access = commands.add_parser("expiry")
    access.add_argument("account")
    access.add_argument("product")
    args = parser.parse_args()
    args.production = args.production or os.environ.get("BILLING_MODE") == "production"  # a live server's own ledger
    if args.production and args.command == "order":
        parser.error("Create live orders through authenticated checkout")
    mode = "production" if args.production else "sandbox"
    path = Path(f"data/billing-{mode}.sqlite3")
    path.parent.mkdir(exist_ok=True)
    ledger = Ledger(path)
    gateway = CashfreeProduction() if args.production else CashfreeSandbox()
    if args.command == "offer":
        ledger.add_offer(args.product, args.version, args.paise, args.days)
    elif args.command == "order":
        record = ledger.order(args.account, args.product, args.version, args.retry_key)
        print("Local order:", record["id"], flush=True)
        result = gateway.create(record, os.environ["CASHFREE_SANDBOX_TEST_PHONE"])
        print("Cashfree order:", result["order_id"], result["order_status"])
    elif args.command == "reconcile-refund":
        print("Refund confirmed" if ledger.reconcile_refund(gateway, args.order_id, args.refund_id) else "Refund pending")
    elif args.command == "reconcile":
        print("Paid" if ledger.reconcile(gateway, args.order_id) else "Awaiting payment")
    elif args.command in ("pause", "resume"):
        ledger.pause(args.product, args.command == "pause")
        print(f"New purchases of {args.product}:", "paused" if ledger.paused(args.product) else "open")
    elif args.command == "status":
        problems = ledger.problems()
        for name, count in problems.items():
            print(f"{name}: {count}")
        with ledger.connection() as db:
            paused = [r[0] for r in db.execute("SELECT product FROM paused")]
        print("paused products:", ", ".join(paused) or "none")
        return 1 if problems["paid without access"] or problems["refunds waiting"] else 0
    elif args.command == "lookup":
        found = ledger.lookup(args.reference)
        for account in found:
            account["trials"] = {product: day(ends) for product, ends in account["trials"].items()}
            for o in account["orders"]:
                o.update({k: day(o[k]) for k in ("created_at", "paid_at", "expires_at")},
                         rupees=o.pop("paise") / 100, refunded=o["refunded"] / 100)
            print(json.dumps(account, indent=2))
        if not found:
            print("No account with that order ID or email")
            return 1
    else:
        print(ledger.expiry(args.account, args.product) or "No access")
    return 0


def day(seconds):
    return seconds and time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(seconds))


if __name__ == "__main__":
    raise SystemExit(main())
