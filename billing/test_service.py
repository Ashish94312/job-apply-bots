import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock

from billing.service import Ledger


class BillingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.ledger = Ledger(Path(directory.name) / "test.sqlite")
        self.ledger.add_offer("sendoff", "test", 1099, 30)
        self.order = self.ledger.order("alice", "sendoff", "test", "purchase")
        self.gateway = Mock()
        self.gateway.get.return_value = dict(order_id=self.order["id"], order_currency="INR",
                                             order_amount=10.99, order_status="PAID")

    def check(self):
        return self.ledger.reconcile(self.gateway, self.order["id"])

    def test_refunding_first_purchase_preserves_renewal(self):
        self.assertTrue(self.check())
        first = self.order["id"]
        self.order = self.ledger.order("alice", "sendoff", "test", "renewal")
        self.gateway.get.return_value["order_id"] = self.order["id"]
        self.assertTrue(self.check())
        before = self.ledger.expiry("alice", "sendoff")
        for name, amount in (("r1", 4), ("r2", 6.99), ("r2", 6.99)):
            self.gateway.refund.return_value = dict(order_id=first, refund_id=name, refund_currency="INR",
                                                   refund_status="SUCCESS", refund_amount=amount)
            self.ledger.reconcile_refund(self.gateway, first, name)
            if name == "r1":
                self.assertEqual(self.ledger.expiry("alice", "sendoff"), before)
        renewed = self.ledger.order("alice", "sendoff", "test", "renewal")
        self.assertEqual(self.ledger.expiry("alice", "sendoff"), renewed["paid_at"] + 30 * 86400)

    def test_retry(self):
        self.assertEqual(self.order, self.ledger.order("alice", "sendoff", "test", "purchase"))
        with self.assertRaises(ValueError):
            self.ledger.order("alice", "other", "test", "purchase")

    def test_pending_and_mismatch(self):
        remote = self.gateway.get.return_value
        for name, value in (("order_amount", 11), ("order_currency", "USD"), ("order_id", "different")):
            with self.subTest(name=name):
                original = remote[name]
                remote[name] = value
                with self.assertRaises(ValueError):
                    self.check()
                remote[name] = original
        remote["order_status"] = "ACTIVE"
        self.assertFalse(self.check())
        self.assertIsNone(self.ledger.expiry("alice", "sendoff"))

    def test_concurrent_confirmation_and_renewal(self):
        with ThreadPoolExecutor(4) as pool:
            self.assertTrue(all(pool.map(lambda _: self.check(), range(8))))
        paid = self.ledger.order("alice", "sendoff", "test", "purchase")
        self.assertEqual(paid["expires_at"] - paid["paid_at"], 30 * 86400)
        self.assertIsNone(self.ledger.expiry("bob", "sendoff"))
        self.assertIsNone(self.ledger.expiry("alice", "other"))
        self.order = self.ledger.order("alice", "sendoff", "test", "renew")
        self.gateway.get.return_value["order_id"] = self.order["id"]
        self.check()
        self.assertEqual(self.ledger.expiry("alice", "sendoff"), paid["expires_at"] + 30 * 86400)

    def test_trial_then_pass_starts_after_it(self):
        self.ledger.start_trial("carol", "sendoff", 7)
        trial_end = self.ledger.expiry("carol", "sendoff")
        self.ledger.start_trial("carol", "sendoff", 7)  # a second sign-in keeps the first trial
        self.assertEqual(self.ledger.expiry("carol", "sendoff"), trial_end)
        self.assertTrue(self.ledger.access("carol", "sendoff")["trial"])
        self.order = self.ledger.order("carol", "sendoff", "test", "during-trial")
        self.gateway.get.return_value["order_id"] = self.order["id"]
        self.assertTrue(self.check())
        self.assertEqual(self.ledger.access("carol", "sendoff"), {"expires": trial_end + 30 * 86400, "trial": False})
        self.gateway.refund.return_value = dict(order_id=self.order["id"], refund_id="all", refund_currency="INR",
                                               refund_status="SUCCESS", refund_amount=10.99)
        self.ledger.reconcile_refund(self.gateway, self.order["id"], "all")
        self.assertEqual(self.ledger.expiry("carol", "sendoff"), trial_end)
        self.assertIsNone(self.ledger.expiry("alice", "sendoff"))  # trials belong to one account
