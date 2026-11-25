import base64
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

from billing.google import GoogleLogin


def id_token(**claims):
    part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    return part({"alg": "RS256"}) + "." + part(claims) + ".signature"


class FakeGoogle(BaseHTTPRequestHandler):
    claims = {}

    def do_POST(self):
        form = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        FakeGoogle.form = form
        body = json.dumps({"id_token": id_token(**FakeGoogle.claims)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class GoogleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeGoogle)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.server.shutdown)
        port = cls.server.server_address[1]
        cls.google = GoogleLogin("client", "secret", f"http://127.0.0.1:{port}/auth", f"http://127.0.0.1:{port}/token")

    def good(self, **changes):
        claims = dict(iss="https://accounts.google.com", aud="client", exp=time.time() + 300, nonce="n",
                      sub="123", email="asha@example.test", email_verified=True)
        claims.update(changes)
        return {k: v for k, v in claims.items() if v is not None}

    def test_url(self):
        query = parse_qs(urlsplit(self.google.url("https://m.example/auth/google", "s", "n")).query)
        self.assertEqual(query["scope"], ["openid email"])
        self.assertEqual(query["prompt"], ["select_account"])
        self.assertEqual(query["nonce"], ["n"])

    def test_account(self):
        FakeGoogle.claims = self.good()
        self.assertEqual(self.google.account("code", "https://m.example/auth/google", "n"), ("123", "asha@example.test"))
        self.assertEqual(FakeGoogle.form["client_secret"], ["secret"])
        self.assertEqual(FakeGoogle.form["grant_type"], ["authorization_code"])

    def test_rejects_claims_that_do_not_match(self):
        for name, value in (("iss", "https://evil.example"), ("aud", "other"), ("exp", time.time() - 1),
                            ("nonce", "other"), ("email_verified", False), ("sub", None)):
            with self.subTest(name=name):
                FakeGoogle.claims = self.good(**{name: value})
                with self.assertRaises(ValueError):
                    self.google.account("code", "https://m.example/auth/google", "n")
