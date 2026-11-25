# Deploying the billing service to Fly.io

One small always-on machine in Singapore (`sin`, the closest region to India now that Fly has closed Mumbai), with the sqlite ledger on a 1 GB Fly volume mounted at `/app/data`.
`deploy.sh` uploads only the billing code. The rest of the repo (settings, job history, browser profiles) never leaves your computer.

| File | What it is |
|---|---|
| `fly.toml` | App name, region, volume, always-on machine, health check, non-secret settings |
| `Dockerfile` | Python 3.12 slim + gunicorn; runs as an unprivileged user |
| `start.sh` | Starts gunicorn (no access log: request lines carry one-time sign-in codes) and the 5-minute recovery sweep |
| `billing-admin` | Operator commands on the server, e.g. registering the offer |
| `deploy.sh` | Stages the billing code and runs `fly deploy` |

## First setup (sandbox)

Replace `sendoff-billing` everywhere if you choose another app name. Keep `app` and `BILLING_ORIGIN` in `fly.toml` the same as that name.

1. Install and log in: `brew install flyctl`, then `fly auth login`.
2. Create the app: `fly apps create sendoff-billing`. Its address will be `https://sendoff-billing.fly.dev`.
3. Create the disk: `fly volumes create billing_data --region sin --size 1 -a sendoff-billing`.
4. Get the keys:
   - **Cashfree sandbox:** in the Cashfree merchant dashboard, switch to Test mode, then Developers → API Keys. Copy the App ID and the Secret Key.
   - **Google:** in Google Cloud Console, create a project. Set up the OAuth consent screen: External, with app name, support email and privacy URL `https://sendoff-billing.fly.dev/privacy`. Then go to Clients → Create client → Web application. Add the authorized redirect URI `https://sendoff-billing.fly.dev/auth/google`. Copy the Client ID and the Client secret.
   - **Extension ID:**
     1. Build with `python tools/package_extension.py --billing-origin https://sendoff-billing.fly.dev`.
     2. Unzip the build into a folder you keep, then use Load unpacked in `chrome://extensions`.
     3. Copy the ID it shows. The ID depends on the folder, so keep loading from that folder.
5. Set the secrets in your own Terminal. Never paste them into chats, issues or commits:

       fly secrets set -a sendoff-billing \
         CASHFREE_SANDBOX_APP_ID=... CASHFREE_SANDBOX_SECRET=... \
         GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
         BILLING_EXTENSION_ID=...

6. Deploy from the repo root: `./billing/deploy/deploy.sh`.
7. Register the offer (₹251 for 30 days, no free trial): `fly ssh console -a sendoff-billing -C "billing-admin offer sendoff v2 25100 30"`.
8. Check it: `https://sendoff-billing.fly.dev/healthz` should say `ok`, and `https://sendoff-billing.fly.dev/` should list the ₹251 pass.
9. Set up Cashfree webhooks. In Cashfree Developers → Webhooks, add `https://sendoff-billing.fly.dev/webhook` for payment and refund events.

## Later

- **Updates:** run `./billing/deploy/deploy.sh` again. The ledger on the volume stays.
- **Logs:** `fly logs -a sendoff-billing`. A repeated "billing recovery: needs a look" means a payment needs a look: run `fly ssh console -a sendoff-billing -C "billing-admin status"`.
- **Pause new purchases:** `fly ssh console -a sendoff-billing -C "billing-admin pause sendoff"` (and `resume sendoff`). Takes effect at once, with no redeploy.
- **Support:** `fly ssh console -a sendoff-billing -C "billing-admin lookup ORDER_ID_OR_EMAIL"`.
- **Backups:** Fly snapshots the volume daily (`fly volumes snapshots list`).
- **Own domain:**
  1. Run `fly certs add pay.yourdomain.in -a sendoff-billing` and add the DNS records it prints.
  2. Set `BILLING_ORIGIN` to that domain.
  3. Update the Google redirect URI and the Cashfree webhook to the new domain.
  4. Rebuild the extension with the new origin.
- **Production:** follow "Production handoff" in [../README.md](../README.md). That covers live keys (`BILLING_MODE=production`), `BILLING_SELLER`, and Cashfree domain approval.
