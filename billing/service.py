"""Cashfree gateway adapters and server-side ledger. Account IDs come from trusted callers."""
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from urllib.request import HTTPRedirectHandler, Request, build_opener


ORDER_TTL = 86400  # Cashfree refuses payment on an order after this; the recovery sweep looks a day past it
SWEEP_WINDOW = ORDER_TTL + 86400


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Merchant credentials belong only to the configured gateway endpoint.
        return None


class CashfreeGateway:
    endpoint: str
    key_prefix: str

    def request(self, path, payload=None, retry_key=None):
        headers = {
            "x-api-version": "2025-01-01",
            "x-client-id": os.environ[self.key_prefix + "APP_ID"],
            "x-client-secret": os.environ[self.key_prefix + "SECRET"],
            "Content-Type": "application/json",
        }
        if retry_key:
            headers["x-idempotency-key"] = retry_key
        data = None if payload is None else json.dumps(payload).encode()
        request = Request(self.endpoint + path, data=data, headers=headers)
        with build_opener(NoRedirect()).open(request, timeout=15) as response:
            return json.load(response, parse_float=Decimal)

    def create(self, order, phone, origin=None):
        return self.request("", {
            "order_id": order["id"],
            "order_expiry_time": datetime.fromtimestamp((order.get("created_at") or time.time()) + ORDER_TTL,
                                                        timezone.utc).isoformat(timespec="seconds"),
            **({"order_meta": {"return_url": origin + "/receipt?id=" + order["id"],
                                "notify_url": origin + "/webhook"}} if origin else {}),
            "order_amount": order["paise"] / 100,
            "order_currency": "INR",
            "customer_details": {"customer_id": order["account"], "customer_phone": phone},
        }, order["id"])

    def refund(self, order_id, refund_id):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", refund_id):
            raise ValueError("Invalid refund ID")
        return self.request("/" + str(uuid.UUID(order_id)) + "/refunds/" + refund_id)

    def get(self, order_id):
        return self.request("/" + str(uuid.UUID(order_id)))


class CashfreeSandbox(CashfreeGateway):
    endpoint = "https://sandbox.cashfree.com/pg/orders"
    key_prefix = "CASHFREE_SANDBOX_"


class CashfreeProduction(CashfreeGateway):
    endpoint = "https://api.cashfree.com/pg/orders"
    key_prefix = "CASHFREE_PRODUCTION_"


