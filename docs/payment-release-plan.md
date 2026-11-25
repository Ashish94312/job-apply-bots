# Shared payments and Sendoff release plan

**Status on 26 November 2026.** The local billing implementation and its fixture checks are complete, including the operator tools (pause switch, status, support lookup) and bounded recovery. The paid edition sells a ₹251 pass for 30 days, renewed manually, with no free trial (changed on 26 November 2026 from a 7-day trial and ₹99). Without a pass, only exporting records, stopping runs and the account panel are available. Each later product gets its own account access scope, catalogue entry and release decision.

| Verification | Recorded outcome |
|---|---|
| Automated tests | 21 billing tests and 42 extension unit tests passed. The billing tests cover the ledger, trials, Google sign-in claims and the web flow, plus out-of-order and duplicate notifications, a Cashfree outage between notification and grant, client price changes, product isolation, the pause switch and order expiry. |
| Packaged customer journey | `billing.browser_check` passed in Chromium. It used the packaged sandbox build, a stand-in for Google's sign-in running the real sign-in code, and a simulated Cashfree gateway. Covered: sign-in starts the trial, an ended trial locks, buying in a checkout tab closed before the notification unlocks, the sign-in survives a Chrome restart, sign-out, sign-in, and restoring in a fresh profile. |
| Decided | Sign-in with Google. No free trial. ₹251 for 30 days. |
| External verification pending | Choose hosting and the domain. Create the Google OAuth client. Get Cashfree activation and domain approval, real sandbox credentials and webhooks. Verify a Cashfree sandbox payment and refund, permitted live-site dry runs, and review-account access, then an authorized live pilot and settlement. |
| Commercial decisions pending | Seller identity, support contact, refund terms and the published policies. No public release or payment has been made. |

Run instructions and configuration are in [the billing guide](../billing/README.md).

## Remaining work

| # | Step | Owner | State |
|---|---|---|---|
| A | Code hardening: order expiry and bounded recovery, pause switch, `status` and `lookup`, edge-case tests | Engineering | Done |
| B | Sandbox deploy on Fly: app, volume, secrets, deploy, register offer, `/healthz` and `/` | Owner (account), engineering (commands) | Not started |
| C | Google OAuth client (Web application, redirect `/auth/google`). Cashfree test-mode keys. Webhook to `/webhook` | Owner | Not started |
| D | Sandbox verification: real sandbox payment and refund, plus the billing sandbox cases below. Rehearse the pause | Owner and engineering | Not started |
| E | Seller identity, support contact, refund terms, policies (BILLING_SELLER). Cashfree activation and domain approval. Own domain | Owner | Not started |
| F | Store submission with reviewer access. One live purchase and refund. Small first cohort | Owner | Not started |

| Milestone | Implementation | Evidence required to proceed |
|---|---|---|
| 1. Freeze the offer | Product owner records the features shipping, free and paid boundaries, price, duration, refund terms, existing-user treatment and support contact. Keep access to local history and export after expiry. Record a baseline against the chosen Sendoff commit. | Approved offer and a list mapping each advertised feature to a test. |
| 2. Prepare the merchant site | Publish the seller identity, product details, INR prices, delivery terms, contact, privacy and cancellation/refund policies on HTTPS. Confirm Cashfree activation, bank settlement setup, business category and checkout domain approval. Repeat eligibility and domain checks for every new product. | Dashboard approval for the intended business and domain. Sandbox and production have separate credentials, endpoints and data. |
| 3. Build the shared service | Use one account system and billing service with a relational database. Register each product and versioned offer. Store account, product, offer version, price, currency and duration on each order. Track payment attempts, refunds and access grants. Enforce account and product scope on every read and protected operation. | Buying product A grants access only to A. Changing a future price leaves earlier orders intact. |
| 4. Integrate checkout and recovery | Create orders on the server with stable retry keys. Open Cashfree Hosted Checkout on the approved website. Verify signed webhooks against timestamp and raw bytes, durably enqueue, then confirm the order is PAID with Cashfree and matches the expected ID, amount and currency. Record attempts by Cashfree payment ID and grant access once per order in a database transaction. Reconcile pending orders and refunds. | A customer can pay, close Chrome, sign in later and recover access. Retries, crashes and late failures cannot duplicate or undo the grant. Refunds affect only the relevant purchase, according to the published terms. |
| 5. Connect Sendoff | Add sign-in, Upgrade, access status, expiry and Restore Purchase on the dashboard. Use a short-lived authorization code with PKCE bound to the extension redirect. The worker reads access for Sendoff from the backend. Keep credentials outside backups and content scripts. Exclude checkout and billing tabs from automation and screenshots. Keep job data local. | New install, upgrade from the previous package, logout, account switch and reinstall all produce the expected access. A service outage preserves local records and gives the user a retry path. |
| 6. Prepare distribution | Update PRIVACY.md, extension/README.md and store/LISTING.md to describe accounts, billing data, Cashfree and paid functionality. Check the manifest for least privilege, bundle extension logic locally, and give reviewers a test account and instructions. Review job-platform terms and the recipient/content confirmation flow for outgoing messages. | Store listing, published policy, permissions and observed network traffic agree. |

