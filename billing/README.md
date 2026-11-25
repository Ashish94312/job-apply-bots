# Sendoff billing

The billing edition of Sendoff needs a pass for every product feature: ₹251 for 30 days, with no free trial. Job data stays in Chrome. The ledger here is authoritative for trials, orders and access. A user who modifies the local extension can change its local feature checks.

## The flow

1. **Sign in with Google** on the dashboard. The extension opens `/authorize` in Chrome's sign-in window (PKCE, bound to the extension's `chromiumapp.org` redirect). The service sends the person to Google, and Google returns to `/auth/google`. The service checks the ID token (issuer, audience, expiry, nonce, verified email), records the account and email, and hands the extension a 90-second code. The extension exchanges the code at `/token` for a sign-in credential. That credential is stored in `chrome.storage.local` and is never included in backups. It lasts 30 days, and each use renews it.
2. **No free trial**: signing in shows the price and keeps Sendoff locked until a pass is bought. A trial can be turned on per product with `BILLING_TRIALS` (for example `{"sendoff":7}`): one per Google account, starting at its first sign-in.
3. **Buy pass**: the extension asks `/checkout/start` for a one-time link (10 minutes). The link signs the checkout tab in as that account with a 2-hour cookie (HttpOnly, SameSite=Lax), then removes the code from the address. The page shows the email being charged and the price, asks for the billing phone Cashfree requires, and opens Cashfree Hosted Checkout. Cashfree returns to `/receipt`.
4. **Confirmation**: the signed `/webhook` (or `/receipt`, or the recovery sweep) asks Cashfree whether the order is PAID with the expected amount, and grants the pass exactly once. A pass adds 30 days after the later of now, the trial's end and any current pass, so buying early loses nothing. A full refund removes that purchase and recomputes later passes. A partial refund keeps access.
5. **The dashboard unlocks by itself**: it checks again when the checkout tab closes, when the dashboard regains focus, and when the pass is due to end. The worker accepts a good check for up to 6 hours, so a short billing outage doesn't stop runs. Without a trial or pass, only exporting records, stopping runs and the account panel work.

## Repeatable local acceptance test

From the repo root, with the project's Playwright Chromium installed:

    .venv/bin/python -m unittest discover -s billing -v
    node --test extension/tests/unit.test.js
    .venv/bin/python tools/package_extension.py --billing-origin http://127.0.0.1:8766
    .venv/bin/python -m billing.browser_check dist/sendoff-1.3.0-billing-sandbox.zip

The last command unpacks the ZIP into an isolated Chromium profile. It starts a local merchant, a stand-in for Google's sign-in that runs the real `GoogleLogin` code against it, and a simulated Cashfree gateway. It then checks, in order:

- signing in without a pass keeps Sendoff locked and offers the ₹251 pass;
- a pass bought in a checkout tab closed before the payment notification unlocks Sendoff;
- the sign-in survives a Chrome restart;
- sign-out, sign-in, and restoring the pass in a fresh profile.

It needs no Google or Cashfree keys and moves no money.

## Setting it up

1. **Google sign-in.** In Google Cloud Console, create an OAuth client of type *Web application*. Add the authorized redirect URI `https://YOUR-BILLING-DOMAIN/auth/google`. The scopes are `openid email`, which need no Google verification. Publish the consent screen with the app name, support email, privacy policy (`/privacy`) and home page (`/`). Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.
2. **Offer.** Register it once per environment. Amounts are integer paise and durations are whole days. The Sendoff pass is ₹251 for 30 days (version v2; v1 was ₹99):

       python -m billing offer sendoff v2 25100 30              # sandbox ledger
       python -m billing --production offer sendoff v2 25100 30 # live ledger

   Set BILLING_OFFERS='{"sendoff":"v2"}'. Leave BILLING_TRIALS unset (or `{}`) for no free trial. A new price is a new version, so earlier orders keep theirs. Removing a product from BILLING_OFFERS pauses new purchases and keeps verification, refunds and restoring.
3. **Server.** Set:
   - BILLING_ORIGIN (HTTPS, on the domain Cashfree approved);
   - BILLING_EXTENSION_ID (the installed extension's ID; for the store build, the store's ID);
   - CASHFREE_SANDBOX_APP_ID and CASHFREE_SANDBOX_SECRET, or BILLING_MODE=production with CASHFREE_PRODUCTION_APP_ID and CASHFREE_PRODUCTION_SECRET;
   - BILLING_SELLER (JSON with name, support, description, terms, refunds and privacy strings, required for production).

   Serve the WSGI app from `billing.web.configured_app()`, run from the repo directory. The database lives in `data/billing-<mode>.sqlite3` and needs a persistent, backed-up disk. Rate-limit at the edge. Leave query strings, Authorization and Cookie headers, phone numbers and webhook bodies out of the logs. Never set REMOTE_USER from a request header: the service trusts it as an account (the local fixture uses it).
4. **Cashfree.** Point payment and refund webhooks at `/webhook`. Schedule `python -m billing.recovery` every few minutes with the same environment. It re-checks orders placed in the last 2 days (each Cashfree order expires 1 day after it's placed, so older ones can't be paid), notifications not yet processed, and refunds still waiting. It exits nonzero when any of those fail or a paid order has no access: alert on that and on repeated webhook failures. For a missed refund, run `python -m billing reconcile-refund ORDER_ID REFUND_ID`.
5. **Extension.** Build with `python tools/package_extension.py --billing-origin https://YOUR-BILLING-DOMAIN`, adding `--live-billing` for production. The build adds the `identity` permission and the merchant host. The free build (without `--billing-origin`) has no billing at all.
6. **Sandbox check.** Run one real sandbox payment and refund. Compare the order ID, amount, currency, expiry, a closed checkout tab, an account switch and the refund on both sides.

For a local manual walkthrough without Google, the loopback-only server uses BILLING_LOCAL_TEST_ACCOUNT as a fixed identity: `python -m billing.web`. Cashfree cannot send webhooks to loopback.

## Operating it

These commands use `data/billing-<mode>.sqlite3`. On a server they follow BILLING_MODE, and `--production` also selects the live ledger. On Fly, prefix them with `billing-admin` (see [deploy/README.md](deploy/README.md)).

| Command | What it does |
|---|---|
| `python -m billing status` | Counts paid orders without access, notifications and refunds still waiting, and orders that may still be paid. Lists paused products. Exits 1 when a paid order lacks access or a refund is waiting. |
| `python -m billing pause sendoff` | Stops new purchases at once, with no redeploy: the dashboard says purchases are paused, and checkout returns 503. Confirmations, refunds, restoring and existing passes carry on. |
| `python -m billing resume sendoff` | Opens purchases again. |
| `python -m billing lookup REF` | Support: finds the account by order ID or email, with its trial, orders, refunds and access dates. |
| `python -m billing reconcile ORDER_ID` | Asks Cashfree about one order now, and grants it if paid. |

Practise the pause before launch: pause, check the dashboard and `/`, then resume.

## Production handoff

Production needs:
- a separate ledger and the live key pair;
- BILLING_MODE=production and Google sign-in configured (the service refuses to start without them, BILLING_SELLER or HTTPS);
- the approved domain and a published merchant website: `/`, `/terms`, `/refunds`, `/privacy` and `/contact` render BILLING_SELLER, and anonymous access to them is allowed.

Set the store extension's stable ID on the service. Submit the paid listing with the price, the terms, the seller, the billing data disclosures and private reviewer access. Confirm every advertised feature test and one approved low-value live purchase and refund before enabling public sales.
