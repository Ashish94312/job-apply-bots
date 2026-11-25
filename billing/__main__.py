"""Local operator commands for testing the sandbox before enabling customer checkout."""
import argparse
import os
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
    access = commands.add_parser("expiry")
    access.add_argument("account")
    access.add_argument("product")
    args = parser.parse_args()
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
    else:
        print(ledger.expiry(args.account, args.product) or "No access")


if __name__ == "__main__":
    main()
