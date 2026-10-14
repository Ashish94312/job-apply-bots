#!/usr/bin/env python3
"""Publish a new version of Sendoff to the Chrome Web Store in one go: raise the version, build the ZIP, upload
it and submit it for review, through the Chrome Web Store API (v2).

  .venv/bin/python tools/publish_extension.py              # 1.0.0 -> 1.0.1, build, upload, submit for review
  .venv/bin/python tools/publish_extension.py --bump minor # 1.0.1 -> 1.1.0
  .venv/bin/python tools/publish_extension.py --no-bump    # you raised "version" in manifest.json yourself
  .venv/bin/python tools/publish_extension.py --draft      # upload only; submit it from the dashboard
  .venv/bin/python tools/publish_extension.py --status     # where the latest submission is
  .venv/bin/python tools/publish_extension.py --setup      # once: sign in with Google and save the token

Google still reviews each update; it goes live by itself when the review passes (often within hours for an
update, sometimes days). The very first version, the store listing and the privacy answers are done by hand in
the Developer Dashboard (see store/LISTING.md); this script is for every update after that.

Needs these in .env (the repo's, never committed), set up once as described in extension/README.md:
  CWS_PUBLISHER_ID   Developer Dashboard > Publisher > Settings
  CWS_EXTENSION_ID   the 32-letter id of the published extension (in its dashboard address)
  CWS_CLIENT_ID      OAuth client of type "Desktop app", from a Google Cloud project with the
  CWS_CLIENT_SECRET  "Chrome Web Store API" turned on
  CWS_REFRESH_TOKEN  written by --setup
"""
import argparse
import http.server
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
MANIFEST = ROOT / "extension" / "manifest.json"
API = "https://chromewebstore.googleapis.com"
SCOPE = "https://www.googleapis.com/auth/chromewebstore"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def need(*names):
    load_dotenv(ENV)
    values = [os.environ.get(n, "").strip() for n in names]
    missing = [n for n, v in zip(names, values) if not v]
    if missing:
        sys.exit(f"Missing in .env: {', '.join(missing)}. extension/README.md > Publishing says where each comes from.")
    return values


def call(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            body = json.loads(body).get("error", {}).get("message", body)
        except ValueError:
            pass
        sys.exit(f"{method} {url.split('?')[0]} failed ({e.code}): {body}")


def access_token():
    client_id, client_secret, refresh = need("CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN")
    data = urllib.parse.urlencode({"client_id": client_id, "client_secret": client_secret, "refresh_token": refresh,
                                   "grant_type": "refresh_token"}).encode()
    return call("POST", TOKEN_URL, data, {"Content-Type": "application/x-www-form-urlencoded"})["access_token"]


def item_url(action, upload=False):
    publisher, item = need("CWS_PUBLISHER_ID", "CWS_EXTENSION_ID")
    return f"{API}/{'upload/' if upload else ''}v2/publishers/{publisher}/items/{item}:{action}"


# ---------------------------------------------------------------- one-time sign-in

def setup():
    """Sign in with Google in the browser (the account that owns the extension) and save the refresh token."""
    client_id, client_secret = need("CWS_CLIENT_ID", "CWS_CLIENT_SECRET")
    state = secrets.token_urlsafe(16)
    got = {}

    class Back(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if q.get("state") == [state]:
                got.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<p>Done. You can close this tab and go back to the terminal.</p>".encode())

    server = http.server.HTTPServer(("127.0.0.1", 0), Back)
    redirect = f"http://127.0.0.1:{server.server_port}"
    threading.Thread(target=server.handle_request, daemon=True).start()
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "state": state,
    })
    print(f"Sign in with the Google account that owns the extension:\n  {url}")
    webbrowser.open(url)
    for _ in range(300):
        if got:
            break
        time.sleep(1)
    if "code" not in got:
        sys.exit(f"No sign-in came back{': ' + got['error'] if got.get('error') else ''}.")
    data = urllib.parse.urlencode({"code": got["code"], "client_id": client_id, "client_secret": client_secret,
                                   "redirect_uri": redirect, "grant_type": "authorization_code"}).encode()
    token = call("POST", TOKEN_URL, data, {"Content-Type": "application/x-www-form-urlencoded"}).get("refresh_token")
    if not token:
        sys.exit("Google didn't give a refresh token. Remove the app's access at myaccount.google.com/permissions and run --setup again.")
    text = ENV.read_text() if ENV.exists() else ""
    line = f"CWS_REFRESH_TOKEN={token}"
    text = re.sub(r"(?m)^CWS_REFRESH_TOKEN=.*$", line, text) if "CWS_REFRESH_TOKEN=" in text else text.rstrip("\n") + f"\n{line}\n"
    ENV.write_text(text)
    print("Saved CWS_REFRESH_TOKEN in .env. Publishing works now.")