class Ledger:
    def __init__(self, path):
        self.path = path
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS offers (
                    product TEXT, version TEXT, paise INTEGER NOT NULL CHECK(paise > 0),
                    days INTEGER NOT NULL CHECK(days > 0), PRIMARY KEY(product, version)
                );
                CREATE TABLE IF NOT EXISTS refunds (
                    order_id TEXT, refund_id TEXT, paise INTEGER, PRIMARY KEY(order_id, refund_id)
                );
                CREATE TABLE IF NOT EXISTS orders (
                    id TEXT PRIMARY KEY, account TEXT NOT NULL, retry_key TEXT NOT NULL,
                    product TEXT NOT NULL, version TEXT NOT NULL, paise INTEGER NOT NULL,
                    days INTEGER NOT NULL, paid_at INTEGER, expires_at INTEGER,
                    UNIQUE(account, retry_key)
                );
                CREATE TABLE IF NOT EXISTS trials (
                    account TEXT, product TEXT, ends_at INTEGER NOT NULL, PRIMARY KEY(account, product)
                );
                CREATE TABLE IF NOT EXISTS paused (product TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT);
            """)
            if "created_at" not in {r["name"] for r in db.execute("PRAGMA table_info(orders)")}:
                db.execute("ALTER TABLE orders ADD COLUMN created_at INTEGER")

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            db.row_factory = sqlite3.Row
            with db:
                yield db

    def add_offer(self, product, version, paise, days):
        if not product or not version or type(paise) is not int or type(days) is not int:
            raise ValueError("Supply product, version, integer paise and whole days")
        with self.connection() as db:
            db.execute("INSERT INTO offers VALUES (?, ?, ?, ?)", (product, version, paise, days))

    def order(self, account, product, version, retry_key):
        if not account or not retry_key:
            raise ValueError("An account and retry key are required")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM orders WHERE account=? AND retry_key=?",
                             (account, retry_key)).fetchone()
            if row:
                if (row["product"], row["version"]) != (product, version):
                    raise ValueError("Retry key already used for a different offer")
                return dict(row)
            offer = db.execute("SELECT * FROM offers WHERE product=? AND version=?",
                               (product, version)).fetchone()
            if not offer:
                raise ValueError("Unknown offer")
            order_id = str(uuid.uuid4())
            db.execute("""INSERT INTO orders (id, account, retry_key, product, version, paise, days, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                       (order_id, account, retry_key, product, version, offer["paise"], offer["days"],
                        int(time.time())))
            return dict(db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())

    def pause(self, product, paused=True):
        """Stop (or restart) new purchases of a product. Confirmations, refunds and restoring carry on."""
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO paused VALUES (?)" if paused else "DELETE FROM paused WHERE product=?",
                       (product,))

    def paused(self, product):
        with self.connection() as db:
            return bool(db.execute("SELECT 1 FROM paused WHERE product=?", (product,)).fetchone())

    def unpaid(self):
        """Orders that may still be paid: created within the sweep window (or before creation times were kept)."""
        with self.connection() as db:
            return [r["id"] for r in db.execute(
                "SELECT id FROM orders WHERE paid_at IS NULL AND (created_at IS NULL OR created_at>?)",
                (int(time.time()) - SWEEP_WINDOW,))]

    def problems(self):
        """What needs an operator: paid orders without access, and confirmations or refunds still waiting."""
        with self.connection() as db:
            def count(sql, *args):
                return db.execute(sql, args).fetchone()[0]
            web = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            return {
                "paid without access": count("""SELECT COUNT(*) FROM orders o WHERE paid_at IS NOT NULL
                    AND expires_at IS NULL AND paise > (SELECT COALESCE(SUM(paise),0) FROM refunds WHERE order_id=o.id)"""),
                "notifications waiting": count("SELECT COUNT(*) FROM notifications WHERE done=0")
                    if "notifications" in web else 0,
                "refunds waiting": count("SELECT COUNT(*) FROM pending_refunds") if "pending_refunds" in web else 0,
                "orders awaiting payment": len(self.unpaid()),
            }

    def lookup(self, reference):
        """Support: the account behind an order ID or email, its trial and every order."""
        with self.connection() as db:
            accounts = [r[0] for r in db.execute("SELECT account FROM orders WHERE id=?", (reference,))]
            accounts += [r[0] for r in db.execute("SELECT id FROM accounts WHERE lower(email)=lower(?)", (reference,))]
            found = []
            for account in dict.fromkeys(accounts):
                email = db.execute("SELECT email FROM accounts WHERE id=?", (account,)).fetchone()
                trials = db.execute("SELECT product, ends_at FROM trials WHERE account=?", (account,)).fetchall()
                orders = db.execute("""SELECT o.id, o.product, o.version, o.paise, o.created_at, o.paid_at,
                    o.expires_at, COALESCE(SUM(r.paise),0) refunded FROM orders o
                    LEFT JOIN refunds r ON o.id=r.order_id WHERE account=? GROUP BY o.id ORDER BY o.rowid""",
                                    (account,)).fetchall()
                found.append({"account": account, "email": email and email[0],
                              "trials": {t["product"]: t["ends_at"] for t in trials},
                              "orders": [dict(o) for o in orders]})
            return found

    def start_trial(self, account, product, days):
        """One free trial per account and product, from its first sign-in. Later calls keep the first."""
        if days > 0:
            with self.connection() as db:
                db.execute("INSERT OR IGNORE INTO trials VALUES (?, ?, ?)",
                           (account, product, int(time.time()) + days * 86400))

    def reconcile(self, gateway, order_id):
        remote = gateway.get(order_id)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
            if (not order or remote["order_id"] != order_id or remote["order_currency"] != "INR"
                    or Decimal(str(remote["order_amount"])) * 100 != order["paise"]):
                raise ValueError("Cashfree order details do not match")
            if order["paid_at"] is not None:
                return True
            if remote["order_status"] != "PAID":
                return False
            now = int(time.time())
            previous = self._expiry(db, order["account"], order["product"])
            refunded = db.execute("SELECT SUM(paise) FROM refunds WHERE order_id=?", (order_id,)).fetchone()[0]
            expires = None if (refunded or 0) >= order["paise"] else max(now, previous or 0) + order["days"] * 86400
            db.execute("UPDATE orders SET paid_at=?, expires_at=? WHERE id=?", (now, expires, order_id))
            return True

    def reconcile_refund(self, gateway, order_id, refund_id):
        remote = gateway.refund(order_id, refund_id)
        amount = Decimal(str(remote["refund_amount"])) * 100
        if (remote["order_id"] != order_id or remote["refund_id"] != refund_id
                or remote["refund_currency"] != "INR" or amount <= 0 or amount != int(amount)):
            raise ValueError("Refund details do not match")
        if remote["refund_status"] != "SUCCESS":
            return False
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            order = db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
            if not order or amount > order["paise"]:
                raise ValueError("Unknown refund amount or order")
            db.execute("INSERT OR IGNORE INTO refunds VALUES(?,?,?)", (order_id, refund_id, int(amount)))
            # Rebuild the customer's pass timeline from the remaining paid orders. Passes start after the trial.
            purchases = db.execute("""SELECT o.*, COALESCE(SUM(r.paise),0) refunded
                FROM orders o LEFT JOIN refunds r ON o.id=r.order_id
                WHERE account=? AND product=? AND paid_at IS NOT NULL GROUP BY o.id
                ORDER BY paid_at, o.rowid""", (order["account"], order["product"])).fetchall()
            expiry = self._trial(db, order["account"], order["product"]) or 0
            for purchase in purchases:
                end = None
                if purchase["refunded"] < purchase["paise"]:
                    expiry = max(expiry, purchase["paid_at"]) + purchase["days"] * 86400
                    end = expiry
                db.execute("UPDATE orders SET expires_at=? WHERE id=?", (end, purchase["id"]))
        return True

    @staticmethod
    def _trial(db, account, product):
        row = db.execute("SELECT ends_at FROM trials WHERE account=? AND product=?", (account, product)).fetchone()
        return row and row[0]

    @staticmethod
    def _paid(db, account, product):
        return db.execute("SELECT MAX(expires_at) FROM orders WHERE account=? AND product=?",
                          (account, product)).fetchone()[0]

    @classmethod
    def _expiry(cls, db, account, product):
        """When access ends: the later of the trial and the paid passes (bought during a trial, they start after it)."""
        ends = [e for e in (cls._paid(db, account, product), cls._trial(db, account, product)) if e]
        return max(ends) if ends else None

    def expiry(self, account, product):
        with self.connection() as db:
            return self._expiry(db, account, product)

    def access(self, account, product):
        """{expires, trial}: trial is true when only the free trial gave access (no pass bought)."""
        with self.connection() as db:
            return {"expires": self._expiry(db, account, product),
                    "trial": not self._paid(db, account, product) and bool(self._trial(db, account, product))}
