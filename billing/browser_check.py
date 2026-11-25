"""Exercise the packaged extension against a local merchant, a stand-in for Google's sign-in and a simulated gateway.

    python -m billing.browser_check dist/sendoff-<version>-billing-sandbox.zip

Covers: sign in with Google (first sign-in starts the free trial), the trial ending, buying a pass in a checkout tab
that is closed before Cashfree's notification, the pass surviving a Chrome restart, signing out, and restoring the
pass in a fresh profile. The worker refuses product messages without an active trial or pass."""
import base64
import hashlib
import hmac
import json
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from unittest.mock import Mock
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen
from wsgiref.simple_server import WSGIRequestHandler, make_server

from playwright.sync_api import expect, sync_playwright

from .google import GoogleLogin
from .web import Billing, Ledger, digest

ORIGIN = "http://127.0.0.1:8766"
GOOGLE = "http://127.0.0.1:8767"
EMAIL = "asha@example.test"


class Quiet(WSGIRequestHandler):
    def log_request(self, code="-", size="-"):
        pass


def fake_google():
    """Google's sign-in page signs the person in at once; its token endpoint vouches for them."""
    nonces = {}

    def app(env, start):
        if env["PATH_INFO"] == "/auth":
            query = {k: v[0] for k, v in parse_qs(env["QUERY_STRING"]).items()}
            code = "code-%d" % len(nonces)
            nonces[code] = query["nonce"]
            start("302 Found", [("Location", query["redirect_uri"] + "?" + urlencode(dict(code=code, state=query["state"])))])
            return [b""]
        form = {k: v[0] for k, v in parse_qs(env["wsgi.input"].read(int(env["CONTENT_LENGTH"])).decode()).items()}
        part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
        claims = dict(iss="https://accounts.google.com", aud="client", exp=time.time() + 300,
                      nonce=nonces.pop(form["code"]), sub="subject-1", email=EMAIL, email_verified=True)
        start("200 OK", [("Content-Type", "application/json")])
        return [json.dumps({"id_token": part({}) + "." + part(claims) + ".sig"}).encode()]
    return app


def gated(page):
    """What the worker says to a product message (one that needs a pass)."""
    return page.evaluate("chrome.runtime.sendMessage({type: 'track', items: []})")


