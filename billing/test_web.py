import base64
import hmac
import io
import json
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import parse_qs, urlencode, urlsplit

from billing.web import Billing, Ledger, challenge, digest


class WebTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ledger = Ledger(Path(tmp.name) / "ledger")
        self.ledger.add_offer("sendoff", "trial", 4999, 7)
        self.gateway = Mock()
        self.origin = "https://merchant.example"
        self.app = Billing(self.ledger, self.gateway, self.origin, "a" * 32, {"sendoff": "trial"}, "fixture")
        self.gateway.create.return_value = {"payment_session_id": "fixture-session"}

    def call(self, path, method="GET", body=b"", user="alice", **env):
        url = urlsplit(path)
        env.update(PATH_INFO=url.path, QUERY_STRING=url.query, REQUEST_METHOD=method,
                   HTTP_HOST="merchant.example", CONTENT_LENGTH=str(len(body)), REMOTE_USER=user)
        env["wsgi.input"] = io.BytesIO(body)
        self.headers = {}
        def start(status, heads):
            self.status = int(status.split()[0])
            self.headers.update(heads)
        return b"".join(self.app(env, start)).decode()

    def sign_in(self, verifier="A" * 43, **env):
        """The extension's sign-in: /authorize (through Google when configured), then /token. Its session token."""
        self.call("/authorize?" + urlencode(dict(challenge=challenge(verifier), state="b"*40)), **env)
        redirect = urlsplit(self.headers["Location"])
        if redirect.hostname == "accounts.example":  # Google: the person signs in there and it comes back
            back = parse_qs(redirect.query)
            self.call("/auth/google?" + urlencode(dict(code="google-code", state=back["state"][0])), user=None)
            redirect = urlsplit(self.headers["Location"])
        self.assertEqual(redirect.hostname, "a"*32 + ".chromiumapp.org")
        self.assertEqual(parse_qs(redirect.query)["state"], ["b"*40])
        code = parse_qs(redirect.query)["code"][0]
        return json.loads(self.call("/token", "POST", json.dumps(dict(code=code, verifier=verifier)).encode()))["token"]

    def test_account_restore_and_logout(self):
        verifier = "A" * 43
        self.call("/authorize?" + urlencode(dict(challenge=challenge(verifier), state="b"*40)))
        redirect = urlsplit(self.headers["Location"])
        self.assertEqual(redirect.hostname, "a"*32 + ".chromiumapp.org")
        code = parse_qs(redirect.query)["code"][0]
        def exchange(v):
            return self.call("/token", "POST", json.dumps(dict(code=code, verifier=v)).encode())
        exchange("wrong")
        self.assertEqual(self.status, 403)
        token = json.loads(exchange(verifier))["token"]
        exchange(verifier)
        self.assertEqual(self.status, 403)
        auth = dict(HTTP_AUTHORIZATION="Bearer " + token)
        access = json.loads(self.call("/access?product=sendoff", **auth))
        self.assertIsNone(access["expires"])
        self.assertEqual(access["offer"], {"paise": 4999, "days": 7})
        self.call("/access?product=another", **auth)
        self.assertEqual(self.status, 403)
        self.call("/logout", "POST", **auth)
        self.call("/access?product=sendoff", **auth)
        self.assertEqual(self.status, 403)

    def test_google_sign_in_trial_and_checkout_link(self):
        google = Mock()
        google.url.side_effect = lambda redirect, state, nonce: "https://accounts.example/auth?" + urlencode(dict(state=state))
        google.account.return_value = ("google-subject", "asha@example.test")
        self.app = Billing(self.ledger, self.gateway, self.origin, "a" * 32, {"sendoff": "trial"}, "fixture",
                           google=google, trials={"sendoff": 7})
        # cancelled on Google's page: the extension hears so, and that sign-in can't be used again
        self.call("/authorize?" + urlencode(dict(challenge=challenge("A"*43), state="b"*40)), user=None)
        state = parse_qs(urlsplit(self.headers["Location"]).query)["state"][0]
        self.call("/auth/google?" + urlencode(dict(error="access_denied", state=state)), user=None)
        self.assertEqual(parse_qs(urlsplit(self.headers["Location"]).query)["error"], ["access_denied"])
        self.call("/auth/google?" + urlencode(dict(code="x", state=state)), user=None)
        self.assertEqual(self.status, 403)

        token = self.sign_in(user=None)
        self.assertEqual(google.account.call_args.args[1], self.origin + "/auth/google")
        auth = dict(HTTP_AUTHORIZATION="Bearer " + token)
        access = json.loads(self.call("/access?product=sendoff", user=None, **auth))
        self.assertTrue(access["trial"])
        self.assertEqual(access["email"], "asha@example.test")
        self.assertAlmostEqual(access["expires"], time.time() + 7 * 86400, delta=5)
        # signing in again (another device, reinstall) keeps the first trial
        account = digest("google:google-subject")[:48]
        with self.ledger.connection() as db:
            db.execute("UPDATE trials SET ends_at=? WHERE account=?", (int(time.time()) - 60, account))
        self.sign_in(user=None)
        access = json.loads(self.call("/access?product=sendoff", user=None, **auth))
        self.assertLess(access["expires"], time.time())

        # Buy pass: a one-time link signs the checkout tab in as this account
        link = json.loads(self.call("/checkout/start?product=sendoff", "POST", user=None, **auth))["url"]
        self.assertTrue(link.startswith(self.origin + "/checkout?"))
        self.call(urlsplit(link).path + "?" + urlsplit(link).query, user=None)
        self.assertEqual(self.status, 303)
        self.assertEqual(self.headers["Location"], "/checkout?product=sendoff")
        cookie = self.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.call(urlsplit(link).path + "?" + urlsplit(link).query, user=None)
        self.assertEqual(self.status, 403)  # used once
        browser = dict(HTTP_COOKIE=cookie.split(";")[0])
        page = self.call("/checkout?product=sendoff", user=None, **browser)
        self.assertIn("asha@example.test", page)
        self.call("/checkout?product=sendoff", user=None)
        self.assertEqual(self.status, 403)  # not without the link
        body = urlencode(dict(retry=str(uuid.uuid4()), phone="9999999999", version="trial")).encode()
        self.call("/checkout?product=sendoff", "POST", body, user=None, HTTP_ORIGIN=self.origin, **browser)
        order = self.gateway.create.call_args.args[0]
        self.assertEqual(order["account"], account)
        self.gateway.get.return_value = dict(order_id=order["id"], order_currency="INR", order_amount=49.99, order_status="PAID")
        self.assertIn("Payment confirmed", self.call("/receipt?id=" + order["id"], user=None, **browser))
        access = json.loads(self.call("/access?product=sendoff", user=None, **auth))
        self.assertFalse(access["trial"])
        self.assertAlmostEqual(access["expires"], time.time() + 7 * 86400, delta=5)

    def test_session_renews_while_used(self):
        token = self.sign_in()
        auth = dict(HTTP_AUTHORIZATION="Bearer " + token)
        with self.ledger.connection() as db:
            db.execute("UPDATE credentials SET expiry=? WHERE kind='session'", (int(time.time()) + 86400,))
        self.call("/access?product=sendoff", **auth)
        with self.ledger.connection() as db:
            expiry = db.execute("SELECT expiry FROM credentials WHERE kind='session'").fetchone()[0]
        self.assertGreater(expiry, time.time() + 29 * 86400)
        with self.ledger.connection() as db:
            db.execute("UPDATE credentials SET expiry=? WHERE kind='session'", (int(time.time()) - 1,))
        self.call("/access?product=sendoff", **auth)
        self.assertEqual(self.status, 403)

    def test_offer_is_public(self):
        self.app.trials = {"sendoff": 7}
        self.assertEqual(json.loads(self.call("/offer?product=sendoff", user=None)),
                         {"offer": {"paise": 4999, "days": 7}, "trial_days": 7})
        self.assertIn("7-day free trial", self.call("/", user=None))

    def test_live_checkout_requires_seller_and_displays_terms(self):
        with self.assertRaises(ValueError):
            Billing(self.ledger, self.gateway, self.origin, "a"*32, {}, "fixture", "production")
        with self.assertRaises(ValueError):  # without Google sign-in
            Billing(self.ledger, self.gateway, self.origin, "a"*32, {}, "fixture", "production",
                    dict(name="n", support="s", description="d", terms="t", refunds="r", privacy="p"))
        self.app = Billing(self.ledger, self.gateway, self.origin, "a"*32, {"sendoff": "trial"}, "fixture",
                           "production", dict(name="Example seller", support="help@example.test",
                                              description="All Sendoff features", terms="One-time pass", refunds="Refund terms", privacy="Account data"),
                           google=Mock())
        page = self.call("/checkout?product=sendoff")
        for value in ("Example seller", "All Sendoff features", "/refunds", "/terms", "49.99"):
            self.assertIn(value, page)
        self.assertNotIn("sandbox", page)
        self.assertIn("Refund terms", self.call("/refunds", user=None))
        self.assertIn("49.99", self.call("/", user=None))
        self.assertIn('mode:"production"', self.call("/checkout.js"))

    def test_checkout_payment_and_refund(self):
        retry = str(uuid.uuid4())
        body = urlencode(dict(retry=retry, phone="9999999999", version="trial")).encode()
        url = "/checkout?product=sendoff"
        self.assertIn("49.99", self.call(url))
        self.call(url, "POST", body, HTTP_ORIGIN="https://other.example")
        self.assertEqual(self.status, 403)
        self.assertIn("fixture-session", self.call(url, "POST", body, HTTP_ORIGIN=self.origin))
        # Cashfree's script submits a form to its own site: the page must allow that, and nothing else off-site
        policy = self.headers["Content-Security-Policy"]
        self.assertIn("form-action 'self' https://*.cashfree.com;", policy)
        self.assertIn("script-src 'self' https://sdk.cashfree.com;", policy)
        order = self.gateway.create.call_args.args[0]
        key = order["id"]
        self.call("/receipt?id=" + key, user="bob")
        self.assertEqual(self.status, 403)
        self.gateway.get.return_value = dict(order_id=key, order_currency="INR", order_amount=49.99, order_status="PAID")
        def notify(event, valid=True):
            raw = json.dumps(event).encode()
            signature = base64.b64encode(hmac.digest(b"fixture", b"123" + raw, "sha256")).decode()
            self.call("/webhook", "POST", raw, user=None, HTTP_X_WEBHOOK_TIMESTAMP="123",
                      HTTP_X_WEBHOOK_SIGNATURE=signature if valid else "wrong")
        event = dict(type="PAYMENT_SUCCESS_WEBHOOK", data=dict(order=dict(order_id=key),
                     payment=dict(cf_payment_id="123", payment_status="SUCCESS")))
        notify(event, False)
        self.assertEqual(self.status, 403)
        self.assertIsNone(self.ledger.expiry(digest("alice")[:48], "sendoff"))
        notify(event)
        notify(event)
        self.assertEqual(self.gateway.get.call_count, 1)
        self.assertTrue(self.ledger.expiry(digest("alice")[:48], "sendoff"))
        refund = dict(refund_id="r1", order_id=key, refund_amount=49.99, refund_currency="INR", refund_status="SUCCESS")
        self.gateway.refund.return_value = refund
        from urllib.error import URLError
        from billing.recovery import sweep
        self.gateway.refund.side_effect = URLError("temporary outage")
        notify(dict(type="REFUND_STATUS_WEBHOOK", data=dict(refund=refund)))
        self.assertEqual(self.status, 503)
        self.gateway.refund.side_effect = None
        self.assertEqual(sweep(self.app), 0)
        self.assertIsNone(self.ledger.expiry(digest("alice")[:48], "sendoff"))
        self.app.offers.clear()
        self.call(url, "POST", body, HTTP_ORIGIN=self.origin)
        self.assertEqual(self.status, 503)

    def checkout(self, user="alice", **form):
        body = urlencode(dict(dict(retry=str(uuid.uuid4()), phone="9999999999", version="trial"), **form)).encode()
        self.call("/checkout?product=sendoff", "POST", body, user=user, HTTP_ORIGIN=self.origin)
        return self.gateway.create.call_args.args[0] if self.status == 200 else None

    def notify(self, order_id, status, payment="p1"):
        raw = json.dumps(dict(type=f"PAYMENT_{dict(SUCCESS='SUCCESS', FAILED='FAILED')[status]}_WEBHOOK",
                              data=dict(order=dict(order_id=order_id),
                                        payment=dict(cf_payment_id=payment, payment_status=status)))).encode()
        signature = base64.b64encode(hmac.digest(b"fixture", b"123" + raw, "sha256")).decode()
        self.call("/webhook", "POST", raw, user=None, HTTP_X_WEBHOOK_TIMESTAMP="123", HTTP_X_WEBHOOK_SIGNATURE=signature)

    def test_out_of_order_and_interrupted_notifications(self):
        from urllib.error import URLError
        from billing.recovery import sweep
        alice = digest("alice")[:48]
        order = self.checkout()
        paid = dict(order_id=order["id"], order_currency="INR", order_amount=49.99, order_status="PAID")
        # a failed attempt, then a retry that succeeds, its notification arriving before the failure's
        self.gateway.get.return_value = paid
        self.notify(order["id"], "SUCCESS", "p2")
        self.notify(order["id"], "FAILED", "p1")
        self.assertEqual(self.status, 200)
        granted = self.ledger.expiry(alice, "sendoff")
        self.assertTrue(granted)
        self.notify(order["id"], "SUCCESS", "p2")  # a duplicate grants nothing more
        self.assertEqual(self.ledger.expiry(alice, "sendoff"), granted)

        # Cashfree unreachable between receiving the notification and granting: kept, then granted by the sweep
        second = self.checkout()
        self.gateway.get.side_effect = URLError("outage")
        self.notify(second["id"], "SUCCESS")
        self.assertEqual(self.status, 503)
        self.assertEqual(self.ledger.expiry(alice, "sendoff"), granted)
        self.gateway.get.side_effect = None
        self.gateway.get.return_value = dict(paid, order_id=second["id"])
        self.assertEqual(sweep(self.app), 0)
        self.assertEqual(self.ledger.expiry(alice, "sendoff"), granted + 7 * 86400)
        self.assertEqual(self.ledger.problems(), {"paid without access": 0, "notifications waiting": 0,
                                                  "refunds waiting": 0, "orders awaiting payment": 0})

    def test_sweep_skips_orders_cashfree_never_created(self):
        from urllib.error import HTTPError
        from billing.recovery import sweep
        self.checkout()
        self.gateway.get.side_effect = HTTPError("u", 404, "Not found", {}, None)
        self.assertEqual(sweep(self.app), 0)
        self.gateway.get.side_effect = HTTPError("u", 500, "Error", {}, None)
        self.assertEqual(sweep(self.app), 1)

    def test_client_cannot_change_price_or_product(self):
        self.assertIsNone(self.checkout(version="cheaper"))
        self.assertEqual(self.status, 400)
        self.assertIsNone(self.checkout(phone="12345"))
        self.assertEqual(self.status, 400)
        order = self.checkout()
        self.assertEqual((order["paise"], order["product"]), (4999, "sendoff"))
        # Cashfree reporting a different amount grants nothing
        self.gateway.get.return_value = dict(order_id=order["id"], order_currency="INR", order_amount=1, order_status="PAID")
        self.call("/receipt?id=" + order["id"])
        self.assertEqual(self.status, 400)
        self.assertIsNone(self.ledger.expiry(digest("alice")[:48], "sendoff"))

    def test_products_are_isolated(self):
        self.ledger.add_offer("other", "v1", 19900, 30)
        self.app = Billing(self.ledger, self.gateway, self.origin, {"sendoff": "a" * 32, "other": "b" * 32},
                           {"sendoff": "trial", "other": "v1"}, "fixture", trials={"sendoff": 7, "other": 7})
        token = self.sign_in()
        auth = dict(HTTP_AUTHORIZATION="Bearer " + token)
        for path in ("/access?product=other", "/checkout/start?product=other"):
            self.call(path, "POST" if "start" in path else "GET", **auth)
            self.assertEqual(self.status, 403)
        order = self.checkout()
        self.gateway.get.return_value = dict(order_id=order["id"], order_currency="INR", order_amount=49.99,
                                             order_status="PAID")
        self.call("/receipt?id=" + order["id"])
        alice = digest("alice")[:48]
        self.assertGreater(self.ledger.expiry(alice, "sendoff"), time.time() + 7 * 86400)
        self.assertIsNone(self.ledger.expiry(alice, "other"))

    def test_pause_switch(self):
        token = self.sign_in()
        auth = dict(HTTP_AUTHORIZATION="Bearer " + token)
        order = self.checkout()
        self.ledger.pause("sendoff")
        self.assertIsNone(json.loads(self.call("/access?product=sendoff", **auth))["offer"])
        self.assertNotIn("49.99", self.call("/", user=None))
        self.assertIsNone(self.checkout())
        self.assertEqual(self.status, 503)
        # an order already placed is still confirmed while paused
        self.gateway.get.return_value = dict(order_id=order["id"], order_currency="INR", order_amount=49.99,
                                             order_status="PAID")
        self.assertIn("Payment confirmed", self.call("/receipt?id=" + order["id"]))
        self.ledger.pause("sendoff", False)
        self.assertTrue(self.checkout())

