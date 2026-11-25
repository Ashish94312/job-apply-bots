"""Sign in with Google (OpenID Connect, authorization code flow) for the billing service."""
import base64
import json
import time
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from .service import NoRedirect

ISSUERS = ("https://accounts.google.com", "accounts.google.com")


class GoogleLogin:
    def __init__(self, client_id, secret, auth_url="https://accounts.google.com/o/oauth2/v2/auth",
                 token_url="https://oauth2.googleapis.com/token"):
        if not client_id or not secret:
            raise ValueError("Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")
        self.client_id, self.secret = client_id, secret
        self.auth_url, self.token_url = auth_url, token_url

    def url(self, redirect_uri, state, nonce, prompt="select_account"):
        """Google's sign-in page, which comes back to redirect_uri with ?code and ?state (or ?error)."""
        return self.auth_url + "?" + urlencode(dict(
            client_id=self.client_id, redirect_uri=redirect_uri, response_type="code",
            scope="openid email", state=state, nonce=nonce, prompt=prompt))

    def account(self, code, redirect_uri, nonce):
        """(subject, email) of the Google account that signed in, from the code Google sent back."""
        body = urlencode(dict(code=code, client_id=self.client_id, client_secret=self.secret,
                              redirect_uri=redirect_uri, grant_type="authorization_code")).encode()
        request = Request(self.token_url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with build_opener(NoRedirect()).open(request, timeout=15) as response:
            id_token = json.load(response)["id_token"]
        # The token comes straight from Google's token endpoint over TLS, authenticated with the client secret, so
        # its signature need not be checked again (OpenID Connect Core 3.1.3.7). Its claims still must match.
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if (claims.get("iss") not in ISSUERS or claims.get("aud") != self.client_id
                or not claims.get("exp", 0) > time.time() or claims.get("nonce") != nonce
                or not claims.get("sub") or claims.get("email_verified") is not True):
            raise ValueError("Google sign-in could not be verified")
        return claims["sub"], claims.get("email", "")