# ---------------------------------------------------------------- publishing

def bump(version, part):
    nums = [int(n) for n in version.split(".")] + [0] * (3 - len(version.split(".")))
    i = {"major": 0, "minor": 1, "patch": 2}[part]
    nums[i] += 1
    nums[i + 1:] = [0] * (2 - i)
    return ".".join(map(str, nums[:3]))


def set_version(version):
    text = MANIFEST.read_text()
    MANIFEST.write_text(re.sub(r'("version":\s*")[^"]+(")', rf"\g<1>{version}\g<2>", text, count=1))


def status():
    s = call("GET", item_url("fetchStatus"), headers={"Authorization": f"Bearer {access_token()}"})
    print(json.dumps(s, indent=2))


def publish(args):
    token = access_token()  # fail on bad credentials before touching anything
    auth = {"Authorization": f"Bearer {token}"}
    old = json.loads(MANIFEST.read_text())["version"]
    new = old if args.no_bump else bump(old, args.bump)
    if new != old:
        set_version(new)
    sys.path.insert(0, str(ROOT / "tools"))
    import package_extension  # noqa: E402

    try:
        package_extension.main()
        zip_path = ROOT / "dist" / f"sendoff-{new}.zip"
        print(f"Uploading {zip_path.name}...")
        up = call("POST", item_url("upload", upload=True), zip_path.read_bytes(), {**auth, "Content-Type": "application/zip"})
        for _ in range(60):  # big uploads are processed for a while
            state = up.get("uploadState", "")
            if state != "IN_PROGRESS" and state != "UPLOAD_IN_PROGRESS":
                break
            time.sleep(5)
            up = call("GET", item_url("fetchStatus"), headers=auth)
        if up.get("uploadState") not in ("SUCCEEDED", "SUCCESS", None) and "FAIL" in str(up.get("uploadState", "")).upper():
            raise RuntimeError(f"upload was refused: {json.dumps(up)}")
    except (SystemExit, RuntimeError, Exception):
        if new != old:
            set_version(old)  # nothing went up: leave the version as it was
            print(f"Version put back to {old}.")
        raise
    print(f"Uploaded version {new}.")
    if args.draft:
        print("Not submitted (--draft): submit it for review in the Developer Dashboard when ready.")
    else:
        result = call("POST", item_url("publish"), b"{}", {**auth, "Content-Type": "application/json"})
        print(f"Submitted for review: {json.dumps(result)}")
        print("It goes live by itself once Google's review passes. --status shows where it is.")
    if new != old:
        print(f"Commit the version change: git commit -am 'Sendoff {new}'")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bump", choices=["patch", "minor", "major"], default="patch", help="which part of the version to raise")
    parser.add_argument("--no-bump", action="store_true", help="keep the version in manifest.json as it is")
    parser.add_argument("--draft", action="store_true", help="upload, but don't submit for review")
    parser.add_argument("--status", action="store_true", help="show where the latest submission is")
    parser.add_argument("--setup", action="store_true", help="sign in once and save the refresh token in .env")
    args = parser.parse_args()
    if args.setup:
        setup()
    elif args.status:
        status()
    else:
        publish(args)


if __name__ == "__main__":
    main()