def main():
    import sys
    with tempfile.TemporaryDirectory() as directory, sync_playwright() as pw:
        root = Path(directory)
        ext = root / "extension"
        with zipfile.ZipFile(sys.argv[1]) as package:
            package.extractall(ext)
        # Unpacked extension IDs are derived from their absolute paths.
        extension_id = hashlib.sha256(str(ext.resolve()).encode()).hexdigest()[:32].translate(
            str.maketrans("0123456789abcdef", "abcdefghijklmnop"))
        ledger = Ledger(root / "data.sqlite")
        ledger.add_offer("sendoff", "fixture", 9900, 30)
        gateway = Mock()
        gateway.create.return_value = {"payment_session_id": "test_session"}
        google = GoogleLogin("client", "secret", GOOGLE + "/auth", GOOGLE + "/token")
        app = Billing(ledger, gateway, ORIGIN, extension_id, {"sendoff": "fixture"}, "test",
                      google=google, trials={"sendoff": 7})
        account = digest("google:subject-1")[:48]
        servers = [make_server("127.0.0.1", 8766, app, handler_class=Quiet),
                   make_server("127.0.0.1", 8767, fake_google(), handler_class=Quiet)]
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()

        def browser(profile):
            ctx = pw.chromium.launch_persistent_context(str(root / profile), channel="chromium",
                    args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}"])
            ctx.route("https://sdk.cashfree.com/**", lambda r: r.fulfill(content_type="text/javascript",
                      body="window.Cashfree=()=>({checkout:async()=>{document.title='Test checkout';}})"))
            dash = ctx.new_page()
            dash.goto(f"chrome-extension://{extension_id}/dashboard.html")
            return ctx, dash

        ctx = None
        try:
            ctx, dash = browser("profile")
            status = dash.locator("#billing output")
            signin = dash.get_by_role("button", name="Sign in with Google")
            expect(status).to_contain_text("7-day free trial")
            expect(dash.locator("main")).to_be_hidden()
            assert "Sign in" in gated(dash)["error"]

            signin.click()
            expect(status).to_contain_text("Free trial until", timeout=15000)
            expect(dash.locator("#billing-account")).to_have_text("Signed in as " + EMAIL)
            expect(dash.locator("main")).to_be_visible()
            assert gated(dash).get("ok"), "the trial opens Sendoff"
            print("ok: Google sign-in starts the 7-day trial")

            with ledger.connection() as db:
                db.execute("UPDATE trials SET ends_at=? WHERE account=?", (int(time.time()) - 60, account))
            dash.get_by_role("button", name="Refresh").click()
            expect(status).to_contain_text("Your free trial ended")
            expect(status).to_contain_text("₹99 for 30 days")
            expect(dash.locator("main")).to_be_hidden()
            assert "ended" in gated(dash)["error"]
            print("ok: an ended trial locks Sendoff and offers the pass")

            with ctx.expect_page() as new:
                dash.get_by_role("button", name="Buy pass").click()
            checkout = new.value
            expect(checkout.locator("body")).to_contain_text("For the Sendoff account " + EMAIL)
            expect(checkout.locator("body")).to_contain_text("₹99.00 for 30 days")
            assert "code=" not in checkout.url, "the one-time link leaves the address"
            checkout.get_by_label("Test billing phone").fill("9999999999")
            checkout.get_by_role("button", name="Continue to Cashfree sandbox").click()
            expect(checkout).to_have_title("Test checkout")
            checkout.close()
            order_id = gateway.create.call_args.args[0]["id"]
            assert gateway.create.call_args.args[0]["account"] == account
            gateway.get.return_value = dict(order_id=order_id, order_currency="INR", order_amount=99, order_status="PAID")
            raw = json.dumps(dict(type="PAYMENT_SUCCESS_WEBHOOK", data=dict(order=dict(order_id=order_id),
                             payment=dict(cf_payment_id="123", payment_status="SUCCESS")))).encode()
            signature = base64.b64encode(hmac.digest(b"test", b"123" + raw, "sha256")).decode()
            with urlopen(Request(ORIGIN + "/webhook", data=raw, headers={
                    "x-webhook-signature": signature, "x-webhook-timestamp": "123"}), timeout=5) as response:
                assert response.status == 200
            expect(status).to_contain_text("Pass valid until", timeout=20000)  # looks again once checkout closes
            expect(dash.locator("main")).to_be_visible()
            assert gated(dash).get("ok")
            print("ok: buying a pass in a closed checkout tab unlocks Sendoff")

            ctx.close()
            ctx, dash = browser("profile")
            expect(dash.locator("#billing output")).to_contain_text("Pass valid until", timeout=15000)
            expect(dash.locator("main")).to_be_visible()
            print("ok: still signed in after Chrome restarts")

            dash.get_by_role("button", name="Sign out").click()
            expect(dash.locator("main")).to_be_hidden()
            assert "Sign in" in gated(dash)["error"]
            dash.get_by_role("button", name="Sign in with Google").click()
            expect(dash.locator("main")).to_be_visible(timeout=15000)
            ctx.close()

            ctx, fresh = browser("new-profile")
            expect(fresh.locator("main")).to_be_hidden()
            fresh.get_by_role("button", name="Sign in with Google").click()
            expect(fresh.locator("#billing output")).to_contain_text("Pass valid until", timeout=15000)
            expect(fresh.locator("main")).to_be_visible()
            print("ok: sign-out, sign-in and restoring the pass in a fresh profile")
            print("All passed")
        finally:
            if ctx:
                ctx.close()
            for server in servers:
                server.shutdown()


if __name__ == "__main__":
    main()
