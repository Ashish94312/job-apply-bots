"""Billing WSGI application. People sign in with Google from the extension; checkout pages are opened from there.

A trusted REMOTE_USER (set by the server, never from a request header) also identifies an account: the local fixture
uses it."""
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
import uuid
from http import HTTPStatus
from http.cookies import SimpleCookie
from urllib.error import URLError
from urllib.parse import parse_qs, urlencode, urlsplit

from .service import CashfreeProduction, CashfreeSandbox, Ledger

SESSION_TTL = 30 * 86400  # the extension's sign-in; renewed while in use, so only 30 days unused end it
WEB_TTL = 7200  # a checkout tab's sign-in, given by a one-time link from the extension
COOKIE = "sendoff_checkout"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def challenge(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


class Denied(Exception):
    pass


class Billing:
    def __init__(self, ledger, gateway, origin, extension_id, offers, secret, mode="sandbox", seller=None,
                 google=None, trials=None):
        clients = extension_id if isinstance(extension_id, dict) else {"sendoff": extension_id}
        if not clients or not all(re.fullmatch("[a-p]{32}", value) for value in clients.values()) or not secret:
            raise ValueError("Configure the extension ID and Cashfree sandbox secret")
        if not (re.fullmatch(r"https://[a-z0-9.-]+", origin) or origin == "http://127.0.0.1:8766"):
            raise ValueError("Configure an HTTPS billing origin")
        self.ledger, self.gateway, self.origin = ledger, gateway, origin
        self.redirects = {product: f"https://{client}.chromiumapp.org/billing" for product, client in clients.items()}
        self.offers, self.secret = offers, secret
        self.mode, self.seller = mode, seller or {}
        self.google, self.trials = google, trials or {}
        if mode not in ("production", "sandbox"):
            raise ValueError("Invalid payment environment")
        if mode == "production" and (not origin.startswith("https://") or not google or
                not all(self.seller.get(k) for k in ("name", "support", "description", "terms", "refunds", "privacy"))):
            raise ValueError("Live checkout requires Google sign-in, seller details, product description and HTTPS")
        with ledger.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS credentials (
                  hash TEXT PRIMARY KEY, kind TEXT, account TEXT, challenge TEXT, expiry INTEGER);
                CREATE TABLE IF NOT EXISTS pending_refunds (
                  order_id TEXT, refund_id TEXT, PRIMARY KEY(order_id, refund_id));
                CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT);
                CREATE TABLE IF NOT EXISTS notifications (
                  event_hash TEXT PRIMARY KEY, order_id TEXT, attempt TEXT, status TEXT, done INTEGER DEFAULT 0);
            """)

            if "product" not in {r["name"] for r in db.execute("PRAGMA table_info(credentials)")}:
                db.execute("ALTER TABLE credentials ADD COLUMN product TEXT NOT NULL DEFAULT 'sendoff'")

    def offer(self, product):
        """The offer on sale for a product, or None while its purchases are paused."""
        with self.ledger.connection() as db:
            row = db.execute("SELECT paise, days FROM offers WHERE product=? AND version=?",
                             (product, self.offers.get(product))).fetchone()
        return dict(row) if row else None

    def email(self, account):
        with self.ledger.connection() as db:
            row = db.execute("SELECT email FROM accounts WHERE id=?", (account,)).fetchone()
        return row[0] if row else ""

    def web_account(self, env, product):
        """The account a checkout page is for: the trusted REMOTE_USER, else the sign-in its one-time link gave."""
        if env.get("REMOTE_USER"):
            return digest(env["REMOTE_USER"])[:48]
        cookie = SimpleCookie(env.get("HTTP_COOKIE", "")).get(COOKIE)
        if cookie:
            with self.ledger.connection() as db:
                row = self.credential(db, cookie.value, "web")
            if product is None or row["product"] == product:
                return row["account"]
        raise Denied()

    def to_extension(self, product, **params):
        return 302, "text/plain", "", [("Location", self.redirects[product] + "?" + urlencode(params))]

    def token(self, db, kind, account, product, ttl, proof=""):
        value = secrets.token_urlsafe(32)
        db.execute("DELETE FROM credentials WHERE expiry<=?", (time.time(),))
        db.execute("INSERT INTO credentials(hash,kind,account,challenge,expiry,product) VALUES (?,?,?,?,?,?)",
                   (digest(value), kind, account, proof, int(time.time()) + ttl, product))
        return value

    def credential(self, db, value, kind):
        row = db.execute("SELECT * FROM credentials WHERE hash=? AND kind=? AND expiry>?",
                         (digest(value), kind, time.time())).fetchone()
        if not row:
            raise Denied()
        return row

    def __call__(self, env, start):
        try:
            status, mime, body, extra = self.route(env)
        except Denied:
            status, mime, body, extra = 403, "text/plain", "Sign in again from the Sendoff dashboard.", []
        except (ValueError, KeyError, TypeError, IndexError):
            status, mime, body, extra = 400, "text/plain", "Invalid billing request.", []
        except (URLError, TimeoutError):
            status, mime, body, extra = 503, "text/plain", "Payment confirmation unavailable. Try again.", []
        headers = [("Content-Type", mime), ("Cache-Control", "no-store"),
                   ("Referrer-Policy", "same-origin"), ("X-Content-Type-Options", "nosniff"),
                   ("Content-Security-Policy", "default-src 'none'; script-src 'self' https://sdk.cashfree.com; "
                    "frame-src https://*.cashfree.com; connect-src 'self' https://*.cashfree.com; "
                    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")]
        start(f"{status} {HTTPStatus(status).phrase}", headers + extra)
        return [body.encode()]

    def route(self, env):
        path, method = env["PATH_INFO"], env["REQUEST_METHOD"]
        if (method, path) == ("GET", "/healthz"):  # the host's health check, which may use another Host header
            return 200, "text/plain", "ok", []
        if env.get("HTTP_HOST") != urlsplit(self.origin).netloc:
            raise Denied()
        length = int(env.get("CONTENT_LENGTH") or 0)
        if not 0 <= length <= 65536:
            raise ValueError()
        raw = env["wsgi.input"].read(length)
        query = {k: v[0] for k, v in parse_qs(env.get("QUERY_STRING", "")).items()}
        if (method, path) == ("POST", "/webhook"):
            self.webhook(env, raw)
            return 200, "text/plain", "OK", []
        if (method, path) == ("POST", "/token"):
            data = json.loads(raw)
            with self.ledger.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                row = self.credential(db, data["code"], "code")
                if not hmac.compare_digest(challenge(data["verifier"]), row["challenge"]):
                    raise Denied()
                db.execute("DELETE FROM credentials WHERE hash=?", (row["hash"],))
                token = self.token(db, "session", row["account"], row["product"], SESSION_TTL)
            self.ledger.start_trial(row["account"], row["product"], self.trials.get(row["product"], 0))
            return 200, "application/json", json.dumps({"token": token}), []
        if (method, path) == ("GET", "/offer"):
            offer = self.offer(query["product"])
            trial = self.trials.get(query["product"], 0)
            return 200, "application/json", json.dumps({"offer": offer, "trial_days": trial}), []
        if (method, path) in (("GET", "/access"), ("POST", "/logout"), ("POST", "/checkout/start")):
            with self.ledger.connection() as db:
                session = self.credential(db, env.get("HTTP_AUTHORIZATION", "").removeprefix("Bearer "), "session")
                if path == "/logout":
                    db.execute("DELETE FROM credentials WHERE hash=?", (session["hash"],))
                    return 204, "text/plain", "", []
                product = query["product"]
                if session["product"] != product:
                    raise Denied()
                if path == "/checkout/start":
                    code = self.token(db, "checkout", session["account"], product, 600)
                    url = self.origin + "/checkout?" + urlencode(dict(product=product, code=code))
                    return 200, "application/json", json.dumps({"url": url}), []
                if session["expiry"] - time.time() < SESSION_TTL / 2:
                    db.execute("UPDATE credentials SET expiry=? WHERE hash=?",
                               (int(time.time()) + SESSION_TTL, session["hash"]))
            access = self.ledger.access(session["account"], product)
            access.update(email=self.email(session["account"]), offer=self.offer(product))
            return 200, "application/json", json.dumps(access), []
        if method == "GET" and path in ("/", "/terms", "/refunds", "/privacy", "/contact"):
            return self.public_page(path)
        if (method, path) == ("GET", "/checkout.js"):
            return 200, "text/javascript", (
                f"Cashfree({{mode:{json.dumps(self.mode)}}}).checkout({{paymentSessionId:document.body.dataset.session,"
                "redirectTarget:'_self'}).catch(()=>document.body.textContent='Checkout unavailable. Please retry.');"), []
        if (method, path) == ("GET", "/authorize"):
            if not all(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", query[k]) for k in ("challenge", "state")):
                raise ValueError()
            product = query.get("product", "sendoff")
            if product not in self.redirects:
                raise Denied()
            if self.google:
                # Google signs the person in, then /auth/google gives the extension its code.
                nonce = secrets.token_urlsafe(16)
                pending = json.dumps(dict(challenge=query["challenge"], state=query["state"], nonce=nonce))
                with self.ledger.connection() as db:
                    login = self.token(db, "login", "", product, 600, pending)
                return 302, "text/plain", "", [("Location", self.google.url(self.origin + "/auth/google", login, nonce))]
            account = self.web_account(env, None)
            with self.ledger.connection() as db:
                code = self.token(db, "code", account, product, 90, query["challenge"])
            return self.to_extension(product, code=code, state=query["state"])
        if (method, path) == ("GET", "/auth/google") and self.google:
            with self.ledger.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                row = self.credential(db, query["state"], "login")
                db.execute("DELETE FROM credentials WHERE hash=?", (row["hash"],))
            pending, product = json.loads(row["challenge"]), row["product"]
            if "code" not in query:  # they cancelled on Google's page
                return self.to_extension(product, error="access_denied", state=pending["state"])
            subject, email = self.google.account(query["code"], self.origin + "/auth/google", pending["nonce"])
            account = digest("google:" + subject)[:48]
            with self.ledger.connection() as db:
                db.execute("INSERT INTO accounts VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email",
                           (account, email))
                code = self.token(db, "code", account, product, 90, pending["challenge"])
            return self.to_extension(product, code=code, state=pending["state"])
        if (method, path) == ("GET", "/checkout") and "code" in query:
            # The one-time link from the extension's Upgrade: sign this tab in as that account, then drop the code.
            with self.ledger.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                row = self.credential(db, query["code"], "checkout")
                db.execute("DELETE FROM credentials WHERE hash=?", (row["hash"],))
                if row["product"] != query["product"]:
                    raise Denied()
                web = self.token(db, "web", row["account"], row["product"], WEB_TTL)
            cookie = f"{COOKIE}={web}; Path=/; HttpOnly; SameSite=Lax; Max-Age={WEB_TTL}"
            if self.origin.startswith("https://"):
                cookie += "; Secure"
            return 303, "text/plain", "", [("Location", "/checkout?" + urlencode(dict(product=row["product"]))),
                                           ("Set-Cookie", cookie)]
        if method == "POST" and env.get("HTTP_ORIGIN") != self.origin:
            raise Denied()
        form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
        if (method, path) == ("GET", "/receipt"):
            account = self.web_account(env, None)
            with self.ledger.connection() as db:
                owned = db.execute("SELECT 1 FROM orders WHERE account=? AND id=?", (account, query["id"])).fetchone()
            if not owned:
                raise Denied()
            paid = self.ledger.reconcile(self.gateway, query["id"])
            return 200, "text/plain; charset=utf-8", (
                "Payment confirmed. Your pass is active: go back to the Sendoff dashboard." if paid else
                "Payment not confirmed yet. If you paid, refresh this page in a minute: Sendoff unlocks once Cashfree "
                "confirms it. If the payment failed, close this tab and choose Buy pass in Sendoff again."), []
        if path != "/checkout" or method not in ("GET", "POST"):
            return 404, "text/plain", "Page unavailable.", []
        product = query["product"]
        account = self.web_account(env, product)
        version = self.offers.get(product)
        offer = self.offer(product)
        if not offer:
            return 503, "text/plain", "Purchases are paused for this product.", []
        if method == "GET":
            label = " sandbox" if self.mode == "sandbox" else ""
            seller_info = ""
            if self.mode == "production":
                seller_info = (f"<p>{html.escape(self.seller['description'])}</p>"
                               f"<p>Sold by {html.escape(self.seller['name'])}. Support: {html.escape(self.seller['support'])}</p>"
                               "<a href='/terms'>Terms</a> · <a href='/refunds'>Refunds</a> · <a href='/privacy'>Privacy</a>")
            email = self.email(account)
            buyer = f"<p>For the Sendoff account {html.escape(email)}</p>" if email else ""
            phone_label = "Test billing phone" if self.mode == "sandbox" else "Billing phone"
            page = (f"<!doctype html><meta charset=utf-8><title>Checkout</title>"
                    f"<h1>{html.escape(product)}{label} pass</h1>{buyer}{seller_info}"
                    f"<p>₹{offer['paise']/100:.2f} for {offer['days']} days. One payment, manual renewal.</p>"
                    f"<form method=post><input type=hidden name=retry value='{uuid.uuid4()}'>"
                    f"<input type=hidden name=version value='{html.escape(version, quote=True)}'>"
                    f"<label>{phone_label} <input required name=phone pattern='[0-9]{{10}}'></label> "
                    f"<button>Continue to Cashfree{label}</button></form>")
        else:
            if form["version"] != version or not re.fullmatch("[0-9]{10}", form["phone"]):
                raise ValueError()
            order = self.ledger.order(account, product, version, str(uuid.UUID(form["retry"])))
            result = self.gateway.create(order, form["phone"], self.origin)
            session = html.escape(result["payment_session_id"], quote=True)
            page = (f"<!doctype html><meta charset=utf-8><title>Cashfree checkout</title><body data-session='{session}'>"
                    "Opening checkout…<script src='https://sdk.cashfree.com/js/v3/cashfree.js'></script>"
                    "<script src='/checkout.js'></script></body>")
        return 200, "text/html; charset=utf-8", page, []

    def public_page(self, path):
        names = {"/terms": "Terms and conditions", "/refunds": "Refunds and cancellations",
                 "/privacy": "Privacy policy", "/contact": "Contact us"}
        links = " · ".join(f'<a href="{url}">{name}</a>' for url, name in names.items())
        seller = html.escape(self.seller.get("name", "Sandbox merchant"))
        if path == "/":
            title = seller
            rows = []
            with self.ledger.connection() as db:
                for product, version in self.offers.items():
                    offer = db.execute("SELECT * FROM offers WHERE product=? AND version=?", (product, version)).fetchone()
                    if offer:
                        trial = self.trials.get(product, 0)
                        rows.append(f'<li>{html.escape(product)} · ₹{offer["paise"]/100:.2f}'
                                    f' · {offer["days"]} days · manual renewal'
                                    f'{f" · {trial}-day free trial first" if trial else ""}</li>')
            description = html.escape(self.seller.get("description", "Test access passes"))
            content = (f"<p>{description}</p><ul>{''.join(rows)}</ul>"
                       "<p>Sign in with Google and buy from the extension's dashboard.</p>")
        else:
            title = names[path]
            key = "support" if path == "/contact" else path[1:]
            content = "".join("<p>" + html.escape(line) + "</p>" for line in
                              self.seller.get(key, "Sandbox test service.").splitlines())
        body = (f"<!doctype html><meta charset=utf-8><title>{title}</title><main><h1>{title}</h1>"
                f"{content}</main><footer>{seller} · {links}</footer>")
        return 200, "text/html; charset=utf-8", body, []

    def process_refund(self, order_id, refund_id):
        if not self.ledger.reconcile_refund(self.gateway, order_id, refund_id):
            raise URLError("Refund pending")
        with self.ledger.connection() as db:
            db.execute("DELETE FROM pending_refunds WHERE order_id=? AND refund_id=?", (order_id, refund_id))

    def webhook(self, env, raw):
        ts = env.get("HTTP_X_WEBHOOK_TIMESTAMP", "")
        expected = base64.b64encode(hmac.digest(self.secret.encode(), ts.encode() + raw, "sha256")).decode()
        if not ts.isdigit() or not hmac.compare_digest(expected, env.get("HTTP_X_WEBHOOK_SIGNATURE", "")):
            raise Denied()
        event = json.loads(raw)
        if event["type"] == "REFUND_STATUS_WEBHOOK":
            refund = event["data"]["refund"]
            if refund["refund_status"] == "SUCCESS":
                with self.ledger.connection() as db:
                    known = db.execute("SELECT 1 FROM orders WHERE id=?", (refund["order_id"],)).fetchone()
                    if known:
                        db.execute("INSERT OR IGNORE INTO pending_refunds VALUES (?,?)",
                                   (refund["order_id"], refund["refund_id"]))
                if known:
                    self.process_refund(refund["order_id"], refund["refund_id"])
            return
        if event["type"] not in ("PAYMENT_SUCCESS_WEBHOOK", "PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK"):
            return
        order_id = event["data"]["order"]["order_id"]
        payment = event["data"]["payment"]
        key = hashlib.sha256(raw).hexdigest()
        with self.ledger.connection() as db:
            if not db.execute("SELECT 1 FROM orders WHERE id=?", (order_id,)).fetchone():
                return
            db.execute("INSERT OR IGNORE INTO notifications(event_hash,order_id,attempt,status) VALUES(?,?,?,?)",
                       (key, order_id, str(payment["cf_payment_id"]), payment["payment_status"]))
            if db.execute("SELECT done FROM notifications WHERE event_hash=?", (key,)).fetchone()[0]:
                return
        if payment["payment_status"] == "SUCCESS" and not self.ledger.reconcile(self.gateway, order_id):
            raise URLError("Payment pending")
        with self.ledger.connection() as db:
            db.execute("UPDATE notifications SET done=1 WHERE event_hash=?", (key,))


def configured_app():
    from pathlib import Path
    Path("data").mkdir(exist_ok=True)
    mode = os.environ.get("BILLING_MODE", "sandbox")
    if mode not in ("sandbox", "production"):
        raise ValueError("Invalid BILLING_MODE")
    gateway = CashfreeProduction() if mode == "production" else CashfreeSandbox()
    from .google import GoogleLogin
    google = GoogleLogin(os.environ["GOOGLE_CLIENT_ID"], os.environ["GOOGLE_CLIENT_SECRET"]) \
        if os.environ.get("GOOGLE_CLIENT_ID") else None
    return Billing(Ledger(f"data/billing-{mode}.sqlite3"), gateway,
                   os.environ["BILLING_ORIGIN"], (json.loads(os.environ["BILLING_CLIENTS"])
                   if "BILLING_CLIENTS" in os.environ else os.environ["BILLING_EXTENSION_ID"]),
                   json.loads(os.environ.get("BILLING_OFFERS", "{}")), os.environ[gateway.key_prefix + "SECRET"],
                   mode, json.loads(os.environ.get("BILLING_SELLER", "{}")), google,
                   json.loads(os.environ.get("BILLING_TRIALS", '{"sendoff": 7}')))


if __name__ == "__main__":
    from wsgiref.simple_server import make_server, WSGIRequestHandler
    app = configured_app()
    if app.origin != "http://127.0.0.1:8766":
        raise SystemExit("Local fixture server requires BILLING_ORIGIN=http://127.0.0.1:8766")
    fixture_account = os.environ["BILLING_LOCAL_TEST_ACCOUNT"]

    def local_fixture(env, start):
        env["REMOTE_USER"] = fixture_account
        return app(env, start)

    class Quiet(WSGIRequestHandler):
        def log_request(self, code="-", size="-"):
            pass  # Auth requests carry short-lived codes and state.

    with make_server("127.0.0.1", 8766, local_fixture, handler_class=Quiet) as server:
        server.serve_forever()