## Release candidate verification

Record commit, extension ZIP checksum, backend version, environment, tester, date, expected and actual results, and redacted order IDs. Mark each case passed, failed or untested. A release candidate needs actual results for every advertised flow.

| Test area | Required checks |
|---|---|
| Existing Sendoff features | Run `node --test extension/tests/unit.test.js` and each existing `extension/tests/e2e*.py` with the repository virtual environment and Playwright Chromium. Cover each shipped site, screening answers, referral previews and confirmations, tracking, backup/restore, stop controls and permission denial. Add manual cases where automated coverage is missing. Test from the packaged build as well as source. Fake-site tests establish expected behavior on fixtures. Check current site compatibility with permitted accounts and dry runs. Record any live submission path that still needs verification. |
| Billing sandbox | Complete checkout, abandon it, retry a failed attempt, close the tab after payment, delay a webhook, deliver duplicate and out-of-order events, and interrupt processing between receipt and grant. Check orders, access, receipts, refunds and reconciliation against Cashfree for every case. |
| Security and isolation | Reject invalid signatures, client price changes, unauthenticated access and another account’s order. Test two accounts and two product IDs. Inspect the ZIP, logs, extension backups and network traffic for secrets or job data entering billing. Verify checkout tabs never receive job scripts. |
| Customer lifecycle | Exercise expiry, early renewal, successful and failed refunds, second device, reinstall, account switch and a temporary backend outage. Verify support can locate a purchase by reference and restore verified access without charging again. |
| Production pilot | After merchant approval, perform one authorized low-value live purchase and refund. Verify the account, product, amount, webhook, grant, refund status and resulting access. Match transaction records to the dashboard and settlement report when available. |

## Release and rollback

Resolve payment integrity, privacy, access isolation and advertised-feature failures before public rollout. If a feature cannot be verified, fix it or explicitly remove it from both the release and its listing. Re-run affected checks on the final package. Start with a small cohort. Monitor checkout errors, webhook lag, paid orders without access, duplicate grants and refund mismatches. Assign an owner to inspect exceptions and respond to support requests.

Provide a server-side switch to pause **new checkout per product**. Rehearse it before launch. Keep webhook ingestion, reconciliation, existing purchases and support available during rollback. Keep database migrations compatible with the previous service version. For each later product, register its approved domain and offer, run the same payment and isolation suite, then run its own feature tests before enabling its checkout.

References: [Cashfree Hosted Checkout](https://www.cashfree.com/docs/payments/online/web/redirect), [domain and line-of-business approval](https://www.cashfree.com/docs/payments/online/go-live/whitelist), [webhook handling](https://www.cashfree.com/docs/payments/online/webhooks/webhook-indempotency), [production checklist](https://www.cashfree.com/docs/payments/online/go-live/checklist), [Chrome Web Store policies](https://developer.chrome.com/docs/webstore/program-policies/policies).
